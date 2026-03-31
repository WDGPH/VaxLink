import Link from 'next/link'
import { CompatibilityTable } from '@/components/CompatibilityTable'
import { DiagnosticShell } from '@/components/DiagnosticShell'
import { FAQSection } from '@/components/FAQSection'
import { InstallSteps } from '@/components/InstallSteps'
import { PanelFrame } from '@/components/PanelFrame'
import { PermissionsTable } from '@/components/PermissionsTable'
import { SectionHeader } from '@/components/SectionHeader'
import { TrustStrip } from '@/components/TrustStrip'
import { ExtensionMockup } from '@/components/ExtensionMockup'
import {
  extensionMetadata,
  extensionTrustChips,
  faqItems,
  siteConfig,
  troubleshootingItems,
} from '@/content/site'

export const metadata = extensionMetadata

const EXTRACTS = [
  { ai: 'AI 01', label: 'GTIN', desc: '14-digit Global Trade Item Number' },
  { ai: 'AI 10', label: 'Lot', desc: 'Lot or batch number' },
  { ai: 'AI 17', label: 'Expiry', desc: 'Expiry date (YYMMDD -> formatted)' },
  { ai: 'AI 21', label: 'Serial', desc: 'Serial number' },
]

const FILLS = [
  'Trade name',
  'Manufacturer',
  'Route of administration',
  'Dose / strength',
  'DIN / drug code',
  'Lot number',
  'Expiry date',
]

