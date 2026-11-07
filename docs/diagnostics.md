# Diagnose a scanning problem

Start with **Data Tools → Check workstation health** in the popup. This reads
scanner status, the existing catalogue status, and a small reply from the selected
chart tab. It does not reconnect a scanner, refresh the catalogue, reinject a
script, reload a chart, or write to a chart. Waking the background worker can
still run its normal startup work.

A cached scanner reply is labelled with its observation age when known. A
connected port does not prove that bytes or a valid barcode reached VaxLink.
The capture count reports frames received since the scanner worker started.

The page reply identifies the content script loaded in the tab and whether its
workflow settings have loaded. A matching build alone does not mean it is ready. A missing reply
means the integration could not be confirmed. A stale reply means its loaded
build differs from the installed package. Reload the chart when safe; VaxLink
does not repair it automatically. Unpacked source has no immutable package
fingerprint, so edits made without a new version cannot be compared reliably.

Packaged builds receive a fingerprint of their staged runtime files. The content
script captures that identity and its version at load, rather than asking the
current background worker which build it is running. Health replies contain
coarse page categories and readiness flags, without chart URLs or field values.

Catalogue readiness and freshness are separate. A usable cached catalogue can
still have degraded freshness after a failed refresh. Use the existing catalogue
controls when a deliberate refresh is needed.

## Test the scanner without sending a clinical scan

In Alpha Scanner Setup, connect the intended scanner, then select **Start scanner
test**. Wait for the active countdown before scanning a synthetic barcode. Test
input does not enter a chart, a queue, inventory, or clinical usage counters.
The test uses the existing serial reader; it does not open another connection.
Production packages do not include this test interface.

Read the checkpoints separately: connected port, bytes received, decoded frame,
and GS1 fields parsed. A frame can end at a terminator, an idle flush, or an
overflow. An idle frame does not establish that the barcode was complete. This
initial scanner test does not perform a catalogue lookup; that checkpoint says
unavailable. Workstation health reports catalogue readiness separately.

For the optional keyboard-output check, focus the test field and scan a synthetic
barcode. Text in that field without serial bytes suggests scanner configuration;
it does not prove a hardware fault. Input in the field is cleared immediately.
There are no keyboard or paste listeners on clinical pages for this check.

Select **Stop test** and wait for the reader to be released before clinical use.
The test ends after one minute. Pending reads, buffered bytes, and partial frames
are discarded at each ownership boundary. Late test messages remain test input
and cannot become clinical scans. A failure during that transition leaves capture
paused and requires an explicit reconnect. No bytes means **No data during the
requested interval**; VaxLink cannot observe a physical trigger press or beep.
