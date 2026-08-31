# AK Daily Digest — the Nexus homepage

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

**`bridge.js`** — live Gmail and Calendar. It also rebuilds the masthead: a
prominent **Last sync** stamp with what arrived since the previous sync (a real
id diff, not a timestamp guess — mail that landed while the tab was shut is new
to the reader whatever its date), and three stat rows replacing the page's own
strip — punch list totals by severity; upcoming calendar events with a meetings
count that excludes routines, proposed meeting time and hours per category for
the next 7 days; then new emails in the last 24 hours. The page's original strip
is hidden with an inline style, not the `hidden` attribute, whose UA-sheet
`display:none` loses to the page's own `display:grid`. The page runs in a same-origin
iframe, so it calls up to `window.__nexusBriefing` on the parent
(`src/lib/briefingBridge.ts`), which fronts the app's Gmail client and the
Calendar client built on the same OAuth layer. It adds:

- a **Live data** strip under the masthead: one chip per service — ✉️ Gmail and
  📅 Calendar — plus status and a manual sync. Each service connects on its own
  because Google's consent screen lets you approve one scope and refuse the
  other, and a single merged indicator would hide that. A chip shows `!` when
  its scope is granted but the API still fails (the classic case: the Calendar
  API is not enabled on the Cloud project) — a granted-but-broken service must
  not read as a reassuring tick — and stays clickable to retry consent;
- **automatic updates**: once a service is connected the page re-syncs every 5
  minutes on its own. Polling pauses while the tab is hidden rather than
  spending API quota on a background tab, and catches up on return if the last
  sync is more than 2 minutes old;
- a **Live inbox** section at the top of Actions & Inbox — the top messages of
  the last 72 hours, ranked by the dashboard's own priority score;
- a **Live calendar** section at the top of Calendar — the next 14 days across
  every calendar you have switched on, linked by the API's `htmlLink`.

Every checkable row also carries a **✓ close** control. The page's own contract
is that checking a box *queues* an item and completion happens on the punch
list — right for triage, but it means a row you have already dealt with returns
on every sweep. ✓ completes it in place, recorded as a done punch-list entry so
the decision survives rebuilds and can be reopened from its tile.

Anything already past is dropped: calendar events before now, prep blocks for
meetings that have happened (which otherwise inflate the prep time you are
being asked to find), and sweep-time headers naming a date gone by. Mail is not
filtered this way — a week-old email can still need answering, so the lookback
range governs it instead.

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

Day to day you do not need a rebuild at all — the page syncs itself every 5
minutes, and **↻ Sync now** forces it. The masthead's old 🔄 Refresh button
(which copied a rebuild prompt) is removed by the bridge: the page fetches its
own data now, so it was a button that no longer did what its label promised.
Run the master prompt when you want the *curated* layer regenerated —
categorized bands, drafts, logistics, the vault — which is the LLM's work, not
an API call.

## Where to take it next

See `docs/ARCHITECTURE.md` for the state model and extension points. Its Phase 1
roadmap — browser OAuth, live refresh from the page itself — is now done via the
bridge, with no backend. What is still open: the curated content (bands, drafts,
severity ratings, logistics) is still written at rebuild time rather than
derived live, and additional mailboxes would each need their own connection.
