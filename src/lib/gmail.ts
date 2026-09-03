/**
 * Gmail access for dashboard widgets.
 *
 * Two modes:
 *  - MOCK (default): no Google credentials configured. Returns stable sample
 *    data so the dashboard is fully usable out of the box.
 *  - LIVE: a Google OAuth Client ID is configured (via VITE_GOOGLE_CLIENT_ID
 *    at build time, or saved in the UI at runtime). Uses Google Identity
 *    Services to get a `gmail.readonly` access token and calls the Gmail REST
 *    API directly from the browser — no backend required.
 */

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
/** Public alias — other modules compose scope sets from this. */
export const GMAIL_READONLY_SCOPE = GMAIL_SCOPE
const CLIENT_ID_KEY = 'nexus.google.clientId'
const GIS_SRC = 'https://accounts.google.com/gsi/client'

/** How many message ids we page through before reporting a capped count. */
const COUNT_CAP = 500
const PAGE_SIZE = 100

export interface InboxStats {
  /** Messages that arrived in the inbox within the lookback window. */
  total: number
  /** Of those, how many are still unread. */
  unread: number
  /** True when the real count exceeded COUNT_CAP (shown as "500+"). */
  capped: boolean
  /** True when the numbers are sample data, not from a real account. */
  mock: boolean
}

// ---------------------------------------------------------------------------
// Client ID configuration
// ---------------------------------------------------------------------------

function envClientId(): string {
  const v = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? ''
  return v.trim()
}

export function getClientId(): string {
  const fromEnv = envClientId()
  if (fromEnv) return fromEnv
  try {
    return (localStorage.getItem(CLIENT_ID_KEY) ?? '').trim()
  } catch {
    return ''
  }
}

export function setClientId(id: string): void {
  try {
    const trimmed = id.trim()
    if (trimmed) localStorage.setItem(CLIENT_ID_KEY, trimmed)
    else localStorage.removeItem(CLIENT_ID_KEY)
  } catch {
    // ignore storage errors
  }
  // A changed client id invalidates every cached token (all scopes).
  clearAllScopeTokens()
}

export function isMockMode(): boolean {
  return getClientId() === ''
}

// ---------------------------------------------------------------------------
// Google Identity Services (token) — loaded lazily, only in LIVE mode
// ---------------------------------------------------------------------------

// Minimal shape of the pieces of GIS we use.
interface TokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
  /**
   * Space-separated scopes Google ACTUALLY granted. The consent screen has a
   * checkbox per scope, so this can be a subset of what was asked for — and
   * assuming otherwise is how a partial grant turns into a sign-in loop.
   */
  scope?: string
}
interface TokenError {
  type?: string
  message?: string
}
interface TokenClient {
  requestAccessToken: (opts?: { prompt?: string }) => void
  callback: (resp: TokenResponse) => void
}
interface GoogleGsi {
  accounts: {
    oauth2: {
      initTokenClient: (config: {
        client_id: string
        scope: string
        callback: (resp: TokenResponse) => void
        error_callback?: (err: TokenError) => void
      }) => TokenClient
      revoke: (token: string, done?: () => void) => void
    }
  }
}

/** Thrown when a silent token request fails because consent is needed. */
export class NeedsConnectError extends Error {
  constructor() {
    super('Gmail not connected')
    this.name = 'NeedsConnectError'
  }
}
declare global {
  interface Window {
    google?: GoogleGsi
  }
}

let gisPromise: Promise<GoogleGsi> | null = null

function loadGis(): Promise<GoogleGsi> {
  if (window.google?.accounts?.oauth2) return Promise.resolve(window.google)
  if (gisPromise) return gisPromise
  gisPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GIS_SRC}"]`,
    )
    const onLoad = () => {
      if (window.google?.accounts?.oauth2) resolve(window.google)
      else reject(new Error('Google Identity Services failed to initialize'))
    }
    if (existing) {
      existing.addEventListener('load', onLoad)
      existing.addEventListener('error', () =>
        reject(new Error('Failed to load Google Identity Services')),
      )
      return
    }
    const script = document.createElement('script')
    script.src = GIS_SRC
    script.async = true
    script.defer = true
    script.onload = onLoad
    script.onerror = () =>
      reject(new Error('Failed to load Google Identity Services'))
    document.head.appendChild(script)
  })
  return gisPromise
}

interface CachedToken {
  token: string
  expiresAt: number
}

// Additional scope for sending mail (used by the direct Evernote converter).
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'

const TOKENS_KEY = 'nexus.google.tokens'

type TokenMap = Record<string, CachedToken>

function loadTokens(): TokenMap {
  try {
    const raw = localStorage.getItem(TOKENS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as TokenMap
      if (parsed && typeof parsed === 'object') return parsed
    }
    return {}
  } catch {
    return {}
  }
}

// Tokens keyed by scope, seeded from storage so a reload reuses valid tokens.
let tokens: TokenMap = loadTokens()

function persistTokens(): void {
  try {
    if (Object.keys(tokens).length) {
      localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens))
    } else {
      localStorage.removeItem(TOKENS_KEY)
    }
  } catch {
    /* storage unavailable — in-memory tokens still work for this session */
  }
}

function setScopeToken(scope: string, next: CachedToken | null): void {
  if (next) tokens[scope] = next
  else delete tokens[scope]
  persistTokens()
}

function validScopeToken(scope: string): string | null {
  const t = tokens[scope]
  if (t && t.expiresAt - 60_000 > Date.now()) return t.token
  return null
}

