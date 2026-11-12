import {
  SCANNER_DAEMON_ACTIONS,
  normalizeScannerPortInfo
} from './scanner/scanner-daemon-shared.js';
import { getSerialScannerProfile } from './scanner/serial-profiles.js';
import {
  isWebSerialSupported,
  requestSerialScannerPort
} from './scanner/serial-provider.js';

const profile = getSerialScannerProfile(
  new URLSearchParams(window.location.search).get('profile')
);
const chooseButton = document.getElementById('chooseScannerBtn');
const status = document.getElementById('pairingStatus');
document.getElementById('closePairingBtn').addEventListener('click', () => {
  window.close();
});

if (!isWebSerialSupported()) {
  chooseButton.disabled = true;
  showStatus('Web Serial is not available in this browser.', true);
}

chooseButton.addEventListener('click', async () => {
  chooseButton.disabled = true;
  try {
    showStatus('Waiting for scanner selection…');
    // The browser needs a click in this window. Opening it from Pair does not
    // transfer the toolbar popup's permission to show a device chooser.
    const port = await requestSerialScannerPort(profile);
    showStatus('Scanner selected. Requesting connection…');
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          action: SCANNER_DAEMON_ACTIONS.CONNECT_GRANTED,
          profileId: profile.id,
          preferredPortInfo: normalizeScannerPortInfo(port.getInfo()),
          enableAutostart: true,
          trigger: 'pairing_permission_granted'
        },
        (response) => {
          if (chrome.runtime.lastError)
            reject(new Error(chrome.runtime.lastError.message));
          else if (!response?.success)
            reject(
              new Error(response?.error || 'Could not request connection.')
            );
          else resolve();
        }
      );
    });
    // The background reader now owns connection attempts. Its live status in
    // Settings confirms connection; this acknowledgement only accepts the request.
    window.close();
  } catch (error) {
    showStatus(
      error.name === 'NotFoundError'
        ? 'No scanner selected. Choose scanner to try again.'
        : error.message || 'Scanner pairing failed.',
      error.name !== 'NotFoundError'
    );
    chooseButton.disabled = false;
  }
});

function showStatus(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
  status.hidden = false;
}
