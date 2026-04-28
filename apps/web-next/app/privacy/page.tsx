import Link from 'next/link'
import { PanelFrame } from '@/components/PanelFrame'
import { SectionHeader } from '@/components/SectionHeader'
import { privacyMetadata } from '@/content/site'
import { withBasePath } from '@/lib/base-path'

export const metadata = privacyMetadata

const UPDATED_AT = 'April 28, 2026'

const handledData = [
  {
    title: 'Barcode and chart-entry data',
    body:
      'When you scan, paste, review, or autofill with the extension, VaxLink may handle barcode payloads and the derived vaccine fields needed for the workflow, such as GTIN, lot, expiry, serial, DIN, trade name, manufacturer, route, dose, and the supported chart fields being filled.',
  },
  {
    title: 'Local workflow and inventory data',
    body:
      'VaxLink stores local settings, cached National Vaccine Catalogue data, scan queues, inventory records, reconciliation notes, monitoring records, and export-ready files in browser-managed storage on the device where the extension is used.',
  },
  {
    title: 'Local analytics and labels',
    body:
      'The extension can keep local operational analytics such as scan counts, workflow usage, export counts, device identifiers, and an optional workstation or nurse label entered by the user. These analytics are stored locally for on-device reporting.',
  },
  {
    title: 'Website access data',
    body:
      'The VaxLink website is informational. It does not ask visitors to upload patient charts or barcode scans. If the site is hosted, the hosting provider may process routine request data such as IP address, browser type, referrer, and request time to serve and secure the page.',
  },
]

const controls = [
  'Review values in the extension before using autofill on a supported chart page.',
  'Clear downloaded export files from the device when they are no longer needed.',
  'Reset local analytics from the extension settings panel where available.',
  'Clear browser-managed extension data or remove the extension to remove locally stored extension data.',
]

