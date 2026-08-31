import { useState } from 'react'
import type { DashboardTab } from '../lib/types'
import { HOME_TAB_ID, HOME_TAB_NAME } from '../lib/types'

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
      {/* The homepage is pinned first and holds no tiles, so it has no rename
          or close affordance — it is a fixed destination, not a user tab. */}
      <div
        className={`tab tab--home ${
          activeTabId === HOME_TAB_ID ? 'tab--active' : ''
        }`}
        onClick={() => onSelect(HOME_TAB_ID)}
        title="Weekly Briefing homepage"
      >
        <span className="tab__icon" aria-hidden="true">
          ⌂
        </span>
        <span className="tab__name">{HOME_TAB_NAME}</span>
      </div>
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
          </div>
        )
      })}
      <button className="tab tab--add" title="Add tab" onClick={onAdd}>
        +
      </button>
    </div>
  )
}
