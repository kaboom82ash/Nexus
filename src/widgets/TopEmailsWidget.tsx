import { useCallback, useEffect, useRef, useState } from 'react'
import { defineWidget, type WidgetProps, type WidgetSettingsProps } from './types'
import {
  fetchTopEmails,
  sendGmailMessage,
  authorizeSend,
  isSendAuthorized,
  isMockMode,
  isConnected,
  connect,
  disconnect,
  getClientId,
  setClientId,
  NeedsConnectError,
  type EmailSummary,
} from '../lib/gmail'

interface TopEmailsConfig {
  lookbackHours: number
  limit: number
  refreshSeconds: number
  /** Extra Gmail search criteria, e.g. "is:starred OR from:boss@x.com". */
  search: string
  /** Evernote email-in address (…@m.evernote.com) for the "to Evernote" shortcut. */
  evernoteEmail: string
  /** Evernote notebook the shortcut files into. */
  evernoteNotebook: string
  /** Tag added to the filed note. */
  evernoteTag: string
  /** Send directly via Gmail (one click) instead of opening the mail client. */
  evernoteDirectSend: boolean
}

const DEFAULT_CONFIG: TopEmailsConfig = {
  lookbackHours: 24,
  limit: 10,
  refreshSeconds: 300,
  search: '',
  evernoteEmail: '',
  evernoteNotebook: 'Planning',
  evernoteTag: 'task',
  evernoteDirectSend: true,
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const diffMin = Math.max(0, Math.round((Date.now() - then) / 60000))
  if (diffMin < 60) return `${diffMin}m`
  const h = Math.round(diffMin / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

// Evernote email-in: "@Notebook" routes, "#tag" tags, trailing "!" adds a reminder.
function evernoteSubject(email: EmailSummary, cfg: TopEmailsConfig): string {
  return `${email.subject} @${cfg.evernoteNotebook} #${cfg.evernoteTag} !`
}
function evernoteBody(email: EmailSummary, cfg: TopEmailsConfig): string {
  return [
    `- [ ] Follow up: ${email.subject}`,
    `From: ${email.fromName} <${email.fromEmail}>`,
    email.url ? `Open in Gmail: ${email.url}` : '',
    '',
    `Filed to ${cfg.evernoteNotebook} from Nexus.`,
  ]
    .filter(Boolean)
    .join('\n')
}
function evernoteMailto(email: EmailSummary, cfg: TopEmailsConfig): string {
  return `mailto:${cfg.evernoteEmail}?subject=${encodeURIComponent(
    evernoteSubject(email, cfg),
  )}&body=${encodeURIComponent(evernoteBody(email, cfg))}`
}

/** Open the user's mail client (fallback when direct Gmail send fails). */
function openMailto(href: string): void {
  const a = document.createElement('a')
  a.href = href
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

type SendState = 'idle' | 'sending' | 'sent' | 'opened' | 'error'

function EmailRow({
  email,
  rank,
  cfg,
  onSend,
}: {
  email: EmailSummary
  rank: number
  cfg: TopEmailsConfig
  onSend: (email: EmailSummary) => Promise<'sent' | 'opened'>
}) {
  const [send, setSend] = useState<SendState>('idle')
  const Main = email.url ? 'a' : 'div'
  const mainProps = email.url
    ? { href: email.url, target: '_blank', rel: 'noreferrer', draggable: false }
    : {}

  const direct = !!cfg.evernoteEmail && cfg.evernoteDirectSend && !isMockMode()
  const glyph =
    send === 'sending'
      ? '…'
      : send === 'sent'
        ? '✓'
        : send === 'opened'
          ? '↗'
          : send === 'error'
            ? '✗'
            : '⤳'

  const handleDirect = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (send === 'sending') return
    setSend('sending')
    try {
      const outcome = await onSend(email)
      setSend(outcome)
      setTimeout(() => setSend('idle'), outcome === 'opened' ? 3000 : 2000)
    } catch {
      setSend('error')
      setTimeout(() => setSend('idle'), 3500)
    }
  }

  return (
    <li className="mailrow" title={email.reasons.join(' · ') || 'No priority signals'}>
      <span className="mailrow__rank">{rank}</span>
      <Main className="mailrow__main mailrow__main--link" {...mainProps}>
        <span className="mailrow__top">
          <span className={`mailrow__from ${email.unread ? 'is-unread' : ''}`}>
            {email.fromName}
          </span>
          <span className="mailrow__time">{relativeTime(email.date)}</span>
        </span>
        <span className="mailrow__subject">{email.subject}</span>
      </Main>
      <span className="mailrow__flags">
        {email.starred && <span title="Starred">★</span>}
        {email.important && <span className="is-important" title="Important">!</span>}
      </span>
      {cfg.evernoteEmail ? (
        direct ? (
          <button
            className={`mailrow__en mailrow__en--${send}`}
            title={`Send to Evernote → ${cfg.evernoteNotebook}`}
            onClick={handleDirect}
          >
            {glyph}
          </button>
        ) : (
          <a
            className="mailrow__en"
            href={evernoteMailto(email, cfg)}
            target="_blank"
            rel="noreferrer"
            draggable={false}
            title={`Send to Evernote → ${cfg.evernoteNotebook} (opens mail app)`}
            onClick={(e) => e.stopPropagation()}
          >
            ⤳
          </a>
        )
      ) : null}
    </li>
  )
}

function TopEmailsBody({ config, title }: WidgetProps<TopEmailsConfig>) {
  const [emails, setEmails] = useState<EmailSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [needsConnect, setNeedsConnect] = useState(false)
  const [stale, setStale] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const mounted = useRef(true)
  const hasData = useRef(false)
  const mock = isMockMode()

  const load = useCallback(
    async (interactive: boolean) => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetchTopEmails({
          lookbackHours: config.lookbackHours,
          limit: config.limit,
          search: config.search,
          interactive,
        })
        if (!mounted.current) return
        setEmails(res.emails)
        hasData.current = true
        setNeedsConnect(false)
        setStale(false)
      } catch (err) {
        if (!mounted.current) return
        if (err instanceof NeedsConnectError || (!interactive && !isConnected())) {
          // Keep showing the list on a transient silent-auth hiccup.
          if (hasData.current) setStale(true)
          else setNeedsConnect(true)
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load')
        }
      } finally {
        if (mounted.current) setLoading(false)
      }
    },
    [config.lookbackHours, config.limit, config.search],
  )

  useEffect(() => {
    mounted.current = true
    void load(false)
    const ms = Math.max(30, config.refreshSeconds) * 1000
    const timer = setInterval(() => void load(false), ms)
    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [load, config.refreshSeconds])

  const onConnect = async () => {
    try {
      await connect()
      await load(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connect failed')
      setNeedsConnect(false)
    }
  }

  const sendToEvernote = async (email: EmailSummary): Promise<'sent' | 'opened'> => {
    try {
      await sendGmailMessage({
        to: config.evernoteEmail,
        subject: evernoteSubject(email, config),
        body: evernoteBody(email, config),
        // First send triggers the gmail.send consent popup.
        interactive: !isSendAuthorized(),
      })
      setNote(`Sent to Evernote → ${config.evernoteNotebook}`)
      setTimeout(() => mounted.current && setNote(null), 2500)
      return 'sent'
    } catch (err) {
      // Direct send failed (usually the gmail.send scope isn't granted) — fall
      // back to opening the mail client so the email still reaches Evernote.
      const msg = err instanceof Error ? err.message : 'send failed'
      openMailto(evernoteMailto(email, config))
      setNote(`Gmail send unavailable (${msg}). Opened mail app instead.`)
      setTimeout(() => mounted.current && setNote(null), 6000)
      return 'opened'
    }
  }

  return (
    <div className="widget topemails-widget">
      <div className="widget__head">
        <span className="widget__icon" aria-hidden>
          🏆
        </span>
        <span className="widget__title">{title}</span>
        <span className="widget__actions">
          <button
            className="widget__inline-btn"
            title="Refresh now"
            onClick={() => void load(false)}
          >
            ↻
          </button>
          {!mock && (
            <button
              className="widget__inline-btn"
              title="Reconnect Gmail"
              onClick={() => void onConnect()}
            >
              ⟲
            </button>
          )}
        </span>
      </div>

      {needsConnect ? (
        <div className="widget__body widget__center">
          <button className="btn btn--primary" onClick={onConnect}>
            Connect Gmail
          </button>
          <p className="widget__hint">Read-only access to your inbox.</p>
        </div>
      ) : error ? (
        <div className="widget__body widget__center">
          <p className="widget__error">{error}</p>
          <button className="btn" onClick={() => void load(true)}>
            Retry
          </button>
        </div>
      ) : (
        <div className="widget__body widget__body--list">
          {emails.length === 0 && !loading ? (
            <p className="widget__hint">No emails match in the last {config.lookbackHours}h.</p>
          ) : (
            <ol className="maillist">
              {emails.map((e, i) => (
                <EmailRow
                  key={e.id}
                  email={e}
                  rank={i + 1}
                  cfg={config}
                  onSend={sendToEvernote}
                />
              ))}
            </ol>
          )}
        </div>
      )}

      <div className="widget__foot">
        {mock && <span className="badge badge--mock">sample data</span>}
        {config.search && <span className="badge" title={config.search}>filtered</span>}
        {note && <span className="badge badge--note">{note}</span>}
        {stale && (
          <button className="badge badge--warn" onClick={onConnect}>
            reconnect
          </button>
        )}
        {loading && <span className="badge">refreshing…</span>}
      </div>
    </div>
  )
}

function TopEmailsSettings({ config, onChange }: WidgetSettingsProps<TopEmailsConfig>) {
  const [clientId, setClientIdInput] = useState(getClientId())
  const [sendAuth, setSendAuth] = useState(isSendAuthorized())
  const [authError, setAuthError] = useState<string | null>(null)
  const connected = isConnected()
  const set = (patch: Partial<TopEmailsConfig>) => onChange({ ...config, ...patch })

  const authorize = async () => {
    setAuthError(null)
    try {
      await authorizeSend()
      setSendAuth(true)
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : 'Authorization failed')
    }
  }

  return (
    <div className="settings-body">
      <div className="field-row">
        <label className="field">
          <span>Look back (hours)</span>
          <input
            type="number"
            min={1}
            value={config.lookbackHours}
            onChange={(e) => set({ lookbackHours: Math.max(1, Number(e.target.value)) })}
          />
        </label>
        <label className="field">
          <span>How many</span>
          <input
            type="number"
            min={1}
            max={25}
            value={config.limit}
            onChange={(e) =>
              set({ limit: Math.min(25, Math.max(1, Number(e.target.value))) })
            }
          />
        </label>
        <label className="field">
          <span>Refresh (s)</span>
          <input
            type="number"
            min={30}
            value={config.refreshSeconds}
            onChange={(e) => set({ refreshSeconds: Math.max(30, Number(e.target.value)) })}
          />
        </label>
      </div>

      <label className="field">
        <span>Search criteria (Gmail query, optional)</span>
        <input
          type="text"
          placeholder="e.g. is:starred OR from:boss@co.com  ·  label:work  ·  -category:promotions"
          value={config.search}
          onChange={(e) => set({ search: e.target.value })}
        />
      </label>
      <p className="settings__hint">
        ANDed with <code>in:inbox newer_than:{config.lookbackHours}h</code>. Uses
        Gmail search operators (from:, is:, label:, subject:, OR, -exclude…).
      </p>

      <div className="settings__divider" />

      <label className="field">
        <span>Evernote email-in address</span>
        <input
          type="text"
          placeholder="yourname.abc123@m.evernote.com"
          value={config.evernoteEmail}
          onChange={(e) => set({ evernoteEmail: e.target.value })}
        />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Notebook (folder)</span>
          <input
            type="text"
            value={config.evernoteNotebook}
            onChange={(e) => set({ evernoteNotebook: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Tag</span>
          <input
            type="text"
            value={config.evernoteTag}
            onChange={(e) => set({ evernoteTag: e.target.value })}
          />
        </label>
      </div>
      <label className="field field--check">
        <input
          type="checkbox"
          checked={config.evernoteDirectSend}
          onChange={(e) => set({ evernoteDirectSend: e.target.checked })}
        />
        <span>One-click send via Gmail (no mail app)</span>
      </label>

      {config.evernoteDirectSend && config.evernoteEmail && !isMockMode() && (
        <p className="settings__hint">
          {sendAuth ? (
            <span className="ok-text">✓ One-click send authorized.</span>
          ) : (
            <>
              <button className="btn btn--sm" onClick={authorize}>
                Authorize one-click send
              </button>{' '}
              — grants the <code>gmail.send</code> permission once so the ⤳
              button sends silently.
            </>
          )}
          {authError && <span className="widget__error"> {authError}</span>}
        </p>
      )}

      <p className="settings__hint">
        The <strong>⤳</strong> button files each email to Evernote in the{' '}
        <strong>{config.evernoteNotebook || 'Planning'}</strong> notebook as a
        task (checkbox + reminder). One-click sends it directly through your
        Gmail; if the <code>gmail.send</code> permission isn’t granted it falls
        back to opening your mail app. To enable true one-click, add the{' '}
        <code>gmail.send</code> scope to your OAuth consent screen, then click{' '}
        <strong>Authorize one-click send</strong> above. Find your Evernote
        address in Evernote → Settings → Email &amp; Calendar.
      </p>

      <div className="settings__divider" />

      <label className="field">
        <span>Google OAuth Client ID (shared by all Gmail widgets)</span>
        <input
          type="text"
          placeholder="xxxx.apps.googleusercontent.com (blank = sample data)"
          value={clientId}
          onChange={(e) => {
            setClientIdInput(e.target.value)
            setClientId(e.target.value)
          }}
        />
      </label>
      <p className="settings__hint">
        Leave blank for sample data. After saving a Client ID, close this and
        click <strong>Connect Gmail</strong> on the tile once to grant access.{' '}
        {connected ? (
          <button className="btn btn--sm" onClick={() => disconnect()}>
            Disconnect
          </button>
        ) : null}
      </p>
    </div>
  )
}

export const topEmailsWidget = defineWidget<TopEmailsConfig>({
  type: 'top-emails',
  name: 'Top Priority Emails',
  description: 'Ranks your most important inbox emails from the last 24h by priority.',
  icon: '🏆',
  defaultConfig: DEFAULT_CONFIG,
  component: TopEmailsBody,
  settings: TopEmailsSettings,
})
