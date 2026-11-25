import { makeScanEvent } from './scanner-events.js';
import { createLineFrameDecoder } from './serial-decoder.js';
import { getSerialScannerProfile } from './serial-profiles.js';
import { createSsiTransport } from './ssi-transport.js';

export function isWebSerialSupported() {
  return !!(globalThis.navigator && 'serial' in globalThis.navigator);
}

export async function getGrantedSerialScannerPorts() {
  if (!isWebSerialSupported()) return [];
  return navigator.serial.getPorts();
}

export async function requestSerialScannerPort(profile) {
  if (!isWebSerialSupported()) {
    throw new Error('Web Serial is not available in this browser context');
  }
  const filters = Array.isArray(profile?.filters) ? profile.filters : [];
  return navigator.serial.requestPort(filters.length > 0 ? { filters } : {});
}

export async function openSerialScanner(port, profileConfig, handlers = {}) {
  if (!port) {
    throw new Error('Missing serial port');
  }

  const profile = getSerialScannerProfile(profileConfig?.id || profileConfig);
  const onScan = typeof handlers === 'function' ? handlers : handlers.onScan;
  const onStatus =
    typeof handlers.onStatus === 'function' ? handlers.onStatus : () => {};
  const onError =
    typeof handlers.onError === 'function' ? handlers.onError : () => {};
  const { signal } = handlers;
  const decoder =
    profile.protocol === 'ssi'
      ? null
      : createLineFrameDecoder(profile.decoder || {});
  let ssi = null;
  const idleFlushMs = Number(profile.decoder?.idleFlushMs || 0);
  let keepReading = true;
  let activeReader = null;
  let idleFlushTimer = null;
  let terminalReadError = null;

  const clearIdleFlush = () => {
    if (idleFlushTimer) {
      clearTimeout(idleFlushTimer);
      idleFlushTimer = null;
    }
  };

  const emitFrame = (frame) => {
    const scan = makeScanEvent({
      rawText: frame.text,
      source: 'web-serial',
      rawBytesHex: frame.rawBytesHex,
      device: {
        profileId: profile.id,
        label: profile.label,
        usbInfo: port.getInfo()
      }
    });
    if (typeof onScan === 'function') onScan(scan);
  };

  const scheduleIdleFlush = () => {
    clearIdleFlush();
    if (!idleFlushMs || !decoder.hasBufferedData()) return;
    idleFlushTimer = setTimeout(() => {
      idleFlushTimer = null;
      if (!keepReading || signal?.aborted || !decoder.hasBufferedData()) return;
      decoder.flush().forEach(emitFrame);
    }, idleFlushMs);
  };

  if (signal?.aborted) return null;
  try {
    await port.open(profile.serialOptions || { baudRate: 9600 });
  } catch (error) {
    if (signal?.aborted) return null;
    throw error;
  }
  if (
    !signal?.aborted &&
    profile.signals &&
    typeof port.setSignals === 'function'
  ) {
    try {
      await port.setSignals(profile.signals);
    } catch (error) {
      // Chromium reports an unsupported control-signal write as NetworkError.
      // An open read stream can still receive scans. Failed reads surface below.
      const optionalSignalError =
        error?.name === 'NetworkError' || error?.name === 'NotSupportedError';
      if (!signal?.aborted && !(optionalSignalError && port.readable))
        throw error;
    }
  }
  // Web Serial cannot cancel open(). Close before any reader can receive bytes.
  if (signal?.aborted) {
    await port.close();
    return null;
  }
  if (!decoder) {
    if (!port.writable)
      throw new Error('The SSI scanner port is not writable.');
    ssi = createSsiTransport(port.writable.getWriter(), emitFrame);
  }
  onStatus({ state: 'open', profile, portInfo: port.getInfo() });

  const readLoop = (async () => {
    while (keepReading && !signal?.aborted && port.readable) {
      activeReader = port.readable.getReader();
      try {
        while (keepReading) {
          const { value, done } = await activeReader.read();
          if (done || !keepReading || signal?.aborted) break;
          if (ssi) ssi.push(value);
          else {
            decoder.push(value).forEach(emitFrame);
            scheduleIdleFlush();
          }
        }
      } catch (error) {
        if (keepReading) {
          terminalReadError = error;
          keepReading = false;
        }
      } finally {
        activeReader.releaseLock();
        activeReader = null;
      }
    }
    clearIdleFlush();
    ssi?.close();
    if (terminalReadError) {
      if (port.readable || port.writable) {
        await port.close().catch(() => undefined);
      }
      onError(terminalReadError);
    } else if (keepReading) {
      onStatus({ state: 'disconnected', profile, portInfo: port.getInfo() });
    }
  })();

  return {
    profile,
    port,
    get readable() {
      return keepReading;
    },
    playFeedback: ssi?.playFeedback,
    async close() {
      keepReading = false;
      clearIdleFlush();
      decoder?.reset();
      ssi?.close();
      if (activeReader) {
        await activeReader.cancel().catch(() => undefined);
      }
      await readLoop.catch(() => undefined);
      if (port.readable || port.writable) {
        await port.close();
      }
      onStatus({ state: 'closed', profile });
    }
  };
}
