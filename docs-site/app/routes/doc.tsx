import { DocRoute } from '@/components/DocRoute'
import { canonicalUrl, FALLBACK_DESCRIPTION, SITE } from '@/lib/page-meta.mjs'
import { getPageByPath } from 'virtual:sureq-docs'

export default function Doc() {
  return <DocRoute />
}

const HOME_TITLE = 'SureQ: TypeScript job queue for Node.js'

export function meta({ location }: { location: { pathname: string } }) {
  const page = getPageByPath(location.pathname)
  if (!page) {
    return [
      { title: 'Not Found - SureQ' },
      { name: 'robots', content: 'noindex' },
    ]
  }
  const title = page.routePath === '/' ? HOME_TITLE : `${page.title} - SureQ`
  const description = page.description || FALLBACK_DESCRIPTION
  const url = canonicalUrl(page.routePath)
  const image = `${SITE}/icon-512.png`
  return [
    { title },
    { name: 'description', content: description },
    { tagName: 'link', rel: 'canonical', href: url },
    { property: 'og:type', content: page.routePath === '/' ? 'website' : 'article' },
    { property: 'og:site_name', content: 'SureQ' },
    { property: 'og:title', content: title },
    { property: 'og:description', content: description },
    { property: 'og:url', content: url },
    { property: 'og:image', content: image },
    { name: 'twitter:card', content: 'summary' },
    { name: 'twitter:title', content: title },
    { name: 'twitter:description', content: description },
    { name: 'twitter:image', content: image },
  ]
}