/**
 * Whether Google granted this scope, regardless of how the expiry maths comes
 * out. Grant and freshness are different questions, and conflating them is a
 * sign-in loop: `validScopeToken` subtracts a 60s safety margin from an expiry
 * derived from the device clock, so a token Google JUST issued reads as
 * ungranted whenever that clock runs fast (or `expires_in` comes back short).
 * The caller then reports "access was not granted", the user signs in again,
 * Google grants again, it still reads ungranted — forever, with nothing on
 * screen to explain it. Verify grants with this; use validScopeToken only to
 * decide whether a cached token is still usable.
 */
function hasScopeGrant(scope: string): boolean {
  return !!tokens[scope]
}

/**
 * Interactive sign-in circuit breaker. Whatever else goes wrong, the app must
 * never be able to reopen Google's consent screen without end: past this many
 * prompts for one scope inside the window, refuse and say so.
 */
const MAX_PROMPTS = 3
const PROMPT_WINDOW_MS = 60_000
const promptLog: Record<string, number[]> = {}

function tooManyPrompts(scope: string): boolean {
  const now = Date.now()
  const recent = (promptLog[scope] ?? []).filter((t) => now - t < PROMPT_WINDOW_MS)
  promptLog[scope] = recent
  return recent.length >= MAX_PROMPTS
}

function notePrompt(scope: string): void {
  promptLog[scope] = (promptLog[scope] ?? []).concat(Date.now())
}

/** Called once a sign-in genuinely works, so a later retry starts fresh. */
function clearPromptLog(scope: string): void {
  delete promptLog[scope]
}

function clearAllScopeTokens(): void {
  tokens = {}
  persistTokens()
}

// --- Backwards-compatible helpers for the read-only Gmail scope ------------
function setCachedToken(next: CachedToken | null): void {
  setScopeToken(GMAIL_SCOPE, next)
}

function currentValidToken(): string | null {
  return validScopeToken(GMAIL_SCOPE)
}

/**
 * Obtain an access token for a given scope. `interactive` controls whether
 * Google may show the consent/account-picker popup (allowed on an explicit
 * user action). Non-interactive calls attempt a silent refresh only.
 */
// De-dupe concurrent token requests per scope. Silent and interactive requests
// are tracked SEPARATELY: an interactive "Connect" must never be handed a
// pending silent attempt (which is designed to fail quietly) — that caused a
// sign-in loop. All widgets share the one interactive flow and its resulting
// token, so you authenticate once for every Gmail widget.
const silentInflight: Record<string, Promise<string> | undefined> = {}
const interactiveInflight: Record<string, Promise<string> | undefined> = {}

async function requestToken(
  scope: string,
  interactive: boolean,
  force = false,
  forceConsent = false,
): Promise<string> {
  // A valid cached token satisfies everyone, silent or interactive.
  if (!force) {
    const existing = validScopeToken(scope)
    if (existing) return existing
  }

  if (interactive) {
    if (tooManyPrompts(scope)) {
      throw new Error(
        'Google sign-in was opened several times without succeeding — something other than consent is failing. Check the browser console, and that this site is in the OAuth client\u2019s Authorized JavaScript origins.',
      )
    }
    // Coalesce concurrent interactive requests into a single popup.
    const pending = interactiveInflight[scope]
    if (pending) return pending
    notePrompt(scope)
    const p = acquireToken(scope, true, forceConsent)
    interactiveInflight[scope] = p
    // Clear on settle without creating an unhandled rejection.
    const clear = () => {
      if (interactiveInflight[scope] === p) interactiveInflight[scope] = undefined
    }
    p.then(clear, clear)
    return p
  }

  // Silent path: coalesce concurrent silent refreshes (unless forced).
  if (!force) {
    const pending = silentInflight[scope]
    if (pending) return pending
  }
  const p = acquireToken(scope, false)
  if (!force) {
    silentInflight[scope] = p
    const clear = () => {
      if (silentInflight[scope] === p) silentInflight[scope] = undefined
    }
    p.then(clear, clear)
  }
  return p
}

async function acquireToken(
  scope: string,
  interactive: boolean,
  forceConsent = false,
): Promise<string> {
  const clientId = getClientId()
  if (!clientId) throw new Error('No Google Client ID configured')

  const google = await loadGis()
  return new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope,
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          finish(() =>
            reject(interactive ? new Error(resp.error || 'Authorization failed') : new NeedsConnectError()),
          )
          return
        }
        const token = resp.access_token
        const ttl = (resp.expires_in ?? 3600) * 1000
        const expiresAt = Date.now() + ttl

        // Cache against what was GRANTED, never what was requested. Caching a
        // refused scope marks it authorized, its API then 403s, and the retry
        // is served from that same bogus cache entry without ever reaching
        // Google — a connect button that flickers "connected" and fails, for
        // as long as the user keeps pressing it.
        const asked = scope.split(' ').filter(Boolean)
        const granted = (resp.scope ?? scope).split(' ').filter(Boolean)
        for (const g of granted) setScopeToken(g, { token, expiresAt })
        for (const a of asked) {
          if (!granted.includes(a)) setScopeToken(a, null)
        }
        // The exact request key is only a valid cache entry if everything it
        // asked for came back; otherwise a repeat request must reach Google.
        if (asked.length > 1 && asked.every((a) => granted.includes(a))) {
          setScopeToken(scope, { token, expiresAt })
        }
        // A grant that landed means the user is not stuck; let them retry
        // freely later without the breaker holding a stale count.
        if (granted.length) {
          clearPromptLog(scope)
          for (const g of granted) clearPromptLog(g)
        }
        // Broadcast ONLY on an interactive sign-in so all widgets refresh once
        // after login. Silent/background refreshes must NOT broadcast, or they
        // can re-trigger loads in a loop.
        if (interactive && scope === GMAIL_SCOPE && typeof window !== 'undefined') {
          window.dispatchEvent(new Event('nexus:gmail-token'))
        }
        finish(() => resolve(token))
      },
      error_callback: (err) => {
        finish(() =>
          reject(
            interactive
              ? new Error(err?.message || err?.type || 'Authorization failed')
              : new NeedsConnectError(),
          ),
        )
      },
    })
    const timeoutMs = interactive ? 120_000 : 10_000
    setTimeout(
      () => finish(() => reject(interactive ? new Error('Authorization timed out') : new NeedsConnectError())),
      timeoutMs,
    )
    try {
      // 'consent' re-opens the checkbox screen. Without it Google replays an
      // existing partial grant with no UI, so a user retrying a refused scope
      // is never actually asked for it again.
      client.requestAccessToken({
        prompt: interactive ? (forceConsent ? 'consent' : '') : 'none',
      })
    } catch (e) {
      finish(() => reject(e instanceof Error ? e : new Error('Authorization failed')))
    }
  })
}

