import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react'

type Theme = 'light' | 'dark'

const STORAGE_KEY = 'theme'

/**
 * Runs before the page paints (inlined in the document head) so the saved or
 * system theme is applied without a flash of the wrong colours.
 */
export const themeScript = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.classList.toggle('dark',t==='dark');document.documentElement.style.colorScheme=t}catch(e){}})()`

const ThemeContext = createContext<{
  resolvedTheme: Theme | undefined
  setTheme: (theme: Theme) => void
}>({ resolvedTheme: undefined, setTheme: () => {} })

function applyTheme(theme: Theme) {
  let root = document.documentElement
  // Suppress transitions while the colours swap.
  let style = document.createElement('style')
  style.textContent = '*,*::before,*::after{transition:none!important}'
  document.head.appendChild(style)
  root.classList.toggle('dark', theme === 'dark')
  root.style.colorScheme = theme
  window.getComputedStyle(document.body)
  setTimeout(() => style.remove(), 1)
}

export function useTheme() {
  return useContext(ThemeContext)
}

export function Providers({ children }: { children: React.ReactNode }) {
  let [resolvedTheme, setResolvedTheme] = useState<Theme | undefined>()

  useEffect(() => {
    setResolvedTheme(
      document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    )

    // Follow the system setting until the reader picks a theme.
    let media = window.matchMedia('(prefers-color-scheme: dark)')
    function onMediaChange() {
      let saved: string | null = null
      try {
        saved = localStorage.getItem(STORAGE_KEY)
      } catch {}
      if (saved === 'light' || saved === 'dark') {
        return
      }
      let theme: Theme = media.matches ? 'dark' : 'light'
      applyTheme(theme)
      setResolvedTheme(theme)
    }
    media.addEventListener('change', onMediaChange)
    return () => media.removeEventListener('change', onMediaChange)
  }, [])

  let setTheme = useCallback((theme: Theme) => {
    let systemTheme: Theme = window.matchMedia('(prefers-color-scheme: dark)')
      .matches
      ? 'dark'
      : 'light'
    try {
      // Picking the system theme goes back to following the system.
      if (theme === systemTheme) {
        localStorage.removeItem(STORAGE_KEY)
      } else {
        localStorage.setItem(STORAGE_KEY, theme)
      }
    } catch {}
    applyTheme(theme)
    setResolvedTheme(theme)
  }, [])

  return (
    <ThemeContext.Provider value={{ resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}
