import type { DataDrivenPropertyValueSpecification, ExpressionSpecification, MapLibreMap } from 'maplibre-gl'
import type { DotZooms } from './geojson'
import { HATCH, addHatchImage, addPlateImages, addTruckImages, truckIcon } from './images'
import { C, DOT_RADIUS, HEAT_OPACITY, LEVEL_SIZE, NO_DATA_LEVEL, PLATE, PLATE_LETTER_OFFSET } from './mapStyle'

export const SOURCE = {
  heat: 'heat',
  routes: 'routes',
  solo: 'route-solo',
  plates: 'plates',
  checkpoints: 'checkpoints',
  ends: 'ends',
  trucks: 'trucks',
} as const

export const LAYER = {
  heat: 'heat-fill',
  heatNoData: 'heat-nodata',
  checkpoints: 'checkpoints',
  checkpointsSpot: 'checkpoints-spot',
  selected: 'checkpoint-selected',
  noDataMark: 'checkpoint-nodata-mark',
} as const

/** A heat cell's level at the slider's hour, set as feature-state; -2 (drawn clear) until it is set. */
const HEAT_LEVEL: ExpressionSpecification = ['number', ['feature-state', 'lvl'], -2]

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
const ROUND = { 'line-join': 'round', 'line-cap': 'round' } as const

const zoom = (...stops: number[]): ExpressionSpecification => ['interpolate', ['linear'], ['zoom'], ...stops]
const state = (key: string): ExpressionSpecification => ['boolean', ['feature-state', key], false]
const LEVEL: ExpressionSpecification = ['get', 'lvl']
const REC: ExpressionSpecification = ['boolean', ['get', 'rec'], false]

/** Worse levels, and the recommended route's dots, draw on top. */
const DOT_SORT: ExpressionSpecification = ['+', ['match', LEVEL, -1, 0.5, LEVEL], ['case', REC, 0.05, 0]]

/** Starting dot sizes, replaced for each plan by dotPaint(). */
const DEFAULT_ZOOMS: DotZooms = { zA: 3.5, zB: 4.5 } // checkpoints every 25 mi at the US's latitude

