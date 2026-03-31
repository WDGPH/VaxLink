import { clinicBenefits } from '@/content/site'
import { PanelFrame } from '@/components/PanelFrame'
import { SectionHeader } from '@/components/SectionHeader'
import { StaggerContainer, StaggerItem } from '@/components/ui/motion'

export function WhyClinicsSection() {
  const [lead, ...rest] = clinicBenefits

  return (
    <section className="py-24 bg-white">
      <div className="section-inner">
        <SectionHeader
          eyebrow="Why Clinics Use It"
          title="Built for documentation speed, not just barcode demos"
          body="VaxLink is designed around the moments where immunization teams lose time: manual entry, lot verification, and switching between source references and chart fields."
        />
        <StaggerContainer className="benefit-layout" stagger={0.08}>
          <StaggerItem key={lead.title} className="benefit-layout-lead">
            <PanelFrame tone="hero" eyebrow="Lead gain" title={lead.title} className="benefit-card benefit-card-lead">
              <p>{lead.body}</p>
            </PanelFrame>
          </StaggerItem>
          {rest.map((benefit, index) => (
            <StaggerItem key={benefit.title}>
              <PanelFrame
                tone={index === 0 ? 'panel' : 'reference'}
                eyebrow={index === 0 ? 'Input error' : 'Time saved'}
                title={benefit.title}
                className="benefit-card"
              >
                <p>{benefit.body}</p>
              </PanelFrame>
            </StaggerItem>
          ))}
        </StaggerContainer>
      </div>
    </section>
  )
}
