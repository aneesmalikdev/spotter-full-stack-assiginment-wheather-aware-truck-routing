/** Where an open checkpoint card may sit: inside the visible map and clear of what floats over it. */

const CLEARANCE = 12 // px between a card and an edge or obstacle
const STACK_RESERVE = 40 // px a card listing several checkpoints leaves for its tip, its offset and its dot
const STACK_FLOOR = 240 // px: about one checkpoint's section, the least such a card is cut to

export interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

/** The part of the map a card can use, in window coordinates: the map's box within the window, 12 px in
 *  from its edges and above the attribution. null before the map has a size (as in tests). */
export function visibleArea(container: HTMLElement): Box | null {
  const map = container.getBoundingClientRect()
  if (map.width === 0 || map.height === 0) return null
  const attribution = container.querySelector('.maplibregl-ctrl-bottom-right')?.getBoundingClientRect()
  const floor = attribution && attribution.height > 0 ? attribution.top : map.bottom
  return {
    left: Math.max(map.left, 0) + CLEARANCE,
    right: Math.min(map.right, window.innerWidth) - CLEARANCE,
    top: Math.max(map.top, 0) + CLEARANCE,
    bottom: Math.min(map.bottom, floor, window.innerHeight) - CLEARANCE,
  }
}

/** How tall a card listing several checkpoints may grow before it scrolls: the area's height, less room
 *  for its tip and its dot, so the dot stays in view too; but never less than about one checkpoint's
 *  section (on a phone the map can be mostly scrolled away), and then cardShift lines up its top. null
 *  before the map has a size. */
export function stackMaxHeight(area: Box | null): number | null {
  return area ? Math.max(area.bottom - area.top - STACK_RESERVE, STACK_FLOOR) : null
}

/** How far an open card must move on screen to sit inside `area` and 12 px clear of each obstacle (the
 *  panel, the dock, the zoom buttons, the phone's slider card), the shortest way. MapLibre only flips a card
 *  to the side of its dot with more room, so on a small map it can still hang over an edge. A move off one
 *  obstacle must keep the card inside the area and off every other obstacle; when none can, the card stays
 *  where it is and draws over the obstacle (index.css: .cp-popup). */
export function cardShift(card: Box, area: Box | null, obstacles: Box[]): { x: number; y: number } {
  let x = area ? fit(card.left, card.right, area.left, area.right) : 0
  let y = area ? fit(card.top, card.bottom, area.top, area.bottom) : 0
  for (const o of obstacles) {
    const p = moved(card, x, y)
    if (!hits(p, o)) continue
    const moves = [
      { x: o.right + CLEARANCE - p.left, y: 0 },
      { x: o.left - CLEARANCE - p.right, y: 0 },
      { x: 0, y: o.bottom + CLEARANCE - p.top },
      { x: 0, y: o.top - CLEARANCE - p.bottom },
    ].filter(move => {
      const q = moved(p, move.x, move.y)
      return (!area || inside(q, area)) && obstacles.every(other => !hits(q, other))
    })
    if (moves.length === 0) continue
    const best = moves.reduce((a, b) => (Math.abs(b.x + b.y) < Math.abs(a.x + a.y) ? b : a))
    x += best.x
    y += best.y
  }
  return { x, y }
}

/** Whether a card comes within 12 px of an obstacle (one with no width, such as a hidden one, never counts). */
function hits(card: Box, o: Box): boolean {
  return (
    o.right > o.left &&
    card.left < o.right + CLEARANCE &&
    card.right > o.left - CLEARANCE &&
    card.top < o.bottom + CLEARANCE &&
    card.bottom > o.top - CLEARANCE
  )
}

/** The move that brings [start, end] inside [min, max]; a span too long for it lines up with min (the
 *  card's title and close button). */
function fit(start: number, end: number, min: number, max: number): number {
  if (end - start > max - min || start < min) return min - start
  return end > max ? max - end : 0
}

function moved(box: Box, x: number, y: number): Box {
  return { left: box.left + x, right: box.right + x, top: box.top + y, bottom: box.bottom + y }
}

function inside(box: Box, area: Box): boolean {
  return box.left >= area.left && box.right <= area.right && box.top >= area.top && box.bottom <= area.bottom
}
