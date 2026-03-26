import { clinicBenefits } from '@/content/site'
import { SectionHeader } from '@/components/SectionHeader'
import { StaggerContainer, StaggerItem } from '@/components/ui/motion'

export function WhyClinicsSection() {
  return (
    <section className="py-24 bg-white">
      <div className="section-inner">
        <SectionHeader
          eyebrow="Why Clinics Use It"
          title="Built for documentation speed, not just barcode demos"
          body="VaxLink is designed around the moments where immunization teams lose time: manual entry, lot verification, and switching between source references and chart fields."
        />
        <StaggerContainer className="grid grid-cols-1 md:grid-cols-3 gap-5" stagger={0.08}>
          {clinicBenefits.map((benefit) => (
            <StaggerItem key={benefit.title}>
              <article className="benefit-card">
                <h3>{benefit.title}</h3>
                <p>{benefit.body}</p>
              </article>
            </StaggerItem>
          ))}
        </StaggerContainer>
      </div>
    </section>
  )
}
