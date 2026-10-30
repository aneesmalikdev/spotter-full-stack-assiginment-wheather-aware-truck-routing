import { useCallback, useSyncExternalStore } from 'react'

/** Whether a CSS media query matches, kept up to date. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false)
}

export const FLOATING_LAYOUT = '(min-width: 960px) and (min-height: 560px)'
export const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

export function prefersReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION).matches
}
