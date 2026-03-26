import { FadeIn } from '@/components/ui/motion'

export function SectionHeader({
  eyebrow,
  title,
  body,
  align = 'left',
}: {
  eyebrow: string
  title: string
  body?: string
  align?: 'left' | 'center'
}) {
  return (
    <FadeIn>
      <div className={align === 'center' ? 'mx-auto max-w-3xl text-center mb-14' : 'max-w-2xl mb-14'}>
        <p className="section-eyebrow">{eyebrow}</p>
        <h2 className="section-title">{title}</h2>
        {body ? <p className="section-body">{body}</p> : null}
      </div>
    </FadeIn>
  )
}
