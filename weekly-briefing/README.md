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
└── weekly-briefing.html          # The complete working page — served as-is, mounted by the app
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
changes are needed. Daily: the page's 🔄 Refresh button copies a standing prompt
that re-sweeps the last 24h; items received today self-badge "NEW" on load.

## Where to take it next

See `docs/ARCHITECTURE.md` for the state model, extension points, and a
suggested path from this static page to a real backed app (OAuth, live refresh
from the button itself, multi-account email). Now that the briefing ships inside
a React app with a Gmail OAuth client already wired up
(`src/lib/gmail.ts`), Phase 1 of that roadmap has a much shorter path: the
refresh could run in the app and hand the page a fresh payload.
