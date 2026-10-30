/** The trip form: its values, the checks the server also makes, and the request it sends. */

import type { FieldErrors, Interval, PlanRequest } from '../api/types'
import { departureProblem, parseInputValue, toApiDeparture } from './time'

export const MAX_LOAD_LB = 200_000
export const INTERVALS: Interval[] = [10, 25, 50]

export interface FormValues {
  origin: string
  destination: string
  departure: string // <input type="datetime-local"> value, local time
  load: string // as typed; "35,000" is accepted
  interval: Interval
}

/** The load as a number, or null if it isn't one. */
export function parseLoad(text: string): number | null {
  const cleaned = text.replace(/[\s,]/g, '')
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(cleaned)) return null
  return Number(cleaned)
}

/** What is wrong with each field; empty when the form can be sent. */
export function validate(values: FormValues, now: Date): FieldErrors {
  const errors: FieldErrors = {}
  const origin = placeProblem(values.origin, 'Enter where the trip starts.')
  const destination = placeProblem(values.destination, 'Enter where the trip ends.')
  const departure = departureProblem(values.departure, now)
  const load = loadProblem(values.load)
  if (origin) errors.origin = origin
  if (destination) errors.destination = destination
  if (departure) errors.departure = departure
  if (load) errors.load_lb = load
  return errors
}

/** The API request for values that passed validate(). */
export function toRequest(values: FormValues): PlanRequest {
  const departure = parseInputValue(values.departure)
  const load = parseLoad(values.load)
  if (departure === null || load === null) throw new Error('validate the form first')
  return {
    origin: values.origin.trim(),
    destination: values.destination.trim(),
    departure: toApiDeparture(departure),
    load_lb: load,
    interval_miles: values.interval,
  }
}

function placeProblem(value: string, missing: string): string | null {
  const text = value.trim()
  if (text.length === 0) return missing
  if (text.length < 2) return 'Enter at least 2 characters.'
  if (text.length > 200) return 'Enter at most 200 characters.'
  return null
}

function loadProblem(value: string): string | null {
  if (value.trim().startsWith('-')) return "The load weight can't be negative."
  const load = parseLoad(value)
  if (load === null) return 'Enter the load weight in pounds.'
  if (load > MAX_LOAD_LB) return `The load weight must be at most ${MAX_LOAD_LB.toLocaleString('en-US')} lb.`
  return null
}
