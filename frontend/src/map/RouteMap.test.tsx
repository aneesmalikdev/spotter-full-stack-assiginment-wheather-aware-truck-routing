/** RouteMap with MapLibre's real Popup and event dispatch; only the WebGL map is faked (jsdom has no
 * WebGL). The fake projects lon/lat linearly and answers queryRenderedFeatures from the data set on it. */

import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Level, Plan } from '../api/types'
import { type HourStore, createHourStore } from '../lib/hourStore'
import { formatDayTime } from '../lib/time'
import { REDUCED_MOTION } from '../lib/useMediaQuery'
import { checkpoint, heatmap, plan as makePlan, route } from '../test/fixtures'
import { HEAT_ID_SPAN } from './heat'
import { STYLE_URL } from './mapStyle'
import { RouteMap } from './RouteMap'
import { truckAt, truckTrack } from './trucks'

vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '/worker.js' }))
vi.mock('./layers', async importOriginal => ({
  ...(await importOriginal<typeof import('./layers')>()),
  addPlanLayers: () => {}, // needs a real style
  applyDotZooms: () => {},
}))
vi.mock('maplibre-gl', async importOriginal => {
  const real = await importOriginal<typeof import('maplibre-gl')>()
  class FakeMap extends real.Evented {
    container: HTMLElement
    _canvasContainer = document.createElement('div')
    canvas = document.createElement('canvas')
    _camera = {
      transform: {
        width: 800,
        height: 600,
        getCoveringTilesDetailsProvider: () => ({ allowWorldCopies: () => false }),
        isLocationOccluded: () => false,
      },
    }
    touchZoomRotate = { disableRotation() {} }
    keyboard = { disableRotation() {} }
    cooperativeGestures = { enable() {}, disable() {} }
    data = new Map<string, GeoJSON.FeatureCollection>()
    states: { source: string; id: number; state: Record<string, boolean | number> }[] = []
    constructor(options: { container: HTMLElement }) {
      super()
      this.container = options.container
      this.canvas.tabIndex = 0
      this._canvasContainer.append(this.canvas)
      this.container.append(this._canvasContainer)
      maps.push(this)
    }
    addControl() {
      return this
    }
    fitBounds() {
      return this
    }
    panBy() {
      return this
    }
    getContainer() {
      return this.container
    }
    getCanvas() {
      return this.canvas
    }
    getCanvasContainer() {
      return this._canvasContainer
    }
    _getUIString() {
      return 'Close popup'
    }
    project(at: [number, number] | { lng: number; lat: number }) {
      const { lng, lat } = Array.isArray(at) ? { lng: at[0], lat: at[1] } : at
      return new real.Point((lng + 110) * 40, (45 - lat) * 40)
    }
    styleGone = false // as MapLibre's map has no style while its WebGL context is lost
    styles: string[] = [] // the styles set after the map was made
    setStyle(url: string) {
      this.styles.push(url)
      return this
    }
    getSource(id: string) {
      if (this.styleGone) return undefined
      return { setData: (data: GeoJSON.FeatureCollection) => this.data.set(id, data) }
    }
    cleared: string[] = []
    removeFeatureState({ source }: { source: string }) {
      if (this.styleGone) throw new TypeError("Cannot read properties of null (reading 'removeFeatureState')")
      this.cleared.push(source)
    }
    setFeatureState(feature: { source: string; id: number }, state: Record<string, boolean | number>) {
      if (this.styleGone) throw new TypeError("Cannot read properties of null (reading 'setFeatureState')")
      this.states.push({ ...feature, state })
    }
    queryRenderedFeatures(box: [[number, number], [number, number]]) {
      if (this.styleGone) return []
      const [[x0, y0], [x1, y1]] = box
      return (this.data.get('checkpoints')?.features ?? []).filter(feature => {
        const at = this.project((feature.geometry as GeoJSON.Point).coordinates as [number, number])
        return at.x >= x0 && at.x <= x1 && at.y >= y0 && at.y <= y1
      })
    }
    remove() {}
  }
  const maps: FakeMap[] = []
  return { ...real, MapLibreMap: FakeMap, NavigationControl: class {}, setWorkerUrl: () => {}, __maps: maps }
})

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

interface FakeMap {
  fire: (type: string, data?: object) => void
  project: (at: [number, number]) => { x: number; y: number }
  getCanvas: () => HTMLCanvasElement
  getContainer: () => HTMLElement
  states: { source: string; id: number; state: Record<string, boolean | number> }[]
  cleared: string[]
  data: Map<string, GeoJSON.FeatureCollection>
  styleGone: boolean
  styles: string[]
}

