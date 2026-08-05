import { useCallback, useEffect, useRef, useState } from 'react'
import { defineWidget, type WidgetProps, type WidgetSettingsProps } from './types'
import {
  fetchInboxStats,
  isMockMode,
  isConnected,
  connect,
  disconnect,
  getClientId,
  setClientId,
  type InboxStats,
} from '../lib/gmail'

interface GmailConfig {
  /** Window to look back over, in hours. */
  lookbackHours: number
  /** Auto-refresh cadence, in seconds. */
  refreshSeconds: number
}

const DEFAULT_CONFIG: GmailConfig = { lookbackHours: 24, refreshSeconds: 300 }

function windowLabel(hours: number): string {
  if (hours === 24) return 'last 24 hours'
  if (hours === 1) return 'last hour'
  if (hours % 24 === 0) return `last ${hours / 24} days`
  return `last ${hours} hours`
}

function GmailInboxBody({ config, onOpenSettings }: WidgetProps<GmailConfig>) {
  const [stats, setStats] = useState<InboxStats | null>(null)
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
        const next = await fetchInboxStats({
          lookbackHours: config.lookbackHours,
          interactive,
        })
        if (!mounted.current) return
        setStats(next)
        setNeedsConnect(false)
      } catch (err) {
        if (!mounted.current) return
        const msg = err instanceof Error ? err.message : 'Failed to load'
        // A non-interactive silent token request failing just means we need a
        // click to connect — surface that as a friendly prompt, not an error.
        if (!interactive && !isConnected()) setNeedsConnect(true)
        else setError(msg)
      } finally {
        if (mounted.current) setLoading(false)
      }
    },
    [config.lookbackHours],
  )

  // Initial load + auto-refresh.
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
    <div className="widget gmail-widget">
      <div className="widget__head">
        <span className="widget__icon" aria-hidden>
          ✉️
        </span>
        <span className="widget__title">Gmail Inbox</span>
        <button
          className="widget__gear"
          title="Widget settings"
          onClick={onOpenSettings}
        >
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
        <div className="widget__body">
          <div className="stat">
            <span className="stat__value">
              {stats ? (stats.capped ? `${stats.total}+` : stats.total) : '—'}
            </span>
            <span className="stat__label">
              new · {windowLabel(config.lookbackHours)}
            </span>
          </div>
          <div className="stat stat--sub">
            <span className="stat__value stat__value--accent">
              {stats ? stats.unread : '—'}
            </span>
            <span className="stat__label">unread</span>
          </div>
        </div>
      )}

      <div className="widget__foot">
        {mock && <span className="badge badge--mock">sample data</span>}
        {loading && <span className="badge">refreshing…</span>}
      </div>
    </div>
  )
}

function GmailInboxSettings({
  config,
  onSave,
  onClose,
}: WidgetSettingsProps<GmailConfig>) {
  const [lookbackHours, setLookback] = useState(config.lookbackHours)
  const [refreshSeconds, setRefresh] = useState(config.refreshSeconds)
  const [clientId, setClientIdInput] = useState(getClientId())
  const connected = isConnected()

  const save = () => {
    setClientId(clientId)
    onSave({
      lookbackHours: Math.max(1, Math.round(lookbackHours)),
      refreshSeconds: Math.max(30, Math.round(refreshSeconds)),
    })
    onClose()
  }

  return (
    <div className="settings">
      <h3 className="settings__title">Gmail Inbox settings</h3>

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
        Leave blank to run with sample data. Add a Web OAuth Client ID (scope{' '}
        <code>gmail.readonly</code>) with this site's origin in “Authorized
        JavaScript origins” to show live numbers.{' '}
        {connected ? (
          <button
            className="btn btn--sm"
            onClick={() => {
              disconnect()
            }}
          >
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

export const gmailInboxWidget = defineWidget<GmailConfig>({
  type: 'gmail-inbox',
  name: 'Gmail Inbox',
  description: 'New emails in your inbox over a time window, and how many are unread.',
  icon: '✉️',
  defaultConfig: DEFAULT_CONFIG,
  component: GmailInboxBody,
  settings: GmailInboxSettings,
})
