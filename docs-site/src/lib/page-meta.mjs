// Shared by the site (load-docs.ts) and the post-build script (scripts/build-extras.mjs), so page descriptions,
// llms.txt summaries and sitemap URLs never drift apart. Plain JS: the script runs on Node without a bundler.

/** The published site, without a trailing slash. */
export const SITE = 'https://sureq-js.github.io/sureq'

/** Shown for a page whose first paragraph is missing or too short to describe it. */
export const FALLBACK_DESCRIPTION =
  'SureQ is a TypeScript job queue for Node.js: typed jobs, retries with backoff, priorities, delayed jobs, schedules, dead letters and pluggable stores.'

/**
 * The first paragraph after the page title, as one line of plain text (links reduced to their text, code marks
 * dropped). Empty when the page opens with a list, table, code block or heading instead.
 * @param {string} markdown
 * @returns {string}
 */
export function pageSummary(markdown) {
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

/**
 * A meta description: the summary without code marks, cut at a word near 160 characters, or the fallback.
 * @param {string} markdown
 * @returns {string}
 */
export function pageDescription(markdown) {
  const text = pageSummary(markdown).replace(/`/g, '')
  if (text.length < 40) return FALLBACK_DESCRIPTION
  if (text.length <= 160) return text
  const cut = text.slice(0, 157)
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`
}

/**
 * The canonical URL of a site route ('/' or '/guides/schedules'). GitHub Pages redirects a page to its
 * trailing-slash form, so that form is canonical.
 * @param {string} routePath
 * @returns {string}
 */
export function canonicalUrl(routePath) {
  return routePath === '/' ? `${SITE}/` : `${SITE}${routePath}/`
}
