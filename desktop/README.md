# Nexus Desktop (Electron)

Runs the Nexus dashboard as a real desktop app with a **system-tray icon**
(show/hide, reload, quit) and minimize-to-tray.

## Run it

```bash
cd desktop
npm install      # downloads Electron (~100 MB) the first time
npm start
```

A native window opens loading the hosted dashboard, and a Nexus icon appears in
your **system tray / menu bar**. Closing the window hides it to the tray; use
the tray menu (or click the tray icon) to bring it back, or to Quit.

- Point it at a local dev build instead of the hosted site:
  ```bash
  NEXUS_URL=http://localhost:5173/Nexus/ npm start
  ```

## Build an installer

```bash
npm run dist
```

`electron-builder` produces a platform installer/app in `desktop/dist/`
(`.AppImage` on Linux, `.dmg` on macOS, `.exe` on Windows). For polished
Windows/macOS icons you can supply a `.ico` / `.icns` in `build.win.icon` /
`build.mac.icon`; the included `icon.png` works out of the box.

Notes:
- The window loads the live site, so Gmail/OAuth uses the same authorized
  origin (`https://kaboom82ash.github.io`) — the Google sign-in popup is
  allowed to open inside the app; other links open in your default browser.
