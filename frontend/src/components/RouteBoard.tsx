import type { KeyboardEvent, ReactNode } from 'react'
import type { Plan, Route } from '../api/types'
import { formatAverageRisk, formatBoardMiles, formatDuration, formatRiskMiles, formatWholeMiles } from '../lib/format'
import { formatDayTime } from '../lib/time'
import type { Column, Why } from '../lib/why'
import { NoDataDot, Octagon, Plate } from './signs'

export type Pointer = 'hover' | 'focus'

interface Props {
  plan: Plan
  why: Why | null
  spotlight: string // the route drawn strongest on the map
  pinned: string | null
  onPoint: (pointer: Pointer, route: string | null) => void
  onPin: (route: string | null) => void
}

/** The levels whose miles rank the routes, in ranking order, and the map colour each is tinted with. */
const MILE_MEASURES = [
  { key: 'no_travel', label: 'No Travel', level: 4 },
  { key: 'severe', label: 'Severe', level: 3 },
  { key: 'high', label: 'High', level: 2 },
] as const

/** The routes compared in the order they are ranked; each row spotlights its route on the map. */
export function RouteBoard({ plan, why, spotlight, pinned, onPoint, onPin }: Props) {
  const routes = [...plan.routes].sort((a, b) => a.rank - b.rank)
  const withData = plan.routes.filter(r => r.summary.average_risk !== null).length
  // explainChoice compares the first two routes in rank order, so these are the pair the mark is about.
  const decided = why?.column ?? null
  const [first, second] = routes
  const unpinOnEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && pinned !== null) {
      event.stopPropagation()
      onPin(null)
    }
  }

  return (
    <section className="board" aria-labelledby="board-heading">
      <h2 id="board-heading">Routes</h2>
      <p className="caption">
        Miles at each risk level when the truck gets there. Best route first: fewest No Travel, Severe and High miles, then
        lowest average risk, then shortest drive.
      </p>
      {decided && second && (
        // A key to a visual mark; the sentence under the recommendation says the same in words.
        <p className="board-key" aria-hidden="true">
          The <span className="board-key-mark">outlined</span> measure put Route {first.id} ahead of Route {second.id}.
        </p>
      )}
      <ul
        className="board-rows"
        role="list"
        onKeyDown={unpinOnEscape}
        // A hover ends when the mouse leaves the list, not a row: between two rows it crosses a divider that
        // belongs to neither, and letting go of the spotlight there would make the map flicker.
        onPointerLeave={event => {
          if (event.pointerType === 'mouse') onPoint('hover', null)
        }}
      >
        {routes.map(route => (
          <li key={route.id}>
            <button
              type="button"
              className={`board-row${route.id === spotlight ? ' is-spot' : ''}`}
              aria-pressed={pinned === route.id}
              // Only a resting mouse and keyboard focus spotlight a row. A tap leaves a sticky hover,
              // and Chrome focuses a clicked button, so either would stop a second click from unpinning.
              onPointerEnter={event => {
                if (event.pointerType === 'mouse') onPoint('hover', route.id)
              }}
              onFocus={event => {
                if (event.currentTarget.matches(':focus-visible')) onPoint('focus', route.id)
              }}
              onBlur={() => onPoint('focus', null)}
              onClick={() => onPin(pinned === route.id ? null : route.id)}
            >
              <RouteRow
                route={route}
                recommended={route.id === plan.recommendation.route_id}
                routesWithData={withData}
                decided={decided}
              />
            </button>
          </li>
        ))}
      </ul>
      <p className="footnote">
        Avg risk is mile-weighted, from 0 (Low) to 4 (No Travel). Unsafe means some No Travel miles. A checkpoint’s risk is
        the worst of its wind, rain and snow; loads over 30,000 lb lower the wind limits. ETAs and drive times assume
        non-stop driving with the truck limited to 68 mph.
      </p>
    </section>
  )
}

interface RowProps {
  route: Route
  recommended: boolean
  routesWithData: number
  decided: Column | null
}

