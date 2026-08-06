import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // GitHub Pages serves a project site under /<repo>/, so the production
  // build needs that base path. Local `vite dev` stays at the root.
  // Override with VITE_BASE if you deploy somewhere else (custom domain, etc.).
  base:
    command === 'build' ? process.env.VITE_BASE ?? '/Nexus/' : '/',
  server: {
    port: 5173,
  },
}))
