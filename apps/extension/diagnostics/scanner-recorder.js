import './collector.js';
import './producer.js';

// This recorder observes clinical reads only. It never receives barcode bytes.
export function createScannerRecorder({ post }) {
  let current = null;
  let lastReadAt = null;
  let chunkCount = 0;
  let firstAttempt = true;
  const producer = globalThis.VaxLinkDiagnosticEvents.createProducer({
    context: 'worker',
    deliver: (batch) =>
      post({
        type: 'diagnosticBatch',
        context: 'worker',
        contextId: producer.contextId,
        ...batch
      })
  });
  const safe = (fn, fallback = null) => {
    try {
      return fn();
    } catch (_) {
      return fallback;
    }
  };
  const reset = () => {
    current = null;
    lastReadAt = null;
    chunkCount = 0;
  };
  function attempt() {
    if (!current) current = producer.newOperation();
    return current;
  }
  function boundary(reason = 'user') {
    safe(() => {
      if (current && producer.active()) {
        producer.record(
          current,
          'lifecycle',
          reason === 'disconnect' ? 'interrupted' : 'cancelled',
          {
            reason: reason === 'disconnect' ? 'disconnect' : 'user'
          }
        );
      }
      reset();
    });
  }
  return Object.freeze({
    contextId: producer.contextId,
    setSession(summary) {
      safe(() => {
        const previous = producer.currentSession();
        if (
          previous &&
          summary &&
          previous.id === summary.id &&
          previous.recordingUntil === summary.recordingUntil
        )
          return;
        reset();
        producer.setSession(summary);
        firstAttempt = true;
      });
    },
    onRead({ owner, byteCount } = {}) {
      safe(() => {
        if (owner !== 'clinical' || !producer.active()) return;
        if (
          !Number.isSafeInteger(byteCount) ||
          byteCount < 0 ||
          byteCount > 1000000000
        )
          return;
        const link = attempt();
        if (!link) return;
        if (firstAttempt) {
          producer.record(link, 'lifecycle', 'partial', { reason: 'unknown' });
          firstAttempt = false;
        }
        const time = performance.now();
        const metadata = { byteCount, chunkCount: ++chunkCount };
        if (lastReadAt !== null)
          metadata.interChunkMs = Math.max(0, time - lastReadAt);
        lastReadAt = time;
        producer.record(link, 'serial_chunk', 'observed', { metadata });
      });
    },
    onFrame({ completionReason, owner } = {}) {
      return safe(() => {
        if (owner !== 'clinical' || !producer.active()) return null;
        const hadRead = current !== null;
        const link = attempt();
        if (!link) return null;
        if (!hadRead)
          producer.record(link, 'lifecycle', 'partial', { reason: 'unknown' });
        firstAttempt = false;
        const completion = ['terminator', 'idle', 'overflow'].includes(
          completionReason
        )
          ? completionReason
          : undefined;
        const options = {};
        if (completion) options.metadata = { completion };
        if (completion === 'overflow') options.reason = 'overflow';
        producer.record(
          link,
          'frame',
          completion === 'overflow' ? 'partial' : 'accepted',
          options
        );
        reset();
        return link;
      });
    },
    boundary,
    onDisconnect() {
      boundary('disconnect');
    }
  });
}
