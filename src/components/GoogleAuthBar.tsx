import { useCallback, useEffect, useState } from 'react'
import {
  GMAIL_READONLY_SCOPE,
  explainAuthError,
  isMockMode,
  isScopeAuthorized,
  lastAuthError,
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
/**
 * `onProblem` lifts the failure text out of the header. It is a sentence, not
 * a label — it names the cause and what to do — and the header's row of chips
 * has nowhere to put a sentence without truncating exactly the part that
 * matters. The app renders it full width underneath instead.
 */
export function GoogleAuthBar({
  onProblem,
}: {
  onProblem?: (message: string) => void
}) {
  const read = useCallback(
    () =>
      Object.fromEntries(
        SERVICES.map((s) => [s.key, isScopeAuthorized(s.scope)]),
      ) as Record<Service, boolean>,
    [],
  )

  const [state, setState] = useState(read)
  const [pending, setPending] = useState<Service | null>(null)
  const [refused, setRefused] = useState<Service | null>(null)
  // Per-service API failures, reported by the digest after each sync.
  const [failing, setFailing] = useState<Record<string, string>>({})
  const mock = isMockMode()

  useEffect(() => {
    if (mock) return
    const refresh = () => setState(read())
    const svcError = (e: Event) => {
      const d = (e as CustomEvent).detail as Record<string, string> | undefined
      setFailing({ gmail: d?.gmail ?? '', calendar: d?.calendar ?? '' })
    }
    window.addEventListener('nexus:google-token', refresh)
    window.addEventListener('nexus:gmail-token', refresh)
    window.addEventListener('nexus:google-service-error', svcError)
    // A token can also lapse or be restored without an event (silent refresh,
    // another tab), so poll cheaply — this only reads an in-memory map.
    const timer = setInterval(refresh, 5000)
    return () => {
      window.removeEventListener('nexus:google-token', refresh)
      window.removeEventListener('nexus:gmail-token', refresh)
      window.removeEventListener('nexus:google-service-error', svcError)
      clearInterval(timer)
    }
  }, [mock, read])

  const connect = async (svc: Service) => {
    const target = SERVICES.find((s) => s.key === svc)
    if (!target) return
    setPending(svc)
    try {
      // Force the consent screen when re-asking: after a refusal, and when the
      // scope is already held — in both cases Google would otherwise replay
      // the existing grant with no UI, and the press would do nothing visible
      // for someone whose held token has in fact stopped working.
      const reAsk = refused === svc || state[svc]
      await requestScopes([target.scope], true, reAsk)
      setRefused(null)
      onProblem?.('')
      setFailing((f) => ({ ...f, [svc]: '' }))
    } catch (err) {
      // Never swallow this. Google refuses in several very different ways —
      // an origin missing from the OAuth client, an app awaiting verification,
      // a blocked popup, a declined checkbox — and they need opposite
      // responses. Caught silently they all look like one thing: a button that
      // shows you Google and changes nothing, which reads as a loop.
      setRefused(svc)
      const raw =
        lastAuthError(target.scope) ||
        (err instanceof Error ? err.message : 'Google sign-in failed')
      onProblem?.(`${target.label}: ${explainAuthError(raw)}`)
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
        const err = failing[svc.key]
        // A held grant whose API is erroring is not connected in any useful
        // sense, so it must not read as a tick.
        const on = state[svc.key] && !err
        const busy = pending === svc.key
        return (
          <button
            key={svc.key}
            className={`svc ${
              err
                ? 'svc--refused'
                : on
                  ? 'svc--on'
                  : refused === svc.key
                    ? 'svc--refused'
                    : 'svc--off'
            }`}
            // Never disabled on "connected": a grant can lapse or be revoked
            // while the cache still holds it, and a disabled tick beside a
            // service returning nothing leaves no way to put it right.
            disabled={busy}
            onClick={() => connect(svc.key)}
            title={
              err
                ? `${svc.label}: ${err} — click to sign in again`
                : on
                  ? `${svc.label} connected (read-only) — click to sign in again`
                  : refused === svc.key
                    ? `${svc.label} access was refused — click to be asked again`
                    : `Connect ${svc.label} (read-only)`
            }
          >
            <span className="svc__icon" aria-hidden="true">
              {svc.icon}
            </span>
            <span className="svc__label">{svc.label}</span>
            <span className="svc__state">
              {busy ? '…' : err ? '!' : on ? '✓' : 'Connect'}
            </span>
          </button>
        )
      })}
    </span>
  )
}
