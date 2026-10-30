import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createHourStore } from '../lib/hourStore'
import { heatmap } from '../test/fixtures'
import { HeatSlider } from './HeatSlider'

const slider = () => screen.getByRole<HTMLInputElement>('slider', { name: 'Heatmap hour' })
const shown = (selector: string) => document.querySelector(selector)?.textContent

describe('heatmap slider', () => {
  it('shows the forecast hour at departure, then each hour it moves to', () => {
    const hour = createHourStore()
    render(<HeatSlider heatmap={heatmap()} hour={hour} />)
    expect([shown('.heat-time'), shown('.heat-offset')]).toEqual(['Sun, 9:00 AM CDT', '+0 h'])
    expect(slider().getAttribute('aria-valuetext')).toBe('Sunday, 9:00 AM CDT, at departure')

    fireEvent.change(slider(), { target: { value: '7' } })
    expect(hour.get()).toBe(7)
    expect([shown('.heat-time'), shown('.heat-offset')]).toEqual(['Sun, 4:00 PM CDT', '+7 h'])
    expect(slider().getAttribute('aria-valuetext')).toBe('Sunday, 4:00 PM CDT, 7 hours after departure')
    expect(slider().style.getPropertyValue('--pct')).toBe(`${(7 / 48) * 100}%`) // the track fills to the thumb

    fireEvent.change(slider(), { target: { value: '1' } })
    expect(slider().getAttribute('aria-valuetext')).toBe('Sunday, 10:00 AM CDT, 1 hour after departure')
  })

  it('follows the hour store, as when a new plan sets it back to departure', () => {
    const hour = createHourStore()
    hour.set(30)
    render(<HeatSlider heatmap={heatmap()} hour={hour} />)
    expect(slider().value).toBe('30')
    expect(shown('.heat-time')).toBe('Mon, 3:00 PM CDT')
    act(() => hour.set(0))
    expect(slider().value).toBe('0')
  })

  it('goes back to its hour when a touch on it turns out to be a page scroll', () => {
    const hour = createHourStore()
    render(<HeatSlider heatmap={heatmap()} hour={hour} />)
    // Android Chrome: the thumb jumps to the finger, then the browser takes the touch for a scroll.
    fireEvent.pointerDown(slider(), { pointerType: 'touch' })
    fireEvent.change(slider(), { target: { value: '40' } })
    fireEvent.pointerCancel(slider(), { pointerType: 'touch' })
    expect(hour.get()).toBe(0)
    // A sideways drag ends normally and keeps its hour.
    fireEvent.pointerDown(slider(), { pointerType: 'touch' })
    fireEvent.change(slider(), { target: { value: '18' } })
    fireEvent.pointerUp(slider(), { pointerType: 'touch' })
    expect(hour.get()).toBe(18)
  })

  it('marks every 6 hours and labels every 12', () => {
    render(<HeatSlider heatmap={heatmap()} hour={createHourStore()} />)
    expect(document.querySelectorAll('.heat-tick')).toHaveLength(9)
    expect([...document.querySelectorAll('.heat-tick-label')].map(label => label.textContent)).toEqual([
      '+0 h',
      '+12 h',
      '+24 h',
      '+36 h',
      '+48 h',
    ])
  })
})
