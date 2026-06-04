/** @type {import('next').NextConfig} */

// When running behind a reverse proxy (e.g. JupyterHub server-proxy),
// set BASE_PATH so browser-facing asset URLs resolve correctly after the
// proxy strips the prefix before forwarding.
//
// Notebook workspaces usually expose VSCODE_PROXY_URI or NB_PREFIX, so
// prefer those as automatic fallbacks when BASE_PATH is not set manually.
//
// GitHub Pages builds set PAGES_BASE_PATH in CI and enable static export.
// Example: BASE_PATH=/notebook/analytics/vaxlink/proxy/3000 npm run notebook
function trimTrailingSlash(value = '') {
  return value.replace(/\/+$/, '')
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) {
      return value
    }
  }

  return undefined
}

function resolveBasePath() {
  const explicitBasePath = firstDefined(
    process.env.PAGES_BASE_PATH,
    process.env.BASE_PATH,
    process.env.NEXT_PUBLIC_BASE_PATH
  )

  // Preserve an explicitly empty Pages base path so GitHub Pages root deploys
  // do not fall back to notebook-only proxy settings from local env files.
  if (explicitBasePath !== undefined) {
    return trimTrailingSlash(explicitBasePath)
  }

  // The app scripts pin Next.js to port 3000. Workspace PORT often points to
  // the outer notebook service instead, so do not use it for proxy paths.
  const proxyPort = process.env.BASE_PATH_PORT || '3000'
  const proxyUri = process.env.VSCODE_PROXY_URI

  if (proxyUri) {
    try {
      const resolvedProxyUri = proxyUri.replace(/\{\{port\}\}/g, proxyPort)
      return trimTrailingSlash(new URL(resolvedProxyUri).pathname)
    } catch {
      // Ignore malformed proxy URIs and continue to other fallbacks.
    }
  }

  const nbPrefix = trimTrailingSlash(process.env.NB_PREFIX || '')

  if (nbPrefix && nbPrefix !== '/') {
    return `${nbPrefix}/proxy/${proxyPort}`
  }

  return ''
}

const basePath = resolveBasePath()
const isStaticExport = process.env.BUILD_STATIC_EXPORT === 'true'

const nextConfig = {
  assetPrefix: basePath || undefined,
  trailingSlash: true,
  output: isStaticExport ? 'export' : undefined,
  images: {
    unoptimized: true,
  },
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
}

module.exports = nextConfig
