# Extension Debug Flow

1. `scanner-daemon.js` forwards physical captures to `background.js`.
   Manual barcode entry starts in `popup.js` and `popup-parser.js`.
2. The background saves Inventory scans and checks the active Panorama
   form for Immunization scans. Compare the selected workflow, the reported
   form and readiness, the automatic entry setting, and the route reason.
3. A ready single form gets one delivery attempt after the barcode is saved
   to the held-scan inbox. The reply can be pending while the chart works.
   Only verification from the matching chart can release a pending attempt.
   If the result is uncertain, check the original chart and the held scan.
4. The Multiple grid can receive the new saved row. The assignment keeps its
   tray dose for the detail step. Follow an explicit tray choice by row ID
   and form token. The worker writes tray changes and `popup-inventory.js`
   shows the saved state.
5. In `content.js`, check the current Agent and Lot or Trade before tracing
   Date, Time, Reason and Consent. Follow the same fill when funding changes
   and the Lot list refreshes. Verify the reservation once when the chart
   settles. A later repair can fill an eligible blank field on the same
   chart. Staff check and save the Panorama record.

## Debug export

Packaged Alpha starts with Debug enabled. Production and unpacked development
start with it off. A saved preference overrides the starting value. Download
the session file from Settings before turning Debug off, restarting the
browser or updating the extension. Follow one operation through the captured
route, lookup, prompt, field checks and outcome. The export identifies the
installed build and settings at download. It can contain a vaccine barcode.
Use synthetic data when sharing an example and keep original workstation
exports out of the repository.

Local Activity has separate daily totals. Compare Today or All time in the
same installation when checking counts. Clearing Debug leaves both counts
available.

## Validation

Run a syntax check and the tests for the affected path. Exercise the workflow
with a synthetic input. Use the workstation procedure when checking reader
permission, a Windows lock, sleep or the live training site.
