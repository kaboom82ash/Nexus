/** Per-tile presentation overrides, independent of the widget's own config. */
export interface TileCustom {
  /** Overrides the widget's default title. */
  title?: string
  /** Accent color (hex) shown as the tile's top strip. */
  accent?: string
}

/** A configured instance of a widget placed on a tile. */
export interface WidgetInstance {
  /** Unique id for this placed instance. */
  id: string
  /** Widget type key, resolved against the widget registry. */
  type: string
  /** Free-form per-instance configuration (validated by the widget itself). */
  config: Record<string, unknown>
  /** Optional presentation overrides applied by the tile chrome. */
  custom?: TileCustom
}

/** Portable representation of a single tile for import/export. */
export interface TileExport {
  nexusTile: 1
  type: string
  config: Record<string, unknown>
  custom?: TileCustom
}

/** Grid is always a fixed length; empty slots are null. */
export type TileSlot = WidgetInstance | null

export interface DashboardTab {
  id: string
  name: string
  /** Length === TILES_PER_PAGE. Empty slots are null. */
  tiles: TileSlot[]
}

export interface DashboardState {
  tabs: DashboardTab[]
  /** Either HOME_TAB_ID or the id of one of `tabs`. */
  activeTabId: string
  /**
   * Set once the Weekly Briefing homepage has been introduced to this browser.
   * Absent in dashboards saved before the homepage existed, which is how we
   * know to land those users on it the first time.
   */
  homeSeen?: boolean
}

/**
 * The Daily Digest homepage. It is not a tile tab — it holds no widgets and
 * cannot be renamed or removed — so it lives outside `tabs` and is identified
 * by this reserved id wherever an active view is stored.
 */
export const HOME_TAB_ID = 'home'
export const HOME_TAB_NAME = 'Daily Digest'

/** 5 x 5 grid. */
export const GRID_COLS = 5
export const GRID_ROWS = 5
export const TILES_PER_PAGE = GRID_COLS * GRID_ROWS
