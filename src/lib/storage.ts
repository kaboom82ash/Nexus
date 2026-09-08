import {
  DashboardState,
  DashboardTab,
  TileExport,
  WidgetInstance,
  HOME_TAB_ID,
  TILES_PER_PAGE,
} from './types'
import { makeId } from './id'

const STORAGE_KEY = 'nexus.dashboard.v1'

export function emptyTiles(): (null)[] {
  return Array.from({ length: TILES_PER_PAGE }, () => null)
}

export function makeTab(name: string): DashboardTab {
  return { id: makeId('tab'), name, tiles: emptyTiles() }
}

export function defaultState(): DashboardState {
  const first = makeTab('Dashboard 1')
  return { tabs: [first], activeTabId: HOME_TAB_ID, homeSeen: true }
}

/**
 * Resolve a stored active view: the homepage, one of `tabs`, or — when the
 * stored id is gone — the homepage again.
 */
function resolveActive(tabs: DashboardTab[], activeTabId: string): string {
  if (activeTabId === HOME_TAB_ID) return HOME_TAB_ID
  return tabs.some((t) => t.id === activeTabId) ? activeTabId : HOME_TAB_ID
}

/** Normalize a loaded tab so its tile array is always exactly TILES_PER_PAGE long. */
function normalizeTab(tab: DashboardTab): DashboardTab {
  const tiles = Array.isArray(tab.tiles) ? tab.tiles.slice(0, TILES_PER_PAGE) : []
  while (tiles.length < TILES_PER_PAGE) tiles.push(null)
  return { ...tab, tiles }
}

export function loadState(): DashboardState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultState()
    const parsed = JSON.parse(raw) as DashboardState
    if (!parsed?.tabs?.length) return defaultState()
    const tabs = parsed.tabs.map(normalizeTab)
    // Dashboards saved before the homepage existed open on it once, so the
    // new home view is never hidden behind a tab the user has to discover.
    const activeTabId = parsed.homeSeen
      ? resolveActive(tabs, parsed.activeTabId)
      : HOME_TAB_ID
    return { tabs, activeTabId, homeSeen: true }
  } catch {
    return defaultState()
  }
}

export function saveState(state: DashboardState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // storage full / unavailable — non-fatal for an in-session dashboard
  }
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

interface DashboardExport {
  nexusDashboard: 1
  exportedAt: string
  state: DashboardState
}

/** Serialize the whole dashboard to a JSON string for download. */
export function exportDashboard(state: DashboardState, now: string): string {
  const payload: DashboardExport = {
    nexusDashboard: 1,
    exportedAt: now,
    state,
  }
  return JSON.stringify(payload, null, 2)
}

/** Parse a previously-exported dashboard JSON string. Throws on bad input. */
export function importDashboard(json: string): DashboardState {
  const parsed = JSON.parse(json) as Partial<DashboardExport> & Partial<DashboardState>
  // Accept either the wrapped export or a bare state object.
  const state = (parsed as DashboardExport).state ?? (parsed as DashboardState)
  if (!state?.tabs?.length) throw new Error('Not a valid Nexus dashboard file')
  const tabs = state.tabs.map(normalizeTab)
  return {
    tabs,
    activeTabId: resolveActive(tabs, state.activeTabId ?? HOME_TAB_ID),
    homeSeen: true,
  }
}

/** Portable JSON for a single tile (widget type + its settings). */
export function tileToExport(instance: WidgetInstance): TileExport {
  return {
    nexusTile: 1,
    type: instance.type,
    config: instance.config,
    custom: instance.custom,
  }
}

/**
 * Build a fresh widget instance from a tile-export JSON string.
 * `known(type)` returns true if the widget type is registered.
 */
export function tileFromExport(
  json: string,
  known: (type: string) => boolean,
): WidgetInstance {
  const parsed = JSON.parse(json) as Partial<TileExport>
  if (!parsed.type || typeof parsed.type !== 'string') {
    throw new Error('Missing widget "type"')
  }
  if (!known(parsed.type)) {
    throw new Error(`Unknown widget type: ${parsed.type}`)
  }
  return {
    id: makeId('w'),
    type: parsed.type,
    config: (parsed.config as Record<string, unknown>) ?? {},
    custom: parsed.custom,
  }
}
