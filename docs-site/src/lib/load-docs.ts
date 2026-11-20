import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { slugifyWithCounter } from '@sindresorhus/slugify'
import glob from 'fast-glob'
import { toString } from 'mdast-util-to-string'
import { remark } from 'remark'
import remarkGfm from 'remark-gfm'
import {
  getHighlighter,
  renderToHtml,
  type Highlighter,
  type Lang,
} from 'shiki'
import { SKIP, visit } from 'unist-util-visit'

import type { Section } from '@/components/SectionProvider'
import { pageDescription } from './page-meta.mjs'
import { resolveDocHrefWithMaps } from './resolve-href.js'

const DOCS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../user-docs',
)

export interface CodeBlock {
  code: string
  language: string
  html: string
  /** Set by a `diagram=<name>` fence attribute; the site draws that diagram instead. */
  diagram?: string
}

export interface DocPage {
  sourceFile: string
  routePath: string
  title: string
  /** Meta description: the first paragraph, cut near 160 characters. */
  description: string
  content: string
  codeBlocks: Record<string, CodeBlock>
  sections: Section[]
  groupKey: string
  groupTitle: string
  sortKey: string
  navTitle: string
}

export interface NavLink {
  title: string
  href: string
}

export interface NavGroup {
  title: string
  links: NavLink[]
}

export interface SearchIndexEntry {
  url: string
  title: string
  content: string
  pageTitle?: string
}

const GROUP_TITLES: Record<string, string> = {
  'getting-started': 'Getting started',
  guides: 'Guides',
  reference: 'Reference',
  stores: 'Stores',
  operations: 'Operations',
}

function stripNumericPrefix(segment: string): string {
  return segment.replace(/^\d+-/, '')
}

function fileToRoute(sourceFile: string): string {
  if (sourceFile === 'README.md') {
    return '/'
  }
  const withoutExt = sourceFile.replace(/\.md$/, '')
  const segments = withoutExt.split('/').map(stripNumericPrefix)
  return `/${segments.join('/')}`
}

function extractTitle(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : 'Untitled'
}

