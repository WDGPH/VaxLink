import Link from 'next/link'
import { CompatibilityTable } from '@/components/CompatibilityTable'
import { FAQSection } from '@/components/FAQSection'
import { InstallSteps } from '@/components/InstallSteps'
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
import { withBasePath } from '@/lib/base-path'

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
    <div className="pt-16">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }} />

      <section className="relative overflow-hidden py-20" style={{ background: 'var(--hero-bg)' }}>
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse at 75% 50%, rgba(37,99,235,0.12) 0%, transparent 55%)',
          }}
        />
        <div className="grain" />

        <div className="section-inner relative z-10 flex flex-col lg:flex-row items-center gap-12">
          <div className="flex-1 max-w-xl">
            <div
              className="inline-flex items-center gap-2 rounded-full border px-3 py-1 mb-6"
              style={{ borderColor: 'rgba(37,99,235,0.35)', background: 'rgba(37,99,235,0.08)' }}
            >
              <span className="font-mono text-[11px] text-blue-300 tracking-widest uppercase">
                Chrome Extension · v{siteConfig.version} · Manifest V3
              </span>
            </div>

            <h1
              className="font-sora font-extrabold text-white leading-tight"
              style={{ fontSize: 'clamp(2rem, 4.5vw, 3.5rem)' }}
            >
              Barcode to CHR,
              <br />
              <span
                style={{
                  background: 'linear-gradient(135deg, #3b82f6, #818cf8)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >
                with review before write.
              </span>
            </h1>

            <p className="mt-5 text-white/60 leading-relaxed" style={{ maxWidth: '48ch' }}>
              Parse GS1 vaccine barcodes, resolve lot metadata, and review autofill-ready values for
              Panorama and InputHealth before updating chart fields.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href="#install"
                className="inline-flex items-center gap-2 font-sora font-semibold text-sm px-6 py-3 rounded-full text-white"
                style={{
                  background: 'linear-gradient(135deg,#3b82f6,#2563eb)',
                  boxShadow: '0 0 24px rgba(37,99,235,0.3)',
                }}
              >
                Install Guide ↓
              </a>
              <Link
                href={withBasePath('/explorer')}
                className="inline-flex items-center gap-2 font-sora font-semibold text-sm px-6 py-3 rounded-full border"
                style={{ borderColor: 'rgba(255,255,255,0.18)', color: 'rgba(255,255,255,0.78)' }}
              >
                Open Web Explorer
              </Link>
            </div>

            <div className="mt-8">
              <TrustStrip items={extensionTrustChips} dark />
            </div>
          </div>

          <div className="flex-shrink-0 w-full max-w-xs">
            <ExtensionMockup />
          </div>
        </div>
      </section>

      <section id="compatibility" className="py-20 bg-white">
        <div className="section-inner">
          <SectionHeader
            eyebrow="Supported Environments"
            title="Compatibility is explicit, not implied"
            body="The extension is intended for Chrome-based clinic workflows. Only Panorama and InputHealth are supported today."
          />
          <CompatibilityTable />
        </div>
      </section>

      <section className="py-20 bg-white">
        <div className="section-inner">
          <SectionHeader
            eyebrow="Read and Write Surface"
            title="What VaxLink reads from the barcode and writes into the CHR"
            body="The extension stays narrow on purpose: parse the barcode, resolve the lot, review the fields, then autofill the supported record."
          />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="rounded-2xl border border-slate-200 p-6">
              <p className="font-mono text-xs text-blue-600 uppercase tracking-widest mb-4">
                Reads from barcode
              </p>
              <div className="space-y-3">
                {EXTRACTS.map(({ ai, label, desc }) => (
                  <div key={ai} className="flex items-start gap-3">
                    <span
                      className="font-mono text-[10px] rounded-md px-2 py-1 shrink-0 mt-0.5"
                      style={{ background: 'rgba(37,99,235,0.1)', color: '#2563eb' }}
                    >
                      {ai}
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-slate-800">{label}</p>
                      <p className="text-xs text-slate-500">{desc}</p>
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-xs text-slate-400">
                Also supports plain text labels: <span className="font-mono">LOT:</span>{' '}
                <span className="font-mono">EXP:</span>{' '}
                <span className="font-mono">DIN:</span>
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 p-6">
              <p className="font-mono text-xs text-amber-600 uppercase tracking-widest mb-4">
                Fills in CHR
              </p>
              <ul className="space-y-2.5">
                {FILLS.map((field) => (
                  <li key={field} className="flex items-center gap-3 text-sm text-slate-700">
                    <span
                      className="w-4 h-4 rounded-full flex items-center justify-center shrink-0"
                      style={{ background: 'rgba(245,158,11,0.15)' }}
                    >
                      <svg className="w-2.5 h-2.5 text-amber-500" viewBox="0 0 12 12" fill="currentColor">
                        <path d="M10 3L5 8.5 2 5.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    {field}
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-xs text-slate-400">
                Supported platforms: Panorama, InputHealth. More planned: OSCAR, Wolf, PS Suite.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section id="install" className="py-20" style={{ background: 'var(--bg)' }}>
        <div className="section-inner">
          <SectionHeader
            eyebrow="Installation"
            title="Developer mode install with a validation checklist"
            body="The current distribution model is an unpacked Chrome extension. Use these steps and the checklist to validate the environment before documenting live charts."
          />
          <InstallSteps />
        </div>
      </section>

      <section id="permissions" className="py-20 bg-white">
        <div className="section-inner">
          <SectionHeader
            eyebrow="Permissions and Local Data"
            title="What the extension requests, what it stores, and what it does not do"
            body="Permissions are tied directly to supported workflow needs. The extension stores bundle data locally, works against active chart fields, and does not turn the website into a patient-data backend."
          />
          <PermissionsTable />
          <div id="data-handling" className="compatibility-notes mt-6">
            <div className="note-card">
              <h3>Local bundle storage</h3>
              <p>Bundle data is cached in browser storage to support repeat lookups and offline fallback behavior.</p>
            </div>
            <div className="note-card">
              <h3>No chart backend</h3>
              <p>The website does not persist patient chart data. The extension acts on the active page fields needed for autofill.</p>
            </div>
            <div className="note-card">
              <h3>Refresh cadence</h3>
              <p>Bundle checks run about every 24 hours, with the last local snapshot available if a refresh fails.</p>
            </div>
          </div>
        </div>
      </section>

      <section id="troubleshooting" className="py-20" style={{ background: 'var(--bg)' }}>
        <div className="section-inner">
          <SectionHeader
            eyebrow="Troubleshooting"
            title="Common install and workflow failure modes"
            body="This page is intended to cover the common setup, barcode, and lot-match issues without requiring repo spelunking."
          />
          <div className="trouble-grid">
            {troubleshootingItems.map((item) => (
              <div key={item.title} className="faq-card">
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="release-notes" className="py-20 bg-white">
        <div className="section-inner">
          <SectionHeader
            eyebrow="Release Notes"
            title="Current release posture"
            body="The website now acts as the operational adoption surface for the current extension release."
          />
          <div className="compatibility-notes">
            <div className="note-card">
              <h3>Current release</h3>
              <p>Version {siteConfig.version} focuses on barcode parsing, NVC-backed lot resolution, and Panorama/InputHealth autofill workflows.</p>
            </div>
            <div className="note-card">
              <h3>Maturity</h3>
              <p>Recommended for internal clinic evaluation where supported screens can be validated before production use.</p>
            </div>
            <div className="note-card">
              <h3>Roadmap</h3>
              <p>Additional CHR integrations remain planned and should not be treated as supported until released here.</p>
            </div>
          </div>
        </div>
      </section>

      <section id="faq" className="py-20" style={{ background: 'var(--bg)' }}>
        <div className="section-inner">
          <SectionHeader
            eyebrow="FAQ"
            title="Questions clinic teams ask before rollout"
            body="These answers are written to help operational reviewers quickly assess risk, compatibility, and workflow fit."
          />
          <FAQSection />
        </div>
      </section>
    </div>
  )
}
