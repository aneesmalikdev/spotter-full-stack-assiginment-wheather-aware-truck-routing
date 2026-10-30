/** The app's truck as SVG paths: from the side for the waiting animation, and from above for the map,
 * where it turns with the road, and for the map key. */

export interface TruckPart {
  d: string
  paint: 'body' | 'light' // the truck's colour, or white
  opacity?: number
}

export interface TruckShape {
  width: number // grid units
  height: number
  parts: TruckPart[]
}

/** A circle as a path: two half arcs. */
const circle = (x: number, y: number, r: number) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`

/** In side view, facing right, on a 48 x 22 grid. */
export const SIDE_TRUCK: TruckShape = {
  width: 48,
  height: 22,
  parts: [
    { d: 'M2.5 2h26a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5h-26A1.5 1.5 0 0 1 1 13.5v-10A1.5 1.5 0 0 1 2.5 2z', paint: 'body' }, // trailer
    { d: 'M30 12h3.5v2H30z', paint: 'body' }, // hitch
    { d: 'M33 5h7.2a2 2 0 0 1 1.6.8l3.6 4.8a2 2 0 0 1 .4 1.2V15H33z', paint: 'body' }, // cab
    { d: 'M35.2 7.2h4.4l2.5 3.4h-6.9z', paint: 'light', opacity: 0.85 }, // window
    ...[7, 13.5, 39.5].flatMap((x): TruckPart[] => [
      { d: circle(x, 17.5, 3.2), paint: 'body' }, // wheel
      { d: circle(x, 17.5, 1.2), paint: 'light' }, // hub
    ]),
  ],
}

/** Seen from above, heading right (east), on a 40 x 16 grid. `trailer` is the middle of the trailer's
 * roof, where the map paints the route letter. */
export const TOP_TRUCK: TruckShape & { trailer: { x: number; y: number } } = {
  width: 40,
  height: 16,
  trailer: { x: 14, y: 8 },
  parts: [
    { d: 'M2.2 2h23.6a1.2 1.2 0 0 1 1.2 1.2v9.6a1.2 1.2 0 0 1-1.2 1.2H2.2A1.2 1.2 0 0 1 1 12.8V3.2A1.2 1.2 0 0 1 2.2 2z', paint: 'body' }, // trailer
    { d: 'M27 6.5h2.5v3H27z', paint: 'body' }, // coupling
    { d: 'M29.5 2.5h6.5a2.5 2.5 0 0 1 2.5 2.5v6a2.5 2.5 0 0 1-2.5 2.5h-6.5z', paint: 'body' }, // cab, rounded at the front
    { d: 'M33.2 1.2h1.2v1.3h-1.2zM33.2 13.5h1.2v1.3h-1.2z', paint: 'body' }, // mirrors
    { d: 'M34 3.8h1.7v8.4H34z', paint: 'light', opacity: 0.85 }, // windscreen
  ],
}
