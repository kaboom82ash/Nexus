import { useState } from 'react'

/**
 * The Weekly Briefing homepage.
 *
 * The briefing is a self-contained HTML page (its own styles, its own inline
 * script, its own localStorage-backed punch-list state) that is rebuilt weekly
 * by a Claude run — see `weekly-briefing/prompts/Weekly_Briefing_Master_Prompt.md`.
 * We serve it verbatim from `public/` and mount it in an iframe so its CSS and
 * script stay isolated from the dashboard shell; replacing the page each week
 * is then a drop-in file swap with no React changes.
 */
export function WeeklyBriefing() {
  const src = `${import.meta.env.BASE_URL}weekly-briefing.html`
  // Changing the key remounts the iframe, which is a clean reload that also
  // works cross-document without touching contentWindow.
  const [reloadKey, setReloadKey] = useState(0)

  return (
    <div className="briefing">
      <div className="briefing__bar">
        <span className="briefing__label">Weekly Briefing</span>
        <span className="briefing__hint">
          Your punch list saves in this browser.
        </span>
        <button
          className="btn btn--sm"
          onClick={() => setReloadKey((k) => k + 1)}
          title="Reload the briefing page"
        >
          Reload
        </button>
        <a
          className="btn btn--sm"
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          title="Open the briefing in its own tab"
        >
          Open full page ↗
        </a>
      </div>
      <iframe
        key={reloadKey}
        className="briefing__frame"
        src={src}
        title="Weekly Briefing"
      />
    </div>
  )
}
