/** Route plates and road-sign icons (MUTCD shapes in plain ink). Icons are decorative: the text
 * beside them always says the same thing. */

import type { TruckShape } from '../lib/truckShape'

export function Plate({ letter, recommended, size }: { letter: string; recommended: boolean; size: 'board' | 'headline' }) {
  return (
    <span className={`plate plate-${size}${recommended ? ' plate-rec' : ''}`} aria-hidden="true">
      {letter}
    </span>
  )
}

/** Unsafe / No Travel. */
export function Octagon({ className = '' }: { className?: string }) {
  return (
    <svg className={`sign ${className}`} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.2 1h5.6L15 5.2v5.6L10.8 15H5.2L1 10.8V5.2z" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 4.5v4.2M8 10.6v.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/** A warning the recommendation carries. */
export function Diamond({ className = '' }: { className?: string }) {
  return (
    <svg className={`sign ${className}`} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.2 14.8 8 8 14.8 1.2 8z" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 5v3.6M8 10.5v.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** A note about the route search or the forecast. */
export function NoteSign({ className = '' }: { className?: string }) {
  return (
    <svg className={`sign ${className}`} viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="1.5" width="12" height="13" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 7v4.5M8 4.6v.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** A field error. */
export function Bang() {
  return (
    <svg className="sign sign-error" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="M8 4.2v4.6M8 11v.6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

/** One of the truck drawings (lib/truckShape.ts) in the current text colour: the waiting animation and the map key. */
export function Truck({ shape, className }: { shape: TruckShape; className: string }) {
  return (
    <svg className={className} viewBox={`0 0 ${shape.width} ${shape.height}`} aria-hidden="true">
      {shape.parts.map(part => (
        <path key={part.d} d={part.d} fill={part.paint === 'body' ? 'currentColor' : '#fff'} opacity={part.opacity} />
      ))}
    </svg>
  )
}

/** The map's No data dot: grey with a dark ring and a question mark. */
export function NoDataDot({ className = '' }: { className?: string }) {
  return (
    <svg className={`sign ${className}`} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="var(--risk-none)" stroke="var(--risk-none-edge)" strokeWidth="2" />
      <text x="8" y="11.2" textAnchor="middle" fontSize="9" fontWeight="800" fill="var(--ink)">
        ?
      </text>
    </svg>
  )
}
