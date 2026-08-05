# Nexus Dashboard

A tab-based dashboard of live-feed **widgets**. Each tab is a page holding a
**5 × 5 grid of 25 tiles**; add more tabs whenever you need more room. Drop a
widget into any empty tile, remove it with the ✕, and everything persists to
your browser's `localStorage`.

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
3. Enable the **Gmail API** for the project, and add the `gmail.readonly`
   scope on the OAuth consent screen.
4. Put the Client ID in `.env` as `VITE_GOOGLE_CLIENT_ID`, or paste it into the
   widget's ⚙ settings at runtime.

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
src/
  lib/          # types, storage, id, Gmail client
  widgets/
    types.ts        # WidgetDefinition / props contract
    registry.ts     # <-- add new widgets here
    GmailInboxWidget.tsx
  components/    # TabBar, DashboardGrid, Tile, WidgetPicker, Modal
  App.tsx        # tab + tile state, persistence
```

### Adding a widget

1. Create `src/widgets/MyWidget.tsx` exporting a `WidgetDefinition` (use the
   `defineWidget` helper). Give it a `type`, `name`, `description`, `icon`,
   `defaultConfig`, a `component`, and optionally a `settings` form.
2. Add it to the array in `src/widgets/registry.ts`.

That's it — it appears in the "Add a widget" picker automatically.
