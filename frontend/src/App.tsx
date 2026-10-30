import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PlanError, UNAVAILABLE, requestPlan } from './api/client'
import type { FieldErrors, FieldName, Plan } from './api/types'
import { HeatSlider } from './components/HeatSlider'
import { MapKey } from './components/MapKey'
import { Notes } from './components/Notes'
import { Recommendation } from './components/Recommendation'
import { RouteBoard, type Pointer } from './components/RouteBoard'
import { LoadingStatus, READY_AGAIN, RequestError, SLOW_AFTER_MS, STILL_WORKING, WORKING } from './components/Status'
import { TripForm } from './components/TripForm'
import { TripSummary } from './components/TripSummary'
import { type FormValues, toRequest, validate } from './lib/form'
import { createHourStore } from './lib/hourStore'
import { planningSteps } from './lib/steps'
import { defaultDeparture } from './lib/time'
import { FLOATING_LAYOUT, prefersReducedMotion, useMediaQuery } from './lib/useMediaQuery'
import { explainChoice } from './lib/why'
import { hasSlider } from './map/heat'
import { type Padding, RouteMap } from './map/RouteMap'

const MAX_COUNTDOWN_S = 120 // longer waits get the message only
const FIELD_OF: Record<keyof FormValues, FieldName> = {
  origin: 'origin',
  destination: 'destination',
  departure: 'departure',
  load: 'load_lb',
  interval: 'interval_miles',
}
const VALUE_OF = Object.fromEntries(Object.entries(FIELD_OF).map(([key, field]) => [field, key])) as Record<
  FieldName,
  keyof FormValues
>

interface Failure {
  message: string
  retryAt: number | null
}

/** Read when needed (fitting, popups), not tracked: React state for this is only for rendering. */
function isFloating(): boolean {
  return window.matchMedia(FLOATING_LAYOUT).matches
}

