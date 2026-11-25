function toByteArray(chunk) {
  if (!chunk) return [];
  if (Array.isArray(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Array.from(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return Array.from(
      new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    );
  }
  if (chunk instanceof ArrayBuffer) return Array.from(new Uint8Array(chunk));
  return [];
}

export function bytesToHex(bytes) {
  return toByteArray(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ');
}

function byteToText(byte, encoding) {
  if (encoding !== 'ascii') {
    return new TextDecoder(encoding || 'utf-8').decode(new Uint8Array([byte]));
  }
  return String.fromCharCode(byte);
}

function findTerminator(text, delimiters) {
  const ordered = [...delimiters].sort((a, b) => b.length - a.length);
  return (
    ordered.find((delimiter) => delimiter && text.endsWith(delimiter)) || ''
  );
}

export function createLineFrameDecoder(options = {}) {
  const encoding = options.encoding || 'ascii';
  const delimiters =
    Array.isArray(options.delimiters) && options.delimiters.length > 0
      ? options.delimiters
      : ['\r\n', '\n', '\r'];
  const maxFrameLength = Number(options.maxFrameLength || 512);
  const requireTerminator = options.requireTerminator === true;
  const delimiterTail =
    Math.max(...delimiters.map((delimiter) => delimiter.length)) - 1;
  let textBuffer = '';
  let byteBuffer = [];
  let discarding = false;

  const emitFrame = (terminator = '') => {
    const terminatorLength = terminator.length;
    const frameText =
      terminatorLength > 0
        ? textBuffer.slice(0, -terminatorLength)
        : textBuffer;
    const frameBytes =
      terminatorLength > 0
        ? byteBuffer.slice(0, -terminatorLength)
        : byteBuffer.slice();
    textBuffer = '';
    byteBuffer = [];
    const trimmed = frameText.trim();
    if (!trimmed || (requireTerminator && frameText.length > maxFrameLength))
      return null;
    return {
      text: trimmed,
      rawBytesHex: bytesToHex(frameBytes)
    };
  };

  return {
    push(chunk) {
      const frames = [];
      for (const byte of toByteArray(chunk)) {
        textBuffer += byteToText(byte, encoding);
        const terminator = findTerminator(textBuffer, delimiters);
        if (discarding) {
          textBuffer = terminator
            ? ''
            : textBuffer.slice(textBuffer.length - delimiterTail);
          discarding = !terminator;
          continue;
        }
        byteBuffer.push(byte);
        if (terminator) {
          const frame = emitFrame(terminator);
          if (frame) frames.push(frame);
          continue;
        }

        if (
          requireTerminator &&
          textBuffer.length > maxFrameLength + delimiterTail
        ) {
          // A broken upload must never turn its trailing bytes into a scan.
          textBuffer = textBuffer.slice(textBuffer.length - delimiterTail);
          byteBuffer = [];
          discarding = true;
        } else if (!requireTerminator && textBuffer.length > maxFrameLength) {
          const frame = emitFrame('');
          if (frame) frames.push(frame);
        }
      }
      return frames;
    },

    flush() {
      if (requireTerminator) return [];
      const frame = emitFrame('');
      return frame ? [frame] : [];
    },

    hasBufferedData() {
      return textBuffer.length > 0 || byteBuffer.length > 0;
    },

    reset() {
      textBuffer = '';
      byteBuffer = [];
      discarding = false;
    }
  };
}
