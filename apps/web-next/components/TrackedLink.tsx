'use client'

import Link, { type LinkProps } from 'next/link'
import type { CSSProperties, MouseEventHandler, ReactNode } from 'react'
import { trackSiteEvent, type SiteEvent } from '@/lib/analytics'

type Props = LinkProps & {
  children: ReactNode
  className?: string
  style?: CSSProperties
  event?: SiteEvent
  target?: string
  rel?: string
  ariaLabel?: string
  onClick?: MouseEventHandler<HTMLAnchorElement>
}

export function TrackedLink({
  children,
  event,
  ariaLabel,
  onClick,
  ...props
}: Props) {
  return (
    <Link
      {...props}
      aria-label={ariaLabel}
      onClick={(e) => {
        if (event) {
          trackSiteEvent(event)
        }
        onClick?.(e)
      }}
    >
      {children}
    </Link>
  )
}
