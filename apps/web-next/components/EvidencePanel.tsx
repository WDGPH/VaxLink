import Image from 'next/image'
import type { EvidenceItem } from '@/content/site'

export function EvidencePanel({
  item,
  className,
}: {
  item: EvidenceItem
  className?: string
}) {
  return (
    <figure className={`evidence-panel evidence-${item.variant}${className ? ` ${className}` : ''}`}>
      <div className="evidence-tag">{item.variant}</div>
      <Image
        src={item.asset}
        alt={item.alt}
        width={720}
        height={480}
        className="evidence-image"
      />
      <figcaption className="evidence-copy">
        <h3>{item.title}</h3>
        <p>{item.caption}</p>
      </figcaption>
    </figure>
  )
}
