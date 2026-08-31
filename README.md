# Nexus Dashboard

Nexus opens on the **Weekly Briefing** — a chief-of-staff console for the week —
with tab-based dashboards of live-feed **widgets** beside it.

## Homepage: the Weekly Briefing

The pinned first tab is the [Weekly Briefing](weekly-briefing/README.md): one
self-contained page fusing a Gmail sweep and a Google Calendar sweep into a
punch list, deadline-ranked actions, a category inbox, a 14-day calendar grid,
draft replies, and a reference vault. Checking any item queues it to the punch
list, which persists in your browser across weekly rebuilds.

It is served verbatim from `public/weekly-briefing.html` and mounted in an
iframe by `src/components/WeeklyBriefing.tsx`, so its own styles and script stay
isolated from the app shell — and refreshing the week's content is a file swap,
not a code change. The homepage cannot be renamed or removed.

Two files in `public/briefing/` adapt the page to the app without touching its
content, so a weekly rebuild does not disturb either:

- **`theme.css`** restates the briefing's palette tokens as Nexus's, so it
  wears the app's dark theme. The page tokenizes every color, so this is
  variables only — no rule here targets its markup.
- **`bridge.js`** gives it **live Gmail and Calendar data**. A *Live data* strip
  under the masthead connects Google and syncs; a **Live inbox** section leads
  the Actions tab and a **Live calendar** section leads the Calendar tab. Live
  items are rendered in the page's own markup vocabulary, so they get the same
  checkbox as swept items and **queue to the punch list identically**.

Live data uses the dashboard's existing Google client: one consent covers
`gmail.readonly` and `calendar.readonly` together, and the session is shared
with every widget — connect in the briefing and the Gmail tiles are connected
too. Without a Client ID configured everything runs on sample data, and opened
as a standalone file the page says so and behaves exactly as it always did.

## Tile dashboards

Every other tab is a page holding a **5 × 5 grid of 25 tiles**; add more tabs
whenever you need more room. Drop a widget into any empty tile, remove it with
the ✕, and everything persists to your browser's `localStorage`.

## First widget: Gmail Inbox

Shows **how many new emails** landed in your inbox over a time window (default
**last 24 hours**) and **how many of those are unread**.

- **Out of the box** it runs in **sample-data mode** so you can see the whole
  dashboard working with zero setup (look for the `sample data` badge).
- **To show live numbers**, add a Google OAuth **Client ID** — either set
  `VITE_GOOGLE_CLIENT_ID` (see `.env.example`) or paste it into the widget's
  ⚙ settings. Access is read-only (`gmail.readonly`) and runs entirely in the
  browser — no backend.

### Enabling live Gmail

1. In [Google Cloud Console](https://console.cloud.google.com/), create an
   **OAuth 2.0 Client ID** of type **Web application**.
2. Under **Authorized JavaScript origins**, add the origin you serve this app
   from (e.g. `http://localhost:5173` for local dev).
3. Enable the **Gmail API** and the **Google Calendar API** for the project,
   and add the `gmail.readonly` and `calendar.readonly` scopes on the OAuth
   consent screen. (Calendar powers the homepage's live calendar; leave it off
   and the rest still works.)
4. Put the Client ID in `.env` as `VITE_GOOGLE_CLIENT_ID`, or paste it into the
   widget's ⚙ settings at runtime.

## Widgets

- **Gmail Inbox** — new emails in a time window + unread count.
- **Top Priority Emails** — ranked top-N of your inbox by a transparent priority score.
- **AI Prompt** — type a prompt in the tile's settings; the model's answer streams
  live onto the tile. Runs in demo mode until you add an Anthropic API key
  (stored only in your browser; sent directly to Anthropic).
- **Skills** — a catalog tile listing every widget available to add.

The **Top Priority Emails** tile also supports: a **search-criteria** field
(any Gmail query, ANDed with the time window), **clickable rows** that open the
message in Gmail, and a per-email **⤳ Evernote shortcut** that files it (via
Evernote email-in) into a notebook — default **Planning** — as a task
(checkbox + reminder). With **one-click send** on (default), Nexus sends it
**directly through your Gmail** (needs the `gmail.send` scope, approved once);
turn it off to open your mail app instead.

## Tile interactions

- **Move**: drag any filled tile onto another tile to move/swap it.
- **Customize** (⚙ on the tile's bottom bar): set a custom **title**, an **accent**
  color, and the widget's own settings — all in one dialog.
- **Export / import a single tile**: the Customize dialog can copy a tile
  (widget type + settings) as JSON; the "Add a widget" picker has
  *Import a tile from JSON…* to paste it back — anywhere.
- **Export / import the whole dashboard**: the header **Export** / **Import**
  buttons save and restore all tabs and tiles as a JSON file.

## Run it as a desktop app

**Install from the browser (PWA).** Open the site in Chrome/Edge and click the
**Install** icon in the address bar (or ⋮ menu → *Install Nexus*). It then opens
in its **own window** — no browser chrome — with its **own icon** in the
taskbar/dock/launcher, and works offline for the app shell.

**Native app with a system-tray icon (Electron).** For a true tray icon
(show/hide, minimize-to-tray, quit), use the Electron shell in `desktop/`:

```bash
cd desktop
npm install
npm start          # opens the app + a tray icon
npm run dist       # optional: build an installer in desktop/dist/
```

See `desktop/README.md` for details.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build to dist/
npm run preview    # serve the production build
```

## Architecture

Widgets are self-contained and registered in one place, so adding a new one is
a small, isolated change:

```
public/
  weekly-briefing.html  # the homepage, served as-is (swap it to refresh the week)
  briefing/
    theme.css           # restates the page's palette tokens as the app's
    bridge.js           # live Gmail + Calendar inside the page
weekly-briefing/        # the briefing's spec, sample data, and architecture notes
src/
  lib/          # types, storage, id, Gmail + Calendar clients, briefing bridge
  widgets/
    types.ts        # WidgetDefinition / props contract
    registry.ts     # <-- add new widgets here
    GmailInboxWidget.tsx
  components/    # TabBar, DashboardGrid, Tile, WidgetPicker, Modal, WeeklyBriefing
  App.tsx        # active view (homepage or a tab) + tile state, persistence
```

The active view is one field — `activeTabId` in the saved state — which is
either a tab id or the reserved `HOME_TAB_ID`, so the homepage costs the tile
code nothing.

`lib/calendar.ts` is built on `lib/gmail.ts`'s OAuth layer rather than its own:
`requestScopeToken` shares the client id, the GIS loader and the token cache,
and `requestScopes` gets one token for several scopes and files it under each,
so adding a Google API is a REST client, not a second sign-in.
`lib/briefingBridge.ts` publishes those two clients on `window.__nexusBriefing`
for the briefing page to call — see the comment there for the contract.

### Adding a widget

1. Create `src/widgets/MyWidget.tsx` exporting a `WidgetDefinition` (use the
   `defineWidget` helper). Give it a `type`, `name`, `description`, `icon`,
   `defaultConfig`, a `component`, and optionally a `settings` form.
2. Add it to the array in `src/widgets/registry.ts`.

That's it — it appears in the "Add a widget" picker automatically.
