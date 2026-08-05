import { Modal } from './Modal'
import { listWidgets } from '../widgets/registry'

interface WidgetPickerProps {
  onPick: (type: string) => void
  onClose: () => void
}

export function WidgetPicker({ onPick, onClose }: WidgetPickerProps) {
  const widgets = listWidgets()
  return (
    <Modal onClose={onClose}>
      <div className="picker">
        <div className="picker__head">
          <h3>Add a widget</h3>
          <button className="btn btn--sm" onClick={onClose}>
            ✕
          </button>
        </div>
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
      </div>
    </Modal>
  )
}
