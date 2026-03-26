import { siteConfig } from '@/content/site'

export default function robots() {
  return {
    rules: [{ userAgent: '*', allow: '/' }],
    sitemap: `${siteConfig.baseUrl}${siteConfig.basePath}/sitemap.xml`,
  }
}
