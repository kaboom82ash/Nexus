import { useCallback, useEffect, useState } from 'react'

/**
 * The digest's tabs, drawn in the app shell directly under the category bar.
 *
 * They belong here for the same reason the filter does: they are the top-level
 * navigation of the whole page, and inside the iframe they sat below a
 * masthead, a status strip and a dashboard — three things you had to scroll
 * past to change what you were looking at. The briefing still owns the tabs
 * themselves; this reads them off `window.__nexusDigest` and drives its
 * `selectTab`, so a rebuilt page that adds or renames one needs no change
 * here.
 */

export interface DigestTab {
  key: string
  label: string
  count: string
  active: boolean
  title: string
}

interface TabApi {
  tabs?(): DigestTab[]
  selectTab?(key: string): void
}

function digest(): TabApi | null {
  const frame = document.querySelector<HTMLIFrameElement>('.briefing__frame')
  try {
    return (
      (frame?.contentWindow as (Window & { __nexusDigest?: TabApi }) | null)
        ?.__nexusDigest ?? null
    )
  } catch {
    return null
  }
}

function same(a: DigestTab[], b: DigestTab[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (t, i) =>
        t.key === b[i].key &&
        t.label === b[i].label &&
        t.count === b[i].count &&
        t.active === b[i].active,
    )
  )
}

export function TabStrip() {
  const [tabs, setTabs] = useState<DigestTab[]>([])

  // The iframe boots after this component and remounts on reload, so poll for
  // the API rather than assuming one handshake. Counts change on their own
  // too — a sync, a closed item — so this keeps reading either way.
  const poll = useCallback(() => {
    const api = digest()
    const next = api?.tabs?.() ?? []
    setTabs((prev) => (same(prev, next) ? prev : next))
  }, [])

  useEffect(() => {
    poll()
    const timer = setInterval(poll, 1000)
    return () => clearInterval(timer)
  }, [poll])

  if (!tabs.length) return null

  const pick = (key: string) => {
    digest()?.selectTab?.(key)
    // Paint the new selection now rather than waiting for the next poll.
    setTabs((prev) => prev.map((t) => ({ ...t, active: t.key === key })))
  }

  return (
    <nav className="tabstrip" aria-label="Digest sections">
      {tabs.map((t) => (
        <button
          key={t.key}
          className={`tabstrip__btn ${t.active ? 'is-on' : ''}`}
          onClick={() => pick(t.key)}
          title={t.title || t.label}
          aria-current={t.active ? 'page' : undefined}
        >
          <span className="tabstrip__label">{t.label}</span>
          {t.count !== '' && <span className="tabstrip__n">{t.count}</span>}
        </button>
      ))}
    </nav>
  )
}
