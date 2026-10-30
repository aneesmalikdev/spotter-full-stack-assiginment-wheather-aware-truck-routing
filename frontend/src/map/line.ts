/** Measuring a route's [lon, lat] line: the plates and the trucks both walk along it. */

export type Point = [number, number]

export interface Line {
  points: Point[]
  along: Float64Array // metres from the start to each point
  length: number // metres
}

export const METRES_PER_DEGREE = (6_371_008.8 * Math.PI) / 180 // of latitude
export const RADIANS_PER_DEGREE = Math.PI / 180

export function measure(points: Point[]): Line {
  const along = new Float64Array(points.length)
  for (let i = 1; i < points.length; i++) along[i] = along[i - 1] + distance(points[i - 1], points[i])
  return { points, along, length: along.at(-1) ?? 0 }
}

/** The point `at` metres along the line, clamped to its ends; [0, 0] when the line has no points. */
export function pointAt({ points, along }: Line, at: number): Point {
  if (points.length === 0) return [0, 0]
  const i = Math.max(count(along, metres => metres <= at) - 1, 0) // the last point at or before `at`
  const [lon1, lat1] = points[i]
  if (i === points.length - 1 || at <= along[i]) return [lon1, lat1]
  const [lon2, lat2] = points[i + 1]
  const t = (at - along[i]) / (along[i + 1] - along[i])
  return [lon1 + (lon2 - lon1) * t, lat1 + (lat2 - lat1) * t]
}

/** How many of an ascending list's values pass the test, which only the smaller ones pass: a binary search. */
export function count(values: Float64Array, test: (value: number) => boolean): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (test(values[mid])) low = mid + 1
    else high = mid
  }
  return low
}

/** Metres from a to b, equirectangular at a's latitude: accurate over the short distances between a line's
 * points. Worked out without an array: this runs for every point of every route. */
export function distance(a: Point, b: Point): number {
  const east = (b[0] - a[0]) * Math.cos(a[1] * RADIANS_PER_DEGREE)
  const north = b[1] - a[1]
  return Math.sqrt(east * east + north * north) * METRES_PER_DEGREE
}
