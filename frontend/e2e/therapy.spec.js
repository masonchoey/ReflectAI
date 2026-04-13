/**
 * Category 6: Therapy Q&A
 *
 * Verifies:
 *   - Submitting a question shows user message immediately
 *   - Loading indicator appears while polling
 *   - Assistant response appears once task completes
 *   - Journal research (semantic search) steps are shown and expandable
 *   - Graceful error when the backend / OpenRouter returns a 503
 *   - Graceful error when the Celery task FAILS
 */
import { test, expect } from '@playwright/test'
import { setupAuthenticatedSession, API } from './helpers/mockApi.js'
const TASK_ID = 'therapy-e2e-task-001'

const NORMAL_RESULT = {
  answer:
    'Your journals show a consistent pattern of morning gratitude and reflective thinking. You tend to process emotions through writing.',
  steps: [
    {
      tool: 'search_journals',
      tool_input: { query: 'morning gratitude reflection' },
      observation: 'Found 2 relevant entries with high similarity scores.',
    },
  ],
}

test.describe('Therapy Q&A', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page)
    await page.goto('/')
    await expect(page.locator('.user-name')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: /therapy/i }).click()
    // Wait for therapy input to be ready
    await expect(page.locator('textarea.therapy-input')).toBeVisible({ timeout: 5_000 })
  })

  // ── Happy path ────────────────────────────────────────────────────────────

  test('therapy input and submit button are visible', async ({ page }) => {
    await expect(page.locator('textarea.therapy-input')).toBeVisible()
    await expect(page.locator('button.therapy-submit-btn')).toBeVisible()
  })

  test('submit button is disabled when input is empty', async ({ page }) => {
    await expect(page.locator('button.therapy-submit-btn')).toBeDisabled()
  })

  test('submit button enables when input has text', async ({ page }) => {
    await page.locator('textarea.therapy-input').fill('What does my journal say about me?')
    await expect(page.locator('button.therapy-submit-btn')).toBeEnabled()
  })

  test('user message appears immediately after submit', async ({ page }) => {
    await page.route(`${API}/tasks/${TASK_ID}`, route =>
      route.fulfill({ json: { task_id: TASK_ID, status: 'SUCCESS', result: NORMAL_RESULT } })
    )

    await page.locator('textarea.therapy-input').fill('How do I feel about my mornings?')
    await page.locator('button.therapy-submit-btn').click()

    await expect(page.locator('.therapy-message--user')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('.therapy-message--user')).toContainText('How do I feel about my mornings?')
  })

  test('loading indicator shows while response is pending', async ({ page }) => {
    // Keep task PENDING so loading state persists during the check
    await page.route(`${API}/tasks/${TASK_ID}`, route =>
      route.fulfill({ json: { task_id: TASK_ID, status: 'PENDING', result: null } })
    )

    await page.locator('textarea.therapy-input').fill('What am I feeling today?')
    await page.locator('button.therapy-submit-btn').click()

    // "Searching your journals" loading bubble should appear
    await expect(page.locator('.therapy-thinking')).toBeVisible({ timeout: 10_000 })
  })

  test('assistant response appears after task completes', async ({ page }) => {
    let pollCount = 0
    await page.route(`${API}/tasks/${TASK_ID}`, route => {
      pollCount++
      if (pollCount === 1) {
        return route.fulfill({ json: { task_id: TASK_ID, status: 'PENDING', result: null } })
      }
      return route.fulfill({ json: { task_id: TASK_ID, status: 'SUCCESS', result: NORMAL_RESULT } })
    })

    await page.locator('textarea.therapy-input').fill('What patterns appear in my entries?')
    await page.locator('button.therapy-submit-btn').click()

    // Assistant message should appear
    await expect(page.locator('.therapy-message--assistant')).toBeVisible({ timeout: 20_000 })
    // Response text is non-empty (we don't assert specific OpenRouter content)
    const responseText = await page.locator('.therapy-answer').first().textContent()
    expect(responseText.trim().length).toBeGreaterThan(0)
  })

  test('input clears after submit', async ({ page }) => {
    await page.route(`${API}/tasks/${TASK_ID}`, route =>
      route.fulfill({ json: { task_id: TASK_ID, status: 'SUCCESS', result: NORMAL_RESULT } })
    )

    await page.locator('textarea.therapy-input').fill('A test question for clearing.')
    await page.locator('button.therapy-submit-btn').click()

    await expect(page.locator('textarea.therapy-input')).toHaveValue('', { timeout: 5_000 })
  })

  test('journal research toggle is shown when steps contain search_journals', async ({ page }) => {
    await page.route(`${API}/therapy/ask`, route =>
      route.fulfill({ json: { task_id: TASK_ID, status: 'PENDING', result: null } })
    )
    await page.route(`${API}/tasks/${TASK_ID}`, route =>
      route.fulfill({ json: { task_id: TASK_ID, status: 'SUCCESS', result: NORMAL_RESULT } })
    )

    await page.locator('textarea.therapy-input').fill('What inspires me?')
    await page.locator('button.therapy-submit-btn').click()

    await expect(page.locator('.therapy-research-toggle')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.therapy-research-toggle')).toContainText(/journal research/i)
  })

  test('expanding journal research shows observation text', async ({ page }) => {
    await page.route(`${API}/therapy/ask`, route =>
      route.fulfill({ json: { task_id: TASK_ID, status: 'PENDING', result: null } })
    )
    await page.route(`${API}/tasks/${TASK_ID}`, route =>
      route.fulfill({ json: { task_id: TASK_ID, status: 'SUCCESS', result: NORMAL_RESULT } })
    )

    await page.locator('textarea.therapy-input').fill('What inspires me?')
    await page.locator('button.therapy-submit-btn').click()

    await expect(page.locator('.therapy-research-toggle')).toBeVisible({ timeout: 20_000 })
    await page.locator('.therapy-research-toggle').click()

    await expect(page.locator('.therapy-steps')).toBeVisible()
    const obs = await page.locator('.therapy-step-observation').first().textContent()
    expect(obs.trim().length).toBeGreaterThan(0)
  })

  // ── Error paths ───────────────────────────────────────────────────────────

  test('graceful error message when POST /therapy/ask returns 503 (OpenRouter down)', async ({ page }) => {
    // Override the therapy/ask route to simulate OpenRouter / backend 503
    await page.route(`${API}/therapy/ask`, route =>
      route.fulfill({
        status: 503,
        json: { detail: 'OpenRouter service unavailable' },
      })
    )

    await page.locator('textarea.therapy-input').fill('What is my greatest strength?')
    await page.locator('button.therapy-submit-btn').click()

    // App should show an inline error message in the conversation — NOT crash
    await expect(
      page.locator('.therapy-message--assistant.therapy-error, .therapy-error').first()
    ).toBeVisible({ timeout: 10_000 })

    // The error bubble should contain a user-friendly message
    const errText = await page.locator('.therapy-message--assistant').last().textContent()
    expect(errText.trim().length).toBeGreaterThan(0)
  })

  test('graceful error message when Celery task FAILS', async ({ page }) => {
    await page.route(`${API}/tasks/${TASK_ID}`, route =>
      route.fulfill({
        json: { task_id: TASK_ID, status: 'FAILURE', result: null, error: 'LLM inference failed' },
      })
    )

    await page.locator('textarea.therapy-input').fill('What should I focus on?')
    await page.locator('button.therapy-submit-btn').click()

    // Should show error assistant bubble
    await expect(page.locator('.therapy-message--assistant').last()).toBeVisible({ timeout: 15_000 })
    const errText = await page.locator('.therapy-message--assistant').last().textContent()
    expect(errText.trim().length).toBeGreaterThan(0)
  })

  test('can start a new conversation after an error', async ({ page }) => {
    // Simulate a 503 first
    await page.route(`${API}/therapy/ask`, route =>
      route.fulfill({ status: 503, json: { detail: 'down' } })
    )

    await page.locator('textarea.therapy-input').fill('Question that will fail.')
    await page.locator('button.therapy-submit-btn').click()

    // Wait for error to appear
    await expect(page.locator('.therapy-message--assistant')).toBeVisible({ timeout: 10_000 })

    // New chat button (✏ in the sidebar header)
    await page.locator('button.therapy-new-chat-btn').click()

    // Conversation should be cleared
    await expect(page.locator('.therapy-message--user')).toHaveCount(0, { timeout: 5_000 })
    await expect(page.locator('.therapy-empty-state')).toBeVisible({ timeout: 5_000 })
  })

  // ── Multi-turn conversation ───────────────────────────────────────────────

  test('multi-turn: second question appears after first response', async ({ page }) => {
    await page.route(`${API}/tasks/${TASK_ID}`, route =>
      route.fulfill({ json: { task_id: TASK_ID, status: 'SUCCESS', result: { answer: 'First response.', steps: [] } } })
    )

    // First turn
    await page.locator('textarea.therapy-input').fill('First question.')
    await page.locator('button.therapy-submit-btn').click()

    await expect(page.locator('.therapy-message--assistant')).toBeVisible({ timeout: 20_000 })

    // Second turn — override task route to return a second result
    await page.route(`${API}/tasks/${TASK_ID}`, route =>
      route.fulfill({ json: { task_id: TASK_ID, status: 'SUCCESS', result: { answer: 'Second response.', steps: [] } } })
    )

    await page.locator('textarea.therapy-input').fill('Second question.')
    await page.locator('button.therapy-submit-btn').click()

    // Two user messages and two assistant messages
    await expect(page.locator('.therapy-message--user')).toHaveCount(2, { timeout: 20_000 })
    await expect(page.locator('.therapy-message--assistant')).toHaveCount(2, { timeout: 20_000 })
  })
})
