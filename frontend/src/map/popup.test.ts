import { describe, expect, it } from 'vitest'
import { checkpoint, route } from '../test/fixtures'
import { formatDayTime, formatHourEnding } from '../lib/time'
import { checkpointCard, checkpointPopup, checkpointTip, loadRuleNote, missingNote, popupTitle } from './popup'

describe('checkpoint popup', () => {
  const b = route('B', { rank: 1, levels: [0, 3, 1] })

  it('names the start and the destination', () => {
    expect([0, 1, 2].map(i => popupTitle(b, i))).toEqual([
      'Route B, start (mile 0.0)',
      'Route B, mile 25.0',
      'Route B, destination (mile 50.0)',
    ])
  })

  it('labels a checkpoint with its ETA and risk, out of screen readers’ way', () => {
    const late = route('B', { rank: 1, levels: [0, 3, 1] })
    // Its own times, so the label can be seen to show the ETA and not another time on the card.
    late.checkpoints[1] = { ...late.checkpoints[1], eta: '2026-10-25T15:20:00Z', forecast_time: '2026-10-25T15:00:00Z', totals_time: '2026-10-25T16:00:00Z' }
    const tip = checkpointTip(late, 1)
    expect(tip.querySelector('.cp-tip-title')?.textContent).toBe('Route B, mile 25.0')
    expect(tip.textContent).toContain(`ETA ${formatDayTime('2026-10-25T15:20:00Z')}`)
    expect(tip.querySelector('.pill-level')?.textContent).toBe('Severe')
    expect(tip.getAttribute('aria-hidden')).toBe('true')
  })

  it('says when the truck gets there and which forecast hours its weather comes from', () => {
    const late = route('A', { rank: 1, levels: [0] })
    late.checkpoints[0] = checkpoint({
      eta: '2026-10-25T14:20:00Z',
      forecast_time: '2026-10-25T14:00:00Z', // the hour nearest the ETA
      totals_time: '2026-10-25T15:00:00Z', // the hour the ETA falls in ends then
    })
    const card = checkpointPopup(late, 0)
    const rows = [...card.querySelectorAll('.cp-times dt')].map(dt => [dt.textContent, dt.nextElementSibling?.textContent])
    expect(rows).toEqual([
      ['ETA', formatDayTime('2026-10-25T14:20:00Z')],
      ['Wind at', formatDayTime('2026-10-25T14:00:00Z')],
      ['Rain, snow', formatHourEnding('2026-10-25T15:00:00Z')],
    ])
  })

  it('says which load rule raised the wind level', () => {
    expect(loadRuleNote(checkpoint({ load_rule_applied: true, wind_level: 3 }))).toBe(
      'Raised from High to Severe by the load rule: wind of 35 up to 45 mph with a load over 40,000 lb.',
    )
    expect(loadRuleNote(checkpoint({ load_rule_applied: true, wind_level: 4 }))).toBe(
      'Raised from Severe to No Travel by the load rule: wind of 45 up to 55 mph with a load over 30,000 lb.',
    )
    expect(loadRuleNote(checkpoint({ load_rule_applied: false, wind_level: 4 }))).toBeNull()
  })

  it('explains a No data risk', () => {
    const none = { level: null, wind_mph: null, rain_in_hr: null, snow_in_hr: null } as const
    expect(missingNote(checkpoint(none))).toBe('No forecast for this place and hour.')
    expect(missingNote(checkpoint({ ...none, wind_mph: 12 }))).toBe('Part of the forecast is missing, so the risk is unknown.')
    expect(missingNote(checkpoint())).toBeNull()
  })

  it('shows the values, levels and the deciding factor', () => {
    const severe = route('A', { rank: 2, levels: [0] })
    severe.checkpoints[0] = checkpoint({ wind_mph: 38.4, gust_mph: 51.2, wind_level: 3, level: 3, load_rule_applied: true, rain_in_hr: 0.02 })
    const text = checkpointPopup(severe, 0).textContent
    expect(text).toContain('Route A, start (mile 0.0)')
    expect(text).toContain('Severe')
    expect(text).toContain('38.4 mph')
    expect(text).toContain('not rated')
    expect(text).toContain('0.02 in/hr')
    const decides = [...checkpointPopup(severe, 0).querySelectorAll('.cp-decides th')].map(th => th.textContent)
    expect(decides).toEqual(['Wind'])
  })

  it('has its own close button', () => {
    let closed = 0
    const popup = checkpointPopup(b, 1, () => closed++)
    const button = popup.querySelector<HTMLButtonElement>('.cp-close')!
    expect(button.getAttribute('aria-label')).toBe('Close checkpoint details')
    button.click()
    expect(closed).toBe(1)
    expect(popup.className).toBe('cp cp-level-3') // the accent bar takes the level's colour
  })

  it('lists several checkpoints in the order given, each with its own details, under one close button', () => {
    const a = route('A', { rank: 1, levels: [0, 1] })
    const c = route('C', { rank: 2, levels: [2, 4] })
    let closed = 0
    const card = checkpointCard(
      [
        { route: c, index: 1 },
        { route: a, index: 1 },
      ],
      () => closed++,
    )
    const sections = [...card.children]
    expect(sections.map(section => section.querySelector('.cp-title')?.textContent)).toEqual([
      'Route C, destination (mile 25.0)',
      'Route A, destination (mile 25.0)',
    ])
    expect(card.getAttribute('role')).toBe('list') // so screen readers say how many there are
    expect(sections.map(section => section.getAttribute('role'))).toEqual(['listitem', 'listitem'])
    sections.forEach(section => section.removeAttribute('role'))
    expect(sections[0].outerHTML).toBe(checkpointPopup(c, 1, () => {}).outerHTML)
    expect(sections[1].outerHTML).toBe(checkpointPopup(a, 1).outerHTML) // the same, without a close button
    const buttons = card.querySelectorAll<HTMLButtonElement>('.cp-close')
    expect(buttons).toHaveLength(1)
    buttons[0].click()
    expect(closed).toBe(1)
  })

  it('gives a single checkpoint the card it has always had', () => {
    const card = checkpointCard([{ route: b, index: 1 }], () => {})
    expect(card.outerHTML).toBe(checkpointPopup(b, 1, () => {}).outerHTML)
    expect(card.getAttribute('role')).toBeNull()
  })

  it('never parses API text as HTML', () => {
    const odd = route('<b>X</b>', { rank: 1, levels: [0] })
    const popup = checkpointPopup(odd, 0)
    expect(popup.querySelector('b')).toBeNull()
    expect(popup.textContent).toContain('Route <b>X</b>')
  })
})
