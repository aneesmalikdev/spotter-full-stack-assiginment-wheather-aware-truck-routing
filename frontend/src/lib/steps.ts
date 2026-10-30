import type { PlanRequest } from '../api/types'
import { formatPounds } from './format'

/** What the server does with a plan request, in order, for the Plan routes button. The answer comes
 * back in one piece, so the page can't see which step is running: the steps advance on a timer
 * (STEP_MS in components/Status.tsx) and stop at the last one rather than looping. */
export function planningSteps(request: Pick<PlanRequest, 'interval_miles' | 'load_lb'>): string[] {
  // Each fits the 14em label slot on the button (index.css: .button-step), so none is cut off, even on a
  // 320 px phone. The widest, "Scoring risk for 200,000 lb…", is 219 px.
  return [
    'Looking up your places…',
    'Asking TomTom for routes…',
    'Finding up to 3 routes…',
    `Checkpoints every ${request.interval_miles} mi…`,
    'Forecasts at each ETA…',
    `Scoring risk for ${formatPounds(request.load_lb)}…`,
    'Ranking the routes…',
  ]
}
