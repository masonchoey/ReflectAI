/**
 * Shared API mock data and route setup for Playwright E2E tests.
 * All tests mock the backend (http://localhost:8000) via page.route()
 * so no real backend is needed in CI.
 */

export const MOCK_TOKEN = 'e2e-test-token-abc123'

/** Issued only by POST /auth/demo so GET /auth/me can return the demo user after token refresh. */
export const MOCK_DEMO_TOKEN = 'e2e-demo-session-token'

/** Returned by POST /auth/demo — must match App.jsx demo detection (demo@reflectai.app). */
export const MOCK_DEMO_USER = {
  id: 1,
  email: 'demo@reflectai.app',
  name: 'Demo User',
  picture: null,
  google_id: 'demo_test_123',
}

/** Used for /auth/me when tests inject a token (non-demo session, e.g. delete button visible). */
export const MOCK_USER = {
  id: 2,
  email: 'e2e@reflectai.test',
  name: 'Test User',
  picture: null,
  google_id: 'e2e_test_google',
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

/** A single mock clustering run (used when testing clustering flows). */
export const MOCK_CLUSTERING_RUN = {
  id: 42,
  user_id: 2,
  run_timestamp: '2026-04-09T10:00:00Z',
  num_entries: 2,
  num_clusters: 1,
  min_cluster_size: 2,
  min_samples: 1,
  membership_threshold: 0.05,
  noise_entries: 0,
  start_date: null,
  end_date: null,
}

/**
 * Mock ClusterVisualizationResponse — two points in one cluster.
 * Matches the schema in backend/schemas.py.
 */
export const MOCK_CLUSTER_VISUALIZATION = {
  run_id: 42,
  points: [
    {
      entry_id: 1,
      title: 'Morning Reflection',
      x: -1.2,
      y: 0.8,
      cluster_id: 0,
      cluster_name: 'Gratitude & Growth',
      membership_probability: 0.95,
      all_memberships: [
        { cluster_id: 0, cluster_name: 'Gratitude & Growth', membership_probability: 0.95, is_primary: true },
      ],
    },
    {
      entry_id: 2,
      title: 'Evening Thoughts',
      x: -0.9,
      y: 1.1,
      cluster_id: 0,
      cluster_name: 'Gratitude & Growth',
      membership_probability: 0.88,
      all_memberships: [
        { cluster_id: 0, cluster_name: 'Gratitude & Growth', membership_probability: 0.88, is_primary: true },
      ],
    },
  ],
  clusters: [
    {
      cluster_id: 0,
      size: 2,
      persistence: 0.75,
      topic_label: 'Gratitude & Growth',
      summary: 'Entries about gratitude and personal development.',
    },
  ],
}

export const MOCK_CLUSTERING_RUNS = []

export const MOCK_CONVERSATIONS = []

/**
 * Set up all standard API mocks for an authenticated session.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} options
 * @param {Array} [options.clusteringRuns]  - clustering runs list (default: empty)
 * @param {object|null} [options.visualization] - visualization data for a specific run id
 */
export async function setupApiMocks(page, options = {}) {
  const {
    clusteringRuns = MOCK_CLUSTERING_RUNS,
    visualization = null,
  } = options
  const API = 'http://localhost:8000'

  // Auth — /auth/me returns user matching the token type
  await page.route(`${API}/auth/me`, route => {
    const auth = route.request().headers()['authorization'] ?? ''
    const user = auth.includes(MOCK_DEMO_TOKEN) ? MOCK_DEMO_USER : MOCK_USER
    return route.fulfill({ json: user })
  })
  await page.route(`${API}/auth/demo`, route =>
    route.fulfill({ json: { access_token: MOCK_DEMO_TOKEN, user: MOCK_DEMO_USER } })
  )

  // Entries — GET returns list, POST echoes a new entry
  await page.route(`${API}/entries`, async route => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: MOCK_ENTRIES })
    }
    const body = route.request().postDataJSON()
    return route.fulfill({
      json: {
        id: 99,
        title: body?.title || '',
        content: body?.content || '',
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
  })

  // Single entry operations: PUT / DELETE
  await page.route(`${API}/entries/**`, async route => {
    const method = route.request().method()
    const url = route.request().url()

    if (url.includes('/analyze')) {
      // POST /entries/{id}/analyze — queue emotion analysis task
      return route.fulfill({ json: { task_id: 'emotion-task-default-001', status: 'PENDING', result: null } })
    }
    if (method === 'PUT') {
      const body = route.request().postDataJSON()
      return route.fulfill({
        json: {
          id: 1,
          title: body?.title || '',
          content: body?.content || '',
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
    }
    if (method === 'DELETE') {
      return route.fulfill({ status: 204, body: '' })
    }
    return route.continue()
  })

  // Clustering
  await page.route(`${API}/clustering/runs`, route =>
    route.fulfill({ json: clusteringRuns })
  )
  await page.route(`${API}/clustering/run`, route =>
    route.fulfill({ json: { task_id: 'cluster-task-001', status: 'PENDING', result: null } })
  )
  await page.route(`${API}/clustering/recommend`, route =>
    route.fulfill({
      json: {
        params: {
          min_cluster_size: 3,
          min_samples: 1,
          membership_threshold: 0.1,
          cluster_selection_epsilon: 0.0,
          umap_n_components: 5,
          umap_n_neighbors: 10,
          umap_min_dist: 0.0,
        },
        reasoning: 'Mock recommendation for testing.',
      },
    })
  )

  // Cluster visualization
  if (visualization) {
    await page.route(`${API}/clustering/runs/*/visualization`, route =>
      route.fulfill({ json: visualization })
    )
  } else {
    await page.route(`${API}/clustering/runs/*/visualization`, route =>
      route.fulfill({ status: 404, json: { detail: 'No visualization data' } })
    )
  }

  // Task polling — default: return completed immediately
  await page.route(`${API}/tasks/**`, route =>
    route.fulfill({ json: { task_id: 'default', status: 'SUCCESS', result: { success: true } } })
  )

  // Conversations / Therapy
  await page.route(`${API}/conversations`, route => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: MOCK_CONVERSATIONS })
    }
    return route.fulfill({ json: { id: 1, user_id: 2, title: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } })
  })
  await page.route(`${API}/conversations/**`, route => {
    const url = route.request().url()
    if (url.includes('/messages')) {
      if (route.request().method() === 'POST') {
        return route.fulfill({ json: { id: 1, conversation_id: 1, role: 'user', content: 'test', steps: null, is_error: false, created_at: new Date().toISOString() } })
      }
      return route.fulfill({ json: [] })
    }
    return route.fulfill({ json: { id: 1, messages: [] } })
  })
  await page.route(`${API}/therapy/ask`, route =>
    route.fulfill({ json: { task_id: 'therapy-task-001', status: 'PENDING', result: null } })
  )

  // Admin
  await page.route(`${API}/admin/**`, route =>
    route.fulfill({ json: { task_id: 'admin-task-001', status: 'PENDING', result: null } })
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
 * @param {object} [options] - forwarded to setupApiMocks
 */
export async function setupAuthenticatedSession(page, options = {}) {
  await setupApiMocks(page, options)
  await injectAuthToken(page)
}
