import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router'

/** GoatCounter endpoint: no cookies and no personal data, so no consent banner is needed. */
export const GOATCOUNTER_ENDPOINT = 'https://avalluru.goatcounter.com/count'
export const GOATCOUNTER_SCRIPT = 'https://gc.zgo.at/count.js'

declare global {
  interface Window {
    goatcounter?: { count?: (vars: { path: string }) => void }
  }
}

/**
 * count.js counts the first page itself when it loads. This is a single-page app, so later page changes do not
 * reload the page: count each new pathname here (a #hash change within a page is not a new view).
 */
export function PageviewTracker() {
  const { pathname } = useLocation()
  const first = useRef(true)

  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    window.goatcounter?.count?.({ path: pathname })
  }, [pathname])

  return null
}
