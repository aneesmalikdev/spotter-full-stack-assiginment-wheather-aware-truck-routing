import { describe, expect, it } from 'vitest'
import type { Route } from '../api/types'
import { checkpoint, route } from '../test/fixtures'
import { measure } from './line'
import { approach, truckAt, truckFeatures, truckPose, truckTrack } from './trucks'

const METRES_PER_MILE = 1609.344
const at = (time: string) => Date.parse(time)

/** A route due east along 35° N, from 100° W to 98° W, with checkpoints at miles 0 and 50 and the end. */
function eastbound(overrides: Partial<Route> = {}): Route {
  const geometry: [number, number][] = [
    [-100, 35],
    [-99, 35],
    [-98, 35],
  ]
  const miles = measure(geometry).length / METRES_PER_MILE // about 113 mi
  const base = route('A', { rank: 1 })
  return {
    ...base,
    geometry,
    distance_miles: miles,
    checkpoints: [
      checkpoint({ mile: 0, eta: '2026-10-25T14:00:00Z' }),
      checkpoint({ mile: 50, eta: '2026-10-25T15:00:00Z' }),
      checkpoint({ mile: miles, eta: '2026-10-25T16:20:00Z' }),
    ],
    ...overrides,
  }
}

describe('a route’s truck', () => {
  const track = truckTrack(eastbound())

  it('waits at the start until it leaves', () => {
    expect(truckAt(track, at('2026-10-25T13:00:00Z')).at).toEqual([-100, 35])
    expect(truckAt(track, at('2026-10-25T14:00:00Z')).at).toEqual([-100, 35])
  })

  it('is at the mile its checkpoint ETAs give, linearly between two checkpoints', () => {
    const [lon, lat] = truckAt(track, at('2026-10-25T14:30:00Z')).at // mile 25
    expect(lat).toBeCloseTo(35, 6)
    expect(lon).toBeCloseTo(-100 + (2 * 25) / track.totalMiles, 3)
    expect(truckAt(track, at('2026-10-25T15:00:00Z')).at[0]).toBeCloseTo(-100 + (2 * 50) / track.totalMiles, 3)
  })

  it('parks at the destination once it has arrived', () => {
    expect(truckAt(track, at('2026-10-25T16:20:00Z')).at).toEqual([-98, 35])
    expect(truckAt(track, at('2026-10-27T14:00:00Z')).at).toEqual([-98, 35])
  })

  it('heads the way the road goes, in degrees clockwise from north', () => {
    const heading = (geometry: [number, number][], time = '2026-10-25T14:30:00Z') =>
      truckAt(truckTrack(eastbound({ geometry })), at(time)).bearing
    expect(heading([[-100, 35], [-98, 35]])).toBeCloseTo(90, 6)
    expect(heading([[-98, 35], [-100, 35]])).toBeCloseTo(270, 6)
    expect(heading([[-100, 35], [-100, 37]])).toBeCloseTo(0, 6)
    expect(heading([[-100, 37], [-100, 35]])).toBeCloseTo(180, 6)
    // North-east at 45° N: a degree of longitude there is only cos 45° of a degree of latitude.
    expect(heading([[-100, 45], [-100 + 1 / Math.cos(Math.PI / 4), 46]])).toBeCloseTo(45, 0)
    expect(heading([[-98, 35], [-100, 35]], '2026-10-25T13:00:00Z')).toBeCloseTo(270, 6) // at the start: the way it will go
    expect(heading([[-98, 35], [-100, 35]], '2026-10-25T17:00:00Z')).toBeCloseTo(270, 6) // parked: the way it came
  })

  it('is drawn from the east- or west-facing image, turned at most a quarter turn, so its letter never reads upside down', () => {
    expect([0, 45, 90, 135, 179, 180, 225, 270, 315].map(bearing => truckPose(bearing))).toEqual([
      { west: false, rotate: -90 }, // north
      { west: false, rotate: -45 },
      { west: false, rotate: 0 }, // east
      { west: false, rotate: 45 },
      { west: false, rotate: 89 },
      { west: true, rotate: -90 }, // south
      { west: true, rotate: -45 },
      { west: true, rotate: 0 }, // west
      { west: true, rotate: 45 },
    ])
  })

  it('places its mile along the drawn line in proportion, as the line is simplified and shorter', () => {
    const long = truckTrack(eastbound({ distance_miles: 2 * track.totalMiles }))
    expect(long.totalMiles).toBeGreaterThan(track.totalMiles)
    // Mile 50 of a route twice as long as its drawn line sits a quarter of the way along the line.
    expect(truckAt(long, at('2026-10-25T15:00:00Z')).at[0]).toBeCloseTo(-100 + 2 * (50 / long.totalMiles), 3)
  })
})

describe('truck features', () => {
  it('give each route’s truck its route index as id, with its letter, rank and pose', () => {
    const a = eastbound()
    const b = { ...eastbound(), id: 'B', rank: 2, geometry: [...eastbound().geometry].reverse() }
    const features = truckFeatures([truckTrack(a), truckTrack(b)], at('2026-10-25T14:30:00Z')).features
    const summary = features.map(({ id, properties: { rid, rank, west, rotate } }) => [id, rid, rank, west, Math.round(rotate)])
    expect(summary).toEqual([
      [0, 'A', 1, false, 0], // heading east
      [1, 'B', 2, true, 0], // heading west
    ])
  })

  it('leave out a route with no line to drive along', () => {
    const empty = { ...eastbound(), geometry: [] }
    const features = truckFeatures([truckTrack(empty), truckTrack(eastbound())], at('2026-10-25T14:30:00Z')).features
    expect(features.map(f => f.id)).toEqual([1])
  })
})

describe('driving to the slider’s hour', () => {
  const HOUR = 3_600_000
  const FRAME = 16 // ms

  it('covers most of the way at first, then slows as it nears', () => {
    const first = approach(0, HOUR, FRAME)
    const second = approach(first, HOUR, FRAME)
    expect(first).toBeGreaterThan(0)
    expect(second - first).toBeLessThan(first)
    expect(second).toBeLessThan(HOUR)
  })

  it('arrives exactly within a second of frames, never overshooting, and drives back as well', () => {
    let time = 0
    for (let frame = 0; frame < 60 && time !== HOUR; frame++) {
      const next = approach(time, HOUR, FRAME)
      expect(next).toBeGreaterThan(time)
      expect(next).toBeLessThanOrEqual(HOUR)
      time = next
    }
    expect(time).toBe(HOUR)
    expect(approach(HOUR, 0, FRAME)).toBeLessThan(HOUR)
  })

  it('stays put while no time passes', () => {
    expect(approach(0, HOUR, 0)).toBe(0)
  })
})
