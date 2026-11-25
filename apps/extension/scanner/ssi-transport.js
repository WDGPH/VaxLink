import { isScannerFeedbackResult } from './scanner-daemon-shared.js';
import { bytesToHex } from './serial-decoder.js';

const ACK = 0xd0;
const NAK = 0xd1;
const BEEP = 0xe6;
const DECODE_DATA = 0xf3;
const EVENT = 0xf6;
const RESEND = 1;
const CANCEL = 10;
const RETRANSMIT = 1;
const CONTINUATION = 2;
const HOST_SOURCE = 4;
const HEADER_LENGTH = 4;

const RESPONSE_TIMEOUT_MS = 2000;
const RETRIES = 2;
const PARTIAL_PACKET_TIMEOUT_MS = 500;
const PARTIAL_BARCODE_TIMEOUT_MS = RESPONSE_TIMEOUT_MS * (RETRIES + 1);
const MAX_BARCODE_BYTES = 8192;
const MAX_PENDING_FEEDBACK = 4;
const WAKE_SETTLE_MS = 100;
const BEEP_CODES = { works: 0x00, attention: 0x06, expired: 0x11 };

function checksum(bytes) {
  return -bytes.reduce((sum, byte) => sum + byte, 0) & 0xffff;
}

function hostPacket(opcode, status = 0, data = []) {
  const message = [
    HEADER_LENGTH + data.length,
    opcode,
    HOST_SOURCE,
    status,
    ...data
  ];
  const check = checksum(message);
  return Uint8Array.from([...message, check >> 8, check & 0xff]);
}

function decodeKey(status, data) {
  return bytesToHex([status & ~RETRANSMIT, ...data]);
}

