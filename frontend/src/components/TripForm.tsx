import { useState, type ChangeEvent, type ReactNode, type SubmitEvent } from 'react'
import type { FieldErrors, FieldName } from '../api/types'
import { type FormValues, INTERVALS } from '../lib/form'
import { MAX_DAYS_AHEAD, PAST_GRACE_MS, parseInputValue, toInputValue, zoneName } from '../lib/time'
import { PlaceField } from './PlaceField'
import { Bang } from './signs'
import { PlanningLabel } from './Status'

interface Props {
  values: FormValues
  errors: FieldErrors
  busySince: number | null // when the plan request was sent, while it is in flight
  steps: string[] // what the button says while busy, one step every 2 seconds
  blocked: boolean // a rate limit asked us to wait before trying again
  onChange: (values: FormValues) => void
  onSubmit: () => void
}

/** The trip form. The browser's own validation is off: the same checks as the server's run on submit. */
export function TripForm({ values, errors, busySince, steps, blocked, onChange, onSubmit }: Props) {
  const busy = busySince !== null
  const [limits, setLimits] = useState(departureLimits)
  const [zoneNow] = useState(() => zoneName(new Date())) // shown while the date is incomplete
  const departure = parseInputValue(values.departure)
  const set = (field: keyof FormValues) => (event: ChangeEvent<HTMLInputElement>) =>
    onChange({ ...values, [field]: event.target.value })
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (!busy && !blocked) onSubmit()
  }

  return (
    <form id="trip-form" className="trip-form" noValidate onSubmit={submit}>
      <Field name="origin" label="From" error={errors.origin}>
        <PlaceField
          {...fieldProps('origin', errors)}
          placeholder="City, address or place"
          value={values.origin}
          onChange={origin => onChange({ ...values, origin })}
        />
      </Field>
      <Field name="destination" label="To" error={errors.destination}>
        <PlaceField
          {...fieldProps('destination', errors)}
          placeholder="City, address or place"
          value={values.destination}
          onChange={destination => onChange({ ...values, destination })}
        />
      </Field>
      <Field name="departure" label="Departure" error={errors.departure} helper="In your time zone, up to 13 days ahead.">
        <div className="with-zone">
          <input
            {...fieldProps('departure', errors, true)}
            type="datetime-local"
            step={60}
            min={limits.min}
            max={limits.max}
            value={values.departure}
            onFocus={() => setLimits(departureLimits())}
            onChange={set('departure')}
          />
          <span className="zone">{departure ? zoneName(departure) : zoneNow}</span>
        </div>
      </Field>
      <div className="load-row">
        <Field name="load_lb" label="Load weight" error={errors.load_lb} helper="0 to 200,000 lb">
          <div className="with-suffix">
            <input
              {...fieldProps('load_lb', errors, true)}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={values.load}
              onChange={set('load')}
            />
            <span className="suffix" aria-hidden="true">
              lb
            </span>
          </div>
        </Field>
        <fieldset className="segments">
          <legend>Check weather every</legend>
          <div className="segment-row">
            {INTERVALS.map(interval => (
              <label key={interval} className="segment">
                <input
                  type="radio"
                  name="interval"
                  value={interval}
                  checked={values.interval === interval}
                  onChange={() => onChange({ ...values, interval })}
                />
                <span>{interval} mi</span>
              </label>
            ))}
          </div>
          {errors.interval_miles && <FieldError id="interval_miles-error" message={errors.interval_miles} />}
        </fieldset>
      </div>
      <button
        type="submit"
        className={`button-primary${busy ? ' is-busy' : ''}`}
        aria-disabled={busy || blocked ? 'true' : undefined}
        aria-label={busy ? 'Planning…' : undefined}
      >
        {busySince !== null ? (
          <>
            <span className="spinner" aria-hidden="true" />
            <PlanningLabel startedAt={busySince} steps={steps} />
          </>
        ) : (
          'Plan routes'
        )}
      </button>
    </form>
  )
}

function Field({ name, label, error, helper, children }: { name: FieldName; label: string; error?: string; helper?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      {children}
      {helper && (
        <p className="helper" id={`${name}-helper`}>
          {helper}
        </p>
      )}
      {error && <FieldError id={`${name}-error`} message={error} />}
    </div>
  )
}

function FieldError({ id, message }: { id: string; message: string }) {
  return (
    <p className="field-error" id={id}>
      <Bang />
      {message}
    </p>
  )
}

function fieldProps(name: FieldName, errors: FieldErrors, hasHelper = false) {
  const describedBy = [errors[name] ? `${name}-error` : '', hasHelper ? `${name}-helper` : ''].filter(Boolean).join(' ')
  return {
    id: name,
    name,
    className: 'input',
    'aria-invalid': errors[name] ? true : undefined,
    'aria-describedby': describedBy || undefined,
  }
}

function departureLimits() {
  const now = Date.now()
  return {
    min: toInputValue(new Date(now - PAST_GRACE_MS)),
    max: toInputValue(new Date(now + MAX_DAYS_AHEAD * 24 * 3_600_000)),
  }
}
