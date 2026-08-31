/**
 * Google Calendar access, built on the Gmail module's OAuth layer.
 *
 * There is no second sign-in here: `requestScopeToken` reuses the same client
 * id, GIS loader and token cache, so granting Calendar adds a scope to the
 * session the user already has rather than starting a new one. Same two modes
 * as Gmail — MOCK until a Google OAuth Client ID is configured, LIVE after.
 */

import {
  isMockMode,
  requestScopeToken,
  isScopeAuthorized,
  clearScopeToken,
} from './gmail'

export const CALENDAR_SCOPE =
  'https://www.googleapis.com/auth/calendar.readonly'

/** How many events we page through before stopping. */
const EVENT_CAP = 250
const PAGE_SIZE = 250

export interface CalendarEvent {
  id: string
  /** Event summary; Google omits it for untitled events. */
  title: string
  /** ISO timestamp of the start (midnight local for all-day events). */
  start: string
  /** ISO timestamp of the end. */
  end: string
  allDay: boolean
  location: string
  /** The API's own event link — constructed eids do not reliably work. */
  url: string
  /** Display name of the calendar the event came from. */
  calendar: string
}

export interface EventsResult {
  events: CalendarEvent[]
  /** True when these are sample events, not from a real account. */
  mock: boolean
}

/** Whether Calendar access has already been granted this session. */
export function isCalendarAuthorized(): boolean {
  return isScopeAuthorized(CALENDAR_SCOPE)
}

// ---------------------------------------------------------------------------
// REST calls
// ---------------------------------------------------------------------------

interface RawCalendarListEntry {
  id: string
  summary?: string
  summaryOverride?: string
  selected?: boolean
  primary?: boolean
}

interface RawEvent {
  id: string
  status?: string
  summary?: string
  location?: string
  htmlLink?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
}

async function calendarFetch<T>(token: string, url: URL): Promise<T> {
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 401) {
    clearScopeToken(CALENDAR_SCOPE)
    throw new Error('Calendar session expired — reconnect required')
  }
  if (!res.ok) throw new Error(`Calendar API error (${res.status})`)
  return (await res.json()) as T
}

/** The calendars the user actually has switched on in the Calendar UI. */
async function listCalendars(token: string): Promise<RawCalendarListEntry[]> {
  const url = new URL(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList',
  )
  url.searchParams.set('minAccessRole', 'reader')
  const data = await calendarFetch<{ items?: RawCalendarListEntry[] }>(
    token,
    url,
  )
  const items = data.items ?? []
  // `selected` is absent on some entries; treat only an explicit false as off.
  return items.filter((c) => c.selected !== false)
}

function toEvent(raw: RawEvent, calendarName: string): CalendarEvent | null {
  const startRaw = raw.start?.dateTime ?? raw.start?.date
  const endRaw = raw.end?.dateTime ?? raw.end?.date
  if (!startRaw) return null
  const allDay = !raw.start?.dateTime
  const start = new Date(startRaw)
  const end = endRaw ? new Date(endRaw) : start
  if (Number.isNaN(start.getTime())) return null
  return {
    id: raw.id,
    title: raw.summary?.trim() || '(no title)',
    start: start.toISOString(),
    end: (Number.isNaN(end.getTime()) ? start : end).toISOString(),
    allDay,
    location: raw.location?.trim() ?? '',
    url: raw.htmlLink ?? '',
    calendar: calendarName,
  }
}

async function listEvents(
  token: string,
  calendarId: string,
  calendarName: string,
  timeMin: string,
  timeMax: string,
): Promise<CalendarEvent[]> {
  const out: CalendarEvent[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
        calendarId,
      )}/events`,
    )
    url.searchParams.set('timeMin', timeMin)
    url.searchParams.set('timeMax', timeMax)
    // Expand recurring events into individual instances so each has a real
    // start time to sort and display.
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('orderBy', 'startTime')
    url.searchParams.set('maxResults', String(PAGE_SIZE))
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const data = await calendarFetch<{
      items?: RawEvent[]
      nextPageToken?: string
    }>(token, url)
    for (const raw of data.items ?? []) {
      if (raw.status === 'cancelled') continue
      const ev = toEvent(raw, calendarName)
      if (ev) out.push(ev)
    }
    pageToken = data.nextPageToken
  } while (pageToken && out.length < EVENT_CAP)
  return out.slice(0, EVENT_CAP)
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

function mockEvents(days: number): CalendarEvent[] {
  const seeds: { title: string; inDays: number; hour: number; mins: number; location: string }[] = [
    { title: 'Sample: school pickup', inDays: 0, hour: 15, mins: 30, location: '' },
    { title: 'Sample: dentist', inDays: 1, hour: 9, mins: 60, location: '1 Main St' },
    { title: 'Sample: project sync', inDays: 2, hour: 11, mins: 45, location: '' },
    { title: 'Sample: HOA meeting', inDays: 4, hour: 18, mins: 90, location: 'Clubhouse' },
    { title: 'Sample: flight to ATL', inDays: 6, hour: 7, mins: 150, location: 'ATL' },
    { title: 'Sample: quarterly review', inDays: 9, hour: 13, mins: 60, location: '' },
  ]
  const now = new Date()
  return seeds
    .filter((s) => s.inDays <= days)
    .map((s, i) => {
      const start = new Date(now)
      start.setDate(start.getDate() + s.inDays)
      start.setHours(s.hour, 0, 0, 0)
      const end = new Date(start.getTime() + s.mins * 60_000)
      return {
        id: `mock-${i}`,
        title: s.title,
        start: start.toISOString(),
        end: end.toISOString(),
        allDay: false,
        location: s.location,
        url: '',
        calendar: 'Sample calendar',
      }
    })
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export interface UpcomingOptions {
  /** How far ahead to look. */
  days: number
  /** Allow the interactive consent popup (only on a user gesture). */
  interactive?: boolean
  /** Cap the number of events returned, after sorting by start time. */
  limit?: number
}

/**
 * Events starting between now and `days` from now, merged across every
 * calendar the user has switched on, sorted by start time.
 */
export async function fetchUpcomingEvents(
  opts: UpcomingOptions,
): Promise<EventsResult> {
  const { days, interactive = false, limit } = opts

  if (isMockMode()) {
    const events = mockEvents(days)
    return { events: limit ? events.slice(0, limit) : events, mock: true }
  }

  const token = await requestScopeToken(CALENDAR_SCOPE, interactive)
  const now = new Date()
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
  const calendars = await listCalendars(token)

  const perCalendar = await Promise.all(
    calendars.map((c) =>
      listEvents(
        token,
        c.id,
        c.summaryOverride || c.summary || c.id,
        now.toISOString(),
        until.toISOString(),
      ).catch(() => [] as CalendarEvent[]),
    ),
  )

  const events = perCalendar
    .flat()
    .sort((a, b) => a.start.localeCompare(b.start))

  return { events: limit ? events.slice(0, limit) : events, mock: false }
}
