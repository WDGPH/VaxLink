import { modeCards, type ModeCard } from '@/content/site'
import { TrackedLink } from '@/components/TrackedLink'
import { withBasePath } from '@/lib/base-path'
import type { SiteEvent } from '@/lib/analytics'

function eventFor(card: ModeCard): SiteEvent {
  return card.slug === 'extension'
    ? { name: 'cta_click', target: 'install' }
    : { name: 'cta_click', target: 'extension' }
}

export function ModeSwitcher() {
  return (
    <div className="mode-switcher">
      {modeCards.map((card) => (
        <article key={card.slug} className={`mode-card mode-card-${card.tone}`}>
          <div className="mode-card-head">
            <p className="panel-eyebrow">{card.label}</p>
            <h3 className="mode-card-title">{card.title}</h3>
            <p className="mode-card-body">{card.description}</p>
          </div>
          <ul className="mode-card-list">
            {card.bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
          <TrackedLink
            href={withBasePath(card.href)}
            event={eventFor(card)}
            className="mode-card-cta"
          >
            {card.cta}
          </TrackedLink>
        </article>
      ))}
    </div>
  )
}
