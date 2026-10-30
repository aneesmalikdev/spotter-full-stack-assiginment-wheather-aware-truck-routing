/** Plans shaped like the API's, for component tests. */

import type { Checkpoint, Heatmap, Level, Plan, Route } from '../api/types'

export function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    mile: 0,
    lat: 33,
    lon: -97,
    eta: '2026-10-25T14:00:00Z',
    forecast_time: '2026-10-25T14:00:00Z',
    totals_time: '2026-10-25T14:00:00Z',
    wind_mph: 8.1,
    gust_mph: 13.2,
    rain_in_hr: 0,
    snow_in_hr: 0,
    wind_level: 0,
    rain_level: 0,
    snow_level: 0,
    load_rule_applied: false,
    level: 0,
    covered_miles: 12.5,
    ...overrides,
  }
}

interface RouteOptions {
  rank: number
  recommended?: boolean
  miles?: Partial<Route['summary']['miles_by_level']>
  average?: number | null
  travel?: number
  levels?: Level[]
}

export function route(id: string, { rank, recommended = rank === 1, miles = {}, average = 0, travel = 46_000, levels = [0, 0, 0] }: RouteOptions): Route {
  const byLevel = { low: 800, moderate: 0, high: 0, severe: 0, no_travel: 0, no_data: 0, ...miles }
  return {
    id,
    source: 'tomtom',
    distance_miles: 812.6,
    travel_time_s: travel,
    arrival: '2026-10-26T03:00:00Z',
    geometry: [
      [-96.8, 32.78],
      [-100, 36],
      [-104.98, 39.74],
    ],
    rank,
    recommended,
    summary: { miles_by_level: byLevel, average_risk: average, unsafe: byLevel.no_travel > 0 },
    checkpoints: levels.map((level, i) => checkpoint({ mile: i * 25, level })),
  }
}

export function plan(routes: Route[], overrides: Partial<Plan> = {}): Plan {
  const recommended = routes.find(r => r.recommended) ?? routes[0]
  return {
    origin: { query: 'Dallas, TX', name: 'Dallas, TX', country_code: 'US', lat: 32.78, lon: -96.8 },
    destination: { query: 'Denver, CO', name: 'Denver, CO', country_code: 'US', lat: 39.74, lon: -104.98 },
    departure: '2026-10-25T14:00:00Z',
    load_lb: 35000,
    interval_miles: 25,
    routes,
    recommendation: { route_id: recommended.id, warnings: [] },
    warnings: [],
    heatmap: { cell_deg: 0.5, band_miles: 30, cells: [], hours: [], levels: [] },
    ...overrides,
  }
}

/** A heatmap of `cells` cells in a row, all Low, for the 49 slider hours from 14:00 UTC on Oct 25
 * (9:00 AM CDT, the tests' time zone). */
export function heatmap(cells = 2): Heatmap {
  const start = Date.parse('2026-10-25T14:00:00Z')
  const hours = Array.from({ length: 49 }, (_, h) => new Date(start + h * 3_600_000).toISOString().replace('.000Z', 'Z'))
  return {
    cell_deg: 0.5,
    band_miles: 30,
    cells: Array.from({ length: cells }, (_, i) => [-97 + i * 0.5, 33, -96.5 + i * 0.5, 33.5] as [number, number, number, number]),
    hours,
    levels: hours.map(() => Array.from({ length: cells }, (): Level => 0)),
  }
}
