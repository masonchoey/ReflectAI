import { defineConfig, devices } from '@playwright/test'

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'
const isLocal = BASE_URL.startsWith('http://localhost')

export default defineConfig({
  testDir: './e2e',
  // Connectivity tests run separately via playwright.connectivity.config.js
  testIgnore: ['**/connectivity.spec.js'],
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Generous timeouts for remote URLs (Vercel in CI); negligible for localhost
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Only spin up the local Vite dev server when running against localhost.
  // When BASE_URL points to the deployed Vercel app, no local server is needed.
  ...(isLocal ? {
    webServer: {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        VITE_API_URL: process.env.VITE_API_URL || 'http://localhost:8000',
        VITE_GOOGLE_CLIENT_ID: process.env.VITE_GOOGLE_CLIENT_ID || 'test-client-id',
        VITE_SUPABASE_URL: '',
        VITE_SUPABASE_ANON_KEY: '',
      },
    },
  } : {}),
})
