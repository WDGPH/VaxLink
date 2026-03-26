import { ArrowRight } from 'lucide-react'
import { CompatibilitySection } from '@/components/CompatibilitySection'
import { ScreenshotShowcase } from '@/components/ScreenshotShowcase'
import { SectionHeader } from '@/components/SectionHeader'
import { TrackedLink } from '@/components/TrackedLink'
import { StaggerContainer, StaggerItem } from '@/components/ui/motion'
import { withBasePath } from '@/lib/base-path'

function ExplorerPreview() {
  return (
    <div className="rounded-xl overflow-hidden font-mono text-[11px] mt-6 bg-slate-900 border border-slate-800">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-slate-800">
        <span className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
        <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
        <span className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
        <span className="ml-2 text-slate-500 text-[10px]">NVC FHIR Bundle Explorer</span>
      </div>
      <div className="p-3 space-y-1.5">
        <div className="flex gap-3 text-slate-600 text-[10px] border-b border-slate-800 pb-1.5 mb-2">
          <span>#</span><span className="flex-1">Resource</span><span>Status</span>
        </div>
        {[
          { type: 'CodeSystem', name: 'nvc-lot-codes',  hl: true  },
          { type: 'ValueSet',   name: 'nvc-vaccines',   hl: false },
          { type: 'ValueSet',   name: 'nvc-routes',     hl: false },
          { type: 'CodeSystem', name: 'nvc-tradenames',  hl: false },
        ].map((r, i) => (
          <div key={i} className={`flex gap-3 ${r.hl ? 'text-blue-400' : 'text-slate-500'}`}>
            <span className="text-slate-600">{i + 1}</span>
            <span className="text-[10px] px-1 rounded" style={r.hl ? { background: 'rgba(37,99,235,0.15)' } : undefined}>
              {r.type}
            </span>
            <span className="flex-1 truncate">{r.name}</span>
            <span className="text-green-500/60 text-[10px]">active</span>
          </div>
        ))}
        <div className="mt-2 pt-2 border-t border-slate-800 text-slate-500 text-[10px]">
          <span className="text-blue-400/60">▶ </span>Lot 2024B-LOT12 → Fluzone Quad · DIN 02484811
        </div>
      </div>
    </div>
  )
}

function ExtensionPreview() {
  return (
    <div className="rounded-xl overflow-hidden font-mono text-[11px] mt-6 bg-slate-900 border border-slate-800 max-w-[260px]">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-800">
        <span className="font-sora font-bold text-sm text-white">Vax<span className="text-blue-400">Link</span></span>
        <span className="text-slate-500 text-[10px]">v1.0.4</span>
      </div>
      <div className="p-3 space-y-2">
        <div className="rounded border border-slate-700 p-2">
          <p className="text-slate-500 text-[10px] mb-1">Barcode Input</p>
          <p className="text-blue-300/80 truncate">(01)003813700075(17)2606(10)2024B</p>
        </div>
        <div className="flex gap-2">
          <div className="flex-1 rounded text-center py-1.5 text-white text-[10px] font-semibold bg-blue-600">Parse</div>
          <div className="flex-1 rounded text-center py-1.5 text-slate-400 text-[10px] border border-slate-700">Auto-fill</div>
        </div>
        <div className="space-y-1 pt-1 text-[10px]">
          {[['Trade Name','Fluzone Quad.'],['Lot','2024B-LOT12'],['Expiry','2026-06'],['DIN','02484811']].map(([k,v]) => (
            <div key={k} className="flex justify-between">
              <span className="text-slate-600">{k}</span>
              <span className="text-blue-300/70">{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function ToolsSection() {
  return (
    <>
      <section id="tools" className="py-24 bg-white">
        <div className="section-inner">
          <SectionHeader
            eyebrow="Choose Your Interface"
            title="Extension for clinic work, explorer for verification"
            body="VaxLink ships as two connected surfaces. The extension keeps charting fast. The explorer helps teams inspect bundle data, odd barcodes, and no-match scenarios."
          />

          <StaggerContainer className="grid grid-cols-1 lg:grid-cols-2 gap-6" stagger={0.15}>
            <StaggerItem>
              <div className="h-full rounded-2xl border border-slate-200 bg-white p-8 flex flex-col hover:border-blue-200 hover:shadow-lg transition-all duration-200">
                <div className="inline-flex items-center self-start rounded-md px-2.5 py-1 font-mono text-xs mb-4 bg-blue-50 text-blue-600 border border-blue-100">
                  Web App
                </div>
                <h3 className="font-sora font-bold text-slate-900 text-xl">NVC Data Explorer</h3>
                <p className="text-sm text-slate-500 mt-2 leading-relaxed">
                  Use it when staff need to confirm source data, inspect FHIR resources, or troubleshoot a lot lookup before changing chart entries.
                </p>
                <ExplorerPreview />
                <div className="mt-6 pt-5 border-t border-slate-100">
                  <TrackedLink
                    href={withBasePath('/explorer')}
                    event={{ name: 'cta_click', target: 'explorer' }}
                    className="group inline-flex items-center gap-2 font-sora font-semibold text-sm px-5 py-2.5 rounded-full text-white transition-all hover:opacity-90"
                    style={{ background: 'linear-gradient(135deg, #3b82f6, var(--accent))' }}
                  >
                    Launch Explorer <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
                  </TrackedLink>
                </div>
              </div>
            </StaggerItem>

            <StaggerItem>
              <div className="h-full rounded-2xl border border-slate-200 bg-white p-8 flex flex-col hover:border-amber-200 hover:shadow-lg transition-all duration-200">
                <div className="inline-flex items-center self-start rounded-md px-2.5 py-1 font-mono text-xs mb-4 bg-amber-50 text-amber-700 border border-amber-100">
                  Chrome Extension · v1.0.4
                </div>
                <h3 className="font-sora font-bold text-slate-900 text-xl">CHR Auto-fill Extension</h3>
                <p className="text-sm text-slate-500 mt-2 leading-relaxed">
                  This is the primary clinic path for barcode parsing and chart documentation inside Panorama and InputHealth.
                </p>
                <div className="flex"><ExtensionPreview /></div>
                <div className="mt-6 pt-5 border-t border-slate-100">
                  <TrackedLink
                    href={withBasePath('/extension#install')}
                    event={{ name: 'cta_click', target: 'install' }}
                    className="inline-flex items-center gap-2 font-sora font-semibold text-sm px-5 py-2.5 rounded-full border border-amber-200 text-amber-700 hover:bg-amber-50 transition-colors"
                  >
                    Install Guide →
                  </TrackedLink>
                </div>
              </div>
            </StaggerItem>
          </StaggerContainer>
        </div>
      </section>

      <CompatibilitySection />

      <section className="py-24" style={{ background: 'var(--bg)' }}>
        <div className="section-inner">
          <SectionHeader
            eyebrow="Proof Surfaces"
            title="Evidence-oriented screenshots instead of abstract promise cards"
            body="These views show the actual decision points clinic operators care about: parsed barcode values, pre-autofill review, and explorer-based validation."
          />
          <ScreenshotShowcase />
        </div>
      </section>
    </>
  )
}
