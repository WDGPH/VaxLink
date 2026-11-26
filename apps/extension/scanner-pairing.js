import {
  LIVE_SSI_PROFILE_ID,
  LONG_RANGE_PROFILE_ID,
  SCANNER_DAEMON_ACTIONS,
  SCANNER_STATUS_STATES,
  normalizeScannerPortInfo,
  selectGrantedPort
} from './scanner/scanner-daemon-shared.js';
import {
  SCANNER_PROFILE_STORAGE_KEY,
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
const testButton = document.getElementById('testScannerBtn');
const closeButton = document.getElementById('closePairingBtn');
const status = document.getElementById('pairingStatus');
const profileSelect = document.getElementById('scannerProfile');
const feedbackPanel = document.getElementById('testFeedbackPanel');
const feedbackStatus = document.getElementById('feedbackStatus');
const feedbackButtons = feedbackPanel.querySelectorAll('button');
let testing = false;
let finishing = false;
let statusVersion = 0;

profileSelect.addEventListener('change', showProfileInstructions);

function showProfileInstructions() {
  const live = profileSelect.value === LIVE_SSI_PROFILE_ID;
  const longRange = profileSelect.value === LONG_RANGE_PROFILE_ID;
  document.getElementById('basicSetup').hidden = live || longRange;
  document.getElementById('liveSetup').hidden = !live;
  document.getElementById('longRangeSetup').hidden = !longRange;
  document.getElementById('profileHint').textContent = live
    ? 'VaxLink sounds a result after checking the barcode and catalogue. A sound does not confirm a saved record.'
    : longRange
      ? 'The scanner beeps when it captures a barcode. VaxLink checks scans when they arrive and queues them for review.'
      : 'Use this for an existing USB CDC setup or a generic scanner. The scanner controls its own beep.';
}

closeButton.addEventListener('click', async () => {
  if (!testing) {
    window.close();
    return;
  }
  finishing = true;
  closeButton.disabled = true;
  try {
    showStatus('Ending test…');
    await sendCommand(SCANNER_DAEMON_ACTIONS.END_TEST);
    window.close();
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    finishing = false;
    closeButton.disabled = false;
  }
});

window.addEventListener('pagehide', () => {
  if (testing && !finishing) {
    void sendCommand(SCANNER_DAEMON_ACTIONS.END_TEST).catch(() => undefined);
  }
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (
    message?.action === 'scannerPairing.isOpen' &&
    sender.id === chrome.runtime.id
  ) {
    reply({ pairing: true });
    return;
  }
  if (
    testing &&
    !finishing &&
    message?.action === SCANNER_DAEMON_ACTIONS.STATUS_CHANGED
  ) {
    void readTestStatus();
  }
});

if (!isWebSerialSupported()) {
  chooseButton.disabled = true;
  showStatus('Web Serial is not available in this browser.', true);
} else {
  profileSelect.disabled = true;
  chrome.storage.local.get(SCANNER_PROFILE_STORAGE_KEY, (stored) => {
    const savedProfileId = stored?.[SCANNER_PROFILE_STORAGE_KEY];
    testButton.hidden = !savedProfileId;
    if (
      savedProfileId === LIVE_SSI_PROFILE_ID ||
      savedProfileId === LONG_RANGE_PROFILE_ID
    ) {
      profileSelect.value = savedProfileId;
      showProfileInstructions();
    }
    chooseButton.disabled = profileSelect.disabled = false;
  });
}

testButton.addEventListener('click', async () => {
  chooseButton.disabled = testButton.disabled = closeButton.disabled = true;
  profileSelect.disabled = true;
  testing = true;
  try {
    showStatus('Starting scanner test…');
    await sendCommand(SCANNER_DAEMON_ACTIONS.START_TEST);
    chooseButton.hidden = testButton.hidden = true;
    document.getElementById('profileControls').hidden = true;
    document.getElementById('setupHint').hidden = false;
    closeButton.textContent = 'Finish test';
    await readTestStatus();
  } catch (error) {
    testing = false;
    chooseButton.disabled = testButton.disabled = false;
    profileSelect.disabled = false;
    showStatus(error.message, true);
  } finally {
    closeButton.disabled = false;
  }
});

async function readTestStatus() {
  const version = ++statusVersion;
  try {
    const result = await sendCommand(SCANNER_DAEMON_ACTIONS.GET_STATUS);
    if (version !== statusVersion || !testing || finishing) return;
    feedbackPanel.hidden = true;
    if (result.source !== 'live') {
      showStatus(
        'Scanner status unavailable. Finish the test to return to regular capture.',
        true
      );
      return;
    }
    const snapshot = result.status;
    if (
      !snapshot.testing ||
      snapshot.state !== SCANNER_STATUS_STATES.CONNECTED
    ) {
      showStatus(
        snapshot.lastError || 'Waiting for the scanner…',
        Boolean(snapshot.lastError)
      );
      return;
    }
    showStatus(
      snapshot.sampleReceived
        ? 'Sample scan received.'
        : 'Scan a sample barcode. Test scans stay out of charts and trays. Finish the test before uploading stored scans.'
    );
    feedbackPanel.hidden = snapshot.profileId !== LIVE_SSI_PROFILE_ID;
  } catch (error) {
    if (version === statusVersion && !finishing) {
      feedbackPanel.hidden = true;
      showStatus(error.message, true);
    }
  }
}

for (const button of feedbackButtons) {
  button.addEventListener('click', async () => {
    if (finishing || feedbackPanel.hidden || button.disabled) return;
    for (const control of feedbackButtons) control.disabled = true;
    try {
      showStatus('Sending sound to scanner…', false, feedbackStatus);
      await sendCommand(SCANNER_DAEMON_ACTIONS.TEST_FEEDBACK, {
        result: button.dataset.feedback
      });
      showStatus('Scanner accepted the sound command.', false, feedbackStatus);
    } catch (error) {
      showStatus(error.message, true, feedbackStatus);
    } finally {
      for (const control of feedbackButtons) control.disabled = false;
    }
  });
}

chooseButton.addEventListener('click', async () => {
  chooseButton.disabled = testButton.disabled = true;
  profileSelect.disabled = true;
  try {
    showStatus('Waiting for scanner selection…');
    const selectedProfile = profileSelect.value
      ? getSerialScannerProfile(profileSelect.value)
      : null;
    // The browser needs a click in this window. Opening it from Pair does not
    // transfer the toolbar popup's permission to show a device chooser.
    const port = await requestSerialScannerPort(selectedProfile);
    const info = normalizeScannerPortInfo(port.getInfo());
    const profile =
      selectedProfile ||
      getSerialScannerProfile(
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
    await sendCommand(SCANNER_DAEMON_ACTIONS.SELECT, {
      profileId: profile.id,
      preferredPortInfo: info
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
    chooseButton.disabled = testButton.disabled = false;
    profileSelect.disabled = false;
  }
});

function sendCommand(action, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, ...payload }, (response) => {
      if (chrome.runtime.lastError)
        reject(new Error(chrome.runtime.lastError.message));
      else if (!response?.success)
        reject(new Error(response?.error || 'Scanner command failed.'));
      else resolve(response);
    });
  });
}

function showStatus(message, error = false, element = status) {
  element.textContent = message;
  element.dataset.error = String(error);
  element.hidden = false;
}
