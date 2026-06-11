# Native Scanner Protocol

The native scanner agent speaks a small versioned protocol over Chrome/Edge native messaging. Messages are JSON objects transported with the browser native messaging frame format.

## Protocol Version

```json
{ "type": "hello", "protocolVersion": 1 }
```

Every response includes `ok: true` or `ok: false`. Error responses include `error`.

## Commands

```json
{ "type": "status.get" }
{ "type": "queue.peek", "limit": 25 }
{ "type": "queue.ack", "ids": ["..."] }
{ "type": "queue.nack", "ids": ["..."], "reason": "no-chart" }
{ "type": "scan.poll", "limit": 25 }
{ "type": "scan.subscribe" }
```

Polling is the first implementation target because MV3 background service workers are event-driven. Subscription can be added later when the extension deliberately holds a native messaging port open.

## Scan Event

Native queue records are converted into source-neutral extension scan events:

```json
{
  "type": "vaxlink.scan",
  "rawText": "01000614141999981726010110ABC123",
  "source": "native-serial",
  "device": {
    "profileId": "zebra-ds8178-usb-cdc",
    "port": "COM4",
    "vendorId": "05E0",
    "productId": ""
  },
  "rawBytesHex": "30313030...",
  "capturedAt": "2026-06-11T14:03:22.123Z",
  "nativeQueueId": "uuid"
}
```

`rawText` is required and must be non-empty after trimming. `nativeQueueId` is preserved so the extension can acknowledge the native queue record after it accepts responsibility for routing.

## Acknowledgement Semantics

There are two queue levels:

- Native queue: protects scans before the browser accepts them.
- Extension pending inbox: protects scans after the browser accepts them but before a chart accepts them.

The extension may ack a native scan after the background router accepts the scan event. If no chart is open, the background moves the scan into the extension pending inbox and still returns success to the native connector. If the background rejects the scan event as invalid, the native connector must not ack it.

`queue.nack` is for explicit negative delivery states such as malformed payloads or policy rejection. A missing chart is not a native delivery failure once the extension has persisted the scan in its own pending inbox.
