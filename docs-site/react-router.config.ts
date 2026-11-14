import type { Config } from '@react-router/dev/config'

import { loadDocsManifest } from './src/lib/load-docs'

export default {
  ssr: false,
  appDirectory: 'app',
  basename: '/sureq/',
  async prerender() {
    const { routes } = await loadDocsManifest()
    return routes
  },
} satisfies Config