function extractH2Sections(markdown: string): Section[] {
  const slugify = slugifyWithCounter()
  const sections: Section[] = []
  for (const line of markdown.split('\n')) {
    const match = line.match(/^##\s+(.+)$/)
    if (match) {
      const title = match[1].trim()
      sections.push({ id: slugify(title), title })
    }
  }
  return sections
}

function extractSearchSections(
  markdown: string,
): Array<[string, string | null, string[]]> {
  const slugify = slugifyWithCounter()
  const sections: Array<[string, string | null, string[]]> = []

  function plugin() {
    return (tree: { type: string }) => {
      slugify.reset()
      visit(tree, (node) => {
        if (node.type === 'heading' || node.type === 'paragraph') {
          const content = toString(node as Parameters<typeof toString>[0])
          if (
            node.type === 'heading' &&
            'depth' in node &&
            typeof node.depth === 'number' &&
            node.depth <= 2
          ) {
            const hash = node.depth === 1 ? null : slugify(content)
            sections.push([content, hash, []])
          } else {
            sections.at(-1)?.[2].push(content)
          }
          return SKIP
        }
      })
    }
  }

  const processor = remark().use(remarkGfm).use(plugin)
  const vfile = { value: markdown }
  processor.runSync(processor.parse(vfile), vfile)
  return sections
}

function groupForFile(sourceFile: string): {
  groupKey: string
  groupTitle: string
} {
  if (sourceFile === 'README.md') {
    return { groupKey: 'getting-started', groupTitle: 'Getting started' }
  }
  const folder = sourceFile.split('/')[0]
  const groupKey = stripNumericPrefix(folder)
  return {
    groupKey,
    groupTitle: GROUP_TITLES[groupKey] ?? groupKey,
  }
}

function navTitleFromPage(page: DocPage): string {
  if (page.routePath === '/') {
    return 'Introduction'
  }
  return page.title
}

const LANGUAGE_ALIASES: Record<string, Lang | 'text'> = {
  js: 'javascript',
  ts: 'typescript',
  sh: 'bash',
  shell: 'bash',
  txt: 'text',
  plaintext: 'text',
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function highlightCode(highlighter: Highlighter, code: string, language: string) {
  let lang = (LANGUAGE_ALIASES[language] ?? language) as Lang | 'text'
  if (lang === 'text' || !highlighter.getLoadedLanguages().includes(lang)) {
    return code
      .split('\n')
      .map((line) => `<span>${escapeHtml(line)}</span>`)
      .join('\n')
  }
  // Same markup as the Protocol template's rehype plugin: one span per line,
  // no wrapping pre/code (the Code component supplies those).
  let tokens = highlighter.codeToThemedTokens(code, lang)
  return renderToHtml(tokens, {
    elements: {
      pre: ({ children }) => children,
      code: ({ children }) => children,
      line: ({ children }) => `<span>${children}</span>`,
    },
  })
}

/** Highlights every fenced block, keyed by its exact source text. */
function highlightCodeBlocks(highlighter: Highlighter, markdown: string) {
  let codeBlocks: Record<string, CodeBlock> = {}
  let tree = remark().use(remarkGfm).parse(markdown)
  visit(tree, 'code', (node) => {
    let language = node.lang ?? ''
    let diagram = node.meta?.match(/(?:^|\s)diagram=([\w-]+)/)?.[1]
    codeBlocks[node.value] = {
      code: node.value,
      language,
      html: highlightCode(highlighter, node.value, language),
      ...(diagram ? { diagram } : {}),
    }
  })
  return codeBlocks
}

export async function loadDocsManifest() {
  const highlighter = await getHighlighter({
    theme: 'css-variables',
    langs: ['typescript', 'javascript', 'json', 'bash', 'sql'],
  })
  const files = glob.sync('**/*.md', { cwd: DOCS_ROOT }).sort()
  const pages: DocPage[] = []
  const byRoute = new Map<string, DocPage>()
  const bySource = new Map<string, DocPage>()
  const allSections: Record<string, Section[]> = {}
  const searchEntries: SearchIndexEntry[] = []

  for (const sourceFile of files) {
    const raw = fs.readFileSync(path.join(DOCS_ROOT, sourceFile), 'utf8')
    const codeBlocks = highlightCodeBlocks(highlighter, raw)
    const routePath = fileToRoute(sourceFile)
    const { groupKey, groupTitle } = groupForFile(sourceFile)
    const title = extractTitle(raw)
    const sections = extractH2Sections(raw)

    const page: DocPage = {
      sourceFile,
      routePath,
      title,
      description: pageDescription(raw),
      content: raw,
      codeBlocks,
      sections,
      groupKey,
      groupTitle,
      // The README is the introduction, so it leads the first group.
      sortKey: sourceFile === 'README.md' ? '' : sourceFile,
      navTitle: '',
    }
    page.navTitle = navTitleFromPage(page)

    pages.push(page)
    byRoute.set(routePath, page)
    bySource.set(sourceFile, page)
    allSections[routePath] = sections

    const docTitle = routePath === '/' ? 'SureQ documentation' : title
    for (const [heading, hash, body] of extractSearchSections(raw)) {
      searchEntries.push({
        url: routePath + (hash ? `#${hash}` : ''),
        title: heading,
        content: [heading, ...body].join('\n'),
        pageTitle: hash ? docTitle : undefined,
      })
    }
  }

  pages.sort((a, b) => a.sortKey.localeCompare(b.sortKey))

  const groupOrder = [
    'getting-started',
    'guides',
    'reference',
    'stores',
    'operations',
  ]

  const navigation: NavGroup[] = []
  for (const groupKey of groupOrder) {
    const groupPages = pages.filter((p) => p.groupKey === groupKey)
    if (groupPages.length === 0) {
      continue
    }
    const groupTitle = groupPages[0].groupTitle
    navigation.push({
      title: groupTitle,
      links: groupPages.map((p) => ({
        title: p.navTitle,
        href: p.routePath,
      })),
    })
  }

  const routes = pages.map((p) => p.routePath)

  return {
    pages,
    byRoute,
    bySource,
    navigation,
    allSections,
    searchEntries,
    routes,
    getPageByPath(pathname: string) {
      const normalized =
        pathname.length > 1 && pathname.endsWith('/')
          ? pathname.slice(0, -1)
          : pathname
      return byRoute.get(normalized)
    },
    resolveDocHref(fromFile: string, href: string) {
      return resolveDocHrefWithMaps(bySource, fromFile, href)
    },
  }
}