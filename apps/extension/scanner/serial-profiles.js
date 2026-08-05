export const SCANNER_PROFILE_STORAGE_KEY = 'vaxlink_serial_scanner_profile_v1';
export const SCANNER_PORT_INFO_STORAGE_KEY = 'vaxlink_serial_scanner_port_info_v1';

export const ZEBRA_USB_VENDOR_ID = 0x05e0;

export const SERIAL_SCANNER_PROFILES = Object.freeze([
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
    },
    setupNote: 'Use the DS8178 cradle in USB CDC / virtual COM mode, not HID keyboard emulation.'
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
    },
    setupNote: 'Use when the scanner exposes a browser-visible virtual COM port.'
  }
]);

export function getSerialScannerProfile(profileId) {
  return SERIAL_SCANNER_PROFILES.find((profile) => profile.id === profileId) || SERIAL_SCANNER_PROFILES[0];
}

export function portMatchesProfile(port, profile) {
  if (!port || !profile) return false;
  const info = typeof port.getInfo === 'function' ? port.getInfo() : {};
  const filters = Array.isArray(profile.filters) ? profile.filters : [];
  if (filters.length === 0) return true;
  return filters.some((filter) => {
    if (filter.usbVendorId && info.usbVendorId !== filter.usbVendorId) return false;
    if (filter.usbProductId && info.usbProductId !== filter.usbProductId) return false;
    return true;
  });
}

export function formatUsbId(value) {
  if (value === undefined || value === null) return 'unknown';
  return `0x${Number(value).toString(16).padStart(4, '0')}`;
}
