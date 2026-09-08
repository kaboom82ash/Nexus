# Architecture

## Current form: one self-contained HTML file

Everything lives in `public/weekly-briefing.html` (served by Nexus at
`/weekly-briefing.html` and mounted in an iframe by
`src/components/WeeklyBriefing.tsx`; originally authored as a Claude artifact,
which is why the persistence path below still probes the artifact runtime
first):

- Content (the week's items) is static HTML written at build time by the Claude run — every item is a `.card`, `.cat-row`, or table row carrying `data-cat` (category), `sev-*` classes (severity), optional `data-sync` (shared identity), and real links (Gmail thread URLs, Calendar htmlLinks, Maps directions with origin preset to home).
- Behavior is one inline `<script>` at the bottom. On load it walks the DOM (`injectCheckables()`), attaches a checkbox + quick-action strip to every linkable item, registers each into `registry` (id → element list) and `ITEM_DATA` (id → title/category/severity/links), then renders the punch list, dashboard tiles, and NEW-today badges from state.
- State is one JSON blob in `<script id="app-state" type="application/json">`. Shape:

```json
{
  "punchlist": {
    "<id>": {
      "title": "…", "category": "finance", "severity": "critical",
      "links": [{"label": "✉️ Email ↗", "href": "…"}],
      "done": false, "doneAt": null, "addedAt": "Aug 25, 2026",
      "subs": [{"t": "call back", "done": true}]
    }
  },
  "status":   { "<id>": "waiting|court|fwd|remind" },
  "priority": { "<id>": true }
}
```

- Persistence: on any change, the script swaps the current state JSON into a pristine copy of the page template (`BASE_HTML`, captured before any dynamic rendering — never the live DOM) and republishes via the artifact runtime (`window.claude.use("artifact").publish(html)`). Fallback: localStorage under `ak-briefing-state`, with a visible "saved on this device only" note. All storage access is wrapped in try/catch. **Inside Nexus there is no artifact runtime, so localStorage is always the live path** — which also means a rebuilt page dropped into `public/` inherits whatever punch-list state that browser already holds.

## Identity and sync rules

- Item id = slugified title, unique per page — EXCEPT items with `data-sync="<key>"`, which share id `sync-<key>` across every copy. One punch entry, N checkboxes, all mirrored (check, status, priority flag).
- Punch entries are snapshots + user edits: once on the list, the title can be edited and sub-steps accumulate; a weekly rebuild must merge new page content around the preserved state, keyed by these ids. Keep ids STABLE across rebuilds (same slugs/sync keys for recurring items like `sync-paypal`, `sync-chase`) or carried entries will orphan.

## Interaction contract (do not break these)

1. Checking a box anywhere = queue to punch list. It never means "done".
2. Completion, sub-steps, editing, removal happen only on the punch list; removal un-checks every source copy.
3. Masthead Critical/High counters count unfinished punch entries, not the raw sweep.
4. Nothing external is ever auto-created: calendar adds and reminders are pre-filled `calendar.google.com/calendar/render?action=TEMPLATE` links the user confirms; drafts are copy-only.
5. Prep-meeting selection sums hours live and queues blocks with ids `prep-N`.

## Live data inside Nexus

Served by the app, the page is no longer sealed off from Google. `public/briefing/bridge.js` runs inside the same-origin iframe and calls `window.__nexusBriefing` on the parent (`src/lib/briefingBridge.ts`), a thin front for the app's Gmail client and the Calendar client sharing its OAuth layer — one consent for `gmail.readonly` + `calendar.readonly`, browser-only, no backend.

- **Live inbox** leads the Actions tab; **Live calendar** leads the Calendar tab. Both are rendered in the page's own markup vocabulary — `.cat-row` inside a `.cat-grid-band`, with a `.mail-link`/`.cal-btn` — which is precisely what makes `injectCheckables()` adopt them: same checkbox, same quick actions, same punch-list entry.
- Live rows carry `data-sync` (a slugified message/event id) so a queued item keeps one punch-list entry across syncs, and carry **no `data-cat`**: `renderPunchList()` only renders entries whose category is in its fixed `CATEGORIES`, so an unknown key (Gmail's `updates`, `promotions`, …) would queue an item that never appears. Letting `inferCategory()` classify guarantees a renderable key.
- Before re-running `injectCheckables()` the bridge prunes `registry` entries whose element left the DOM, but never deletes a key: a missing key reads as "first sighting" and would double-count the item into the dashboard tiles.
- The theme is `public/briefing/theme.css` — a restatement of the page's palette tokens, nothing more, because the page tokenizes every color.

Both files are additive and linked from the page's head. Standalone, the bridge finds no parent, says so in its strip, and the page behaves exactly as it did before.

## Rebuild loop (still Claude's job)

The bridge fetches; it does not *curate*. Categorized bands, severity ratings, drafts, logistics and the vault are written at rebuild time by a Claude run, and that is still a round-trip:

1. 🔄 Refresh button copies a standing prompt (re-sweep last 24h mail + 14-day calendar, merge, preserve state).
2. User pastes it into a Claude chat with the Google connectors attached.
3. The regenerated page is written over `public/weekly-briefing.html`; on load it badges anything received TODAY as `NEW` and counts it in the masthead.

A scheduled task (daily, morning) running the same prompt makes this hands-off. For "what landed in the last hour", use ↻ Sync now instead — no rebuild needed.

## Roadmap to a real app

Phase 1 — live data without a backend: **done**, via the bridge above. Google OAuth 2.0 (`gmail.readonly`, `calendar.readonly`) runs in the browser through Google Identity Services, and Sync is a real fetch. What Phase 1 originally also wanted and this does not give you: server-side tokens, and state that follows you between devices — punch-list state is still per browser.

Phase 2 — structure:
- Split content from template: produce `items.json` (id, title, category, severity, dates, links, syncKey) and render all tabs from it. The current DOM-walking injector goes away; rendering and state share the same id space by construction. The bridge's live sections are a small preview of this — they build rows from data — but they still hand them to the injector rather than owning identity outright.
- Add the other mailboxes (kohlihome22, grilldome, emory) as additional OAuth connections; tag items by account; keep the two-property Gmail-label separation.
- Real drive-time estimates via a maps API (Distance Matrix) instead of static estimates.

Phase 3 — intelligence:
- The categorize/severity/draft logic is the LLM's job: run the master prompt's Section 3 rules through an API call over the raw sweep, returning the structured items + drafts. The master prompt file is deliberately written to be usable as that system prompt.

## Gotchas learned the hard way

- Never serialize the live DOM for persistence — dynamic checkboxes/badges get baked in. Always template + state.
- Google Calendar event links must come from the API's `htmlLink`; constructed eids don't work.
- Force-republishing over a page that saved its own state destroys user data — merge or ask first.
- Artifact pages block downloads and most external fetches; only pre-filled Google URLs (calendar templates, Gmail deep links, Maps) work as "actions". Served from Nexus that restriction is gone, which is what makes the bridge possible.
- The masthead is `position: sticky` with no `scroll-margin` anywhere, so every `scrollIntoView` in the page lands content underneath it. The bridge sets `scroll-padding-top` on the scrolling element from the masthead's measured height — it made the masthead taller, so keeping that in step is its job.
