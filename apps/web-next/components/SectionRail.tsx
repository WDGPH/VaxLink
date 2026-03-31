import { FadeIn } from '@/components/ui/motion'

export function SectionRail({
  eyebrow,
  title,
  body,
  align = 'left',
  className,
}: {
  eyebrow: string
  title: string
  body?: string
  align?: 'left' | 'center'
  className?: string
}) {
  return (
    <FadeIn>
      <div className={`section-rail ${align === 'center' ? 'section-rail-center' : ''}${className ? ` ${className}` : ''}`}>
        <div className="section-rail-line" />
        <div className="section-rail-copy">
          <p className="section-eyebrow">{eyebrow}</p>
          <h2 className="section-title">{title}</h2>
          {body ? <p className="section-body">{body}</p> : null}
        </div>
      </div>
    </FadeIn>
  )
}
