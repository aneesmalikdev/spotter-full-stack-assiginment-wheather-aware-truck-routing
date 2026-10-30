import type { Plan } from '../api/types'
import { formatPounds } from '../lib/format'
import { formatDateTime } from '../lib/time'

/** The planned trip, in the form's words, with a button that reopens the form. */
export function TripSummary({ plan, formOpen, onToggle }: { plan: Plan; formOpen: boolean; onToggle: () => void }) {
  return (
    <div className="summary">
      <dl className="summary-list">
        <dt>From</dt>
        <dd className="summary-place">{plan.origin.name}</dd>
        <dt>To</dt>
        <dd className="summary-place">{plan.destination.name}</dd>
        <dt>Departure</dt>
        <dd>{formatDateTime(plan.departure)}</dd>
        <dt>Load</dt>
        <dd>
          {formatPounds(plan.load_lb)}, weather every {plan.interval_miles} mi
        </dd>
      </dl>
      <button type="button" className="button-secondary summary-change" aria-expanded={formOpen} aria-controls="trip-form" onClick={onToggle}>
        Change trip
      </button>
    </div>
  )
}
