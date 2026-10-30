import { describe, expect, it } from 'vitest'
import type { Level } from '../api/types'
import { heatmap } from '../test/fixtures'
import { HEAT_ID_SPAN, hasSlider, heatCells, heatChanges } from './heat'
import { NO_DATA_LEVEL } from './mapStyle'

describe('heat cells', () => {
  it('draws each cell as a square, with its index after the plan’s first id as its id', () => {
    const heatmap = {
      cell_deg: 0.5,
      band_miles: 30,
      cells: [
        [-97.5, 33, -97, 33.5],
        [-97, 33, -96.5, 33.5],
      ] as [number, number, number, number][],
      hours: [],
      levels: [],
    }
    const cells = heatCells(heatmap, HEAT_ID_SPAN)
    expect(cells.features.map(feature => feature.id)).toEqual([HEAT_ID_SPAN, HEAT_ID_SPAN + 1])
    expect(cells.features[1].geometry.coordinates).toEqual([
      [
        [-97, 33],
        [-96.5, 33],
        [-96.5, 33.5],
        [-97, 33.5],
        [-97, 33],
      ],
    ])
  })
})

describe('heat changes', () => {
  const levels: Level[][] = [
    [0, null, 3],
    [0, 1, 3],
    [2, 1, null],
  ]

  it('colours every cell for a plan’s first hour, No data included', () => {
    expect(heatChanges(levels, null, 0)).toEqual([
      [0, 0],
      [1, NO_DATA_LEVEL],
      [2, 3],
    ])
  })

  it('sets only the cells whose level differs between two hours', () => {
    expect(heatChanges(levels, 0, 1)).toEqual([[1, 1]])
    expect(heatChanges(levels, 1, 2)).toEqual([
      [0, 2],
      [2, NO_DATA_LEVEL],
    ])
    expect(heatChanges(levels, 2, 0)).toEqual([
      [0, 0],
      [1, NO_DATA_LEVEL],
      [2, 3],
    ])
    expect(heatChanges(levels, 1, 1)).toEqual([])
  })
})

describe('the slider', () => {
  it('comes with squares over more than one hour', () => {
    expect(hasSlider(heatmap(2))).toBe(true)
    expect(hasSlider(heatmap(0))).toBe(false) // no squares
    expect(hasSlider({ ...heatmap(2), hours: heatmap(2).hours.slice(0, 1) })).toBe(false) // one hour
  })
})
