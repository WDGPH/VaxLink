import { siteConfig } from '@/content/site'

export default function sitemap() {
  const routes = ['/', '/extension', '/explorer']

  return routes.map((path) => ({
    url: `${siteConfig.baseUrl}${siteConfig.basePath}${path === '/' ? '/' : path}`,
    lastModified: new Date(),
  }))
}
