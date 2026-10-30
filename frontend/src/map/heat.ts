import type { FeatureCollection, Polygon } from 'geojson'
import type { Heatmap, Level } from '../api/types'
import { NO_DATA_LEVEL } from './mapStyle'

/** Room for one plan's cell ids: consecutive plans number their cells from 0 and from this. */
export const HEAT_ID_SPAN = 1_000_000

/** Whether a plan gets the 0–48 h slider: squares to show, over more than one hour. The trucks go with it. */
export function hasSlider(heatmap: Heatmap): boolean {
  return heatmap.cells.length > 0 && heatmap.hours.length > 1
}

/** The heatmap's cells as squares, id = `base` + the cell's index in the plan (its level is feature-state). */
export function heatCells(heatmap: Heatmap, base = 0): FeatureCollection<Polygon> {
  return {
    type: 'FeatureCollection',
    features: heatmap.cells.map(([west, south, east, north], i) => ({
      type: 'Feature',
      id: base + i,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south],
          ],
        ],
      },
      properties: {},
    })),
  }
}

/** The cells whose level differs between two slider hours, with their new level (No data as -1), so
 * moving the slider sets feature-state only where the map changes. `from` null: every cell. */
export function heatChanges(levels: Level[][], from: number | null, to: number): [cell: number, level: number][] {
  const next = levels[to] ?? []
  const previous = from === null ? null : (levels[from] ?? null)
  const changes: [number, number][] = []
  next.forEach((level, cell) => {
    const value = level ?? NO_DATA_LEVEL
    if (previous === null || (previous[cell] ?? NO_DATA_LEVEL) !== value) changes.push([cell, value])
  })
  return changes
}
