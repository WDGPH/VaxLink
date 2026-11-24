import {
  SCANNER_DAEMON_ACTIONS,
  normalizeScannerPortInfo,
  selectGrantedPort
} from './scanner/scanner-daemon-shared.js';
import {
  ZEBRA_USB_VENDOR_ID,
  getSerialScannerProfile,
  portMatchesProfile
} from './scanner/serial-profiles.js';
import {
  getGrantedSerialScannerPorts,
  isWebSerialSupported,
  requestSerialScannerPort
} from './scanner/serial-provider.js';

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
    const port = await requestSerialScannerPort();
    const info = normalizeScannerPortInfo(port.getInfo());
    const profile = getSerialScannerProfile(
      info?.usbVendorId === ZEBRA_USB_VENDOR_ID
        ? 'zebra-ds8178-usb-cdc'
        : 'generic-usb-cdc'
    );
    if (!info) throw new Error('The selected scanner could not be identified.');
    const selection = selectGrantedPort(
      await getGrantedSerialScannerPorts(),
      profile,
      info,
      portMatchesProfile
    );
    if (!selection.port) {
      throw new Error(
        selection.reason === 'ambiguous'
          ? 'More than one scanner matches. Unplug the extra scanner, then choose again.'
          : 'The selected scanner is no longer available.'
      );
    }
    showStatus('Connecting scanner…');
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          action: SCANNER_DAEMON_ACTIONS.SELECT,
          profileId: profile.id,
          preferredPortInfo: info
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
        ? 'No scanner selected. Choose Connect scanner to try again.'
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