/** Sources and layers for a plan, all empty until the first plan. Call once the style has loaded. */
export function addPlanLayers(map: MapLibreMap): void {
  addPlateImages(map)
  addHatchImage(map)
  addTruckImages(map)
  const layers = map.getStyle().layers
  const routesBefore = layers.find(layer => layer.type === 'symbol')?.id // under the basemap's labels
  // Just above the basemap's last area fill: the heat tints land, water and parks, while roads, rail,
  // boundaries and labels stay on top of it.
  const lastFill = layers.findLastIndex(layer => layer.type === 'fill')
  const heatBefore = lastFill >= 0 ? layers[lastFill + 1]?.id : routesBefore

  for (const id of Object.values(SOURCE)) {
    // Heat cells are squares: simplifying them would bend the shared edges apart.
    map.addSource(id, { type: 'geojson', data: EMPTY, ...(id === SOURCE.heat && { tolerance: 0 }) })
  }

  map.addLayer(
    {
      id: LAYER.heat,
      type: 'fill',
      source: SOURCE.heat,
      paint: {
        'fill-antialias': false, // neighbouring cells share their edges exactly, so no seams show
        'fill-color': ['match', HEAT_LEVEL, 0, C.low, 1, C.moderate, 2, C.high, 3, C.severe, 4, C.noTravel, C.noData],
        'fill-opacity': [
          'match', HEAT_LEVEL,
          0, HEAT_OPACITY[0], 1, HEAT_OPACITY[1], 2, HEAT_OPACITY[2], 3, HEAT_OPACITY[3], 4, HEAT_OPACITY[4],
          NO_DATA_LEVEL, HEAT_OPACITY.noData,
          0,
        ],
      },
    },
    heatBefore,
  )
  map.addLayer(
    {
      id: LAYER.heatNoData,
      type: 'fill',
      source: SOURCE.heat,
      paint: {
        'fill-antialias': false,
        'fill-pattern': HATCH,
        'fill-opacity': ['case', ['==', HEAT_LEVEL, NO_DATA_LEVEL], 1, 0], // a pattern can't read feature-state; opacity can
      },
    },
    heatBefore,
  )

  const sortByRank: ExpressionSpecification = ['-', 0, ['get', 'rank']]
  map.addLayer(
    {
      id: 'route-casing',
      type: 'line',
      source: SOURCE.routes,
      layout: { ...ROUND, 'line-sort-key': sortByRank },
      paint: { 'line-color': C.white, 'line-width': zoom(3, 4, 6, 5.5, 9, 7, 12, 9) },
    },
    routesBefore,
  )
  map.addLayer(
    {
      id: 'route-line',
      type: 'line',
      source: SOURCE.routes,
      layout: { ...ROUND, 'line-sort-key': sortByRank },
      paint: { 'line-color': ['case', state('dim'), C.dim, C.other], 'line-width': zoom(3, 2, 6, 3, 9, 4, 12, 5) },
    },
    routesBefore,
  )
  // Sort keys can't read feature-state, so the spotlighted route is drawn again by its own pair of layers.
  map.addLayer(
    {
      id: 'route-spot-casing',
      type: 'line',
      source: SOURCE.routes,
      layout: ROUND,
      paint: {
        'line-color': C.white,
        'line-width': zoom(3, 7, 6, 9, 9, 12, 12, 14),
        'line-opacity': ['case', state('spot'), 1, 0],
      },
    },
    routesBefore,
  )
  map.addLayer(
    {
      id: 'route-spot-line',
      type: 'line',
      source: SOURCE.routes,
      layout: ROUND,
      paint: {
        'line-color': C.ink,
        'line-width': zoom(3, 3.5, 6, 5, 9, 7, 12, 9),
        'line-opacity': ['case', state('spot'), 1, 0],
      },
    },
    routesBefore,
  )
  // Letters along stretches no other route shares, below the basemap's labels so they give way to them.
  map.addLayer(
    {
      id: 'route-letters',
      type: 'symbol',
      source: SOURCE.solo,
      minzoom: 7,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 360,
        'text-field': ['get', 'rid'],
        'text-font': ['Noto Sans Bold'],
        'text-size': zoom(7, 13, 12, 16),
        'text-rotation-alignment': 'map',
        'text-keep-upright': true,
        'text-offset': [0, -1.3], // beside the line, so dots never cover it
        'text-padding': 6,
      },
      paint: {
        'text-color': ['case', state('spot'), C.ink, state('dim'), C.dimText, C.ink2],
        'text-halo-color': C.white,
        'text-halo-width': 2,
        'text-halo-blur': 0.5,
      },
    },
    routesBefore,
  )

  // Above the basemap's labels:
  map.addLayer({
    id: LAYER.checkpoints,
    type: 'circle',
    source: SOURCE.checkpoints,
    layout: { 'circle-sort-key': DOT_SORT },
    paint: { ...dotPaint(DEFAULT_ZOOMS), 'circle-opacity': ['case', state('dim'), 0.25, 1], 'circle-stroke-opacity': ['case', state('dim'), 0.25, 1] },
  })
  map.addLayer({
    id: LAYER.checkpointsSpot,
    type: 'circle',
    source: SOURCE.checkpoints,
    layout: { 'circle-sort-key': DOT_SORT },
    paint: { ...dotPaint(DEFAULT_ZOOMS), 'circle-opacity': ['case', state('spot'), 1, 0], 'circle-stroke-opacity': ['case', state('spot'), 1, 0] },
  })
  // A ring round the dot whose details are open.
  map.addLayer({
    id: LAYER.selected,
    type: 'circle',
    source: SOURCE.checkpoints,
    paint: {
      'circle-radius': ringRadius(DEFAULT_ZOOMS),
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': C.ink,
      'circle-stroke-width': 2.5,
      'circle-stroke-opacity': ['case', state('selected'), 1, 0],
    },
  })
  map.addLayer({
    id: LAYER.noDataMark,
    type: 'symbol',
    source: SOURCE.checkpoints,
    minzoom: DEFAULT_ZOOMS.zB,
    filter: ['==', LEVEL, -1],
    layout: {
      'text-field': '?',
      'text-font': ['Noto Sans Bold'],
      'text-size': noDataMarkSize(DEFAULT_ZOOMS),
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': C.ink, 'text-opacity': ['case', state('dim'), 0.25, 1] },
  })
  map.addLayer({
    id: 'endpoint-rings',
    type: 'circle',
    source: SOURCE.ends,
    paint: {
      'circle-radius': zoom(3, 6, 8, 8, 12, 10),
      'circle-color': 'rgba(0,0,0,0)', // hollow, so the first and last dots show inside
      'circle-stroke-width': 2.5,
      'circle-stroke-color': C.ink,
    },
  })
  map.addLayer({
    id: 'endpoint-labels',
    type: 'symbol',
    source: SOURCE.ends,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Bold'],
      'text-size': 12,
      'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
      'text-radial-offset': 1.1,
      'text-justify': 'auto',
      'text-max-width': 12,
      'text-padding': 4,
    },
    paint: { 'text-color': C.ink, 'text-halo-color': C.white, 'text-halo-width': 2, 'text-halo-blur': 0.5 },
  })
  const side: ExpressionSpecification = ['get', 'side']
  const offset = PLATE_LETTER_OFFSET
  map.addLayer({
    id: 'route-plates',
    type: 'symbol',
    source: SOURCE.plates,
    layout: {
      'icon-image': ['concat', 'plate-', ['case', REC, 'rec', 'alt'], '-', side],
      'icon-anchor': ['match', side, 'n', 'bottom', 's', 'top', 'e', 'left', 'right'],
      'icon-allow-overlap': true,
      'text-field': ['get', 'rid'],
      'text-font': ['Noto Sans Bold'],
      'text-size': PLATE.textSize,
      'text-anchor': 'center',
      'text-offset': [
        'match',
        side,
        'n', ['literal', [0, -offset]],
        's', ['literal', [0, offset]],
        'e', ['literal', [offset, 0]],
        ['literal', [-offset, 0]],
      ],
      'text-allow-overlap': true,
      'symbol-sort-key': ['case', REC, 1, 0], // with overlap allowed, a higher key draws on top
    },
    paint: {
      'text-color': ['case', REC, C.white, C.ink2],
      'icon-opacity': ['case', state('dim'), 0.45, 1],
      'text-opacity': ['case', state('dim'), 0.45, 1],
    },
  })
  // Each route's truck where it is at the slider's hour, seen from above and turned to the road, with the
  // route's letter on its roof: grey, and the spotlighted route's drawn again in ink on top, as the route
  // lines are.
  for (const colour of ['other', 'ink'] as const) {
    map.addLayer({
      id: colour === 'ink' ? 'trucks-spot' : 'trucks',
      type: 'symbol',
      source: SOURCE.trucks,
      layout: {
        'icon-image': truckIcon(colour),
        'icon-rotate': ['number', ['get', 'rotate'], 0],
        'icon-rotation-alignment': 'map', // turned with the road, centred on it
        'icon-size': zoom(3, 0.85, 8, 1, 12, 1.15),
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['-', 0, ['get', 'rank']], // with overlap allowed, a higher key draws on top
      },
      paint: { 'icon-opacity': colour === 'ink' ? ['case', state('spot'), 1, 0] : ['case', state('dim'), 0.45, 1] },
    })
  }
}

