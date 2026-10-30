import { describe, expect, it } from 'vitest'
import {
  formatAverageRisk,
  formatBoardMiles,
  formatDuration,
  formatPounds,
  formatRate,
  formatRiskMiles,
  formatWholeMiles,
  formatWind,
  levelName,
} from './format'

describe('formatting', () => {
  it('names risk levels, with No data for missing ones', () => {
    expect([0, 1, 2, 3, 4, null].map(level => levelName(level as never))).toEqual([
      'Low',
      'Moderate',
      'High',
      'Severe',
      'No Travel',
      'No data',
    ])
  })

  it('formats distances, durations and weights', () => {
    expect(formatDuration(46_380)).toBe('12 h 53 min')
    expect(formatDuration(2_700)).toBe('45 min')
    expect(formatDuration(183_960)).toBe('51 h 6 min')
    expect(formatPounds(35000)).toBe('35,000 lb')
    expect(formatWholeMiles(3018.6)).toBe('3,019 mi')
  })

  it('shows board values as the server ranks them', () => {
    expect(formatRiskMiles(0)).toBe('0')
    expect(formatRiskMiles(25)).toBe('25.0')
    expect(formatRiskMiles(1234.5)).toBe('1,234.5')
    expect(formatAverageRisk(0.1)).toBe('0.10')
    expect(formatBoardMiles(999.9)).toBe('999.9')
    expect(formatBoardMiles(1234.5)).toBe('1,235')
    expect(formatBoardMiles(0)).toBe('0')
  })

  it('keeps the forecast precision near thresholds and says No data when missing', () => {
    expect(formatWind(24.94)).toBe('24.9 mph')
    expect(formatWind(null)).toBe('No data')
    expect(formatRate(0.249)).toBe('0.249 in/hr')
    expect(formatRate(0.1)).toBe('0.1 in/hr')
    expect(formatRate(0)).toBe('0 in/hr')
    expect(formatRate(null)).toBe('No data')
  })
})
