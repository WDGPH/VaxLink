// Local, bounded diagnostic observations. Callers must authenticate senders before recording.
(() => {
  const KEY = 'vaxlink_diagnostic_session_v1';
  const RECORDING_MS = 15 * 60 * 1000;
  const RETENTION_MS = 30 * 60 * 1000;
  const MAX_EVENTS = 1000;
  const MAX_BYTES = 1024 * 1024;
  const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const enums = {
    context: [
      'background',
      'offscreen',
      'content',
      'popup',
      'viewer',
      'worker'
    ],
    code: [
      'serial_chunk',
      'frame',
      'parse',
      'nvc',
      'route',
      'queue',
      'fill',
      'snapshot',
      'retry',
      'resource',
      'render',
      'lifecycle'
    ],
    outcome: [
      'observed',
      'accepted',
      'parsed',
      'enriched',
      'delivered',
      'queued',
      'pending',
      'verified',
      'partial',
      'failed',
      'cancelled',
      'superseded',
      'timed_out',
      'interrupted',
      'unknown',
      'skipped'
    ],
    reason: [
      'none',
      'unknown',
      'complete',
      'incomplete',
      'overflow',
      'disconnect',
      'invalid',
      'unavailable',
      'not_found',
      'no_match',
      'busy',
      'user',
      'navigation',
      'replaced',
      'expired',
      'storage',
      'duplicate',
      'unsupported',
      'timeout',
      'timer',
      'mutation',
      'min_gap',
      'settling'
    ],
    queueState: ['unknown', 'busy', 'idle'],
    phase: ['before', 'after', 'change', 'final'],
    completion: ['terminator', 'idle', 'overflow'],
    workflow: ['single', 'multiple', 'inventory', 'unknown'],
    field: [
      'agent',
      'lot',
      'funding',
      'date',
      'time',
      'reason',
      'consent',
      'unknown'
    ],
    resourceClass: [
      'document',
      'script',
      'stylesheet',
      'fetch',
      'xhr',
      'image',
      'other',
      'unknown'
    ]
  };
  const metadataTypes = {
    nodeId: 'uuid',
    formId: 'uuid',
    tabAlias: 'uuid',
    documentAlias: 'uuid',
    desiredMatchCount: 'count',
    repeated: 'count',
    transferSize: 'count',
    encodedSize: 'count',
    decodedSize: 'count',
    native: 'boolean',
    restricted: 'boolean',
    resourceTiming: 'boolean',
    longTasks: 'boolean',
    longAnimationFrames: 'boolean',
    queueState: 'queueState',
    phase: 'phase',
    completion: 'completion',
    ttfbMs: 'duration',
    responseMs: 'duration',
    scheduledMs: 'duration',
    actualMs: 'duration',
    interChunkMs: 'duration',
    count: 'count',
    byteCount: 'count',
    chunkCount: 'count',
    matchCount: 'count',
    optionCount: 'count',
    durationMs: 'duration',
    delayMs: 'duration',
    connected: 'boolean',
    enabled: 'boolean',
    requested: 'boolean',
    visible: 'boolean',
    matches: 'boolean',
    replaced: 'boolean',
    workflow: 'workflow',
    field: 'field',
    resourceClass: 'resourceClass'
  };
  const required = [
    'sessionId',
    'operationId',
    'context',
    'contextId',
    'seq',
    'observedAt',
    'code',
    'outcome'
  ];
  const allowed = new Set([
    ...required,
    'parentOperationId',
    'elapsedMs',
    'reason',
    'metadata'
  ]);
  const isObject = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const isUuid = (value) => typeof value === 'string' && UUID.test(value);
  const finite = (value, max) =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= max;
  const oneOf = (key, value) => enums[key].includes(value);
  const size = (value) =>
    new TextEncoder().encode(JSON.stringify(value)).length;

  function validateEvent(event, sessionId) {
    if (
      !isObject(event) ||
      Object.keys(event).some((key) => !allowed.has(key)) ||
      required.some((key) => !Object.hasOwn(event, key))
    )
      return false;
    if (
      event.sessionId !== sessionId ||
      !isUuid(event.sessionId) ||
      !isUuid(event.operationId) ||
      !isUuid(event.contextId)
    )
      return false;
    if (
      event.parentOperationId !== undefined &&
      !isUuid(event.parentOperationId)
    )
      return false;
    if (
      !oneOf('context', event.context) ||
      !oneOf('code', event.code) ||
      !oneOf('outcome', event.outcome)
    )
      return false;
    if (
      !Number.isSafeInteger(event.seq) ||
      event.seq < 0 ||
      !finite(event.observedAt, 8640000000000000)
    )
      return false;
    if (event.elapsedMs !== undefined && !finite(event.elapsedMs, 86400000))
      return false;
    if (event.reason !== undefined && !oneOf('reason', event.reason))
      return false;
    if (event.metadata !== undefined) {
      if (!isObject(event.metadata)) return false;
      for (const [key, value] of Object.entries(event.metadata)) {
        const type = metadataTypes[key];
        if (!Object.hasOwn(metadataTypes, key)) return false;
        if (type === 'uuid' && !isUuid(value)) return false;
        if (type === 'boolean' && typeof value !== 'boolean') return false;
        if (
          type === 'count' &&
          (!Number.isSafeInteger(value) || value < 0 || value > 1000000000)
        )
          return false;
        if (type === 'duration' && !finite(value, 86400000)) return false;
        if (enums[type] && !oneOf(type, value)) return false;
      }
    }
    return size(event) <= 4096;
  }

  function validateLink(link, sessionId) {
    return (
      isObject(link) &&
      Object.keys(link).every((key) =>
        ['sessionId', 'operationId', 'parentOperationId'].includes(key)
      ) &&
      isUuid(sessionId) &&
      link.sessionId === sessionId &&
      isUuid(link.operationId) &&
      (link.parentOperationId === undefined || isUuid(link.parentOperationId))
    );
  }

  function createCollector({
    storage,
    now = Date.now,
    randomUUID = () => crypto.randomUUID()
  }) {
    let chain = Promise.resolve();
    function serial(action) {
      const result = chain.catch(() => undefined).then(action);
      chain = result;
      return result;
    }
    async function load() {
      const current = (await storage.get(KEY))[KEY] || null;
      if (!current) return null;
      const time = now();
      if (time >= current.expiresAt) {
        await storage.remove(KEY);
        return null;
      }
      if (current.state === 'recording' && time >= current.recordingUntil) {
        current.state = 'stopped';
        current.stoppedAt = current.recordingUntil;
        current.expiresAt = current.recordingUntil + RETENTION_MS;
        if (time >= current.expiresAt) {
          await storage.remove(KEY);
          return null;
        }
        await storage.set({ [KEY]: current });
      }
      return current;
    }
    return {
      start: () =>
        serial(async () => {
          await load();
          const time = now();
          const id = randomUUID();
          if (!isUuid(id))
            throw new Error('Invalid diagnostic session identifier');
          const session = {
            version: 1,
            id,
            state: 'recording',
            startedAt: time,
            recordingUntil: time + RECORDING_MS,
            expiresAt: time + RECORDING_MS + RETENTION_MS,
            dropped: 0,
            events: []
          };
          await storage.set({ [KEY]: session });
          return session;
        }),
      stop: () =>
        serial(async () => {
          const session = await load();
          if (!session) return null;
          if (session.state === 'recording') {
            session.state = 'stopped';
            session.stoppedAt = now();
            session.expiresAt = session.stoppedAt + RETENTION_MS;
            await storage.set({ [KEY]: session });
          }
          return session;
        }),
      clear: () =>
        serial(async () => {
          await load();
          await storage.remove(KEY);
        }),
      read: () => serial(load),
      recordBatch: (events, producerDropped = 0) =>
        serial(async () => {
          const session = await load();
          if (!session || session.state !== 'recording')
            return { accepted: 0, dropped: 0 };
          if (!Array.isArray(events) || events.length > 25)
            throw new Error('Invalid diagnostic batch');
          if (
            !Number.isSafeInteger(producerDropped) ||
            producerDropped < 0 ||
            producerDropped > 1000000000
          )
            throw new Error('Invalid producer drop count');
          let accepted = 0;
          let dropped = 0;
          for (const event of events) {
            if (!validateEvent(event, session.id)) {
              dropped += 1;
              continue;
            }
            const copy = JSON.parse(JSON.stringify(event));
            copy.receivedAt = now();
            const terminal =
              (event.code === 'fill' &&
                [
                  'verified',
                  'failed',
                  'cancelled',
                  'superseded',
                  'timed_out',
                  'interrupted'
                ].includes(event.outcome)) ||
              (['parse', 'nvc', 'queue'].includes(event.code) &&
                event.outcome === 'failed');
            let removed = null;
            let removedIndex = -1;
            if (
              session.events.length >= MAX_EVENTS ||
              size(session) + size(copy) + 1 > MAX_BYTES
            ) {
              if (terminal) {
                removedIndex = session.events.findIndex((entry) =>
                  ['snapshot', 'retry', 'resource', 'render'].includes(
                    entry.code
                  )
                );
                if (removedIndex >= 0)
                  removed = session.events.splice(removedIndex, 1)[0];
              }
              if (!removed) {
                dropped += 1;
                continue;
              }
            }
            session.events.push(copy);
            if (size(session) > MAX_BYTES) {
              session.events.pop();
              if (removed) session.events.splice(removedIndex, 0, removed);
              dropped += 1;
            } else {
              accepted += 1;
              if (removed) dropped += 1;
            }
          }
          session.dropped += dropped + producerDropped;
          await storage.set({ [KEY]: session });
          return { accepted, dropped };
        }),
      record(event) {
        return this.recordBatch([event]).then(
          (result) => result.accepted === 1
        );
      }
    };
  }
  globalThis.VaxLinkDiagnosticCollector = Object.freeze({
    createCollector,
    validateEvent,
    validateLink
  });
})();