/** Read-only Gmail access token (inbox reading widgets). */
function getAccessToken(interactive: boolean): Promise<string> {
  return requestToken(GMAIL_SCOPE, interactive)
}

/**
 * Access token for any Google scope, using the same client id, GIS loader,
 * token cache and request de-duplication as Gmail. Other Google clients in
 * this app (see `lib/calendar.ts`) build on this rather than standing up a
 * second OAuth layer, so one sign-in serves every scope the user has granted.
 */
export function requestScopeToken(
  scope: string,
  interactive: boolean,
): Promise<string> {
  return requestToken(scope, interactive)
}

/**
 * Request ONE token covering several scopes, then cache it under each scope
 * individually. Google issues a single token for a space-separated scope
 * string, so this is one consent popup instead of one per scope — and because
 * the result is mirrored into each per-scope cache slot, code that only knows
 * about `gmail.readonly` (the widgets, the auth bar) sees itself as connected
 * straight away.
 */
export async function requestScopes(
  scopes: string[],
  interactive: boolean,
  /** Re-open Google's checkbox screen instead of replaying an existing grant. */
  forceConsent = false,
): Promise<string> {
  const unique = Array.from(new Set(scopes.filter(Boolean)))
  if (unique.length === 0) throw new Error('No scopes requested')
  if (unique.length === 1) {
    const only = await requestToken(unique[0], interactive, false, forceConsent)
    if (!hasScopeGrant(unique[0])) {
      throw new Error(
        `access was not granted for ${scopeLabel(unique[0])} — reconnect and leave the permission ticked`,
      )
    }
    announceGrant(unique, interactive)
    startKeepAlive()
    return only
  }

  // Already covered individually? Then there is nothing to ask for.
  const cached = unique.map((s) => validScopeToken(s))
  if (cached.every((t) => t !== null)) return cached[0] as string

  const combined = unique.join(' ')
  // acquireToken files the result against the granted scopes; all this needs
  // to do is check what actually landed.
  const token = await requestToken(combined, interactive, false, forceConsent)

  const missing = unique.filter((s) => !hasScopeGrant(s))
  if (missing.length) {
    throw new Error(
      `access was not granted for ${missing
        .map(scopeLabel)
        .join(' and ')} — reconnect and leave every permission ticked`,
    )
  }

  announceGrant(unique, interactive)
  startKeepAlive()
  return token
}

/** Human name for a scope, for messages a person has to act on. */
function scopeLabel(scope: string): string {
  if (scope === GMAIL_SCOPE) return 'Gmail'
  if (scope === GMAIL_SEND_SCOPE) return 'Gmail send'
  if (scope.includes('calendar')) return 'Calendar'
  return scope
}

function announceGrant(unique: string[], interactive: boolean): void {
  if (!interactive || typeof window === 'undefined') return
  {
    // The per-scope broadcast in acquireToken only fires for a bare
    // gmail.readonly request, so announce this one ourselves.
    if (unique.includes(GMAIL_SCOPE)) {
      window.dispatchEvent(new Event('nexus:gmail-token'))
    }
    // Fires for ANY scope, so indicators for non-Gmail services update too.
    window.dispatchEvent(new Event('nexus:google-token'))
  }
}

/**
 * Whether `scope` has been granted. This drives what the UI SHOWS, so it asks
 * about the grant, not about freshness: a chip that reads "Connect" while the
 * scope is in fact held invites a sign-in that changes nothing, and that is a
 * loop the user drives by hand — click, grant, still says Connect, click.
 * Staleness is handled where it belongs, in requestToken, which refreshes a
 * cached token when it is actually used.
 */
export function isScopeAuthorized(scope: string): boolean {
  return hasScopeGrant(scope)
}

/** Drop a cached token — used when the API answers 401 for that scope. */
export function clearScopeToken(scope: string): void {
  setScopeToken(scope, null)
}

export function isConnected(): boolean {
  return currentValidToken() !== null
}

/** Whether a send-capable token is already granted (one-click Evernote send). */
export function isSendAuthorized(): boolean {
  return validScopeToken(GMAIL_SEND_SCOPE) !== null
}

/** Trigger the interactive Google sign-in / consent flow. */
export async function connect(): Promise<void> {
  await getAccessToken(true)
  startKeepAlive()
}

/**
 * Keep-alive: silently refresh the read-only token shortly before it expires,
 * and whenever the tab regains focus / the network returns — so an open
 * dashboard stays connected without a reconnect click (as long as the browser
 * permits silent auth). Idempotent; safe to call repeatedly.
 */
