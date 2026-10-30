import { type ChangeEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { type PlaceSuggestion, requestPlaces } from '../api/places'
import { matchesTyped } from '../lib/placeMatch'

export const SUGGEST_AFTER_MS = 350 // a pause in typing this long asks for suggestions
export const SUGGEST_MIN_CHARS = 3

interface Props {
  id: string
  name: string
  className: string
  placeholder: string
  'aria-invalid'?: boolean
  'aria-describedby'?: string
  value: string
  onChange: (value: string) => void
}

/** A place field that suggests cities while the user types (the ARIA combobox pattern). Suggestions
 * are only a shortcut: whatever is typed is what the plan looks up. */
export function PlaceField({ value, onChange, ...input }: Props) {
  const listId = useId()
  const [found, setFound] = useState<PlaceSuggestion[]>([]) // the latest answer from the server
  const [showing, setShowing] = useState(false) // off after a pick, Enter, Escape or leaving the field, until typing again
  // The place the arrow keys or the mouse point at, by name: a newer answer may reorder the list.
  const [active, setActive] = useState<string | null>(null)
  // A value not typed here (a pick, or what the field opened with): nothing to look up for it.
  const settled = useRef<string | null>(value.trim())

  const text = value.trim()
  // The last answer narrows at once as typing goes on; the next answer then replaces it.
  const options = text.length >= SUGGEST_MIN_CHARS ? found.filter(place => matchesTyped(place, text)) : []
  const open = showing && options.length > 0
  const current = open && active !== null ? options.findIndex(place => place.name === active) : -1

  useEffect(() => {
    if (text.length < SUGGEST_MIN_CHARS || text === settled.current) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      requestPlaces(text, controller.signal).then(setFound, () => {}) // without suggestions the field still works
    }, SUGGEST_AFTER_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort() // a newer text, or the field went away
    }
  }, [text])

  const pick = (place: string) => {
    settled.current = place
    onChange(place)
    setShowing(false)
    setActive(null)
  }

  const change = (event: ChangeEvent<HTMLInputElement>) => {
    settled.current = null
    onChange(event.target.value)
    setShowing(true)
    setActive(null)
  }

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && options.length > 0) {
      event.preventDefault()
      setShowing(true)
      setActive(options[open ? Math.min(current + 1, options.length - 1) : 0].name)
    } else if (event.key === 'ArrowUp' && open) {
      event.preventDefault()
      setActive(options[Math.max(current - 1, 0)].name)
    } else if (event.key === 'Enter') {
      if (current >= 0) {
        event.preventDefault() // picks the place instead of sending the form
        pick(options[current].name)
      } else {
        setShowing(false) // the form is sent: the list mustn't stay over it, or open late
      }
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      setShowing(false)
    }
  }

  return (
    <div className="place-field">
      <input
        {...input}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={current >= 0 ? `${listId}-${current}` : undefined}
        autoComplete="off"
        value={value}
        onChange={change}
        onKeyDown={keyDown}
        onBlur={() => setShowing(false)}
      />
      <ul
        className="place-list"
        id={listId}
        role="listbox"
        aria-label="Suggested places"
        hidden={!open}
        onMouseLeave={() => setActive(null)}
      >
        {options.map((place, i) => (
          <li
            key={place.name}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === current}
            className={`place-option${i === current ? ' is-active' : ''}`}
            onMouseDown={event => event.preventDefault()} // keeps the focus in the field
            onMouseMove={() => setActive(place.name)} // a moving pointer, not a list appearing under a still one
            onClick={() => pick(place.name)}
          >
            {place.name}
          </li>
        ))}
      </ul>
      <p className="visually-hidden" role="status">
        {open ? `${options.length} ${options.length === 1 ? 'suggestion' : 'suggestions'}` : ''}
      </p>
    </div>
  )
}
