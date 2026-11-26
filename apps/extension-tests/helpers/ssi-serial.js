export function scannerPacket(opcode, status = 0, data = []) {
  const bytes = [4 + data.length, opcode, 0, status, ...data];
  const check = 65536 - bytes.reduce((sum, byte) => sum + byte, 0);
  return Uint8Array.from([...bytes, check >> 8, check & 255]);
}

export function decodePacket(text, status, codeType = 0x1b) {
  return scannerPacket(0xf3, status, [codeType, ...Buffer.from(text, 'ascii')]);
}

export function fakeSerialPort() {
  const writes = [];
  let input;
  const port = {
    readable: null,
    writable: null,
    getInfo: () => ({ usbVendorId: 0x05e0, usbProductId: 0x1200 }),
    async open() {
      port.readable = new ReadableStream({
        start(controller) {
          input = controller;
        }
      });
      port.writable = new WritableStream({
        write(bytes) {
          writes.push([...bytes]);
        }
      });
    },
    async close() {
      if (port.readable?.locked || port.writable?.locked)
        throw new Error('Serial stream still locked');
      port.readable = null;
      port.writable = null;
    }
  };
  return { port, writes, receive: (bytes) => input.enqueue(bytes) };
}
