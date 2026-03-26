import { PanelFrame } from '@/components/PanelFrame'
import { workflowCards } from '@/content/site'
import { SectionHeader } from '@/components/SectionHeader'
import { StaggerContainer, StaggerItem } from '@/components/ui/motion'

export function WorkflowSection() {
  return (
    <section id="workflows" className="py-24" style={{ background: 'var(--bg)' }}>
      <div className="section-inner">
        <SectionHeader
          eyebrow="Use Cases"
          title="Three ways teams can move through the product"
          body="The extension handles chart entry. The explorer handles lookup. The structure below shows where those two modes meet."
        />

        <StaggerContainer className="workflow-rack" stagger={0.12}>
          <div className="workflow-track" />
          {workflowCards.map(({ title, steps, note }, index) => (
            <StaggerItem key={title}>
              <PanelFrame tone={index === 1 ? 'hero' : 'utility'} eyebrow={`Step 0${index + 1}`} title={title} className="workflow-card">
                <ul>
                  {steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ul>
                <div className="workflow-note">{note}</div>
              </PanelFrame>
            </StaggerItem>
          ))}
        </StaggerContainer>
      </div>
    </section>
  )
}
