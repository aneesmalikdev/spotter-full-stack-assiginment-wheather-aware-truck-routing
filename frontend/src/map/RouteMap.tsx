import { memo, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import {
  GPUInitializationError,
  MapLibreMap,
  NavigationControl,
  Popup,
  setWorkerUrl,
  type GeoJSONSource,
  type LngLatBoundsLike,
  type PointLike,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { Plan } from '../api/types'
import type { HourStore } from '../lib/hourStore'
import { prefersReducedMotion } from '../lib/useMediaQuery'
import { type PlanData, checkpointId, checkpointRef, planData } from './geojson'
import { HEAT_ID_SPAN, hasSlider, heatCells, heatChanges } from './heat'
import { cardShift, stackMaxHeight, visibleArea } from './keepInView'
import { LAYER, SOURCE, addPlanLayers, applyDotZooms } from './layers'
import { LOWER_48, STYLE_URL } from './mapStyle'
import { checkpointCard, checkpointTip } from './popup'
import { type TruckTrack, approach, truckFeatures, truckTrack } from './trucks'

setWorkerUrl(workerUrl) // MapLibre 6 needs its worker's URL when bundled

const ATTRIBUTION = [
  '<a href="https://www.tomtom.com/" target="_blank" rel="noopener">Routing © TomTom</a>',
  '<a href="https://open-meteo.com/" target="_blank" rel="noopener">Weather data by Open-Meteo.com</a> (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>)',
]
const NO_WEBGL = "This browser can't draw the map (WebGL 2 is off or unavailable). The Routes list still works."
const NO_BASEMAP = "The base map didn't load. Check your connection and reload the page. The Routes list still works."
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
// Not the heat: each plan's cells have their own ids, and every one is coloured when the plan is shown.
const PLAN_SOURCES = [SOURCE.routes, SOURCE.solo, SOURCE.plates, SOURCE.checkpoints, SOURCE.ends, SOURCE.trucks]

export interface Padding {
  top: number
  bottom: number
  left: number
  right: number
}

interface Props {
  plan: Plan | null
  spotlight: string | null // a route letter pointed at or pinned on the board; null shows the default
  stacked: boolean // the phone layout: the page scrolls, so the map needs two fingers to move
  hour: HourStore // the heatmap slider's hour, applied to the heat cells as it moves
  padding: () => Padding // keeps fitted routes clear of the panel and the dock
  obstacles: () => Element[] // what floats over the map, for popups to stay clear of
}

/** The one MapLibre map. React never re-renders it: plans, the spotlight and the slider hour are
 * applied imperatively. */
export const RouteMap = memo(function RouteMap({ plan, spotlight, stacked, hour, padding, obstacles }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const popupRef = useRef<Popup | null>(null) // the open details card (a closing one is let go)
  const selectedRef = useRef<number[]>([]) // the checkpoints the open card lists
  const tipRef = useRef<Popup | null>(null) // the label shown while the mouse rests on a checkpoint
  const tipAt = useRef<number | null>(null) // the checkpoint the label shows, while it is shown
  const shown = useRef<{ plan: Plan; data: PlanData; tracks: TruckTrack[] } | null>(null)
  const heatHour = useRef<number | null>(null) // the hour the heat cells show; null: none yet
  const heatBase = useRef(0) // the shown plan's first heat cell id (0 or HEAT_ID_SPAN, alternating)
  const truckTime = useRef<number | null>(null) // the moment the trucks are drawn at; null: none drawn
  const truckFrame = useRef(0) // the next step of the trucks' drive to the slider's hour
  const lost = useRef(false) // the browser has taken the map's WebGL context away: MapLibre has no style until it's back
  const [ready, setReady] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const data = useMemo(() => (plan ? planData(plan) : null), [plan])

  /** The checkpoint nearest a point, if one is drawn within reach. */
  const pick = useEffectEvent((point: { x: number; y: number }, touch: boolean) => {
    const map = mapRef.current
    const current = shown.current
    if (!map || !current || lost.current) return null
    const reach = touch ? 16 : 12
    const box: [PointLike, PointLike] = [
      [point.x - reach, point.y - reach],
      [point.x + reach, point.y + reach],
    ]
    // The pointed-at route's dots are drawn above all others (applySpotlight, checkpoints-spot).
    const pointed = current.plan.routes.some(r => r.id === spotlight) ? spotlight : null
    let best: { route: number; index: number; distance: number; priority: number[] } | null = null
    const seen = new Set<number>()
    for (const feature of map.queryRenderedFeatures(box, { layers: [LAYER.checkpoints, LAYER.checkpointsSpot] })) {
      const id = Number(feature.id)
      if (seen.has(id)) continue
      seen.add(id)
      const { route, index } = checkpointRef(id)
      const routeData = current.plan.routes[route]
      const checkpoint = routeData?.checkpoints[index]
      if (!checkpoint) continue
      const at = map.project([checkpoint.lon, checkpoint.lat])
      const distance = Math.hypot(at.x - point.x, at.y - point.y)
      // Within a pixel, take the dot drawn on top: the pointed-at route's, then the worse level (No data
      // between Low and Moderate), then the recommended route's, as layers.ts's DOT_SORT draws them.
      const priority = [routeData.id === pointed ? 1 : 0, checkpoint.level ?? 0.5, routeData.recommended ? 1 : 0]
      if (!best || distance < best.distance - 1 || (distance <= best.distance + 1 && isBetter(priority, best.priority))) {
        best = { route, index, distance, priority }
      }
    }
    return best
  })

  /** What a click lists: the dot clicked (the one on top, which the hover label names) and each other
   * route's checkpoint drawn on it, its centre within SAME_PLACE px (at the ends and on shared roads). One
   * per route, the spotlighted route first, then the others in ranking order. */
  const stopsAt = useEffectEvent((point: { x: number; y: number }, touch: boolean): Stop[] => {
    const map = mapRef.current
    const routes = shown.current?.plan.routes
    const clicked = pick(point, touch)
    if (!map || !routes || !clicked) return []
    const { lon, lat } = routes[clicked.route].checkpoints[clicked.index]
    const at = map.project([lon, lat])
    const stops = routes.flatMap((route, r): Stop[] => {
      if (r === clicked.route) return [{ route: r, index: clicked.index }]
      const [nearest] = route.checkpoints
        .map((checkpoint, index) => {
          const dot = map.project([checkpoint.lon, checkpoint.lat])
          return { route: r, index, distance: Math.hypot(dot.x - at.x, dot.y - at.y) }
        })
        .filter(stop => stop.distance <= SAME_PLACE)
        .sort((a, b) => a.distance - b.distance)
      return nearest ? [nearest] : []
    })
    const pointed = routes.findIndex(route => route.id === spotlight)
    const lit = pointed >= 0 ? pointed : routes.findIndex(route => route.recommended)
    return stops.sort((a, b) => Number(b.route === lit) - Number(a.route === lit) || routes[a.route].rank - routes[b.route].rank)
  })

  const hideTip = useEffectEvent(() => {
    tipRef.current?.remove()
    tipAt.current = null
  })

  /** Label the checkpoint under the mouse with its ETA and risk. Not one the open card lists: the card
   * already says the same. */
  const showTip = useEffectEvent((hit: { route: number; index: number } | null) => {
    const map = mapRef.current
    const routeData = hit ? shown.current?.plan.routes[hit.route] : undefined
    if (!map || !hit || !routeData) return hideTip()
    const id = checkpointId(hit.route, hit.index)
    if (selectedRef.current.includes(id)) return hideTip()
    if (id === tipAt.current) return
    const checkpoint = routeData.checkpoints[hit.index]
    tipRef.current ??= new Popup({
      offset: 10,
      maxWidth: 'none',
      focusAfterOpen: false,
      closeButton: false,
      closeOnClick: false,
      className: 'cp-tip',
    })
    tipRef.current.setLngLat([checkpoint.lon, checkpoint.lat]).setDOMContent(checkpointTip(routeData, hit.index))
    if (!tipRef.current.isOpen()) tipRef.current.addTo(map)
    tipAt.current = id
  })

  /** Close the open card with its closing animation; `focusMap` when the user closed it from the card. */
  const closePopup = useEffectEvent((focusMap: boolean) => {
    const map = mapRef.current
    const popup = popupRef.current
    popupRef.current = null
    if (map && map.getSource(SOURCE.checkpoints)) {
      for (const id of selectedRef.current) map.setFeatureState({ source: SOURCE.checkpoints, id }, { selected: false })
    }
    selectedRef.current = []
    if (popup) dismiss(popup)
    if (focusMap) map?.getCanvas().focus({ preventScroll: true }) // the phone page mustn't jump
  })

  /** Open the card for the checkpoints a click lists (stopsAt), anchored at the first. A card already open
   * closes as this one opens, each with its animation. */
  const openPopup = useEffectEvent((stops: { route: number; index: number }[]) => {
    const map = mapRef.current
    const routes = shown.current?.plan.routes
    if (!map || !routes || stops.length === 0) return
    hideTip() // the card says the same, and more
    const ids = stops.map(stop => checkpointId(stop.route, stop.index))
    // Already open: a second click changes nothing.
    if (popupRef.current && ids.length === selectedRef.current.length && ids.every((id, i) => id === selectedRef.current[i])) return
    closePopup(false)
    const first = routes[stops[0].route].checkpoints[stops[0].index]
    const popup = new Popup({
      maxWidth: 'min(300px, calc(100vw - 32px))',
      offset: 12,
      focusAfterOpen: false, // focused below, once the card is in view
      closeButton: false, // the card has its own, so closing can animate
      closeOnClick: false, // map clicks are handled below
      className: `cp-popup cp-level-${first.level ?? 'none'}`, // the tip takes the first section's colour
    })
    // A card that is already closing ignores its close button and Escape: they would close its successor.
    const close = () => {
      if (popupRef.current === popup) closePopup(true)
    }
    const container = map.getContainer()
    const card = checkpointCard(
      stops.map(stop => ({ route: routes[stop.route], index: stop.index })),
      close,
    )
    // A long list scrolls inside the card. Set before the card is placed: MapLibre picks the side of the
    // dot it hangs on from its height.
    const maxHeight = stops.length > 1 ? stackMaxHeight(visibleArea(container)) : null
    if (maxHeight !== null) card.style.maxHeight = `${maxHeight}px`
    popup.setLngLat([first.lon, first.lat]).setDOMContent(card).addTo(map)
    popupRef.current = popup
    selectedRef.current = ids
    for (const id of ids) map.setFeatureState({ source: SOURCE.checkpoints, id }, { selected: true })
    const element = popup.getElement()
    if (!element) return
    element.addEventListener('keydown', event => {
      if (event.key === 'Escape') close()
    })
    const controls = container.querySelectorAll('.maplibregl-ctrl-top-right .maplibregl-ctrl')
    const shift = cardShift(
      element.getBoundingClientRect(),
      visibleArea(container),
      [...obstacles(), ...controls].map(obstacle => obstacle.getBoundingClientRect()),
    )
    if (shift.x !== 0 || shift.y !== 0) map.panBy([-shift.x, -shift.y], { duration: 250 })
    element.querySelector<HTMLElement>('.cp-close')?.focus({ preventScroll: true })
  })

  const fitTo = useEffectEvent((bounds: LngLatBoundsLike, animate: boolean) => {
    const map = mapRef.current
    if (!map) return
    map.fitBounds(bounds, { padding: fitPadding(map, padding()), maxZoom: 10, linear: true, duration: 700, animate })
  })

  /** Draw each route's truck where it is at `time`, or none. */
  const drawTrucks = useEffectEvent((time: number | null) => {
    const current = shown.current
    truckTime.current = time
    const data = time !== null && current ? truckFeatures(current.tracks, time) : EMPTY
    mapRef.current?.getSource<GeoJSONSource>(SOURCE.trucks)?.setData(data)
  })

  /** Drive the trucks along their routes to where they are at `target`, a step a frame, so they turn with
   * the road on the way. At once for a new plan, or when the system asks for reduced motion. */
  const driveTrucks = useEffectEvent((target: number | null) => {
    cancelAnimationFrame(truckFrame.current)
    if (target !== null && target === truckTime.current) return
    if (target === null || truckTime.current === null || prefersReducedMotion()) {
      drawTrucks(target)
      return
    }
    let last = performance.now()
    const step = () => {
      const now = performance.now()
      const time = approach(truckTime.current ?? target, target, now - last)
      last = now
      drawTrucks(time)
      if (time !== target) truckFrame.current = requestAnimationFrame(step)
    }
    truckFrame.current = requestAnimationFrame(step)
  })

  /** Show the slider's hour: colour the heat cells, setting only those whose level changed, and drive
   * each route's truck to where it is then. */
  const showHour = useEffectEvent(() => {
    const map = mapRef.current
    const current = shown.current
    const levels = current?.plan.heatmap.levels
    if (!map || !current || lost.current || !levels || levels.length === 0) return
    const to = Math.min(Math.max(0, hour.get()), levels.length - 1)
    for (const [cell, lvl] of heatChanges(levels, heatHour.current, to)) {
      map.setFeatureState({ source: SOURCE.heat, id: heatBase.current + cell }, { lvl })
    }
    heatHour.current = to
    const { heatmap } = current.plan
    driveTrucks(hasSlider(heatmap) ? Date.parse(heatmap.hours[to]) : null)
  })

  /** Put the shown plan on the map: its data, the dots' sizes for its spacing, the spotlight, and the
   * slider's hour (heat squares and trucks). */
  const drawPlan = useEffectEvent(() => {
    const map = mapRef.current
    if (!map) return
    const current = shown.current
    heatHour.current = null
    const set = (source: string, value: GeoJSON.FeatureCollection | null) =>
      map.getSource<GeoJSONSource>(source)?.setData(value ?? EMPTY)
    set(SOURCE.heat, current ? heatCells(current.plan.heatmap, heatBase.current) : null)
    set(SOURCE.routes, current?.data.routes ?? null)
    set(SOURCE.solo, current?.data.solo ?? null)
    set(SOURCE.plates, current?.data.plates ?? null)
    set(SOURCE.checkpoints, current?.data.checkpoints ?? null)
    set(SOURCE.ends, current?.data.ends ?? null)
    set(SOURCE.trucks, null) // placed by showHour below
    if (current) {
      applyDotZooms(map, current.data.dots)
      applySpotlight(map, current.plan, spotlight)
      showHour()
    }
  })

  const showPlan = useEffectEvent((next: Plan | null, nextData: PlanData | null) => {
    const map = mapRef.current
    if (!map) return
    closePopup(false)
    hideTip()
    cancelAnimationFrame(truckFrame.current)
    truckTime.current = null // a new plan's trucks start where they are, without driving there
    // The old squares keep drawing until MapLibre has rebuilt the heat tiles: with ids of their own,
    // they keep their own colours meanwhile instead of taking the new plan's by index.
    heatBase.current = heatBase.current === 0 ? HEAT_ID_SPAN : 0
    shown.current = next && nextData ? { plan: next, data: nextData, tracks: next.routes.map(truckTrack) } : null
    if (!lost.current) {
      // Without its graphics the map has no style: the plan is drawn once they are back (restore).
      for (const source of PLAN_SOURCES) map.removeFeatureState({ source })
      drawPlan()
    }
    if (nextData) fitTo(nextData.bounds, true)
  })

  /** The map has its graphics back, and MapLibre has rebuilt its style from a copy: with each source's
   * data, but without the feature-state that colours the heat squares, lights the spotlighted route and
   * its truck, and rings the dots the open card lists. Draw the plan again (in full, as one may have
   * arrived meanwhile), with those. */
  const restore = useEffectEvent(() => {
    const map = mapRef.current
    lost.current = false
    if (!map) return
    truckTime.current = null // the trucks go straight to the slider's hour
    drawPlan()
    for (const id of selectedRef.current) map.setFeatureState({ source: SOURCE.checkpoints, id }, { selected: true })
  })

  useEffect(() => {
    const element = container.current!
    let map: MapLibreMap
    try {
      map = new MapLibreMap({
        container: element,
        style: STYLE_URL,
        center: [-96, 38],
        zoom: 3,
        minZoom: 2,
        maxPitch: 0,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        renderWorldCopies: false,
        fadeDuration: prefersReducedMotion() ? 0 : 300,
        // The built-in GPU is plenty for a flat map. Asking for the faster one (MapLibre's default) makes
        // laptops with two GPUs switch between them, and the first frame after an idle spell stalls.
        canvasContextAttributes: { powerPreference: 'low-power' },
        locale: { 'Map.Title': 'Map of routes, checkpoints and weather risk' },
        attributionControl: { compact: false, customAttribution: ATTRIBUTION },
      })
    } catch (error) {
      // oxlint-disable-next-line react/set-state-in-effect -- the map could not start: an external failure to show
      setProblem(error instanceof GPUInitializationError ? NO_WEBGL : NO_BASEMAP)
      return
    }
    mapRef.current = map
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    map.touchZoomRotate.disableRotation()
    map.keyboard.disableRotation()
    if (!shown.current) fitTo(LOWER_48, false)

    // The base map counts as failed if its style never loads, or if not one tile arrives. A failed
    // sprite or a few failed tiles still leave a usable map.
    let styled = false
    let tiles = false
    map.on('style.load', () => {
      styled = true
      if (lost.current) restore()
    })
    // The browser can take the map's WebGL context away (after sleep, a GPU switch or with too many tabs
    // open) and later give it back. Meanwhile the map has no style; MapLibre then rebuilds it from a copy,
    // and 'style.load' above draws the plan's colours and highlights again.
    map.on('webglcontextlost', () => {
      lost.current = true
      cancelAnimationFrame(truckFrame.current)
    })
    map.on('webglcontextrestored', () => {
      if (!styled) map.setStyle(STYLE_URL) // MapLibre keeps no copy of a style that hadn't loaded yet
    })
    map.on('sourcedata', event => {
      if (event.tile && !tiles) {
        tiles = true
        setProblem(current => (current === NO_BASEMAP ? null : current))
      }
    })
    map.on('load', () => {
      if (!tiles) setProblem(NO_BASEMAP)
      addPlanLayers(map)
      setReady(true)
    })
    map.on('error', event => {
      console.error(event.error) // listening stops MapLibre logging errors itself; keep them visible
      if (!styled) setProblem(NO_BASEMAP)
    })
    map.on('click', event => {
      const touch = 'pointerType' in event.originalEvent && event.originalEvent.pointerType === 'touch'
      const stops = stopsAt(event.point, touch)
      if (stops.length > 0) openPopup(stops)
      else closePopup(false)
    })
    let frame = 0
    const hover = window.matchMedia('(hover: hover)') // a mouse or trackpad; on touch screens a tap opens the card
    map.on('mousemove', event => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const hit = pick(event.point, false)
        map.getCanvas().style.cursor = hit ? 'pointer' : ''
        showTip(hover.matches && event.originalEvent.buttons === 0 ? hit : null) // none while a button is held
      })
    })
    // A press can start a drag, and MapLibre sends no mousemove until the drag ends: hide the label at once.
    const leave = () => {
      cancelAnimationFrame(frame)
      hideTip()
    }
    map.on('mousedown', leave)
    map.on('mouseout', leave)

    // The dock and the phone's slider card sit above the attribution, whose height varies.
    const region = element.closest<HTMLElement>('.map-region')
    const attribution = element.querySelector('.maplibregl-ctrl-bottom-right')
    const observer = new ResizeObserver(([entry]) => {
      region?.style.setProperty('--attrib-h', `${Math.ceil(entry.contentRect.height)}px`)
    })
    if (attribution) observer.observe(attribution)

    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      cancelAnimationFrame(truckFrame.current)
      popupRef.current?.remove()
      popupRef.current = null
      selectedRef.current = []
      tipRef.current?.remove()
      tipRef.current = null
      tipAt.current = null
      map.remove()
      mapRef.current = null
      setReady(false)
    }
  }, [])

  useEffect(() => {
    if (ready) showPlan(plan, data)
  }, [plan, data, ready])

  // The slider can move many times a frame: draw only the latest hour, once per frame.
  useEffect(() => {
    let frame = 0
    const unsubscribe = hour.subscribe(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => showHour())
    })
    return () => {
      unsubscribe()
      cancelAnimationFrame(frame)
    }
  }, [hour])

  useEffect(() => {
    const map = mapRef.current
    const current = shown.current
    if (!ready || !map || !current || current.plan !== plan) return
    const frame = requestAnimationFrame(() => {
      if (!lost.current) applySpotlight(map, current.plan, spotlight) // else drawn when the graphics are back
    })
    return () => cancelAnimationFrame(frame)
  }, [spotlight, plan, ready])

  useEffect(() => {
    const gestures = mapRef.current?.cooperativeGestures
    if (stacked) gestures?.enable()
    else gestures?.disable()
  }, [stacked])

  return (
    <div className="map-frame">
      <div className="map" ref={container} />
      {/* The live region exists from the start, so a problem shown later is announced. */}
      <div role="status">{problem && <p className="map-problem">{problem}</p>}</div>
    </div>
  )
})

