# Historical issue: paste interception in Panorama

An earlier scanner implementation listened for paste and keyboard input on clinical pages. Its loose barcode check could mistake ordinary text containing `01` for a scan and prevent a clinician's paste. A subsequent fix tightened that check.

That interception path has since been removed. VaxLink now receives hardware scans through Web Serial and does not capture page-level keyboard or paste input. Do not restore the old interception logic or the historical fix described above.

For the current scanner design and setup, see [Architecture](../architecture.md) and [Diagnostics](../diagnostics.md).
