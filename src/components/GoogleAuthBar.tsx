import { useCallback, useEffect, useState } from 'react'
import {
  GMAIL_READONLY_SCOPE,
  isMockMode,
  isScopeAuthorized,
  requestScopes,
} from '../lib/gmail'
import { CALENDAR_SCOPE } from '../lib/calendar'

type Service = 'gmail' | 'calendar'

const SERVICES: {
  key: Service
  scope: string
  icon: string
  label: string
}[] = [
  { key: 'gmail', scope: GMAIL_READONLY_SCOPE, icon: '✉️', label: 'Gmail' },
  { key: 'calendar', scope: CALENDAR_SCOPE, icon: '📅', label: 'Calendar' },
]

/**
 * Header indicators for the connected Google services — one per service, each
 * showing its own state.
 *
 * Gmail and Calendar are granted separately (the consent screen lets you
 * approve one and refuse the other), so a single "connected" light would be a
 * lie half the time. Each chip reads the token cache directly, and re-reads on
 * `nexus:google-token`, which any interactive grant fires — including one made
 * from inside the briefing's iframe.
 */
export function GoogleAuthBar() {
  const read = useCallback(
    () =>
      Object.fromEntries(
        SERVICES.map((s) => [s.key, isScopeAuthorized(s.scope)]),
      ) as Record<Service, boolean>,
    [],
  )

  const [state, setState] = useState(read)
  const [pending, setPending] = useState<Service | null>(null)
  const mock = isMockMode()

  useEffect(() => {
    if (mock) return
    const refresh = () => setState(read())
    window.addEventListener('nexus:google-token', refresh)
    window.addEventListener('nexus:gmail-token', refresh)
    // A token can also lapse or be restored without an event (silent refresh,
    // another tab), so poll cheaply — this only reads an in-memory map.
    const timer = setInterval(refresh, 5000)
    return () => {
      window.removeEventListener('nexus:google-token', refresh)
      window.removeEventListener('nexus:gmail-token', refresh)
      clearInterval(timer)
    }
  }, [mock, read])

  const connect = async (svc: Service) => {
    const target = SERVICES.find((s) => s.key === svc)
    if (!target) return
    setPending(svc)
    try {
      await requestScopes([target.scope], true)
    } catch {
      // The chip stays in its "connect" state, which is the whole message.
    } finally {
      setPending(null)
      setState(read())
    }
  }

  if (mock) {
    return <span className="authbar authbar--mock">Google: sample data</span>
  }

  return (
    <span className="authbar authbar--services">
      {SERVICES.map((svc) => {
        const on = state[svc.key]
        const busy = pending === svc.key
        return (
          <button
            key={svc.key}
            className={`svc ${on ? 'svc--on' : 'svc--off'}`}
            disabled={on || busy}
            onClick={() => connect(svc.key)}
            title={
              on
                ? `${svc.label} connected (read-only)`
                : `Connect ${svc.label} (read-only)`
            }
          >
            <span className="svc__icon" aria-hidden="true">
              {svc.icon}
            </span>
            <span className="svc__label">{svc.label}</span>
            <span className="svc__state">
              {busy ? '…' : on ? '✓' : 'Connect'}
            </span>
          </button>
        )
      })}
    </span>
  )
}
