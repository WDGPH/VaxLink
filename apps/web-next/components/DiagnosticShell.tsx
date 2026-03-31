import type { ReactNode } from 'react'

export function DiagnosticShell({
  label,
  title,
  aside,
  children,
  className,
}: {
  label: string
  title: string
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`diagnostic-shell${className ? ` ${className}` : ''}`}>
      <header className="diagnostic-shell-head">
        <div>
          <p className="panel-eyebrow">{label}</p>
          <h2 className="diagnostic-shell-title">{title}</h2>
        </div>
        {aside ? <div className="diagnostic-shell-aside">{aside}</div> : null}
      </header>
      <div className="diagnostic-shell-body">{children}</div>
    </section>
  )
}
