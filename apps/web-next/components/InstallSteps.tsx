import { installChecklist, installSteps } from '@/content/site'

export function InstallSteps() {
  return (
    <div className="install-grid">
      <div className="install-steps">
        {installSteps.map((step) => (
          <article key={step.n} className="install-card">
            <div className="step-badge">{step.n}</div>
            <h3>{step.title}</h3>
            <p>{step.detail}</p>
            <code>{step.code}</code>
          </article>
        ))}
      </div>
      <aside className="checklist-card">
        <p className="section-eyebrow">Validation Checklist</p>
        <h3>Confirm the install before documenting live charts</h3>
        <ul>
          {installChecklist.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </aside>
    </div>
  )
}
