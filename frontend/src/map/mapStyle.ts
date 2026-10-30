/** Map colours and sizes. The panel uses the same values as CSS custom properties. */

export const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron'

/** The contiguous US, shown before the first plan. */
export const LOWER_48: [[number, number], [number, number]] = [
  [-124.8, 24.4],
  [-66.9, 49.4],
]

export const C = {
  low: '#caeed0',
  moderate: '#f9c718',
  high: '#f58028',
  severe: '#d7352d',
  noTravel: '#871b63',
  noData: '#9da2a8',
  noDataEdge: '#2f353a',
  ink: '#1f2429',
  ink2: '#454b52',
  other: '#7a8188',
  dim: '#b2b6ba',
  dimText: '#959aa0',
  white: '#ffffff',
} as const

/** Stands for No data in feature properties and heat feature-state (MapLibre drops properties that are null). */
export const NO_DATA_LEVEL = -1

/** Heat cells: each level's colour at this opacity over the land, so Low is a faint wash that still
 * shows where the corridor runs. No data cells are also hatched. */
export const HEAT_OPACITY = { 0: 0.6, 1: 0.8, 2: 0.9, 3: 0.95, 4: 0.9, noData: 0.75 } as const

/** Checkpoint dot radius in px at the plan's small (zA), full (zB) and close-up (zB + 4) zooms,
 * before LEVEL_SIZE. Between zA and zB a Moderate dot's radius is 35 % of the gap to the next checkpoint,
 * so neighbouring dots stay apart (the worst levels, drawn larger, may touch). */
export const DOT_RADIUS = { small: 2.5, full: 5, close: 7 } as const
export const DOT_SPACING_SHARE = 0.35

/** Dot radius multiplier by level: worse levels draw larger, so size also carries the level. */
export const LEVEL_SIZE = { 0: 0.8, 1: 1, 2: 1.125, 3: 1.25, 4: 1.375, noData: 1 } as const

/** Plates: route letters on highway-sign panels. */
export const PLATE = {
  body: 22, // CSS px
  radius: 5,
  pointer: 6,
  pointerBase: 10,
  margin: 1.5,
  border: 1.5,
  textSize: 13,
} as const

/** From the plate image's anchored edge (at the pointer) to the centre of its body, in ems. */
export const PLATE_LETTER_OFFSET = (PLATE.margin + PLATE.pointer + PLATE.body / 2) / PLATE.textSize
