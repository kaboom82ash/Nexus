import { useEffect, useMemo, useRef, useState } from 'react'
import type { DashboardState, TileCustom, WidgetInstance } from './lib/types'
import { HOME_TAB_ID } from './lib/types'
import {
  loadState,
  saveState,
  makeTab,
  exportDashboard,
  importDashboard,
} from './lib/storage'
import { makeId } from './lib/id'
import { getWidget } from './widgets/registry'
import { TabBar } from './components/TabBar'
import { DashboardGrid } from './components/DashboardGrid'
import { WidgetPicker } from './components/WidgetPicker'
import { GmailAuthBar } from './components/GmailAuthBar'
import { GlobalSettings } from './components/GlobalSettings'
import { WeeklyBriefing } from './components/WeeklyBriefing'

export default function App() {
  const [state, setState] = useState<DashboardState>(() => loadState())
  const [pickerIndex, setPickerIndex] = useState<number | null>(null)
  const [showGlobalSettings, setShowGlobalSettings] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    saveState(state)
  }, [state])

  const onHome = state.activeTabId === HOME_TAB_ID

  // Only meaningful when a tile tab is active; the homepage has no tiles.
  const activeTab = useMemo(
    () => state.tabs.find((t) => t.id === state.activeTabId) ?? null,
    [state],
  )

  // --- tab operations -----------------------------------------------------
  const selectTab = (id: string) => setState((s) => ({ ...s, activeTabId: id }))

  const addTab = () =>
    setState((s) => {
      const tab = makeTab(`Dashboard ${s.tabs.length + 1}`)
      return { ...s, tabs: [...s.tabs, tab], activeTabId: tab.id }
    })

  const removeTab = (id: string) =>
    setState((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeTabId = s.activeTabId === id ? HOME_TAB_ID : s.activeTabId
      return { ...s, tabs, activeTabId }
    })

  const renameTab = (id: string, name: string) =>
    setState((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, name } : t)),
    }))

  // --- tile operations ----------------------------------------------------
  const updateActiveTiles = (
    fn: (tiles: (WidgetInstance | null)[]) => (WidgetInstance | null)[],
  ) =>
    setState((s) => ({
      ...s,
      tabs: s.tabs.map((t) =>
        t.id === s.activeTabId ? { ...t, tiles: fn(t.tiles) } : t,
      ),
    }))

  const placeInstance = (index: number, instance: WidgetInstance) => {
    updateActiveTiles((tiles) => {
      const next = tiles.slice()
      next[index] = instance
      return next
    })
    setPickerIndex(null)
  }

  const addWidget = (index: number, type: string) => {
    const def = getWidget(type)
    if (!def) return
    placeInstance(index, {
      id: makeId('w'),
      type,
      config: { ...def.defaultConfig },
    })
  }

  const removeWidget = (index: number) =>
    updateActiveTiles((tiles) => {
      const next = tiles.slice()
      next[index] = null
      return next
    })

  const updateTile = (
    index: number,
    patch: { config?: Record<string, unknown>; custom?: TileCustom },
  ) =>
    updateActiveTiles((tiles) => {
      const next = tiles.slice()
      const current = next[index]
      if (current) {
        next[index] = {
          ...current,
          config: patch.config ?? current.config,
          custom: patch.custom ?? current.custom,
        }
      }
      return next
    })

  // Move a widget between tiles; swap if the target is occupied.
  const moveWidget = (from: number, to: number) =>
    updateActiveTiles((tiles) => {
      const next = tiles.slice()
      const tmp = next[to]
      next[to] = next[from]
      next[from] = tmp
      return next
    })

  // --- dashboard import / export -----------------------------------------
  const doExport = () => {
    const json = exportDashboard(state, new Date().toISOString())
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'nexus-dashboard.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const onImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-importing the same file
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        setState(importDashboard(String(reader.result)))
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Import failed')
      }
    }
    reader.readAsText(file)
  }

  const filledCount = activeTab ? activeTab.tiles.filter(Boolean).length : 0

  return (
    <div className="app">
      <header className="app__header">
        <div className="brand">
          <span className="brand__mark">◲</span>
          <span className="brand__name">Nexus</span>
        </div>
        <TabBar
          tabs={state.tabs}
          activeTabId={state.activeTabId}
          onSelect={selectTab}
          onAdd={addTab}
          onRemove={removeTab}
          onRename={renameTab}
        />
        <div className="app__meta">
          <GmailAuthBar />
          {activeTab && (
            <span className="app__count">
              {filledCount}/{activeTab.tiles.length} tiles
            </span>
          )}
          <button className="btn btn--sm" onClick={doExport} title="Export dashboard">
            Export
          </button>
          <button
            className="btn btn--sm"
            onClick={() => fileInputRef.current?.click()}
            title="Import dashboard"
          >
            Import
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={onImportFile}
          />
          <button
            className="btn btn--sm"
            onClick={() => setShowGlobalSettings(true)}
            title="Global settings"
          >
            ⚙
          </button>
        </div>
      </header>

      <main className={`app__main ${onHome ? 'app__main--home' : ''}`}>
        {onHome || !activeTab ? (
          <WeeklyBriefing />
        ) : (
          <DashboardGrid
            tab={activeTab}
            onAdd={(index) => setPickerIndex(index)}
            onRemove={removeWidget}
            onUpdate={updateTile}
            onMove={moveWidget}
          />
        )}
      </main>

      {pickerIndex !== null && (
        <WidgetPicker
          onPick={(type) => addWidget(pickerIndex, type)}
          onImport={(instance) => placeInstance(pickerIndex, instance)}
          onClose={() => setPickerIndex(null)}
        />
      )}

      {showGlobalSettings && (
        <GlobalSettings onClose={() => setShowGlobalSettings(false)} />
      )}
    </div>
  )
}
