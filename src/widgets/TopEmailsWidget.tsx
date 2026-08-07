import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defineWidget, type WidgetProps, type WidgetSettingsProps } from './types'
import { useTileActions } from '../components/TileActions'
import {
  fetchInboxCounts,
  fetchEmailPage,
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
  type InboxCounts,
  type MailFilter,
} from '../lib/gmail'

interface TopEmailsConfig {
  lookbackHours: number
  refreshSeconds: number
  pageSize: number
  search: string
  evernoteEmail: string
  evernoteNotebook: string
  evernoteTag: string
  evernoteDirectSend: boolean
  /** Which automation to POST to (per tile). 'none' uses the email path. */
  webhookProvider: WebhookProvider
  /** Catch-Hook URL for the selected provider. */
  webhookUrl: string
}

type WebhookProvider = 'none' | 'zapier' | 'make'

const PROVIDER_LABEL: Record<WebhookProvider, string> = {
  none: 'None',
  zapier: 'Zapier',
  make: 'Make.com',
}
const PROVIDER_PLACEHOLDER: Record<WebhookProvider, string> = {
  none: '',
  zapier: 'https://hooks.zapier.com/hooks/catch/…',
  make: 'https://hook.us1.make.com/…  (or hook.eu1.make.com)',
}

const DEFAULT_CONFIG: TopEmailsConfig = {
  lookbackHours: 24,
  refreshSeconds: 300,
  pageSize: 15,
  search: '',
  evernoteEmail: 'ashishkohli.62760@m.evernote.com',
  evernoteNotebook: 'Planning',
  evernoteTag: 'task',
  evernoteDirectSend: true,
  webhookProvider: 'none',
  webhookUrl: '',
}

