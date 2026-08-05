import type { DashboardTab } from '../lib/types'
import { Tile } from './Tile'

interface DashboardGridProps {
  tab: DashboardTab
  onAdd: (index: number) => void
  onRemove: (index: number) => void
  onConfigChange: (index: number, config: Record<string, unknown>) => void
}

export function DashboardGrid({
  tab,
  onAdd,
  onRemove,
  onConfigChange,
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
          onConfigChange={onConfigChange}
        />
      ))}
    </div>
  )
}
