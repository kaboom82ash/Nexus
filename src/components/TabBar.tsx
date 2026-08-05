import { useState } from 'react'
import type { DashboardTab } from '../lib/types'

interface TabBarProps {
  tabs: DashboardTab[]
  activeTabId: string
  onSelect: (id: string) => void
  onAdd: () => void
  onRemove: (id: string) => void
  onRename: (id: string, name: string) => void
}

export function TabBar({
  tabs,
  activeTabId,
  onSelect,
  onAdd,
  onRemove,
  onRename,
}: TabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const startRename = (tab: DashboardTab) => {
    setEditingId(tab.id)
    setDraft(tab.name)
  }
  const commitRename = () => {
    if (editingId) onRename(editingId, draft.trim() || 'Untitled')
    setEditingId(null)
  }

  return (
    <div className="tabbar">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            className={`tab ${active ? 'tab--active' : ''}`}
            onClick={() => onSelect(tab.id)}
          >
            {editingId === tab.id ? (
              <input
                className="tab__input"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') setEditingId(null)
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className="tab__name"
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  startRename(tab)
                }}
                title="Double-click to rename"
              >
                {tab.name}
              </span>
            )}
            {tabs.length > 1 && (
              <button
                className="tab__close"
                title="Remove tab"
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm(`Remove tab “${tab.name}” and its widgets?`)) {
                    onRemove(tab.id)
                  }
                }}
              >
                ✕
              </button>
            )}
          </div>
        )
      })}
      <button className="tab tab--add" title="Add tab" onClick={onAdd}>
        +
      </button>
    </div>
  )
}
