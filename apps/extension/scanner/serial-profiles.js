import {
  LIVE_SSI_PROFILE_ID,
  LONG_RANGE_PROFILE_ID
} from './scanner-daemon-shared.js';

export const SCANNER_PROFILE_STORAGE_KEY = 'vaxlink_serial_scanner_profile_v1';

export const ZEBRA_USB_VENDOR_ID = 0x05e0;

const cdcProfiles = [
  {
    id: 'zebra-ds8178-usb-cdc',
    label: 'Zebra DS8178 / USB CDC',
    vendor: 'Zebra',
    model: 'DS8178',
    channel: 'web-serial',
    filters: [{ usbVendorId: ZEBRA_USB_VENDOR_ID }],
    serialOptions: {
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none'
    },
    signals: {
      dataTerminalReady: true,
      requestToSend: true
    },
    decoder: {
      encoding: 'ascii',
      delimiters: ['\r\n', '\n', '\r'],
      idleFlushMs: 150,
      maxFrameLength: 512
    }
  },
  {
    id: 'generic-usb-cdc',
    label: 'Generic USB CDC scanner',
    vendor: 'Generic',
    model: 'USB CDC scanner',
    channel: 'web-serial',
    filters: [],
    serialOptions: {
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none'
    },
    signals: {
      dataTerminalReady: true,
      requestToSend: true
    },
    decoder: {
      encoding: 'ascii',
      delimiters: ['\r\n', '\n', '\r'],
      idleFlushMs: 150,
      maxFrameLength: 512
    }
  }
];
const [zebraCdc] = cdcProfiles;

export const SERIAL_SCANNER_PROFILES = Object.freeze([
  ...cdcProfiles,
  {
    ...zebraCdc,
    id: LIVE_SSI_PROFILE_ID,
    label: 'Zebra DS8178 / Live feedback',
    protocol: 'ssi',
    decoder: null
  },
  {
    ...zebraCdc,
    id: LONG_RANGE_PROFILE_ID,
    label: 'Zebra DS8178 / Long range',
    decoder: {
      delimiters: ['\r\n'],
      requireTerminator: true,
      maxFrameLength: 8192
    }
  }
]);

export function getSerialScannerProfile(profileId) {
  return (
    SERIAL_SCANNER_PROFILES.find((profile) => profile.id === profileId) ||
    SERIAL_SCANNER_PROFILES[0]
  );
}

export function portMatchesProfile(port, profile) {
  if (!port || !profile) return false;
  const info = typeof port.getInfo === 'function' ? port.getInfo() : {};
  const filters = Array.isArray(profile.filters) ? profile.filters : [];
  if (filters.length === 0) return true;
  return filters.some((filter) => {
    if (filter.usbVendorId && info.usbVendorId !== filter.usbVendorId)
      return false;
    if (filter.usbProductId && info.usbProductId !== filter.usbProductId)
      return false;
    return true;
  });
}

export function formatUsbId(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) return '';
  return value.toString(16).toUpperCase().padStart(4, '0');
}
