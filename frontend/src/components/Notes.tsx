import { NoteSign } from './signs'

/** Notes about the route search and the forecast, in the server's words. */
export function Notes({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null
  return (
    <section className="notes" aria-labelledby="notes-heading">
      <h2 id="notes-heading">Notes</h2>
      <ul role="list">
        {warnings.map(text => (
          <li key={text}>
            <NoteSign />
            {text}
          </li>
        ))}
      </ul>
    </section>
  )
}