let keepAliveStarted = false
function startKeepAlive(): void {
  if (keepAliveStarted) return
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  keepAliveStarted = true

  const tick = () => {
    if (isMockMode()) return
    const t = tokens[GMAIL_SCOPE]
    // Only refresh once the user has connected at least once.
    if (!t) return
    // Refresh well ahead of expiry (10 min) so the token is never close to
    // dying while the tab is open.
    if (t.expiresAt - Date.now() < 10 * 60_000) {
      // Force a silent refresh (bypass the still-valid cache); failures are
      // non-fatal (widgets retry / offer reconnect).
      requestToken(GMAIL_SCOPE, false, true).catch(() => {})
    }
  }

  // Check every 45s, and whenever the tab/window regains focus or the network
  // returns — the more often we top up, the less the session can lapse.
  setInterval(tick, 45_000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick()
  })
  window.addEventListener('focus', tick)
  window.addEventListener('online', tick)
  // Prime once shortly after load so an expiring persisted token is topped up.
  setTimeout(tick, 1_500)
}

// Begin keep-alive as soon as the module loads (no-op until connected).
startKeepAlive()

/** Ask for the gmail.send scope (interactive consent the first time). */
export async function authorizeSend(): Promise<void> {
  await requestToken(GMAIL_SEND_SCOPE, true)
}

export function disconnect(): void {
  const toRevoke = Object.values(tokens).map((t) => t.token)
  tokens = {}
  persistTokens()
  if (window.google?.accounts?.oauth2) {
    for (const tok of toRevoke) window.google.accounts.oauth2.revoke(tok)
  }
}

/** RFC 2822 message, base64url-encoded, sent via the Gmail API. */
function toBase64Url(str: string): string {
  // Handle UTF-8 safely before base64.
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface SendMailOptions {
  to: string
  subject: string
  body: string
  interactive?: boolean
}

/** Send a plain-text email directly through the connected Gmail account. */
export async function sendGmailMessage(opts: SendMailOptions): Promise<void> {
  const { to, subject, body, interactive = false } = opts
  const token = await requestToken(GMAIL_SEND_SCOPE, interactive)
  // Encode the subject (may contain non-ASCII) per RFC 2047.
  const encodedSubject = `=?UTF-8?B?${btoa(
    String.fromCharCode(...new TextEncoder().encode(subject)),
  )}?=`
  const mime =
    `To: ${to}\r\n` +
    `Subject: ${encodedSubject}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset=UTF-8\r\n\r\n` +
    body
  const res = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: toBase64Url(mime) }),
    },
  )
  if (res.status === 401) {
    setScopeToken(GMAIL_SEND_SCOPE, null)
    throw new Error('Gmail send session expired — reauthorize required')
  }
  if (!res.ok) {
    let detail = `Gmail send error (${res.status})`
    try {
      const err = await res.json()
      detail = err?.error?.message || detail
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }
}

// ---------------------------------------------------------------------------
// Gmail REST calls
// ---------------------------------------------------------------------------

interface MessagesListResponse {
  messages?: { id: string }[]
  nextPageToken?: string
  resultSizeEstimate?: number
}

/** Count messages matching a Gmail search query, paginating up to COUNT_CAP. */
async function countMessages(
  token: string,
  query: string,
): Promise<{ count: number; capped: boolean }> {
  let count = 0
  let pageToken: string | undefined
  do {
    const url = new URL(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages',
    )
    url.searchParams.set('q', query)
    url.searchParams.set('maxResults', String(PAGE_SIZE))
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status === 401) {
      setCachedToken(null)
      throw new Error('Gmail session expired — reconnect required')
    }
    if (!res.ok) {
      throw new Error(`Gmail API error (${res.status})`)
    }
    const data = (await res.json()) as MessagesListResponse
    count += data.messages?.length ?? 0
    pageToken = data.nextPageToken
    if (count >= COUNT_CAP) return { count: COUNT_CAP, capped: true }
  } while (pageToken)
  return { count, capped: false }
}

