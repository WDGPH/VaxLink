# Security Policy

## Report a vulnerability

Email **innovation@wdgpublichealth.ca** with the affected version, impact, and steps to reproduce if available. Please report suspected vulnerabilities privately; do not open a public GitHub issue for an undisclosed vulnerability. We aim to acknowledge vulnerability reports promptly, generally within two business days. We assess their impact and arrange a fix through the tested, versioned release process. We use the same process for third-party dependency findings and contact affected pilot partners when they need to act. This is an acknowledgement target, not a fix deadline.

## Extension data and network access

VaxLink downloads the public vaccine catalogue over HTTPS and looks up scanned products in the browser. It reads and changes fields on supported Panorama immunization pages within the staff member’s signed-in session. Staff review and save the clinical record in Panorama.

The browser profile stores trays, held scans, device settings and activity counts. Session storage holds recent chart lots and optional Debug details. VaxLink adds no encryption to these stores. Workstation and profile controls protect them. Files, clipboard copies and email drafts have separate access and retention controls. Older installations may also have inventory data left from earlier versions.
