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

## Daily refresh loop (current)

The page can't reach Gmail/Calendar itself (static file; artifact CSP allows no API fetches, and there's no OAuth). So freshness is a round-trip through Claude:

1. 🔄 Refresh button copies a standing prompt (re-sweep last 24h mail + 14-day calendar, merge, preserve state, republish same URL).
2. User pastes it into a Claude chat with the Google connectors attached.
3. Claude republishes; on load the page badges anything received TODAY as `NEW` and counts it in the masthead.

A scheduled task (daily, morning) running the same prompt makes this hands-off.

## Roadmap to a real app

Phase 1 — keep the file, add a tiny backend:
- Host the page anywhere (Vercel/Netlify). Add a small server (Node/Express or a serverless function) exposing `/api/refresh` that runs the sweep server-side.
- Google OAuth 2.0 (scopes: `gmail.readonly`, `calendar.readonly`) with tokens stored server-side. The Refresh button becomes a real fetch → server returns the regenerated item payload → client re-renders and diffs against previous ids to mark NEW.
- Move state from in-page JSON to the server (SQLite/Postgres, or Firestore). Same shape as above; the page becomes a pure client.

Phase 2 — structure:
- Split content from template: server produces `items.json` (id, title, category, severity, dates, links, syncKey) and the client renders all tabs from it. The current DOM-walking injector goes away; rendering and state share the same id space by construction.
- Add the other mailboxes (kohlihome22, grilldome, emory) as additional OAuth connections; tag items by account; keep the two-property Gmail-label separation.
- Real drive-time estimates via a maps API (Distance Matrix) instead of static estimates.

Phase 3 — intelligence:
- The categorize/severity/draft logic is the LLM's job: run the master prompt's Section 3 rules through an API call over the raw sweep, returning the structured items + drafts. The master prompt file is deliberately written to be usable as that system prompt.

## Gotchas learned the hard way

- Never serialize the live DOM for persistence — dynamic checkboxes/badges get baked in. Always template + state.
- Google Calendar event links must come from the API's `htmlLink`; constructed eids don't work.
- Force-republishing over a page that saved its own state destroys user data — merge or ask first.
- Artifact pages block downloads and most external fetches; only pre-filled Google URLs (calendar templates, Gmail deep links, Maps) work as "actions".
