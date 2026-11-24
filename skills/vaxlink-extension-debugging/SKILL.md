---
name: vaxlink-extension-debugging
description: Trace VaxLink scanner capture, tray storage, Panorama autofill, Local Activity and Debug. Use when scans do not arrive, the wrong form receives a scan, an Autofill setting is ignored, or a dose stays held.
---

# VaxLink Extension Debugging

1. Confirm the installed build and browser profile. Use synthetic barcodes and
   a training chart to reproduce the problem.
2. Check scanner connection and last known capture time. Follow the barcode
   through the worker route, tray save or held scan, and the chart's reply.
3. For a chart fill, look at the observed form, eligibility, funding choice,
   Agent and Lot or Trade readback, and the enabled detail fields. Check that
   the same document and owner still hold the fill after each wait.
4. If a dose is in review, inspect the original chart before resolving it.
   Check the tray balance after the verification reply.

Open [Extension Debug Flow](references/extension-debug-flow.md) for file
locations and how to interpret the Debug export.
