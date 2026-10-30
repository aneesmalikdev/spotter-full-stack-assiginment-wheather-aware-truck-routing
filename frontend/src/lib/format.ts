import type { Level } from '../api/types'

export const LEVEL_NAMES = ['Low', 'Moderate', 'High', 'Severe', 'No Travel'] as const
export const NO_DATA = 'No data'

export function levelName(level: Level): string {
  return level === null ? NO_DATA : LEVEL_NAMES[level]
}

const wholeMiles = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const oneDecimal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** "3,019 mi" */
export function formatWholeMiles(value: number): string {
  return `${wholeMiles.format(value)} mi`
}

/** Miles at a risk level, as the board shows them: "0", or one decimal ("25.0"). */
export function formatRiskMiles(value: number): string {
  return value === 0 ? '0' : oneDecimal.format(value)
}

/** Miles at a risk level in the route list: as formatRiskMiles, but whole miles from 1,000 up, so
 * the narrow columns hold on phones ("1,235" rather than "1,234.5"). */
export function formatBoardMiles(value: number): string {
  return value >= 1000 ? wholeMiles.format(value) : formatRiskMiles(value)
}

/** Average risk, 0 (Low) to 4 (No Travel), to two decimals. */
export function formatAverageRisk(value: number): string {
  return value.toFixed(2)
}

/** "12 h 52 min", or "45 min" under an hour. */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  const hours = Math.floor(minutes / 60)
  return hours === 0 ? `${minutes} min` : `${hours} h ${minutes % 60} min`
}

/** "24.9 mph" (one decimal, as the forecast gives it, so values near a threshold aren't misread). */
export function formatWind(mph: number | null): string {
  return mph === null ? NO_DATA : `${mph.toFixed(1)} mph`
}

/** "0.567 in/hr" (up to three decimals, the forecast's precision). */
export function formatRate(inchesPerHour: number | null): string {
  return inchesPerHour === null ? NO_DATA : `${Number(inchesPerHour.toFixed(3))} in/hr`
}

/** "35,000 lb" */
export function formatPounds(value: number): string {
  return `${new Intl.NumberFormat('en-US').format(value)} lb`
}
