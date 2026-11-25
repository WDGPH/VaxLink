# Set up a scanning workstation

Designate one browser and one profile for scanning on each clinic workstation. Each browser profile and VaxLink installation has its own scanner connection and trays. Record the workstation configuration before staff start scanning.

| Record for this station                                | Local value |
| ------------------------------------------------------ | ----------- |
| Workstation identifier and Windows version             |             |
| Designated browser, version and profile                |             |
| VaxLink channel and version                            |             |
| Scanner model, handheld and cradle identifiers         |             |
| USB mode and VaxLink scanner profile                   |             |
| USB socket, hub or dock and power source               |             |
| Screen lock, sleep, hibernation and USB power settings |             |
| Tester, date and acceptance result                     |             |

1. Install the clinic channel in the designated profile. Keep training and development installations identifiable. Ordinary browser sync can install VaxLink on another computer. Tray items, held scans and pairing choices stay local to the installation.
2. Choose a scanner setup below. Use USB serial capture and disable keyboard output. Scan a training barcode into a focused blank text editor. Characters appearing there indicate keyboard output is still enabled.
3. Open **VaxLink → Settings → Scanner → Setup**. Choose the setup, then select **Connect scanner** and choose the device. Wait for Settings to show **Connected**. Then scan into Inventory and confirm that the sample reaches this station’s tray.
4. Close the popup and run the lock procedure below on an awake workstation. Record the results against the actual model, cradle, browser and profile. Test sleep and wake separately.
5. If the clinic copies browser profiles, test a copied profile on its destination workstation, including the contents present immediately after the copy. If it uses remote desktops, verify where the USB device is attached, where the browser runs and where the scan is saved. Record each combination separately.

## Choose a scanner setup

| Setup                      | What to expect                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standard USB CDC           | Use an existing USB CDC configuration or a generic serial scanner. The device controls its own beep.                                                    |
| Zebra DS8178 live feedback | The scanner uses SSI over USB CDC. VaxLink sounds a result after checking the barcode and catalogue. The normal decode beep is off.                     |
| Zebra DS8178 long range    | The scanner uses USB CDC and can store scans away from its cradle. Its decode beep confirms capture. VaxLink queues arrivals without sounding a result. |

Existing USB CDC scanners keep their saved setup. Use the Zebra options only with the DS8178 and its USB cradle.

### Program the Zebra DS8178

1. Finish uploading any stored scans. Then choose **Disconnect** in **VaxLink → Settings → Scanner** before changing the scanner’s settings. Keep the scanner near its powered, paired cradle.
2. In **VaxLink → Settings → Scanner → Setup**, choose the Zebra setup you want. Open **Program your Zebra DS8178** and print the setup sheet at 100% scale.
3. For an optional clean start, scan **Set Factory Defaults** first. This clears custom defaults and settings. Scan the symbols for your chosen setup in order. When you reach the USB host type, wait for the connection to restart before continuing. The browser may ask you to choose the scanner again.
4. With live feedback, use **Multipacket Option 1** and the **2-second Host Serial Response Timeout**. These are the factory settings. If they were customized, use the guide’s symbols on pages 9-19 and 9-17.
5. Return to setup, select the matching profile and choose **Connect scanner**. For live feedback, reopen setup and choose **Test saved scanner**. Listen for each of the three sounds. For long range, choose the workflow before docking the scanner to upload, then review the tray and any held scans. Finish any scanner test before uploading stored scans.

The setup sheet contains individual Zebra programming symbols from the DS8178 Product Reference Guide, MN-002752-18EN Rev A (August 2025). Use one symbol per step. Complete the hardware acceptance checks for the scanner, cradle and workstation before clinical use. [Zebra DS8178 Product Reference Guide](https://www.zebra.com/content/dam/support-dam/en/documentation/unrestricted/guide/product/ds8178-prg-en.pdf)

## Before clinical use

Confirm the station’s workflow and autofill settings with the clinical and privacy leads. Check the saved choices on the installed profile. The [privacy assessment guide](privacy-assessment.md) describes each switch and both diagnostic downloads.

Start in Inventory with representative products, formulations and package sizes. VaxLink recognizes nirsevimab as the Panorama agent RSVAb. Check each presentation against its label and the catalogue. In training, use synthetic records to try a single entry, several immunizations, an interrupted scan and a missing lot. Verify scan recovery after locking and unlocking the station. Ask an authorized Panorama administrator to confirm production lots and funding choices before clinical rollout.

[Workstation acceptance procedure](scanner-acceptance.md)
