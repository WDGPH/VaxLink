# Privacy assessment guide

Use this guide when assessing VaxLink for a clinic. It describes the 2.0 candidate workflow. Record the version and channel your clinic will install, the workflows you plan to use, and who will approve them. An inventory-only station has a different purpose from a station where staff also enter information in a client’s chart.

## What a clinic installs and uses

VaxLink is a browser extension. Staff select **Inventory** to record vaccine stock or **Immunization** to help enter a dose in an open Panorama chart. They can pair a USB serial scanner through the browser’s device chooser or enter a barcode by hand. A scanner can keep capturing after the popup closes, including while an awake workstation is locked. Staff review held immunization scans after unlocking.

Install the approved channel in the designated browser profile. **VaxLink Alpha** is the prerelease channel. **VaxLink** is the production listing. Chrome updates a Store installation through its listing. For a manually installed GitHub release, IT verifies the release ZIP against its published checksum, extracts it, loads the folder as an unpacked extension and repeats that process for each approved update. A GitHub release and a Store publication are separate events. After an update, check unsaved work before reloading Panorama tabs. Record the version shown in the popup and recheck the station’s settings.

The systems involved in routine use are the scanner, browser profile, public catalogue and Panorama. The extension uses browser storage, schedules catalogue checks, runs a scanner reader in the background and detects screen locks. It fetches the public catalogue from the fixed HTTPS address `https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC`. Windows or browser account access, device encryption and backup settings affect who can read local copies. Downloads, email and browser distribution services have their own access and retention arrangements.

## Follow one scan

![A scan and the public catalogue meet in the clinic browser. Chart entry and staff-created copies follow separate paths, as described below.](images/privacy-data-flow.svg)

| From → to                         | What moves and why                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product label → clinic browser    | The scanner sends the barcode text. Staff can also enter it by hand. VaxLink reads the product identifier (GTIN), lot, expiry and serial number when present. It can keep the original input, including a label scanned by mistake.                                                                                           |
| Public catalogue → clinic browser | VaxLink downloads the National Vaccine Catalogue over an encrypted connection to the Public Health Agency of Canada. It looks up the lot on the workstation. The agency receives an ordinary download request, including network information such as the clinic’s IP address. The request contains no scan or client details. |
| Browser → Inventory tray          | On an inventory station, product details stay in the browser profile for staff to review, count or export. An inventory scan does not enter a chart.                                                                                                                                                                          |
| Browser ↔ open Panorama chart     | In the Immunization workflow, VaxLink reads the available product and funding choices and checks the selected vaccine and lot. Depending on settings it also fills date, time, reason and consent. These values are linked to the client whose chart is open. Panorama can communicate with its own servers as fields change. |
| Reviewed chart → Panorama record  | Staff check the client, product, lot and clinical details, then save in Panorama. A tray count can decrease as soon as a fill is verified. Only the clinical record can confirm what was saved.                                                                                                                               |

VaxLink uses the staff member’s existing Panorama session. The browser allows it to read the supported immunization pages, including information visible on those pages. Choosing Inventory leaves that page access in place. Packaged Alpha and production builds can fill supported training and production charts. Test each release in training before using it in production. VaxLink’s field checks use the form and current page address to detect a change of chart or step. Its trays and activity records have no dedicated fields for client names, birth dates, health numbers or chart numbers.

A vaccine lot alone usually tells you little about a person. A rare product, scan time and workstation label together may identify a client or staff member when compared with appointments or shift records. A patient label scanned by mistake could identify someone directly.

This version requests chart access on three Ontario hosts: `www.panorama.prod.ehealthontario.ca`, `panorama.prod.ehealthontario.ca` and `trpanoramadhir.prod.ehealthontario.ca`. Each grant covers immunization-entry pages under `/phsdsm/ImmsWeb/pages/recordImms/` or `/ImmsWeb/pages/recordImms/`. Check your deployment’s address when assessing applicability.

## How much chart entry can be automated?

These eight switches are under **Settings → Autofill**. All start on in a fresh profile. Saved choices take precedence. Older profiles may inherit a combined date/time or reason/consent preference. Staff can still choose **Use** on a tray item when automatic scan entry is off.

| Switch                                                 | What the clinic is authorizing                                                                                                                                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fill an open single form from a scan                   | A scan can start filling the ready single form. Turn off for staff to choose the dose from the tray.                                                                                                            |
| Add a scan to the Multiple grid                        | A scan can fill a row when staff are entering several immunizations. Turn off for staff to start each row themselves.                                                                                           |
| Carry a grid dose into Enter Details                   | After staff open the details, VaxLink can continue with the reserved dose on its matching step. Turn off to require a separate staff choice.                                                                    |
| Choose funding automatically when one category matches | If a category has already been selected, VaxLink respects it. Otherwise it can choose the sole matching category or ask when both match. Turn off to have it ask before searching. Staff determine eligibility. |
| Set administration date to the autofill date           | Fills an empty date with the local date when entry starts. Turn off if staff should enter the actual administration date themselves.                                                                            |
| Set administration time to the autofill time           | Fills an empty time with the local time when entry starts, including for a dose saved earlier in the tray.                                                                                                      |
| Set Reason for Immunization to "Routine"               | Fills an empty reason where Routine is available. Turn off when the clinician should choose the reason for each entry.                                                                                          |
| Set Consent for Service to "Consent obtained"          | Can fill the consent field. The clinician still establishes and documents actual consent. Turn off when the clinician must make that entry personally.                                                          |

