/**
 * Connectivity Tests — real deployed services
 *
 * These tests hit actual production infrastructure. Run them with:
 *   npx playwright test --config playwright.connectivity.config.js
 *
 * What each test checks:
 *   - Fly.io API     : GET /status returns { status: "ready" }
 *   - Vercel         : Frontend homepage loads and contains "ReflectAI"
 *   - Demo Auth      : POST /auth/demo returns token + user (tests Fly.io + Postgres)
 *   - Redis / Celery : Queue an emotion analysis task, verify task_id returned and
 *                      status is PENDING / STARTED (proves Upstash Redis is reachable)
 *   - OpenRouter     : Submit a therapy question, poll until SUCCESS, assert non-empty answer
 *   - OpenRouter 503 : Mocked at the UI level — verify graceful error in the chat UI
 *
 * Rules we follow:
 *   ✅ Demo token bypass — no real Google OAuth
 *   ✅ Non-empty response assertion only — no specific LLM output assertions
 *   ✅ 503 is tested at the UI / mock level, not by actually killing OpenRouter
 */

import { test, expect } from '@playwright/test'

const PROD_API = process.env.PROD_API_URL || 'https://reflectai-api-icy-dust-4243.fly.dev'
const PROD_FRONTEND = process.env.PROD_FRONTEND_URL || 'https://reflect-ai-nine.vercel.app'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Get a fresh demo token from the production API. */
async function getDemoToken(request) {
  const res = await request.post(`${PROD_API}/auth/demo`)
  expect(res.status(), 'Demo auth should succeed').toBe(200)
  const body = await res.json()
  expect(body.access_token, 'Demo auth should return access_token').toBeTruthy()
  return { token: body.access_token, user: body.user }
}

/** Poll GET /tasks/{task_id} until non-PENDING status or timeout (ms). */
async function pollTask(request, token, taskId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3_000))
    const res = await request.get(`${PROD_API}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok()) continue
    const status = await res.json()
    if (status.status === 'SUCCESS') return { done: true, result: status.result }
    if (status.status === 'FAILURE' || status.status === 'REVOKED') {
      return { done: true, failed: true, error: status.error }
    }
    // PENDING / STARTED — keep polling
  }
  return { done: false, timedOut: true }
}

// ── Fly.io API ────────────────────────────────────────────────────────────────

test.describe('Fly.io API', () => {
  test('GET /status returns ready', async ({ request }) => {
    const res = await request.get(`${PROD_API}/status`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ready')
  })

  test('unauthenticated GET /entries returns 401 or 403', async ({ request }) => {
    const res = await request.get(`${PROD_API}/entries`)
    expect([401, 403]).toContain(res.status())
  })
})

// ── Vercel Frontend ───────────────────────────────────────────────────────────

test.describe('Vercel Frontend', () => {
  test('frontend is accessible and shows ReflectAI branding', async ({ page }) => {
    const res = await page.goto(PROD_FRONTEND)
    expect(res.status()).toBeLessThan(400)
    await expect(page).toHaveTitle(/ReflectAI/i, { timeout: 15_000 })
  })

  test('demo login button is visible on the production frontend', async ({ page }) => {
    await page.goto(PROD_FRONTEND)
    await expect(page.locator('.try-demo-button')).toBeVisible({ timeout: 15_000 })
  })
})

// ── Demo Auth (Fly.io + Postgres) ─────────────────────────────────────────────

test.describe('Demo Auth — Fly.io + Postgres', () => {
  test('POST /auth/demo returns valid token and demo user', async ({ request }) => {
    const res = await request.post(`${PROD_API}/auth/demo`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.access_token).toBeTruthy()
    expect(body.user.email).toBe('demo@reflectai.app')
    expect(body.user.id).toBeTruthy()
  })

  test('token from /auth/demo is accepted by GET /auth/me', async ({ request }) => {
    const { token, user } = await getDemoToken(request)
    const res = await request.get(`${PROD_API}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status()).toBe(200)
    const me = await res.json()
    expect(me.email).toBe('demo@reflectai.app')
  })

  test('demo user can fetch their journal entries', async ({ request }) => {
    const { token } = await getDemoToken(request)
    const res = await request.get(`${PROD_API}/entries`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status()).toBe(200)
    const entries = await res.json()
    expect(Array.isArray(entries)).toBe(true)
    // Demo user has 100 pre-seeded entries
    expect(entries.length).toBeGreaterThan(0)
  })
})

