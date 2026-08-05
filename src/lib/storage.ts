import { DashboardState, DashboardTab, TILES_PER_PAGE } from './types'
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
  return { tabs: [first], activeTabId: first.id }
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
    const activeTabId = tabs.some((t) => t.id === parsed.activeTabId)
      ? parsed.activeTabId
      : tabs[0].id
    return { tabs, activeTabId }
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
