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
        changeOrigin: true,
      },
    },
  },
  build: {
    // Fastify serves this folder in production.
    outDir: '../server/public',
    emptyOutDir: true,
  },
})
