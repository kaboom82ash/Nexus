import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defineWidget, type WidgetProps, type WidgetSettingsProps } from './types'
import { useTileActions } from '../components/TileActions'
import {
  fetchInboxStats,
  isMockMode,
  isConnected,
  connect,
  NeedsConnectError,
  type InboxStats,
} from '../lib/gmail'

interface GmailConfig {
  lookbackHours: number
  refreshSeconds: number
}

const DEFAULT_CONFIG: GmailConfig = { lookbackHours: 24, refreshSeconds: 300 }

function windowLabel(hours: number): string {
  if (hours === 24) return 'last 24 hours'
  if (hours === 1) return 'last hour'
  if (hours % 24 === 0) return `last ${hours / 24} days`
  return `last ${hours} hours`
}

function GmailInboxBody({ config, title }: WidgetProps<GmailConfig>) {
  const [stats, setStats] = useState<InboxStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [needsConnect, setNeedsConnect] = useState(false)
  const [stale, setStale] = useState(false)
  const mounted = useRef(true)
  const hasData = useRef(false)
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
        hasData.current = true
        setNeedsConnect(false)
        setStale(false)
      } catch (err) {
        if (!mounted.current) return
        if (err instanceof NeedsConnectError || (!interactive && !isConnected())) {
          // Don't blank a tile that already has data on a transient silent-auth
          // hiccup — keep showing it and offer a manual reconnect.
          if (hasData.current) setStale(true)
          else setNeedsConnect(true)
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load')
        }
      } finally {
        if (mounted.current) setLoading(false)
      }
    },
    [config.lookbackHours],
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

  const onConnect = useCallback(async () => {
    try {
      await connect()
      // connect() already cached the token; reload silently (no 2nd popup).
      await load(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connect failed')
      setNeedsConnect(false)
    }
  }, [load])

  // Refresh immediately when a token becomes available (e.g. header login).
  useEffect(() => {
    const h = () => void load(false)
    window.addEventListener('nexus:gmail-token', h)
    return () => window.removeEventListener('nexus:gmail-token', h)
  }, [load])

  // Contribute refresh / reconnect controls to the tile's bottom bar.
  const barActions = useMemo(
    () =>
      mock
        ? [{ key: 'refresh', icon: '↻', title: 'Refresh now', onClick: () => void load(false) }]
        : [
            { key: 'refresh', icon: '↻', title: 'Refresh now', onClick: () => void load(false) },
            { key: 'reconnect', icon: '⟲', title: 'Reconnect Gmail', onClick: () => void onConnect() },
          ],
    [mock, load, onConnect],
  )
  useTileActions(barActions, [barActions])

  return (
    <div className="widget gmail-widget">
      <div className="widget__head">
        <span className="widget__icon" aria-hidden>
          ✉️
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

function GmailInboxSettings({ config, onChange }: WidgetSettingsProps<GmailConfig>) {
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
      <p className="settings__hint">
        Gmail sign-in &amp; Client ID live in <strong>Global settings</strong>{' '}
        (the ⚙ in the top bar) — set once for every Gmail widget.
      </p>
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
