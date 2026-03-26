import Link from 'next/link'
import { footerColumns, siteConfig } from '@/content/site'
import { withBasePath } from '@/lib/base-path'

export function Footer() {
  return (
    <footer style={{ background: 'var(--dark-bg)' }}>
      <div
        className="h-px w-full"
        style={{ background: 'linear-gradient(90deg, transparent, #3b82f6 30%, #818cf8 50%, #3b82f6 70%, transparent)' }}
      />

      <div className="section-inner py-12">
        <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr_1fr_1fr_1fr] gap-10">
          <div>
            <p className="font-sora font-extrabold text-xl text-white tracking-tight">
              Vax<span className="text-blue-400">Link</span>
            </p>
            <p className="text-sm text-white/40 mt-2.5 leading-relaxed max-w-xs">
              Vaccine barcode workflows for clinic teams. Powered by the National Vaccine Catalogue and designed for Panorama/InputHealth operations.
            </p>
            <p className="text-xs text-white/25 mt-4">Version {siteConfig.version} · Internal toolkit, not affiliated with Health Canada.</p>
          </div>

          {footerColumns.map((column) => (
            <div key={column.title}>
              <p className="font-mono text-[10px] text-white/30 uppercase tracking-widest mb-4">{column.title}</p>
              <nav className="flex flex-col gap-2.5">
                {column.links.map((link) => (
                  <Link
                    key={link.label}
                    href={link.external ? link.href : withBasePath(link.href)}
                    target={link.external ? '_blank' : undefined}
                    rel={link.external ? 'noreferrer' : undefined}
                    className="text-sm text-white/50 hover:text-white transition-colors w-fit"
                  >
                    {link.label}
                  </Link>
                ))}
              </nav>
            </div>
          ))}
        </div>

        <div className="mt-10 pt-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <p className="text-xs text-white/25">Source data reference: Health Canada National Vaccine Catalogue FHIR bundle.</p>
          <p className="font-mono text-xs text-white/20">Built for clinic workflow clarity.</p>
        </div>
      </div>
    </footer>
  )
}
