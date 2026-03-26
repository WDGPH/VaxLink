/** @type {import('next').NextConfig} */

// When running behind a reverse proxy (e.g. JupyterHub server-proxy),
// Set BASE_PATH to the notebook proxy prefix so browser-facing asset URLs
// resolve correctly after the proxy strips the prefix before forwarding.
// Example: BASE_PATH=/notebook/analytics/vaxlink/proxy/3000 npm run notebook
const assetPrefix = process.env.BASE_PATH || ''

const nextConfig = {
  assetPrefix: assetPrefix || undefined,
  trailingSlash: true,
  // Uncomment for static export (GitHub Pages, etc.):
  // output: 'export',
}

module.exports = nextConfig
