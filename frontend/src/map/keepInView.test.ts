import { describe, expect, it } from 'vitest'
import { cardShift, stackMaxHeight } from './keepInView'

describe('keeping a card in view', () => {
  // A 375 x 340 phone map, 12 px in from each edge and above a 30 px attribution.
  const phone = { left: 12, right: 363, top: 12, bottom: 298 }
  const zoomButtons = { left: 323, right: 363, top: 10, bottom: 90 }

  it('moves a card hanging below the map up into it', () => {
    expect(cardShift({ left: 60, right: 308, top: 212, bottom: 464 }, phone, [])).toEqual({ x: 0, y: -166 })
  })

  it('moves a card running past the right edge back in', () => {
    const narrow = { left: 12, right: 308, top: 12, bottom: 298 } // a 320 px phone
    expect(cardShift({ left: 108, right: 396, top: 20, bottom: 278 }, narrow, [])).toEqual({ x: -88, y: 0 })
  })

  it('keeps the top of a card taller than the map in view', () => {
    expect(cardShift({ left: 60, right: 308, top: 100, bottom: 400 }, phone, [])).toEqual({ x: 0, y: -88 })
  })

  it('steps off an obstacle the shortest way that keeps the card in the map', () => {
    // Moving down 22 px would clear the zoom buttons but push the card out at the bottom.
    expect(cardShift({ left: 60, right: 353, top: 80, bottom: 290 }, phone, [zoomButtons])).toEqual({ x: -42, y: 0 })
  })

  it('leaves a card too tall to fit above the slider card in the map, over the slider card', () => {
    // A 375 x 340 phone map with a 48 px attribution, and the slider card along its bottom.
    const map = { left: 12, right: 363, top: 12, bottom: 280 }
    const sliderCard = { left: 8, right: 367, top: 188, bottom: 286 }
    // Only the move into the map remains: moving up off the slider card would push the card out of the top.
    expect(cardShift({ left: 60, right: 308, top: 72, bottom: 326 }, map, [sliderCard])).toEqual({ x: 0, y: -46 })
  })

  it('never moves a card off one obstacle onto another', () => {
    // 960 x 560: the panel down the left, the dock card along the bottom right.
    const map = { left: 12, right: 948, top: 12, bottom: 516 }
    const panel = { left: 12, right: 392, top: 12, bottom: 548 }
    const dock = { left: 404, right: 948, top: 325, bottom: 520 }
    // The only move that clears the dock card and stays in the map lands on the panel, so the card stays.
    expect(cardShift({ left: 500, right: 800, top: 162, bottom: 470 }, map, [panel, dock])).toEqual({ x: 0, y: 0 })
  })

  it('clears obstacles only, before the map has a size', () => {
    const panel = { left: 12, right: 392, top: 12, bottom: 868 }
    expect(cardShift({ left: 300, right: 548, top: 200, bottom: 452 }, null, [panel])).toEqual({ x: 104, y: 0 })
  })

  it('lets a card listing several checkpoints grow to the map’s height, less room for its tip and dot', () => {
    const laptop = { left: 404, right: 1428, top: 12, bottom: 788 }
    expect(stackMaxHeight(laptop)).toBe(736)
  })

  it('never cuts that card below about one checkpoint, nor before the map has a size', () => {
    expect(stackMaxHeight(phone)).toBe(246)
    expect(stackMaxHeight({ left: 12, right: 363, top: 12, bottom: 120 })).toBe(240) // a map mostly scrolled away
    expect(stackMaxHeight(null)).toBeNull()
  })
})
