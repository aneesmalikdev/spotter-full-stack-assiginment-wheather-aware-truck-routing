/** The plan API's request and response (README "API"). Times are ISO 8601 strings in UTC. */

/** 0 Low, 1 Moderate, 2 High, 3 Severe, 4 No Travel; null means No data. */
export type Level = 0 | 1 | 2 | 3 | 4 | null

export type Interval = 10 | 25 | 50

export interface PlanRequest {
  origin: string
  destination: string
  departure: string // ISO 8601 with a time-zone offset
  load_lb: number
  interval_miles: Interval
}

export interface Place {
  query: string
  name: string
  country_code: string | null
  lat: number
  lon: number
}

export interface Checkpoint {
  mile: number
  lat: number
  lon: number
  eta: string
  forecast_time: string // the forecast hour nearest the ETA, for the sustained wind
  totals_time: string // the end of the hour the ETA falls in, whose rain, snow and gusts are used
  wind_mph: number | null
  gust_mph: number | null // for information only
  rain_in_hr: number | null
  snow_in_hr: number | null
  wind_level: Level
  rain_level: Level
  snow_level: Level
  load_rule_applied: boolean
  level: Level
  covered_miles: number
}

export interface MilesByLevel {
  low: number
  moderate: number
  high: number
  severe: number
  no_travel: number
  no_data: number
}

export interface Route {
  id: string // 'A', 'B' or 'C'
  source: 'tomtom' | 'via_point'
  distance_miles: number
  travel_time_s: number
  arrival: string
  geometry: [number, number][] // [lon, lat]
  rank: number
  recommended: boolean
  summary: {
    miles_by_level: MilesByLevel
    average_risk: number | null // 0 to 4; null when no mile has forecast data
    unsafe: boolean
  }
  checkpoints: Checkpoint[]
}

export interface Heatmap {
  cell_deg: number
  band_miles: number
  cells: [number, number, number, number][] // west, south, east, north
  hours: string[] // the forecast hour at each slider position, 0 to 48
  levels: Level[][] // [hour][cell]
}

export interface Plan {
  origin: Place
  destination: Place
  departure: string
  load_lb: number
  interval_miles: Interval
  routes: Route[]
  recommendation: { route_id: string; warnings: string[] }
  warnings: string[]
  heatmap: Heatmap
}

export type FieldName = keyof PlanRequest
export type FieldErrors = Partial<Record<FieldName, string>>
