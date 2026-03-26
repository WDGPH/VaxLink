import Link from 'next/link'
import { PanelFrame } from '@/components/PanelFrame'
import { SectionHeader } from '@/components/SectionHeader'
import { trustPoints } from '@/content/site'
import { withBasePath } from '@/lib/base-path'

export function TrustSection() {
  return (
    <section className="py-24" style={{ background: 'var(--bg)' }}>
      <div className="section-inner">
        <SectionHeader
          eyebrow="Trust and Source of Truth"
          title="What data VaxLink uses and what the extension can touch"
          body="The site keeps this section plain: data source, local storage, and the browser permissions tied to chart entry."
        />
        <div className="trust-layout">
          <PanelFrame tone="utility" eyebrow="Reference" title="What teams should know first" className="trust-panel">
            <ul className="trust-dossier-list">
              {trustPoints.map((item, index) => (
                <li key={item}>
                  <span>{`0${index + 1}`}</span>
                  <strong>{item}</strong>
                </li>
              ))}
            </ul>
          </PanelFrame>
          <PanelFrame tone="hero" eyebrow="Data summary" title="Bundle, browser, and chart access" className="trust-panel trust-panel-secondary">
            <p>
              VaxLink uses the National Vaccine Catalogue bundle maintained by the Public Health Agency of Canada as its lot reference.
              Bundle data stays in browser storage for repeated lookups. The extension targets the active
              chart fields needed for autofill and is not affiliated with PHAC.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href={withBasePath('/extension#permissions')} className="text-link-button">
                Review permissions
              </Link>
              <Link href={withBasePath('/extension#faq')} className="text-link-button">
                Read the FAQ
              </Link>
            </div>
          </PanelFrame>
        </div>
      </div>
    </section>
  )
}
