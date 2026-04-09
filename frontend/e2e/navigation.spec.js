import { test, expect } from '@playwright/test'
import { setupAuthenticatedSession } from './helpers/mockApi.js'

test.describe('Tab Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page)
    await page.goto('/')
    // Wait for authenticated app to load
    await expect(page.locator('.user-name')).toBeVisible({ timeout: 10_000 })
  })

  test('renders three main tabs', async ({ page }) => {
    await expect(page.getByRole('button', { name: /entries/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /clusters/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /therapy/i })).toBeVisible()
  })

  test('Entries tab is active by default', async ({ page }) => {
    const entriesTab = page.getByRole('button', { name: /entries/i })
    await expect(entriesTab).toHaveClass(/active/)
  })

  test('clicking Clusters tab shows clustering UI', async ({ page }) => {
    await page.getByRole('button', { name: /clusters/i }).click()
    // Clustering section should appear
    await expect(page.getByRole('button', { name: /run clustering/i })).toBeVisible({ timeout: 5_000 })
  })

  test('clicking Therapy tab shows therapy UI', async ({ page }) => {
    await page.getByRole('button', { name: /therapy/i }).click()
    // Therapy input should appear
    await expect(page.locator('textarea, input[type="text"]').last()).toBeVisible({ timeout: 5_000 })
  })

  test('can switch back to Entries tab from Clusters', async ({ page }) => {
    await page.getByRole('button', { name: /clusters/i }).click()
    await page.getByRole('button', { name: /entries/i }).click()
    // Entries content should be visible again
    await expect(page.locator('textarea[placeholder]').first()).toBeVisible({ timeout: 5_000 })
  })
})