export default function App() {
  const floating = useMediaQuery(FLOATING_LAYOUT)
  const [values, setValues] = useState<FormValues>(() => ({
    origin: '',
    destination: '',
    departure: defaultDeparture(new Date()),
    load: '',
    interval: 25,
  }))
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failure, setFailure] = useState<Failure | null>(null)
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null)
  const [busySince, setBusySince] = useState<number | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [pinned, setPinned] = useState<string | null>(null)
  const [pointed, setPointed] = useState<Record<Pointer, string | null>>({ hover: null, focus: null })
  const [slow, setSlow] = useState(false) // the plan has taken over 25 s
  const [retryReady, setRetryReady] = useState(false) // a rate-limit wait just ended
  const [planCount, setPlanCount] = useState(0) // remounts the results, so each new plan animates in
  const [steps, setSteps] = useState<string[]>([]) // what the Plan routes button says while busy
  const [hour] = useState(createHourStore) // the heatmap slider's hour, shared with the map

  const panelRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const sliderRef = useRef<HTMLDivElement>(null) // on phones a card over the bottom of the map
  const regionRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const pendingFocus = useRef<'errors' | 'heading' | 'origin' | null>(null)
  const latestValues = useRef(values) // for answers that arrive after the user edited the form

  const busy = busySince !== null
  const why = useMemo(() => (plan ? explainChoice(plan.routes) : null), [plan])
  const spotlight = pointed.hover ?? pointed.focus ?? pinned
  const heat = plan !== null && hasSlider(plan.heatmap)

  useEffect(() => {
    if (blockedUntil === null) return
    const timer = window.setTimeout(() => {
      setBlockedUntil(null)
      setRetryReady(true)
    }, Math.max(0, blockedUntil - Date.now()))
    return () => window.clearTimeout(timer)
  }, [blockedUntil])

  useEffect(() => {
    if (busySince === null) return
    const timer = window.setTimeout(() => setSlow(true), Math.max(0, busySince + SLOW_AFTER_MS - Date.now()))
    return () => window.clearTimeout(timer)
  }, [busySince])

  // Move focus once the elements it goes to have rendered.
  useEffect(() => {
    const target = pendingFocus.current
    if (target === null) return
    pendingFocus.current = null
    if (target === 'errors') document.querySelector<HTMLElement>('#trip-form [aria-invalid="true"]')?.focus()
    if (target === 'origin') document.getElementById('origin')?.focus()
    if (target === 'heading' && headingRef.current) {
      headingRef.current.focus({ preventScroll: true })
      headingRef.current.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    }
  })

  const submit = async () => {
    if (busy || blockedUntil !== null) return
    const sent = values
    const problems = validate(sent, new Date())
    setErrors(problems)
    setFailure(null)
    setRetryReady(false)
    if (Object.keys(problems).length > 0) {
      pendingFocus.current = 'errors'
      return
    }
    const request = toRequest(sent)
    setSteps(planningSteps(request))
    setSlow(false)
    setBusySince(Date.now())
    try {
      const next = await requestPlan(request)
      hour.set(0) // each plan's heatmap starts at departure
      setPlan(next)
      setPlanCount(count => count + 1)
      setPinned(null)
      setPointed({ hover: null, focus: null }) // the rows they pointed at may be gone
      setFormOpen(false)
      pendingFocus.current = 'heading'
    } catch (error) {
      if (error instanceof PlanError && Object.keys(error.fields).length > 0) {
        // Keep only errors about values still in the form; the user may have fixed one while waiting.
        const current = Object.entries(error.fields).filter(
          ([field]) => sent[VALUE_OF[field as FieldName]] === latestValues.current[VALUE_OF[field as FieldName]],
        )
        if (current.length > 0) {
          setErrors(Object.fromEntries(current))
          setFormOpen(true) // the messages are in the form, which "Change trip" may have folded meanwhile
          pendingFocus.current = 'errors'
        }
      } else if (error instanceof PlanError) {
        const wait = error.retryAfterS
        const retryAt = wait !== null && wait <= MAX_COUNTDOWN_S ? Date.now() + wait * 1000 : null
        setFailure({ message: error.message, retryAt })
        setBlockedUntil(retryAt)
      } else {
        setFailure({ message: UNAVAILABLE, retryAt: null })
      }
    } finally {
      setBusySince(null)
    }
  }

  /** New form values; an edited field's error goes away until the next submit. */
  const changeValues = (next: FormValues) => {
    const changed = (Object.keys(next) as (keyof FormValues)[]).filter(key => next[key] !== values[key])
    setErrors(current => {
      if (!changed.some(key => current[FIELD_OF[key]])) return current
      const remaining = { ...current }
      for (const key of changed) delete remaining[FIELD_OF[key]]
      return remaining
    })
    latestValues.current = next
    setValues(next)
  }

  const toggleForm = () => {
    if (!formOpen) pendingFocus.current = 'origin'
    setFormOpen(!formOpen)
  }

  const point = useCallback((pointer: Pointer, route: string | null) => {
    setPointed(current => (current[pointer] === route ? current : { ...current, [pointer]: route }))
  }, [])

  const pin = useCallback((route: string | null) => {
    setPinned(route)
    const frame = regionRef.current?.querySelector('.map-frame')
    if (route === null || isFloating() || !frame) return
    const rect = frame.getBoundingClientRect()
    const visible = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
    if (visible < rect.height / 2) frame.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [])

  /** Room to leave around fitted routes: the panel, the dock, the slider and the attribution cover parts of the map. */
  const padding = useCallback((): Padding => {
    const region = regionRef.current
    const attribution = region ? parseFloat(getComputedStyle(region).getPropertyValue('--attrib-h')) || 24 : 24
    if (!isFloating()) {
      const slider = sliderRef.current ? sliderRef.current.offsetHeight + 6 : 0 // it sits 6 px above the attribution
      return { top: 40, right: 56, bottom: slider + attribution + 16, left: 40 } // room for a plate (31 px)
    }
    const panelWidth = panelRef.current?.offsetWidth ?? 380
    const dockHeight = dockRef.current?.offsetHeight ?? 0
    return { top: 56, right: 72, bottom: dockHeight + attribution + 32, left: 12 + panelWidth + 48 }
  }, [])

  /** What floats over the map: the panel and the dock's card (not the dock's empty strip around it), or on
   *  phones the slider card. */
  const obstacles = useCallback((): Element[] => {
    const floating = isFloating() ? [panelRef.current, ...(dockRef.current?.children ?? [])] : [sliderRef.current]
    return floating.filter((element): element is Element => element !== null)
  }, [])

  const announcement = busy ? (slow ? STILL_WORKING : WORKING) : retryReady ? READY_AGAIN : ''

  return (
    <main className="app">
      <div className="panel" ref={panelRef}>
        <header className="panel-section">
          <h1>Weather-Aware Truck Routing</h1>
          {!plan && (
            <p className="intro">
              Compare up to three truck routes by the wind, rain and snow forecast for the time the truck reaches each
              stretch of road.
            </p>
          )}
        </header>
        <div className="panel-section">
          {plan && <TripSummary plan={plan} formOpen={formOpen} onToggle={toggleForm} />}
          {(!plan || formOpen) && (
            <TripForm
              values={values}
              errors={errors}
              busySince={busySince}
              steps={steps}
              blocked={blockedUntil !== null}
              onChange={changeValues}
              onSubmit={submit}
            />
          )}
          {busySince !== null && <LoadingStatus startedAt={busySince} slow={slow} />}
          {/* Always present, so screen readers announce changes to it. */}
          <p className="visually-hidden" role="status">
            {announcement}
          </p>
          {failure && <RequestError message={failure.message} retryAt={failure.retryAt} />}
        </div>
        {plan && (
          <div key={planCount} className={`results${busy ? ' is-stale' : ''}`} inert={busy} aria-busy={busy || undefined}>
            <div className="panel-section">
              <Recommendation plan={plan} why={why} headingRef={headingRef} />
            </div>
            {plan.warnings.length > 0 && (
              <div className="panel-section">
                <Notes warnings={plan.warnings} />
              </div>
            )}
            <div className="panel-section">
              <RouteBoard
                plan={plan}
                why={why}
                spotlight={spotlight ?? plan.recommendation.route_id}
                pinned={pinned}
                onPoint={point}
                onPin={pin}
              />
            </div>
          </div>
        )}
      </div>
      <section className="map-region" aria-label="Map" ref={regionRef}>
        <RouteMap plan={plan} spotlight={spotlight} stacked={!floating} hour={hour} padding={padding} obstacles={obstacles} />
        {plan && (
          <div className="dock" ref={dockRef}>
            {/* Desktop: one card, the slider over the key. Phones: the slider floats over the map's
                bottom and the key follows the map (index.css). */}
            <div className="dock-card">
              {heat && (
                <div className="slider-card" ref={sliderRef}>
                  <HeatSlider heatmap={plan.heatmap} hour={hour} />
                </div>
              )}
              <MapKey heat={heat} />
            </div>
          </div>
        )}
      </section>
    </main>
  )
}
