import { LEVEL_NAMES, NO_DATA } from '../lib/format'
import { TOP_TRUCK } from '../lib/truckShape'
import { NoDataDot, Truck } from './signs'

/** What the map's colours and lines mean. `heat`: the plan has heat cells, so the key shows their squares. */
export function MapKey({ heat }: { heat: boolean }) {
  return (
    <section className="key" aria-labelledby="key-heading">
      <h2 id="key-heading" className="key-heading">
        Map key
      </h2>
      <ul className="key-levels" role="list">
        {LEVEL_NAMES.map((name, level) => (
          <li key={name}>
            <span className={`dot dot-${level} key-dot`} aria-hidden="true" />
            {heat && <span className={`key-square key-square-${level}`} aria-hidden="true" />}
            {name}
          </li>
        ))}
        <li>
          <NoDataDot className="key-dot" />
          {heat && <span className="key-square key-square-none" aria-hidden="true" />}
          {NO_DATA}
        </li>
      </ul>
      <p className="key-text">
        <span>Dots: risk when the truck gets there (ETA). Select a dot for details.</span>
        {heat && <span>Squares: risk at the slider’s hour.</span>}
        {heat && (
          <span className="key-line">
            <Truck shape={TOP_TRUCK} className="key-truck" />
            Each route’s truck at the slider’s hour
          </span>
        )}
        <span className="key-line">
          <svg viewBox="0 0 24 8" aria-hidden="true">
            <path d="M1 4h22" stroke="#fff" strokeWidth="7" strokeLinecap="round" />
            <path d="M1 4h22" stroke="var(--ink)" strokeWidth="4" strokeLinecap="round" />
          </svg>
          Recommended or selected route
        </span>
        <span className="key-line">
          <svg viewBox="0 0 24 8" aria-hidden="true">
            <path d="M1 4h22" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
            <path d="M1 4h22" stroke="var(--border-strong)" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          Other routes
        </span>
      </p>
    </section>
  )
}