function webhookActive(cfg: TopEmailsConfig): boolean {
  return cfg.webhookProvider !== 'none' && !!cfg.webhookUrl.trim()
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const diffMin = Math.max(0, Math.round((Date.now() - then) / 60000))
  if (diffMin < 60) return `${diffMin}m`
  const h = Math.round(diffMin / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

const byPriority = (a: EmailSummary, b: EmailSummary) =>
  b.score - a.score || b.date.localeCompare(a.date)

// ---- Evernote email-in helpers (@Notebook routes, #tag tags, ! reminder) ----
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
function openMailto(href: string): void {
  const a = document.createElement('a')
  a.href = href
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/**
 * POST the email to a Zapier / Make / IFTTT catch-hook. Sent as form-encoded
 * (a CORS "simple request", so no preflight) so it works cross-origin from a
 * static page. The automation then creates the Evernote note/task.
 */
async function postWebhook(
  url: string,
  email: EmailSummary,
  cfg: TopEmailsConfig,
): Promise<void> {
  const body = new URLSearchParams({
    subject: email.subject,
    from: email.fromName,
    fromEmail: email.fromEmail,
    date: email.date,
    gmailUrl: email.url,
    notebook: cfg.evernoteNotebook,
    tag: cfg.evernoteTag,
    unread: String(email.unread),
    important: String(email.important),
    score: String(email.score),
    reasons: email.reasons.join(', '),
  })
  // no-cors: fire-and-forget; the hook receives the data, response is opaque.
  await fetch(url, { method: 'POST', mode: 'no-cors', body })
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
  // Use the action button (not a mailto link) when a webhook is active, or when
  // one-click Gmail send is on in live mode.
  const direct =
    webhookActive(cfg) ||
    (!!cfg.evernoteEmail && cfg.evernoteDirectSend && !isMockMode())
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
  const [filter, setFilter] = useState<MailFilter>('all')
  const [emails, setEmails] = useState<EmailSummary[]>([])
  const [nextToken, setNextToken] = useState<string | undefined>(undefined)
  const [counts, setCounts] = useState<InboxCounts | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsConnect, setNeedsConnect] = useState(false)
  const [stale, setStale] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const mounted = useRef(true)
  const hasData = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)
  const mock = isMockMode()

  const handleErr = (err: unknown, interactive: boolean) => {
    if (err instanceof NeedsConnectError || (!interactive && !isConnected())) {
      if (hasData.current) setStale(true)
      else setNeedsConnect(true)
    } else {
      setError(err instanceof Error ? err.message : 'Failed to load')
    }
  }

  const loadFirst = useCallback(
    async (interactive: boolean) => {
      setLoading(true)
      setError(null)
      try {
        const [countRes, pageRes] = await Promise.all([
          fetchInboxCounts({
            lookbackHours: config.lookbackHours,
            search: config.search,
            interactive,
          }),
          fetchEmailPage({
            lookbackHours: config.lookbackHours,
            search: config.search,
            filter,
            pageSize: config.pageSize,
            interactive,
          }),
        ])
        if (!mounted.current) return
        setCounts(countRes)
        setEmails([...pageRes.emails].sort(byPriority))
        setNextToken(pageRes.nextPageToken)
        hasData.current = true
        setNeedsConnect(false)
        setStale(false)
      } catch (err) {
        if (mounted.current) handleErr(err, interactive)
      } finally {
        if (mounted.current) setLoading(false)
      }
    },
    [config.lookbackHours, config.search, config.pageSize, filter],
  )

  const loadMore = useCallback(async () => {
    if (!nextToken || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await fetchEmailPage({
        lookbackHours: config.lookbackHours,
        search: config.search,
        filter,
        pageToken: nextToken,
        pageSize: config.pageSize,
      })
      if (!mounted.current) return
      setEmails((prev) => {
        const seen = new Set(prev.map((e) => e.id))
        const merged = [...prev, ...res.emails.filter((e) => !seen.has(e.id))]
        return merged.sort(byPriority)
      })
      setNextToken(res.nextPageToken)
    } catch (err) {
      if (mounted.current) handleErr(err, false)
    } finally {
      if (mounted.current) setLoadingMore(false)
    }
  }, [nextToken, loadingMore, config.lookbackHours, config.search, config.pageSize, filter])

  // Initial load + refresh on interval + reload when filter changes.
  useEffect(() => {
    mounted.current = true
    void loadFirst(false)
    const ms = Math.max(30, config.refreshSeconds) * 1000
    const timer = setInterval(() => void loadFirst(false), ms)
    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [loadFirst, config.refreshSeconds])

  const onConnect = useCallback(async () => {
    try {
      await connect()
      // connect() already cached the token; reload silently (no 2nd popup).
      await loadFirst(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connect failed')
      setNeedsConnect(false)
    }
  }, [loadFirst])

  // Refresh when a token becomes available (e.g. header login).
  useEffect(() => {
    const h = () => void loadFirst(false)
    window.addEventListener('nexus:gmail-token', h)
    return () => window.removeEventListener('nexus:gmail-token', h)
  }, [loadFirst])

  // Bottom-bar controls.
  const barActions = useMemo(
    () =>
      mock
        ? [{ key: 'refresh', icon: '↻', title: 'Refresh now', onClick: () => void loadFirst(false) }]
        : [
            { key: 'refresh', icon: '↻', title: 'Refresh now', onClick: () => void loadFirst(false) },
            { key: 'reconnect', icon: '⟲', title: 'Reconnect Gmail', onClick: () => void onConnect() },
          ],
    [mock, loadFirst, onConnect],
  )
  useTileActions(barActions, [barActions])

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) void loadMore()
  }

  const sendToEvernote = async (email: EmailSummary): Promise<'sent' | 'opened'> => {
    // Preferred path: POST to the selected automation webhook (a real API call).
    if (webhookActive(config)) {
      const label = PROVIDER_LABEL[config.webhookProvider]
      try {
        await postWebhook(config.webhookUrl.trim(), email, config)
        setNote(`Sent to ${label} → ${config.evernoteNotebook}`)
        setTimeout(() => mounted.current && setNote(null), 2500)
        return 'sent'
      } catch (err) {
        setNote(err instanceof Error ? `${label} failed: ${err.message}` : `${label} failed`)
        setTimeout(() => mounted.current && setNote(null), 5000)
        throw err
      }
    }
    try {
      await sendGmailMessage({
        to: config.evernoteEmail,
        subject: evernoteSubject(email, config),
        body: evernoteBody(email, config),
        interactive: !isSendAuthorized(),
      })
      setNote(`Sent to Evernote → ${config.evernoteNotebook}`)
      setTimeout(() => mounted.current && setNote(null), 2500)
      return 'sent'
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'send failed'
      openMailto(evernoteMailto(email, config))
      setNote(`Gmail send unavailable (${msg}). Opened mail app instead.`)
      setTimeout(() => mounted.current && setNote(null), 6000)
      return 'opened'
    }
  }

  const filters: { key: MailFilter; label: string; count: number | undefined }[] = [
    { key: 'all', label: 'All', count: counts?.total },
    { key: 'unread', label: 'Unread', count: counts?.unread },
    { key: 'read', label: 'Read', count: counts?.read },
  ]

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
          <button className="btn" onClick={() => void loadFirst(true)}>
            Retry
          </button>
        </div>
      ) : (
        <>
          <div className="mailcounts">
            {filters.map((f) => (
              <button
                key={f.key}
                className={`mailcounts__btn ${filter === f.key ? 'is-active' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                <span className="mailcounts__n">{f.count ?? '—'}</span>
              </button>
            ))}
          </div>

          <div
            className="widget__body widget__body--list"
            ref={listRef}
            onScroll={onScroll}
          >
            {emails.length === 0 && !loading ? (
              <p className="widget__hint">Nothing here in the last {config.lookbackHours}h.</p>
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
            {nextToken && (
              <button
                className="maillist__more"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </div>
        </>
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
          <span>Page size</span>
          <input
            type="number"
            min={5}
            max={50}
            value={config.pageSize}
            onChange={(e) =>
              set({ pageSize: Math.min(50, Math.max(5, Number(e.target.value))) })
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
          placeholder="e.g. is:starred OR from:boss@co.com  ·  label:work"
          value={config.search}
          onChange={(e) => set({ search: e.target.value })}
        />
      </label>
      <p className="settings__hint">
        ANDed with <code>in:inbox newer_than:{config.lookbackHours}h</code>. The
        list is priority-ranked; scroll to load more. Counts at top show
        total / unread / read for the current window.
      </p>

      <div className="settings__divider" />

      <label className="field">
        <span>Send via — pick this tile's automation</span>
        <select
          value={config.webhookProvider}
          onChange={(e) => set({ webhookProvider: e.target.value as WebhookProvider })}
        >
          <option value="none">Email (Evernote email-in / Gmail)</option>
          <option value="zapier">Zapier webhook</option>
          <option value="make">Make.com webhook</option>
        </select>
      </label>
      {config.webhookProvider !== 'none' && (
        <>
          <label className="field">
            <span>{PROVIDER_LABEL[config.webhookProvider]} catch-hook URL</span>
            <input
              type="text"
              placeholder={PROVIDER_PLACEHOLDER[config.webhookProvider]}
              value={config.webhookUrl}
              onChange={(e) => set({ webhookUrl: e.target.value })}
            />
          </label>
          <p className="settings__hint">
            The <strong>⤳</strong> button POSTs the email (subject, sender, Gmail
            link, notebook, tag, score…) to this URL — your{' '}
            {PROVIDER_LABEL[config.webhookProvider]} scenario then “Create Note”
            in Evernote. Real API call, no backend.{' '}
            {config.webhookProvider === 'zapier'
              ? 'In Zapier: Trigger = “Webhooks by Zapier → Catch Hook”, Action = “Evernote → Create Note”.'
              : 'In Make: add a “Custom webhook” trigger, then an “Evernote → Create a Note” module.'}
          </p>
        </>
      )}

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
              — grants the <code>gmail.send</code> permission once.
            </>
          )}
          {authError && <span className="widget__error"> {authError}</span>}
        </p>
      )}

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
        Leave blank for sample data.{' '}
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
  description: 'Priority-ranked inbox with counts, unread/read filters, and infinite scroll.',
  icon: '🏆',
  defaultConfig: DEFAULT_CONFIG,
  component: TopEmailsBody,
  settings: TopEmailsSettings,
})
