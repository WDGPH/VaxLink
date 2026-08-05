import assert from 'node:assert/strict';
import test from 'node:test';

import { openSerialScanner } from '../extension/scanner/serial-provider.js';

test('a terminal read error closes the COM port before reconnect is requested', async () => {
  const events = [];
  let readable = {
    getReader() {
      return {
        read: async () => { throw new DOMException('Device disconnected', 'NetworkError'); },
        releaseLock() {},
        cancel: async () => undefined
      };
    }
  };
  const port = {
    get readable() { return readable; },
    writable: null,
    getInfo: () => ({ usbVendorId: 0x05e0, usbProductId: 0x1200 }),
    open: async () => { events.push('open'); },
    close: async () => {
      events.push('close');
      readable = null;
    },
    setSignals: async () => undefined
  };

  await openSerialScanner(port, 'zebra-ds8178-usb-cdc', {
    onStatus(status) { events.push(status.state); },
    onError(error) { events.push(`error:${error.name}`); }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ['open', 'open', 'close', 'error:NetworkError']);
});