function lookbackQuery(lookbackHours: number): string {
  // Gmail's search supports `newer_than:Nd|Nh|Nm`. Use hours for precision.
  const hours = Math.max(1, Math.round(lookbackHours))
  return `in:inbox newer_than:${hours}h`
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

function mockStats(lookbackHours: number): InboxStats {
  // Deterministic-ish sample that scales a little with the window so the UI
  // visibly responds to config changes.
  const base = 18
  const total = Math.round(base * (lookbackHours / 24)) + 6
  const unread = Math.round(total * 0.4)
  return { total, unread, capped: false, mock: true }
}

// ---------------------------------------------------------------------------
// Public: fetch inbox stats
// ---------------------------------------------------------------------------

export interface FetchOptions {
  lookbackHours: number
  /** Allow the interactive consent popup (only on a user gesture). */
  interactive?: boolean
}

export async function fetchInboxStats(opts: FetchOptions): Promise<InboxStats> {
  const { lookbackHours, interactive = false } = opts

  if (isMockMode()) return mockStats(lookbackHours)

  const token = await getAccessToken(interactive)
  const query = lookbackQuery(lookbackHours)

  const [totalRes, unreadRes] = await Promise.all([
    countMessages(token, query),
    countMessages(token, `${query} is:unread`),
  ])

  return {
    total: totalRes.count,
    unread: unreadRes.count,
    capped: totalRes.capped || unreadRes.capped,
    mock: false,
  }
}

// ---------------------------------------------------------------------------
// Priority inbox: rank the most important recent emails
// ---------------------------------------------------------------------------

export type MailCategory =
  | 'personal'
  | 'updates'
  | 'social'
  | 'forums'
  | 'promotions'
  | 'other'

export interface EmailSummary {
  id: string
  threadId: string
  /** Display name if present, else the email address. */
  fromName: string
  fromEmail: string
  subject: string
  /** ISO timestamp. */
  date: string
  unread: boolean
  important: boolean
  starred: boolean
  category: MailCategory
  /** Computed priority score (higher = more important). */
  score: number
  /** Short human-readable reasons the score was assigned. */
  reasons: string[]
  /** Deep link to open this message in Gmail on the web (empty for mock data). */
  url: string
}

/** Web link that opens a specific message/thread in Gmail. */
export function gmailWebUrl(messageId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${messageId}`
}

/** How many recent messages we score before taking the top N. */
const SCORE_CANDIDATE_CAP = 40
/** Ceiling on the scoring pool — one metadata request each, so this is latency. */
const SCORE_CANDIDATE_MAX = 120

const TRANSACTIONAL =
  /\b(order|ordered|receipt|payment|paid|invoice|statement|refund|shipped|delivery|delivered|confirmation|confirmed|venmo|paypal|klarna|zelle|deposit|transfer|bank|billing|charged)\b/i

const JOB_ALERT =
  /\b(hiring|job|jobs|role|position|opening|opportunit)/i

function categoryFromLabels(labels: string[]): MailCategory {
  if (labels.includes('CATEGORY_PERSONAL')) return 'personal'
  if (labels.includes('CATEGORY_UPDATES')) return 'updates'
  if (labels.includes('CATEGORY_SOCIAL')) return 'social'
  if (labels.includes('CATEGORY_FORUMS')) return 'forums'
  if (labels.includes('CATEGORY_PROMOTIONS')) return 'promotions'
  return 'other'
}

function parseFrom(raw: string): { name: string; email: string } {
  // "Display Name <addr@host>" | "addr@host"
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim() }
  return { name: raw.trim(), email: raw.trim() }
}

interface ScoreInput {
  labels: string[]
  from: string
  subject: string
  hasListUnsubscribe: boolean
}

/** Transparent, tunable priority heuristic. Returns score + reasons. */
export function scoreEmail(input: ScoreInput): { score: number; reasons: string[] } {
  const { labels, from, subject, hasListUnsubscribe } = input
  const category = categoryFromLabels(labels)
  const text = `${from} ${subject}`
  let score = 0
  const reasons: string[] = []

  if (labels.includes('STARRED')) {
    score += 5
    reasons.push('Starred')
  }
  if (labels.includes('IMPORTANT')) {
    score += 4
    reasons.push('Marked important')
  }
  if (TRANSACTIONAL.test(text)) {
    score += 4
    reasons.push('Transactional')
  }
  if (category === 'personal') {
    score += 3
    reasons.push('Primary')
  } else if (category === 'updates') {
    score += 1
    reasons.push('Update')
  } else if (category === 'promotions') {
    score -= 3
    reasons.push('Promotion')
  } else if (category === 'social') {
    score -= 1
    reasons.push('Social')
  }
  if (hasListUnsubscribe && !TRANSACTIONAL.test(text)) {
    score -= 2
    reasons.push('Bulk mail')
  }
  if (JOB_ALERT.test(subject)) {
    score += 1
    reasons.push('Job alert')
  }
  if (labels.includes('UNREAD')) {
    score += 1
    reasons.push('Unread')
  }
  return { score, reasons }
}

interface GmailMessageMeta {
  id: string
  threadId: string
  labelIds?: string[]
  internalDate?: string
  payload?: { headers?: { name: string; value: string }[] }
}

async function listMessageIds(
  token: string,
  query: string,
  cap: number,
): Promise<string[]> {
  const ids: string[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages',
    )
    url.searchParams.set('q', query)
    url.searchParams.set('maxResults', String(Math.min(PAGE_SIZE, cap)))
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status === 401) {
      setCachedToken(null)
      throw new Error('Gmail session expired — reconnect required')
    }
    if (!res.ok) throw new Error(`Gmail API error (${res.status})`)
    const data = (await res.json()) as MessagesListResponse
    for (const m of data.messages ?? []) ids.push(m.id)
    pageToken = data.nextPageToken
  } while (pageToken && ids.length < cap)
  return ids.slice(0, cap)
}

/**
 * Gmail enforces a per-user rate limit (250 quota units/second), and one
 * metadata read is 5 units. Firing a whole candidate pool at once trips it and
 * comes back 429 — so requests go out a few at a time, and a 429 or a 5xx is
 * retried with exponential backoff plus jitter rather than surfaced.
 *
 * Retry-After is honoured when Google sends it; the jitter matters because a
 * batch that all backs off on the same schedule just collides again.
 */
const REQUEST_CONCURRENCY = 5
const MAX_RETRIES = 4

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchRetrying(
  url: string,
  init: RequestInit,
): Promise<Response> {
  let wait = 400
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init)
    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600)
    if (!retryable || attempt >= MAX_RETRIES) return res

    const header = Number(res.headers.get('retry-after'))
    const delay = Number.isFinite(header) && header > 0
      ? header * 1000
      : wait + Math.random() * wait
    await sleep(delay)
    wait *= 2
  }
}

/** Run `fn` over `items` a few at a time, preserving input order. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i])
      }
    },
  )
  await Promise.all(workers)
  return out
}

async function getMessageMeta(
  token: string,
  id: string,
): Promise<GmailMessageMeta> {
  const url = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`,
  )
  url.searchParams.set('format', 'metadata')
  for (const h of ['From', 'Subject', 'Date', 'List-Unsubscribe']) {
    url.searchParams.append('metadataHeaders', h)
  }
  const res = await fetchRetrying(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 401) {
    setCachedToken(null)
    throw new Error('Gmail session expired — reconnect required')
  }
  if (res.status === 429) {
    throw new Error(
      'Gmail is rate-limiting this account — try a shorter window, or wait a minute and sync again',
    )
  }
  if (!res.ok) throw new Error(`Gmail API error (${res.status})`)
  return (await res.json()) as GmailMessageMeta
}

