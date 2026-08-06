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

function TopEmailsBody({ config, onOpenSettings }: WidgetProps<TopEmailsConfig>) {
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
        const msg = err instanceof Error ? err.message : 'Failed to load'
        if (!interactive && !isConnected()) setNeedsConnect(true)
        else setError(msg)
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
    }
  }

  return (
    <div className="widget topemails-widget">
      <div className="widget__head">
        <span className="widget__icon" aria-hidden>
          🏆
        </span>
        <span className="widget__title">Top Priority Emails</span>
        <button className="widget__gear" title="Widget settings" onClick={onOpenSettings}>
          ⚙
        </button>
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

function TopEmailsSettings({ config, onSave, onClose }: WidgetSettingsProps<TopEmailsConfig>) {
  const [lookbackHours, setLookback] = useState(config.lookbackHours)
  const [limit, setLimit] = useState(config.limit)
  const [refreshSeconds, setRefresh] = useState(config.refreshSeconds)
  const [clientId, setClientIdInput] = useState(getClientId())
  const connected = isConnected()

  const save = () => {
    setClientId(clientId)
    onSave({
      lookbackHours: Math.max(1, Math.round(lookbackHours)),
      limit: Math.min(25, Math.max(1, Math.round(limit))),
      refreshSeconds: Math.max(30, Math.round(refreshSeconds)),
    })
    onClose()
  }

  return (
    <div className="settings">
      <h3 className="settings__title">Top Priority Emails settings</h3>

      <label className="field">
        <span>Look back (hours)</span>
        <input
          type="number"
          min={1}
          value={lookbackHours}
          onChange={(e) => setLookback(Number(e.target.value))}
        />
      </label>

      <label className="field">
        <span>How many to show</span>
        <input
          type="number"
          min={1}
          max={25}
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
        />
      </label>

      <label className="field">
        <span>Auto-refresh (seconds)</span>
        <input
          type="number"
          min={30}
          value={refreshSeconds}
          onChange={(e) => setRefresh(Number(e.target.value))}
        />
      </label>

      <div className="settings__divider" />

      <label className="field">
        <span>Google OAuth Client ID</span>
        <input
          type="text"
          placeholder="xxxx.apps.googleusercontent.com (blank = sample data)"
          value={clientId}
          onChange={(e) => setClientIdInput(e.target.value)}
        />
      </label>
      <p className="settings__hint">
        Shared with the Gmail Inbox widget. Leave blank to run with sample data.{' '}
        {connected ? (
          <button className="btn btn--sm" onClick={() => disconnect()}>
            Disconnect
          </button>
        ) : null}
      </p>

      <div className="settings__actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn--primary" onClick={save}>
          Save
        </button>
      </div>
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
