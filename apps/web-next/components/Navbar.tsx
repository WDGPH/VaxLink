'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { TrackedLink } from '@/components/TrackedLink'
import { withBasePath } from '@/lib/base-path'

const NAV_LINKS = [
  { href: '/', label: 'Home' },
  { href: '/extension', label: 'Extension' },
  { href: '/extension#compatibility', label: 'Compatibility' },
  { href: '/extension#install', label: 'Install' },
]

export function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const isHome = pathname === '/' || pathname === ''

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const onDark = !scrolled && isHome

  return (
    <header
      className={`fixed top-9 inset-x-0 z-50 transition-all duration-300 ${
        scrolled || !isHome
          ? 'nav-shell nav-shell-solid'
          : 'nav-shell nav-shell-ghost'
      }`}
    >
      <div className="section-inner nav-inner">
        <Link
          href={withBasePath('/')}
          className={`nav-brand ${onDark ? 'nav-brand-dark' : ''}`}
        >
          <span>Vax</span>
          <span>Link</span>
        </Link>

        <nav className="nav-mode-bar hidden md:flex">
          {NAV_LINKS.map(({ href, label }) => (
            <Link
              key={href}
              href={withBasePath(href)}
              className={`nav-mode-link ${onDark ? 'nav-mode-link-dark' : ''}`}
            >
              {label}
            </Link>
          ))}
        </nav>

        <div className="hidden md:flex items-center gap-2">
          <TrackedLink
            href={withBasePath('/extension')}
            event={{ name: 'cta_click', target: 'extension' }}
            className="nav-secondary-cta"
          >
            View Extension
          </TrackedLink>
          <TrackedLink
            href={withBasePath('/extension#install')}
            event={{ name: 'cta_click', target: 'install' }}
            className="nav-primary-cta"
          >
            Install Extension
          </TrackedLink>
        </div>

        <button
          className="md:hidden nav-mobile-toggle"
          onClick={() => setOpen(!open)}
          aria-label="Toggle menu"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
            {open ? (
              <path fillRule="evenodd" clipRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" />
            ) : (
              <path fillRule="evenodd" clipRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" />
            )}
          </svg>
        </button>
      </div>

        {/* Mobile drawer */}
      {open && (
        <div className="md:hidden nav-mobile-drawer">
          {NAV_LINKS.map(({ href, label }) => (
            <Link
              key={href}
              href={withBasePath(href)}
              onClick={() => setOpen(false)}
              className="nav-mobile-link"
            >
              {label}
            </Link>
          ))}
          <TrackedLink
            href={withBasePath('/extension')}
            event={{ name: 'cta_click', target: 'extension' }}
            onClick={() => setOpen(false)}
            className="nav-mobile-secondary"
          >
            View Extension
          </TrackedLink>
          <TrackedLink
            href={withBasePath('/extension#install')}
            event={{ name: 'cta_click', target: 'install' }}
            onClick={() => setOpen(false)}
            className="nav-mobile-primary"
          >
            Install Extension
          </TrackedLink>
        </div>
      )}
    </header>
  )
}
