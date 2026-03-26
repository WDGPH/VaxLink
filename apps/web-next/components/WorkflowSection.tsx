import { workflowCards } from '@/content/site'
import { SectionHeader } from '@/components/SectionHeader'
import { StaggerContainer, StaggerItem } from '@/components/ui/motion'

export function WorkflowSection() {
  return (
    <section id="workflows" className="py-24" style={{ background: 'var(--bg)' }}>
      <div className="section-inner">
        <SectionHeader
          eyebrow="Supported Workflows"
          title="Three ways clinic teams can use VaxLink"
          body="The extension is the fastest path for documentation. The explorer is the verification surface when a barcode, lot, or workflow needs extra review."
        />

        <StaggerContainer className="grid grid-cols-1 lg:grid-cols-3 gap-6" stagger={0.12}>
          {workflowCards.map(({ title, steps, note }, index) => (
            <StaggerItem key={title}>
              <article className="workflow-card">
                <div className="workflow-badge">{`0${index + 1}`}</div>
                <h3>{title}</h3>
                <ul>
                  {steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ul>
                <div className="workflow-note">{note}</div>
              </article>
            </StaggerItem>
          ))}
        </StaggerContainer>
      </div>
    </section>
  )
}
