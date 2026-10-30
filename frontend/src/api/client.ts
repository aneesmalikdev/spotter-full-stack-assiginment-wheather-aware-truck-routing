import type { FieldErrors, FieldName, Plan, PlanRequest } from './types'

const FIELDS: FieldName[] = ['origin', 'destination', 'departure', 'load_lb', 'interval_miles']

/** A plan request that failed, with what to tell the user. */
export class PlanError extends Error {
  readonly fields: FieldErrors
  readonly retryAfterS: number | null

  constructor(message: string, fields: FieldErrors = {}, retryAfterS: number | null = null) {
    super(message)
    this.name = 'PlanError'
    this.fields = fields
    this.retryAfterS = retryAfterS
  }
}

export const UNREACHABLE = "The server can't be reached. Check your connection and try again."
export const UNAVAILABLE = 'The server is unavailable right now. Try again in a minute.'
export const TIMED_OUT = "The server didn't answer within 90 seconds. Try again."
export const TIMEOUT_MS = 90_000

/** POST /api/plan/. Resolves to the plan; rejects with a PlanError (with TIMED_OUT after `timeoutMs`). */
export async function requestPlan(request: PlanRequest, timeoutMs = TIMEOUT_MS): Promise<Plan> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const failed = (): never => {
    throw new PlanError(timeout.aborted ? TIMED_OUT : UNREACHABLE)
  }

  let response: Response
  try {
    response = await fetch('/api/plan/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(request),
      signal: timeout,
    })
  } catch {
    return failed()
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    if (timeout.aborted) return failed()
    body = null // e.g. an HTML error page from a proxy, or a cut-off response
  }
  if (response.ok && isPlan(body)) return body
  throw toPlanError(body)
}

/** The API's error body ({error, fields?, retry_after_seconds?}) as a PlanError. */
export function toPlanError(body: unknown): PlanError {
  if (!isObject(body) || typeof body.error !== 'string') return new PlanError(UNAVAILABLE)
  const fields: FieldErrors = {}
  if (isObject(body.fields)) {
    for (const field of FIELDS) {
      const messages = body.fields[field]
      if (Array.isArray(messages) && typeof messages[0] === 'string') fields[field] = messages[0]
    }
  }
  const retry = body.retry_after_seconds
  return new PlanError(body.error, fields, typeof retry === 'number' && retry > 0 ? retry : null)
}

function isPlan(body: unknown): body is Plan {
  return isObject(body) && Array.isArray(body.routes) && body.routes.length > 0 && isObject(body.heatmap)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
