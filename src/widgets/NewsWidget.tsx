import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defineWidget, type WidgetProps, type WidgetSettingsProps } from './types'
import { useTileActions } from '../components/TileActions'
import { fetchNews, CNN_TOP_STORIES, type NewsItem } from '../lib/news'

interface NewsConfig {
  feedUrl: string
  limit: number
  refreshSeconds: number
}

const DEFAULT_CONFIG: NewsConfig = {
  feedUrl: CNN_TOP_STORIES,
  limit: 10,
  refreshSeconds: 600,
}

function relativeTime(dateStr: string): string {
  if (!dateStr) return ''
  const then = new Date(dateStr).getTime()
  if (Number.isNaN(then)) return ''
  const diffMin = Math.max(0, Math.round((Date.now() - then) / 60000))
  if (diffMin < 60) return `${diffMin}m`
  const h = Math.round(diffMin / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

function NewsBody({ config, title }: WidgetProps<NewsConfig>) {
  const [items, setItems] = useState<NewsItem[]>([])
  const [source, setSource] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const mounted = useRef(true)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoading(true)
    setError(null)
    try {
      const res = await fetchNews(config.feedUrl, config.limit, ctrl.signal)
      if (!mounted.current || ctrl.signal.aborted) return
      setItems(res.items)
      setSource(res.source)
    } catch (err) {
      if (!mounted.current || ctrl.signal.aborted) return
      setError(err instanceof Error ? err.message : 'Failed to load feed')
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [config.feedUrl, config.limit])

  useEffect(() => {
    mounted.current = true
    void load()
    const ms = Math.max(60, config.refreshSeconds) * 1000
    const timer = setInterval(() => void load(), ms)
    return () => {
      mounted.current = false
      abortRef.current?.abort()
      clearInterval(timer)
    }
  }, [load, config.refreshSeconds])

  const barActions = useMemo(
    () => [{ key: 'refresh', icon: '↻', title: 'Refresh now', onClick: () => void load() }],
    [load],
  )
  useTileActions(barActions, [barActions])

  return (
    <div className="widget news-widget">
      <div className="widget__head">
        <span className="widget__icon" aria-hidden>
          📰
        </span>
        <span className="widget__title">{title}</span>
      </div>

      {error && items.length === 0 ? (
        <div className="widget__body widget__center">
          <p className="widget__error">{error}</p>
          <button className="btn" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : (
        <div className="widget__body widget__body--list">
          {items.length === 0 && !loading ? (
            <p className="widget__hint">No stories.</p>
          ) : (
            <ol className="newslist">
              {items.map((it, i) => (
                <li key={`${i}-${it.link}`} className="newsrow">
                  <span className="newsrow__rank">{i + 1}</span>
                  <a
                    className="newsrow__link"
                    href={it.link || undefined}
                    target="_blank"
                    rel="noreferrer"
                    draggable={false}
                  >
                    <span className="newsrow__title">{it.title}</span>
                    {it.date && (
                      <span className="newsrow__time">{relativeTime(it.date)}</span>
                    )}
                  </a>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <div className="widget__foot">
        {source && <span className="badge" title={config.feedUrl}>{source}</span>}
        {error && items.length > 0 && <span className="badge badge--warn">stale</span>}
        {loading && <span className="badge">refreshing…</span>}
      </div>
    </div>
  )
}

const CNN_PRESETS: { label: string; url: string }[] = [
  { label: 'CNN — Top Stories', url: 'http://rss.cnn.com/rss/cnn_topstories.rss' },
  { label: 'CNN — World', url: 'http://rss.cnn.com/rss/cnn_world.rss' },
  { label: 'CNN — US', url: 'http://rss.cnn.com/rss/cnn_us.rss' },
  { label: 'CNN — Technology', url: 'http://rss.cnn.com/rss/cnn_tech.rss' },
  { label: 'CNN — Business', url: 'http://rss.cnn.com/rss/money_latest.rss' },
]

function NewsSettings({ config, onChange }: WidgetSettingsProps<NewsConfig>) {
  const set = (patch: Partial<NewsConfig>) => onChange({ ...config, ...patch })
  return (
    <div className="settings-body">
      <label className="field">
        <span>Feed preset</span>
        <select
          value={CNN_PRESETS.some((p) => p.url === config.feedUrl) ? config.feedUrl : ''}
          onChange={(e) => e.target.value && set({ feedUrl: e.target.value })}
        >
          {!CNN_PRESETS.some((p) => p.url === config.feedUrl) && (
            <option value="">Custom feed</option>
          )}
          {CNN_PRESETS.map((p) => (
            <option key={p.url} value={p.url}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Feed URL (any RSS/Atom)</span>
        <input
          type="text"
          value={config.feedUrl}
          onChange={(e) => set({ feedUrl: e.target.value })}
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span>How many</span>
          <input
            type="number"
            min={1}
            max={50}
            value={config.limit}
            onChange={(e) =>
              set({ limit: Math.min(50, Math.max(1, Number(e.target.value))) })
            }
          />
        </label>
        <label className="field">
          <span>Refresh (s)</span>
          <input
            type="number"
            min={60}
            value={config.refreshSeconds}
            onChange={(e) => set({ refreshSeconds: Math.max(60, Number(e.target.value)) })}
          />
        </label>
      </div>
      <p className="settings__hint">
        Fetched via a CORS-friendly RSS→JSON converter (rss2json), since browsers
        can’t read most feeds directly. Works with any RSS/Atom URL — swap the
        feed above for BBC, NYT, a subreddit, etc.
      </p>
    </div>
  )
}

export const newsWidget = defineWidget<NewsConfig>({
  type: 'news-rss',
  name: 'CNN Top Stories',
  description: 'Top headlines from CNN (or any RSS feed), refreshed live.',
  icon: '📰',
  defaultConfig: DEFAULT_CONFIG,
  component: NewsBody,
  settings: NewsSettings,
})
