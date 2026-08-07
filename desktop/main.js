// Nexus desktop shell (Electron): a native window + a real system-tray icon.
// By default it loads the hosted dashboard; override with NEXUS_URL to point at
// a local dev server (e.g. NEXUS_URL=http://localhost:5173/Nexus/).
const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require('electron')
const path = require('path')

const APP_URL = process.env.NEXUS_URL || 'https://kaboom82ash.github.io/Nexus/'

let win = null
let tray = null
let quitting = false

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 480,
    minHeight: 480,
    backgroundColor: '#0b0d12',
    title: 'Nexus',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  })

  win.loadURL(APP_URL)

  // Article / email links open in the real browser; let Google's OAuth popup
  // open inside the app so the sign-in flow can complete.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://accounts.google.com')) return { action: 'allow' }
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Closing the window hides to the tray instead of quitting.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
    }
  })
}

function toggleWindow() {
  if (!win) return createWindow()
  if (win.isVisible()) win.hide()
  else {
    win.show()
    win.focus()
  }
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'tray.png'))
  tray = new Tray(img)
  tray.setToolTip('Nexus Dashboard')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Nexus', click: () => { if (win) { win.show(); win.focus() } else createWindow() } },
      { label: 'Reload', click: () => win && win.reload() },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit() } },
    ]),
  )
  tray.on('click', toggleWindow)
}

// Single-instance: focus the existing window instead of opening a second one.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus() }
  })
  app.whenReady().then(() => {
    createWindow()
    createTray()
  })
  // Keep running in the tray after the window is closed.
  app.on('window-all-closed', () => {})
  app.on('before-quit', () => { quitting = true })
  app.on('activate', () => { if (win) win.show(); else createWindow() })
}
