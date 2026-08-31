/**
 * The API the Weekly Briefing page calls to reach Google.
 *
 * The briefing is a static page in a same-origin iframe. Rather than teach it
 * OAuth — a second sign-in, a second token cache, a second thing to keep
 * working — it calls up into this object on the parent window, which is a thin
 * front for the app's existing Gmail client and the Calendar client built on
 * the same token layer. One consent, one session, shared with every widget.
 *
 * Everything here returns plain data, and every method resolves rather than
 * throwing across the frame boundary: `error` on the result is the failure
 * channel, so a rejected promise can never surface as an unhandled error
 * inside a page that has no error handling of its own.
 *
 * `public/briefing/bridge.js` is the consumer. Treat this as a published
 * contract: bump `version` if its shape changes.
 */

import {
  GMAIL_READONLY_SCOPE,
  fetchThread,
  fetchTopEmails,
  isMockMode,
  isScopeAuthorized,
  parseGmailId,
  requestScopes,
} from './gmail'
import { CALENDAR_SCOPE, fetchUpcomingEvents } from './calendar'

export interface BridgeStatus {
  /** No Google Client ID configured — everything below is sample data. */
  mock: boolean
  gmail: boolean
  calendar: boolean
}

export interface BridgeMailItem {
  id: string
  subject: string
  from: string
  date: string
  unread: boolean
  score: number
  reasons: string[]
  url: string
  category: string
}

export interface BridgeThreadMessage {
  id: string
  from: string
  to: string
  date: string
  snippet: string
  unread: boolean
  outbound: boolean
  url: string
}

export interface BridgeThread {
  threadId: string
  subject: string
  participants: string[]
  messages: BridgeThreadMessage[]
  mock: boolean
  error?: string
}

export interface BridgeEventItem {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  location: string
  url: string
  calendar: string
}

interface BridgeResult<T> {
  items: T[]
  mock: boolean
  /** Human-readable failure; `items` is empty when set. */
  error?: string
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

/**
 * Which Google service to request. Google's consent screen lets a user grant
 * one scope and refuse the other, so partial grants are a real state and each
 * service has to be connectable on its own.
 */
export type BridgeService = 'all' | 'gmail' | 'calendar'

export interface BriefingBridge {
  version: number
  status(): BridgeStatus
  connect(which?: BridgeService): Promise<BridgeStatus & { error?: string }>
  fetchMail(opts: {
    lookbackHours?: number
    limit?: number
    /** Scoring pool size; a long lookback needs a wider one. */
    candidates?: number
  }): Promise<BridgeResult<BridgeMailItem>>
  fetchEvents(opts: {
    days?: number
    limit?: number
  }): Promise<BridgeResult<BridgeEventItem>>
  /** The conversation behind a punch-list item, oldest message first. */
  fetchThread(id: string): Promise<BridgeThread>
  /** Normalize a pasted Gmail id or URL; '' when it is neither. */
  parseId(input: string): string
}

function status(): BridgeStatus {
  const mock = isMockMode()
  return {
    mock,
    // In sample-data mode there is nothing to authorize, and the page should
    // show its sample panels rather than a Connect button that cannot work.
    gmail: mock || isScopeAuthorized(GMAIL_READONLY_SCOPE),
    calendar: mock || isScopeAuthorized(CALENDAR_SCOPE),
  }
}

const bridge: BriefingBridge = {
  version: 1,

  status,

  async connect(which: BridgeService = 'all') {
    if (isMockMode()) return status()
    const scopes =
      which === 'gmail'
        ? [GMAIL_READONLY_SCOPE]
        : which === 'calendar'
          ? [CALENDAR_SCOPE]
          : [GMAIL_READONLY_SCOPE, CALENDAR_SCOPE]
    try {
      // One popup for the scopes asked for. Called from a click inside the
      // iframe, whose user activation propagates to this same-origin parent.
      await requestScopes(scopes, true)
      return status()
    } catch (err) {
      return { ...status(), error: message(err, 'Google sign-in failed') }
    }
  },

  parseId(input: string) {
    return parseGmailId(input)
  },

  async fetchThread(id: string) {
    const empty = {
      threadId: '',
      subject: '',
      participants: [] as string[],
      messages: [] as BridgeThreadMessage[],
      mock: false,
    }
    try {
      const t = await fetchThread(id)
      return {
        threadId: t.threadId,
        subject: t.subject,
        participants: t.participants,
        mock: t.mock,
        messages: t.messages.map((m) => ({
          id: m.id,
          from: m.fromName || m.fromEmail,
          to: m.to,
          date: m.date,
          snippet: m.snippet,
          unread: m.unread,
          outbound: m.outbound,
          url: m.url,
        })),
      }
    } catch (err) {
      return { ...empty, error: message(err, 'Could not load that thread') }
    }
  },

  async fetchMail({ lookbackHours = 72, limit = 12, candidates }) {
    try {
      const res = await fetchTopEmails({ lookbackHours, limit, candidates })
      return {
        mock: res.mock,
        items: res.emails.map((e) => ({
          id: e.id,
          subject: e.subject,
          from: e.fromName || e.fromEmail,
          date: e.date,
          unread: e.unread,
          score: e.score,
          reasons: e.reasons,
          url: e.url,
          category: e.category,
        })),
      }
    } catch (err) {
      return { items: [], mock: false, error: message(err, 'Gmail fetch failed') }
    }
  },

  async fetchEvents({ days = 14, limit = 40 }) {
    try {
      const res = await fetchUpcomingEvents({ days, limit })
      return {
        mock: res.mock,
        items: res.events.map((e) => ({
          id: e.id,
          title: e.title,
          start: e.start,
          end: e.end,
          allDay: e.allDay,
          location: e.location,
          url: e.url,
          calendar: e.calendar,
        })),
      }
    } catch (err) {
      return {
        items: [],
        mock: false,
        error: message(err, 'Calendar fetch failed'),
      }
    }
  },
}

declare global {
  interface Window {
    __nexusBriefing?: BriefingBridge
  }
}

/**
 * Publish the bridge on the parent window. Must run before the iframe loads,
 * which is why the briefing component installs it during module evaluation
 * rather than in an effect.
 */
export function installBriefingBridge(): void {
  if (typeof window === 'undefined') return
  window.__nexusBriefing = bridge
}
