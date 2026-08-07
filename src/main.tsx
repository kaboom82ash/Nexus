import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Purge any previously-installed service worker + caches. An earlier SW could
// pin stale app code or trap the app in a reload/refetch loop, so we remove it
// entirely. (The PWA still installs on desktop from the manifest alone.)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((regs) => regs.forEach((r) => r.unregister()))
    .catch(() => {})
}
if (typeof caches !== 'undefined') {
  caches
    .keys()
    .then((keys) => keys.forEach((k) => caches.delete(k)))
    .catch(() => {})
}
