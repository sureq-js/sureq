import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

import { loadDocsManifest } from './src/lib/load-docs'

const virtualId = 'virtual:sureq-docs'
const resolvedId = '\0virtual:sureq-docs'

const DOCS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../user-docs',
)

async function buildVirtualModule() {
  const manifest = await loadDocsManifest()
  const pagesJson = JSON.stringify(
    manifest.pages.map((p) => ({
      sourceFile: p.sourceFile,
      routePath: p.routePath,
      title: p.title,
      description: p.description,
      content: p.content,
      codeBlocks: p.codeBlocks,
      sections: p.sections,
      groupKey: p.groupKey,
      navTitle: p.navTitle,
    })),
  )

  return `
    import FlexSearch from 'flexsearch';
    import { resolveDocHrefWithMaps } from '@/lib/resolve-href';

    const pages = ${pagesJson};
    const navigation = ${JSON.stringify(manifest.navigation)};
    const allSections = ${JSON.stringify(manifest.allSections)};
    const searchEntries = ${JSON.stringify(manifest.searchEntries)};
    const byRoute = new Map(pages.map((p) => [p.routePath, p]));
    const bySource = new Map(pages.map((p) => [p.sourceFile, p]));

    export { navigation, allSections, pages };

    export function getPageByPath(pathname) {
      const normalized = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
      return byRoute.get(normalized);
    }

    export function resolveDocHref(fromFile, href) {
      return resolveDocHrefWithMaps(bySource, fromFile, href);
    }

    const sectionIndex = new FlexSearch.Document({
      tokenize: 'full',
      document: {
        id: 'url',
        index: 'content',
        store: ['title', 'pageTitle'],
      },
      context: { resolution: 9, depth: 2, bidirectional: true },
    });

    for (const entry of searchEntries) {
      sectionIndex.add({
        url: entry.url,
        title: entry.title,
        content: entry.content,
        pageTitle: entry.pageTitle,
      });
    }

    export function search(query, options = {}) {
      const result = sectionIndex.search(query, { ...options, enrich: true });
      if (result.length === 0) return [];
      return result[0].result.map((item) => ({
        url: item.id,
        title: item.doc.title,
        pageTitle: item.doc.pageTitle,
      }));
    }
  `
}

export function sureqDocsPlugin(): Plugin {
  return {
    name: 'sureq-docs',
    resolveId(id) {
      if (id === virtualId) {
        return resolvedId
      }
    },
    async load(id) {
      if (id === resolvedId) {
        return buildVirtualModule()
      }
    },
    configureServer(server) {
      if (fs.existsSync(DOCS_ROOT)) {
        server.watcher.add(DOCS_ROOT)
      }
      const reload = () => {
        const mod = server.moduleGraph.getModuleById(resolvedId)
        if (mod) {
          server.moduleGraph.invalidateModule(mod)
        }
      }
      server.watcher.on('change', (file) => {
        if (file.startsWith(DOCS_ROOT)) {
          reload()
        }
      })
    },
  }
}