function headerValue(meta: GmailMessageMeta, name: string): string {
  const h = meta.payload?.headers?.find(
    (x) => x.name.toLowerCase() === name.toLowerCase(),
  )
  return h?.value ?? ''
}

function metaToSummary(meta: GmailMessageMeta): EmailSummary {
  const labels = meta.labelIds ?? []
  const fromRaw = headerValue(meta, 'From')
  const subject = headerValue(meta, 'Subject') || '(no subject)'
  const { name, email } = parseFrom(fromRaw)
  const hasListUnsubscribe = headerValue(meta, 'List-Unsubscribe') !== ''
  const { score, reasons } = scoreEmail({
    labels,
    from: fromRaw,
    subject,
    hasListUnsubscribe,
  })
  const date = meta.internalDate
    ? new Date(Number(meta.internalDate)).toISOString()
    : new Date(headerValue(meta, 'Date') || 0).toISOString()
  return {
    id: meta.id,
    threadId: meta.threadId,
    fromName: name,
    fromEmail: email,
    subject,
    date,
    unread: labels.includes('UNREAD'),
    important: labels.includes('IMPORTANT'),
    starred: labels.includes('STARRED'),
    category: categoryFromLabels(labels),
    score,
    reasons,
    url: gmailWebUrl(meta.id),
  }
}

export interface TopEmailsOptions {
  lookbackHours: number
  limit: number
  /** Extra Gmail search criteria ANDed with the inbox+time window. */
  search?: string
  interactive?: boolean
  /**
   * How many recent messages to score before taking the top `limit`. Each
   * candidate costs one metadata request, so this trades latency for coverage:
   * a long lookback needs a wider pool or it ranks only the newest slice of it.
   * Defaults to SCORE_CANDIDATE_CAP; hard-capped at SCORE_CANDIDATE_MAX.
   */
  candidates?: number
}

export interface TopEmailsResult {
  emails: EmailSummary[]
  mock: boolean
}

export async function fetchTopEmails(
  opts: TopEmailsOptions,
): Promise<TopEmailsResult> {
  const { lookbackHours, limit, search, interactive = false } = opts

  if (isMockMode()) {
    return { emails: mockTopEmails().slice(0, limit), mock: true }
  }

  const token = await getAccessToken(interactive)
  const extra = search?.trim() ? ` ${search.trim()}` : ''
  const query = `${lookbackQuery(lookbackHours)}${extra}`
  const pool = Math.min(
    Math.max(opts.candidates ?? SCORE_CANDIDATE_CAP, limit),
    SCORE_CANDIDATE_MAX,
  )
  const ids = await listMessageIds(token, query, pool)
  const metas = await mapLimited(ids, REQUEST_CONCURRENCY, (id) =>
    getMessageMeta(token, id),
  )
  const emails = metas
    .map(metaToSummary)
    .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date))
    .slice(0, limit)
  return { emails, mock: false }
}

// ---------------------------------------------------------------------------
// Threads: the conversation behind an item
// ---------------------------------------------------------------------------

export interface ThreadMessage {
  id: string
  fromName: string
  fromEmail: string
  to: string
  subject: string
  /** ISO timestamp. */
  date: string
  /** Gmail's own one-line preview of the body. */
  snippet: string
  unread: boolean
  /** True when the message was sent by the account owner. */
  outbound: boolean
  url: string
}

export interface ThreadTimeline {
  threadId: string
  subject: string
  messages: ThreadMessage[]
  /** Participants in first-seen order, for the hierarchy header. */
  participants: string[]
  mock: boolean
}

/**
 * Accept whatever the user has to hand: a raw Gmail id, or a Gmail web URL
 * copied from the address bar. Both carry the id as the last hex-ish segment.
 */
