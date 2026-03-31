import { SectionRail } from '@/components/SectionRail'

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
  return <SectionRail eyebrow={eyebrow} title={title} body={body} align={align} />
}
