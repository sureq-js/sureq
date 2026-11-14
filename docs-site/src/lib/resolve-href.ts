import type { DocPage } from '@/lib/load-docs'

function posixDirname(file: string): string {
  const index = file.lastIndexOf('/')
  return index === -1 ? '' : file.slice(0, index)
}

function posixJoin(...parts: string[]): string {
  const segments: string[] = []
  for (const part of parts) {
    for (const segment of part.split('/')) {
      if (!segment || segment === '.') {
        continue
      }
      if (segment === '..') {
        segments.pop()
      } else {
        segments.push(segment)
      }
    }
  }
  return segments.join('/')
}

export function resolveDocHrefWithMaps(
  bySource: Map<string, Pick<DocPage, 'routePath' | 'sourceFile'>>,
  fromFile: string,
  href: string,
): string {
  if (
    !href ||
    href.startsWith('http://') ||
    href.startsWith('https://') ||
    href.startsWith('mailto:')
  ) {
    return href
  }

  const [linkPath, hash = ''] = href.split('#', 2)
  if (linkPath === '' || linkPath === '#') {
    return hash ? `#${hash}` : href
  }

  if (linkPath.startsWith('/')) {
    const normalized = linkPath.replace(/^\//, '')
    const direct = bySource.get(`${normalized}.md`)
    if (direct) {
      return direct.routePath + (hash ? `#${hash}` : '')
    }
    const asReadme = bySource.get(posixJoin(normalized, 'README.md'))
    if (asReadme) {
      return asReadme.routePath + (hash ? `#${hash}` : '')
    }
    return href
  }

  const fromDir = posixDirname(fromFile)
  const target = posixJoin(fromDir, linkPath)
  const page = bySource.get(target)
  if (!page) {
    return href
  }
  return page.routePath + (hash ? `#${hash}` : '')
}