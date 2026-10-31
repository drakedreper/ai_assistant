import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// The local daemon (apps/daemon). In development the browser talks to the Vite server only and Vite forwards /api and
// /ws, so the app, the REST calls, the WebSocket and the daemon's session cookie are all one origin (the daemon sends
// no CORS headers on purpose). Override with DAEMON_URL, e.g. `set DAEMON_URL=http://127.0.0.1:7500` (cmd) or
// `$env:DAEMON_URL = 'http://127.0.0.1:7500'` (PowerShell). /hooks is not proxied: Claude Code talks to the daemon directly.
const DAEMON_URL = (process.env.DAEMON_URL ?? '').trim() || 'http://127.0.0.1:7421'

// `vite build --mode single` produces one self-contained index.html (a clickable copy of the mockup).
// A mode flag instead of an env var keeps the script working in PowerShell and cmd on Windows.
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === 'single' ? [viteSingleFile()] : [])],
  resolve: { dedupe: ['react', 'react-dom', 'three'] },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      // changeOrigin rewrites Host to the daemon's own (it only accepts 127.0.0.1:PORT and localhost:PORT).
      // The browser's Origin (http://127.0.0.1:5173) passes through; the daemon allows it as a dev origin.
      '/api': { target: DAEMON_URL, changeOrigin: true },
      '/ws': { target: DAEMON_URL, ws: true, changeOrigin: true },
    },
  },
  build: { chunkSizeWarningLimit: 2500 },
}))
