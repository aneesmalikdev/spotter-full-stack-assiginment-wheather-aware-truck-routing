import { describe, expect, it } from 'vitest'
import type { Checkpoint, Plan, Route } from '../api/types'
import { checkpointId, checkpointRef, dotZooms, planData } from './geojson'
import { NO_DATA_LEVEL } from './mapStyle'

function checkpoint(lon: number, lat: number, level: Checkpoint['level']): Checkpoint {
  return {
    mile: 0, lat, lon, eta: '', forecast_time: '', totals_time: '', wind_mph: null, gust_mph: null, rain_in_hr: null, snow_in_hr: null,
    wind_level: null, rain_level: null, snow_level: null, load_rule_applied: false, level, covered_miles: 0,
  }
}

function route(id: string, rank: number, geometry: [number, number][], levels: Checkpoint['level'][]): Route {
  return {
    id, rank, recommended: rank === 1, source: 'tomtom', distance_miles: 0, travel_time_s: 0, arrival: '', geometry,
    summary: { miles_by_level: { low: 0, moderate: 0, high: 0, severe: 0, no_travel: 0, no_data: 0 }, average_risk: 0, unsafe: false },
    checkpoints: levels.map((level, i) => checkpoint(geometry[i][0], geometry[i][1], level)),
  }
}

function plan(interval: 10 | 25 | 50 = 25, lat = 37): Plan {
  return {
    origin: { query: 'Dallas', name: 'Dallas, TX', country_code: 'US', lat: 33, lon: -97 },
    destination: { query: 'Denver', name: 'Denver, CO', country_code: 'US', lat: 40, lon: -105 },
    interval_miles: interval,
    routes: [
      route('A', 2, [[-97, lat], [-100, lat + 3], [-105, lat + 7]], [0, 2, null]),
      route('B', 1, [[-97, lat], [-102, lat + 1], [-105, lat + 7]], [0, 4, 1]),
      route('C', 3, [[-97, lat], [-96, lat + 5], [-105, lat + 7]], [0, 0, 0]),
    ],
    heatmap: { cell_deg: 0.5, band_miles: 30, cells: [[-97.5, 37, -97, 37.5]], hours: [], levels: [] },
  } as unknown as Plan
}

describe('map data', () => {
  it('keeps each route with its letter, rank and recommendation', () => {
    const { routes } = planData(plan())
    expect(routes.features.map(f => [f.id, f.properties])).toEqual([
      [0, { rid: 'A', rank: 2, rec: false }],
      [1, { rid: 'B', rank: 1, rec: true }],
      [2, { rid: 'C', rank: 3, rec: false }],
    ])
  })

  it('gives every checkpoint an id that leads back to its route and index', () => {
    const { checkpoints } = planData(plan())
    expect(checkpoints.features).toHaveLength(9)
    const noData = checkpoints.features[2]
    expect([noData.id, noData.properties]).toEqual([checkpointId(0, 2), { lvl: NO_DATA_LEVEL, rec: false }])
    expect(checkpointRef(checkpoints.features[4].id as number)).toEqual({ route: 1, index: 1 })
    expect(checkpoints.features[4].properties).toEqual({ lvl: 4, rec: true })
  })

  it('marks both ends with the resolved place names', () => {
    const { ends } = planData(plan())
    expect(ends.features.map(f => [f.geometry.coordinates, f.properties.name])).toEqual([
      [[-97, 37], 'Dallas, TX'],
      [[-105, 44], 'Denver, CO'],
    ])
  })

  it('places one plate per route and bounds every route', () => {
    const data = planData(plan())
    expect(data.plates.features.map(f => f.properties.rid).sort()).toEqual(['A', 'B', 'C'])
    expect(data.solo.features).toHaveLength(3)
    expect(data.bounds).toEqual([[-105, 37], [-96, 44]])
  })

  it.each([
    [10, 4.8, 5.8],
    [25, 3.5, 4.5],
    [50, 2.5, 3.5],
  ] as const)('sizes dots for checkpoints every %i mi', (interval, zA, zB) => {
    const zooms = dotZooms({ ...plan(interval), routes: [route('A', 1, [[-97, 37]], [0])] } as Plan)
    expect(zooms.zA).toBeCloseTo(zA, 1)
    expect(zooms.zB).toBeCloseTo(zB, 1)
  })
})