const A = route('A', { rank: 1 })
A.checkpoints = [
  checkpoint({ mile: 0, lat: 33, lon: -97 }),
  // Its own times, so a test can tell its ETA from the card's other times.
  checkpoint({ mile: 25, lat: 35, lon: -100, level: 1, eta: '2026-10-25T15:20:00Z', forecast_time: '2026-10-25T15:00:00Z', totals_time: '2026-10-25T16:00:00Z' }),
  checkpoint({ mile: 50, lat: 37, lon: -103, level: 2 }),
]
const B = route('B', { rank: 2, average: 0.1 })
B.checkpoints = B.checkpoints.map((dot, i) => ({ ...dot, lat: 31, lon: -95 + i })) // clear of A's dots: a click opens one
const PLAN = makePlan([A, B])

async function mount(
  options: { plan?: Plan | null; spotlight?: string | null; hour?: HourStore } = {},
): Promise<FakeMap> {
  const { plan = PLAN, spotlight = null, hour = createHourStore() } = options
  render(
    <RouteMap
      plan={plan}
      spotlight={spotlight}
      stacked={false}
      hour={hour}
      padding={() => ({ top: 0, bottom: 0, left: 0, right: 0 })}
      obstacles={() => []}
    />,
  )
  const maps = ((await import('maplibre-gl')) as unknown as { __maps: FakeMap[] }).__maps
  return maps[maps.length - 1]
}

function load(map: FakeMap) {
  act(() => {
    map.fire('style.load')
    map.fire('sourcedata', { tile: {} })
    map.fire('load')
  })
}

function clickAt(map: FakeMap, point: { x: number; y: number }) {
  act(() => map.fire('click', { point, originalEvent: new MouseEvent('click') }))
}

function clickDot(map: FakeMap, i: number) {
  const dot = A.checkpoints[i]
  clickAt(map, map.project([dot.lon, dot.lat]))
}

/** The open card's title (a card that is closing doesn't count). */
const popupTitle = () => document.querySelector('.cp-popup:not(.is-closing) .cp-title')?.textContent ?? null
const selected = (map: FakeMap) =>
  map.states.filter(s => s.source === 'checkpoints' && 'selected' in s.state).map(s => [s.id, s.state.selected])
const problemCard = () => document.querySelector('.map-problem')?.textContent ?? null

afterEach(() => vi.restoreAllMocks())

describe('checkpoint popup', () => {
  it('moves from dot to dot, each click showing the dot clicked and ringing it', async () => {
    const map = await mount()
    load(map)
    clickDot(map, 0)
    expect(popupTitle()).toBe('Route A, start (mile 0.0)')
    clickDot(map, 1)
    expect(popupTitle()).toBe('Route A, mile 25.0')
    clickDot(map, 2)
    expect(popupTitle()).toBe('Route A, destination (mile 50.0)')
    expect(document.activeElement?.className).toBe('cp-close')
    expect(selected(map)).toEqual([
      [0, true],
      [0, false],
      [1, true],
      [1, false],
      [2, true],
    ])
  })

  it('animates a card out, then removes it', async () => {
    const map = await mount()
    load(map)
    clickDot(map, 1)
    clickAt(map, { x: 5, y: 5 }) // no dot here
    expect(popupTitle()).toBeNull()
    expect(document.querySelectorAll('.cp-popup.is-closing')).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(document.querySelectorAll('.cp-popup')).toHaveLength(0)
  })

  it('leaves an open card alone when its dot is clicked again', async () => {
    const map = await mount()
    load(map)
    clickDot(map, 2)
    const card = document.querySelector('.cp-popup')
    clickDot(map, 2)
    expect(document.querySelectorAll('.cp-popup')).toHaveLength(1)
    expect(document.querySelector('.cp-popup')).toBe(card)
    expect(card?.classList.contains('cp-level-2')).toBe(true) // the tip takes the level's colour
    expect(selected(map)).toEqual([[2, true]])
  })

  it('ignores the close button of a card that is already closing', async () => {
    const map = await mount()
    load(map)
    clickDot(map, 0)
    clickDot(map, 2)
    fireEvent.click(document.querySelector('.cp-popup.is-closing .cp-close')!)
    expect(popupTitle()).toBe('Route A, destination (mile 50.0)')
  })

  it('returns focus to the map when closed with Escape or the close button', async () => {
    const map = await mount()
    load(map)
    clickDot(map, 1)
    fireEvent.keyDown(document.querySelector('.cp-popup:not(.is-closing)')!, { key: 'Escape' })
    expect(popupTitle()).toBeNull()
    expect(document.activeElement).toBe(map.getCanvas())
    clickDot(map, 2)
    fireEvent.click(document.querySelector('.cp-popup:not(.is-closing) .cp-close')!)
    expect(popupTitle()).toBeNull()
    expect(document.activeElement).toBe(map.getCanvas())
  })
})

