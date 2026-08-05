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
      }) => TokenClient
      revoke: (token: string, done?: () => void) => void
    }
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
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GMAIL_SCOPE,
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          reject(new Error(resp.error || 'Authorization was cancelled'))
          return
        }
        const ttl = (resp.expires_in ?? 3600) * 1000
        cachedToken = { token: resp.access_token, expiresAt: Date.now() + ttl }
        resolve(resp.access_token)
      },
    })
    // '' asks for a silent grant; 'consent' forces the picker/consent screen.
    client.requestAccessToken({ prompt: interactive ? '' : 'none' })
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
