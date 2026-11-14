import { useLocation } from 'react-router'

/**
 * The current path without a trailing slash. Static hosts such as GitHub
 * Pages serve `/guides/schedules/`, while navigation links use
 * `/guides/schedules`, so compare against this instead of the raw pathname.
 */
export function usePathname() {
  let { pathname } = useLocation()
  return pathname.length > 1 && pathname.endsWith('/')
    ? pathname.slice(0, -1)
    : pathname
}
