# Native Scanner Agent

VaxLink native scanning replaces keyboard-wedge capture. The extension must not infer scans from EMR page `keydown`, `paste`, or `input` events. A scanner in serial/USB CDC mode is owned by a small per-user helper, and the extension only consumes explicit scan events delivered through Chrome/Edge native messaging.

## Architecture

```text
Scanner in serial/CDC mode
  -> VaxLink Native Scanner Agent
  -> local durable scan queue
  -> Chrome / Edge native messaging bridge
  -> VaxLink extension background
  -> active chart content script
  -> existing handleHandsFreeScan(...)
```

The agent owns the scanner connection all day. It reconnects after disconnects, timestamps every completed scan, persists the scan before delivery, and never injects keystrokes. It does not require an EMR tab to be open when the barcode is scanned.

The extension background is the browser-side router. It receives normalized scan events, routes them to an active supported chart tab when one is available, and keeps an extension pending inbox when no chart accepts the scan.

## Agent Responsibilities

- Open and monitor the configured serial scanner port.
- Reconnect with backoff after unplug, suspend, or scanner reset.
- Frame scans on CR, LF, or CRLF.
- Preserve `rawText`, `rawBytesHex`, scanner identity, and capture timestamp.
- Persist scans to a durable queue before native messaging delivery.
- Mark scans delivered only after extension acknowledgement.
- Expose status and queue drain operations over native messaging.
- Never send synthetic keyboard events.

## Queue Record

```json
{
  "id": "uuid",
  "capturedAt": "2026-06-11T14:03:22.123Z",
  "source": "native-serial",
  "rawText": "01000614141999981726010110ABC123",
  "rawBytesHex": "30313030...",
  "scanner": {
    "profileId": "zebra-ds8178-usb-cdc",
    "port": "COM4",
    "vendorId": "05E0",
    "productId": ""
  },
  "deliveryState": "pending"
}
```

SQLite is preferred for the durable queue. JSONL is acceptable for an early pilot only if appends and compaction are crash tolerant enough for workstation use.

## Scanner Configuration

The first target scanner profile is `zebra-ds8178-usb-cdc`:

- USB CDC / virtual COM mode, not keyboard HID mode.
- 9600 baud initially, configurable.
- 8 data bits, no parity, 1 stop bit.
- CR, LF, or CRLF scan delimiter.
- Full GS1 payload enabled, including AI(01), AI(17), AI(10), and AI(21) where present.

## Extension Boundary

The preserved extension workflow begins once a scan reaches `handleHandsFreeScan(rawText, source)`. Parsing, NVC lookup, analytics, workflow queueing, and autofill remain extension responsibilities.

The removed boundary is DOM capture. VaxLink must not capture scanner input from page keydown, paste, or input events. Pasting notes, dates, and identifiers into Panorama must not be intercepted by VaxLink, and Tab or Enter navigation must not be blocked by scanner detection logic.
