# Security Policy

## Report a vulnerability

Email **innovation@wdgpublichealth.ca** with the affected version, impact, and steps to reproduce if available. Please report suspected vulnerabilities privately; do not open a public GitHub issue for an undisclosed vulnerability. We aim to acknowledge vulnerability reports promptly, generally within two business days. We assess their impact and arrange a fix through the tested, versioned release process. We use the same process for third-party dependency findings and contact affected pilot partners when they need to act. This is an acknowledgement target, not a fix deadline.

## Extension data and network access

VaxLink is a client-side Chrome extension. It reads vaccine barcode data and writes vaccine details into the open EMR page for staff to review before saving. The EMR remains the clinical record. VaxLink does not upload patient or chart data, scans, queues, inventory, or local analytics to any server. Its default application network request fetches the public NVC vaccine catalogue over HTTPS. The browser's Chrome Web Store connection is part of extension distribution, not a VaxLink application API; a manual GitHub deployment does not need the Web Store.

VaxLink retains vaccine and product labels, GTIN, lot, serial, raw barcode, expiry, route, dose and related metadata; scan times; Multiple Inject and inventory queues and records; the NVC cache; workflow settings; scanner settings and status; and operational analytics such as parse, lookup and autofill results, workflow, product label and time. This operational data is stored in `chrome.storage.local`. The extension's queue and analytics schemas are for vaccine workflow data, not patient names, health card numbers, chart identifiers or demographics. Staff should review all autofilled vaccine details before saving in the EMR.

VaxLink adds no application-level encryption to `chrome.storage.local` or `chrome.storage.session`. Protection at rest depends on workstation, browser and operating-system controls.

## Opted-in Alpha diagnostics

Alpha can record a bounded local workflow session in `chrome.storage.session`.
The allowlist retains random correlation aliases, event codes, times, counts,
booleans, and field-match state. It excludes raw scans, serial numbers, clinical
field values, HTML, page URLs and titles, full exceptions, and nurse/workstation
analytics labels. Recording lasts up to 15 minutes, with at most 1,000 events or
1 MiB and 30-minute post-stop retention. Browser restart or extension
reload/update/disablement clears session storage. The viewer also expires its
local trace and export preview. Export requires an explicit preview and download;
there is no automatic upload.

Production packaging excludes the recorder, viewer, and rich-capture assets and
substitutes a disabled capability facade. Saved settings or forged runtime
requests cannot enable missing implementations. Alpha has the same restrictive
defaults on production records as elsewhere. Timing data can still be linkable;
these controls are not a clinical-data compliance claim.

Developer browser traces, HAR, DOM snapshots, and screenshots are a different,
opted-in capture level. Use synthetic records and a dedicated disposable profile.
Such files can contain credentials, cookies, URLs, form contents, and responses;
keep them local and ignored, and review every companion artifact before sharing.
