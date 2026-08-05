import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCANNER_STATUS_STATES,
  buildDefaultScannerStatus,
  buildScannerStatusDescriptor,
  classifyScannerConnectionFailure,
  getScannerReconnectDelayMs,
  selectGrantedPort
} from '../extension/scanner/scanner-daemon-shared.js';
import { getSerialScannerProfile, portMatchesProfile } from '../extension/scanner/serial-profiles.js';

function makePort(info) {
  return {
    getInfo() {
      return info;
    }
  };
}

test('default scanner status reflects setup state from stored config', () => {
  assert.equal(buildDefaultScannerStatus({}).state, SCANNER_STATUS_STATES.NEVER_CONFIGURED);
  assert.equal(
    buildDefaultScannerStatus({ enabled: false, profileId: 'zebra-ds8178-usb-cdc' }).state,
    SCANNER_STATUS_STATES.DISABLED
  );
  assert.equal(
    buildDefaultScannerStatus({ enabled: true, profileId: 'zebra-ds8178-usb-cdc' }).state,
    SCANNER_STATUS_STATES.WAITING_FOR_DEVICE
  );
});

test('granted port selection prefers the exact previously used port before profile fallback', () => {
  const profile = getSerialScannerProfile('zebra-ds8178-usb-cdc');
  const preferred = makePort({ usbVendorId: 0x05e0, usbProductId: 0x0200 });
  const profileMatch = makePort({ usbVendorId: 0x05e0, usbProductId: 0x0300 });
  const generic = makePort({ usbVendorId: 0x1234, usbProductId: 0xabcd });

  const exact = selectGrantedPort(
    [generic, profileMatch, preferred],
    profile,
    { usbVendorId: 0x05e0, usbProductId: 0x0200 },
    portMatchesProfile
  );
  assert.equal(exact.reason, 'preferred');
  assert.equal(exact.port, preferred);

  const fallback = selectGrantedPort(
    [generic, profileMatch],
    profile,
    { usbVendorId: 0x05e0, usbProductId: 0x0200 },
    portMatchesProfile
  );
  assert.equal(fallback.reason, 'profile');
  assert.equal(fallback.port, profileMatch);
});

test('scanner status descriptor exposes workflow banner only for unattended capture modes', () => {
  const descriptor = buildScannerStatusDescriptor(
    {
      state: SCANNER_STATUS_STATES.RECOVERING,
      profileId: 'zebra-ds8178-usb-cdc'
    },
    'multiple'
  );
  assert.equal(descriptor.label, 'Recovering');
  assert.equal(descriptor.showReconnect, true);
  assert.match(descriptor.bannerText, /retrying automatically/i);

  const singleModeDescriptor = buildScannerStatusDescriptor(
    {
      state: SCANNER_STATUS_STATES.RECOVERING,
      profileId: 'zebra-ds8178-usb-cdc'
    },
    'single'
  );
  assert.equal(singleModeDescriptor.bannerText, '');
});

test('scanner reconnect delay backs off and then caps', () => {
  assert.equal(getScannerReconnectDelayMs(0), 0);
  assert.equal(getScannerReconnectDelayMs(1), 1000);
  assert.equal(getScannerReconnectDelayMs(4), 30000);
  assert.equal(getScannerReconnectDelayMs(99), 60000);
});

test('serial failure classification distinguishes recoverable disconnects from busy ports', () => {
  const recovering = classifyScannerConnectionFailure(new DOMException('Serial device disconnected.', 'NetworkError'));
  assert.equal(recovering.state, SCANNER_STATUS_STATES.RECOVERING);
  assert.equal(recovering.recoverable, true);

  const busy = classifyScannerConnectionFailure(new Error('Failed to open serial port: Access denied'));
  assert.equal(busy.state, SCANNER_STATUS_STATES.BUSY);
  assert.equal(busy.recoverable, false);
});
