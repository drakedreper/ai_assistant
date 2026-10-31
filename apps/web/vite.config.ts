import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// `vite build --mode single` produces one self-contained index.html (a clickable copy of the mockup).
// A mode flag instead of an env var keeps the script working in PowerShell and cmd on Windows.
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === 'single' ? [viteSingleFile()] : [])],
  resolve: { dedupe: ['react', 'react-dom', 'three'] },
  server: { host: '127.0.0.1', port: 5173 },
  build: { chunkSizeWarningLimit: 2500 },
}))
