import { describe, expect, it, vi } from 'vitest'
import { createHourStore } from './hourStore'

describe('slider hour store', () => {
  it('starts at departure and tells its subscribers about each new hour', () => {
    const store = createHourStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    expect(store.get()).toBe(0)
    store.set(7)
    store.set(7) // the same hour again: nothing to tell
    expect(store.get()).toBe(7)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    store.set(8)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
