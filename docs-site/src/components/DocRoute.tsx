import { usePathname } from '@/lib/pathname'

import { Feedback } from '@/components/Feedback'
import { HomeHero } from '@/components/HomeHero'
import { Layout } from '@/components/Layout'
import { MarkdownDoc } from '@/components/MarkdownDoc'
import { Prose } from '@/components/Prose'
import { allSections, getPageByPath } from 'virtual:sureq-docs'

export function DocRoute() {
  const pathname = usePathname()
  const page = getPageByPath(pathname)

  if (!page) {
    return (
      <Layout allSections={{}}>
        <main className="mx-auto max-w-lg py-24 text-center">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-white">
            Page not found
          </h1>
        </main>
      </Layout>
    )
  }

  const isHome = page.routePath === '/'

  return (
    <Layout allSections={allSections}>
      <article className="flex h-full flex-col pt-16 pb-10">
        <Prose className="flex-auto">
          {isHome && <HomeHero />}
          <MarkdownDoc
            content={page.content}
            sourceFile={page.sourceFile}
            codeBlocks={page.codeBlocks}
            hideTitle={isHome}
          />
        </Prose>
        <footer className="mx-auto mt-16 w-full max-w-2xl lg:max-w-5xl">
          <Feedback />
        </footer>
      </article>
    </Layout>
  )
}