**Other controls.** The selected Immunization or Inventory workflow determines where scans go. Under **Scanner**, **Setup** lets staff connect a device or test a saved scanner. Test samples stay out of charts and trays. **Reconnect** resumes capture, **Disconnect** stops it, and **Forget** clears the saved selection. A disconnected device may still need its browser permission removed. **Acknowledge** dismisses the warning after staff account for the scan. Under **National Vaccine Catalogue**, **Recheck** checks the public catalogue. Settings shows the catalogue version and release date, plus a warning if the check fails. The **Debug mode** setting is described below.

## What stays on the workstation?

Local records are kept in the browser profile. VaxLink adds no encryption of its own to these stores. People with access to a shared profile, a copied profile or its backups may gain access to the information there.

| Record                           | What it contains                                                                                                                                                                                 | When it clears                                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Immunization and Inventory trays | Original barcode, product name and identifier, lot, expiry, optional serial, scan time, quantity and lookup result. A reserved dose also carries information tying it to a browser tab and form. | Rows stay until used, removed or cleared. There is no age-based expiry for tray records.                                                                                                                                   |
| Held scans                       | Original scanner input, capture time, device and intended destination. These help staff account for interrupted or locked-workstation scans.                                                     | Kept for delivery or staff review. At 250 scans or 1 MiB, new captures can fail to save. Unlocking does not replay uncertain chart work.                                                                                   |
| Settings and scanner status      | Selected device, preferences, last capture, lock and unlock times, and browser tab or window references used for recovery. The profile also holds a copy of the public catalogue.                | Persist between sessions. Forgetting a scanner removes its pairing information. Other records have separate controls.                                                                                                      |
| Local Activity                   | Daily workflow and product counts, manufacturer categories, a device identifier and optional workstation label. Exports also give the times of first use, last activity and export.              | Kept across sessions until reset. Counts have no automatic age cutoff.                                                                                                                                                     |
| Recent chart lots and Debug      | Up to 20 recent product, lot and expiry combinations. When Debug is on, the session also holds troubleshooting events such as funding choices, field checks and sometimes a vaccine barcode.     | Cleared on browser restart. Turning Debug off clears its session details. Closing the popup leaves the session running. Packaged Alpha starts with Debug on, production with it off, unless staff have saved a preference. |

## Activity, telemetry and troubleshooting

**Local Activity** collects daily counts in both channels. There is no staff switch to turn those counts off and no automatic upload to the project team. **Reset** clears the stored counts and starts a new device identifier. Collection continues. An earlier download keeps the old identifier and counts.

### What staff see in Local Activity

The popup compares **Today** and **All time** on this installation.

| Group             | What the numbers mean                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scanning          | **Scans** adds scanner captures and successfully parsed manual popup entries. **Expiry notices shown** counts warnings displayed.                                        |
| Charting          | **Forms filled** counts successful fill results. **Tray to chart** counts recorded uses from the Immunization tray. Neither establishes that a clinician saved a record. |
| Funding           | Counts prompts shown, choices made and searches with no match. The percentages for one or both categories use only searches that found a matching category.              |
| Trays and exports | Counts additions to the Immunization tray and Inventory exports. An export can contain several rows.                                                                     |

### What the activity export includes

The downloaded JSON file contains all retained days, the number of days with activity and combined totals. Its date range is independent of which column staff were reading. A generated device ID, any saved workstation label and first-use, last-event and export times can connect several exports to one station.

| Daily output            | Details in the file                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Use and input           | Number of recorded events, popup openings, workflow selections and counts by source of activity. The single, multiple and inventory groups include scanner captures, popup entries, tray saves and uses, and successful or failed fills. |
| Barcode and catalogue   | Successful and failed barcode reads, missing lots, successful and failed lookups, and results of automatic and manual catalogue refreshes.                                                                                               |
| Chart entry and funding | Fill attempts, successes, failures and successful fills from a tray. Funding prompts, choices, and counts of comparisons with one, both or neither category matching.                                                                    |
| Tray and Inventory use  | Immunization tray additions, uses and clears, Inventory additions and clears, largest recorded size of each tray, number of Inventory exports and rows exported.                                                                         |
| Product and expiry      | Counts by vaccine label and manufacturer, each limited to 12 labels per day. Counts for expired, expiring soon, valid or unknown expiry and notices shown.                                                                               |

Counts describe recorded operations. One scan can contribute to several counts. A small count for an unusual product may be recognizable even without a client name. Review the daily detail and workstation identifiers before sharing this file.

### What Debug adds

**Collect troubleshooting details** records individual steps for the current browser session. It starts on in packaged Alpha and off in production and development. A saved choice overrides the channel default. Records include operation numbers and elapsed times, scan routing and readiness, accepted barcode text, catalogue result and version, funding searches and choices, grid rows and detail steps, and the outcomes of field checks, retries and stops. Field checks report states such as missing or matched. Barcode text may contain a lot and serial number.

