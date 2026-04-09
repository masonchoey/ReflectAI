import { test, expect } from '@playwright/test'
import { setupAuthenticatedSession, MOCK_ENTRIES } from './helpers/mockApi.js'

test.describe('Journal Entries', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page)
    await page.goto('/')
    await expect(page.locator('.user-name')).toBeVisible({ timeout: 10_000 })
  })

  test('displays existing entries after login', async ({ page }) => {
    await expect(page.getByText('Morning Reflection')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('Evening Thoughts')).toBeVisible()
  })

  test('shows entry content', async ({ page }) => {
    await expect(
      page.getByText('Feeling grateful and energized today')
    ).toBeVisible({ timeout: 10_000 })
  })

  test('shows emotion label on entries that have it', async ({ page }) => {
    // Entry 1 has emotion: 'joy'
    await expect(page.getByText(/joy/i).first()).toBeVisible({ timeout: 10_000 })
  })

  test('new entry form is visible', async ({ page }) => {
    // Content textarea and submit button should be on the entries tab
    const textarea = page.locator('textarea').first()
    await expect(textarea).toBeVisible({ timeout: 5_000 })
  })

  test('creates a new entry', async ({ page }) => {
    const API = 'http://localhost:8000'
    const newEntry = {
      id: 99,
      title: 'Test Entry',
      content: 'Created during E2E test',
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

    // Override GET /entries to include the new entry after creation
    let created = false
    await page.route(`${API}/entries`, route => {
      if (route.request().method() === 'POST') {
        created = true
        return route.fulfill({ json: newEntry })
      }
      // Return expanded list after creation
      const list = created ? [...MOCK_ENTRIES, newEntry] : MOCK_ENTRIES
      return route.fulfill({ json: list })
    })

    // Fill in entry content
    const textarea = page.locator('textarea').first()
    await textarea.fill('Created during E2E test')

    // Fill optional title if present
    const titleInput = page.locator('input[placeholder*="title" i]')
    if (await titleInput.isVisible()) {
      await titleInput.fill('Test Entry')
    }

    // Submit
    await page.getByRole('button', { name: /add entry|save|submit/i }).first().click()

    await expect(page.getByText('Created during E2E test')).toBeVisible({ timeout: 10_000 })
  })

  test('edit button appears on entry hover/click', async ({ page }) => {
    // At least one edit control should exist in the entries list
    const editBtn = page.getByRole('button', { name: /edit/i }).first()
    await expect(editBtn).toBeVisible({ timeout: 10_000 })
  })

  test('can enter edit mode for an entry', async ({ page }) => {
    await page.getByRole('button', { name: /edit/i }).first().click()
    // An editable text area or input should now be visible
    await expect(page.locator('textarea').first()).toBeVisible()
  })

  test('delete button appears on entries', async ({ page }) => {
    const deleteBtn = page.getByRole('button', { name: /delete/i }).first()
    await expect(deleteBtn).toBeVisible({ timeout: 10_000 })
  })
})
