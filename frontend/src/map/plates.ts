import { type Line, METRES_PER_DEGREE, type Point, RADIANS_PER_DEGREE, count, measure, pointAt } from './line'

export type Side = 'n' | 's' | 'e' | 'w'

export interface Plate {
  route: number // index into the input
  position: [number, number] // [lon, lat], on the route
  side: Side // the side of the route the plate sits on, away from the other routes
}

export interface RouteLayout {
  plates: Plate[] // one per route, same order as the input
  solo: [number, number][][][] // per route (input order): its unshared runs, each a [lon, lat] line
}

interface Samples {
  step: number // metres between samples
  along: number[] // metres from the start to each sample
  points: Point[]
}

const SHARED_M = 5_000 // samples nearer than this to another route's are on shared road
const SOLO_MIN_M = 10_000 // shorter unshared runs get no repeated letters
const PROBE_M = 15_000 // how far out each side of the route is checked for room
const TIE_M = 1 // sides whose room differs by no more than this are a tie

/**
 * Routes between the same two places share stretches of road. Each route gets one letter plate where it runs
 * farthest from the others, on the side away from them, and its solo runs: the stretches no other route shares,
 * where its letter can repeat along the line.
 */
export function routeLayout(routes: { geometry: [number, number][] }[]): RouteLayout {
  const lines = routes.map(route => measure(route.geometry))
  const samples = lines.map(resample)
  const others = samples.map((_, r) => pack(samples.flatMap((s, q) => (q === r ? [] : s.points))))
  // each sample's distance to the nearest sample of any other route
  const separation = samples.map((s, r) => s.points.map(point => nearest(others[r], point)))
  return {
    plates: lines.map((line, r) => plate(r, line, samples[r], separation[r], others[r])),
    solo: lines.map((line, r) => soloRuns(line, samples[r].along, separation[r], others[r].length === 0)),
  }
}

/** Points every `step` metres along the line, and its end; the step is a 400th of the length, kept within 1 to 5 km. */
function resample(line: Line): Samples {
  const step = Math.min(Math.max(line.length / 400, 1_000), 5_000)
  const along: number[] = []
  for (let i = 0; i * step < line.length; i++) along.push(i * step)
  if (line.points.length > 0) along.push(line.length)
  return { step, along, points: along.map(at => pointAt(line, at)) }
}

function plate(route: number, line: Line, { step, along }: Samples, separation: number[], others: Float64Array): Plate {
  const at = plateAlong(line.length, along, separation)
  const position = pointAt(line, at)
  return { route, position, side: plateSide(line, at, step, position, others) }
}

/** Metres along the route to its plate: the sample farthest from the other routes between 15 % and 85 % of the way,
 * or halfway when even that one is on shared road or there is no other route (separation Infinity). */
function plateAlong(length: number, along: number[], separation: number[]): number {
  let best = -1
  along.forEach((at, i) => {
    // 1 mm of slack: the samples at exactly 15 % and 85 % can round a hair outside the window.
    if (at < 0.15 * length - 0.001 || at > 0.85 * length + 0.001) return
    if (best < 0 || separation[i] > separation[best]) best = i
  })
  const apart = best >= 0 && separation[best] >= SHARED_M && separation[best] < Infinity
  return apart ? along[best] : length / 2
}

/** The side with more room before the other routes, snapped to n, s, e or w. A tie, as when there is no other route,
 * gives n, or e where the route runs north-south. */
function plateSide(line: Line, at: number, step: number, position: Point, others: Float64Array): Side {
  const [east, north] = delta(pointAt(line, at - step), pointAt(line, at + step))
  const size = Math.hypot(east, north)
  if (size === 0) return 'n'
  // the left-hand normal as a unit vector, x east and y north
  const x = -north / size
  const y = east / size
  const left = nearest(others, offset(position, x * PROBE_M, y * PROBE_M))
  const right = nearest(others, offset(position, -x * PROBE_M, -y * PROBE_M))
  if (left > right + TIE_M) return snap(x, y)
  if (right > left + TIE_M) return snap(-x, -y)
  return Math.abs(x) > Math.abs(y) ? 'e' : 'n'
}

function snap(x: number, y: number): Side {
  if (Math.abs(x) > Math.abs(y)) return x > 0 ? 'e' : 'w'
  return y < 0 ? 's' : 'n'
}

/** Runs of samples at least SHARED_M from every other route and at least SOLO_MIN_M long, cut from the route's own
 * line. With no other route, the whole line is one run (if it has any length). */
function soloRuns(line: Line, along: number[], separation: number[], alone: boolean): Point[][] {
  if (alone) return line.length > 0 ? [[...line.points]] : []
  const runs: Point[][] = []
  let first = 0
  while (first < separation.length) {
    if (separation[first] < SHARED_M) {
      first++
      continue
    }
    let last = first
    while (last + 1 < separation.length && separation[last + 1] >= SHARED_M) last++
    if (along[last] - along[first] >= SOLO_MIN_M) runs.push(cut(line, along[first], along[last]))
    first = last + 1
  }
  return runs
}

/** The line between two distances along it: interpolated ends, with the original points strictly between. */
function cut(line: Line, from: number, to: number): Point[] {
  const first = count(line.along, metres => metres <= from)
  const end = count(line.along, metres => metres < to)
  return [pointAt(line, from), ...line.points.slice(first, end), pointAt(line, to)]
}

/** Metres east and north from a to b, equirectangular at a's latitude: accurate over the short distances that decide
 * anything here. */
function delta([lon1, lat1]: Point, [lon2, lat2]: Point): [number, number] {
  return [(lon2 - lon1) * Math.cos(lat1 * RADIANS_PER_DEGREE) * METRES_PER_DEGREE, (lat2 - lat1) * METRES_PER_DEGREE]
}

/** The point `east` and `north` metres from the given one. */
function offset([lon, lat]: Point, east: number, north: number): Point {
  return [lon + east / (Math.cos(lat * RADIANS_PER_DEGREE) * METRES_PER_DEGREE), lat + north / METRES_PER_DEGREE]
}

/** Points as flat lon, lat, cos(lat) triples, for a fast nearest-point search. */
function pack(points: Point[]): Float64Array {
  const packed = new Float64Array(points.length * 3)
  points.forEach(([lon, lat], i) => packed.set([lon, lat, Math.cos(lat * RADIANS_PER_DEGREE)], i * 3))
  return packed
}

/** Metres to the nearest packed point, or Infinity when there is none. East-west gaps use the packed point's
 * latitude, so two points mirrored across a route measure the same. */
function nearest(packed: Float64Array, [lon, lat]: Point): number {
  let best = Infinity
  for (let j = 0; j < packed.length; j += 3) {
    const dx = (packed[j] - lon) * packed[j + 2]
    const dy = packed[j + 1] - lat
    const squared = dx * dx + dy * dy
    if (squared < best) best = squared
  }
  return Math.sqrt(best) * METRES_PER_DEGREE
}
