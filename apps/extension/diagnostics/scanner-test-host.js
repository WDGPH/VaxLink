const PREFIX = 'diagnostics.test.';

export function createScannerTestHost({
  getWorker,
  isConnected,
  stopReconnect,
  broadcast
}) {
  let session = null;
  let sequence = 0;
  const pending = new Map();
  const setupUrl = chrome.runtime.getURL('scanner-setup.html');
  const ownerOf = (sender) => {
    if (sender?.id !== chrome.runtime.id || sender.url !== setupUrl)
      return null;
    if (sender.tab)
      return sender.tab.url === setupUrl && Number.isInteger(sender.tab.id)
        ? `tab:${sender.tab.id}`
        : null;
    return sender.documentId ? `document:${sender.documentId}` : null;
  };
  const sendWorker = (type, current) =>
    new Promise((resolve) => {
      const worker = getWorker();
      if (!worker) return resolve({ success: false, state: 'disconnected' });
      const requestId = `test-${++sequence}`;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        stopReconnect();
        try {
          worker.postMessage({ type: 'stopTest', sessionId: current.id });
        } catch (_) {
          // The worker may already have terminated.
        }
        resolve({ success: false, state: 'paused' });
      }, 5000);
      pending.set(requestId, (state) => {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve(state);
      });
      try {
        worker.postMessage({
          type,
          requestId,
          sessionId: current.id,
          expiresAt: current.expiresAt
        });
      } catch (_) {
        stopReconnect();
        pending.get(requestId)?.({ success: false, state: 'paused' });
      }
    });
  const snapshot = () =>
    session
      ? {
          success: true,
          state: session.state,
          sessionId: session.id,
          expiresAt: session.expiresAt,
          bytes: session.bytes,
          chunks: session.chunks,
          frames: session.frames,
          lastFrame: session.lastFrame
        }
      : { success: true, state: 'inactive' };
  const publish = () => {
    if (session)
      broadcast({ action: 'diagnostics.test.observation', ...snapshot() });
  };
  return {
    handleMessage(request, sender, reply) {
      if (!request.action?.startsWith(PREFIX)) return false;
      const owner = ownerOf(sender);
      if (!owner) {
        reply({
          success: false,
          error: 'Scanner test is available only in Scanner Setup.'
        });
        return true;
      }
      if (request.action === `${PREFIX}read`) {
        reply(
          session && session.owner !== owner
            ? { success: false, error: 'Scanner test is in use.' }
            : snapshot()
        );
        return true;
      }
      if (request.action === `${PREFIX}start`) {
        if (session || !getWorker() || !isConnected()) {
          reply({
            success: false,
            error: session
              ? 'Scanner test is in use.'
              : 'Connect a scanner first.'
          });
          return true;
        }
        const current = {
          owner,
          id: crypto.randomUUID(),
          expiresAt: Date.now() + 60000,
          state: 'starting',
          bytes: 0,
          chunks: 0,
          frames: 0,
          lastFrame: null
        };
        session = current;
        void sendWorker('startTest', current).then((state) => {
          if (session !== current)
            return reply({
              success: false,
              error: 'Scanner test interrupted.'
            });
          if (!state.success || state.state !== 'active') {
            session = null;
            stopReconnect();
            return reply({
              success: false,
              error:
                'Scanner test could not start safely. Reconnect the scanner before clinical use.'
            });
          }
          current.state = 'active';
          reply(snapshot());
        });
        return true;
      }
      if (request.action === `${PREFIX}stop`) {
        if (!session || session.owner !== owner) {
          reply({
            success: false,
            error: 'No scanner test is owned by this page.'
          });
          return true;
        }
        const current = session;
        current.state = 'stopping';
        void sendWorker('stopTest', current).then((state) => {
          if (!state.success) stopReconnect();
          if (session === current) session = null;
          reply({
            success: !!state.success,
            state: state.success ? 'stopped' : 'paused'
          });
        });
        return true;
      }
      reply({ success: false, error: 'Unknown scanner test action.' });
      return true;
    },
    onWorkerMessage(data) {
      if (data.type === 'testState') {
        const resolve = pending.get(data.requestId);
        if (resolve) resolve(data);
        else if (
          session &&
          data.sessionId === session.id &&
          data.state !== 'active'
        ) {
          if (!data.success) stopReconnect();
          session.state = data.success ? 'expired' : 'paused';
          publish();
          session = null;
        }
        return true;
      }
      if (data.type !== 'testObservation') return false;
      if (
        !session ||
        session.state !== 'active' ||
        data.sessionId !== session.id ||
        Date.now() >= session.expiresAt
      )
        return true;
      if (data.kind === 'chunk') {
        session.chunks += 1;
        session.bytes += Math.max(
          0,
          Math.min(65536, Number(data.byteCount) || 0)
        );
      } else if (data.kind === 'frame') {
        session.frames += 1;
        session.lastFrame = {
          completionReason: ['terminator', 'idle', 'overflow'].includes(
            data.completionReason
          )
            ? data.completionReason
            : 'unknown',
          parsed: data.parsed === true,
          hasGtin: data.hasGtin === true,
          hasLot: data.hasLot === true,
          hasExpiry: data.hasExpiry === true,
          hasSerial: data.hasSerial === true,
          lookup: 'unavailable'
        };
      }
      publish();
      return true;
    },
    onStatus(status) {
      if (session && status?.state !== 'connected') this.onWorkerError();
    },
    onWorkerError() {
      if (!session) return;
      stopReconnect();
      for (const resolve of pending.values())
        resolve({ success: false, state: 'paused' });
      session.state = 'paused';
      publish();
      session = null;
    }
  };
}
