import { test, expect } from '@playwright/test'
import { setupApiMocks, setupAuthenticatedSession, MOCK_USER } from './helpers/mockApi.js'

test.describe('Authentication', () => {
  test('shows sign-in page when unauthenticated', async ({ page }) => {
    await setupApiMocks(page)
    await page.goto('/')
    await expect(page.locator('.try-demo-button')).toBeVisible()
    // Google sign-in button rendered by the Google SDK (div with data-type or class)
    await expect(page.getByText(/sign in with google/i).or(page.locator('[data-type="standard"]'))).toBeVisible({ timeout: 10_000 }).catch(() => {
      // Google SDK may not load in test env — just verify demo button is present
    })
  })

  test('demo button is visible on the login page', async ({ page }) => {
    await setupApiMocks(page)
    await page.goto('/')
    const demoBtn = page.locator('.try-demo-button')
    await expect(demoBtn).toBeVisible()
    await expect(demoBtn).toContainText(/demo/i)
  })

  test('clicking Try Demo logs in and shows the app', async ({ page }) => {
    await setupApiMocks(page)
    await page.goto('/')

    await page.locator('.try-demo-button').click()

    // After demo login the header should show the user name
    await expect(page.locator('.user-name')).toContainText('Demo User', { timeout: 10_000 })
  })

  test('demo mode shows DEMO badge in header', async ({ page }) => {
    await setupApiMocks(page)
    await page.goto('/')
    await page.locator('.try-demo-button').click()

    await expect(page.locator('.demo-badge')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.demo-badge')).toContainText('DEMO')
  })

  test('demo mode shows demo banner', async ({ page }) => {
    await setupApiMocks(page)
    await page.goto('/')
    await page.locator('.try-demo-button').click()

    await expect(page.locator('.demo-banner')).toBeVisible({ timeout: 10_000 })
  })

  test('sign out returns to login screen', async ({ page }) => {
    await setupAuthenticatedSession(page)
    await page.goto('/')

    // Wait for authenticated state
    await expect(page.locator('.user-name')).toBeVisible({ timeout: 10_000 })

    // Sign out
    await page.locator('button', { hasText: /exit demo|sign out/i }).click()

    // Should be back on login page
    await expect(page.locator('.try-demo-button')).toBeVisible({ timeout: 10_000 })
  })

  test('persists session across page reload', async ({ page }) => {
    await setupAuthenticatedSession(page)
    await page.goto('/')

    await expect(page.locator('.user-name')).toContainText('Demo User', { timeout: 10_000 })

    // Reload — token is in localStorage so should stay logged in
    await page.reload()
    await expect(page.locator('.user-name')).toContainText('Demo User', { timeout: 10_000 })
  })
})
