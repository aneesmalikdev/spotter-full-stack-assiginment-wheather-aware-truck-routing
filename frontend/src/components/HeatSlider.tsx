import { type CSSProperties, useRef, useSyncExternalStore } from 'react'
import type { Heatmap } from '../api/types'
import type { HourStore } from '../lib/hourStore'
import { formatDayTime, formatSpokenDayTime } from '../lib/time'

const TICK_EVERY = 6 // hours between tick marks
const LABEL_EVERY = 12 // hours between tick labels

interface Props {
  heatmap: Heatmap // with at least two hours
  hour: HourStore
}

/** The forecast slider: which hour after departure the heat cells show. Every hour came with the
 * plan, so moving it never fetches. */
export function HeatSlider({ heatmap, hour }: Props) {
  const last = heatmap.hours.length - 1
  const h = Math.min(useSyncExternalStore(hour.subscribe, hour.get), last)
  // Android Chrome moves the thumb to where a finger lands, before it knows the finger means to scroll
  // the page: when the browser takes the touch for a scroll, the hour goes back to what it was.
  const beforeTouch = useRef<number | null>(null)
  const at = heatmap.hours[h]
  const share = (n: number) => `${(n / last) * 100}%`
  const after = h === 0 ? 'at departure' : `${h} ${h === 1 ? 'hour' : 'hours'} after departure`
  const ticks = Array.from({ length: Math.floor(last / TICK_EVERY) + 1 }, (_, i) => i * TICK_EVERY)

  return (
    <div className="heat-slider">
      {/* The input says the same through aria-valuetext. */}
      <p className="heat-readout" aria-hidden="true">
        <span className="heat-label">Heatmap at</span>
        <span className="heat-time">{formatDayTime(at)}</span>
        <span className="heat-offset">+{h} h</span>
      </p>
      <input
        type="range"
        className="heat-range"
        min={0}
        max={last}
        step={1}
        value={h}
        aria-label="Heatmap hour"
        aria-valuetext={`${formatSpokenDayTime(at)}, ${after}`}
        style={{ '--pct': share(h) } as CSSProperties} // the track fills up to the thumb
        onChange={event => hour.set(Number(event.currentTarget.value))}
        onPointerDown={event => {
          beforeTouch.current = event.pointerType === 'touch' ? hour.get() : null
        }}
        onPointerUp={() => {
          beforeTouch.current = null
        }}
        onPointerCancel={() => {
          if (beforeTouch.current !== null) hour.set(beforeTouch.current)
          beforeTouch.current = null
        }}
      />
      <div className="heat-scale" aria-hidden="true">
        {ticks.map(t => (
          <span key={t} className="heat-tick" style={{ left: share(t) }}>
            {t % LABEL_EVERY === 0 && <span className="heat-tick-label">+{t} h</span>}
          </span>
        ))}
      </div>
    </div>
  )
}
