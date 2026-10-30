import type { FeatureCollection, LineString, MultiLineString, Point } from 'geojson'
import type { Plan } from '../api/types'
import { DOT_RADIUS, DOT_SPACING_SHARE, NO_DATA_LEVEL } from './mapStyle'
import { routeLayout, type Side } from './plates'

export interface RouteProps {
  rid: string // the route letter
  rank: number
  rec: boolean // the recommended route
}

export interface PlanData {
  routes: FeatureCollection<LineString, RouteProps>
  solo: FeatureCollection<MultiLineString, { rid: string }> // stretches no other route shares
  plates: FeatureCollection<Point, { rid: string; rec: boolean; side: Side }>
  checkpoints: FeatureCollection<Point, { lvl: number; rec: boolean }>
  ends: FeatureCollection<Point, { name: string }>
  dots: DotZooms
  bounds: [[number, number], [number, number]]
}

/** Zooms where checkpoint dots reach their small (zA) and full (zB) size for this plan's spacing. */
export interface DotZooms {
  zA: number
  zB: number
}

/** Feature ids: routes, solo stretches and plates use the route's index; checkpoints this. */
export function checkpointId(route: number, index: number): number {
  return route * 10_000 + index
}

export function checkpointRef(id: number): { route: number; index: number } {
  return { route: Math.floor(id / 10_000), index: id % 10_000 }
}

/** Everything the map draws for a plan. Compute once per plan: the plate layout walks every route. */
export function planData(plan: Plan): PlanData {
  const layout = routeLayout(plan.routes)
  const first = plan.routes[0].geometry
  return {
    routes: {
      type: 'FeatureCollection',
      features: plan.routes.map((route, i) => ({
        type: 'Feature',
        id: i,
        geometry: { type: 'LineString', coordinates: route.geometry },
        properties: { rid: route.id, rank: route.rank, rec: route.recommended },
      })),
    },
    solo: {
      type: 'FeatureCollection',
      features: plan.routes.map((route, i) => ({
        type: 'Feature',
        id: i,
        geometry: { type: 'MultiLineString', coordinates: layout.solo[i] },
        properties: { rid: route.id },
      })),
    },
    plates: {
      type: 'FeatureCollection',
      features: layout.plates.map(plate => ({
        type: 'Feature',
        id: plate.route,
        geometry: { type: 'Point', coordinates: plate.position },
        properties: { rid: plan.routes[plate.route].id, rec: plan.routes[plate.route].recommended, side: plate.side },
      })),
    },
    checkpoints: {
      type: 'FeatureCollection',
      features: plan.routes.flatMap((route, r) =>
        route.checkpoints.map((checkpoint, i) => ({
          type: 'Feature' as const,
          id: checkpointId(r, i),
          geometry: { type: 'Point' as const, coordinates: [checkpoint.lon, checkpoint.lat] },
          properties: { lvl: checkpoint.level ?? NO_DATA_LEVEL, rec: route.recommended },
        })),
      ),
    },
    ends: {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: first[0] }, properties: { name: plan.origin.name } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: first[first.length - 1] }, properties: { name: plan.destination.name } },
      ],
    },
    dots: dotZooms(plan),
    bounds: planBounds(plan),
  }
}

const METERS_PER_PIXEL_Z0 = 78_271.517 // 512 px tiles: the equator's length / 512

/** The zoom where checkpoints sit far enough apart for small dots (zA) and for full-size ones (zB),
 * so dense checkpoints never merge into a solid line (see DOT_RADIUS). */
export function dotZooms(plan: Plan): DotZooms {
  const latitudes = plan.routes.flatMap(route => route.checkpoints.map(checkpoint => checkpoint.lat))
  const meanLat = latitudes.length ? latitudes.reduce((sum, lat) => sum + lat, 0) / latitudes.length : 0
  const spacingZ0 = (plan.interval_miles * 1609.344) / (METERS_PER_PIXEL_Z0 * Math.cos((meanLat * Math.PI) / 180))
  const zA = Math.min(20, Math.max(0, Math.log2(DOT_RADIUS.small / (DOT_SPACING_SHARE * spacingZ0))))
  return { zA, zB: zA + Math.log2(DOT_RADIUS.full / DOT_RADIUS.small) }
}

/** [[west, south], [east, north]] around every route. */
export function planBounds(plan: Plan): [[number, number], [number, number]] {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const route of plan.routes) {
    for (const [lon, lat] of route.geometry) {
      west = Math.min(west, lon)
      east = Math.max(east, lon)
      south = Math.min(south, lat)
      north = Math.max(north, lat)
    }
  }
  return [
    [west, south],
    [east, north],
  ]
}
