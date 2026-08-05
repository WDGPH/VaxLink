# Browser-only locked scanner proof of concept

## Goal

Confirm that a USB CDC scanner paired with VaxLink remains readable after the setup tab is closed and while Windows is locked. Scans captured during the lock must appear exactly once, in order, in the Multiple Inject queue after unlock.

This proof of concept is browser-only: it requires the Chrome extension but no Windows service, native messaging host, administrator install, or separate bridge application.

## Prerequisites

- Windows workstation with Chrome 114 or newer and the unpacked VaxLink extension loaded.
- Zebra DS8178/cradle configured as USB CDC (virtual COM), with HID keyboard output disabled.
- Chrome is allowed to keep running in the background.
- Windows power policy keeps the workstation awake during the test. Sleep and hibernation stop browser execution and serial capture.
- A non-production test chart is open in Panorama or InputHealth before locking.

## Test procedure

1. Open VaxLink Scanner Setup and choose the scanner profile.
2. Select **Select Scanner**, grant the serial-port permission, and wait for **Connected in background**.
3. Scan one test barcode while the setup page is visible. Verify the decoded value, confirm that **Hardware captures since daemon start** increments, and confirm that the keyboard-leakage field remains unchanged. If the field receives characters, the scanner is still acting as an HID keyboard and this test is invalid.
4. Close the Scanner Setup tab completely.
5. Scan one barcode while Windows is unlocked. Verify the normal open-chart behavior.
6. Clear or record the current Multiple Inject queue count and the Scanner Setup hardware-capture count.
7. Lock Windows with **Win+L**. Do not put the workstation to sleep.
8. Scan five known barcodes. Include the same barcode twice consecutively to prove that intentional duplicate doses are preserved.
9. Unlock Windows, open the VaxLink popup, and select Multiple Inject.
10. Verify that all five locked scans are present, in scan order, and that the repeated barcode appears twice. The summary should identify the scans captured while locked.
11. Confirm that none of the locked scans were injected into the chart before review.
12. Reopen Scanner Setup and compare its hardware-capture count. If the count increased but the queue did not, report a VaxLink routing failure. If the count did not increase, the scanner/Chrome Web Serial channel stopped at the Windows lock boundary.

## Reconnect test

1. Lock Windows again while the scanner status is connected.
2. Disconnect the scanner or cradle, wait several seconds, and reconnect it.
3. Scan another known barcode after reconnection.
4. Unlock Windows and confirm that the scan was added to Multiple Inject.

## Diagnostics and pass criteria

The proof of concept passes only if:

- Scanner Setup can be closed before locking.
- Every locked scan is retained exactly once and in order, including consecutive identical scans.
- No patient identifier or chart URL is copied into the lock-session metadata.
- Locked scans are queued and are not automatically injected into the chart.
- The extension reconnects after a temporary USB disconnect without reopening Scanner Setup.

If capture fails, inspect the extension service worker and offscreen document from `chrome://extensions` and record the scanner status/error. A message that Web Serial is unavailable in the scanner worker means the installed Chrome build does not expose Web Serial in that extension worker context; that workstation cannot use this browser-only design and would need a native bridge fallback.
