import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { planningSteps } from '../lib/steps'
import { LoadingStatus, PlanningLabel, SLOW_NOTE, STEP_MS } from './Status'

afterEach(() => vi.useRealTimers())

describe('loading status', () => {
  const steps = planningSteps({ interval_miles: 25, load_lb: 35000 })

  it('names the steps with the request’s own interval and load', () => {
    expect(steps).toContain('Checkpoints every 25 mi…')
    expect(steps).toContain('Scoring risk for 35,000 lb…')
    expect(steps[0]).toBe('Looking up your places…')
    expect(steps[steps.length - 1]).toBe('Ranking the routes…')
  })

  it('keeps every step short enough for the button, at the widest interval and load', () => {
    // 28 characters is "Scoring risk for 200,000 lb…", 219 px in the app's font: the most the 224 px
    // (14em) label slot holds, so no step is cut off, even on a 320 px phone.
    const widest = planningSteps({ interval_miles: 50, load_lb: 200_000 })
    expect(Math.max(...widest.map(step => step.length))).toBeLessThanOrEqual(28)
  })

  it('moves to the next step every 2 seconds and stays on the last one', () => {
    vi.useFakeTimers()
    const start = Date.now()
    render(<PlanningLabel startedAt={start} steps={steps} />)
    const shown = () => document.querySelector('.button-step')?.textContent
    expect(shown()).toBe(steps[0])
    act(() => vi.advanceTimersByTime(STEP_MS))
    expect(shown()).toBe(steps[1])
    act(() => vi.advanceTimersByTime(STEP_MS * 3))
    expect(shown()).toBe(steps[4])
    act(() => vi.advanceTimersByTime(STEP_MS * 20))
    expect(shown()).toBe(steps[steps.length - 1]) // no loop back to the start
  })

  it('says long trips take longer on a long wait', () => {
    render(<LoadingStatus startedAt={Date.now()} slow />)
    expect(screen.getByText(SLOW_NOTE)).toBeTruthy()
  })
})