describe('overlapping checkpoints', () => {
  /** Three routes from one start to one destination, ranked A, C, B. B's and C's mile 25 are 4 px apart. */
  function sharing(): Plan {
    const a = route('A', { rank: 1 })
    a.checkpoints = [
      checkpoint({ mile: 0, lat: 33, lon: -97 }),
      checkpoint({ mile: 25, lat: 35, lon: -98 }),
      checkpoint({ mile: 50, lat: 37, lon: -103, level: 1 }),
    ]
    const b = route('B', { rank: 3, average: 0.5 })
    b.checkpoints = [
      checkpoint({ mile: 0, lat: 33, lon: -97 }),
      checkpoint({ mile: 25, lat: 34, lon: -101 }),
      checkpoint({ mile: 60, lat: 37, lon: -103, level: 3 }),
    ]
    const c = route('C', { rank: 2, average: 0.2 })
    c.checkpoints = [
      checkpoint({ mile: 0, lat: 33, lon: -97 }),
      checkpoint({ mile: 25, lat: 34.1, lon: -101 }),
      checkpoint({ mile: 70, lat: 37, lon: -103, level: 2 }),
    ]
    return makePlan([a, b, c])
  }
  const titles = () => [...document.querySelectorAll('.cp-popup:not(.is-closing) .cp-title')].map(title => title.textContent)
  const destination = (map: FakeMap) => map.project([-103, 37])

  it('lists every route’s checkpoint under the pointer, the recommended route first, then by rank', async () => {
    const map = await mount({ plan: sharing() })
    load(map)
    clickAt(map, destination(map))
    expect(titles()).toEqual(['Route A, destination (mile 50.0)', 'Route C, destination (mile 70.0)', 'Route B, destination (mile 60.0)'])
  })

  it('puts the route pointed at or pinned on the board first', async () => {
    const map = await mount({ plan: sharing(), spotlight: 'B' })
    load(map)
    clickAt(map, destination(map))
    expect(titles()).toEqual(['Route B, destination (mile 60.0)', 'Route A, destination (mile 50.0)', 'Route C, destination (mile 70.0)'])
  })

  it('gives each checkpoint its full details, under one close button', async () => {
    const map = await mount({ plan: sharing() })
    load(map)
    clickAt(map, destination(map))
    const card = document.querySelector('.cp-popup')!
    const sections = [...card.querySelectorAll('.cp')]
    expect(sections.map(section => section.className)).toEqual(['cp cp-level-1', 'cp cp-level-2', 'cp cp-level-3'])
    expect(sections.map(section => section.querySelector('.pill-level')?.textContent)).toEqual(['Moderate', 'High', 'Severe'])
    expect(sections.map(section => section.querySelectorAll('.cp-times dt, .cp-factors th').length)).toEqual([7, 7, 7])
    expect(card.querySelectorAll('.cp-close')).toHaveLength(1)
    expect(document.activeElement).toBe(sections[0].querySelector('.cp-close'))
    expect(card.classList.contains('cp-level-1')).toBe(true) // the tip takes the first section's colour
  })

  it('rings every listed dot, and lets them all go when the card closes', async () => {
    const map = await mount({ plan: sharing() })
    load(map)
    clickAt(map, destination(map))
    expect(selected(map)).toEqual([
      [2, true], // A's destination (route 0, checkpoint 2)
      [20_002, true], // C's
      [10_002, true], // B's
    ])
    fireEvent.click(document.querySelector('.cp-popup:not(.is-closing) .cp-close')!)
    expect(selected(map).slice(3)).toEqual([
      [2, false],
      [20_002, false],
      [10_002, false],
    ])
  })

  it('lists each other route once, at its checkpoint nearest the dot clicked', async () => {
    const a = route('A', { rank: 1 })
    a.checkpoints = [checkpoint({ mile: 0, lat: 35, lon: -98 }), checkpoint({ mile: 25, lat: 37, lon: -100 })]
    const b = route('B', { rank: 2 })
    b.checkpoints = [
      checkpoint({ mile: 0, lat: 34.875, lon: -98 }), // 5 px from A's start
      checkpoint({ mile: 10, lat: 35.1, lon: -98 }), // 4 px
      checkpoint({ mile: 20, lat: 36, lon: -99 }),
    ]
    const map = await mount({ plan: makePlan([a, b]) })
    load(map)
    clickAt(map, map.project([-98, 35]))
    expect(titles()).toEqual(['Route A, start (mile 0.0)', 'Route B, mile 10.0'])
  })

  it('leaves out another route’s dot beside the one clicked, which can be clicked on its own', async () => {
    const a = route('A', { rank: 1 })
    a.checkpoints = [checkpoint({ mile: 0, lat: 33, lon: -97 }), checkpoint({ mile: 50, lat: 37, lon: -103 })]
    const b = route('B', { rank: 2 })
    b.checkpoints = [checkpoint({ mile: 0, lat: 33, lon: -97 }), checkpoint({ mile: 52, lat: 37, lon: -102.75 })] // 10 px
    const map = await mount({ plan: makePlan([a, b]) })
    load(map)
    clickAt(map, map.project([-103, 37]))
    expect(titles()).toEqual(['Route A, destination (mile 50.0)'])
    clickAt(map, map.project([-102.75, 37]))
    expect(titles()).toEqual(['Route B, destination (mile 52.0)'])
  })

  it('keeps its order while the spotlight moves', async () => {
    const props = {
      stacked: false,
      hour: createHourStore(),
      padding: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
      obstacles: () => [],
    }
    const plan = sharing()
    const view = render(<RouteMap plan={plan} spotlight={null} {...props} />)
    const maps = ((await import('maplibre-gl')) as unknown as { __maps: FakeMap[] }).__maps
    const map = maps[maps.length - 1]
    load(map)
    clickAt(map, destination(map))
    view.rerender(<RouteMap plan={plan} spotlight="B" {...props} />) // the route list pointed at
    expect(titles()).toEqual(['Route A, destination (mile 50.0)', 'Route C, destination (mile 70.0)', 'Route B, destination (mile 60.0)'])
  })

  it('leaves the card alone when the same dots are clicked again, and replaces it for others', async () => {
    const map = await mount({ plan: sharing() })
    load(map)
    clickAt(map, destination(map))
    const card = document.querySelector('.cp-popup')
    clickAt(map, { x: destination(map).x + 2, y: destination(map).y }) // the same three dots
    expect(document.querySelector('.cp-popup:not(.is-closing)')).toBe(card)
    clickAt(map, map.project([-98, 35])) // A's mile 25, alone
    expect(titles()).toEqual(['Route A, mile 25.0'])
  })

  it('shows no hover label for a dot the card lists', async () => {
    withMedia({ hover: true })
    const map = await mount({ plan: sharing() })
    load(map)
    clickAt(map, destination(map))
    await hoverAt(map, destination(map)) // B's Severe dot is on top here, and the card lists it
    expect(tipTitle()).toBeNull()
    await hoverAt(map, map.project([-98, 35]))
    expect(tipTitle()).toBe('Route A, mile 25.0')
  })

  it('scrolls a list taller than the map inside the card', async () => {
    const map = await mount({ plan: sharing() })
    load(map)
    vi.spyOn(map.getContainer(), 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
    clickAt(map, destination(map))
    // 600 px, less 12 px at the top and bottom, and 40 px for the tip and the dot (stackMaxHeight)
    expect(document.querySelector<HTMLElement>('.cp-popup .cp-stack')?.style.maxHeight).toBe('536px')
  })
})

/** Pretend the device has a mouse or trackpad (`(hover: hover)`), and whether the system asks for reduced motion. */
function withMedia({ hover = false, reducedMotion = false }: { hover?: boolean; reducedMotion?: boolean }) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    query =>
      ({
        matches: (hover && query === '(hover: hover)') || (reducedMotion && query === REDUCED_MOTION),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  )
}

/** Move the mouse to a point (with `buttons` held), then let the frame that handles it run. */
async function hoverAt(map: FakeMap, point: { x: number; y: number }, buttons = 0) {
  act(() => map.fire('mousemove', { point, originalEvent: new MouseEvent('mousemove', { buttons }) }))
  await act(() => new Promise(resolve => requestAnimationFrame(resolve)))
}

const dotAt = (map: FakeMap, i: number) => map.project([A.checkpoints[i].lon, A.checkpoints[i].lat])
const tipTitle = () => document.querySelector('.cp-tip .cp-tip-title')?.textContent ?? null

describe('hover label', () => {
  it('labels the dot under the mouse with its ETA and risk, and goes when the mouse leaves', async () => {
    withMedia({ hover: true })
    const map = await mount()
    load(map)
    await hoverAt(map, dotAt(map, 1))
    expect(tipTitle()).toBe('Route A, mile 25.0')
    expect(document.querySelector('.cp-tip')?.textContent).toContain(`ETA ${formatDayTime('2026-10-25T15:20:00Z')}`)
    expect(document.querySelector('.cp-tip .pill-level')?.textContent).toBe('Moderate')
    expect(map.getCanvas().style.cursor).toBe('pointer')
    await hoverAt(map, dotAt(map, 2))
    expect(tipTitle()).toBe('Route A, destination (mile 50.0)')
    expect(document.querySelectorAll('.cp-tip')).toHaveLength(1)
    await hoverAt(map, { x: 5, y: 5 }) // no dot here
    expect(tipTitle()).toBeNull()
    await hoverAt(map, dotAt(map, 1))
    act(() => map.fire('mouseout'))
    expect(tipTitle()).toBeNull()
  })

  it('gives way to the card', async () => {
    withMedia({ hover: true })
    const map = await mount()
    load(map)
    await hoverAt(map, dotAt(map, 1))
    clickDot(map, 1)
    expect(tipTitle()).toBeNull() // the card opened in its place
    await hoverAt(map, dotAt(map, 1))
    expect(tipTitle()).toBeNull() // the card already shows this checkpoint
  })

  it('goes when the mouse is pressed, as a drag may start, and stays away while a button is held', async () => {
    withMedia({ hover: true })
    const map = await mount()
    load(map)
    await hoverAt(map, dotAt(map, 2))
    expect(tipTitle()).toBe('Route A, destination (mile 50.0)')
    act(() => map.fire('mousedown', { point: dotAt(map, 2), originalEvent: new MouseEvent('mousedown', { buttons: 1 }) }))
    expect(tipTitle()).toBeNull() // MapLibre sends no mousemove during a drag, so the press must hide it
    await hoverAt(map, dotAt(map, 2), 1)
    expect(tipTitle()).toBeNull()
  })

  it('shows no label on touch screens, where a tap opens the card', async () => {
    withMedia({})
    const map = await mount()
    load(map)
    await hoverAt(map, dotAt(map, 1))
    expect(tipTitle()).toBeNull()
    expect(map.getCanvas().style.cursor).toBe('pointer')
  })

  /** Routes A (recommended) and B ending at the same place, A's last dot Low and B's Severe. */
  function sameEnd(): Plan {
    const a = route('A', { rank: 1 })
    a.checkpoints = [checkpoint({ mile: 0, lat: 33, lon: -97 }), checkpoint({ mile: 50, lat: 37, lon: -103 })]
    const b = route('B', { rank: 2, average: 0.5 })
    b.checkpoints = [checkpoint({ mile: 0, lat: 33, lon: -97 }), checkpoint({ mile: 60, lat: 37, lon: -103, level: 3 })]
    return makePlan([a, b])
  }

  it('names the dot drawn on top where two routes share a place', async () => {
    withMedia({ hover: true })
    const map = await mount({ plan: sameEnd() })
    load(map)
    await hoverAt(map, map.project([-103, 37]))
    expect(tipTitle()).toBe('Route B, destination (mile 60.0)') // B's Severe dot is drawn over A's Low one
  })

  it('names the pointed-at route’s dot where two routes share a place', async () => {
    withMedia({ hover: true })
    const map = await mount({ plan: sameEnd(), spotlight: 'A' })
    load(map)
    await hoverAt(map, map.project([-103, 37]))
    expect(tipTitle()).toBe('Route A, destination (mile 50.0)') // A's dots are drawn on top while it is pointed at
  })
})

describe('heatmap', () => {
  it('colours the cells for the slider hour, then only the cells that change, once a frame', async () => {
    const hour = createHourStore()
    const withHeat = makePlan([A, route('B', { rank: 2, average: 0.1 })], {
      heatmap: {
        cell_deg: 0.5,
        band_miles: 30,
        cells: [
          [-97.5, 33, -97, 33.5],
          [-97, 33, -96.5, 33.5],
        ],
        hours: ['2026-10-25T14:00:00Z', '2026-10-25T15:00:00Z', '2026-10-25T16:00:00Z'],
        levels: [
          [0, null],
          [0, 2],
          [3, 2],
        ],
      },
    })
    const map = await mount({ plan: withHeat, hour })
    load(map)
    const heat = () => map.states.filter(s => s.source === 'heat').map(s => [s.id % HEAT_ID_SPAN, s.state.lvl])
    expect(heat()).toEqual([
      [0, 0],
      [1, -1], // No data
    ])
    act(() => {
      hour.set(1)
      hour.set(2) // two moves in one frame: only the last is drawn
    })
    await act(() => new Promise(resolve => requestAnimationFrame(resolve)))
    expect(heat().slice(2)).toEqual([
      [0, 3],
      [1, 2],
    ])
  })
})

describe('heatmap ids', () => {
  it('gives a new plan’s cells ids the old ones didn’t use, and leaves the old colours alone', async () => {
    const withCells = (levels: Level[]) =>
      makePlan([A], {
        heatmap: {
          cell_deg: 0.5,
          band_miles: 30,
          cells: levels.map((_, i) => [-97 + i * 0.5, 33, -96.5 + i * 0.5, 33.5] as [number, number, number, number]),
          hours: ['2026-10-25T14:00:00Z'],
          levels: [levels],
        },
      })
    const props = {
      spotlight: null,
      stacked: false,
      hour: createHourStore(),
      padding: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
      obstacles: () => [],
    }
    const view = render(<RouteMap plan={withCells([2, 2])} {...props} />)
    const maps = ((await import('maplibre-gl')) as unknown as { __maps: FakeMap[] }).__maps
    const map = maps[maps.length - 1]
    load(map)
    const heatIds = () => map.states.filter(s => s.source === 'heat').map(s => s.id)
    const first = heatIds()
    view.rerender(<RouteMap plan={withCells([0, 1, null])} {...props} />)
    const second = heatIds().slice(first.length)
    expect(second).toHaveLength(3)
    expect(second.some(id => first.includes(id))).toBe(false)
    expect(map.cleared).not.toContain('heat')
  })
})

describe('base map problems', () => {
  it('shows no card when only some tiles fail, and still logs the failures', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const map = await mount()
    act(() => {
      map.fire('style.load')
      map.fire('error', { error: new Error('one tile failed') })
      map.fire('sourcedata', { tile: {} })
      map.fire('load')
    })
    expect(problemCard()).toBeNull()
    expect(log).toHaveBeenCalledWith(new Error('one tile failed'))
  })

  it('shows the card when the style itself fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const map = await mount()
    act(() => map.fire('error', { error: new Error('style failed') }))
    expect(problemCard()).toContain("The base map didn't load.")
  })

  it('shows the card when no tile arrived, and hides it once one does', async () => {
    const map = await mount()
    act(() => {
      map.fire('style.load')
      map.fire('load')
    })
    expect(problemCard()).toContain("The base map didn't load.")
    act(() => map.fire('sourcedata', { tile: {} }))
    expect(problemCard()).toBeNull()
  })
})