/** One route drawn strongest: the one pointed at (the others fade), or by default the recommended one. */
function applySpotlight(map: MapLibreMap, plan: Plan, pointedAt: string | null): void {
  const spotlight = plan.routes.some(route => route.id === pointedAt) ? pointedAt : null
  plan.routes.forEach((route, r) => {
    const spot = spotlight === null ? route.recommended : route.id === spotlight
    const dim = spotlight !== null && route.id !== spotlight
    for (const source of [SOURCE.routes, SOURCE.solo, SOURCE.plates, SOURCE.trucks]) map.setFeatureState({ source, id: r }, { spot, dim })
    const dotSpot = spotlight !== null && route.id === spotlight
    route.checkpoints.forEach((_, i) => {
      map.setFeatureState({ source: SOURCE.checkpoints, id: checkpointId(r, i) }, { spot: dotSpot, dim })
    })
  })
}

const CLOSE_MS = 140 // just over the card's 130 ms closing animation (index.css: cp-fade-out, cp-shrink)
// px between two dots' centres for a click to list both: about a full-size dot's radius, so one mostly
// covers the other. Dots further apart can each be clicked on their own.
const SAME_PLACE = 6

/** Remove a card after its closing animation; at once when motion is reduced. */
function dismiss(popup: Popup): void {
  const element = popup.getElement()
  if (!element || prefersReducedMotion()) {
    popup.remove()
    return
  }
  element.classList.add('is-closing')
  window.setTimeout(() => popup.remove(), CLOSE_MS)
}

/** A checkpoint the open card lists: its route's index in the plan, and its own index on the route. */
interface Stop {
  route: number
  index: number
}

function isBetter(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/** The requested padding, shrunk if it would leave less than a quarter of the map to fit into. */
function fitPadding(map: MapLibreMap, wanted: Padding): Padding {
  const { clientWidth: width, clientHeight: height } = map.getContainer()
  const shrinkX = Math.min(1, (width * 0.75) / Math.max(1, wanted.left + wanted.right))
  const shrinkY = Math.min(1, (height * 0.75) / Math.max(1, wanted.top + wanted.bottom))
  return {
    top: wanted.top * shrinkY,
    bottom: wanted.bottom * shrinkY,
    left: wanted.left * shrinkX,
    right: wanted.right * shrinkX,
  }
}
