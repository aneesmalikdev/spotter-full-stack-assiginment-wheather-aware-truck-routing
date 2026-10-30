import { describe, expect, it } from 'vitest'
import type { Route } from '../api/types'
import { clientOrder, explainChoice } from './why'

interface Measures {
  noTravel?: number
  severe?: number
  high?: number
  risk?: number | null // average risk; null when no mile has forecast data
  time?: number // travel_time_s
}

// Only the ranking fields vary. By default a route has forecast data, no risky miles and a 10-hour drive.
function route(id: string, rank: number, measures: Measures = {}): Route {
  const { noTravel = 0, severe = 0, high = 0, risk = 0.5, time = 36_000 } = measures
  return {
    id, rank, recommended: rank === 1, source: 'tomtom', distance_miles: 0, travel_time_s: time, arrival: '', geometry: [],
    summary: {
      miles_by_level: { low: 0, moderate: 0, high, severe, no_travel: noTravel, no_data: 0 },
      average_risk: risk,
      unsafe: noTravel > 0,
    },
    checkpoints: [],
  }
}

const ids = (routes: Route[]) => routes.map(r => r.id)

describe('client order', () => {
  // B can only come first through the measure named: A is better on the measures after it and on the letter.
  it.each([
    ['forecast data', { risk: null }, { noTravel: 9, severe: 9, high: 9, risk: 4, time: 90_000 }],
    ['No Travel miles', { noTravel: 0.2 }, { noTravel: 0.1, severe: 9, high: 9, risk: 4, time: 90_000 }],
    ['Severe miles', { severe: 0.2 }, { severe: 0.1, high: 9, risk: 4, time: 90_000 }],
    ['High miles', { high: 0.2 }, { high: 0.1, risk: 4, time: 90_000 }],
    ['average risk', { risk: 0.02 }, { risk: 0.01, time: 90_000 }],
    ['travel time', { time: 36_001 }, { time: 36_000 }],
  ])('ranks on %s before the measures after it', (_, a, b) => {
    expect(ids(clientOrder([route('A', 2, a), route('B', 1, b)]))).toEqual(['B', 'A'])
  })

  it('breaks a full tie by route letter', () => {
    expect(ids(clientOrder([route('C', 3), route('A', 1), route('B', 2)]))).toEqual(['A', 'B', 'C'])
  })

  it('leaves the array it was given as it was', () => {
    const routes = [route('B', 2), route('A', 1)]
    clientOrder(routes)
    expect(ids(routes)).toEqual(['B', 'A'])
  })
})

describe('why the recommended route was picked', () => {
  it('says when it is the only route', () => {
    expect(explainChoice([route('A', 1)])).toEqual({ text: 'The only route found.', column: null })
  })

  it('says when no other route has forecast data', () => {
    const routes = [route('A', 1, { severe: 40, risk: 2 }), route('B', 2, { risk: null }), route('C', 3, { risk: null })]
    expect(explainChoice(routes)).toEqual({ text: 'The only route with forecast data.', column: null })
  })

  // Route A is no better than B on any measure after the first one where they differ.
  it.each([
    ['no_travel', { severe: 9, risk: 2 }, { noTravel: 12.5 }, 'Fewest No Travel miles: 0 mi, against 12.5 mi on Route B.'],
    ['severe', { severe: 25, high: 9 }, { severe: 1234.5 }, 'Fewest Severe miles: 25.0 mi, against 1,234.5 mi on Route B.'],
    ['high', { high: 0.1, risk: 2 }, { high: 3 }, 'Fewest High miles: 0.1 mi, against 3.0 mi on Route B.'],
    ['average_risk', { risk: 0.03 }, { risk: 1.5 }, 'Lowest average risk: 0.03, against 1.50 on Route B.'],
  ])('marks the %s column when it differs first', (column, a, b, text) => {
    expect(explainChoice([route('A', 1, a), route('B', 2, b)])).toEqual({ text, column })
  })

  it.each([
    [960, 'Ties with Route B on No Travel, Severe and High miles and average risk, and is 16 min faster.'],
    [3_900, 'Ties with Route B on No Travel, Severe and High miles and average risk, and is 1 h 5 min faster.'],
    [60, 'Ties with Route B on No Travel, Severe and High miles and average risk, and is 1 min faster.'],
    // 10 h 0 min against 10 h 1 min on screen
    [59, 'Ties with Route B on No Travel, Severe and High miles and average risk, and is 1 min faster.'],
    // both show 10 h 0 min
    [29, 'Ties with Route B on No Travel, Severe and High miles and average risk, and is under a minute faster.'],
  ])('marks the drive column when only drive time differs (%i s)', (seconds, text) => {
    const routes = [route('A', 1), route('B', 2, { time: 36_000 + seconds })]
    expect(explainChoice(routes)).toEqual({ text, column: 'drive' })
  })

  it('counts the minutes between the two drive times shown, not the seconds between the exact ones', () => {
    // 10 h 0 min against 10 h 3 min on screen; the exact times are 122 s apart.
    const routes = [route('A', 1, { time: 36_029 }), route('B', 2, { time: 36_151 })]
    expect(explainChoice(routes)?.text).toBe(
      'Ties with Route B on No Travel, Severe and High miles and average risk, and is 3 min faster.',
    )
  })

  it('falls back to the route letter when nothing else differs', () => {
    expect(explainChoice([route('A', 1), route('B', 2)])).toEqual({
      text: 'Ties with Route B on every measure; listed first by route letter.',
      column: null,
    })
  })

  it('compares the rank-1 and rank-2 routes, whatever order they come in', () => {
    const routes = [route('A', 3, { severe: 10 }), route('C', 2, { severe: 5 }), route('B', 1)]
    expect(explainChoice(routes)).toEqual({ text: 'Fewest Severe miles: 0 mi, against 5.0 mi on Route C.', column: 'severe' })
  })
})

