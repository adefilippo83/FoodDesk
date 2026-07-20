import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    // Phones on the venue Wi-Fi hit the dev server directly.
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_TARGET ?? 'http://localhost:3000',
        // Deliberately NOT changeOrigin: the server's CSRF guard compares the
        // Origin header against Host, so the browser's real Host must pass
        // through. changeOrigin would rewrite it to :3000 and every write
        // through the dev proxy would be rejected as bad_origin.
      },
    },
  },
  build: {
    // Fastify serves this folder in production.
    outDir: '../server/public',
    emptyOutDir: true,
  },
})
