/**
 * Playwright config for connectivity tests against real production services.
 *
 * Run with:
 *   npx playwright test --config playwright.connectivity.config.js
 *
 * Environment variables (optional — defaults to production URLs):
 *   PROD_API_URL        https://reflectai-api-icy-dust-4243.fly.dev
 *   PROD_FRONTEND_URL   https://reflect-ai-nine.vercel.app
 */
import { defineConfig, devices } from '@playwright/test'

const PROD_FRONTEND = process.env.PROD_FRONTEND_URL || 'https://reflect-ai-nine.vercel.app'

export default defineConfig({
  testDir: './e2e',
  testMatch: ['**/connectivity.spec.js'],
  timeout: 120_000,   // LLM calls can be slow
  retries: 1,
  workers: 1,         // Avoid hammering the demo user concurrently
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report-connectivity' }],
  ],
  use: {
    baseURL: PROD_FRONTEND,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Generous timeouts for real network calls
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'connectivity-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // No webServer — connectivity tests hit real deployed services
})
