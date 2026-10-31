import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// SINGLEFILE=1 builds one self-contained index.html (used to publish a clickable copy of the mockup).
const single = process.env.SINGLEFILE === '1'

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(single ? [viteSingleFile()] : [])],
  resolve: { dedupe: ['react', 'react-dom', 'three'] },
  server: { host: '127.0.0.1', port: 5173 },
  build: { chunkSizeWarningLimit: 2500 },
})
