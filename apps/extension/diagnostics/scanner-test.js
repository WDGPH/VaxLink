import '../shared/gs1-parser.js';
import { selectGrantedPort } from '../scanner/scanner-daemon-shared.js';
import {
  getSerialScannerProfile,
  portMatchesProfile,
  SCANNER_PORT_INFO_STORAGE_KEY,
  SCANNER_PROFILE_STORAGE_KEY
} from '../scanner/serial-profiles.js';
import {
  getGrantedSerialScannerPorts,
  openSerialScanner
} from '../scanner/serial-provider.js';

const SESSION_MS = 60000;
const OPERATION_MS = 5000;
const SYNTHETIC_GTIN = '09999000000008';
const SYNTHETIC_LOT = 'VAXLINKTEST';

function bounded(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Operation timed out')),
        OPERATION_MS
      );
    })
  ]).finally(() => clearTimeout(timer));
}

// All scan data stays in this page; only these checkpoint flags reach the UI.
export function createScannerTest({
  acquire,
  release,
  getSelection,
  getPorts,
  open,
  parse,
  update,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now
}) {
  let session = null;
  let sequence = 0;
  let ownershipUnresolved = false;
  const publish = (current) =>
    update({ ...current.checkpoints, state: current.state });

  async function stop(current = session) {
    if (!current || current.stopping) return;
    current.stopping = true;
    current.active = false;
    clearTimer(current.timer);
    current.state = 'stopping';
    publish(current);
    try {
      const connection = await bounded(Promise.resolve(current.opening));
      if (connection) await bounded(connection.close());
      if (current.lease) {
        const result = await bounded(release(current.lease));
        if (!result?.success)
          throw new Error('Lease release was not confirmed');
      }
      current.state = 'stopped';
    } catch {
      ownershipUnresolved = true;
      if (current.opening) {
        current.opening
          .then((connection) => connection?.close())
          .catch(() => {});
      }
      current.state = 'paused';
    }
    if (session === current) session = null;
    publish(current);
  }

  async function start() {
    if (session || ownershipUnresolved) return;
    const current = {
      id: ++sequence,
      deadline: now() + SESSION_MS,
      active: true,
      stopping: false,
      opening: null,
      state: 'starting',
      checkpoints: { port: false, bytes: false, frame: false, parsed: false }
    };
    session = current;
    current.timer = setTimer(() => void stop(current), SESSION_MS);
    publish(current);
    try {
      const acquiring = Promise.resolve().then(acquire);
      acquiring
        .then((result) => {
          if (!current.active && result?.lease) {
            ownershipUnresolved = true;
            current.state = 'paused';
            publish(current);
          }
        })
        .catch(() => {});
      const acknowledgement = await bounded(acquiring);
      if (!current.active) {
        ownershipUnresolved = true;
        current.state = 'paused';
        publish(current);
        return;
      }
      if (now() >= current.deadline) {
        current.lease = acknowledgement?.lease;
        await stop(current);
        return;
      }
      if (
        !acknowledgement?.success ||
        acknowledgement.released !== true ||
        !acknowledgement.lease
      )
        throw new Error('Scanner release was not confirmed');
      current.lease = acknowledgement.lease;
      const { profile, preferredPortInfo } = await getSelection();
      if (!current.active) return;
      if (!profile) throw new Error('Scanner is not configured');
      const ports = await getPorts();
      if (!current.active) return;
      const selection = selectGrantedPort(
        ports,
        profile,
        preferredPortInfo,
        portMatchesProfile
      );
      if (!selection.port)
        throw new Error('Selected scanner is unavailable or ambiguous');
      if (now() >= current.deadline) {
        await stop(current);
        return;
      }
      current.opening = Promise.resolve().then(() =>
        open(selection.port, profile, {
          onBytes: (count) => {
            if (!current.active) return;
            if (now() >= current.deadline) {
              void stop(current);
              return;
            }
            if (!(count > 0)) return;
            current.checkpoints.bytes = true;
            publish(current);
          },
          onScan: (scan) => {
            if (!current.active) return;
            if (now() >= current.deadline) {
              void stop(current);
              return;
            }
            current.checkpoints.frame = true;
            try {
              const parsed = parse(scan.rawText);
              current.checkpoints.parsed ||= Boolean(
                parsed?.gtin === SYNTHETIC_GTIN && parsed?.lot === SYNTHETIC_LOT
              );
            } catch {
              /* Invalid input is reported as an incomplete checkpoint. */
            }
            publish(current);
          },
          onError: () => void stop(current),
          onStatus: (status) => {
            if (status.state === 'disconnected') void stop(current);
          }
        })
      );
      const connection = await bounded(current.opening);
      if (!current.active) return;
      if (now() >= current.deadline) {
        await stop(current);
        return;
      }
      current.checkpoints.port = true;
      current.state = 'active';
      publish(current);
    } catch {
      if (!current.active) return;
      if (!current.lease) ownershipUnresolved = true;
      await stop(current);
      current.state = 'paused';
      publish(current);
    }
  }
  return { start, stop };
}

if (typeof document !== 'undefined') {
  const output = document.getElementById('status');
  const checks = ['port', 'bytes', 'frame', 'parsed'];
  const controller = createScannerTest({
    acquire: () =>
      chrome.runtime.sendMessage({ action: 'scannerTest.acquire' }),
    release: (lease) =>
      chrome.runtime.sendMessage({ action: 'scannerTest.release', lease }),
    getSelection: async () => {
      const stored = await chrome.storage.local.get([
        SCANNER_PROFILE_STORAGE_KEY,
        SCANNER_PORT_INFO_STORAGE_KEY
      ]);
      const id = stored[SCANNER_PROFILE_STORAGE_KEY];
      return {
        profile: id ? getSerialScannerProfile(id) : null,
        preferredPortInfo: stored[SCANNER_PORT_INFO_STORAGE_KEY]
      };
    },
    getPorts: getGrantedSerialScannerPorts,
    open: openSerialScanner,
    parse: globalThis.VaxLinkGS1Parser.parseGS1Barcode,
    update: (result) => {
      const messages = {
        starting: 'Pausing normal scanner capture and opening the scanner…',
        active: 'Test is active. Scan the synthetic test barcode.',
        stopping: 'Stopping the test…',
        stopped:
          'Test stopped. Reconnect the scanner in Scanner Setup to resume normal capture.',
        paused:
          'The scanner could not be safely released or opened. Close this page and reconnect in Scanner Setup.'
      };
      output.textContent = messages[result.state];
      document.getElementById('barcode').hidden = result.state !== 'active';
      for (const key of checks)
        document.getElementById(key).textContent = result[key]
          ? 'Observed'
          : 'Not observed';
      document.getElementById('start').disabled = [
        'paused',
        'starting',
        'active',
        'stopping'
      ].includes(result.state);
      document.getElementById('stop').disabled = ![
        'starting',
        'active'
      ].includes(result.state);
    }
  });
  document
    .getElementById('start')
    .addEventListener('click', () => void controller.start());
  document
    .getElementById('stop')
    .addEventListener('click', () => void controller.stop());
  window.addEventListener('pagehide', () => void controller.stop());
}
