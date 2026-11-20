// Writes the files crawlers and AI tools read into the built site: sitemap.xml, llms.txt, llms-full.txt
// (https://llmstxt.org) and a raw .md copy of every page.
// Run after `react-router build`: node scripts/build-extras.mjs [outDir]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { SITE, canonicalUrl, pageSummary } from '../src/lib/page-meta.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DOCS_ROOT = path.resolve(here, '../../user-docs')
const OUT_DIR = path.resolve(here, '..', process.argv[2] ?? 'build/client')

const GROUP_TITLES = {
  'getting-started': 'Getting started',
  guides: 'Guides',
  reference: 'Reference',
  stores: 'Stores',
  operations: 'Operations',
}

const strip = (segment) => segment.replace(/^\d+-/, '')

// user-docs/02-guides/05-schedules.md -> guides/schedules.md ; README.md -> index.md
function mdPath(sourceFile) {
  if (sourceFile === 'README.md') return 'index.md'
  return sourceFile.split('/').map(strip).join('/')
}

function listDocs(dir, prefix = '') {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) return listDocs(path.join(dir, entry.name), rel)
      return entry.name.endsWith('.md') ? [rel] : []
    })
}

function title(markdown) {
  return markdown.match(/^#\s+(.+)$/m)?.[1].trim() ?? 'Untitled'
}

// The site route of a doc, as load-docs.ts computes it: README.md -> '/', 02-guides/05-schedules.md -> '/guides/schedules'.
function routePath(sourceFile) {
  if (sourceFile === 'README.md') return '/'
  return `/${sourceFile.replace(/\.md$/, '').split('/').map(strip).join('/')}`
}

// The date of the last commit that touched the doc (YYYY-MM-DD), or undefined outside a git checkout.
// CI must check out with enough history for this to be the real date; a shallow clone gives the newest commit's date.
function lastModified(sourceFile) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', sourceFile], {
      cwd: DOCS_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out || undefined
  } catch {
    return undefined
  }
}

// Point relative links to other docs at their published .md copies.
function absoluteLinks(markdown, sourceFile) {
  return markdown.replace(/\]\((?!https?:|#|mailto:)([^)\s]+?\.md)(#[^)\s]*)?\)/g, (match, target, hash = '') => {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), target))
    if (resolved.startsWith('..')) return match
    return `](${SITE}/${mdPath(resolved)}${hash})`
  })
}

const pages = listDocs(DOCS_ROOT).map((sourceFile) => {
  const raw = fs.readFileSync(path.join(DOCS_ROOT, sourceFile), 'utf8')
  const content = absoluteLinks(raw, sourceFile).trimEnd() + '\n'
  return { sourceFile, content, title: title(raw), summary: pageSummary(raw), url: `${SITE}/${mdPath(sourceFile)}` }
})

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...pages.map((p) => {
    const lastmod = lastModified(p.sourceFile)
    return `  <url><loc>${escapeXml(canonicalUrl(routePath(p.sourceFile)))}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`
  }),
  '</urlset>',
  '',
].join('\n')
fs.writeFileSync(path.join(OUT_DIR, 'sitemap.xml'), sitemap)

for (const page of pages) {
  const file = path.join(OUT_DIR, mdPath(page.sourceFile))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, page.content)
}

const intro = pages.find((p) => p.sourceFile === 'README.md')
const index = [
  '# SureQ',
  '',
  `> ${intro.summary}`,
  '',
  'Install with `npm install @sureq/core` (Node 22 or newer, ESM and CommonJS). Every page below is plain Markdown;',
  `the whole documentation in one file is ${SITE}/llms-full.txt.`,
  '',
]
for (const [key, groupTitle] of Object.entries(GROUP_TITLES)) {
  const group = pages.filter((p) => strip(p.sourceFile.split('/')[0]) === key)
  if (!group.length) continue
  index.push(`## ${groupTitle}`, '')
  for (const p of group) index.push(`- [${p.title}](${p.url})${p.summary ? `: ${p.summary}` : ''}`)
  index.push('')
}
index.push(
  '## Optional',
  '',
  '- [npm: @sureq/core](https://www.npmjs.com/package/@sureq/core): the package, its README and versions',
  '- [Source on GitHub](https://github.com/sureq-js/sureq): code, CHANGELOG and issues',
  '',
)
fs.writeFileSync(path.join(OUT_DIR, 'llms.txt'), index.join('\n'))

const full = pages.map((p) => `<!-- ${p.url} -->\n\n${p.content}`).join('\n---\n\n')
fs.writeFileSync(path.join(OUT_DIR, 'llms-full.txt'), full)

console.log(`sitemap.xml, llms.txt: ${pages.length} pages written to ${path.relative(process.cwd(), OUT_DIR) || '.'}`)
