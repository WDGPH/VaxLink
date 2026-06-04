export const basePath =
  process.env.NEXT_PUBLIC_BASE_PATH ??
  process.env.PAGES_BASE_PATH ??
  process.env.BASE_PATH ??
  ''

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
