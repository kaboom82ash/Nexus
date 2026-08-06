import { useState, type CSSProperties, type DragEvent } from 'react'
import type { TileCustom, WidgetInstance } from '../lib/types'
import { getWidget } from '../widgets/registry'
import { TileCustomizeModal } from './TileCustomizeModal'

interface TileProps {
  index: number
  instance: WidgetInstance | null
  onAdd: (index: number) => void
  onRemove: (index: number) => void
  onUpdate: (
    index: number,
    patch: { config?: Record<string, unknown>; custom?: TileCustom },
  ) => void
  onMove: (from: number, to: number) => void
}

export function Tile({
  index,
  instance,
  onAdd,
  onRemove,
  onUpdate,
  onMove,
}: TileProps) {
  const [showSettings, setShowSettings] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  // Drop handling is shared by empty and filled tiles.
  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if (e.dataTransfer.types.includes('text/plain')) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!dragOver) setDragOver(true)
      }
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const from = Number(e.dataTransfer.getData('text/plain'))
      if (!Number.isNaN(from) && from !== index) onMove(from, index)
    },
  }

  if (!instance) {
    return (
      <button
        className={`tile tile--empty ${dragOver ? 'tile--dragover' : ''}`}
        onClick={() => onAdd(index)}
        title="Add widget"
        {...dropProps}
      >
        <span className="tile__plus">+</span>
      </button>
    )
  }

  const def = getWidget(instance.type)
  if (!def) {
    return (
      <div className="tile tile--error" {...dropProps}>
        <span>Unknown widget: {instance.type}</span>
        <button className="tile__remove" onClick={() => onRemove(index)}>
          ✕
        </button>
      </div>
    )
  }

  const Body = def.component
  const config = { ...def.defaultConfig, ...instance.config }
  const title = instance.custom?.title || def.name
  const accent = instance.custom?.accent

  return (
    <div
      className={`tile tile--filled ${dragOver ? 'tile--dragover' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', String(index))
        e.dataTransfer.effectAllowed = 'move'
      }}
      {...dropProps}
      style={accent ? ({ '--tile-accent': accent } as CSSProperties) : undefined}
    >
      {accent && <span className="tile__accent" />}

      <button
        className="tile__remove"
        title="Remove widget"
        onClick={() => onRemove(index)}
      >
        ✕
      </button>

      <div className="tile__content">
        <Body
          config={config}
          title={title}
          onConfigChange={(next) =>
            onUpdate(index, { config: next as Record<string, unknown> })
          }
        />
      </div>

      {/* Bottom control bar: drag handle + gear */}
      <div className="tile__bar">
        <span className="tile__handle" title="Drag to move" aria-hidden>
          ⠿
        </span>
        <button
          className="tile__gear"
          title="Customize tile"
          onClick={() => setShowSettings(true)}
        >
          ⚙
        </button>
      </div>

      {showSettings && (
        <TileCustomizeModal
          instance={instance}
          def={def}
          onSave={({ config: c, custom }) => {
            onUpdate(index, { config: c, custom })
            setShowSettings(false)
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}