export function parseGmailId(input: string): string {
  const raw = input.trim()
  if (!raw) return ''
  const tail = /^https?:\/\//i.test(raw)
    ? (raw.split(/[#/?]/).filter(Boolean).pop() ?? '')
    : raw.replace(/^#/, '')
  // Two id shapes reach this: the API's 16-hex message/thread id, and the
  // opaque mixed-case id the Gmail web UI puts in its URL (FMfcgz…). Accept
  // both shapes here — only the API can say whether an id actually resolves,
  // and rejecting on shape would turn "paste the link from my browser" into a
  // dead end with no explanation.
  return /^[A-Za-z0-9_-]{8,}$/.test(tail) ? tail : ''
}

interface RawThread {
  id: string
  messages?: (GmailMessageMeta & { snippet?: string })[]
}

/**
 * The thread a message belongs to, oldest first.
 *
 * `id` may be a message id or a thread id — Gmail does not tell them apart by
 * shape, so try the thread endpoint first and fall back to resolving the
 * message to its threadId. That keeps "paste the id from the Gmail URL"
 * working, which is the only id a user can actually get hold of.
 */
export async function fetchThread(
  id: string,
  interactive = false,
): Promise<ThreadTimeline> {
  const clean = parseGmailId(id)
  if (!clean) throw new Error('Not a Gmail message id or link')
  if (isMockMode()) return mockThread(clean)

  const token = await getAccessToken(interactive)

  let raw: RawThread | null = await getThread(token, clean)
  if (!raw) {
    // Not a thread id — try it as a message id and follow it to its thread.
    const meta = await getMessageMeta(token, clean).catch(() => null)
    if (meta?.threadId) raw = await getThread(token, meta.threadId)
  }
  if (!raw) {
    // The id the Gmail web UI shows in its address bar is a different
    // encoding from the API's, and there is no way to convert one to the
    // other — so say that, rather than "not found".
    if (!/^[0-9a-f]{8,}$/i.test(clean)) {
      throw new Error(
        'that looks like an id from the Gmail web address bar, which the API cannot resolve — attach the message from the Live inbox instead',
      )
    }
    throw new Error('No thread found for that id')
  }

  const me = (await getProfileEmail(token)).toLowerCase()
  const messages: ThreadMessage[] = (raw.messages ?? []).map((m) => {
    const fromRaw = headerValue(m, 'From')
    const { name, email } = parseFrom(fromRaw)
    return {
      id: m.id,
      fromName: name,
      fromEmail: email,
      to: headerValue(m, 'To'),
      subject: headerValue(m, 'Subject'),
      date: m.internalDate
        ? new Date(Number(m.internalDate)).toISOString()
        : new Date(headerValue(m, 'Date') || 0).toISOString(),
      snippet: m.snippet ?? '',
      unread: (m.labelIds ?? []).includes('UNREAD'),
      outbound: email.toLowerCase() === me,
      url: gmailWebUrl(m.id),
    }
  })
  messages.sort((a, b) => a.date.localeCompare(b.date))

  const participants: string[] = []
  for (const m of messages) {
    const who = m.fromName || m.fromEmail
    if (who && !participants.includes(who)) participants.push(who)
  }

  return {
    threadId: raw.id,
    subject: messages[0]?.subject || '(no subject)',
    messages,
    participants,
    mock: false,
  }
}

/** Returns null on 404 so the caller can try the other id interpretation. */
async function getThread(
  token: string,
  id: string,
): Promise<RawThread | null> {
  const url = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(id)}`,
  )
  url.searchParams.set('format', 'metadata')
  for (const h of ['From', 'To', 'Subject', 'Date']) {
    url.searchParams.append('metadataHeaders', h)
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 404 || res.status === 400) return null
  if (res.status === 401) {
    setCachedToken(null)
    throw new Error('Gmail session expired — reconnect required')
  }
  if (!res.ok) throw new Error(`Gmail API error (${res.status})`)
  return (await res.json()) as RawThread
}

let cachedProfileEmail: string | null = null
async function getProfileEmail(token: string): Promise<string> {
  if (cachedProfileEmail !== null) return cachedProfileEmail
  try {
    const res = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) return (cachedProfileEmail = '')
    const data = (await res.json()) as { emailAddress?: string }
    return (cachedProfileEmail = data.emailAddress ?? '')
  } catch {
    // Only used to mark messages as outbound; failing is cosmetic.
    return (cachedProfileEmail = '')
  }
}

function mockThread(id: string): ThreadTimeline {
  const base = Date.now() - 6 * 86400000
  const step = 36 * 3600000
  const cast = [
    { who: 'Sample Counsel', out: false, snippet: 'Attaching the filing for your review — let me know before Friday.' },
    { who: 'You', out: true, snippet: 'Thanks — reviewing today, one question on section 4.' },
    { who: 'Sample Counsel', out: false, snippet: 'Section 4 is the buy-back window. Confirming the deadline stands.' },
  ]
  return {
    threadId: id,
    subject: 'Sample: thread timeline',
    participants: ['Sample Counsel', 'You'],
    mock: true,
    messages: cast.map((c, i) => ({
      id: `${id}-${i}`,
      fromName: c.who,
      fromEmail: c.out ? 'you@example.com' : 'counsel@example.com',
      to: c.out ? 'counsel@example.com' : 'you@example.com',
      subject: 'Sample: thread timeline',
      date: new Date(base + i * step).toISOString(),
      snippet: c.snippet,
      unread: false,
      outbound: c.out,
      url: '',
    })),
  }
}

// ---------------------------------------------------------------------------
// Landing auto-connect
// ---------------------------------------------------------------------------

/**
 * Attempt a silent connect on page load. Returns true if a token is available
 * (already valid or silently obtained), false if interactive login is needed.
 */
export async function ensureConnected(): Promise<boolean> {
  if (isMockMode()) return false
  if (isConnected()) return true
  try {
    await getAccessToken(false)
    startKeepAlive()
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Counts (total / unread / read)
// ---------------------------------------------------------------------------

async function countEstimate(token: string, query: string): Promise<number> {
  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
  url.searchParams.set('q', query)
  url.searchParams.set('maxResults', '1')
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 401) {
    setCachedToken(null)
    throw new Error('Gmail session expired — reconnect required')
  }
  if (!res.ok) throw new Error(`Gmail API error (${res.status})`)
  const data = (await res.json()) as MessagesListResponse
  return data.resultSizeEstimate ?? 0
}

export interface InboxCounts {
  total: number
  unread: number
  read: number
  mock: boolean
}

export interface CountsOptions {
  lookbackHours: number
  search?: string
  interactive?: boolean
}

export async function fetchInboxCounts(opts: CountsOptions): Promise<InboxCounts> {
  const { lookbackHours, search, interactive = false } = opts
  if (isMockMode()) {
    const m = mockTopEmails()
    const unread = m.filter((e) => e.unread).length
    return { total: m.length, unread, read: m.length - unread, mock: true }
  }
  const token = await getAccessToken(interactive)
  const base = `${lookbackQuery(lookbackHours)}${
    search?.trim() ? ` ${search.trim()}` : ''
  }`
  const [total, unread] = await Promise.all([
    countEstimate(token, base),
    countEstimate(token, `${base} is:unread`),
  ])
  return { total, unread, read: Math.max(0, total - unread), mock: false }
}

// ---------------------------------------------------------------------------
// Paged + filtered email fetch (for infinite scroll)
// ---------------------------------------------------------------------------

export type MailFilter = 'all' | 'unread' | 'read'

function filterFragment(f: MailFilter): string {
  return f === 'unread' ? ' is:unread' : f === 'read' ? ' is:read' : ''
}

async function listPage(
  token: string,
  query: string,
  pageToken: string | undefined,
  pageSize: number,
): Promise<{ ids: string[]; nextPageToken?: string }> {
  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
  url.searchParams.set('q', query)
  url.searchParams.set('maxResults', String(pageSize))
  if (pageToken) url.searchParams.set('pageToken', pageToken)
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 401) {
    setCachedToken(null)
    throw new Error('Gmail session expired — reconnect required')
  }
  if (!res.ok) throw new Error(`Gmail API error (${res.status})`)
  const data = (await res.json()) as MessagesListResponse
  return {
    ids: (data.messages ?? []).map((m) => m.id),
    nextPageToken: data.nextPageToken,
  }
}

export interface EmailPageOptions {
  lookbackHours: number
  search?: string
  filter: MailFilter
  pageToken?: string
  pageSize?: number
  interactive?: boolean
}

export interface EmailPageResult {
  emails: EmailSummary[]
  nextPageToken?: string
  mock: boolean
}

export async function fetchEmailPage(
  opts: EmailPageOptions,
): Promise<EmailPageResult> {
  const {
    lookbackHours,
    search,
    filter,
    pageToken,
    pageSize = 15,
    interactive = false,
  } = opts
  if (isMockMode()) {
    let emails = mockTopEmails()
    if (filter === 'unread') emails = emails.filter((e) => e.unread)
    else if (filter === 'read') emails = emails.filter((e) => !e.unread)
    return { emails, nextPageToken: undefined, mock: true }
  }
  const token = await getAccessToken(interactive)
  const q = `${lookbackQuery(lookbackHours)}${
    search?.trim() ? ` ${search.trim()}` : ''
  }${filterFragment(filter)}`
  const { ids, nextPageToken } = await listPage(token, q, pageToken, pageSize)
  const metas = await mapLimited(ids, REQUEST_CONCURRENCY, (id) =>
    getMessageMeta(token, id),
  )
  const emails = metas.map(metaToSummary)
  return { emails, nextPageToken, mock: false }
}

// Generic, fictional sample data (no real account content).
function mockTopEmails(): EmailSummary[] {
  const now = Date.now()
  const mins = (m: number) => new Date(now - m * 60_000).toISOString()
  const mk = (
    p: Partial<EmailSummary> & Pick<EmailSummary, 'fromName' | 'subject'>,
    labels: string[],
    from: string,
    listUnsub: boolean,
  ): EmailSummary => {
    const { score, reasons } = scoreEmail({
      labels,
      from,
      subject: p.subject,
      hasListUnsubscribe: listUnsub,
    })
    return {
      id: p.id ?? p.subject,
      threadId: p.id ?? p.subject,
      fromEmail: p.fromEmail ?? from,
      date: p.date ?? mins(30),
      unread: labels.includes('UNREAD'),
      important: labels.includes('IMPORTANT'),
      starred: labels.includes('STARRED'),
      category: categoryFromLabels(labels),
      score,
      reasons,
      fromName: p.fromName,
      subject: p.subject,
      url: p.url ?? '',
    }
  }
  return [
    mk(
      { fromName: 'PayPal', subject: 'Your payment of $84.20 was sent', date: mins(22) },
      ['UNREAD', 'IMPORTANT', 'CATEGORY_UPDATES'],
      'service@paypal.com',
      false,
    ),
    mk(
      { fromName: 'Sam Rivera', subject: 'Re: lunch Thursday?', date: mins(48) },
      ['UNREAD', 'IMPORTANT', 'CATEGORY_PERSONAL'],
      'sam.rivera@example.com',
      false,
    ),
    mk(
      { fromName: 'Amazon', subject: 'Ordered: 1 item — arriving Friday', date: mins(70) },
      ['CATEGORY_UPDATES'],
      'auto-confirm@amazon.com',
      false,
    ),
    mk(
      { fromName: 'GitHub', subject: '[acme/app] CI passed on main', date: mins(95) },
      ['UNREAD', 'CATEGORY_UPDATES'],
      'notifications@github.com',
      true,
    ),
    mk(
      { fromName: 'Dr. Lee Office', subject: 'Appointment reminder: Tue 9:00 AM', date: mins(130) },
      ['UNREAD', 'IMPORTANT', 'CATEGORY_PERSONAL'],
      'reminders@clinic.example',
      false,
    ),
    mk(
      { fromName: 'The Daily Brief', subject: "Today's top stories", date: mins(160) },
      ['UNREAD', 'CATEGORY_UPDATES'],
      'news@dailybrief.example',
      true,
    ),
    mk(
      { fromName: 'LinkedIn', subject: 'Senior Analyst roles in your area', date: mins(190) },
      ['UNREAD', 'CATEGORY_UPDATES'],
      'jobalerts-noreply@linkedin.com',
      true,
    ),
    mk(
      { fromName: 'Chase', subject: 'Your July statement is ready', date: mins(230) },
      ['CATEGORY_UPDATES'],
      'no.reply@chase.com',
      true,
    ),
    mk(
      { fromName: 'Nike', subject: '🔥 30% off ends tonight', date: mins(260) },
      ['UNREAD', 'CATEGORY_PROMOTIONS'],
      'nike@notifications.nike.com',
      true,
    ),
    mk(
      { fromName: 'Temu', subject: 'Your $100 coupon is waiting', date: mins(300) },
      ['UNREAD', 'CATEGORY_PROMOTIONS'],
      'email@news.temuemail.com',
      true,
    ),
  ].sort((a, b) => b.score - a.score || b.date.localeCompare(a.date))
}
