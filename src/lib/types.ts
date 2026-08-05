/** A configured instance of a widget placed on a tile. */
export interface WidgetInstance {
  /** Unique id for this placed instance. */
  id: string
  /** Widget type key, resolved against the widget registry. */
  type: string
  /** Free-form per-instance configuration (validated by the widget itself). */
  config: Record<string, unknown>
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
  activeTabId: string
}

/** 5 x 5 grid. */
export const GRID_COLS = 5
export const GRID_ROWS = 5
export const TILES_PER_PAGE = GRID_COLS * GRID_ROWS
