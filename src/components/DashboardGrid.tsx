import type { DashboardTab, TileCustom } from '../lib/types'
import { Tile } from './Tile'

interface DashboardGridProps {
  tab: DashboardTab
  onAdd: (index: number) => void
  onRemove: (index: number) => void
  onUpdate: (
    index: number,
    patch: { config?: Record<string, unknown>; custom?: TileCustom },
  ) => void
  onMove: (from: number, to: number) => void
}

export function DashboardGrid({
  tab,
  onAdd,
  onRemove,
  onUpdate,
  onMove,
}: DashboardGridProps) {
  return (
    <div className="grid">
      {tab.tiles.map((instance, i) => (
        <Tile
          key={instance?.id ?? `empty-${i}`}
          index={i}
          instance={instance}
          onAdd={onAdd}
          onRemove={onRemove}
          onUpdate={onUpdate}
          onMove={onMove}
        />
      ))}
    </div>
  )
}