describe('trucks', () => {
  /** Route A leaves at 14:00 UTC (the slider's +0 h), reaches mile 400 at 20:00 and arrives at 03:00. */
  function driving(): Plan {
    const a = route('A', { rank: 1 })
    a.checkpoints = [
      checkpoint({ mile: 0, eta: '2026-10-25T14:00:00Z' }),
      checkpoint({ mile: 400, eta: '2026-10-25T20:00:00Z' }),
      checkpoint({ mile: 812.6, eta: '2026-10-26T03:00:00Z' }),
    ]
    return makePlan([a, route('B', { rank: 2, average: 0.1 })], { heatmap: heatmap() })
  }
  const truckA = (map: FakeMap) => (map.data.get('trucks')?.features[0]?.geometry as GeoJSON.Point | undefined)?.coordinates
  const nextFrame = () => act(() => new Promise(resolve => requestAnimationFrame(resolve)))

  it('start at the start, follow the slider along each route, and park at the end', async () => {
    withMedia({ reducedMotion: true }) // straight to each hour
    const hour = createHourStore()
    const plan = driving()
    const line = plan.routes[0].geometry // heads west and north
    const map = await mount({ plan, hour })
    load(map)
    expect(truckA(map)).toEqual(line[0])
    act(() => hour.set(6)) // 20:00 UTC: mile 400 of 812.6
    await nextFrame()
    const [lon, lat] = truckA(map)!
    expect(lon).toBeLessThan(line[0][0])
    expect(lon).toBeGreaterThan(line[2][0])
    expect(lat).toBeGreaterThan(line[0][1])
    act(() => hour.set(48)) // long after arrival
    await nextFrame()
    expect(truckA(map)).toEqual(line[2])
  })

  it('drive along the route to the slider’s new hour instead of jumping there', async () => {
    const hour = createHourStore()
    const plan = driving()
    const map = await mount({ plan, hour })
    load(map)
    const start = truckA(map)!
    const target = truckAt(truckTrack(plan.routes[0]), Date.parse(plan.heatmap.hours[6])).at
    act(() => hour.set(6))
    await nextFrame() // the slider's hour is applied
    await nextFrame() // the first step of the drive
    const [lon] = truckA(map)!
    expect(lon).toBeLessThan(start[0]) // under way, west along the route
    expect(lon).toBeGreaterThan(target[0]) // but not there yet
    for (let frame = 0; frame < 120 && truckA(map)?.[0] !== target[0]; frame++) await nextFrame()
    expect(truckA(map)).toEqual(target)
  })

  it('start a new plan’s trucks in place, even when it arrives mid-drive', async () => {
    const hour = createHourStore()
    const props = {
      spotlight: null,
      stacked: false,
      hour,
      padding: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
      obstacles: () => [],
    }
    const view = render(<RouteMap plan={driving()} {...props} />)
    const maps = ((await import('maplibre-gl')) as unknown as { __maps: FakeMap[] }).__maps
    const map = maps[maps.length - 1]
    load(map)
    act(() => hour.set(6))
    await nextFrame()
    await nextFrame() // the first plan's trucks are under way
    const next = driving()
    next.routes[0].geometry = [
      [-90, 30],
      [-91, 31],
      [-92, 32],
    ]
    view.rerender(<RouteMap plan={next} {...props} />)
    const there = truckAt(truckTrack(next.routes[0]), Date.parse(next.heatmap.hours[6])).at
    expect(truckA(map)).toEqual(there) // at once, not driving in from the old plan
    await nextFrame()
    await nextFrame()
    expect(truckA(map)).toEqual(there) // and the old drive doesn't move it
  })

  it('go with the slider, so a plan without squares has none', async () => {
    const map = await mount({ plan: makePlan(driving().routes, { heatmap: heatmap(0) }) })
    load(map)
    expect(map.data.get('trucks')?.features).toEqual([])
  })

  it('are lit and dimmed with their routes', async () => {
    const map = await mount({ plan: driving(), spotlight: 'B' })
    load(map)
    expect(map.states.filter(s => s.source === 'trucks')).toEqual([
      { source: 'trucks', id: 0, state: { spot: false, dim: true } },
      { source: 'trucks', id: 1, state: { spot: true, dim: false } },
    ])
  })
})

