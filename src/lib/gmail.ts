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
  // A changed client id invalidates any cached token.
  cachedToken = null
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
let cachedToken: CachedToken | null = null

function currentValidToken(): string | null {
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) {
    return cachedToken.token
  }
  return null
}

/**
 * Obtain a Gmail access token. `interactive` controls whether Google may show
 * the consent/account-picker popup (allowed on an explicit user action such as
 * clicking "Connect"). Non-interactive calls attempt a silent refresh only.
 */
async function getAccessToken(interactive: boolean): Promise<string> {
  const existing = currentValidToken()
  if (existing) return existing

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
      scope: GMAIL_SCOPE,
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          // A silent attempt without prior consent reports an error here or via
          // error_callback — treat it as "needs interactive connect".
          finish(() =>
            reject(interactive ? new Error(resp.error || 'Authorization failed') : new NeedsConnectError()),
          )
          return
        }
        const token = resp.access_token
        const ttl = (resp.expires_in ?? 3600) * 1000
        cachedToken = { token, expiresAt: Date.now() + ttl }
        finish(() => resolve(token))
      },
      // Fired when the popup can't open, consent is required for prompt:'none',
      // or the user dismisses the flow. Without this the promise would hang.
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
    // Backstop: a silent request that never calls back must not hang the tile.
    const timeoutMs = interactive ? 120_000 : 10_000
    setTimeout(
      () => finish(() => reject(interactive ? new Error('Authorization timed out') : new NeedsConnectError())),
      timeoutMs,
    )
    try {
      // '' asks for a silent grant; 'none' never prompts (used for background refresh).
      client.requestAccessToken({ prompt: interactive ? '' : 'none' })
    } catch (e) {
      finish(() => reject(e instanceof Error ? e : new Error('Authorization failed')))
    }
  })
}

export function isConnected(): boolean {
  return currentValidToken() !== null
}

/** Trigger the interactive Google sign-in / consent flow. */
export async function connect(): Promise<void> {
  await getAccessToken(true)
}

export function disconnect(): void {
  const token = cachedToken?.token
  cachedToken = null
  if (token && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(token)
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
      cachedToken = null
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
}

/** How many recent messages we score before taking the top N. */
const SCORE_CANDIDATE_CAP = 40

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
      cachedToken = null
      throw new Error('Gmail session expired — reconnect required')
    }
    if (!res.ok) throw new Error(`Gmail API error (${res.status})`)
    const data = (await res.json()) as MessagesListResponse
    for (const m of data.messages ?? []) ids.push(m.id)
    pageToken = data.nextPageToken
  } while (pageToken && ids.length < cap)
  return ids.slice(0, cap)
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
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 401) {
    cachedToken = null
    throw new Error('Gmail session expired — reconnect required')
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
  }
}

export interface TopEmailsOptions {
  lookbackHours: number
  limit: number
  interactive?: boolean
}

export interface TopEmailsResult {
  emails: EmailSummary[]
  mock: boolean
}

export async function fetchTopEmails(
  opts: TopEmailsOptions,
): Promise<TopEmailsResult> {
  const { lookbackHours, limit, interactive = false } = opts

  if (isMockMode()) {
    return { emails: mockTopEmails().slice(0, limit), mock: true }
  }

  const token = await getAccessToken(interactive)
  const query = lookbackQuery(lookbackHours)
  const ids = await listMessageIds(token, query, SCORE_CANDIDATE_CAP)
  const metas = await Promise.all(ids.map((id) => getMessageMeta(token, id)))
  const emails = metas
    .map(metaToSummary)
    .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date))
    .slice(0, limit)
  return { emails, mock: false }
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
