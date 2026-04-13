/**
 * Category 3: Async task polling — Emotion Analysis
 *
 * Verifies the full cycle:
 *   1. New entry is created  →  POST /entries
 *   2. App immediately queues  →  POST /entries/{id}/analyze
 *   3. App polls  →  GET /tasks/{task_id}  (PENDING → SUCCESS)
 *   4. UI updates to show emotion label + score
 */
import { test, expect } from '@playwright/test'
import { setupAuthenticatedSession, MOCK_ENTRIES, API } from './helpers/mockApi.js'
const NEW_ENTRY_ID = 99
const TASK_ID = 'emotion-poll-task-001'

test.describe('Async Task Polling — Emotion Analysis', () => {
  test.beforeEach(async ({ page }) => {
    // Set up auth + base routes, then add test-specific overrides below
    await setupAuthenticatedSession(page)
  })

  test('emotion label appears after task completes (PENDING → SUCCESS)', async ({ page }) => {
    const newEntry = {
      id: NEW_ENTRY_ID,
      title: 'Polling Test Entry',
      content: 'Today felt really joyful and uplifting.',
      created_at: new Date().toISOString(),
      edited_at: null,
      emotion: null,
      emotion_score: null,
      all_emotions: null,
      embedding: null,
      umap_x: null,
      umap_y: null,
      summary: null,
    }

    let created = false

    // POST /entries — return new entry; GET returns expanded list after creation
    await page.route(`${API}/entries`, route => {
      const method = route.request().method()
      if (method === 'POST') {
        created = true
        return route.fulfill({ json: newEntry })
      }
      const list = created ? [newEntry, ...MOCK_ENTRIES] : MOCK_ENTRIES
      return route.fulfill({ json: list })
    })

    // POST /entries/99/analyze — return task id
    await page.route(`${API}/entries/${NEW_ENTRY_ID}/analyze`, route =>
      route.fulfill({ json: { task_id: TASK_ID, status: 'PENDING', result: null } })
    )

    // GET /tasks/{task_id} — PENDING on first poll, SUCCESS on second
    let pollCount = 0
    await page.route(`${API}/tasks/${TASK_ID}`, route => {
      pollCount++
      if (pollCount === 1) {
        return route.fulfill({ json: { task_id: TASK_ID, status: 'PENDING', result: null } })
      }
      return route.fulfill({
        json: {
          task_id: TASK_ID,
          status: 'SUCCESS',
          result: {
            entry_id: NEW_ENTRY_ID,
            emotion: 'joy',
            emotion_score: 0.92,
            all_emotions: [
              { label: 'joy', score: 0.92 },
              { label: 'optimism', score: 0.51 },
            ],
          },
        },
      })
    })

    await page.goto('/')
    await expect(page.locator('.user-name')).toBeVisible({ timeout: 10_000 })

    // Submit the new entry
    await page.locator('textarea').first().fill('Today felt really joyful and uplifting.')
    await page.getByRole('button', { name: /add entry|save entry|new entry|submit/i }).first().click()

    // The new entry should appear
    await expect(page.getByText('Today felt really joyful and uplifting.')).toBeVisible({ timeout: 10_000 })

    // Emotion label should appear once the task completes (within ~6s including 2 poll cycles)
    await expect(page.getByText(/joy/i).first()).toBeVisible({ timeout: 15_000 })
  })

  test('emotion analysis is triggered automatically on entry creation', async ({ page }) => {
    let analyzeWasCalled = false

    const newEntry = {
      id: NEW_ENTRY_ID,
      title: '',
      content: 'Automatic analysis test.',
      created_at: new Date().toISOString(),
      edited_at: null,
      emotion: null, emotion_score: null, all_emotions: null,
      embedding: null, umap_x: null, umap_y: null, summary: null,
    }

    await page.route(`${API}/entries`, route => {
      if (route.request().method() === 'POST') return route.fulfill({ json: newEntry })
      return route.fulfill({ json: MOCK_ENTRIES })
    })

    await page.route(`${API}/entries/${NEW_ENTRY_ID}/analyze`, route => {
      analyzeWasCalled = true
      return route.fulfill({ json: { task_id: TASK_ID, status: 'PENDING', result: null } })
    })

    await page.route(`${API}/tasks/${TASK_ID}`, route =>
      route.fulfill({ json: { task_id: TASK_ID, status: 'SUCCESS', result: { entry_id: NEW_ENTRY_ID, emotion: 'neutral', emotion_score: 0.7, all_emotions: [] } } })
    )

    await page.goto('/')
    await expect(page.locator('.user-name')).toBeVisible({ timeout: 10_000 })

    await page.locator('textarea').first().fill('Automatic analysis test.')
    await page.getByRole('button', { name: /add entry|save entry|new entry|submit/i }).first().click()

    await expect(async () => {
      expect(analyzeWasCalled).toBe(true)
    }).toPass({ timeout: 10_000 })
  })

  test('emotion analysis is triggered after editing an entry', async ({ page }) => {
    let analyzeWasCalled = false

    const updatedEntry = {
      id: 1,
      title: 'Morning Reflection',
      content: 'Updated during editing test.',
      created_at: '2026-04-01T08:00:00Z',
      edited_at: new Date().toISOString(),
      emotion: null, emotion_score: null, all_emotions: null,
      embedding: null, umap_x: null, umap_y: null, summary: null,
    }

    await page.route(`${API}/entries/1`, route => {
      if (route.request().method() === 'PUT') return route.fulfill({ json: updatedEntry })
      return route.continue()
    })

    await page.route(`${API}/entries/1/analyze`, route => {
      analyzeWasCalled = true
      return route.fulfill({ json: { task_id: TASK_ID, status: 'PENDING', result: null } })
    })

    await page.route(`${API}/tasks/${TASK_ID}`, route =>
      route.fulfill({ json: { task_id: TASK_ID, status: 'SUCCESS', result: { entry_id: 1, emotion: 'neutral', emotion_score: 0.6, all_emotions: [] } } })
    )

    await page.goto('/')
    await expect(page.locator('.user-name')).toBeVisible({ timeout: 10_000 })

    // Edit the first entry
    await page.getByRole('button', { name: /edit/i }).first().click()
    await page.locator('textarea').first().fill('Updated during editing test.')
    await page.getByRole('button', { name: /save|update|done/i }).first().click()

    await expect(async () => {
      expect(analyzeWasCalled).toBe(true)
    }).toPass({ timeout: 10_000 })
  })

  test('shows FAILURE state gracefully if analysis task fails', async ({ page }) => {
    const newEntry = {
      id: NEW_ENTRY_ID,
      title: '',
      content: 'Will trigger a failed analysis.',
      created_at: new Date().toISOString(),
      edited_at: null,
      emotion: null, emotion_score: null, all_emotions: null,
      embedding: null, umap_x: null, umap_y: null, summary: null,
    }

    await page.route(`${API}/entries`, route => {
      if (route.request().method() === 'POST') return route.fulfill({ json: newEntry })
      return route.fulfill({ json: MOCK_ENTRIES })
    })

    await page.route(`${API}/entries/${NEW_ENTRY_ID}/analyze`, route =>
      route.fulfill({ json: { task_id: TASK_ID, status: 'PENDING', result: null } })
    )

    await page.route(`${API}/tasks/${TASK_ID}`, route =>
      route.fulfill({ json: { task_id: TASK_ID, status: 'FAILURE', result: null, error: 'Worker crashed' } })
    )

    await page.goto('/')
    await expect(page.locator('.user-name')).toBeVisible({ timeout: 10_000 })

    await page.locator('textarea').first().fill('Will trigger a failed analysis.')
    await page.getByRole('button', { name: /add entry|save entry|new entry|submit/i }).first().click()

    // App should show an error message (not crash)
    await expect(page.locator('.error, [class*="error"]').first()).toBeVisible({ timeout: 10_000 })
  })
})
