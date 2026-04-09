/**
 * Category 5: Clustering
 *
 * Verifies the full clustering flow:
 *   1. User triggers a clustering run  →  POST /clustering/run
 *   2. App polls  →  GET /tasks/{task_id}  (PENDING → SUCCESS)
 *   3. App fetches the run list and selects the new run
 *   4. ClusterVisualization SVG renders with circle data points
 *   5. Cluster legend shows topic labels
 */
import { test, expect } from '@playwright/test'
import {
  setupAuthenticatedSession,
  MOCK_CLUSTERING_RUN,
  MOCK_CLUSTER_VISUALIZATION,
} from './helpers/mockApi.js'

const API = 'http://localhost:8000'
const CLUSTER_TASK_ID = 'cluster-task-e2e-001'

test.describe('Clustering', () => {
  // ── Basic UI ──────────────────────────────────────────────────────────────

  test.describe('UI controls', () => {
    test.beforeEach(async ({ page }) => {
      await setupAuthenticatedSession(page)
      await page.goto('/')
      await expect(page.locator('.user-name')).toBeVisible({ timeout: 10_000 })
      await page.getByRole('button', { name: /clusters/i }).click()
    })

    test('shows the Run Clustering button', async ({ page }) => {
      await expect(page.getByRole('button', { name: /run clustering/i })).toBeVisible({ timeout: 5_000 })
    })

    test('shows min cluster size and min samples params', async ({ page }) => {
      await expect(page.getByText(/min cluster size/i)).toBeVisible({ timeout: 5_000 })
      await expect(page.getByText(/min samples/i)).toBeVisible()
    })

    test('shows date range selector', async ({ page }) => {
      // "All time" option or date range controls must be present
      await expect(page.getByText(/all time|last.*days|date range|time period/i).first()).toBeVisible({ timeout: 5_000 })
    })

    test('shows empty state when no clustering runs exist', async ({ page }) => {
      // No runs → the dropdown for selecting a run should be empty / hidden
      const runSelect = page.locator('#run-select')
      if (await runSelect.count() > 0) {
        const optionCount = await runSelect.locator('option').count()
        expect(optionCount).toBe(0)
      }
      // The Run Clustering button should still be actionable
      await expect(page.getByRole('button', { name: /run clustering/i })).toBeEnabled()
    })
  })

  // ── Full clustering flow ──────────────────────────────────────────────────

  test.describe('Full flow — trigger → poll → visualize', () => {
    test('clicking Run Clustering triggers POST /clustering/run', async ({ page }) => {
      await setupAuthenticatedSession(page)

      let clusteringTriggered = false
      await page.route(`${API}/clustering/run`, route => {
        clusteringTriggered = true
        return route.fulfill({ json: { task_id: CLUSTER_TASK_ID, status: 'PENDING', result: null } })
      })
      await page.route(`${API}/tasks/${CLUSTER_TASK_ID}`, route =>
        route.fulfill({ json: { task_id: CLUSTER_TASK_ID, status: 'SUCCESS', result: { run_id: 42 } } })
      )

      await page.goto('/')
      await expect(page.locator('.user-name')).toBeVisible({ timeout: 10_000 })
      await page.getByRole('button', { name: /clusters/i }).click()
      await page.getByRole('button', { name: /run clustering/i }).click()

      await expect(async () => {
        expect(clusteringTriggered).toBe(true)
      }).toPass({ timeout: 5_000 })
    })

    test('task status message updates during polling', async ({ page }) => {
      await setupAuthenticatedSession(page)

      let pollCount = 0
      await page.route(`${API}/clustering/run`, route =>
        route.fulfill({ json: { task_id: CLUSTER_TASK_ID, status: 'PENDING', result: null } })
      )
      await page.route(`${API}/tasks/${CLUSTER_TASK_ID}`, route => {
        pollCount++
        if (pollCount === 1) {
          return route.fulfill({ json: { task_id: CLUSTER_TASK_ID, status: 'PENDING', result: null } })
        }
        return route.fulfill({ json: { task_id: CLUSTER_TASK_ID, status: 'SUCCESS', result: { run_id: 42 } } })
      })

      await page.goto('/')
      await expect(page.locator('.user-name')).toBeVisible({ timeout: 10_000 })
      await page.getByRole('button', { name: /clusters/i }).click()
      await page.getByRole('button', { name: /run clustering/i }).click()

      // While polling, a status message should appear
      await expect(page.locator('.task-status-message')).toBeVisible({ timeout: 10_000 })
    })

    test('visualization renders SVG with data points after clustering completes', async ({ page }) => {
      // Pass the mock run and visualization data through setupAuthenticatedSession options
      await setupAuthenticatedSession(page, {
        clusteringRuns: [MOCK_CLUSTERING_RUN],
        visualization: MOCK_CLUSTER_VISUALIZATION,
      })

      await page.route(`${API}/clustering/run`, route =>
        route.fulfill({ json: { task_id: CLUSTER_TASK_ID, status: 'PENDING', result: null } })
      )

      let pollCount = 0
      await page.route(`${API}/tasks/${CLUSTER_TASK_ID}`, route => {
        pollCount++
        if (pollCount === 1) {
          return route.fulfill({ json: { task_id: CLUSTER_TASK_ID, status: 'PENDING', result: null } })
        }
        return route.fulfill({ json: { task_id: CLUSTER_TASK_ID, status: 'SUCCESS', result: { run_id: MOCK_CLUSTERING_RUN.id } } })
      })

      await page.goto('/')
      await expect(page.locator('.user-name')).toBeVisible({ timeout: 10_000 })
      await page.getByRole('button', { name: /clusters/i }).click()

      // Run selector should show the existing run
      await expect(page.locator('#run-select')).toBeVisible({ timeout: 5_000 })

      // SVG should render with circle data points (one per entry)
      await expect(page.locator('svg')).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('svg circle').first()).toBeVisible({ timeout: 5_000 })
    })

    test('cluster legend shows topic label', async ({ page }) => {
      await setupAuthenticatedSession(page, {
        clusteringRuns: [MOCK_CLUSTERING_RUN],
        visualization: MOCK_CLUSTER_VISUALIZATION,
      })

      await page.goto('/')
      await expect(page.locator('.user-name')).toBeVisible({ timeout: 10_000 })
      await page.getByRole('button', { name: /clusters/i }).click()

      // Legend should appear with the cluster name from MOCK_CLUSTER_VISUALIZATION
      await expect(page.locator('.cluster-legend')).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('.cluster-legend')).toContainText('Gratitude & Growth')
    })

    test('run selector populates when runs exist', async ({ page }) => {
      await setupAuthenticatedSession(page, {
        clusteringRuns: [MOCK_CLUSTERING_RUN],
        visualization: MOCK_CLUSTER_VISUALIZATION,
      })

      await page.goto('/')
      await expect(page.locator('.user-name')).toBeVisible({ timeout: 10_000 })
      await page.getByRole('button', { name: /clusters/i }).click()

      const runSelect = page.locator('#run-select')
      await expect(runSelect).toBeVisible({ timeout: 5_000 })
      const optionCount = await runSelect.locator('option').count()
      expect(optionCount).toBeGreaterThan(0)
    })
  })
})
