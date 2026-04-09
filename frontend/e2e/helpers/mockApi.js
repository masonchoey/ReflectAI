/**
 * Shared API mock data and route setup for Playwright E2E tests.
 * All tests mock the backend (http://localhost:8000) via page.route()
 * so no real backend is needed in CI.
 */

export const MOCK_TOKEN = 'e2e-test-token-abc123'

export const MOCK_USER = {
  id: 1,
  email: 'demo@reflectai.app',
  name: 'Demo User',
  picture: null,
  google_id: 'demo_test_123',
}

export const MOCK_ENTRIES = [
  {
    id: 1,
    title: 'Morning Reflection',
    content: 'Feeling grateful and energized today. Ready to take on new challenges.',
    created_at: '2026-04-01T08:00:00Z',
    edited_at: null,
    emotion: 'joy',
    emotion_score: 0.88,
    all_emotions: [
      { label: 'joy', score: 0.88 },
      { label: 'optimism', score: 0.45 },
    ],
    embedding: null,
    umap_x: null,
    umap_y: null,
    summary: null,
  },
  {
    id: 2,
    title: 'Evening Thoughts',
    content: 'Had a productive day at work. Feeling accomplished but a little tired.',
    created_at: '2026-04-02T20:00:00Z',
    edited_at: null,
    emotion: null,
    emotion_score: null,
    all_emotions: null,
    embedding: null,
    umap_x: null,
    umap_y: null,
    summary: null,
  },
]

export const MOCK_CLUSTERING_RUNS = []

export const MOCK_CONVERSATIONS = []

/**
 * Set up all standard API mocks for an authenticated session.
 * Call this at the start of each test that needs auth.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function setupApiMocks(page) {
  const API = 'http://localhost:8000'

  // Auth
  await page.route(`${API}/auth/me`, route =>
    route.fulfill({ json: MOCK_USER })
  )
  await page.route(`${API}/auth/demo`, route =>
    route.fulfill({ json: { access_token: MOCK_TOKEN, user: MOCK_USER } })
  )

  // Entries
  await page.route(`${API}/entries`, route => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: MOCK_ENTRIES })
    }
    // POST — create entry: echo back a new entry
    return route.request().postDataJSON().then(body =>
      route.fulfill({
        json: {
          id: 99,
          title: body.title || '',
          content: body.content,
          created_at: new Date().toISOString(),
          edited_at: null,
          emotion: null,
          emotion_score: null,
          all_emotions: null,
          embedding: null,
          umap_x: null,
          umap_y: null,
          summary: null,
        },
      })
    )
  })

  // Single entry operations (PUT/DELETE)
  await page.route(`${API}/entries/**`, route => {
    const method = route.request().method()
    if (method === 'PUT') {
      return route.request().postDataJSON().then(body =>
        route.fulfill({
          json: {
            id: 1,
            title: body.title || '',
            content: body.content,
            created_at: '2026-04-01T08:00:00Z',
            edited_at: new Date().toISOString(),
            emotion: null,
            emotion_score: null,
            all_emotions: null,
            embedding: null,
            umap_x: null,
            umap_y: null,
            summary: null,
          },
        })
      )
    }
    if (method === 'DELETE') {
      return route.fulfill({ status: 204, body: '' })
    }
    return route.continue()
  })

  // Clustering
  await page.route(`${API}/clustering/runs`, route =>
    route.fulfill({ json: MOCK_CLUSTERING_RUNS })
  )
  await page.route(`${API}/clustering/run`, route =>
    route.fulfill({ json: { task_id: 'mock-cluster-task-001' } })
  )
  await page.route(`${API}/clustering/recommend`, route =>
    route.fulfill({
      json: {
        recommended_params: {
          minClusterSize: 3,
          minSamples: 1,
          membershipThreshold: 0.1,
          clusterSelectionEpsilon: 0.0,
          umapNComponents: 5,
          umapNNeighbors: 10,
          umapMinDist: 0.0,
        },
        reasoning: 'Mock recommendation for testing.',
      },
    })
  )

  // Task polling
  await page.route(`${API}/tasks/**`, route =>
    route.fulfill({
      json: { status: 'completed', result: { success: true } },
    })
  )

  // Conversations / Therapy
  await page.route(`${API}/conversations`, route =>
    route.fulfill({ json: MOCK_CONVERSATIONS })
  )
  await page.route(`${API}/conversations/messages`, route =>
    route.fulfill({ json: [] })
  )
  await page.route(`${API}/therapy/ask`, route =>
    route.fulfill({ json: { task_id: 'mock-therapy-task-001' } })
  )

  // Admin
  await page.route(`${API}/admin/**`, route =>
    route.fulfill({ json: { task_id: 'mock-admin-task-001' } })
  )
}

/**
 * Inject the auth token into localStorage before the page loads.
 * Must be called BEFORE page.goto().
 *
 * @param {import('@playwright/test').Page} page
 */
export async function injectAuthToken(page) {
  await page.addInitScript(token => {
    localStorage.setItem('auth_token', token)
  }, MOCK_TOKEN)
}

/**
 * Full authenticated setup: inject token + set up API mocks.
 * Call before page.goto() for any test that requires a logged-in state.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function setupAuthenticatedSession(page) {
  await setupApiMocks(page)
  await injectAuthToken(page)
}
