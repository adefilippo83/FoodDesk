import { defineConfig } from '@playwright/test'

/**
 * E2E smoke test against the real production build: `npm run build` first.
 * The web server script migrates + seeds a throwaway SQLite database and
 * boots the compiled server (API + built PWA on one port), exactly like the
 * venue box runs it.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    locale: 'en-GB',
  },
  webServer: {
    command: 'node e2e/serve.mjs',
    url: 'http://127.0.0.1:3100/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
