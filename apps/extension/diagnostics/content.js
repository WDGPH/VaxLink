// Loaded only in diagnostic-capable packages, after collector.js and producer.js.
(() => {
  function create() {
    const { validateLink } = globalThis.VaxLinkDiagnosticCollector;
    const observers = [];
    let expiryTimer = null;
    let generation = 0;
    let sessionId = null;
    let nodeIds = new WeakMap();
    let formIds = new WeakMap();
    let snapshots = new Map();
    let started = new Map();
    let marks = [];
    let pageLink = null;
    let lastSnapshotAt = -Infinity;
    const now = () => {
      try {
        const value = performance.now();
        return Number.isFinite(value) ? value : undefined;
      } catch (_) {
        return undefined;
      }
    };
    const send = (message) =>
      Promise.resolve().then(() => chrome.runtime.sendMessage(message));
    const producer = globalThis.VaxLinkDiagnosticEvents.createProducer({
      context: 'content',
      deliver: async (batch) => {
        const result = await sendWithRejoin(
          {
            action: 'diagnostics.events',
            context: 'content',
            contextId: producer.contextId,
            ...batch
          },
          batch.sessionId
        );
        if (!result?.success) throw new Error('Diagnostic delivery failed');
      },
      onSession: (session) => {
        if (!session) close();
      }
    });
    function close() {
      for (const observer of observers.splice(0)) observer.disconnect();
      if (expiryTimer !== null) clearTimeout(expiryTimer);
      expiryTimer = null;
      for (const name of marks) {
        try {
          performance.clearMarks?.(name);
        } catch (_) {
          /* Optional browser evidence. */
        }
      }
      marks = [];
      snapshots = new Map();
      started = new Map();
      nodeIds = new WeakMap();
      formIds = new WeakMap();
      pageLink = null;
      sessionId = null;
      lastSnapshotAt = -Infinity;
    }
    function setBounded(map, key, value, limit) {
      if (!map.has(key) && map.size >= limit)
        map.delete(map.keys().next().value);
      map.set(key, value);
    }
    function alias(map, node) {
      if (!node || (typeof node !== 'object' && typeof node !== 'function'))
        return undefined;
      if (!map.has(node)) map.set(node, crypto.randomUUID());
      return map.get(node);
    }
    function formAlias(node) {
      if (!producer.active() || !node) return undefined;
      const form = node.form || node.closest?.('form');
      return alias(formIds, form);
    }
    function record(link, code, outcome, details = {}) {
      if (!producer.active() || !link) return false;
      const began = started.get(link.operationId);
      const options = { ...details };
      const observed = now();
      if (
        Number.isFinite(began) &&
        Number.isFinite(observed) &&
        options.elapsedMs === undefined
      )
        options.elapsedMs = Math.min(86400000, Math.max(0, observed - began));
      const accepted = producer.record(link, code, outcome, options);
      if (accepted && marks.length < 1000) {
        try {
          if (typeof performance.mark === 'function') {
            const name = `vaxlink:${link.operationId}:${code}:${outcome}:${marks.length}`;
            performance.mark(name);
            marks.push(name);
          }
        } catch (_) {
          /* Optional browser evidence. */
        }
      }
      return accepted;
    }
    function begin(link, queueRecordId) {
      const session = producer.currentSession();
      if (!session) return null;
      const adopted = validateLink(link, session.id)
        ? { ...link }
        : producer.newOperation();
      if (!adopted) return null;
      setBounded(started, adopted.operationId, now(), 128);
      if (!validateLink(link, session.id))
        record(adopted, 'lifecycle', 'partial', { reason: 'unknown' });
      if (
        typeof queueRecordId === 'string' &&
        queueRecordId.length > 0 &&
        queueRecordId.length <= 128
      ) {
        void sendWithRejoin(
          {
            action: 'diagnostics.queueParent',
            context: 'content',
            contextId: producer.contextId,
            sessionId: session.id,
            recordId: queueRecordId
          },
          session.id
        )
          .then((result) => {
            const linked = {
              ...adopted,
              parentOperationId: result?.parentOperationId
            };
            if (
              result?.success &&
              validateLink(linked, session.id) &&
              producer.currentSession()?.id === session.id
            )
              record(linked, 'queue', 'accepted');
          })
          .catch(() => {});
      }
      return adopted;
    }
    function snapshot(link, phase, groups) {
      if (!producer.active() || !link || !Array.isArray(groups)) return;
      const time = now();
      if (
        phase !== 'before' &&
        phase !== 'final' &&
        time - lastSnapshotAt < 200
      )
        return;
      lastSnapshotAt = time;
      for (const group of groups) {
        if (!group || !Array.isArray(group.nodes)) continue;
        const nodes = group.nodes.slice(0, 50);
        for (const [index, node] of (nodes.length ? nodes : [null]).entries()) {
          const nodeId = alias(nodeIds, node);
          const formId = formAlias(node);
          const key = `${link.operationId}:${group.field}:${group.native ? 'native' : 'widget'}:${index}`;
          const previous = snapshots.get(key);
          let visible = false;
          if (node?.getBoundingClientRect) {
            const rect = node.getBoundingClientRect();
            visible = rect.width > 0 && rect.height > 0;
            const style = globalThis.getComputedStyle?.(node);
            if (
              style?.visibility === 'hidden' ||
              style?.visibility === 'collapse'
            )
              visible = false;
          }
          const metadata = {
            phase,
            field: group.field,
            native: !!group.native,
            matchCount: Math.min(group.nodes.length, 1000000000),
            connected: !!node?.isConnected,
            enabled:
              !!node &&
              (group.enabled
                ? !!group.enabled(node)
                : !node.disabled && !node.readOnly),
            requested: group.requested !== false,
            visible,
            optionCount: Math.min(node?.options?.length || 0, 1000000000),
            desiredMatchCount: Math.min(
              1000000000,
              Math.max(0, Number(group.desiredMatches?.(node)) || 0)
            ),
            matches: !!node && !!group.matches?.(node),
            replaced: !!previous && previous.nodeId !== nodeId
          };
          if (nodeId) metadata.nodeId = nodeId;
          if (formId) metadata.formId = formId;
          const state = JSON.stringify({
            ...metadata,
            phase: undefined,
            replaced: undefined
          });
          if (
            previous?.state === state &&
            phase !== 'before' &&
            phase !== 'final'
          ) {
            previous.repeated++;
            continue;
          }
          if (previous?.repeated)
            metadata.repeated = Math.min(previous.repeated, 1000000000);
          if (record(link, 'snapshot', 'observed', { metadata }))
            setBounded(snapshots, key, { state, nodeId, repeated: 0 }, 1000);
        }
      }
    }
    function startPerformance() {
      const types = globalThis.PerformanceObserver?.supportedEntryTypes || [];
      const supported = (type) => types.includes(type);
      pageLink = producer.newOperation();
      if (!pageLink) return;
      const captureStart = now();
      setBounded(started, pageLink.operationId, captureStart, 128);
      const capabilities = {
        resourceTiming: false,
        longTasks: false,
        longAnimationFrames: false
      };
      for (const type of ['resource', 'longtask', 'long-animation-frame']) {
        if (!supported(type) || !Number.isFinite(captureStart)) continue;
        let count = 0;
        let finished = false;
        const limit = type === 'resource' ? 100 : 40;
        try {
          const observer = new PerformanceObserver((list) => {
            if (finished || !producer.active()) return;
            const finish = () => {
              if (finished || count < limit) return;
              finished = true;
              record(pageLink, 'lifecycle', 'observed', {
                reason: 'overflow',
                metadata: {
                  count,
                  resourceTiming: type === 'resource',
                  longTasks: type === 'longtask',
                  longAnimationFrames: type === 'long-animation-frame'
                }
              });
              observer.disconnect();
              const index = observers.indexOf(observer);
              if (index >= 0) observers.splice(index, 1);
            };
            for (const entry of list.getEntries()) {
              if (!producer.active() || finished) break;
              if (
                type === 'resource' &&
                (!Number.isFinite(entry.startTime) ||
                  entry.startTime < captureStart)
              )
                continue;
              count++;
              // Free batch space before a large callback reaches its limit marker.
              if (type === 'resource' && count === 75) void producer.flush();
              const duration = Math.min(
                86400000,
                Math.max(0, Number(entry.duration) || 0)
              );
              if (type !== 'resource') {
                record(pageLink, 'render', 'observed', {
                  metadata: {
                    durationMs: duration,
                    longTasks: type === 'longtask',
                    longAnimationFrames: type === 'long-animation-frame'
                  }
                });
                finish();
                continue;
              }
              const classes = {
                document: 'document',
                script: 'script',
                link: 'stylesheet',
                css: 'stylesheet',
                fetch: 'fetch',
                xmlhttprequest: 'xhr',
                img: 'image',
                image: 'image'
              };
              const responseStart = Number(entry.responseStart) || 0;
              const requestStart = Number(entry.requestStart) || 0;
              const metadata = {
                resourceClass: classes[entry.initiatorType] || 'other',
                durationMs: duration,
                restricted: !requestStart || !responseStart
              };
              if (requestStart && responseStart >= requestStart)
                metadata.ttfbMs = Math.min(
                  86400000,
                  responseStart - requestStart
                );
              if (responseStart && entry.responseEnd >= responseStart)
                metadata.responseMs = Math.min(
                  86400000,
                  entry.responseEnd - responseStart
                );
              for (const [key, prop] of [
                ['transferSize', 'transferSize'],
                ['encodedSize', 'encodedBodySize'],
                ['decodedSize', 'decodedBodySize']
              ]) {
                const value = Number(entry[prop]);
                if (Number.isSafeInteger(value) && value > 0)
                  metadata[key] = Math.min(1000000000, value);
              }
              const end = Number(entry.responseEnd);
              const options = { metadata };
              if (Number.isFinite(end) && end >= captureStart && end <= now()) {
                options.elapsedMs = Math.min(86400000, end - captureStart);
                metadata.delayMs = Math.min(86400000, now() - end);
              }
              record(pageLink, 'resource', 'observed', options);
              finish();
            }
          });
          observer.observe({ type });
          observers.push(observer);
          capabilities[
            type === 'resource'
              ? 'resourceTiming'
              : type === 'longtask'
                ? 'longTasks'
                : 'longAnimationFrames'
          ] = true;
        } catch (_) {
          /* Unsupported observer is optional. */
        }
      }
      record(pageLink, 'lifecycle', 'observed', { metadata: capabilities });
    }
    async function sendWithRejoin(message, expectedSessionId) {
      let result;
      try {
        result = await send(message);
      } catch (_) {
        result = null;
      }
      if (result?.success) return result;
      if (producer.currentSession()?.id !== expectedSessionId) return result;
      const rebound = await join(generation);
      if (!rebound || producer.currentSession()?.id !== expectedSessionId)
        return result;
      return send(message);
    }
    async function join(expectedGeneration) {
      try {
        const result = await send({
          action: 'diagnostics.join',
          context: 'content',
          contextId: producer.contextId
        });
        if (generation !== expectedGeneration) return false;
        const next = result?.success ? result.session : null;
        if (next?.id === sessionId && producer.active()) return true;
        close();
        producer.setSession(next);
        const session = producer.currentSession();
        if (!session) return false;
        sessionId = session.id;
        expiryTimer = setTimeout(
          () => {
            producer.setSession(null);
          },
          Math.max(0, session.recordingUntil - Date.now())
        );
        startPerformance();
        return true;
      } catch (_) {
        /* Recording must never block clinical work. */
        return false;
      }
    }
    function boot() {
      void join(++generation);
    }
    function onSession(summary) {
      ++generation;
      if (!summary || summary.id !== sessionId) {
        close();
        producer.setSession(null);
      }
      if (summary) void join(generation);
    }
    return Object.freeze({
      boot,
      onSession,
      active: () => producer.active(),
      begin,
      record,
      snapshot,
      formAlias
    });
  }
  globalThis.VaxLinkContentDiagnostics = Object.freeze({ create });
})();
