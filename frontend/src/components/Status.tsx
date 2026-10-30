import { useEffect, useState } from 'react'
import { SIDE_TRUCK } from '../lib/truckShape'
import { Bang, Truck } from './signs'

export const SLOW_AFTER_MS = 25_000
export const STEP_MS = 2_000
export const WORKING = 'Finding routes and checking the forecast. This usually takes 8 to 20 seconds.'
export const STILL_WORKING = 'Still working. Long trips can take up to a minute.'
/** STILL_WORKING's visible form: short enough for one line beside the seconds on a 320 px phone. */
export const SLOW_NOTE = 'Long trips can take up to a minute.'
export const READY_AGAIN = 'You can try again now.'

/** The Plan routes button's label while busy: the current step, changing every 2 seconds and
 * stopping at the last one. Visual only: the button keeps a steady accessible name. */
export function PlanningLabel({ startedAt, steps }: { startedAt: number; steps: string[] }) {
  const elapsedMs = useNow() - startedAt
  const step = steps[Math.min(steps.length - 1, Math.max(0, Math.floor(elapsedMs / STEP_MS)))]
  return (
    <span key={step} className="button-step" aria-hidden="true">
      {step}
    </span>
  )
}

/** Shown under the button while a plan is being worked out. Only the app's status region speaks
 * to screen readers (one steady message). */
export function LoadingStatus({ startedAt, slow }: { startedAt: number; slow: boolean }) {
  const elapsed = Math.max(0, Math.floor((useNow() - startedAt) / 1000))
  return (
    <div className="loading" aria-hidden="true">
      <div className="road">
        <span className="road-lane" />
        <Truck shape={SIDE_TRUCK} className="road-truck" />
      </div>
      <p className="loading-text">
        <span>{slow ? SLOW_NOTE : 'This usually takes 8 to 20 seconds.'}</span>
        <span className="loading-elapsed">{elapsed} s</span>
      </p>
    </div>
  )
}

/** A request that failed, with the server's own words; a rate limit adds a countdown. */
export function RequestError({ message, retryAt }: { message: string; retryAt: number | null }) {
  return (
    <div className="request-error">
      <p role="alert">
        <Bang />
        {message}
      </p>
      {retryAt !== null && <RetryCountdown retryAt={retryAt} />}
    </div>
  )
}

function RetryCountdown({ retryAt }: { retryAt: number }) {
  const left = Math.max(0, Math.ceil((retryAt - useNow()) / 1000))
  return <p className="retry">{left > 0 ? `Try again in ${left} s` : READY_AGAIN}</p>
}

/** The current time, updated every quarter second while mounted (so 2-second steps land on time). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [])
  return now
}
