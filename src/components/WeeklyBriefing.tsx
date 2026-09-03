import { useCallback } from 'react'
import { installBriefingBridge } from '../lib/briefingBridge'

/**
 * The Weekly Briefing homepage.
 *
 * The briefing is a self-contained HTML page (its own styles, its own inline
 * script, its own localStorage-backed punch-list state) that is rebuilt weekly
 * by a Claude run — see `weekly-briefing/prompts/Weekly_Briefing_Master_Prompt.md`.
 * We serve it verbatim from `public/` and mount it in an iframe so its CSS and
 * script stay isolated from the dashboard shell; replacing the page each week
 * is then a drop-in file swap with no React changes.
 *
 * Two files in `public/briefing/` adapt it to the app without editing its
 * content: `theme.css` restates its palette tokens as Nexus's, and `bridge.js`
 * gives it live Gmail and Calendar data through `window.__nexusBriefing`. The
 * page links both itself; `ensureIntegration` re-adds them if a rebuilt page
 * arrives without those lines.
 */

// Published before the iframe can load, since the page's script looks for it
// as soon as it runs.
installBriefingBridge()

const THEME_HREF = 'briefing/theme.css'
const BRIDGE_SRC = 'briefing/bridge.js'

/** Add the theme and bridge to a briefing page that was rebuilt without them. */
function ensureIntegration(doc: Document, base: string): void {
  // Contains, not ends-with: the published page carries a ?v=<hash> cache
  // buster, so a suffix match would miss it and inject a duplicate.
  if (!doc.querySelector(`link[href*="${THEME_HREF}"]`)) {
    const link = doc.createElement('link')
    link.rel = 'stylesheet'
    link.href = `${base}${THEME_HREF}`
    doc.head.appendChild(link)
  }
  if (!doc.querySelector(`script[src*="${BRIDGE_SRC}"]`)) {
    const script = doc.createElement('script')
    script.src = `${base}${BRIDGE_SRC}`
    doc.body.appendChild(script)
  }
}

export function WeeklyBriefing({ reloadSignal = 0 }: { reloadSignal?: number }) {
  const base = import.meta.env.BASE_URL
  const src = `${base}weekly-briefing.html`
  // Changing the key remounts the iframe, which is a clean reload that also
  // works cross-document without touching contentWindow. The Actions menu
  // owns the control; this only reacts to it.
  const reloadKey = reloadSignal

  const onLoad = useCallback(
    (e: React.SyntheticEvent<HTMLIFrameElement>) => {
      const doc = e.currentTarget.contentDocument
      // Same-origin, so this is readable; guard anyway rather than throw into
      // a load handler.
      if (doc) ensureIntegration(doc, base)
    },
    [base],
  )

  return (
    <div className="briefing">
      <iframe
        key={reloadKey}
        className="briefing__frame"
        src={src}
        title="Daily Digest"
        onLoad={onLoad}
      />
    </div>
  )
}