export default function PrivacyPage() {
  return (
    <div className="pt-16 privacy-page-shell">
      <section className="mode-page-hero privacy-page-hero">
        <div className="section-inner">
          <PanelFrame tone="hero" eyebrow="Privacy Policy" title="How VaxLink handles data" className="privacy-hero-card">
            <div className="privacy-hero-copy">
              <p>
                This policy describes the current VaxLink website and Chrome extension behavior as of {UPDATED_AT}. VaxLink
                is built for barcode review, National Vaccine Catalogue lookups, and supported chart-entry workflows.
              </p>
              <p>
                The extension is designed to keep workflow data on the local workstation unless the user deliberately exports
                a file or the extension fetches reference data from the National Vaccine Catalogue source.
              </p>
              <div className="privacy-hero-links">
                <Link href={withBasePath('/extension#permissions')} className="hero-primary-cta">
                  Review Permissions
                </Link>
                <Link href={withBasePath('/extension#data-handling')} className="hero-secondary-cta">
                  See Data Handling Notes
                </Link>
              </div>
            </div>
          </PanelFrame>
        </div>
      </section>

      <section className="py-20 bg-white">
        <div className="section-inner">
          <SectionHeader
            eyebrow="Scope"
            title="What VaxLink may handle"
            body="The extension has a narrow purpose: parse vaccine barcodes, review vaccine details, and support autofill or inventory workflows on supported systems."
          />

          <div className="privacy-grid">
            {handledData.map((item, index) => (
              <PanelFrame
                key={item.title}
                tone={index % 4 === 0 ? 'utility' : index % 4 === 1 ? 'panel' : index % 4 === 2 ? 'reference' : 'hero'}
                eyebrow={`Category 0${index + 1}`}
                title={item.title}
                className="privacy-card"
              >
                <p>{item.body}</p>
              </PanelFrame>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20" style={{ background: 'var(--bg-panel)' }}>
        <div className="section-inner">
          <SectionHeader
            eyebrow="Use and Storage"
            title="Why the data is used and where it stays"
            body="The current codebase uses data only for the active barcode, lookup, autofill, inventory, and local reporting workflows."
          />

          <div className="privacy-detail-grid">
            <PanelFrame tone="utility" eyebrow="Use" title="How VaxLink uses data" className="privacy-card">
              <div className="privacy-copy">
                <p>VaxLink uses barcode and chart-related data to parse scans, resolve lot metadata, show reviewable values, autofill supported chart fields, maintain local queues, and produce user-requested inventory or analytics exports.</p>
                <p>VaxLink is not designed to sell data, profile users for advertising, or transmit patient chart content to a developer-operated backend.</p>
              </div>
            </PanelFrame>

            <PanelFrame tone="reference" eyebrow="Storage" title="Where data is stored" className="privacy-card">
              <div className="privacy-copy">
                <p>The extension uses browser-managed local storage for settings, cached bundle data, queue records, and local analytics. The inventory manager also uses IndexedDB for inventory items, transaction records, reconciliation data, monitoring cases, and related operational records.</p>
                <p>If you export CSV or JSON files, those files are downloaded to the local device and are then managed outside the extension.</p>
              </div>
            </PanelFrame>
          </div>
        </div>
      </section>

      <section className="py-20 bg-white">
        <div className="section-inner">
          <SectionHeader
            eyebrow="Network and Sharing"
            title="What leaves the browser"
            body="The codebase shows a local-first workflow with limited network access for reference data refreshes and normal website delivery."
          />

          <div className="privacy-detail-grid">
            <PanelFrame tone="panel" eyebrow="Outbound" title="Reference data requests" className="privacy-card">
              <div className="privacy-copy">
                <p>The extension can fetch National Vaccine Catalogue bundle data from the public PHAC endpoint at <code>https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC</code> and related bundle URLs returned by that service so local lookups stay current.</p>
                <p>Those requests are for reference data refreshes. They are not used to upload patient chart data, barcode contents, clipboard contents, inventory records, or local analytics to VaxLink-operated servers.</p>
              </div>
            </PanelFrame>

            <PanelFrame tone="hero" eyebrow="Sharing" title="What VaxLink does not do" className="privacy-card">
              <div className="privacy-copy">
                <p>VaxLink does not sell user data. It does not disclose extension-handled data to advertising platforms, data brokers, or unrelated third parties.</p>
                <p>VaxLink also does not provide a human review channel for extension-handled workflow data because the current extension keeps that data local unless the user chooses to export a file from the workstation.</p>
              </div>
            </PanelFrame>
          </div>
        </div>
      </section>

      <section className="py-20" style={{ background: 'var(--bg-base)' }}>
        <div className="section-inner">
          <SectionHeader
            eyebrow="Retention and Control"
            title="How long data stays and what users can do"
            body="Retention depends on local browser storage and the files created by the user on the workstation."
          />

          <div className="privacy-detail-grid">
            <PanelFrame tone="reference" eyebrow="Retention" title="Data lifetime" className="privacy-card">
              <div className="privacy-copy">
                <p>Local extension data remains in browser-managed storage until it is cleared by the user, replaced by newer local data, or removed with the extension. Downloaded export files remain on the device until the user deletes them.</p>
                <p>Because VaxLink is intended for workstation-based clinical workflows, users should apply their organization&apos;s retention, workstation security, and local file handling rules to any exported materials.</p>
              </div>
            </PanelFrame>

            <PanelFrame tone="utility" eyebrow="User actions" title="Available controls" className="privacy-card">
              <ul className="privacy-list">
                {controls.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </PanelFrame>
          </div>
        </div>
      </section>

      <section className="py-20 bg-white">
        <div className="section-inner">
          <SectionHeader
            eyebrow="Questions"
            title="Privacy contact and deployment notes"
            body="This page covers the repository behavior reflected in the current VaxLink codebase."
          />

          <div className="privacy-detail-grid">
            <PanelFrame tone="panel" eyebrow="Contact" title="How to raise a privacy question" className="privacy-card">
              <div className="privacy-copy">
                <p>Use the support contact published with the Chrome Web Store listing or the internal deployment owner responsible for your VaxLink rollout.</p>
                <p>If a specific deployment adds third-party analytics, authentication, or backend services beyond what is described here, that deployment should publish an updated or supplemental privacy notice before use.</p>
              </div>
            </PanelFrame>

            <PanelFrame tone="reference" eyebrow="Related" title="Where to verify this behavior" className="privacy-card">
              <div className="privacy-copy">
                <p>
                  You can compare this policy with the extension&apos;s{' '}
                  <Link href={withBasePath('/extension#permissions')} className="text-link-button">
                    permissions summary
                  </Link>{' '}
                  and{' '}
                  <Link href={withBasePath('/extension#data-handling')} className="text-link-button">
                    local data notes
                  </Link>
                  .
                </p>
              </div>
            </PanelFrame>
          </div>
        </div>
      </section>
    </div>
  )
}
