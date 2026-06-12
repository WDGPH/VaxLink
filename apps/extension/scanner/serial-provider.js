import { makeScanEvent } from './scanner-events.js';
import { createLineFrameDecoder } from './serial-decoder.js';
import { getSerialScannerProfile } from './serial-profiles.js';

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
  const onStatus = typeof handlers.onStatus === 'function' ? handlers.onStatus : () => {};
  const onError = typeof handlers.onError === 'function' ? handlers.onError : () => {};
  const decoder = createLineFrameDecoder(profile.decoder || {});
  const idleFlushMs = Number(profile.decoder?.idleFlushMs || 0);
  let keepReading = true;
  let activeReader = null;
  let idleFlushTimer = null;

  const clearIdleFlush = () => {
    if (idleFlushTimer) {
      clearTimeout(idleFlushTimer);
      idleFlushTimer = null;
    }
  };

  const emitFrames = (frames) => {
    for (const frame of frames) {
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
      if (typeof onScan === 'function') {
        onScan(scan);
      }
    }
  };

  const scheduleIdleFlush = () => {
    clearIdleFlush();
    if (!idleFlushMs || !decoder.hasBufferedData()) return;
    idleFlushTimer = setTimeout(() => {
      idleFlushTimer = null;
      if (!keepReading || !decoder.hasBufferedData()) return;
      emitFrames(decoder.flush());
    }, idleFlushMs);
  };

  await port.open(profile.serialOptions || { baudRate: 9600 });
  if (profile.signals && typeof port.setSignals === 'function') {
    await port.setSignals(profile.signals).catch((error) => onError(error));
  }
  onStatus({ state: 'open', profile, portInfo: port.getInfo() });

  const readLoop = (async () => {
    while (keepReading && port.readable) {
      activeReader = port.readable.getReader();
      try {
        while (keepReading) {
          const { value, done } = await activeReader.read();
          if (done) break;
          const frames = decoder.push(value);
          emitFrames(frames);
          scheduleIdleFlush();
        }
      } catch (error) {
        if (keepReading) {
          onError(error);
        }
      } finally {
        activeReader.releaseLock();
        activeReader = null;
      }
    }
  })();

  return {
    profile,
    port,
    get readable() {
      return keepReading;
    },
    async close() {
      keepReading = false;
      clearIdleFlush();
      decoder.reset();
      if (activeReader) {
        await activeReader.cancel().catch(() => undefined);
      }
      await readLoop.catch(() => undefined);
      if (port.readable || port.writable) {
        await port.close().catch(() => undefined);
      }
      onStatus({ state: 'closed', profile });
    }
  };
}
