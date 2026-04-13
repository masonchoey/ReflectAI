/**
 * Category 2: Journal CRUD
 * - Create an entry, verify it appears, edit it, verify the update, delete it.
 */
import { test, expect } from '@playwright/test'
import { setupAuthenticatedSession, MOCK_ENTRIES, API } from './helpers/mockApi.js'

test.describe('Journal CRUD', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page)
    await page.goto('/')
    await expect(page.locator('.user-name')).toBeVisible({ timeout: 10_000 })
  })

  // ── Read ─────────────────────────────────────────────────────────────────

  test('lists existing entries on load', async ({ page }) => {
    await expect(page.getByText('Morning Reflection')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('Evening Thoughts')).toBeVisible()
  })

  test('shows entry content', async ({ page }) => {
    await expect(
      page.getByText(/Feeling grateful and energized today/)
    ).toBeVisible({ timeout: 10_000 })
  })

  test('shows emotion label for analyzed entries', async ({ page }) => {
    // Entry 1 has emotion: 'joy'
    await expect(page.getByText(/joy/i).first()).toBeVisible({ timeout: 10_000 })
  })

  // ── Create ────────────────────────────────────────────────────────────────

  test('creates a new entry and shows it in the list', async ({ page }) => {
    const newEntry = {
      id: 99,
      title: 'E2E Created Entry',
      content: 'Written during an automated test.',
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
    // Override entries route so GET after creation returns the new entry too
    await page.route(`${API}/entries`, route => {
      const method = route.request().method()
      if (method === 'POST') {
        created = true
        return route.fulfill({ json: newEntry })
      }
      const list = created ? [newEntry, ...MOCK_ENTRIES] : MOCK_ENTRIES
      return route.fulfill({ json: list })
    })

    // Fill the content textarea (first on the page)
    await page.locator('textarea').first().fill('Written during an automated test.')

    // Title input if present
    const titleInput = page.locator('input[placeholder*="title" i]')
    if (await titleInput.count() > 0) {
      await titleInput.first().fill('E2E Created Entry')
    }

    // Submit
    await page.getByRole('button', { name: /add entry|save entry|new entry|submit/i }).first().click()

    await expect(page.getByText('Written during an automated test.')).toBeVisible({ timeout: 10_000 })
  })

  test('form clears after successful submission', async ({ page }) => {
    const textarea = page.locator('textarea').first()
    await textarea.fill('Temporary content')
    await page.getByRole('button', { name: /add entry|save entry|new entry|submit/i }).first().click()
    // After submit, textarea should be empty
    await expect(textarea).toHaveValue('', { timeout: 10_000 })
  })

  // ── Edit ─────────────────────────────────────────────────────────────────

  test('clicking Edit shows editable fields', async ({ page }) => {
    await page.getByRole('button', { name: /edit/i }).first().click()
    // An edit textarea or input should be focusable
    const editArea = page.locator('textarea').first()
    await expect(editArea).toBeVisible()
  })

  test('can save an edited entry', async ({ page }) => {
    const updatedEntry = {
      id: 1,
      title: 'Updated Title',
      content: 'Updated content from E2E test.',
      created_at: '2026-04-01T08:00:00Z',
      edited_at: new Date().toISOString(),
      emotion: null,
      emotion_score: null,
      all_emotions: null,
      embedding: null,
      umap_x: null,
      umap_y: null,
      summary: null,
    }

    await page.route(`${API}/entries/1`, route => {
      if (route.request().method() === 'PUT') {
        return route.fulfill({ json: updatedEntry })
      }
      return route.continue()
    })

    // Click edit on first entry
    await page.getByRole('button', { name: /edit/i }).first().click()

    // Update the content textarea
    const textarea = page.locator('textarea').first()
    await textarea.fill('Updated content from E2E test.')

    // Save
    await page.getByRole('button', { name: /save|update|done/i }).first().click()

    await expect(page.getByText('Updated content from E2E test.')).toBeVisible({ timeout: 10_000 })
  })

  test('can cancel edit without saving', async ({ page }) => {
    const originalText = MOCK_ENTRIES[0].content

    await page.getByRole('button', { name: /edit/i }).first().click()

    const textarea = page.locator('textarea').first()
    await textarea.fill('This should NOT be saved')

    // Cancel
    await page.getByRole('button', { name: /cancel/i }).first().click()

    // Original content should still be showing
    await expect(page.getByText(originalText)).toBeVisible({ timeout: 5_000 })
  })

  // ── Delete ────────────────────────────────────────────────────────────────

  test('deletes an entry after confirming', async ({ page }) => {
    // Accept the confirmation dialog
    page.once('dialog', dialog => dialog.accept())

    await page.route(`${API}/entries/2`, route => {
      if (route.request().method() === 'DELETE') {
        return route.fulfill({ status: 204, body: '' })
      }
      return route.continue()
    })

    // Click delete on the second entry (id 2 — "Evening Thoughts")
    const deleteButtons = page.getByRole('button', { name: /delete/i })
    await deleteButtons.nth(1).click()

    // Entry should be removed from the list
    await expect(page.getByText('Evening Thoughts')).not.toBeVisible({ timeout: 10_000 })
  })

  test('does not delete entry if dialog is cancelled', async ({ page }) => {
    page.once('dialog', dialog => dialog.dismiss())

    const deleteButtons = page.getByRole('button', { name: /delete/i })
    await deleteButtons.nth(1).click()

    // Entry should still be visible
    await expect(page.getByText('Evening Thoughts')).toBeVisible({ timeout: 5_000 })
  })
})