**Download** saves a JSON file with those events, the number retained and overwritten, the extension name, versions and build fingerprint, and the workflow and autofill choices at download time. Up to 3,000 events and 1 MiB are kept in the session, with older events discarded as space is needed. Turning Debug off clears that session’s details. Ordinary browser console warnings can still contain error or field details, including a date value after a conversion error. Review console captures as well as downloaded files before sharing.

### Choosing settings for pilot and production

In a training pilot, use synthetic charts and sample products. If the team needs to explain a failed fill, Debug can show the sequence. Agree who may inspect it, when to download it and when to clear it. A pilot that uses real client records needs the same decisions about identifiable data as other clinical use.

For routine production use, a clinic can leave Debug off and enable it for an approved support case. A clinic that wants staff to initiate each fill can disable the three automatic entry switches. A clinic documenting historical doses can disable date and time defaults. Review reason and consent separately with the clinical lead. Record which choices apply on each profile and who checks them after updates.

## When can a copy leave the profile?

VaxLink has no central scan or activity reporting service. The following staff actions create additional copies. Clearing the tray or resetting Activity leaves those copies under the control of their destination.

- **Download or copy.** An Inventory spreadsheet (CSV) includes the row number, scan time and raw barcode. It can include product, trade and generic names, disease, antigen, manufacturer, GTIN, lot, serial, drug identifiers, route, strength, dose and unit, total and remaining doses, lookup error, barcode/inventory/catalogue expiry dates, expiry source, status and days remaining. Local Activity and Debug have separate downloadable files. The Debug download includes the build and settings. Copying a held scan puts its barcode on the workstation clipboard.
- **Prepare a support email.** Debug mode can download the current log and open a message to `innovation@wdgpublichealth.ca`. A carry problem can open the same controls in another tab. Review the JSON file before attaching it and sending the message.
- **Report a lot missing from the catalogue.** VaxLink opens an email draft to `NVC-CNV@phac-aspc.gc.ca`. It includes available product, GTIN, lot, expiry and catalogue version.
- **Report a lot missing from production Panorama.** When the catalogue recognizes the lot, staff can open a draft and choose their local Panorama Resolution Coordinator as recipient. The draft can also include manufacturer, drug identification number and funding search details. Training shows an explanation for this situation.
- **Review a draft.** Both drafts copy `innovation@wdgpublichealth.ca` by default. Staff can change recipients and decide whether to send. The mail service may already have saved the draft. A signature, attachment or chart screenshot can disclose more than the product details supplied by VaxLink.

## Decisions to record in your local PIA

| Decision                 | What to document                                                                                                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose and authority    | Which programs will use Inventory, chart entry, Activity or Debug? Who is accountable? Identify applicable law, professional recordkeeping standards, permitted uses, and any notice or consent obligations.                                                                      |
| Access and safeguards    | Name the roles allowed to open charts, view trays, download files and receive support material. Check actual account access, disk encryption, screen locking, profile backups and download locations on the proposed stations. Include who can use a shared station after unlock. |
| Clinical accuracy        | Agree which defaults staff may use and how they check them. Autofill uses the time filling starts. Staff must verify the actual administration time and that consent was obtained, especially for historical entries. Record how staff correct a saved chart.                     |
| Disclosure and retention | Decide whether each export and default email recipient is appropriate. Set a retention period and disposal owner for trays, held scans, counts, downloads, backups and mail. Include older browser profiles when replacing a workstation.                                         |
| Requests and incidents   | Identify who handles access or correction requests, a lost device, a patient label scanned by mistake, or a file sent to the wrong recipient. Record how staff report the event and account for copies.                                                                           |
| Approval and review      | Keep the assessed version, workstation check results, remaining risks, responsible owners and approval in your local assessment. Revisit it when chart access, stored fields, recipients or clinic use changes.                                                                   |

The Office of the Privacy Commissioner of Canada’s fair information principles offer a reference for these questions. Your privacy lead can identify the rules that apply in your jurisdiction. [Fair information principles](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/p_principle/)

For supporting evidence, IT can check the software’s page access and storage against the installed version, verify the package, and test the proposed workstation with sample data. Local privacy and security approval depends on that deployment. [Architecture](architecture.md) · [Release and package verification](RELEASING.md) · [Workstation setup](workstation-setup.md) · [Security reporting](security.md)

The description covers the 2.0 candidate on the Alpha branch. To validate a package, compare its version and controls with the reviewed source. The page permissions, counter definitions and diagnostic fields can be checked independently. [Page permissions](https://github.com/WDGPH/VaxLink/blob/189c677/apps/extension/manifest.json) · [Settings](https://github.com/WDGPH/VaxLink/blob/189c677/apps/extension/popup.html) · [Local Activity and its export](https://github.com/WDGPH/VaxLink/blob/189c677/apps/extension/background.js#L2198) · [Debug fields](https://github.com/WDGPH/VaxLink/blob/189c677/apps/extension/recent-activity.js)
