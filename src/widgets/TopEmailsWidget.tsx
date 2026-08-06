import { useCallback, useEffect, useRef, useState } from 'react'
import { defineWidget, type WidgetProps, type WidgetSettingsProps } from './types'
import {
  fetchTopEmails,
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
}

const DEFAULT_CONFIG: TopEmailsConfig = {
  lookbackHours: 24,
  limit: 10,
  refreshSeconds: 300,
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const diffMin = Math.max(0, Math.round((Date.now() - then) / 60000))
  if (diffMin < 60) return `${diffMin}m`
  const h = Math.round(diffMin / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

function EmailRow({ email, rank }: { email: EmailSummary; rank: number }) {
  return (
    <li className="mailrow" title={email.reasons.join(' · ') || 'No priority signals'}>
      <span className="mailrow__rank">{rank}</span>
      <span className="mailrow__main">
        <span className="mailrow__top">
          <span className={`mailrow__from ${email.unread ? 'is-unread' : ''}`}>
            {email.fromName}
          </span>
          <span className="mailrow__time">{relativeTime(email.date)}</span>
        </span>
        <span className="mailrow__subject">{email.subject}</span>
      </span>
      <span className="mailrow__flags">
        {email.starred && <span title="Starred">★</span>}
        {email.important && <span className="is-important" title="Important">!</span>}
      </span>
    </li>
  )
}

function TopEmailsBody({ config, title }: WidgetProps<TopEmailsConfig>) {
  const [emails, setEmails] = useState<EmailSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [needsConnect, setNeedsConnect] = useState(false)
  const mounted = useRef(true)
  const mock = isMockMode()

  const load = useCallback(
    async (interactive: boolean) => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetchTopEmails({
          lookbackHours: config.lookbackHours,
          limit: config.limit,
          interactive,
        })
        if (!mounted.current) return
        setEmails(res.emails)
        setNeedsConnect(false)
      } catch (err) {
        if (!mounted.current) return
        if (err instanceof NeedsConnectError || (!interactive && !isConnected())) {
          setNeedsConnect(true)
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load')
        }
      } finally {
        if (mounted.current) setLoading(false)
      }
    },
    [config.lookbackHours, config.limit],
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

  return (
    <div className="widget topemails-widget">
      <div className="widget__head">
        <span className="widget__icon" aria-hidden>
          🏆
        </span>
        <span className="widget__title">{title}</span>
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
            <p className="widget__hint">No emails in the last {config.lookbackHours}h.</p>
          ) : (
            <ol className="maillist">
              {emails.map((e, i) => (
                <EmailRow key={e.id} email={e} rank={i + 1} />
              ))}
            </ol>
          )}
        </div>
      )}

      <div className="widget__foot">
        {mock && <span className="badge badge--mock">sample data</span>}
        {loading && <span className="badge">refreshing…</span>}
      </div>
    </div>
  )
}

function TopEmailsSettings({ config, onChange }: WidgetSettingsProps<TopEmailsConfig>) {
  const [clientId, setClientIdInput] = useState(getClientId())
  const connected = isConnected()

  return (
    <div className="settings-body">
      <label className="field">
        <span>Look back (hours)</span>
        <input
          type="number"
          min={1}
          value={config.lookbackHours}
          onChange={(e) =>
            onChange({ ...config, lookbackHours: Math.max(1, Number(e.target.value)) })
          }
        />
      </label>

      <label className="field">
        <span>How many to show</span>
        <input
          type="number"
          min={1}
          max={25}
          value={config.limit}
          onChange={(e) =>
            onChange({
              ...config,
              limit: Math.min(25, Math.max(1, Number(e.target.value))),
            })
          }
        />
      </label>

      <label className="field">
        <span>Auto-refresh (seconds)</span>
        <input
          type="number"
          min={30}
          value={config.refreshSeconds}
          onChange={(e) =>
            onChange({ ...config, refreshSeconds: Math.max(30, Number(e.target.value)) })
          }
        />
      </label>

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
