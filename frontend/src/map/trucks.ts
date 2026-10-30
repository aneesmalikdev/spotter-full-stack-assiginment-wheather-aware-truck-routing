import type { Feature, FeatureCollection, Point as GeoPoint } from 'geojson'
import type { Route } from '../api/types'
import { type Line, type Point, RADIANS_PER_DEGREE, count, measure, pointAt } from './line'

const HEADING_M = 2_000 // the road's direction is judged over this far behind and ahead of the truck
const FOLLOW_MS = 70 // how fast a truck catches up with the slider: 95 % of the way in about 3 times this
const SETTLED_MS = 1_000 // a truck this close in time to the slider's hour (about 30 m of road) is put there

/** One route's timetable and drawn line, ready to place its truck at any moment. */
export interface TruckTrack {
  id: string // the route letter
  line: Line
  times: Float64Array // the checkpoints' ETAs, in ms
  miles: number[] // the checkpoints' miles
  totalMiles: number
  rank: number
}

export interface TruckProps {
  rid: string // the route letter, painted on the trailer's roof
  rank: number
  west: boolean // drawn from the west-facing image (see truckPose)
  rotate: number // degrees clockwise from that image's own heading, within ±90
}

export function truckTrack(route: Route): TruckTrack {
  return {
    id: route.id,
    line: measure(route.geometry),
    times: Float64Array.from(route.checkpoints, checkpoint => Date.parse(checkpoint.eta)),
    miles: route.checkpoints.map(checkpoint => checkpoint.mile),
    totalMiles: route.distance_miles,
    rank: route.rank,
  }
}

/** Each route's truck at `time` (ms), with the route's index as the feature id. */
export function truckFeatures(tracks: TruckTrack[], time: number): FeatureCollection<GeoPoint, TruckProps> {
  const features = tracks.flatMap((track, r): Feature<GeoPoint, TruckProps>[] => {
    if (track.line.points.length === 0) return []
    const { at, bearing } = truckAt(track, time)
    const properties = { rid: track.id, rank: track.rank, ...truckPose(bearing) }
    return [{ type: 'Feature', id: r, geometry: { type: 'Point', coordinates: at }, properties }]
  })
  return { type: 'FeatureCollection', features }
}

/** Where a route's truck is at `time`, and the road's heading there (degrees clockwise from north): at the
 * start until it leaves, at the destination once it has arrived, and in between at the mile its checkpoint
 * ETAs give (linear between two checkpoints). The mile is placed along the drawn line in proportion, as
 * simplifying the line shortened it a little. */
export function truckAt(track: TruckTrack, time: number): { at: Point; bearing: number } {
  const { line } = track
  const share = track.totalMiles > 0 ? Math.min(Math.max(mileAt(track, time) / track.totalMiles, 0), 1) : 0
  const metres = share * line.length
  const behind = pointAt(line, metres - HEADING_M)
  const ahead = pointAt(line, metres + HEADING_M)
  return { at: pointAt(line, metres), bearing: bearing(behind, ahead) }
}

/** How to draw a truck heading `bearing`: from the east-facing image for headings up to 180°, from the
 * west-facing one beyond, each turned at most a quarter turn, so the letter on its roof never reads
 * upside down. */
export function truckPose(bearing: number): { west: boolean; rotate: number } {
  return bearing < 180 ? { west: false, rotate: bearing - 90 } : { west: true, rotate: bearing - 270 }
}

/** The time a truck is drawn at after driving toward `target` for `elapsed` ms from `shown`: quickly at
 * first, easing as it nears, and put exactly there once it is close. */
export function approach(shown: number, target: number, elapsed: number): number {
  const next = target + (shown - target) * Math.exp(-Math.max(elapsed, 0) / FOLLOW_MS)
  return Math.abs(target - next) < SETTLED_MS ? target : next
}

/** The mile the truck has reached at `time`, from its checkpoint ETAs. */
function mileAt({ times, miles }: TruckTrack, time: number): number {
  const passed = count(times, eta => eta <= time) // checkpoints reached by then
  if (passed === 0) return miles[0] ?? 0
  if (passed === times.length) return miles[passed - 1]
  const i = passed - 1 // between checkpoints i and i + 1
  return miles[i] + ((miles[i + 1] - miles[i]) * (time - times[i])) / (times[i + 1] - times[i])
}

/** Degrees clockwise from north, from a to b, equirectangular at a's latitude; east when they coincide. */
function bearing([lon1, lat1]: Point, [lon2, lat2]: Point): number {
  const east = (lon2 - lon1) * Math.cos(lat1 * RADIANS_PER_DEGREE)
  const north = lat2 - lat1
  if (east === 0 && north === 0) return 90
  return (Math.atan2(east, north) / RADIANS_PER_DEGREE + 360) % 360
}
