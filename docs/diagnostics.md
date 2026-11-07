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
