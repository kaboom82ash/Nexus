import { useEffect, useRef, useState } from 'react'

/**
 * Every app-level action in one menu at the top: export, import, sync, reload,
 * settings. These were scattered — some in the header, Reload on the digest's
 * own bar, Sync inside the briefing — which meant three places to look for
 * "do something to this page".
 */

export interface ActionsMenuProps {
  onExport: () => void
  onImport: () => void
  onReload: () => void
  onSettings: () => void
}

function digestSync(): boolean {
  const frame = document.querySelector<HTMLIFrameElement>('.briefing__frame')
  try {
    const api = (frame?.contentWindow as (Window & { __nexusDigest?: { sync(): void } }) | null)
      ?.__nexusDigest
    if (!api) return false
    api.sync()
    return true
  } catch {
    return false
  }
}

export function ActionsMenu({
  onExport,
  onImport,
  onReload,
  onSettings,
}: ActionsMenuProps) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }

  return (
    <div className="menu" ref={wrap}>
      <button
        className="btn btn--sm menu__trigger"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Actions"
      >
        Actions ▾
      </button>
      {open && (
        <div className="menu__panel" role="menu">
          <button
            className="menu__item"
            role="menuitem"
            onClick={run(() => {
              // Falls back to a full reload when the digest has not booted:
              // either way the user gets fresh data, which is what they asked
              // for by pressing it.
              if (!digestSync()) onReload()
            })}
          >
            ↻ Sync now
          </button>
          <button className="menu__item" role="menuitem" onClick={run(onReload)}>
            ⟳ Reload digest
          </button>
          <div className="menu__sep" />
          <button className="menu__item" role="menuitem" onClick={run(onExport)}>
            ⬇ Export dashboard
          </button>
          <button className="menu__item" role="menuitem" onClick={run(onImport)}>
            ⬆ Import dashboard
          </button>
          <div className="menu__sep" />
          <button className="menu__item" role="menuitem" onClick={run(onSettings)}>
            ⚙ Settings
          </button>
        </div>
      )}
    </div>
  )
}
