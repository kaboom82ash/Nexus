import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The global filter across the whole digest.
 *
 * It lives here, in the app shell, rather than inside the briefing page,
 * because it governs every tab at once — and because the page it drives is
 * rebuilt weekly, so a control written into that file would keep having to be
 * put back. The briefing publishes `window.__nexusDigest` on its own window;
 * same origin, so this calls it directly rather than posting messages.
 *
 * "Critical" sits among the categories deliberately. It is a severity, not a
 * category, but from the reader's side both answer the same question — show me
 * only this slice — and two controls would have to be reasoned about together.
 */

export interface DigestApi {
  version: number
  setFilters(next: string[]): void
  getFilters(): string[]
  categoryCounts(): Record<string, number>
  sync(): void
}

const CATEGORIES: { key: string; label: string; icon: string }[] = [
  { key: 'critical', label: 'Critical', icon: '🔴' },
  { key: 'personal', label: 'Personal', icon: '📧' },
  { key: 'kids', label: 'Kids', icon: '🧒' },
  { key: 'health', label: 'Health', icon: '🏥' },
  { key: 'finance', label: 'Finances', icon: '💰' },
  { key: 'home', label: 'Home', icon: '🏠' },
  { key: 'lifestyle', label: 'Lifestyle', icon: '🎡' },
]

/** Reach the briefing's API through the iframe, if it has booted yet. */
function digest(): DigestApi | null {
  const frame = document.querySelector<HTMLIFrameElement>('.briefing__frame')
  try {
    const api = frame?.contentWindow as (Window & { __nexusDigest?: DigestApi }) | null
    return api?.__nexusDigest ?? null
  } catch {
    // Cross-origin should be impossible here, but never let the bar throw.
    return null
  }
}

export function CategoryBar() {
  const [selected, setSelected] = useState<string[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [ready, setReady] = useState(false)
  const syncing = useRef(false)

  // The iframe boots after this component, and reloads whenever the digest is
  // reloaded, so poll for the API rather than assuming a single handshake.
  const poll = useCallback(() => {
    const api = digest()
    if (!api) {
      setReady(false)
      return
    }
    if (!ready) setReady(true)
    setCounts(api.categoryCounts())
    // The page owns the persisted selection; adopt it rather than fighting it.
    if (!syncing.current) {
      const theirs = api.getFilters()
      setSelected((mine) =>
        theirs.length === mine.length && theirs.every((k) => mine.includes(k))
          ? mine
          : theirs,
      )
    }
  }, [ready])

  useEffect(() => {
    poll()
    const timer = setInterval(poll, 1500)
    return () => clearInterval(timer)
  }, [poll])

  const apply = (next: string[]) => {
    syncing.current = true
    setSelected(next)
    digest()?.setFilters(next)
    // Let the poll adopt the page's view again once it has taken the change.
    setTimeout(() => {
      syncing.current = false
    }, 400)
  }

  const toggle = (key: string) => {
    apply(
      selected.includes(key)
        ? selected.filter((k) => k !== key)
        : selected.concat(key),
    )
  }

  const all = selected.length === 0

  return (
    <div className={`catbar ${ready ? '' : 'catbar--waiting'}`}>
      <button
        className={`catchip catchip--all ${all ? 'is-on' : ''}`}
        onClick={() => apply([])}
        title="Show everything"
      >
        <span className="catchip__icon" aria-hidden="true">
          🗂️
        </span>
        <span className="catchip__label">All</span>
        {counts.all !== undefined && (
          <span className="catchip__n">{counts.all}</span>
        )}
      </button>
      {CATEGORIES.map((c) => (
        <button
          key={c.key}
          className={`catchip cat-${c.key} ${
            selected.includes(c.key) ? 'is-on' : ''
          }`}
          onClick={() => toggle(c.key)}
          title={`Filter to ${c.label} — click again to remove`}
        >
          <span className="catchip__icon" aria-hidden="true">
            {c.icon}
          </span>
          <span className="catchip__label">{c.label}</span>
          {counts[c.key] !== undefined && (
            <span className="catchip__n">{counts[c.key]}</span>
          )}
        </button>
      ))}
    </div>
  )
}