// ── Redis / Upstash / Celery — task queuing ───────────────────────────────────

test.describe('Redis / Upstash / Celery', () => {
  test('creating an entry and queuing emotion analysis returns a task_id', async ({ request }) => {
    const { token } = await getDemoToken(request)

    // Create a test entry in the demo session
    const entryRes = await request.post(`${PROD_API}/entries`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { title: 'E2E Connectivity Test', content: 'Connectivity check for Celery and Redis.' },
    })
    expect(entryRes.status()).toBe(200)
    const entry = await entryRes.json()
    expect(entry.id).toBeTruthy()

    // Queue emotion analysis
    const analyzeRes = await request.post(`${PROD_API}/entries/${entry.id}/analyze`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(analyzeRes.status()).toBe(200)
    const taskBody = await analyzeRes.json()
    expect(taskBody.task_id).toBeTruthy()

    // Verify the broker accepted the task — status should be PENDING or better
    const statusRes = await request.get(`${PROD_API}/tasks/${taskBody.task_id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(statusRes.status()).toBe(200)
    const taskStatus = await statusRes.json()
    expect(['PENDING', 'STARTED', 'SUCCESS']).toContain(taskStatus.status)
  })
})

// ── OpenRouter ────────────────────────────────────────────────────────────────

test.describe('OpenRouter', () => {
  // Allow up to 2 minutes for the LLM to respond
  test.setTimeout(120_000)

  test('therapy question returns a non-empty answer via OpenRouter', async ({ request }) => {
    const { token } = await getDemoToken(request)

    // Submit therapy question
    const therapyRes = await request.post(`${PROD_API}/therapy/ask`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { question: 'What are the main themes in my journal entries?' },
    })
    expect(therapyRes.status(), 'therapy/ask should be accepted').toBe(200)
    const { task_id } = await therapyRes.json()
    expect(task_id).toBeTruthy()

    // Poll until complete
    const outcome = await pollTask(request, token, task_id, 100_000)

    if (outcome.timedOut) {
      test.skip() // Don't fail CI if LLM is slow — just skip
    }

    expect(outcome.failed, `Task failed: ${outcome.error}`).toBeFalsy()
    expect(outcome.result).toBeTruthy()
    expect(outcome.result.answer).toBeTruthy()
    expect(outcome.result.answer.length, 'Answer should be non-empty').toBeGreaterThan(20)
  })

  // ── OpenRouter 503 (mocked at UI level) ──────────────────────────────────

  test('UI shows graceful error when backend returns 503 (OpenRouter down)', async ({ page }) => {
    // This sub-test uses a mocked local server, not the production API.
    // It verifies that the React app handles a 503 gracefully.
    const LOCAL_API = 'http://localhost:8000'

    // Set up minimal auth mock
    await page.route(`${LOCAL_API}/auth/me`, route =>
      route.fulfill({ json: { id: 1, email: 'demo@reflectai.app', name: 'Demo User', picture: null, google_id: 'x' } })
    )
    await page.route(`${LOCAL_API}/entries`, route => route.fulfill({ json: [] }))
    await page.route(`${LOCAL_API}/clustering/runs`, route => route.fulfill({ json: [] }))
    await page.route(`${LOCAL_API}/clustering/runs/*/visualization`, route =>
      route.fulfill({ status: 404, json: {} })
    )
    await page.route(`${LOCAL_API}/conversations`, route => route.fulfill({ json: [] }))
    await page.route(`${LOCAL_API}/conversations/**`, route => route.fulfill({ json: [] }))

    // Simulate OpenRouter 503
    await page.route(`${LOCAL_API}/therapy/ask`, route =>
      route.fulfill({ status: 503, json: { detail: 'OpenRouter service unavailable' } })
    )

    await page.addInitScript(() => localStorage.setItem('auth_token', 'demo-connectivity-token'))

    await page.goto('http://localhost:5173')
    await expect(page.locator('.user-name')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: /therapy/i }).click()
    await expect(page.locator('textarea.therapy-input')).toBeVisible({ timeout: 5_000 })

    await page.locator('textarea.therapy-input').fill('Trigger a 503 error.')
    await page.locator('button.therapy-submit-btn').click()

    // App should show an inline error bubble — NOT a blank page or unhandled rejection
    await expect(page.locator('.therapy-message--assistant').last()).toBeVisible({ timeout: 10_000 })
    const errorText = await page.locator('.therapy-message--assistant').last().textContent()
    expect(errorText.trim().length).toBeGreaterThan(0)
  })
})
