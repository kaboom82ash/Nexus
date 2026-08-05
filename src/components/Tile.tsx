import { useState } from 'react'
import type { WidgetInstance } from '../lib/types'
import { getWidget } from '../widgets/registry'
import { Modal } from './Modal'

interface TileProps {
  index: number
  instance: WidgetInstance | null
  onAdd: (index: number) => void
  onRemove: (index: number) => void
  onConfigChange: (index: number, config: Record<string, unknown>) => void
}

export function Tile({
  index,
  instance,
  onAdd,
  onRemove,
  onConfigChange,
}: TileProps) {
  const [showSettings, setShowSettings] = useState(false)

  if (!instance) {
    return (
      <button
        className="tile tile--empty"
        onClick={() => onAdd(index)}
        title="Add widget"
      >
        <span className="tile__plus">+</span>
      </button>
    )
  }

  const def = getWidget(instance.type)
  if (!def) {
    return (
      <div className="tile tile--error">
        <span>Unknown widget: {instance.type}</span>
        <button className="tile__remove" onClick={() => onRemove(index)}>
          ✕
        </button>
      </div>
    )
  }

  const Body = def.component
  const Settings = def.settings
  // Merge stored config over defaults so older instances gain new fields.
  const config = { ...def.defaultConfig, ...instance.config }

  return (
    <div className="tile tile--filled">
      <button
        className="tile__remove"
        title="Remove widget"
        onClick={() => onRemove(index)}
      >
        ✕
      </button>
      <Body
        config={config}
        onConfigChange={(next) => onConfigChange(index, next as Record<string, unknown>)}
        onOpenSettings={() => setShowSettings(true)}
      />
      {showSettings && Settings && (
        <Modal onClose={() => setShowSettings(false)}>
          <Settings
            config={config}
            onSave={(next) => onConfigChange(index, next as Record<string, unknown>)}
            onClose={() => setShowSettings(false)}
          />
        </Modal>
      )}
    </div>
  )
}
