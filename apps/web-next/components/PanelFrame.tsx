import type { ReactNode } from 'react'
import type { VisualTone } from '@/content/site'

export function PanelFrame({
  children,
  title,
  eyebrow,
  tone = 'panel',
  className,
}: {
  children: ReactNode
  title?: string
  eyebrow?: string
  tone?: VisualTone
  className?: string
}) {
  return (
    <section className={`panel-frame panel-tone-${tone}${className ? ` ${className}` : ''}`}>
      {eyebrow || title ? (
        <header className="panel-frame-head">
          {eyebrow ? <p className="panel-eyebrow">{eyebrow}</p> : null}
          {title ? <h3 className="panel-title">{title}</h3> : null}
        </header>
      ) : null}
      <div className="panel-frame-body">{children}</div>
    </section>
  )
}
