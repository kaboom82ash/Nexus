import { useCallback, useEffect, useRef } from 'react'
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

/**
 * A third-party stylesheet must not be able to stop the briefing loading.
 *
 * The page pulls its fonts from fonts.googleapis.com in `<head>`, and its
 * script — ours included — is `defer`red after it. A render-blocking
 * stylesheet blocks deferred scripts too, so on a network where that request
 * hangs rather than fails (a corporate proxy, a blocker, a bad DNS answer) the
 * document sits in readyState "loading" for ever: no live data, no tabs, no
 * error, and the deferred script that would report it never runs either.
 *
 * So if the frame is still parsing after a grace period, take the cross-origin
 * stylesheets out of the critical path by giving them a media query that does
 * not match. Parsing resumes, the scripts run, and if the fonts do turn up
 * later they are put back into use.
 */
const STALL_GRACE_MS = 4000

function unblockStalledFrame(doc: Document): boolean {
  if (doc.readyState !== 'loading') return false
  const links = doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')
  let freed = false
  links.forEach((link) => {
    if (!/^https?:/i.test(link.getAttribute('href') ?? '')) return
    if (link.dataset.nexusUnblocked) return
    link.dataset.nexusUnblocked = '1'
    link.media = 'print'
    // Put it back once it finally arrives, so the page still gets its fonts.
    link.addEventListener('load', () => {
      link.media = 'all'
    })
    freed = true
  })
  return freed
}

export function WeeklyBriefing({ reloadSignal = 0 }: { reloadSignal?: number }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const base = import.meta.env.BASE_URL
  const src = `${base}weekly-briefing.html`
  // Changing the key remounts the iframe, which is a clean reload that also
  // works cross-document without touching contentWindow. The Actions menu
  // owns the control; this only reacts to it.
  const reloadKey = reloadSignal

  useEffect(() => {
    const timer = setTimeout(() => {
      const doc = frameRef.current?.contentDocument
      if (doc) unblockStalledFrame(doc)
    }, STALL_GRACE_MS)
    return () => clearTimeout(timer)
  }, [reloadSignal])

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
        ref={frameRef}
        key={reloadKey}
        className="briefing__frame"
        src={src}
        title="Daily Digest"
        onLoad={onLoad}
      />
    </div>
  )
}
