# Security Policy

## Reporting a Vulnerability

Please do not open a public GitHub issue for security vulnerabilities. Instead, email **dna.automation@wdgpublichealth.ca** with details and, if possible, steps to reproduce. We'll acknowledge within a few business days.

## Data Handling

VaxLink (the Chrome extension) runs entirely client-side:

- Scanned barcode data is parsed locally in the browser and never sent to any server VaxLink controls.
- The only outbound network call is fetching the public NVC vaccine metadata bundle from `https://nvc-cnv.canada.ca`.
- Autofilled patient/visit data goes only into the EMR page (Panorama/InputHealth) the extension is running on, via direct DOM writes — it is never transmitted elsewhere by the extension.
- Local storage (`chrome.storage.local`) holds only scan queues, workflow settings, and the cached NVC bundle — no data leaves the device except the NVC fetch above.
