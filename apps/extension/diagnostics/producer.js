// Callers own transport and must load collector.js before this file.
(() => {
  const { validateEvent, validateLink } = globalThis.VaxLinkDiagnosticCollector;
  function createProducer({ context, deliver, onSession }) {
    const contextId = crypto.randomUUID();
    let session = null;
    let queue = [];
    let dropped = 0;
    let sequence = 0;
    let timer = null;
    let sending = false;
    let inFlight = null;
    let dropRetryAvailable = false;

    function clear() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      queue = [];
      dropped = 0;
      dropRetryAvailable = false;
    }
    function active() {
      if (session && Date.now() >= session.recordingUntil) {
        session = null;
        clear();
        if (onSession) onSession(null);
      }
      return session !== null;
    }
    function schedule() {
      if (timer === null && !sending && (queue.length || dropped)) {
        timer = setTimeout(() => {
          timer = null;
          void flush();
        }, 100);
      }
    }
    function flush() {
      if (inFlight)
        return inFlight.then(() => (queue.length ? flush() : undefined));
      if (!active() || (!queue.length && (!dropped || !dropRetryAvailable)))
        return Promise.resolve();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const current = session;
      sending = true;
      inFlight = (async () => {
        // The queue is bounded to 100 events. Drain only the work present when
        // flush began, so ongoing capture cannot make a stop wait indefinitely.
        let batches = Math.ceil(queue.length / 25) || 1;
        while (batches-- > 0 && session === current && active()) {
          const events = queue.splice(0, 25);
          if (!events.length && (!dropped || !dropRetryAvailable)) break;
          if (!events.length) dropRetryAvailable = false;
          const lost = dropped;
          dropped = 0;
          try {
            await deliver({ sessionId: current.id, events, dropped: lost });
          } catch (_) {
            if (session === current && active()) {
              dropped += events.length + lost;
              if (events.length) dropRetryAvailable = true;
            }
            break;
          }
        }
      })().finally(() => {
        sending = false;
        inFlight = null;
        if (active() && (queue.length || (dropped && dropRetryAvailable)))
          schedule();
      });
      return inFlight;
    }

    return Object.freeze({
      context,
      contextId,
      setSession(next) {
        clear();
        session =
          next &&
          validateLink(
            { sessionId: next.id, operationId: contextId },
            next.id
          ) &&
          typeof next.recordingUntil === 'number' &&
          Number.isFinite(next.recordingUntil) &&
          Date.now() < next.recordingUntil
            ? { id: next.id, recordingUntil: next.recordingUntil }
            : null;
        if (onSession) onSession(session && { ...session });
      },
      active,
      currentSession() {
        return active() ? { ...session } : null;
      },
      newOperation(parentOperationId) {
        if (!active()) return null;
        const link = {
          sessionId: session.id,
          operationId: crypto.randomUUID()
        };
        if (parentOperationId !== undefined)
          link.parentOperationId = parentOperationId;
        return validateLink(link, session.id) ? link : null;
      },
      record(link, code, outcome, options = {}) {
        if (!active() || !validateLink(link, session.id)) return false;
        if (
          !options ||
          typeof options !== 'object' ||
          Array.isArray(options) ||
          Object.keys(options).some(
            (key) => !['reason', 'metadata', 'elapsedMs'].includes(key)
          )
        )
          return false;
        const event = {
          ...link,
          context,
          contextId,
          seq: sequence++,
          observedAt: Date.now(),
          code,
          outcome,
          ...options
        };
        if (!validateEvent(event, session.id)) return false;
        if (queue.length >= 100) {
          dropped += 1;
          schedule();
          return false;
        }
        dropRetryAvailable = false;
        queue.push(JSON.parse(JSON.stringify(event)));
        schedule();
        return true;
      },
      pendingCount() {
        return queue.length + dropped;
      },
      flush
    });
  }
  globalThis.VaxLinkDiagnosticEvents = Object.freeze({ createProducer });
})();
