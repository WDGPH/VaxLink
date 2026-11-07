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

## Record a real workflow issue

In Alpha Data Tools, select **Open workflow recorder**. It opens in a background
tab and leaves recording off. In that tab, start recording, return to the chart,
and follow the normal workflow. Recording does not select a different chart or
pin scanner routing to the tab used for the health check. The timeline reports
the destination that the normal router actually accepted.

Open an attempt to see its last established checkpoint and outcome. Bytes,
framing, parsing, catalogue enrichment, delivery, queueing, and observed form
state are separate checkpoints. Delivery does not prove a fill. Matching fields
do not prove that staff saved the clinical record. Pending user choices,
cancellation, supersession, failure, and missing final evidence are shown
separately. Identical intentional scans receive separate random attempt IDs;
normal duplicate suppression and queue order still apply.

A queued record can link a later fill to its original recorded attempt. Those
links stay in session storage, outside the clinical queue. Missing links,
recording begun mid-frame, or context interruption produce partial history.
VaxLink does not invent earlier captures. Pending scans with an ambiguous capture
time remain unlinked instead of being attached to the wrong attempt.

Stop when the issue has been reproduced. Preview the export, review its scope,
and select **Download** only when ready to save a local JSON diagnostic file.
There is no automatic upload or import. Even filtered operational timings can be
linked to other information; review the file before sharing it.

## Retention and retained fields

Recording lasts up to 15 minutes and retains at most 1,000 events or 1 MiB,
whichever is reached first. Stopped data expires after 30 minutes. The collector
checks expiry when it wakes, reads, and writes; producers and the viewer also
check their deadlines. Browser restart, extension reload, update, or disablement
clears session storage. This is a troubleshooting recording, not a durable audit
trail.

The versioned event allowlist contains random session, operation, context, node,
form, and tab aliases; local sequence numbers; observation and receipt times;
controlled event and outcome codes; booleans, counts, and local durations.
Snapshots keep field aliases, native-control or widget state, option counts,
replacement state, and whether the intended selection matches. They omit the
actual field values, text, HTML, raw barcode, serial number, page title, full URL,
exception text, and nurse or workstation analytics labels. The export includes
the packaged code identity, not operational queues or analytics.

Dropped-event counts and capture-limit observations identify incomplete
coverage. Final outcomes can replace an older routine observation in a full
buffer, with the replacement counted as lost detail. A producer, page, or worker
can still stop before its last batch arrives. Context restarts and missing tails
remain possible, including while stopping. A missing event is not proof that an
action never happened.

## Form and timing evidence

Targeted Panorama observations cover agent, lot, funding, date/time, reason, and
consent. Native controls and visible widgets are inspected separately. A hidden
native select can still be the control VaxLink writes; visibility alone does not
make that write invalid. These snapshots are small state observations, not a
rendered-page reconstruction. Other EMRs report the workflow stages that can be
observed without claiming Panorama-specific field verification.

Retry observations report the existing timer and mutation decisions, scheduled
versus actual local delay, cancellation, and late follow-ups. Recording does not
change retry constants or fill order. PrimeFaces queue state is **unknown** when
the isolated content script cannot inspect it; unknown does not mean idle.

Resource observations cover requests that began during the opted-in session.
They contain a coarse resource class and available timing or size fields, with
no resource URL, query, path, headers, body, or HTTP-status claim. Nearby entries
are filtered by the attempt's content context and time window. Correlation does
not establish cause. Time to first byte includes more than server processing,
and missing or zeroed fields do not prove instantaneous work or no request.
Resource Timing is not a full HAR.

Optional Long Task and Long Animation Frame observations are feature-detected.
Unsupported observations are labelled unavailable, and limits are reported.
Long Animation Frame script attribution does not cover extension isolated-world
code or workers; VaxLink does not collect script attribution. Bounded User Timing
marks use the same event instrumentation. No document-wide diagnostic observer,
main-world bridge, fetch/XHR patch, highlighting, or extra browser permission is
installed for recording.

Diagnostic messages and observers have a cost and can affect worker lifetime.
Compare recording off and on, including with the viewer closed and DevTools
closed. The diagnostic recorder does not send heartbeat traffic to keep a worker
alive.

## A controlled workstation comparison

Use the same synthetic barcode on a working and failing workstation, then
cross-swap scanners where practical. Compare capture and parsing separately from
catalogue readiness and form completion. Repeat with recording off and on, after
idle/reconnect, and with only the intended VaxLink installation using the port.
Do not clear real queues or trigger live clinical actions to investigate a
failure. A training hostname alone does not prove that its records are synthetic.

Local code, package, and synthetic browser checks do not establish physical
scanner behavior, institutional access, live Panorama behavior, or Store
publication. Keep those acceptance checks separate.
