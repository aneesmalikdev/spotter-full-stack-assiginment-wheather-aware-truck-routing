import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlanError, TIMED_OUT, UNAVAILABLE, UNREACHABLE, requestPlan } from './client'
import type { PlanRequest } from './types'

const REQUEST: PlanRequest = {
  origin: 'Dallas, TX',
  destination: 'Denver, CO',
  departure: '2026-10-25T14:00:00-05:00',
  load_lb: 35000,
  interval_miles: 25,
}
const PLAN = { routes: [{ id: 'A' }], heatmap: { cells: [] } }

function answer(status: number, body: string, contentType = 'application/json') {
  const fetchMock = vi.fn(async () => new Response(body, { status, headers: { 'Content-Type': contentType } }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function failure(): Promise<PlanError> {
  try {
    await requestPlan(REQUEST)
  } catch (error) {
    if (error instanceof PlanError) return error
    throw error
  }
  throw new Error('the request did not fail')
}

afterEach(() => vi.unstubAllGlobals())

describe('requestPlan', () => {
  it('posts the request as JSON and returns the plan', async () => {
    const fetchMock = answer(200, JSON.stringify(PLAN))
    expect(await requestPlan(REQUEST)).toEqual(PLAN)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/plan/')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual(REQUEST)
  })

  it('reports field errors with the first message for each field', async () => {
    answer(400, JSON.stringify({ error: 'Please correct the highlighted fields.', fields: { origin: ['Enter where the trip starts.'], other: ['x'] } }))
    const error = await failure()
    expect(error.message).toBe('Please correct the highlighted fields.')
    expect(error.fields).toEqual({ origin: 'Enter where the trip starts.' })
  })

  it('passes on when to retry after a rate limit', async () => {
    answer(503, JSON.stringify({ error: 'The weather service is busy.', retry_after_seconds: 42 }))
    const error = await failure()
    expect([error.message, error.retryAfterS]).toEqual(['The weather service is busy.', 42])
  })

  it.each([
    [502, '<html>Bad Gateway</html>', 'text/html'],
    [504, '', 'text/plain'],
    [200, '{"routes": []}', 'application/json'], // no route: not a plan
    [500, '{"detail": "x"}', 'application/json'], // not the API's error shape
  ])('says the server is unavailable for an unusable answer (%i %j)', async (status, body, type) => {
    answer(status, body, type)
    expect((await failure()).message).toBe(UNAVAILABLE)
  })

  it('says the server cannot be reached when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    expect((await failure()).message).toBe(UNREACHABLE)
  })

  it('gives up after the timeout with its own message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })),
    )
    await expect(requestPlan(REQUEST, 20)).rejects.toMatchObject({ message: TIMED_OUT })
  })
})
