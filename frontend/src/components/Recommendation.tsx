import type { Ref } from 'react'
import type { Plan, Route } from '../api/types'
import { formatDuration, formatWholeMiles } from '../lib/format'
import { formatDayTime } from '../lib/time'
import type { Why } from '../lib/why'
import { Diamond, NoDataDot, Octagon, Plate } from './signs'

interface Props {
  plan: Plan
  why: Why | null
  headingRef: Ref<HTMLHeadingElement>
}

/** The answer: which route to take, or that travel is not advised, and why. */
export function Recommendation({ plan, why, headingRef }: Props) {
  const route = plan.routes.find(r => r.id === plan.recommendation.route_id) ?? plan.routes[0]
  const warnings = plan.recommendation.warnings
  const withData = plan.routes.filter(r => r.summary.average_risk !== null).length

  if (route.summary.average_risk === null) {
    return (
      <section className="answer answer-unknown" aria-labelledby="answer-heading">
        <h2 id="answer-heading" className="answer-flag" tabIndex={-1} ref={headingRef}>
          <NoDataDot className="answer-flag-icon" />
          Weather risk unknown
        </h2>
        <RouteLine route={route} lead="Fastest route" plate="plate-rec" />
        {warnings.map(text => (
          <p key={text} className="answer-note">
            {text}
          </p>
        ))}
      </section>
    )
  }

  if (route.summary.unsafe) {
    const lead = plan.routes.length === 1 ? 'Only route found' : withData === 1 ? 'Only route with forecast data' : 'Least bad option'
    return (
      <section className="answer answer-unsafe" aria-labelledby="answer-heading">
        <h2 id="answer-heading" className="answer-flag" tabIndex={-1} ref={headingRef}>
          <Octagon className="answer-flag-icon" />
          No travel advised
        </h2>
        {warnings.map(text => (
          <p key={text} className="answer-note">
            <Octagon />
            {text}
          </p>
        ))}
        <RouteLine route={route} lead={lead} plate="plate-inverse" />
        {why && lead === 'Least bad option' && <p className="answer-why">{why.text}</p>}
      </section>
    )
  }

  return (
    <section className="answer" aria-labelledby="answer-heading">
      <div className="answer-head">
        <Plate letter={route.id} recommended size="headline" />
        <div>
          <h2 id="answer-heading" className="answer-title" tabIndex={-1} ref={headingRef}>
            Take Route {route.id}
          </h2>
          <p className="answer-arrival">Arrives {formatDayTime(route.arrival)}</p>
          <p className="answer-trip">
            {formatDuration(route.travel_time_s)}, {formatWholeMiles(route.distance_miles)}
          </p>
        </div>
      </div>
      {why && <p className="answer-why">{why.text}</p>}
      {warnings.map(text => (
        <p key={text} className="answer-note">
          <Diamond />
          {text}
        </p>
      ))}
    </section>
  )
}

/** "Least bad option: Route B, arrives Sun, 7:06 PM CDT" and its drive time and distance. */
function RouteLine({ route, lead, plate }: { route: Route; lead: string; plate: 'plate-rec' | 'plate-inverse' }) {
  return (
    <div className="answer-route">
      <span className={`plate plate-board ${plate}`} aria-hidden="true">
        {route.id}
      </span>
      <div>
        <p className="answer-route-name">
          {lead}: Route {route.id}, arrives {formatDayTime(route.arrival)}
        </p>
        <p className="answer-trip">
          {formatDuration(route.travel_time_s)}, {formatWholeMiles(route.distance_miles)}
        </p>
      </div>
    </div>
  )
}
