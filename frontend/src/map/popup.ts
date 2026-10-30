import type { Checkpoint, Level, Route } from '../api/types'
import { formatRate, formatWind, levelName } from '../lib/format'
import { formatDayTime, formatHourEnding } from '../lib/time'

const SVG = 'http://www.w3.org/2000/svg'

/** The card for the checkpoints a click lists, one per route. One checkpoint gets its own card
 * (checkpointPopup); several get a list of the same, each in a section of its own, with the close
 * button in the first section's head. `onClose` wires up that button. */
export function checkpointCard(stops: { route: Route; index: number }[], onClose?: () => void): HTMLElement {
  if (stops.length === 1) return checkpointPopup(stops[0].route, stops[0].index, onClose)
  const root = el('div', 'cp-stack')
  root.setAttribute('role', 'list')
  stops.forEach(({ route, index }, i) => {
    const section = checkpointPopup(route, index, i === 0 ? onClose : undefined)
    section.setAttribute('role', 'listitem')
    root.append(section)
  })
  return root
}

/** The details of one checkpoint, built with DOM calls (nothing from the API is parsed as HTML).
 * `onClose` wires up the card's own close button. */
export function checkpointPopup(route: Route, index: number, onClose?: () => void): HTMLElement {
  const checkpoint = route.checkpoints[index]
  const root = el('div', `cp cp-level-${checkpoint.level ?? 'none'}`)

  const head = el('div', 'cp-head')
  const plate = el('span', `plate plate-mini${route.recommended ? ' plate-rec' : ''}`, route.id)
  plate.setAttribute('aria-hidden', 'true')
  head.append(plate, el('p', 'cp-title', popupTitle(route, index)))
  if (onClose) head.append(closeButton(onClose))
  root.append(head)

  const body = el('div', 'cp-body')
  const overall = el('p', 'cp-overall')
  overall.append(levelPill(checkpoint.level), el('span', 'cp-overall-note', 'risk at ETA'))
  body.append(overall)

  const times = el('dl', 'cp-times')
  times.append(el('dt', '', 'ETA'), el('dd', '', formatDayTime(checkpoint.eta)))
  // Sustained wind is a value at the hour; rain, snow and gusts are the hour's totals (assumption 7).
  times.append(el('dt', '', 'Wind at'), el('dd', '', formatDayTime(checkpoint.forecast_time)))
  times.append(el('dt', '', 'Rain, snow'), el('dd', '', formatHourEnding(checkpoint.totals_time)))
  body.append(times)

  const factors = el('table', 'cp-factors')
  const decides = (level: Level) => level !== null && level === checkpoint.level
  factors.append(factorRow('Wind', formatWind(checkpoint.wind_mph), levelSwatch(checkpoint.wind_level), decides(checkpoint.wind_level)))
  const rule = loadRuleNote(checkpoint)
  if (rule) {
    const row = el('tr', 'cp-rule')
    const cell = el('td', '', rule)
    cell.colSpan = 2
    row.append(el('td', ''), cell)
    factors.append(row)
  }
  const gust = checkpoint.gust_mph === null ? null : el('span', 'cp-unrated', 'not rated')
  factors.append(factorRow('Gusts', formatWind(checkpoint.gust_mph), gust ?? levelSwatch(null), false))
  factors.append(factorRow('Rain', formatRate(checkpoint.rain_in_hr), levelSwatch(checkpoint.rain_level), decides(checkpoint.rain_level)))
  factors.append(factorRow('Snow', formatRate(checkpoint.snow_in_hr), levelSwatch(checkpoint.snow_level), decides(checkpoint.snow_level)))
  body.append(factors)

  const missing = missingNote(checkpoint)
  if (missing) body.append(el('p', 'cp-missing', missing))
  root.append(body)
  return root
}

/** The label shown while the mouse rests on a checkpoint: which one, its ETA and its risk. The card a
 * click opens says the same and more, so screen readers skip the label. */
export function checkpointTip(route: Route, index: number): HTMLElement {
  const checkpoint = route.checkpoints[index]
  const root = el('div', 'cp-tip-body')
  root.setAttribute('aria-hidden', 'true')
  const line = el('p', 'cp-tip-line')
  line.append(el('span', '', `ETA ${formatDayTime(checkpoint.eta)}`), levelPill(checkpoint.level))
  root.append(el('p', 'cp-tip-title', popupTitle(route, index)), line)
  return root
}

export function popupTitle(route: Route, index: number): string {
  const mile = route.checkpoints[index].mile.toFixed(1)
  if (index === 0) return `Route ${route.id}, start (mile ${mile})`
  if (index === route.checkpoints.length - 1) return `Route ${route.id}, destination (mile ${mile})`
  return `Route ${route.id}, mile ${mile}`
}

/** Which load rule raised the wind level, if one did. */
export function loadRuleNote(checkpoint: Checkpoint): string | null {
  if (!checkpoint.load_rule_applied) return null
  if (checkpoint.wind_level === 4) {
    return 'Raised from Severe to No Travel by the load rule: wind of 45 up to 55 mph with a load over 30,000 lb.'
  }
  if (checkpoint.wind_level === 3) {
    return 'Raised from High to Severe by the load rule: wind of 35 up to 45 mph with a load over 40,000 lb.'
  }
  return null
}

/** Why the overall risk is No data, when it is. */
export function missingNote(checkpoint: Checkpoint): string | null {
  if (checkpoint.level !== null) return null
  const known = [checkpoint.wind_mph, checkpoint.rain_in_hr, checkpoint.snow_in_hr].filter(value => value !== null)
  return known.length === 0 ? 'No forecast for this place and hour.' : 'Part of the forecast is missing, so the risk is unknown.'
}

function closeButton(onClose: () => void): HTMLButtonElement {
  const button = el('button', 'cp-close')
  button.type = 'button'
  button.setAttribute('aria-label', 'Close checkpoint details')
  const icon = document.createElementNS(SVG, 'svg')
  icon.setAttribute('viewBox', '0 0 16 16')
  icon.setAttribute('aria-hidden', 'true')
  const cross = document.createElementNS(SVG, 'path')
  cross.setAttribute('d', 'M4 4l8 8M12 4l-8 8')
  icon.append(cross)
  button.append(icon)
  button.addEventListener('click', onClose)
  return button
}

function factorRow(name: string, value: string, level: HTMLElement, decides: boolean): HTMLTableRowElement {
  const row = el('tr', decides ? 'cp-decides' : '')
  const levelCell = el('td', 'cp-level')
  levelCell.append(level)
  row.append(el('th', '', name), el('td', 'cp-value', value), levelCell)
  return row
}

/** A level's colour swatch and name, so colour is never the only cue. */
function levelSwatch(level: Level): HTMLElement {
  const chip = el('span', 'cp-swatch')
  chip.append(el('span', `dot ${level === null ? 'dot-none' : `dot-${level}`}`), document.createTextNode(levelName(level)))
  return chip
}

function levelPill(level: Level): HTMLElement {
  return el('span', `pill pill-level pill-level-${level ?? 'none'}`, levelName(level))
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
