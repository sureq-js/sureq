import { isValidElement } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeSlug from 'rehype-slug'
import remarkGfm from 'remark-gfm'

import { diagrams } from '@/components/diagrams'
import { FencedCode } from '@/components/FencedCode'
import { Heading } from '@/components/Heading'
import { Link } from '@/lib/link'
import type { CodeBlock } from '@/lib/load-docs'
import { resolveDocHref } from 'virtual:sureq-docs'

// Table cells with at most this many characters never wrap (see typography.ts).
const SHORT_CELL = 32

function textOf(children: React.ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children)
  }
  if (Array.isArray(children)) {
    return children.map((child) => textOf(child)).join('')
  }
  if (isValidElement(children)) {
    return textOf((children.props as { children?: React.ReactNode }).children)
  }
  return ''
}

function MarkdownLink({
  href,
  sourceFile,
  ...props
}: React.ComponentPropsWithoutRef<'a'> & { sourceFile: string }) {
  let resolved = href && !href.startsWith('#') ? resolveDocHref(sourceFile, href) : href

  // Links to other doc pages go through the router; everything else is a plain link.
  if (resolved && !/^[a-z]+:/i.test(resolved)) {
    return <Link href={resolved} {...props} />
  }

  return <a href={resolved} {...props} />
}

export function MarkdownDoc({
  content,
  sourceFile,
  codeBlocks,
  hideTitle = false,
}: {
  content: string
  sourceFile: string
  codeBlocks: Record<string, CodeBlock>
  hideTitle?: boolean
}) {
  let body = hideTitle ? content.replace(/^#\s+.+\n+/, '') : content

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSlug]}
      components={{
        h2: ({ node: _node, id, ...props }) => (
          <Heading level={2} id={id ?? ''} {...props} />
        ),
        h3: ({ node: _node, id, ...props }) => (
          <Heading level={3} id={id ?? ''} anchor={false} {...props} />
        ),
        a: ({ node: _node, ...props }) => (
          <MarkdownLink sourceFile={sourceFile} {...props} />
        ),
        pre: ({ node: _node, children, ...props }) => {
          // react-markdown keeps the fence's trailing newline; the AST value does not.
          let code = textOf(children).replace(/\n$/, '')
          let block = codeBlocks[code]
          let Diagram = block?.diagram ? diagrams[block.diagram] : undefined
          if (Diagram) {
            return <Diagram />
          }
          if (block) {
            return <FencedCode block={block} />
          }
          return <pre {...props}>{children}</pre>
        },
        // Tables use the whole content width on large screens, and scroll inside their own frame on small ones.
        table: ({ node: _node, ...props }) => (
          <div className="my-8 overflow-x-auto rounded-xl ring-1 ring-(--tw-prose-table-ring) lg:max-w-5xl">
            <table {...props} />
          </div>
        ),
        // A short value (a name, a type, a default) stays on one line; longer text wraps as usual.
        td: ({ node: _node, children, ...props }) => (
          <td data-short={textOf(children).length <= SHORT_CELL ? '' : undefined} {...props}>
            {children}
          </td>
        ),
      }}
    >
      {body}
    </ReactMarkdown>
  )
}
