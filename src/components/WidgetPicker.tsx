import { useState } from 'react'
import { Modal } from './Modal'
import { listWidgets, getWidget } from '../widgets/registry'
import { tileFromExport } from '../lib/storage'
import type { WidgetInstance } from '../lib/types'

interface WidgetPickerProps {
  onPick: (type: string) => void
  onImport: (instance: WidgetInstance) => void
  onClose: () => void
}

export function WidgetPicker({ onPick, onImport, onClose }: WidgetPickerProps) {
  const widgets = listWidgets()
  const [importing, setImporting] = useState(false)
  const [json, setJson] = useState('')
  const [error, setError] = useState<string | null>(null)

  const doImport = () => {
    try {
      const instance = tileFromExport(json, (t) => !!getWidget(t))
      onImport(instance)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid tile JSON')
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="picker">
        <div className="picker__head">
          <h3>{importing ? 'Import a tile' : 'Add a widget'}</h3>
          <button className="btn btn--sm" onClick={onClose}>
            ✕
          </button>
        </div>

        {importing ? (
          <div className="picker__import">
            <textarea
              className="field__textarea"
              rows={7}
              placeholder='Paste tile JSON here (from a tile’s "Copy tile JSON")'
              value={json}
              onChange={(e) => {
                setJson(e.target.value)
                setError(null)
              }}
            />
            {error && <p className="widget__error">{error}</p>}
            <div className="settings__actions">
              <button className="btn" onClick={() => setImporting(false)}>
                Back
              </button>
              <button className="btn btn--primary" onClick={doImport}>
                Add tile
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="picker__list">
              {widgets.map((w) => (
                <button
                  key={w.type}
                  className="picker__item"
                  onClick={() => onPick(w.type)}
                >
                  <span className="picker__icon" aria-hidden>
                    {w.icon}
                  </span>
                  <span className="picker__text">
                    <span className="picker__name">{w.name}</span>
                    <span className="picker__desc">{w.description}</span>
                  </span>
                </button>
              ))}
            </div>
            <button
              className="picker__importlink"
              onClick={() => setImporting(true)}
            >
              Import a tile from JSON…
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}
