// Offscreen documents relay worker evidence through runtime messages, not storage.
export function createDaemonRecorder({ getWorker }) {
  let contextId = null;
  let authorizedSession = null;
  let lastSessionId = null;
  let generation = 0;
  let dropped = 0;
  let queued = 0;
  let deliveries = Promise.resolve();
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  const send = async (message) => chrome.runtime.sendMessage(message);
  const countLost = (count, sessionId) => {
    if (sessionId === lastSessionId)
      dropped = Math.min(1000000, dropped + count);
  };
  async function join() {
    const attempt = ++generation;
    authorizedSession = null;
    if (!contextId || !getWorker()) return;
    try {
      const reply = await send({
        action: 'diagnostics.join',
        context: 'worker',
        contextId
      });
      if (generation !== attempt) return;
      const session = reply?.success ? reply.session : null;
      if (session?.id !== lastSessionId) dropped = 0;
      lastSessionId = session?.id || null;
      authorizedSession = session;
      getWorker()?.postMessage({ type: 'diagnosticSession', session });
    } catch (_) {
      // Evidence may be missing; scanner capture does not depend on this relay.
    }
  }
  async function forward(data) {
    if (
      !authorizedSession ||
      data.sessionId !== authorizedSession.id ||
      Date.now() >= authorizedSession.recordingUntil
    ) {
      countLost(data.events.length + data.dropped, data.sessionId);
      return;
    }
    const lost = Math.min(1000000, data.dropped + dropped);
    dropped = 0;
    const message = {
      action: 'diagnostics.events',
      context: 'worker',
      contextId,
      sessionId: data.sessionId,
      events: data.events,
      dropped: lost
    };
    try {
      let reply = await send(message);
      if (!reply?.success) {
        // A sleeping background worker loses context bindings, not the session.
        await join();
        if (authorizedSession?.id === data.sessionId)
          reply = await send(message);
      }
      if (!reply?.success) countLost(data.events.length + lost, data.sessionId);
    } catch (_) {
      countLost(data.events.length + lost, data.sessionId);
    }
  }
  return Object.freeze({
    onSession() {
      void join();
    },
    onWorkerMessage(data) {
      if (data.type === 'diagnosticContext') {
        if (uuid.test(data.contextId || '')) {
          contextId = data.contextId;
          void join();
        }
        return true;
      }
      if (data.type !== 'diagnosticBatch') return false;
      if (
        data.contextId !== contextId ||
        !Array.isArray(data.events) ||
        data.events.length > 25 ||
        !Number.isSafeInteger(data.dropped) ||
        data.dropped < 0 ||
        data.dropped > 1000000
      )
        return true;
      if (queued >= 4) {
        countLost(data.events.length + data.dropped, data.sessionId);
        return true;
      }
      queued += 1;
      deliveries = deliveries
        .catch(() => undefined)
        .then(() => forward(data))
        .finally(() => {
          queued -= 1;
        });
      return true;
    }
  });
}
