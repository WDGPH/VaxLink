import Link from 'next/link'
import { footerColumns, siteConfig } from '@/content/site'
import { withBasePath } from '@/lib/base-path'

export function Footer() {
  return (
    <footer className="site-footer">
      <div
        className="site-footer-line"
      />

      <div className="section-inner site-footer-inner">
        <div className="site-footer-grid">
          <div>
            <p className="site-footer-brand">
              Vax<span>Link</span>
            </p>
            <p className="site-footer-copy">
              Vaccine barcode lookup and chart entry for Panorama and InputHealth, using National Vaccine Catalogue data.
            </p>
            <p className="site-footer-meta">Version {siteConfig.version} · Internal toolkit, not affiliated with PHAC.</p>
          </div>

          {footerColumns.map((column) => (
            <div key={column.title}>
              <p className="site-footer-heading">{column.title}</p>
              <nav className="site-footer-links">
                {column.links.map((link) => (
                  <Link
                    key={link.label}
                    href={link.external ? link.href : withBasePath(link.href)}
                    target={link.external ? '_blank' : undefined}
                    rel={link.external ? 'noreferrer' : undefined}
                    className="site-footer-link"
                  >
                    {link.label}
                  </Link>
                ))}
              </nav>
            </div>
          ))}
        </div>

        <div className="site-footer-bottom">
          <p>Source data reference: National Vaccine Catalogue FHIR bundle maintained by the Public Health Agency of Canada.</p>
          <p>Built for clinic chart entry.</p>
        </div>
      </div>
    </footer>
  )
}
