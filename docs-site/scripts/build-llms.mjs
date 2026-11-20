// Writes llms.txt, llms-full.txt and a raw .md copy of every page into the built site (https://llmstxt.org).
// Run after `react-router build`: node scripts/build-llms.mjs [outDir]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DOCS_ROOT = path.resolve(here, '../../user-docs')
const OUT_DIR = path.resolve(here, '..', process.argv[2] ?? 'build/client')
const SITE = 'https://sureq-js.github.io/sureq'

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

// The first paragraph after the title, as one line.
function summary(markdown) {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => /^#\s/.test(l)) + 1
  const para = []
  for (const line of lines.slice(start)) {
    if (!line.trim()) {
      if (para.length) break
      continue
    }
    if (/^(#|```|\||[-*] |\d+\. |>)/.test(line)) break
    para.push(line.trim())
  }
  return para.join(' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
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
  return { sourceFile, content, title: title(raw), summary: summary(raw), url: `${SITE}/${mdPath(sourceFile)}` }
})

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

console.log(`llms.txt: ${pages.length} pages written to ${path.relative(process.cwd(), OUT_DIR) || '.'}`)
