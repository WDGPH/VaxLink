import Link from 'next/link'
import { SectionHeader } from '@/components/SectionHeader'
import { trustPoints } from '@/content/site'
import { withBasePath } from '@/lib/base-path'

export function TrustSection() {
  return (
    <section className="py-24" style={{ background: 'var(--bg)' }}>
      <div className="section-inner">
        <SectionHeader
          eyebrow="Trust and Source of Truth"
          title="Operational clarity about data, permissions, and provenance"
          body="The site and extension are meant to help clinics evaluate VaxLink safely. The goal is transparency: what data is used, where it comes from, and what the browser extension actually touches."
        />
        <div className="trust-layout">
          <div className="trust-panel">
            <h3>What teams should know first</h3>
            <ul>
              {trustPoints.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="trust-panel trust-panel-secondary">
            <h3>Source and handling summary</h3>
            <p>
              VaxLink uses Health Canada&apos;s National Vaccine Catalogue bundle as its vaccine lot reference.
              Bundle data is cached locally in the browser for repeat lookups. The extension targets active CHR
              fields required for autofill and is not affiliated with Health Canada.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href={withBasePath('/extension#permissions')} className="text-link-button">
                Review permissions
              </Link>
              <Link href={withBasePath('/extension#faq')} className="text-link-button">
                Read the FAQ
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
