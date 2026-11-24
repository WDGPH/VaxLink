# Check scanner capture and chart protection on a workstation

Use training records, known sample barcodes and the clinic’s designated browser profile. Record the starting tray contents and held scans. Keep the browser running and the workstation awake.

## Prepare one training run

1. Extract the supplied Alpha ZIP into a dedicated folder. In the designated training profile, open `chrome://extensions`, turn on Developer mode and choose **Load unpacked**. Select the folder containing `manifest.json`. Open a fresh synthetic training chart. Keep additional VaxLink copies disabled until the two-installation check.
2. In **Settings → Debug mode**, turn on **Collect troubleshooting details**. Record the extension version, browser, scanner and cradle. Use fictional training samples for the run.
3. Keep a short observation sheet with the test name, time, sample order, expected destination and what you saw. The log cannot establish which work Windows or the scanner missed, or whether Panorama saved a record.

## Capture with Windows locked

1. Select Immunization, open a training chart and record its starting fields. Confirm the scanner is connected. Close the popup and lock Windows with Win+L.
2. Scan five known samples in a recorded order. Scan the same barcode twice consecutively.
3. Unlock and open VaxLink. Check **Scans from the last lock**, then open **Immunization → Held scanner scans**. Account for five new entries in capture order, including both copies of the repeated barcode. Check that unlocking and opening the popup left the training chart untouched.
4. Repeat in Inventory. Account for five new Inventory tray entries in the same order. Confirm that neither workflow filled the chart.
5. Repeat a lock with the cradle disconnected during the session. After unlocking, check for the interruption message and reconcile the samples. Check for the message even when no scans were saved.
6. Run a separate sleep and wake test. Record which samples arrived before sleep and after wake, and whether the reader needed reconnecting.

## Other release checks

| Exercise                                                              | What to check                                                                                                                                             |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delay opening, then disconnect before the port opens                  | The reader closes and accepts zero scans. Disconnect an unrelated serial device while scanning and confirm the status still describes the working reader. |
| Delay a fill, then switch tabs, switch from Chrome to Edge, or lock   | The background chart receives no new writes after the switch. Review the original chart if a write had already started. Repeat each change separately.    |
| Try to use the last dose from two training charts                     | Only one begins filling. Check the staff message in the other chart. Repeat with a pinned item and an item holding two doses.                             |
| Open production and Alpha on the same training chart                  | Check the conflict notice. Try a hardware scan and manual tray use. Check both trays and the original chart before removing the extra installation.       |
| Change USB sockets, disconnect the hub, then replace a broken scanner | Run a test scan after each change. Try two identical units connected together. Replace a cordless handheld and its cradle in separate runs.               |
| Slow local storage, unavailable catalogue and delayed chart response  | Exercise each separately. Check where the scan was saved, the staff message and the next safe action.                                                     |
| Update VaxLink while a training chart stays open                      | If the old chart script still responds, verify that the scan is held and the message says to check unsaved work before refreshing.                        |

For the update check, record if the browser removed the old chart script. In that case, confirm that the chart received no new fields.

Both installations in the conflict check must support conflict detection.
When a production release with this change is unavailable, extract the Alpha
package to two different folders and load both in the same training profile.
Refresh the synthetic chart and verify the two-copy warning. Record the
channels you actually tested. Disable the extra copy and check unsaved work
before refreshing again.

## Check Local Activity during the same run

1. In Inventory, note the **Inventory exports** and **Scanner captures** counts.
   Export the tray once. Check that Today and All time each rose by one export,
   then download the Local Activity JSON and compare its totals.
2. Repeat while scanning one fictional sample. Check for one more export, one
   new scanner capture and one new Inventory row. Record the sample order.
3. On a synthetic training chart, turn automatic funding selection off. With
   Debug mode off, trigger one funding prompt and choose a category. Check the
   daily prompt and choice counts. Repeat with Debug mode on and export the
   session log. Check the prompt reason and choice, then turn collection off and
   confirm that both daily counts still include both attempts.
4. On the Multiple grid, fill a row from the tray and choose **Enter Details**.
   Repeat after switching away and returning. Record the Agent, Lot and dose
   availability in each case, including whether Panorama replaced the grid row.

## Collect the results together

Download the Debug mode log before turning collection off, reloading VaxLink, or restarting the browser. Those actions clear the log. If a scenario requires a reload or an installation change, download that part first. Keep the files and send them together with the workstation observations after the last check. Each installation has its own log.

## Earlier package checks

The combined Alpha package at `43a1c8b` contained the runtime at `144c127`. On November 22, 2026, Chromium checks used simulated ports and synthetic chart pages.

- One Inventory CSV raised the screen and JSON export counts by one. A second
  CSV requested alongside a simulated serial scan added one export and one
  capture. The new activity JSON omitted the sample lot and barcode.
- With Debug mode off and then on, two prompts and two choices produced two
  of each daily count. The enabled session recorded the prompt reason and
  answer. Turning collection off preserved both totals.
- Two charts competed for the last dose. Dismissing the prompt before entry
  released it to the second chart. Interrupting after Agent entry held it for
  review and blocked reuse on the first chart.
- Settings required a fresh reader reply for Connected. The scanner checks
  covered a second popup during a sample test, Disconnect during a delayed
  open, an unrelated USB removal, an unanswered status request with a cached
  capture time, and a failed close followed by a successful retry.
- Controlled Node tests covered a delayed count across reset, a scan saved
  while counting was blocked, a replaced grid row, and a lock and unlock
  before a detail transfer. The full extension suite passed all 339 tests.

The original Alpha package at `99301fa` remains the training comparison build.

On November 24, 2026, a workstation tester reported that scanner setup and
Inventory worked on the Alpha reference package at `aa76ff2`. The package
matched the build fingerprint in the troubleshooting export. The export
showed scanner capture with Inventory selected. Check the tray itself when
confirming Inventory saves. Panorama training was under maintenance during
that run, so it did not provide a live chart result.

## Evidence to record

Record the workstation configuration, test date, sample order, expected and observed destinations, chart fields before and after, and any interruption. Keep patient information out of test records. A passing software simulation covers only the simulated case. Record a clinic hardware pass only after running the procedure on the named configuration.

Use the [workstation setup sheet](../workstation-setup.md) for each new
package and workstation. Record the exact package used for each result so
that a result from an earlier build does not carry forward to a later one.
