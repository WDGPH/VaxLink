---
name: vaxlink-extension-debugging
description: Debug VaxLink extension behavior across popup, content script, background service worker, parsing, storage, and analytics. Use when scans do not autofill, messages fail between popup and content script, workflow settings are ignored, inventory parsing is wrong, or extension logs need tracing in `apps/extension/*.js`.
---

# VaxLink Extension Debugging

## Focus

Use this skill when the bug is in the extension plumbing rather than Panorama itself.
Trace the path from scan input to parsed payload to background queue to content-script autofill.

## Debug Order

- Confirm the input parsed correctly.
- Confirm the popup built the expected payload.
- Confirm the background worker stored or forwarded the message.
- Confirm the content script received the message and chose the right workflow.
- Confirm the page selectors are actually visible and enabled.

## High Value Files

- `apps/extension/popup.js`
- `apps/extension/popup-inventory.js`
- `apps/extension/popup-parser.js`
- `apps/extension/background.js`
- `apps/extension/content.js`

## What To Check First

- Does the parsed barcode contain `lot`, `expiry`, `gtin`, and `serial` as expected?
- Did the popup include `administered_at` only when the setting is enabled?
- Is `workflow_mode` correct for single, multiple, or inventory flows?
- Did background storage keep the last-known-good bundle and analytics state?
- Is the content script on the right host and page type before autofill starts?
- Are there runtime errors from `chrome.runtime.lastError` or missing permissions?
