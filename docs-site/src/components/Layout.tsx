import { motion } from 'framer-motion'
import { useEffect, useRef } from 'react'

import { usePathname } from '@/lib/pathname'

import { Link } from '@/lib/link'

import { Footer } from '@/components/Footer'
import { Header } from '@/components/Header'
import { Logo } from '@/components/Logo'
import { Navigation } from '@/components/Navigation'
import { SectionProvider, type Section } from '@/components/SectionProvider'

export function Layout({
  children,
  allSections,
}: {
  children: React.ReactNode
  allSections: Record<string, Array<Section>>
}) {
  const pathname = usePathname()
  let sidebarRef = useRef<HTMLDivElement>(null)

  // Bring the current page's link into view when it is out of sight, such as
  // after a full page load of a page low in the list. A link already visible
  // is left alone, so the sidebar never jumps under the reader's pointer.
  useEffect(() => {
    let sidebar = sidebarRef.current
    let link = sidebar?.querySelector<HTMLElement>('a[aria-current="page"]')
    if (!sidebar || !link) {
      return
    }
    let box = sidebar.getBoundingClientRect()
    let target = link.getBoundingClientRect()
    if (target.top >= box.top && target.bottom <= box.bottom) {
      return
    }
    sidebar.scrollTop += target.top - box.top - box.height / 3
  }, [pathname])

  return (
    <SectionProvider sections={allSections[pathname] ?? []}>
      <div className="h-full lg:ml-72 xl:ml-80">
        <motion.header
          layoutScroll
          className="contents lg:pointer-events-none lg:fixed lg:inset-0 lg:z-40 lg:flex"
        >
          <div
            ref={sidebarRef}
            className="contents lg:pointer-events-auto lg:block lg:w-72 lg:overflow-y-auto lg:border-r lg:border-zinc-900/10 lg:px-6 lg:pt-4 lg:pb-8 xl:w-80 lg:dark:border-white/10"
          >
            <div className="hidden lg:flex">
              <Link href="/" aria-label="Home">
                <Logo className="h-6" />
              </Link>
            </div>
            <Header />
            <Navigation className="hidden lg:mt-10 lg:block" />
          </div>
        </motion.header>
        <div className="relative flex h-full flex-col px-4 pt-14 sm:px-6 lg:px-8">
          <main className="flex-auto">{children}</main>
          <Footer />
        </div>
      </div>
    </SectionProvider>
  )
}
