import type { MetadataRoute } from 'next'
import { siteConfig } from '@/content/site'

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ['/', '/extension']

  return routes.map((path) => ({
    url: `${siteConfig.baseUrl}${siteConfig.basePath}${path === '/' ? '/' : path}`,
    lastModified: new Date(),
  }))
}
