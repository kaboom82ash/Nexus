import { useEffect, useMemo, useState } from 'react'
import type { DashboardState, WidgetInstance } from './lib/types'
import { loadState, saveState, makeTab } from './lib/storage'
import { makeId } from './lib/id'
import { getWidget } from './widgets/registry'
import { TabBar } from './components/TabBar'
import { DashboardGrid } from './components/DashboardGrid'
import { WidgetPicker } from './components/WidgetPicker'

export default function App() {
  const [state, setState] = useState<DashboardState>(() => loadState())
  // When adding a widget, which tile index the picker is targeting.
  const [pickerIndex, setPickerIndex] = useState<number | null>(null)

  useEffect(() => {
    saveState(state)
  }, [state])

  const activeTab = useMemo(
    () => state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0],
    [state],
  )

  // --- tab operations -----------------------------------------------------
  const selectTab = (id: string) =>
    setState((s) => ({ ...s, activeTabId: id }))

  const addTab = () =>
    setState((s) => {
      const tab = makeTab(`Dashboard ${s.tabs.length + 1}`)
      return { tabs: [...s.tabs, tab], activeTabId: tab.id }
    })

  const removeTab = (id: string) =>
    setState((s) => {
      if (s.tabs.length <= 1) return s
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeTabId =
        s.activeTabId === id ? tabs[0].id : s.activeTabId
      return { tabs, activeTabId }
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

  const addWidget = (index: number, type: string) => {
    const def = getWidget(type)
    if (!def) return
    const instance: WidgetInstance = {
      id: makeId('w'),
      type,
      config: { ...def.defaultConfig },
    }
    updateActiveTiles((tiles) => {
      const next = tiles.slice()
      next[index] = instance
      return next
    })
    setPickerIndex(null)
  }

  const removeWidget = (index: number) =>
    updateActiveTiles((tiles) => {
      const next = tiles.slice()
      next[index] = null
      return next
    })

  const changeConfig = (index: number, config: Record<string, unknown>) =>
    updateActiveTiles((tiles) => {
      const next = tiles.slice()
      const current = next[index]
      if (current) next[index] = { ...current, config }
      return next
    })

  const filledCount = activeTab.tiles.filter(Boolean).length

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
          {filledCount}/{activeTab.tiles.length} tiles
        </div>
      </header>

      <main className="app__main">
        <DashboardGrid
          tab={activeTab}
          onAdd={(index) => setPickerIndex(index)}
          onRemove={removeWidget}
          onConfigChange={changeConfig}
        />
      </main>

      {pickerIndex !== null && (
        <WidgetPicker
          onPick={(type) => addWidget(pickerIndex, type)}
          onClose={() => setPickerIndex(null)}
        />
      )}
    </div>
  )
}
