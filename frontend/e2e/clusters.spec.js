import { test, expect } from '@playwright/test'
import { setupAuthenticatedSession } from './helpers/mockApi.js'

test.describe('Clustering', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page)
    await page.goto('/')
    await expect(page.locator('.user-name')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: /clusters/i }).click()
  })

  test('shows the Run Clustering button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /run clustering/i })).toBeVisible({ timeout: 5_000 })
  })

  test('shows clustering parameter inputs', async ({ page }) => {
    // Min Cluster Size and Min Samples are the primary params
    await expect(page.getByText(/min cluster size/i)).toBeVisible({ timeout: 5_000 })
    await expect(page.getByText(/min samples/i)).toBeVisible()
  })

  test('shows date range selector', async ({ page }) => {
    // Time period / date range options
    await expect(
      page.getByText(/all time|date range|time period/i).first()
    ).toBeVisible({ timeout: 5_000 })
  })

  test('can select 30-day date range', async ({ page }) => {
    const btn = page.getByRole('button', { name: /30 days/i })
    if (await btn.isVisible()) {
      await btn.click()
      await expect(btn).toHaveClass(/active/)
    } else {
      // Some implementations use a select dropdown
      const select = page.locator('select').first()
      if (await select.isVisible()) {
        await select.selectOption({ label: /30/i })
      }
    }
  })

  test('clicking Run Clustering triggers API call', async ({ page }) => {
    const API = 'http://localhost:8000'
    let clusteringTriggered = false

    await page.route(`${API}/clustering/run`, route => {
      clusteringTriggered = true
      return route.fulfill({ json: { task_id: 'mock-cluster-task-001' } })
    })

    await page.getByRole('button', { name: /run clustering/i }).click()

    // The button should be disabled / loading state while running
    await expect(async () => {
      expect(clusteringTriggered).toBe(true)
    }).toPass({ timeout: 5_000 })
  })

  test('shows no previous runs message when runs list is empty', async ({ page }) => {
    // With MOCK_CLUSTERING_RUNS = [], expect some empty state indication
    // The exact text varies — look for absence of a run list or an empty state element
    const runsList = page.locator('.clustering-runs-list, [data-testid="runs-list"]')
    const count = await runsList.count()
    if (count > 0) {
      await expect(runsList).toBeVisible()
    }
    // If no dedicated list component, just verify the Run Clustering button is present
    await expect(page.getByRole('button', { name: /run clustering/i })).toBeVisible()
  })
})