describe('lost graphics', () => {
  /** As MapLibre does when the browser takes its WebGL context away: the style goes, so sources and
   * queries come back empty and setting feature-state throws. */
  function loseGraphics(map: FakeMap) {
    act(() => {
      map.styleGone = true
      map.fire('webglcontextlost', { originalEvent: new Event('webglcontextlost') })
    })
  }
  /** As MapLibre does when the context comes back: the style is rebuilt from a copy, with each source's
   * data but no feature-state, and can be used only once it has loaded, a frame later. */
  function restoreGraphics(map: FakeMap) {
    act(() => map.fire('webglcontextrestored', { originalEvent: new Event('webglcontextrestored') }))
    act(() => {
      map.styleGone = false
      map.fire('style.load')
    })
  }
  /** Two heat cells over two hours, with the trucks on the slider. */
  function withHeat(routes: Plan['routes'], levels: Level[][]): Plan {
    const cells: [number, number, number, number][] = [
      [-97.5, 33, -97, 33.5],
      [-97, 33, -96.5, 33.5],
    ]
    return makePlan(routes, {
      heatmap: { cell_deg: 0.5, band_miles: 30, cells, hours: ['2026-10-25T14:00:00Z', '2026-10-25T15:00:00Z'], levels },
    })
  }
  const nextFrame = () => act(() => new Promise(resolve => requestAnimationFrame(resolve)))
  const heat = (states: FakeMap['states']) => states.filter(s => s.source === 'heat').map(s => [s.id % HEAT_ID_SPAN, s.state.lvl])
  const lit = (states: FakeMap['states'], source: string) => states.filter(s => s.source === source).map(s => [s.id, s.state] as const)

  it('draws the heat colours, the spotlight, the open card’s ring and the trucks’ highlight again', async () => {
    const hour = createHourStore()
    const map = await mount({ plan: withHeat([A, B], [[0, 1], [2, 3]]), spotlight: 'B', hour })
    load(map)
    act(() => hour.set(1))
    await nextFrame()
    clickDot(map, 1) // A's mile 25
    loseGraphics(map)
    const before = map.states.length
    restoreGraphics(map)
    const after = map.states.slice(before)
    expect(heat(after)).toEqual([
      [0, 2],
      [1, 3],
    ])
    for (const source of ['routes', 'route-solo', 'plates', 'trucks']) {
      expect(lit(after, source)).toEqual([
        [0, { spot: false, dim: true }],
        [1, { spot: true, dim: false }],
      ])
    }
    expect(lit(after, 'checkpoints').filter(([, state]) => 'selected' in state)).toEqual([[1, { selected: true }]])
    expect(document.querySelector('.cp-popup .cp-title')?.textContent).toBe('Route A, mile 25.0') // the card stays open
    expect(map.styles).toEqual([]) // MapLibre rebuilt the style itself
  })

  it('puts the trucks back where they are at the slider’s hour', async () => {
    withMedia({ reducedMotion: true }) // parked at the hour, not driving there
    const hour = createHourStore()
    const plan = withHeat([A, B], [[0, 1], [2, 3]])
    const map = await mount({ plan, hour })
    load(map)
    act(() => hour.set(1))
    await nextFrame()
    loseGraphics(map)
    restoreGraphics(map)
    const trucks = map.data.get('trucks')?.features.map(truck => (truck.geometry as GeoJSON.Point).coordinates)
    expect(trucks).toEqual(plan.routes.map(r => truckAt(truckTrack(r), Date.parse(plan.heatmap.hours[1])).at))
  })

  it('loads the base map again when the graphics went before it had loaded', async () => {
    const map = await mount()
    loseGraphics(map) // before 'style.load': MapLibre keeps no copy of the style to rebuild
    act(() => map.fire('webglcontextrestored', { originalEvent: new Event('webglcontextrestored') }))
    expect(map.styles).toEqual([STYLE_URL])
    map.styleGone = false
    load(map) // the style loads, then the map with it
    expect(map.data.get('checkpoints')?.features).toHaveLength(6) // and the plan is drawn
  })

  it('holds back the slider, the spotlight and a new plan while the graphics are gone, then draws them', async () => {
    const hour = createHourStore()
    const props = {
      stacked: false,
      hour,
      padding: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
      obstacles: () => [],
    }
    const view = render(<RouteMap plan={withHeat([A, B], [[0, 0], [1, 2]])} spotlight={null} {...props} />)
    const maps = ((await import('maplibre-gl')) as unknown as { __maps: FakeMap[] }).__maps
    const map = maps[maps.length - 1]
    load(map)
    clickDot(map, 1)
    loseGraphics(map)
    const next = withHeat([route('A', { rank: 1 }), route('B', { rank: 2, average: 0.1 })], [[0, 0], [4, null]])
    next.routes[0].geometry = [
      [-90, 30],
      [-91, 31],
      [-92, 32],
    ]
    act(() => hour.set(1)) // its squares change colour, but none of this reaches the map, which would throw
    await nextFrame()
    view.rerender(<RouteMap plan={next} spotlight="B" {...props} />)
    await nextFrame()
    expect(document.querySelector('.cp-popup:not(.is-closing)')).toBeNull() // a new plan closes the card, as ever
    const before = map.states.length
    restoreGraphics(map)
    const after = map.states.slice(before)
    expect(heat(after)).toEqual([
      [0, 4],
      [1, -1], // No data
    ])
    expect(lit(after, 'routes')).toEqual([
      [0, { spot: false, dim: true }],
      [1, { spot: true, dim: false }],
    ])
    expect(lit(after, 'checkpoints').filter(([, state]) => 'selected' in state)).toEqual([]) // the old card's ring went with it
    expect(map.data.get('checkpoints')?.features).toHaveLength(6) // the new plan's dots
    const truck = (map.data.get('trucks')?.features[0]?.geometry as GeoJSON.Point | undefined)?.coordinates
    expect(truck).toEqual(truckAt(truckTrack(next.routes[0]), Date.parse(next.heatmap.hours[1])).at) // at the slider's hour, at once
  })

  it('finds no checkpoint under the pointer while the graphics are gone', async () => {
    const map = await mount()
    load(map)
    loseGraphics(map)
    clickDot(map, 1)
    expect(popupTitle()).toBeNull()
  })
})

describe('spotlight', () => {
  it('falls back to the recommended route for a letter the plan does not have', async () => {
    const map = await mount({ spotlight: 'Z' })
    load(map)
    const routeStates = map.states.filter(s => s.source === 'routes')
    expect(routeStates).toEqual([
      { source: 'routes', id: 0, state: { spot: true, dim: false } },
      { source: 'routes', id: 1, state: { spot: false, dim: false } },
    ])
  })
})
