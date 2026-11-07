import '../shared/gs1-parser.js';

const MAX_SESSION_MS = 60000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createScannerTestController({ getConnection, post }) {
  let session = null;
  let timer = null;
  let operations = Promise.resolve();
  let starting = false;
  let stopping = false;
  const respond = (data, success, state, current = session) =>
    post({
      type: 'testState',
      requestId: data.requestId,
      success,
      state,
      sessionId: current?.id || data.sessionId || '',
      expiresAt: current?.expiresAt || null
    });
  const stop = async (data) => {
    if (!session || data.sessionId !== session.id) {
      respond(data, false, 'inactive');
      return;
    }
    const previous = session;
    stopping = true;
    session = null;
    clearTimeout(timer);
    timer = null;
    try {
      const connection = getConnection();
      if (!connection) throw new Error('Scanner disconnected');
      await connection.setCaptureOwner('clinical');
      respond(data, true, 'stopped', previous);
    } catch (_) {
      respond(data, false, 'paused', previous);
    } finally {
      stopping = false;
    }
  };
  const enqueue = (action) => {
    operations = operations.catch(() => undefined).then(action);
  };
  return {
    handleMessage(data) {
      if (data.type !== 'startTest' && data.type !== 'stopTest') return false;
      enqueue(async () => {
        if (data.type === 'stopTest') return stop(data);
        const expiresAt = Number(data.expiresAt);
        if (
          session ||
          !UUID.test(String(data.sessionId || '')) ||
          !Number.isFinite(expiresAt) ||
          expiresAt <= Date.now() ||
          expiresAt > Date.now() + MAX_SESSION_MS
        ) {
          respond(data, false, 'invalid');
          return;
        }
        const next = { id: data.sessionId, expiresAt };
        starting = true;
        try {
          const connection = getConnection();
          if (!connection) throw new Error('Scanner disconnected');
          await connection.setCaptureOwner(next.id);
          if (!starting || getConnection() !== connection)
            throw new Error('Scanner disconnected');
          session = next;
          if (expiresAt <= Date.now()) return stop(data);
          timer = setTimeout(
            () => enqueue(() => stop({ sessionId: next.id })),
            expiresAt - Date.now()
          );
          respond(data, true, 'active');
        } catch (_) {
          respond(data, false, 'paused', next);
        } finally {
          starting = false;
        }
      });
      return true;
    },
    connectionLost() {
      const wasTesting = !!session || starting || stopping;
      starting = false;
      session = null;
      clearTimeout(timer);
      timer = null;
      return wasTesting;
    },
    onRead({ owner, byteCount }) {
      if (!session || owner !== session.id || Date.now() >= session.expiresAt)
        return;
      post({
        type: 'testObservation',
        sessionId: session.id,
        kind: 'chunk',
        byteCount
      });
    },
    onScan(scan, { owner, completionReason }) {
      if (!session || owner !== session.id || Date.now() >= session.expiresAt)
        return;
      let parsed = null;
      try {
        parsed = globalThis.VaxLinkGS1Parser.parseGS1Barcode(scan.rawText);
      } catch (_) {
        /* invalid frame */
      }
      post({
        type: 'testObservation',
        sessionId: session.id,
        kind: 'frame',
        completionReason,
        parsed: !!parsed,
        hasGtin: !!parsed?.gtin,
        hasLot: !!parsed?.lot,
        hasExpiry: !!parsed?.expiry,
        hasSerial: !!parsed?.serial,
        lookup: 'unavailable'
      });
    }
  };
}
