import { privacyMetadata } from '@/content/site'

export const metadata = privacyMetadata

const UPDATED_AT = 'April 28, 2026'

export default function PrivacyPage() {
  return (
    <div className="policy-page">
      <article className="policy-doc">
        <header className="policy-header">
          <p className="policy-kicker">Privacy Policy</p>
          <h1>VaxLink Privacy Policy</h1>
          <p className="policy-updated">Last updated: {UPDATED_AT}</p>
        </header>

        <section>
          <p>
            This policy describes the current data handling behavior of the VaxLink website and Chrome extension. VaxLink
            is designed for vaccine barcode parsing, National Vaccine Catalogue lookups, and supported chart-entry
            workflows in Panorama and InputHealth.
          </p>
        </section>

        <section>
          <h2>What VaxLink May Handle</h2>
          <p>Depending on how it is used, VaxLink may handle the following categories of information:</p>
          <ul>
            <li>Barcode payloads and parsed vaccine fields such as GTIN, lot, expiry, serial, DIN, trade name, manufacturer, route, and dose.</li>
            <li>Supported chart-entry values used for review and autofill on Panorama or InputHealth pages.</li>
            <li>Local workflow settings, queue records, cached National Vaccine Catalogue data, and inventory records stored on the local device.</li>
            <li>Local operational analytics such as scan counts, workflow usage, export counts, device identifiers, and optional workstation labels entered by the user.</li>
          </ul>
        </section>

        <section>
          <h2>How VaxLink Uses Data</h2>
          <p>VaxLink uses data only to support its stated workflow features. This includes:</p>
          <ul>
            <li>Parsing scanned or pasted vaccine barcode data.</li>
            <li>Resolving vaccine and lot details from National Vaccine Catalogue reference data.</li>
            <li>Showing reviewable values before autofill.</li>
            <li>Autofilling supported chart fields on supported pages.</li>
            <li>Maintaining local queue, inventory, reconciliation, monitoring, and export workflows.</li>
            <li>Producing user-requested CSV or JSON exports on the local workstation.</li>
          </ul>
        </section>

        <section>
          <h2>Where Data Is Stored</h2>
          <p>VaxLink only uses local browser-managed storage on the device where the extension is installed.</p>
          <ul>
            <li>`chrome.storage.local` is used for settings, cached National Vaccine Catalogue data, local queues, and local analytics.</li>
            <li>IndexedDB is used by the inventory manager for inventory items, transaction records, reconciliation data, incidents, monitoring cases, and related operational records.</li>
            <li>If the user exports CSV or JSON files, those files are downloaded to the local device and are managed outside the extension after download.</li>
          </ul>
        </section>

        <section>
          <h2>What Leaves the Browser</h2>
          <p>
            The extension may fetch National Vaccine Catalogue reference data from{' '}
            <code>https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC</code> and related bundle URLs returned by that service so
            local lookups stay current.
          </p>
          <p>
            Those network requests are used for reference data refreshes. 
          </p>
        </section>

        <section>
          <h2>Sharing and Disclosure</h2>
          <p>VaxLink does not sell user data. It does not disclose extension-handled data to advertising platforms, data brokers, or unrelated third parties.</p>
          <p>
            The current extension is designed to keep workflow data local unless the user deliberately exports a file from
            the workstation.
          </p>
        </section>

        <section>
          <h2>Retention</h2>
          <p>Local extension data remains in browser-managed storage until it is cleared by the user, replaced by newer local data, or removed with the extension.</p>
          <p>Downloaded export files remain on the device until the user deletes them.</p>
          <p>Organizations using VaxLink should apply their own workstation security, retention, and local file handling requirements to exported materials.</p>
        </section>

        <section>
          <h2>User Controls</h2>
          <ul>
            <li>Review values in the extension before using autofill on a supported chart page.</li>
            <li>Clear downloaded export files from the device when they are no longer needed.</li>
            <li>Reset local analytics from the extension settings panel where available.</li>
            <li>Clear browser-managed extension data or remove the extension to remove locally stored extension data.</li>
          </ul>
        </section>

        <section>
          <h2>Contact and Deployment Notes</h2>
          <p>Use the support contact published with the Chrome Web Store listing or the internal deployment owner responsible for your VaxLink rollout if you have a privacy question.</p>
          <p>
            If a specific deployment adds third-party analytics, authentication, or backend services beyond what is
            described here, that deployment should publish an updated or supplemental privacy notice before use.
          </p>
        </section>
      </article>
    </div>
  )
}