describe('the trade-off', () => {
  it('names a faster route when drive time did not decide', () => {
    const routes = [route('A', 1, { time: 37_080 }), route('B', 2, { severe: 10 })]
    expect(explainChoice(routes)).toEqual({
      text: 'Fewest Severe miles: 0 mi, against 10.0 mi on Route B. Route B is 18 min faster.',
      column: 'severe',
    })
  })

  // Route B takes 36,000 s, shown as 10 h 0 min.
  it.each([
    [36_060, 'Fewest Severe miles: 0 mi, against 10.0 mi on Route B. Route B is 1 min faster.'],
    [36_030, 'Fewest Severe miles: 0 mi, against 10.0 mi on Route B. Route B is 1 min faster.'], // 10 h 1 min
    [36_029, 'Fewest Severe miles: 0 mi, against 10.0 mi on Route B.'], // 10 h 0 min, like Route B
    [30_000, 'Fewest Severe miles: 0 mi, against 10.0 mi on Route B.'],
  ])('needs a route shown at least a minute faster (Route A takes %i s)', (time, text) => {
    expect(explainChoice([route('A', 1, { time }), route('B', 2, { severe: 10 })])?.text).toBe(text)
  })

  it('matches the difference between the two drive times shown', () => {
    // 22 h 4 min against 17 h 50 min on screen: 4 h 14 min apart (the exact times are 4 h 14 min 58 s apart).
    const routes = [route('A', 1, { time: 79_469 }), route('B', 2, { severe: 10, time: 64_171 })]
    expect(explainChoice(routes)?.text).toBe('Fewest Severe miles: 0 mi, against 10.0 mi on Route B. Route B is 4 h 14 min faster.')
  })

  it('names the fastest other route, even when it is not the rank-2 route', () => {
    const routes = [route('A', 1, { time: 37_080 }), route('B', 2, { severe: 5, time: 37_000 }), route('C', 3, { severe: 10 })]
    expect(explainChoice(routes)?.text).toBe('Fewest Severe miles: 0 mi, against 5.0 mi on Route B. Route C is 18 min faster.')
  })

  it('names the better-ranked of two equally fast routes', () => {
    const routes = [route('A', 1, { time: 37_080 }), route('B', 3, { severe: 10 }), route('C', 2, { severe: 5 })]
    expect(explainChoice(routes)?.text).toBe('Fewest Severe miles: 0 mi, against 5.0 mi on Route C. Route C is 18 min faster.')
  })

  // Route A takes 18 minutes longer than the fastest other route.
  it.each([
    ['no-forecast', [route('B', 2, { risk: null })], 'The only route with forecast data. Route B is 18 min faster.'],
    ['average-risk', [route('B', 2, { risk: 1.5 })], 'Lowest average risk: 0.50, against 1.50 on Route B. Route B is 18 min faster.'],
    [
      'full-tie',
      [route('B', 2, { time: 37_080 }), route('C', 3, { severe: 10 })],
      'Ties with Route B on every measure; listed first by route letter. Route C is 18 min faster.',
    ],
  ])('follows the %s sentence too', (_, others, text) => {
    expect(explainChoice([route('A', 1, { time: 37_080 }), ...others])?.text).toBe(text)
  })

  it('is left out when drive time decided', () => {
    const routes = [route('A', 1), route('B', 2, { time: 36_960 }), route('C', 3, { severe: 10, time: 30_000 })]
    expect(explainChoice(routes)).toEqual({
      text: 'Ties with Route B on No Travel, Severe and High miles and average risk, and is 16 min faster.',
      column: 'drive',
    })
  })
})

describe('when there is nothing to say', () => {
  it('says nothing when the recommended route has no forecast data', () => {
    expect(explainChoice([route('A', 1, { risk: null })])).toBeNull()
    expect(explainChoice([route('A', 1, { risk: null }), route('B', 2, { risk: null, time: 40_000 })])).toBeNull()
  })

  it('says nothing without routes', () => {
    expect(explainChoice([])).toBeNull()
  })

  it('says nothing when the client would rank the routes differently', () => {
    const b = route('B', 2, { severe: 5 })
    const c = route('C', 3, { severe: 10 })
    expect(explainChoice([route('A', 1), b, c])).not.toBeNull()
    expect(explainChoice([route('A', 2), { ...b, rank: 1 }, c])).toBeNull() // ranks 1 and 2 swapped
    expect(explainChoice([route('A', 1), { ...b, rank: 3 }, { ...c, rank: 2 }])).toBeNull() // ranks 2 and 3 swapped
  })

  it('says nothing when the client would break a tie differently', () => {
    expect(explainChoice([route('A', 2), route('B', 1)])).toBeNull()
  })
})
