'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { TrackedLink } from '@/components/TrackedLink'
import { withBasePath } from '@/lib/base-path'

const NAV_LINKS = [
  { href: '/', label: 'Home' },
  { href: '/extension', label: 'Extension' },
  { href: '/explorer', label: 'Explorer' },
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
      className={`fixed top-0 inset-x-0 z-50 transition-all duration-300 ${
        scrolled || !isHome
          ? 'bg-white/95 backdrop-blur-md shadow-sm border-b border-slate-200/80'
          : 'bg-transparent border-b border-transparent'
      }`}
    >
      <div className="section-inner h-16 flex items-center justify-between">

        {/* Brand */}
        <Link
          href={withBasePath('/')}
          className={`font-sora font-extrabold text-xl tracking-tight transition-colors ${
            onDark ? 'text-white' : 'text-slate-900'
          }`}
        >
          Vax<span className={onDark ? 'text-blue-400' : 'text-blue-600'}>Link</span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-1">
          {NAV_LINKS.map(({ href, label }) => (
            <Link
              key={href}
              href={withBasePath(href)}
              className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${
                onDark
                  ? 'text-white/70 hover:text-white hover:bg-white/10'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
              }`}
            >
              {label}
            </Link>
          ))}
          <TrackedLink
            href={withBasePath('/extension#install')}
            event={{ name: 'cta_click', target: 'install' }}
            className={`ml-1 text-sm font-semibold px-4 py-2 rounded-full transition-all ${
              onDark
                ? 'text-white/90 border border-white/20 hover:bg-white/10'
                : 'text-blue-700 border border-blue-200 hover:bg-blue-50'
            }`}
          >
            Install Extension
          </TrackedLink>
          <TrackedLink
            href={withBasePath('/explorer')}
            event={{ name: 'cta_click', target: 'explorer' }}
            className="ml-2 text-sm font-semibold px-4 py-2 rounded-full text-white transition-all hover:opacity-90 hover:shadow-md"
            style={{ background: 'linear-gradient(135deg, #3b82f6, var(--accent))' }}
          >
            Open Explorer →
          </TrackedLink>
        </nav>

        <button
          className={`md:hidden p-2 rounded-lg transition-colors ${
            onDark ? 'text-white hover:bg-white/10' : 'text-slate-700 hover:bg-slate-100'
          }`}
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
        <div className="md:hidden bg-white border-t border-slate-100 px-6 py-5 flex flex-col gap-3 shadow-lg">
          {NAV_LINKS.map(({ href, label }) => (
            <Link
              key={href}
              href={withBasePath(href)}
              onClick={() => setOpen(false)}
              className="text-sm font-medium text-slate-700 hover:text-slate-900 py-1"
            >
              {label}
            </Link>
          ))}
          <TrackedLink
            href={withBasePath('/extension#install')}
            event={{ name: 'cta_click', target: 'install' }}
            onClick={() => setOpen(false)}
            className="mt-2 inline-flex items-center justify-center rounded-full border border-blue-200 px-4 py-2 text-sm font-semibold text-blue-700"
          >
            Install Extension
          </TrackedLink>
          <TrackedLink
            href={withBasePath('/explorer')}
            event={{ name: 'cta_click', target: 'explorer' }}
            onClick={() => setOpen(false)}
            className="inline-flex items-center justify-center rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            Open Explorer
          </TrackedLink>
        </div>
      )}
    </header>
  )
}
