import { DocRoute } from '@/components/DocRoute'
import { getPageByPath } from 'virtual:sureq-docs'

export default function Doc() {
  return <DocRoute />
}

export function meta({ location }: { location: { pathname: string } }) {
  const page = getPageByPath(location.pathname)
  if (!page) {
    return [{ title: 'Not Found - SureQ' }]
  }
  if (page.routePath === '/') {
    return [
      {
        title: 'SureQ',
        description:
          'SureQ is a job queue for Node.js, written in TypeScript.',
      },
    ]
  }
  return [{ title: `${page.title} - SureQ` }]
}