/** The plate, pills and trip; the five ranking measures, each under its own label; then Moderate and No data miles. */
function RouteRow({ route, recommended, routesWithData, decided }: RowProps) {
  const { miles_by_level: miles, average_risk: average, unsafe } = route.summary
  const hasData = average !== null
  const leastBad = recommended && unsafe && routesWithData >= 2
  const plainRecommended = recommended && !unsafe && hasData // with no data, the headline says "Fastest route"

  return (
    <>
      <span className="board-route">
        <Plate letter={route.id} recommended={recommended} size="board" />
        <span className="board-route-text">
          <span className="visually-hidden">Route {route.id}. </span>
          {plainRecommended && <Pill className="pill-rec">Recommended</Pill>}
          {leastBad && <Pill className="pill-outline">Least bad</Pill>}
          {unsafe && (
            <Pill className="pill-unsafe">
              <Octagon className="pill-icon" />
              Unsafe
            </Pill>
          )}
          <span className="board-trip">
            {formatWholeMiles(route.distance_miles)}, arrives {formatDayTime(route.arrival)}
            <span className="visually-hidden">. </span>
          </span>
        </span>
      </span>
      <span className="measures">
        {hasData ? (
          <>
            {MILE_MEASURES.map(({ key, label, level }) => (
              <Measure
                key={key}
                label={label}
                spoken={`${label} miles`}
                className={miles[key] === 0 ? 'is-zero' : `is-level-${level}`}
                decided={decided === key}
              >
                {formatBoardMiles(miles[key])}
              </Measure>
            ))}
            <Measure
              label="Avg risk"
              spoken="average risk"
              className={average === 0 ? 'is-zero' : ''}
              decided={decided === 'average_risk'}
            >
              {formatAverageRisk(average)}
            </Measure>
          </>
        ) : (
          <Measure label="Weather risk" spoken="weather risk:" className="measure-nodata">
            <NoDataDot className="measure-icon" />
            No data
          </Measure>
        )}
        <Measure label="Drive" spoken="drive time" className="measure-drive" decided={decided === 'drive'} end=". ">
          <Duration seconds={route.travel_time_s} />
        </Measure>
      </span>
      {(miles.moderate > 0 || (hasData && miles.no_data > 0)) && (
        <span className="board-extra">
          {miles.moderate > 0 && (
            <span>
              <span className="dot dot-1" aria-hidden="true" />
              Moderate {formatRiskMiles(miles.moderate)} mi<span className="visually-hidden">. </span>
            </span>
          )}
          {hasData && miles.no_data > 0 && (
            <span>
              <NoDataDot className="dot-icon" />
              No data {formatRiskMiles(miles.no_data)} mi<span className="visually-hidden">. </span>
            </span>
          )}
        </span>
      )}
    </>
  )
}

interface MeasureProps {
  label: string
  spoken: string // what a screen reader hears before the value, in place of the label
  className?: string // is-zero, is-level-2 to 4, measure-nodata or measure-drive
  decided?: boolean // the measure that decided the pick: outlined
  end?: string // the pause a screen reader makes after the value
  children: ReactNode
}

/** One ranking measure: its label right over its value, in the same column on every row. */
function Measure({ label, spoken, className = '', decided = false, end = ', ', children }: MeasureProps) {
  return (
    <span className={['measure', className, decided && 'is-decided'].filter(Boolean).join(' ')}>
      <span className="measure-label" aria-hidden="true">
        {label}
      </span>
      <span className="measure-value">
        <span className="visually-hidden">{spoken} </span>
        {children}
        <span className="visually-hidden">{end}</span>
      </span>
    </span>
  )
}

/** A status pill, then a pause for a screen reader. */
function Pill({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className={`pill ${className}`}>
      {children}
      <span className="visually-hidden">, </span>
    </span>
  )
}

/** "22 h 4 min" with the units in smaller type, so the numbers lead. */
function Duration({ seconds }: { seconds: number }) {
  const parts = formatDuration(seconds).split(' ') // ['22', 'h', '4', 'min'] or ['45', 'min']
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 0 ? (
          part
        ) : (
          <span key={i} className="measure-unit">
            {i < parts.length - 1 ? ` ${part} ` : ` ${part}`}
          </span>
        ),
      )}
    </>
  )
}
