const basePath = process.env.BASE_PATH || ''

export function withBasePath(path: string) {
  if (!basePath) {
    return path
  }

  if (!path || path === '/') {
    return `${basePath}/`
  }

  if (path.startsWith('#')) {
    return `${basePath}/${path}`
  }

  return `${basePath}${path.startsWith('/') ? path : `/${path}`}`
}
