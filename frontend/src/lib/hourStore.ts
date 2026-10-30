/** The heatmap slider's hour, kept outside React state: moving the slider re-renders only the slider
 * (which reads it with useSyncExternalStore) and tells the map, never the panel. */
export interface HourStore {
  get: () => number
  set: (hour: number) => void
  subscribe: (listener: () => void) => () => void
}

export function createHourStore(): HourStore {
  let hour = 0
  const listeners = new Set<() => void>()
  return {
    get: () => hour,
    set: next => {
      if (next === hour) return
      hour = next
      for (const listener of listeners) listener()
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
