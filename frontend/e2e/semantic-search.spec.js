/**
 * Category 4: Semantic Search
 *
 * The app doesn't expose a standalone search UI. Semantic search is performed
 * by the LLM agent (therapy) via the `search_journals` tool. This spec verifies:
 *
 *   1. Submitting a therapy question triggers the POST /therapy/ask API
 *   2. When the task result includes steps with tool:"search_journals", the UI
 *      shows the "Journal research (N searches)" disclosure button
 *   3. Expanding that section shows the query and observation text
 *   4. Results are "relevant" in the sense that the observation text is non-empty
 *      (we don't assert on specific model output content)
 */
import { test, expect } from '@playwright/test'
import { setupAuthenticatedSession, API } from './helpers/mockApi.js'
const THERAPY_TASK_ID = 'therapy-search-task-001'

const MOCK_THERAPY_RESULT_WITH_SEARCH = {
  answer:
    'Based on your journal entries, you tend to feel most at peace during morning routines. Your entries frequently mention gratitude and a sense of clarity at the start of the day.',
  steps: [
    {
      tool: 'search_journals',
      tool_input: { query: 'morning routine peace clarity' },
      observation:
        'Found 2 relevant entries:\n1. "Morning Reflection" (score: 0.92) — Feeling grateful and energized today...\n2. "Evening Thoughts" (score: 0.71) — Had a productive day at work...',
    },
  ],
}

test.describe('Semantic Search via Therapy Q&A', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page)

    // Override therapy endpoints with search-specific responses
    await page.route(`${API}/therapy/ask`, route =>
      route.fulfill({ json: { task_id: THERAPY_TASK_ID, status: 'PENDING', result: null } })
    )

    await page.route(`${API}/conversations/messages`, route => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          json: { id: 1, conversation_id: 1, role: 'user', content: 'test', steps: null, is_error: false, created_at: new Date().toISOString() },
        })
      }
      return route.fulfill({ json: [] })
    })

    await page.goto('/')
    await expect(page.locator('.user-name')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: /therapy/i }).click()
  })

  test('submitting a question triggers POST /therapy/ask', async ({ page }) => {
    let therapyCalled = false
    await page.route(`${API}/therapy/ask`, route => {
      therapyCalled = true
      return route.fulfill({ json: { task_id: THERAPY_TASK_ID, status: 'PENDING', result: null } })
    })

    await page.route(`${API}/tasks/${THERAPY_TASK_ID}`, route =>
      route.fulfill({ json: { task_id: THERAPY_TASK_ID, status: 'SUCCESS', result: MOCK_THERAPY_RESULT_WITH_SEARCH } })
    )

    await page.locator('textarea.therapy-input').fill('What themes appear in my morning journal entries?')
    await page.locator('button.therapy-submit-btn').click()

    await expect(async () => {
      expect(therapyCalled).toBe(true)
    }).toPass({ timeout: 5_000 })
  })

  test('assistant response appears after task completes', async ({ page }) => {
    await page.route(`${API}/tasks/${THERAPY_TASK_ID}`, route =>
      route.fulfill({ json: { task_id: THERAPY_TASK_ID, status: 'SUCCESS', result: MOCK_THERAPY_RESULT_WITH_SEARCH } })
    )

    await page.locator('textarea.therapy-input').fill('What themes appear in my morning journal entries?')
    await page.locator('button.therapy-submit-btn').click()

    // User message should appear immediately
    await expect(page.locator('.therapy-message--user').first()).toBeVisible({ timeout: 5_000 })

    // Assistant response should appear after task completes
    await expect(page.locator('.therapy-message--assistant').first()).toBeVisible({ timeout: 15_000 })
  })

  test('journal research disclosure button appears when steps include search_journals', async ({ page }) => {
    await page.route(`${API}/tasks/${THERAPY_TASK_ID}`, route =>
      route.fulfill({ json: { task_id: THERAPY_TASK_ID, status: 'SUCCESS', result: MOCK_THERAPY_RESULT_WITH_SEARCH } })
    )

    await page.locator('textarea.therapy-input').fill('What gives me peace?')
    await page.locator('button.therapy-submit-btn').click()

    // "Journal research (1 search)" toggle should appear
    await expect(page.locator('.therapy-research-toggle')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.therapy-research-toggle')).toContainText(/journal research/i)
    await expect(page.locator('.therapy-research-toggle')).toContainText(/1 search/)
  })

  test('expanding journal research shows the query and observation', async ({ page }) => {
    await page.route(`${API}/tasks/${THERAPY_TASK_ID}`, route =>
      route.fulfill({ json: { task_id: THERAPY_TASK_ID, status: 'SUCCESS', result: MOCK_THERAPY_RESULT_WITH_SEARCH } })
    )

    await page.locator('textarea.therapy-input').fill('What gives me peace?')
    await page.locator('button.therapy-submit-btn').click()

    // Wait for and click the research toggle
    await expect(page.locator('.therapy-research-toggle')).toBeVisible({ timeout: 15_000 })
    await page.locator('.therapy-research-toggle').click()

    // Steps section should expand and show non-empty observation
    await expect(page.locator('.therapy-steps')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('.therapy-step-observation')).toBeVisible()
    // Observation text is non-empty (we don't assert on specific content)
    const obsText = await page.locator('.therapy-step-observation').first().textContent()
    expect(obsText.trim().length).toBeGreaterThan(0)
  })

  test('search query is visible in the step header', async ({ page }) => {
    await page.route(`${API}/tasks/${THERAPY_TASK_ID}`, route =>
      route.fulfill({ json: { task_id: THERAPY_TASK_ID, status: 'SUCCESS', result: MOCK_THERAPY_RESULT_WITH_SEARCH } })
    )

    await page.locator('textarea.therapy-input').fill('What gives me peace?')
    await page.locator('button.therapy-submit-btn').click()

    await expect(page.locator('.therapy-research-toggle')).toBeVisible({ timeout: 15_000 })
    await page.locator('.therapy-research-toggle').click()

    // The step input (query) should appear in the step header
    await expect(page.locator('.therapy-step-input')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('.therapy-step-input')).toContainText('morning routine peace clarity')
  })

  test('multiple search steps are all shown', async ({ page }) => {
    const multiSearchResult = {
      answer: 'You show patterns of resilience and curiosity.',
      steps: [
        { tool: 'search_journals', tool_input: { query: 'resilience challenges' }, observation: 'Found 2 entries about overcoming challenges.' },
        { tool: 'search_journals', tool_input: { query: 'curiosity learning' }, observation: 'Found 1 entry about exploring new ideas.' },
      ],
    }

    await page.route(`${API}/tasks/${THERAPY_TASK_ID}`, route =>
      route.fulfill({ json: { task_id: THERAPY_TASK_ID, status: 'SUCCESS', result: multiSearchResult } })
    )

    await page.locator('textarea.therapy-input').fill('What patterns define me?')
    await page.locator('button.therapy-submit-btn').click()

    await expect(page.locator('.therapy-research-toggle')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.therapy-research-toggle')).toContainText('2 searches')

    await page.locator('.therapy-research-toggle').click()
    await expect(page.locator('.therapy-step')).toHaveCount(2, { timeout: 5_000 })
  })
})
