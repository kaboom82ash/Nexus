# AK Weekly Briefing — the Nexus homepage

A personal chief-of-staff dashboard: one self-contained HTML page that fuses a
Gmail sweep and a Google Calendar sweep into an operable weekly console — punch
list, deadline-ranked actions, category inbox, weekly calendar grid, logistics
with directions, draft replies, and a reference vault.

It is the **core homepage of Nexus**: the app opens on it, and the tile
dashboards are tabs beside it.

## Contents

```
public/
├── weekly-briefing.html          # The complete working page — served as-is, mounted by the app
└── briefing/
    ├── theme.css                 # Restates the page's palette tokens as the Nexus theme
    └── bridge.js                 # Live Gmail + Calendar data inside the page
weekly-briefing/
├── prompts/
│   └── Weekly_Briefing_Master_Prompt.md   # Full build spec: rules, tab structure, info-flow, quality checklist
├── data/
│   ├── Email_Summary_2026-08-24.md        # Sample weekly email digest (source data for the page)
│   └── Prep_Meetings_2026-08-24.ics       # Sample prep-meeting invites (Google Calendar import format)
├── docs/
│   └── ARCHITECTURE.md           # How the page works + roadmap to a real app
└── README.md
```

The page lives in `public/` rather than beside these files so Vite serves it
verbatim at `/weekly-briefing.html`; `src/components/WeeklyBriefing.tsx` mounts
it in an iframe, which keeps the briefing's own styles and inline script fully
isolated from the dashboard shell.

## How it is wired into Nexus

- The **Weekly Briefing** tab is pinned first in the tab bar and cannot be
  renamed or removed — it is a fixed destination, not a user tab.
- New browsers open on it; so does any existing dashboard the first time it
  loads a build that includes it (`homeSeen` in `nexus.dashboard.v1`).
- Punch-list state saves to `localStorage` under `ak-briefing-state`, per
  browser. There is no artifact runtime here, so the page's "saved on this
  device only" path is the one that runs.

Two files in `public/briefing/` adapt the page without editing its content —
both are linked from the page's head and both are additive, so the page still
works standalone and a weekly rebuild does not disturb them:

**`theme.css`** — the page tokenizes its whole palette, so restating those
tokens is the entire theme. Nothing here targets the page's markup.

**`bridge.js`** — live Gmail and Calendar. The page runs in a same-origin
iframe, so it calls up to `window.__nexusBriefing` on the parent
(`src/lib/briefingBridge.ts`), which fronts the app's Gmail client and the
Calendar client built on the same OAuth layer. It adds:

- a **Live data** strip under the masthead: connect, sync, and status;
- a **Live inbox** section at the top of Actions & Inbox — the top messages of
  the last 72 hours, ranked by the dashboard's own priority score;
- a **Live calendar** section at the top of Calendar — the next 14 days across
  every calendar you have switched on, linked by the API's `htmlLink`.

Live rows are ordinary `.cat-row`s carrying `data-sync`, so the page's
`injectCheckables()` treats them as first-class: same checkbox, same quick
actions, same punch-list entry — and a stable sync key means a queued item
keeps its entry across syncs. They deliberately carry **no `data-cat`**: the
punch list only renders categories in its own fixed `CATEGORIES` list, so
letting the page's `inferCategory()` classify them is what keeps a queued item
from vanishing.

One consent covers `gmail.readonly` and `calendar.readonly`, and the session is
shared with every dashboard widget. With no Client ID configured the sections
render sample data, badged as such. Opened as a standalone file — OAuth lives
in the app — the strip says so and the briefing behaves exactly as before.

## Quick start

`npm run dev`, then Nexus opens on the briefing. Or open
`public/weekly-briefing.html` directly in any browser — everything is inline,
no build step, no server.

## The one-paragraph mental model

Data flows one way: Gmail + Calendar → normalize (ET dates, real links, thread
histories) → categorize + severity-rate → render tabs. The user flows the other
way: checking any item QUEUES it to the punch list (checking ≠ done); the punch
list is the single working surface — completion (date-stamped), sub-steps,
statuses, edits, and the masthead Critical/High counters all live there, and it
persists across weekly rebuilds. Duplicated items (a critical top action and its
category twin) share a sync key so they act as one.

The full contract is in `prompts/Weekly_Briefing_Master_Prompt.md` — treat it as
the product spec.

## Rebuilding weekly / refreshing daily

The master prompt is written to be run by Claude (Cowork or Claude Code) with
Gmail + Google Calendar connectors attached. Weekly: full 14-day/7-day sweep,
**ALWAYS** carrying the punch-list state forward. To ship a rebuild here, write
the regenerated page over `public/weekly-briefing.html` and commit — no React
changes are needed, but **re-add the two `public/briefing/` lines** in the
page's head (they sit right after the closing `</style>`). Forgetting costs a
flash of the original theme, not the integration: `WeeklyBriefing.tsx` injects
them if they are missing.

Day to day you do not need a rebuild at all — **↻ Sync now** in the Live data
strip pulls fresh mail and events into the page directly. The 🔄 Refresh button
still copies the standing prompt, which is the different and larger job:
regenerating the whole curated briefing — categorized bands, drafts, logistics,
the vault — which is the LLM's work, not an API call.

## Where to take it next

See `docs/ARCHITECTURE.md` for the state model and extension points. Its Phase 1
roadmap — browser OAuth, live refresh from the page itself — is now done via the
bridge, with no backend. What is still open: the curated content (bands, drafts,
severity ratings, logistics) is still written at rebuild time rather than
derived live, and additional mailboxes would each need their own connection.
