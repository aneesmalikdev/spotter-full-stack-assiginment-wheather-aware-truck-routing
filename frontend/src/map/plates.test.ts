import { describe, expect, it } from 'vitest'
import { routeLayout } from './plates'

type Point = [number, number]

/** count + 1 points f(t), for t from 0 to 1. */
function path(count: number, f: (t: number) => Point): Point[] {
  return Array.from({ length: count + 1 }, (_, i) => f(i / count))
}

/** East from (-104, 35) to (-96, 35), about 730 km. Between its first and last quarters (about 180 km each, the same
 * for every such route) it bows `height` degrees north at the middle, or south when negative. */
function bowed(height: number): Point[] {
  return path(800, t => [-104 + 8 * t, t > 0.25 && t < 0.75 ? 35 + height * Math.sin(2 * Math.PI * (t - 0.25)) : 35])
}

const DIRECT = bowed(0)
const NORTH = bowed(1) // about 111 km out at the middle
const SOUTH = bowed(-0.8) // about 89 km out, so the direct route has more room to the north

const KM_PER_DEGREE = (6371.0088 * Math.PI) / 180

function lengthKm(line: Point[]): number {
  return line.slice(1).reduce((sum, [lon, lat], i) => {
    const [lon0, lat0] = line[i]
    return sum + Math.hypot((lon - lon0) * Math.cos((lat0 * Math.PI) / 180), lat - lat0) * KM_PER_DEGREE
  }, 0)
}

function onSegment([x, y]: Point, [ax, ay]: Point, [bx, by]: Point): boolean {
  const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
  const dot = (bx - ax) * (x - ax) + (by - ay) * (y - ay)
  return Math.abs(cross) < 1e-12 && dot >= 0 && dot <= (bx - ax) ** 2 + (by - ay) ** 2
}

/** Expects the run to be cut from the line: its ends on the line's segments, the line's own points in between. */
function expectCutFrom(line: Point[], run: Point[]) {
  const inner = run.slice(1, -1)
  const first = line.findIndex(([lon, lat]) => lon === inner[0][0] && lat === inner[0][1])
  const end = first + inner.length
  expect(first).toBeGreaterThan(0)
  expect(inner).toEqual(line.slice(first, end))
  expect(onSegment(run[0], line[first - 1], line[first])).toBe(true)
  expect(onSegment(run[run.length - 1], line[end - 1], line[end])).toBe(true)
}

function expectNear([lon, lat]: Point, [lon0, lat0]: Point, degrees: number) {
  expect(Math.abs(lon - lon0)).toBeLessThan(degrees)
  expect(Math.abs(lat - lat0)).toBeLessThan(degrees)
}

function withoutRepeats(line: Point[]): Point[] {
  return line.filter((point, i) => i === 0 || point[0] !== line[i - 1][0] || point[1] !== line[i - 1][1])
}

