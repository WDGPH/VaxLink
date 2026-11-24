# Trying VaxLink in a clinic

Start in Inventory with the scanner and packages your clinic expects to use. Then practise chart entry with synthetic records in Panorama training. This lets staff tell whether a problem starts at the label, in the catalogue or in the chart.

## Choose the product barcode

Look beside the printed lot and expiry for the product barcode, often a small square GS1 DataMatrix. Another square code on the package may open a website. Scan only product labels. Check the product, formulation, lot and expiry shown in Inventory against the unit you will use.

If the unit label is hard to scan and your clinic allows a carton scan, keep the carton with its contents and compare the printed details on both. Enter the quantity separately. Scanning one carton cannot tell you how many doses remain.

Include different strengths, package sizes and biological products in local trials. For example, VaxLink recognizes nirsevimab as the Panorama agent RSVAb. Each presentation still needs a readable barcode, a catalogue match and an available Panorama lot.

## Find where a scan stopped

| What staff see                                            | What to check next                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scanner beeps, but no entry appears                       | Check the selected tray, Held scanner scans and the connection in Settings. If delivery was uncertain, check the original chart before trying again. [Staff scanner guide](scanner-quick-guide.md)                                                                                             |
| Barcode is captured, but the lot or product is incomplete | Compare the label with the decoded fields. Check the catalogue status and last successful check in Settings. An unavailable catalogue cannot confirm a missing lot.                                                                                                                            |
| A working catalogue reports the lot missing               | Check the printed lot and product. If correct, review the catalogue email draft and its recipients before sending.                                                                                                                                                                             |
| The catalogue finds the lot, but Panorama does not        | Check Agent, formulation and funding. Training can have a limited lot list. For a production miss, contact the local Panorama Resolution Coordinator. In Multiple Immunizations, staff may need to delete the unfinished entry to complete the other entries. Check which entry is open first. |
| Only some chart fields filled                             | Read the message, check the original chart and complete the missing fields under local procedure. Confirm the correct client, product, lot, funding, administration details and consent before saving.                                                                                         |

When a lot appears in both funding categories, staff choose the category. A match in one category can guide the search. Staff still determine eligibility under the program’s rules.

## Before clinical use

Try a single entry, several immunizations, an interrupted scan and a missing lot. Confirm the workstation can account for scans after lock and unlock. Ask an authorized Panorama administrator to confirm relevant production lots and funding choices. Use the clinic’s approved production workflow for clinical records. [Workstation acceptance checks](fixes/browser-only-locked-scanner-poc.md)

For support, start with the software version, scanner model, training or production environment, package type, printed lot, catalogue status and exact message. Use a sample record for screenshots. Review any barcode, email recipients and Debug download before sharing through an approved private channel. [Privacy assessment guide](privacy-assessment.md)