export function createSsiTransport(writer, onFrame) {
  let packet = [];
  let lastBytesAt = 0;
  let lastScannerPacketAt = -Infinity;
  let partialBarcode = null;
  let lastDecodePacket = null;
  let rejectedFirstAt = -Infinity;
  let cancelledDecodePacket = null;
  let feedbackTail = Promise.resolve();
  let pendingFeedback = 0;
  let onCommandReply = null;
  let cancelCommand = null;
  let feedbackAvailable = true;
  let closed = false;

  function write(bytes) {
    // The single stream writer serializes whole packets. A pending BEEP reply
    // does not hold the writer and cannot delay a required scanner ACK.
    return writer.write(bytes).then(
      () => true,
      () => false
    );
  }

  function decodeBarcode(data, status, now) {
    const retransmitted = (status & RETRANSMIT) !== 0;
    const continued = (status & CONTINUATION) !== 0;
    const [codeType, ...fragment] = data;
    // Option 1 resends the last unacknowledged packet. A deliberate repeat
    // has the retransmit bit clear and is accepted even if the bytes match.
    const key = decodeKey(status, data);
    const retriesRejectedFirst =
      now - rejectedFirstAt < PARTIAL_BARCODE_TIMEOUT_MS;
    rejectedFirstAt = -Infinity;
    if (
      retransmitted &&
      cancelledDecodePacket?.key === key &&
      now - cancelledDecodePacket.at < PARTIAL_BARCODE_TIMEOUT_MS
    ) {
      void write(hostPacket(NAK, 0, [CANCEL]));
      return;
    }
    cancelledDecodePacket = null;
    if (
      retransmitted &&
      !retriesRejectedFirst &&
      lastDecodePacket?.key === key &&
      now - lastDecodePacket.at < PARTIAL_BARCODE_TIMEOUT_MS
    ) {
      if (partialBarcode) partialBarcode.rejected = 0;
      void write(hostPacket(ACK));
      return;
    }
    if (!retransmitted && partialBarcode?.rejected) {
      // An outstanding NAK requires a retry for this barcode to continue.
      // A first transmission means the scanner has started a new barcode.
      partialBarcode = null;
    }
    const bytes = partialBarcode?.bytes ?? [];
    if (
      codeType === undefined ||
      (partialBarcode &&
        (partialBarcode.codeType !== codeType ||
          now - partialBarcode.at >= PARTIAL_BARCODE_TIMEOUT_MS)) ||
      bytes.length + fragment.length > MAX_BARCODE_BYTES
    ) {
      partialBarcode = null;
      // SSI has no fragment number or start bit. After a timeout this could
      // be an orphaned tail. Cancel the message before accepting another scan.
      cancelledDecodePacket = { key, at: now };
      void write(hostPacket(NAK, 0, [CANCEL]));
      return;
    }

    lastDecodePacket = { key, at: now };
    bytes.push(...fragment);
    partialBarcode = continued
      ? { codeType, bytes, at: now, rejected: 0 }
      : null;
    void write(hostPacket(ACK));
    if (!continued) {
      // Type 0x99 contains structured PDF417 records, not plain decode text.
      // Keep it visible as unsupported without feeding its binary fields to GS1.
      const text =
        codeType === 0x99
          ? 'Unsupported structured SSI barcode'
          : String.fromCharCode(...bytes);
      onFrame({ text, rawBytesHex: bytesToHex(bytes) });
    }
  }

  function receive(message, now) {
    const [length, opcode, , status] = message;
    const actualChecksum = (message[length] << 8) | message[length + 1];
    const expectedChecksum = checksum(message.slice(0, length));
    if (actualChecksum !== expectedChecksum) {
      if (opcode === DECODE_DATA) {
        if (partialBarcode && ++partialBarcode.rejected > RETRIES) {
          // The scanner has exhausted this fragment's attempts. Discard the
          // prefix so the next scan cannot be joined to an abandoned barcode.
          partialBarcode = null;
          rejectedFirstAt = -Infinity;
          const key = decodeKey(status, message.slice(HEADER_LENGTH, length));
          cancelledDecodePacket = { key, at: now };
          void write(hostPacket(NAK, 0, [CANCEL]));
          return;
        }
        if (!(status & RETRANSMIT)) {
          // Option 1 retries only one outstanding packet. Its damaged bytes
          // can differ from the retry and cannot identify it. If restoring
          // the retry bit exactly matches the last accepted packet, it could
          // instead be that packet's retry with a damaged status byte.
          const acceptedRetry =
            actualChecksum === ((expectedChecksum - 1) & 0xffff) &&
            lastDecodePacket?.key ===
              decodeKey(status, message.slice(HEADER_LENGTH, length));
          if (!acceptedRetry) rejectedFirstAt = now;
        }
        void write(hostPacket(NAK, 0, [RESEND]));
      }
      return;
    }

    lastScannerPacketAt = now;
    if (opcode === ACK && length === HEADER_LENGTH) {
      onCommandReply?.('ack');
    } else if (opcode === NAK && length === HEADER_LENGTH + 1) {
      onCommandReply?.(message[HEADER_LENGTH] === RESEND ? 'resend' : 'denied');
    } else if (opcode === DECODE_DATA) {
      decodeBarcode(message.slice(HEADER_LENGTH, length), status, now);
    } else if (opcode === EVENT) {
      void write(hostPacket(ACK));
    }
  }

  function beepAttempt(result, attempt, expiresAt) {
    return new Promise((resolve) => {
      let finished = false;
      let wakeTimer;
      let timer = setTimeout(() => finish('writeFailed'), RESPONSE_TIMEOUT_MS);

      function finish(reply) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(wakeTimer);
        onCommandReply = null;
        cancelCommand = null;
        resolve(reply);
      }

      function send() {
        if (finished) return;
        if (Date.now() >= expiresAt) {
          finish('expired');
          return;
        }
        onCommandReply = finish;
        void write(
          hostPacket(BEEP, attempt ? RETRANSMIT : 0, [BEEP_CODES[result]])
        ).then((written) => {
          if (finished) return;
          if (!written) {
            finish('writeFailed');
            return;
          }
          clearTimeout(timer);
          timer = setTimeout(() => finish('timeout'), RESPONSE_TIMEOUT_MS);
        });
      }

      cancelCommand = () => finish('closed');
      if (Date.now() >= expiresAt) {
        finish('expired');
      } else if (Date.now() - lastScannerPacketAt < WAKE_SETTLE_MS) {
        send();
      } else {
        // The USB cradle may bypass wired RTS/CTS. Wake an idle scanner before
        // a host-initiated command. A recently received scan can be ACKed at once.
        void write(Uint8Array.of(0)).then((written) => {
          if (finished) return;
          if (written) wakeTimer = setTimeout(send, WAKE_SETTLE_MS);
          else finish('writeFailed');
        });
      }
    });
  }

  async function play(result, expiresAt) {
    if (closed || Date.now() >= expiresAt)
      return { success: false, error: 'Scanner feedback expired.' };
    if (!feedbackAvailable)
      return {
        success: false,
        error: 'Reconnect the scanner before testing feedback again.'
      };
    let reply;
    let timedOut = false;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      if (Date.now() >= expiresAt) break;
      reply = await beepAttempt(result, attempt, expiresAt);
      timedOut ||= reply === 'timeout';
      if (reply !== 'timeout' && reply !== 'resend') break;
    }
    if (reply === 'ack') return { success: true };
    if (timedOut || reply === 'writeFailed') {
      // ACKs carry no command ID. A late ACK must not confirm a different beep.
      feedbackAvailable = false;
    }
    return {
      success: false,
      error: 'The scanner did not confirm the feedback sound.'
    };
  }

  return {
    push(chunk) {
      if (closed) return;
      const now = Date.now();
      if (now - lastBytesAt >= PARTIAL_PACKET_TIMEOUT_MS) packet = [];
      lastBytesAt = now;
      for (const byte of chunk) {
        packet.push(byte);
        // A packet can have at most 257 bytes, including its two checksum bytes.
        // Skip wake characters and invalid headers while looking for its start.
        while (
          packet.length &&
          (packet[0] < HEADER_LENGTH ||
            (packet.length >= HEADER_LENGTH && packet[2] !== 0))
        ) {
          packet.shift();
        }
        if (packet.length === packet[0] + 2) {
          const message = packet;
          packet = [];
          receive(message, now);
        }
      }
    },

    playFeedback(result, expiresAt = Infinity) {
      if (
        !isScannerFeedbackResult(result) ||
        pendingFeedback >= MAX_PENDING_FEEDBACK ||
        (expiresAt === Infinity && pendingFeedback > 0)
      ) {
        return Promise.resolve({
          success: false,
          error: 'Scanner feedback is unavailable.'
        });
      }
      pendingFeedback++;
      feedbackTail = feedbackTail
        .then(() => play(result, expiresAt))
        .finally(() => {
          pendingFeedback--;
        });
      return feedbackTail;
    },

    close() {
      if (closed) return;
      closed = true;
      cancelCommand?.();
      packet = [];
      partialBarcode = null;
      lastDecodePacket = null;
      rejectedFirstAt = -Infinity;
      cancelledDecodePacket = null;
      // Release immediately so port.close can interrupt a stalled serial write.
      void writer.abort().catch(() => undefined);
      writer.releaseLock();
    }
  };
}
