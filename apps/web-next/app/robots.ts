import type { MetadataRoute } from 'next'
import { siteConfig } from '@/content/site'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/' }],
    sitemap: `${siteConfig.baseUrl}${siteConfig.basePath}/sitemap.xml`,
  }
}
