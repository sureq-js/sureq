/// <reference types="vite/client" />

declare module 'virtual:sureq-docs' {
  type DocPage = import('./lib/load-docs').DocPage
  type NavGroup = import('./lib/load-docs').NavGroup
  type Section = import('./components/SectionProvider').Section

  export const pages: DocPage[]
  export const navigation: NavGroup[]
  export const allSections: Record<string, Section[]>

  export function getPageByPath(pathname: string): DocPage | undefined
  export function resolveDocHref(fromFile: string, href: string): string

  export type SearchResult = {
    url: string
    title: string
    pageTitle?: string
  }

  export function search(
    query: string,
    options?: { limit?: number },
  ): SearchResult[]
}
