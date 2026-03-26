import { FileText, MonitorSmartphone, ScanBarcode, SearchCheck } from 'lucide-react'
import { homepageFeatures } from '@/content/site'
import { PanelFrame } from '@/components/PanelFrame'
import { SectionHeader } from '@/components/SectionHeader'
import { StaggerContainer, StaggerItem } from '@/components/ui/motion'

const MINI_BARS = [2, 1, 3, 2, 1, 1, 3, 2, 1, 2, 1, 3, 2, 1, 2, 1, 3, 1, 2, 3, 1, 2]

const visuals = [
  {
    icon: ScanBarcode,
    body: (
      <div className="feature-snippet feature-snippet-bars" aria-hidden>
        <div className="feature-mini-bars">
          {MINI_BARS.map((width, index) => (
            <div
              key={index}
              className={index % 2 === 0 ? 'feature-bar-dark' : 'feature-bar-light'}
              style={{ width: width * 6 }}
            />
          ))}
        </div>
        <p>(01)...(10)...(17)...(21)...</p>
      </div>
    ),
  },
  {
    icon: SearchCheck,
    body: (
      <div className="feature-snippet feature-snippet-match">
        <span>lot</span>
        <strong>2024B-LOT12</strong>
        <p>Fluzone Quadrivalent · DIN 02484811</p>
      </div>
    ),
  },
  {
    icon: MonitorSmartphone,
    body: (
      <div className="feature-snippet feature-snippet-fields">
        {['Trade Name', 'DIN', 'Expiry'].map((field, index) => (
          <div key={field} className="feature-field-row">
            <span>{field}</span>
            <strong>{index === 0 ? 'Fluzone Quadrivalent' : index === 1 ? '02484811' : '2026-06'}</strong>
          </div>
        ))}
      </div>
    ),
  },
  {
    icon: FileText,
    body: (
      <div className="feature-snippet feature-snippet-json">
        <div><span>"resourceType"</span>: "CodeSystem"</div>
        <div><span>"name"</span>: "NVCLotCodes"</div>
        <div><span>"concept"</span>: [ 4200 entries ]</div>
      </div>
    ),
  },
]

export function FeaturesSection() {
  return (
    <section className="py-24" style={{ background: 'var(--bg-base)' }}>
      <div className="section-inner">
        <SectionHeader
          eyebrow="System Map"
          title="What the app does on an actual clinic screen"
          body="Each block maps to one step in the product: parse the barcode, check the lot, review the values, then inspect the bundle if something looks wrong."
        />

        <StaggerContainer className="feature-panel-grid" stagger={0.1}>
          {homepageFeatures.map((feature, index) => {
            const { icon: Icon, body } = visuals[index]
            return (
              <StaggerItem key={feature.slug}>
                <PanelFrame
                  tone={feature.tone ?? 'panel'}
                  eyebrow={feature.layout ?? 'split'}
                  title={feature.title}
                  className={`feature-panel feature-layout-${feature.layout ?? 'split'}`}
                >
                  <div className="feature-panel-head">
                    <div className="feature-icon">
                      <Icon className="w-5 h-5" strokeWidth={1.6} />
                    </div>
                    <div>
                      <p className="feature-summary">{feature.summary}</p>
                      <p className="feature-detail">{feature.detail}</p>
                    </div>
                  </div>
                  <div className="feature-panel-foot">
                    {body}
                    {feature.proof ? <p className="feature-proof">{feature.proof}</p> : null}
                  </div>
                </PanelFrame>
              </StaggerItem>
            )
          })}
        </StaggerContainer>
      </div>
    </section>
  )
}
