# Extension Debug Flow

## Flow

1. Parse scan input in `popup-parser.js` or `content.js`.
2. Build the payload in `popup.js` or hands-free scan code.
3. Persist popup queue state in `popup-inventory.js` and, for the inventory page, sync normalized state through `inventory/page-controller.js` and `inventory/repository.js`.
4. Forward the autofill request through `background.js` or direct message.
5. Handle the page write in `content.js`.

## Typical failure points

- Parser accepts bad GS1 text or rejects a valid scan.
- Popup omits the field a downstream page expects.
- Background worker stores stale queue data or the inventory page misses a legacy queue sync.
- Content script receives the message but chooses the wrong workflow.
- Autofill succeeds briefly and is cleared by the page rerender.

## Minimal validation

- Run `node --check` on the changed extension file.
- Run `cd apps/extension && npm test` when inventory model or export behavior changes.
- Trace the same scan through popup, background, and content logs.
- Verify `chrome.runtime.lastError` is handled, not ignored.
