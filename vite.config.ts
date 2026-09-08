import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Cache-bust the briefing's sidecar files.
 *
 * Vite fingerprints everything it bundles, but files under `public/` are
 * copied out verbatim — so `briefing/bridge.js` and `briefing/theme.css` keep
 * the same URL forever. GitHub Pages serves them with a positive max-age, and
 * browsers then hold a stale copy well past a deploy: the app updates, the
 * briefing's behaviour does not, and the change looks like it never shipped.
 *
 * So stamp each reference with a hash of the file's own contents. Same bytes,
 * same URL, still cached; changed bytes, new URL, fetched immediately.
 */
function briefingCacheBust(): Plugin {
  const stamp = (html: string, dir: string, file: string) => {
    const full = resolve(dir, 'briefing', file)
    if (!existsSync(full)) return html
    const hash = createHash('sha256')
      .update(readFileSync(full))
      .digest('hex')
      .slice(0, 8)
    // Match the bare path only, so re-running never stacks query strings.
    return html.replace(
      new RegExp(`(briefing/${file.replace('.', '\\.')})(?=["'])`, 'g'),
      `$1?v=${hash}`,
    )
  }

  return {
    name: 'briefing-cache-bust',
    // public/ is copied during the build, so the emitted HTML only exists
    // once writing is done.
    closeBundle() {
      const dir = resolve(process.cwd(), 'dist')
      const page = resolve(dir, 'weekly-briefing.html')
      if (!existsSync(page)) return
      let html = readFileSync(page, 'utf8')
      html = stamp(html, dir, 'theme.css')
      html = stamp(html, dir, 'bridge.js')
      writeFileSync(page, html)
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react(), briefingCacheBust()],
  // GitHub Pages serves a project site under /<repo>/, so the production
  // build needs that base path. Local `vite dev` stays at the root.
  // Override with VITE_BASE if you deploy somewhere else (custom domain, etc.).
  base:
    command === 'build' ? process.env.VITE_BASE ?? '/Nexus/' : '/',
  server: {
    port: 5173,
  },
}))
