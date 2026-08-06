import { useState } from 'react'
import { Modal } from './Modal'
import type { WidgetDefinition } from '../widgets/types'
import type { TileCustom, WidgetInstance } from '../lib/types'
import { tileToExport } from '../lib/storage'

interface Props {
  instance: WidgetInstance
  def: WidgetDefinition<any>
  onSave: (next: { config: Record<string, unknown>; custom: TileCustom }) => void
  onClose: () => void
}

const ACCENT_SWATCHES = [
  '',
  '#6366f1',
  '#22c55e',
  '#eab308',
  '#ef4444',
  '#ec4899',
  '#06b6d4',
  '#f97316',
]

export function TileCustomizeModal({ instance, def, onSave, onClose }: Props) {
  const [config, setConfig] = useState<Record<string, unknown>>({
    ...def.defaultConfig,
    ...instance.config,
  })
  const [custom, setCustom] = useState<TileCustom>({ ...instance.custom })
  const [copied, setCopied] = useState(false)

  const Settings = def.settings

  const copyJson = async () => {
    const json = JSON.stringify(tileToExport({ ...instance, config, custom }), null, 2)
    try {
      await navigator.clipboard.writeText(json)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked — select the text as a fallback.
      window.prompt('Copy this tile JSON:', json)
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="settings">
        <div className="settings__titlebar">
          <h3 className="settings__title">
            {def.icon} Customize · {custom.title || def.name}
          </h3>
        </div>

        {/* Common tile options */}
        <label className="field">
          <span>Tile title</span>
          <input
            type="text"
            placeholder={def.name}
            value={custom.title ?? ''}
            onChange={(e) =>
              setCustom((c) => ({ ...c, title: e.target.value || undefined }))
            }
          />
        </label>

        <div className="field">
          <span>Accent</span>
          <div className="swatches">
            {ACCENT_SWATCHES.map((color) => (
              <button
                key={color || 'none'}
                className={`swatch ${(custom.accent ?? '') === color ? 'is-active' : ''} ${
                  color ? '' : 'swatch--none'
                }`}
                style={color ? { background: color } : undefined}
                title={color || 'None'}
                onClick={() =>
                  setCustom((c) => ({ ...c, accent: color || undefined }))
                }
              />
            ))}
          </div>
        </div>

        {/* Widget-specific settings */}
        {Settings && (
          <>
            <div className="settings__divider" />
            <Settings config={config} onChange={(next) => setConfig(next)} />
          </>
        )}

        {/* Per-tile export */}
        <div className="settings__divider" />
        <p className="settings__hint">
          Save this tile (type + settings) to reuse elsewhere.{' '}
          <button className="btn btn--sm" onClick={copyJson}>
            {copied ? 'Copied ✓' : 'Copy tile JSON'}
          </button>
        </p>

        <div className="settings__actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            onClick={() => onSave({ config, custom })}
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  )
}
