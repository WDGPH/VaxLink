# Security Policy

## Report a vulnerability

Email **innovation@wdgpublichealth.ca** with the affected version, impact, and steps to reproduce if available. Please report suspected vulnerabilities privately; do not open a public GitHub issue for an undisclosed vulnerability. We aim to acknowledge reports within two business days, assess their impact, and arrange a fix through the tested, versioned release process. We use the same process for third-party dependency findings and contact affected pilot partners when they need to act. This is an acknowledgement target, not a fix deadline.

## Extension data and network access

VaxLink is a client-side Chrome extension. It reads vaccine barcode data and writes vaccine details into the open EMR page for staff to review before saving. The EMR remains the clinical record. VaxLink does not upload patient or chart data, scans, queues, inventory, or local analytics to any server. Its default application network request fetches the public NVC vaccine catalogue over HTTPS. The browser's Chrome Web Store connection is part of extension distribution, not a VaxLink application API; a manual GitHub deployment does not need the Web Store.

VaxLink retains vaccine and product labels, GTIN, lot, serial, raw barcode, expiry, route, dose and related metadata; scan times; Multiple Inject and inventory queues and records; the NVC cache; workflow settings; scanner settings and status; and operational analytics such as parse, lookup and autofill results, workflow, product label and time. This data is stored in Chrome local storage and, for inventory operations, IndexedDB. The extension's queue and analytics schemas are for vaccine workflow data, not patient names, health card numbers, chart identifiers or demographics. Staff should review all autofilled vaccine details before saving in the EMR.

VaxLink adds no application-level encryption to Chrome local storage or IndexedDB. Protection at rest depends on workstation, browser and operating-system controls.
