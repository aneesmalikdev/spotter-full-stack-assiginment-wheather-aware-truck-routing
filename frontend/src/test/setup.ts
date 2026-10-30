/** jsdom lacks a few browser APIs the app uses. */

import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false, // the stacked (phone) layout, no reduced motion
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

Element.prototype.scrollIntoView ??= function scrollIntoView() {}

afterEach(() => cleanup())