export default function ExtensionPage() {
  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqItems.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  }

  return (
    <div className="pt-16 extension-page-shell">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }} />

      <section className="mode-page-hero mode-page-extension">
        <div className="section-inner mode-page-hero-grid">
          <DiagnosticShell
            label="Entry Mode"
            title="Chrome extension for barcode review and chart entry"
            aside={<span className="hero-version-pill">v{siteConfig.version}</span>}
            className="extension-command-shell"
          >
            <div className="extension-hero-copy">
              <p>
                Parse GS1 vaccine barcodes, check the lot data, and review the values before filling
                Panorama or InputHealth fields.
              </p>
              <div className="extension-hero-cta">
                <a href="#install" className="hero-primary-cta">Install Guide</a>
                <Link href="#compatibility" className="hero-secondary-cta">
                  View Compatibility
                </Link>
              </div>
              <TrustStrip items={extensionTrustChips} dark />
            </div>
          </DiagnosticShell>

          <PanelFrame tone="hero" eyebrow="Popup Preview" title="Extension review window" className="extension-hero-preview">
            <ExtensionMockup />
          </PanelFrame>
        </div>
      </section>

      <section id="compatibility" className="py-20" style={{ background: 'var(--bg-base)' }}>
        <div className="section-inner">
          <SectionHeader
            eyebrow="Supported Environments"
            title="Compatibility matrix"
            body="The extension targets Chrome. Panorama and InputHealth are supported charting targets in the current release."
          />
          <PanelFrame tone="utility" eyebrow="Matrix" title="Browser and CHR support" className="matrix-frame">
            <CompatibilityTable />
          </PanelFrame>
        </div>
      </section>

      <section className="py-20 bg-white">
        <div className="section-inner">
          <SectionHeader
            eyebrow="Read and Write"
            title="What the extension reads from the barcode and writes into the chart"
            body="The extension keeps its scope narrow: barcode in, review step, then field fill on supported screens."
          />

          <div className="io-console-grid">
            <PanelFrame tone="utility" eyebrow="Reads" title="Barcode fields and fallbacks" className="io-console">
              <div className="io-console-list">
                {EXTRACTS.map(({ ai, label, desc }) => (
                  <div key={ai} className="io-console-row">
                    <span>{ai}</span>
                    <div>
                      <strong>{label}</strong>
                      <p>{desc}</p>
                    </div>
                  </div>
                ))}
              </div>
              <p className="io-console-note">Also supports text labels such as LOT:, EXP:, and DIN: when scanner output is not fully structured.</p>
            </PanelFrame>

            <PanelFrame tone="panel" eyebrow="Writes" title="Fields prepared for chart entry" className="io-console">
              <div className="io-console-list io-console-list-simple">
                {FILLS.map((field) => (
                  <div key={field} className="io-console-row io-console-row-simple">
                    <span className="io-dot" />
                    <strong>{field}</strong>
                  </div>
                ))}
              </div>
              <p className="io-console-note">Supported platforms: Panorama and InputHealth. Other CHRs remain planned.</p>
            </PanelFrame>
          </div>
        </div>
      </section>

      <section id="install" className="py-20" style={{ background: 'var(--bg-panel)' }}>
        <div className="section-inner">
          <SectionHeader
            eyebrow="Install"
            title="Developer mode install and preflight check"
            body="The current release installs as an unpacked Chrome extension. Check the environment before working in a live chart."
          />
          <InstallSteps />
        </div>
      </section>

      <section id="permissions" className="py-20 bg-white">
        <div className="section-inner">
          <SectionHeader
            eyebrow="Permissions and Local Data"
            title="Browser access, local storage, and what the site does not keep"
            body="Each permission maps to a concrete browser action. Bundle data stays local to the browser."
          />
          <PanelFrame tone="reference" eyebrow="Access table" title="Requested permissions" className="matrix-frame">
            <PermissionsTable />
          </PanelFrame>
          <div id="data-handling" className="compatibility-notes mt-6">
            <PanelFrame tone="utility" eyebrow="Storage" title="Local bundle storage" className="note-card">
              <p>Bundle data is cached in browser storage to support repeat lookups and offline fallback behavior.</p>
            </PanelFrame>
            <PanelFrame tone="reference" eyebrow="Charts" title="No chart backend" className="note-card">
              <p>The website does not persist patient chart data. The extension acts only on the active page fields needed for autofill.</p>
            </PanelFrame>
            <PanelFrame tone="panel" eyebrow="Refresh" title="Bundle check interval" className="note-card">
              <p>Bundle checks run about every 24 hours, with the last local snapshot available if a refresh fails.</p>
            </PanelFrame>
          </div>
        </div>
      </section>

      <section id="troubleshooting" className="py-20" style={{ background: 'var(--bg-base)' }}>
        <div className="section-inner">
          <SectionHeader
            eyebrow="Troubleshooting"
            title="Common install and chart-entry problems"
            body="This section covers the setup, barcode, and lot-match problems people usually hit first."
          />
          <div className="trouble-grid">
            {troubleshootingItems.map((item, index) => (
              <PanelFrame
                key={item.title}
                tone={index % 3 === 0 ? 'utility' : index % 3 === 1 ? 'panel' : 'reference'}
                eyebrow={`Issue 0${index + 1}`}
                title={item.title}
                className="faq-card issue-card"
              >
                <p>{item.body}</p>
              </PanelFrame>
            ))}
          </div>
        </div>
      </section>

      <section id="release-notes" className="py-20 bg-white">
        <div className="section-inner">
          <SectionHeader
            eyebrow="Release Notes"
            title="Current release"
            body="This page tracks what the current extension release supports."
          />
          <div className="compatibility-notes">
            <PanelFrame tone="hero" eyebrow="Release" title={`Version ${siteConfig.version}`} className="note-card">
              <p>Barcode parsing, lot lookup, and Panorama/InputHealth field fill are the supported paths in this release.</p>
            </PanelFrame>
            <PanelFrame tone="reference" eyebrow="Status" title="Maturity" className="note-card">
              <p>Best suited for internal evaluation where supported screens can be checked before production use.</p>
            </PanelFrame>
            <PanelFrame tone="utility" eyebrow="Next" title="Roadmap" className="note-card">
              <p>Additional CHR integrations remain planned and are not supported until released here.</p>
            </PanelFrame>
          </div>
        </div>
      </section>

      <section id="faq" className="py-20" style={{ background: 'var(--bg-panel)' }}>
        <div className="section-inner">
          <SectionHeader
            eyebrow="FAQ"
            title="Questions people ask before trying the extension"
            body="These answers cover the practical questions that come up before rollout."
          />
          <FAQSection />
        </div>
      </section>
    </div>
  )
}