/** Dot size and ring width for a plan's checkpoint spacing (see dotZooms). */
export function dotPaint({ zA, zB }: DotZooms): {
  'circle-color': DataDrivenPropertyValueSpecification<string>
  'circle-radius': DataDrivenPropertyValueSpecification<number>
  'circle-stroke-width': DataDrivenPropertyValueSpecification<number>
  'circle-stroke-color': DataDrivenPropertyValueSpecification<string>
} {
  return {
    'circle-color': ['match', LEVEL, 0, C.low, 1, C.moderate, 2, C.high, 3, C.severe, 4, C.noTravel, C.noData],
    'circle-radius': dotRadius({ zA, zB }, 0),
    'circle-stroke-width': [
      'interpolate', ['linear'], ['zoom'],
      zA - 1, ['match', LEVEL, 0, 0.4, -1, 1.25, 3, 1.25, 4, 1.25, 1],
      zA, ['match', LEVEL, 0, 0.75, -1, 1.25, 3, 1.25, 4, 1.25, 1],
      zB, ['match', LEVEL, 0, 1, -1, 2, 3, 2, 4, 2, 1.5],
    ],
    // Low is pale, so it gets a thin dark ring instead of the white one the others wear.
    'circle-stroke-color': ['match', LEVEL, 0, 'rgba(31,36,41,0.55)', -1, C.noDataEdge, C.white],
  }
}

const LEVEL_FACTOR: ExpressionSpecification = [
  'match', LEVEL,
  0, LEVEL_SIZE[0], 1, LEVEL_SIZE[1], 2, LEVEL_SIZE[2], 3, LEVEL_SIZE[3], 4, LEVEL_SIZE[4],
  LEVEL_SIZE.noData,
]

/** A dot's radius by zoom and level, plus `extra` px (for the ring around a selected dot). Below zA dots
 *  keep their small size, except Low ones: they go on shrinking with the gaps for one more zoom level, or
 *  zoomed out they would merge into a pale band hiding which route is the recommended one. */
function dotRadius({ zA, zB }: DotZooms, extra: number): ExpressionSpecification {
  const at = (px: number | ExpressionSpecification): ExpressionSpecification => ['+', ['*', px, LEVEL_FACTOR], extra]
  const lowShrinks: ExpressionSpecification = ['match', LEVEL, 0, DOT_RADIUS.small / 2, DOT_RADIUS.small]
  return [
    'interpolate', ['exponential', 2], ['zoom'],
    zA - 1, at(lowShrinks),
    zA, at(DOT_RADIUS.small),
    zB, at(DOT_RADIUS.full),
    zB + 4, at(DOT_RADIUS.close),
  ]
}

function ringRadius(zooms: DotZooms): ExpressionSpecification {
  return dotRadius(zooms, 4)
}

export function noDataMarkSize({ zB }: DotZooms): ExpressionSpecification {
  return zoom(zB, 8, zB + 4, 10)
}

/** Resize the dots for a new plan's checkpoint spacing. */
export function applyDotZooms(map: MapLibreMap, zooms: DotZooms): void {
  const paint = dotPaint(zooms)
  for (const layer of [LAYER.checkpoints, LAYER.checkpointsSpot]) {
    map.setPaintProperty(layer, 'circle-radius', paint['circle-radius'])
    map.setPaintProperty(layer, 'circle-stroke-width', paint['circle-stroke-width'])
  }
  map.setPaintProperty(LAYER.selected, 'circle-radius', ringRadius(zooms))
  map.setLayerZoomRange(LAYER.noDataMark, zooms.zB, 24)
  map.setLayoutProperty(LAYER.noDataMark, 'text-size', noDataMarkSize(zooms))
}