describe('route layout', () => {
  it('plates a lone east-west route halfway, from the north, and makes its whole line solo', () => {
    const line = path(400, t => [-100 + 4 * t, 35])
    const { plates, solo } = routeLayout([{ geometry: line }])
    expect(plates).toHaveLength(1)
    expect(plates[0].route).toBe(0)
    expect(plates[0].side).toBe('n')
    expectNear(plates[0].position, [-98, 35], 1e-9)
    expect(solo).toEqual([[line]])
    expect(routeLayout([{ geometry: [...line].reverse() }]).plates[0].side).toBe('n')
  })

  it('plates a lone north-south route from the east', () => {
    const { plates } = routeLayout([{ geometry: path(400, t => [-100, 33 + 4 * t]) }])
    expect(plates[0].side).toBe('e')
    expectNear(plates[0].position, [-100, 35], 1e-9)
  })

  it('plates routes that bow apart at their widest, on the side away from the others', () => {
    const { plates } = routeLayout([{ geometry: DIRECT }, { geometry: NORTH }, { geometry: SOUTH }])
    expect(plates.map(p => p.route)).toEqual([0, 1, 2])
    expect(plates.map(p => p.side)).toEqual(['n', 'n', 's'])
    expectNear(plates[0].position, [-100, 35], 0.1)
    expectNear(plates[1].position, [-100, 36], 0.1)
    expectNear(plates[2].position, [-100, 34.2], 0.1)
  })

  it("makes solo runs of only the unshared stretches, cut from each route's own line", () => {
    const { solo } = routeLayout([{ geometry: DIRECT }, { geometry: NORTH }, { geometry: SOUTH }])
    for (const [r, line] of [DIRECT, NORTH, SOUTH].entries()) {
      expect(solo[r]).toHaveLength(1)
      const run = solo[r][0]
      // the bows leave the direct route at -102 and rejoin it at -98: each run starts and ends a few km inside
      expect(run[0][0]).toBeGreaterThan(-102)
      expect(run[0][0]).toBeLessThan(-101.8)
      expect(run[run.length - 1][0]).toBeLessThan(-98)
      expect(run[run.length - 1][0]).toBeGreaterThan(-98.2)
      expect(lengthKm(run)).toBeGreaterThanOrEqual(10)
      expectCutFrom(line, run)
    }
  })

  it('cuts solo runs at points interpolated on the original segments', () => {
    // Segments of about 55 km, so every cut falls inside one. B leaves A at A's second point and rejoins it at the
    // fourth, by way of a point 1 degree north of A's third.
    const a: Point[] = [[-100, 35], [-99.4, 35.2], [-98.8, 35.1], [-98.2, 35.3], [-97.6, 35.2]]
    const b: Point[] = [a[0], a[1], [-98.8, 36.1], a[3], a[4]]
    const { solo } = routeLayout([{ geometry: a }, { geometry: b }])
    for (const [r, line] of [a, b].entries()) {
      expect(solo[r]).toHaveLength(1)
      const [start, middle, end, ...rest] = solo[r][0]
      expect(rest).toEqual([])
      expect(middle).toEqual(line[2])
      expect(onSegment(start, line[1], line[2])).toBe(true)
      expect(onSegment(end, line[2], line[3])).toBe(true)
      expect(start).not.toEqual(line[1]) // inside the segment, not at its ends
      expect(end).not.toEqual(line[3])
    }
  })

  it('leaves out unshared stretches shorter than 10 km', () => {
    // B leaves A for a spike about 9 km wide. At 7 km high only about 5 km of its road is 5 km clear of A; at 33 km
    // high most of it is.
    const a = path(200, t => [-100 + 2 * t, 35])
    const spike = (height: number) =>
      path(200, t => [-100 + 2 * t, 35 + height * Math.max(0, 1 - Math.abs(t - 0.5) / 0.025)])
    expect(routeLayout([{ geometry: a }, { geometry: spike(0.063) }]).solo).toEqual([[], []])
    const { plates, solo } = routeLayout([{ geometry: a }, { geometry: spike(0.3) }])
    expect(solo[0]).toEqual([])
    expect(solo[1]).toHaveLength(1)
    // A never gets 5 km clear, so its plate goes halfway, which is under the spike: on the side away from it
    expectNear(plates[0].position, [-99, 35], 1e-9)
    expect(plates[0].side).toBe('s')
    expectNear(plates[1].position, [-99, 35.3], 0.01)
  })

  it('gives identical routes no solo runs and plates them halfway', () => {
    const line = path(400, t => [-100 + 4 * t, 35])
    const { plates, solo } = routeLayout([{ geometry: line }, { geometry: line }])
    expect(solo).toEqual([[], []])
    expect(plates.map(p => p.side)).toEqual(['n', 'n'])
    for (const plate of plates) expectNear(plate.position, [-98, 35], 1e-9)
  })

  it('copes with no routes, no points, one point and no length', () => {
    expect(routeLayout([])).toEqual({ plates: [], solo: [] })
    const { plates, solo } = routeLayout([
      { geometry: [] },
      { geometry: [[-100, 35]] },
      { geometry: [[-99, 36], [-99, 36]] },
    ])
    expect(plates).toEqual([
      { route: 0, position: [0, 0], side: 'n' },
      { route: 1, position: [-100, 35], side: 'n' },
      { route: 2, position: [-99, 36], side: 'n' },
    ])
    expect(solo).toEqual([[], [], []])
    expect(routeLayout([{ geometry: [[-99, 36], [-99, 36]] }])).toEqual({
      plates: [{ route: 0, position: [-99, 36], side: 'n' }],
      solo: [[]],
    })
  })

  it('lays out the same with repeated points', () => {
    const twice = (line: Point[]) => line.flatMap(point => [point, point])
    const clean = routeLayout([{ geometry: DIRECT }, { geometry: NORTH }, { geometry: SOUTH }])
    const repeated = routeLayout([{ geometry: twice(DIRECT) }, { geometry: twice(NORTH) }, { geometry: SOUTH }])
    expect(repeated.plates).toEqual(clean.plates)
    expect(repeated.solo.map(runs => runs.map(withoutRepeats))).toEqual(clean.solo)
  })

  it('lays out three coast-to-coast routes quickly', () => {
    // about 4,500 km each with a point every 100 m (45,000 points); two bow apart over the middle 60 %
    const coast = (height: number) =>
      path(45_000, t => {
        const bow = t > 0.2 && t < 0.8 ? height * Math.sin((Math.PI * (t - 0.2)) / 0.6) : 0
        return [-122 + 49.4 * t, 35 + bow]
      })
    const routes = [0, 1.5, -1.2].map(height => ({ geometry: coast(height) }))
    // The fastest of three runs, so a busy machine doesn't fail it: this takes tens of milliseconds,
    // and comparing every point with every other point would take many seconds.
    const timings = [0, 1, 2].map(() => {
      const started = performance.now()
      routeLayout(routes)
      return performance.now() - started
    })
    expect(Math.min(...timings)).toBeLessThan(1000)
    const { plates, solo } = routeLayout(routes)
    expect(plates.map(p => p.side)).toEqual(['n', 'n', 's'])
    expect(solo.map(runs => runs.length)).toEqual([1, 1, 1])
  })
})

describe('plate window', () => {
  it('keeps the sample at exactly 85 % (it must not round out of the window)', () => {
    // About 911 km east, so sample 340 sits at exactly 85 %. B rejoins A at the end after bowing
    // north from 80 %, widest at 90 %: the best sample inside the window is the one at 85 %.
    const path = (count: number, f: (t: number) => [number, number]) => Array.from({ length: count + 1 }, (_, i) => f(i / count))
    const line = (height: number) =>
      path(1000, t => [-100 + 10.003 * t, 35 + (t > 0.8 ? height * Math.sin((Math.PI * (t - 0.8)) / 0.2) : 0)])
    const { plates } = routeLayout([{ geometry: line(0) }, { geometry: line(0.5) }])
    expect((plates[0].position[0] + 100) / 10.003).toBeCloseTo(0.85, 9)
  })
})
