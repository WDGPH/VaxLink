import { FileText, ScanBarcode, SearchCheck, MonitorSmartphone } from 'lucide-react'
import { homepageFeatures } from '@/content/site'
import { SectionHeader } from '@/components/SectionHeader'
import { StaggerContainer, StaggerItem } from '@/components/ui/motion'

const MINI_BARS = [2,1,3,2,1,1,3,2,1,2,1,3,2,1,2,1,3,1,2,3,1,2]

const visuals = [
  {
    icon: FileText,
    visual: (
      <div className="mt-5 rounded-lg p-3 font-mono text-[10px] leading-relaxed bg-slate-900 border border-slate-800 text-slate-300">
        <div><span className="text-blue-300">&quot;resourceType&quot;</span>: <span className="text-amber-300">&quot;CodeSystem&quot;</span>,</div>
        <div><span className="text-blue-300">&quot;name&quot;</span>: <span className="text-amber-300">&quot;NVCLotCodes&quot;</span>,</div>
        <div><span className="text-blue-300">&quot;status&quot;</span>: <span className="text-green-400">&quot;active&quot;</span>,</div>
        <div className="text-slate-600"><span className="text-blue-400/50">&quot;concept&quot;</span>: <span className="text-blue-400/70">[ 4,200 entries ]</span></div>
      </div>
    ),
  },
  {
    icon: ScanBarcode,
    visual: (
      <div className="mt-5" aria-hidden>
        <div className="flex gap-px h-7 rounded overflow-hidden bg-slate-100 w-full">
          {MINI_BARS.map((w, i) => (
            <div key={i} className={i % 2 === 0 ? 'bg-slate-800' : 'bg-transparent'} style={{ width: w * 5, flexShrink: 0 }} />
          ))}
        </div>
        <p className="font-mono text-[10px] text-blue-600 mt-2">(01)…(10)…(17)…(21)…</p>
      </div>
    ),
  },
  {
    icon: SearchCheck,
    visual: (
      <div className="mt-5 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2.5 font-mono text-[10px]">
        <div className="text-slate-500">lot: <span className="text-blue-700 font-semibold">2024B-LOT12</span></div>
        <div className="flex items-center gap-1.5 mt-1 text-slate-700">
          <span className="text-blue-500">→</span> Fluzone Quadrivalent · DIN 02484811
        </div>
      </div>
    ),
  },
  {
    icon: MonitorSmartphone,
    visual: (
      <div className="mt-5 space-y-1.5">
        {[['Trade Name', 'Fluzone Quadrivalent'], ['DIN', '02484811'], ['Expiry', '2026-06']].map(([k, v]) => (
          <div key={k} className="flex items-center gap-3 px-3 py-1.5 rounded-md bg-amber-50 border border-amber-100 text-[10px]">
            <span className="font-mono text-amber-700/70 w-16 shrink-0">{k}</span>
            <span className="font-medium text-amber-900 flex-1 truncate">{v}</span>
            <span className="text-green-600 flex-shrink-0">✓</span>
          </div>
        ))}
      </div>
    ),
  },
]

export function FeaturesSection() {
  return (
    <section id="features" className="py-24 bg-white">
      <div className="section-inner">
        <SectionHeader
          eyebrow="What It Actually Does"
          title="Concrete workflow support instead of abstract product claims"
          body="Each capability is tied to a real clinic use case: parse the barcode, resolve the lot, review source-backed values, and then document with confidence."
        />

        <StaggerContainer className="grid grid-cols-1 sm:grid-cols-2 gap-5" stagger={0.1}>
          {homepageFeatures.map(({ title, summary, detail, proof }, index) => {
            const { icon: Icon, visual } = visuals[index]
            return (
              <StaggerItem key={title}>
                <article className="feature-proof-card">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-5 bg-blue-50 text-blue-600 flex-shrink-0">
                    <Icon className="w-5 h-5" strokeWidth={1.75} />
                  </div>
                  <h3 className="font-sora font-semibold text-slate-900 text-base mb-2">{title}</h3>
                  <p className="text-sm text-slate-700 leading-relaxed">{summary}</p>
                  <p className="mt-3 text-sm text-slate-500 leading-relaxed">{detail}</p>
                  {proof ? <p className="mt-4 text-xs font-medium text-blue-700">{proof}</p> : null}
                  <div className="mt-auto">{visual}</div>
                </article>
              </StaggerItem>
            )
          })}
        </StaggerContainer>
      </div>
    </section>
  )
}
