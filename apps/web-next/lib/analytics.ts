export type SiteEvent =
  | { name: 'cta_click'; target: 'explorer' | 'extension' | 'install' }
  | { name: 'explorer_load_remote' }
  | { name: 'explorer_load_local' }
  | { name: 'barcode_parse' }

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void
    dataLayer?: unknown[]
  }
}

export function trackSiteEvent(event: SiteEvent) {
  if (typeof window === 'undefined') {
    return
  }

  window.dispatchEvent(new CustomEvent('vaxlink:analytics', { detail: event }))

  if (typeof window.gtag === 'function') {
    window.gtag('event', event.name, event)
  }
}
