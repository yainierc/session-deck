import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { deckDir } from './src/platform.js'

// In development Vite serves the UI and forwards API and WebSocket calls to
// the real server. In production the server serves dist/ with no proxy at all.

/**
 * The deck's token, read fresh on every proxied request.
 *
 * The server requires one now, and a dev server that did not present it would
 * mean pairing a browser you reload forty times an hour. Vite runs on the same
 * machine and under the same user, so it can simply read the file — this
 * grants nothing that whoever started it did not already have.
 *
 * Deliberately read per request rather than once at startup: `npm run dev`
 * launches both processes at the same moment, so on a first ever run the file
 * may not exist yet when this config is evaluated. And it never *writes* one —
 * two processes racing to mint a token would leave the server holding a
 * different one from the file.
 */
function token() {
  try {
    return JSON.parse(fs.readFileSync(path.join(deckDir(), 'auth.json'), 'utf8')).token || ''
  } catch {
    return ''
  }
}

function withToken(proxy) {
  proxy.on('proxyReq', (req) => req.setHeader('x-deck-token', token()))
  proxy.on('proxyReqWs', (req) => req.setHeader('x-deck-token', token()))
}

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5317,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4317', configure: withToken },
      '/ws': { target: 'ws://127.0.0.1:4317', ws: true, configure: withToken },
    },
  },
})
