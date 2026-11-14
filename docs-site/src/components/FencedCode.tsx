import { Code, CodeGroup } from '@/components/Code'
import type { CodeBlock } from '@/lib/load-docs'

export function FencedCode({ block }: { block: CodeBlock }) {
  return (
    <CodeGroup title="">
      <Code code={block.code} language={block.language}>
        {block.html}
      </Code>
    </CodeGroup>
  )
}
