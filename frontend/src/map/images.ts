import type { ExpressionSpecification, MapLibreMap } from 'maplibre-gl'
import { TOP_TRUCK } from '../lib/truckShape'
import { C, PLATE } from './mapStyle'

const PIXEL_RATIO = 2
export const PLATE_SIDES = ['n', 's', 'e', 'w'] as const

/** Plate images, named plate-{rec|alt}-{side}: a rounded panel with a pointer toward the route.
 * "n" sits north of its point with the pointer down; the others are the same shape rotated. */
export function addPlateImages(map: MapLibreMap): void {
  for (const kind of ['rec', 'alt'] as const) {
    for (const side of PLATE_SIDES) {
      const image = drawPlate(kind, side)
      if (image) map.addImage(`plate-${kind}-${side}`, image, { pixelRatio: PIXEL_RATIO })
    }
  }
}

function drawPlate(kind: 'rec' | 'alt', side: (typeof PLATE_SIDES)[number]): ImageData | null {
  const { body, pointer, margin } = PLATE
  const long = body + pointer + 2 * margin // along the pointer
  const short = body + 2 * margin
  const vertical = side === 'n' || side === 's'
  const width = (vertical ? short : long) * PIXEL_RATIO
  const height = (vertical ? long : short) * PIXEL_RATIO
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null

  // Draw the "n" shape (pointer down) in CSS px, rotated about the image centre for other sides.
  context.scale(PIXEL_RATIO, PIXEL_RATIO)
  context.translate(width / PIXEL_RATIO / 2, height / PIXEL_RATIO / 2)
  context.rotate({ n: 0, s: Math.PI, e: Math.PI / 2, w: -Math.PI / 2 }[side])
  context.translate(-short / 2, -long / 2)

  if (kind === 'rec') {
    platePath(context, 0)
    context.lineJoin = 'round'
    context.lineWidth = 2 * PLATE.border // half of it shows outside: a white halo
    context.strokeStyle = C.white
    context.stroke()
    context.fillStyle = C.ink
    context.fill()
  } else {
    platePath(context, 0)
    context.fillStyle = C.white
    context.fill()
    platePath(context, PLATE.border / 2) // a border drawn just inside the edge
    context.lineJoin = 'round'
    context.lineWidth = PLATE.border
    context.strokeStyle = C.other
    context.stroke()
  }
  return context.getImageData(0, 0, width, height)
}

/** The plate outline: a rounded square with a pointer centred under it, shrunk by `inset`. */
function platePath(context: CanvasRenderingContext2D, inset: number): void {
  const { body, radius, pointer, pointerBase, margin } = PLATE
  const left = margin + inset
  const top = margin + inset
  const right = margin + body - inset
  const bottom = margin + body - inset
  const r = radius - inset
  const middle = margin + body / 2
  const halfBase = pointerBase / 2 - inset
  context.beginPath()
  context.moveTo(left + r, top)
  context.arcTo(right, top, right, bottom, r)
  context.arcTo(right, bottom, left, bottom, r)
  context.lineTo(middle + halfBase, bottom)
  context.lineTo(middle, bottom + pointer - inset)
  context.lineTo(middle - halfBase, bottom)
  context.arcTo(left, bottom, left, top, r)
  context.arcTo(left, top, right, top, r)
  context.closePath()
}

const TRUCK_SCALE = 1.2 // CSS px per unit of the top-down truck's 40 x 16 grid: about 48 x 19 px
const TRUCK_HALO = 1.5 // CSS px of white round the truck, so it stands out on lines, dots and squares
const TRUCK_LETTERS = ['A', 'B', 'C'] // the API names routes A to C
const LETTER_SIZE = 10 // grid units, about 12 px
const LETTER_FONT = "'Overpass Variable', system-ui, sans-serif"

type TruckColour = 'ink' | 'other'

const truckImageName = (colour: TruckColour, west: boolean, letter: string) => `truck-${colour}-${west ? 'w' : 'e'}-${letter}`

/** The icon-image expression for a truck layer: each feature's truck by its route letter (rid) and the
 * image it is drawn from (west). */
export function truckIcon(colour: TruckColour): ExpressionSpecification {
  return ['concat', `truck-${colour}-`, ['case', ['boolean', ['get', 'west'], false], 'w', 'e'], '-', ['get', 'rid']]
}

/** Trucks seen from above, heading east and west, with each route's letter on the trailer's roof: dark for
 * the spotlighted route, grey for the others. The map turns them to the road (trucks.ts, truckPose). */
export function addTruckImages(map: MapLibreMap): void {
  for (const colour of ['ink', 'other'] as const) {
    for (const west of [false, true]) {
      for (const letter of TRUCK_LETTERS) {
        const image = drawTruck(C[colour], west, letter)
        if (image) map.addImage(truckImageName(colour, west, letter), image, { pixelRatio: PIXEL_RATIO })
      }
    }
  }
}

/** The top-down truck (lib/truckShape.ts) with a white halo, mirrored when it heads west, and the route's
 * letter in white on the trailer's roof, never mirrored. */
function drawTruck(colour: string, west: boolean, letter: string): ImageData | null {
  const { width: gridWidth, height: gridHeight, parts, trailer } = TOP_TRUCK
  const width = Math.ceil((gridWidth * TRUCK_SCALE + 2 * TRUCK_HALO) * PIXEL_RATIO)
  const height = Math.ceil((gridHeight * TRUCK_SCALE + 2 * TRUCK_HALO) * PIXEL_RATIO)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null
  context.scale(PIXEL_RATIO, PIXEL_RATIO)
  context.translate(TRUCK_HALO, TRUCK_HALO)
  context.scale(TRUCK_SCALE, TRUCK_SCALE) // grid units from here on

  context.save()
  if (west) {
    context.translate(gridWidth, 0)
    context.scale(-1, 1)
  }
  const paths = parts.map(part => ({ ...part, path: new Path2D(part.d) }))
  context.lineJoin = 'round'
  context.lineWidth = (2 * TRUCK_HALO) / TRUCK_SCALE // half of it shows outside the shape
  context.strokeStyle = C.white
  for (const part of paths) if (part.paint === 'body') context.stroke(part.path)
  for (const part of paths) {
    context.globalAlpha = part.opacity ?? 1
    context.fillStyle = part.paint === 'body' ? colour : C.white
    context.fill(part.path)
  }
  context.restore() // also back to full opacity

  context.fillStyle = C.white
  context.font = `700 ${LETTER_SIZE}px ${LETTER_FONT}`
  context.textAlign = 'center'
  context.textBaseline = 'alphabetic'
  const capHeight = 0.7 * LETTER_SIZE
  context.fillText(letter, west ? gridWidth - trailer.x : trailer.x, trailer.y + capHeight / 2)
  return context.getImageData(0, 0, width, height)
}

export const HATCH = 'hatch-nodata'
const HATCH_TILE = 10 // CSS px

/** No data heat cells: one 45° line per 10 px tile, plus its two corner pieces so the tiles join. */
export function addHatchImage(map: MapLibreMap): void {
  const size = HATCH_TILE * PIXEL_RATIO
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) return
  context.strokeStyle = 'rgba(47, 53, 58, 0.55)'
  context.lineWidth = 2 // device px
  for (const shift of [-size, 0, size]) {
    context.beginPath()
    context.moveTo(shift, size)
    context.lineTo(shift + size, 0)
    context.stroke()
  }
  map.addImage(HATCH, context.getImageData(0, 0, size, size), { pixelRatio: PIXEL_RATIO })
}
