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
  const onStatus =
    typeof handlers.onStatus === 'function' ? handlers.onStatus : () => {};
  const onError =
    typeof handlers.onError === 'function' ? handlers.onError : () => {};
  const decoder = createLineFrameDecoder(profile.decoder || {});
  const idleFlushMs = Number(profile.decoder?.idleFlushMs || 0);
  let keepReading = true;
  let paused = false;
  let activeReader = null;
  let readTask = null;
  let idleFlushTimer = null;
  let generation = 0;
  let captureOwner = 'clinical';
  let transition = Promise.resolve();
  const onRead =
    typeof handlers.onRead === 'function' ? handlers.onRead : () => {};

  const clearIdleFlush = () => {
    if (idleFlushTimer) clearTimeout(idleFlushTimer);
    idleFlushTimer = null;
  };
  const emitFrames = (frames, owner) => {
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
      if (typeof onScan === 'function')
        onScan(scan, { owner, completionReason: frame.completionReason });
    }
  };
  const startReading = () => {
    const owner = captureOwner;
    const readGeneration = generation;
    readTask = (async () => {
      let terminalReadError = null;
      while (keepReading && readGeneration === generation && port.readable) {
        const reader = port.readable.getReader();
        activeReader = reader;
        try {
          while (keepReading && readGeneration === generation) {
            const { value, done } = await reader.read();
            if (readGeneration !== generation || !keepReading) break;
            if (done) break;
            onRead({
              owner,
              byteCount: value?.byteLength || value?.length || 0
            });
            emitFrames(decoder.push(value), owner);
            clearIdleFlush();
            if (idleFlushMs && decoder.hasBufferedData()) {
              idleFlushTimer = setTimeout(() => {
                idleFlushTimer = null;
                if (
                  keepReading &&
                  readGeneration === generation &&
                  decoder.hasBufferedData()
                ) {
                  emitFrames(decoder.flush(), owner);
                }
              }, idleFlushMs);
            }
          }
        } catch (error) {
          if (keepReading && readGeneration === generation) {
            terminalReadError = error;
            keepReading = false;
          }
        } finally {
          reader.releaseLock();
          if (activeReader === reader) activeReader = null;
        }
      }
      if (readGeneration !== generation) return;
      clearIdleFlush();
      if (terminalReadError) {
        if (port.readable || port.writable)
          await port.close().catch(() => undefined);
        onError(terminalReadError);
      } else if (keepReading) {
        onStatus({ state: 'disconnected', profile, portInfo: port.getInfo() });
      }
    })();
    return readTask;
  };
  const setCaptureOwner = (owner) => {
    const operation = transition
      .catch(() => undefined)
      .then(async () => {
        if (!keepReading || paused) throw new Error('Scanner is not connected');
        generation += 1;
        clearIdleFlush();
        const reader = activeReader;
        if (reader) await reader.cancel();
        if (readTask) await readTask;
        if (!keepReading) throw new Error('Scanner is not connected');
        decoder.reset();
        captureOwner = owner;
        startReading();
      })
      .catch((error) => {
        paused = true;
        clearIdleFlush();
        decoder.reset();
        throw error;
      });
    transition = operation;
    return operation;
  };

  await port.open(profile.serialOptions || { baudRate: 9600 });
  if (profile.signals && typeof port.setSignals === 'function') {
    await port.setSignals(profile.signals).catch((error) => onError(error));
  }
  onStatus({ state: 'open', profile, portInfo: port.getInfo() });

  startReading();

  return {
    profile,
    port,
    setCaptureOwner,
    get readable() {
      return keepReading && !paused;
    },
    async close() {
      keepReading = false;
      generation += 1;
      clearIdleFlush();
      decoder.reset();
      if (activeReader) {
        await activeReader.cancel().catch(() => undefined);
      }
      await readTask?.catch(() => undefined);
      if (port.readable || port.writable) {
        await port.close().catch(() => undefined);
      }
      onStatus({ state: 'closed', profile });
    }
  };
}
