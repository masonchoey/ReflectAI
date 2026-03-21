# ReflectAI

ReflectAI is a personal journaling app that combines a FastAPI backend, a React (Vite) frontend, and PostgreSQL with **pgvector**. It uses **Google Sign-In** for identity, **JWT** for API access, and **Celery + Redis** for heavy work: embeddings, emotion analysis, semantic search, entry clustering (HDBSCAN + UMAP), and an optional **therapy-style Q&A** flow backed by an LLM (OpenRouter / LangChain).

## Features

- **Sign in with Google** — ID token verified on the backend; JWT stored in the browser for API calls  
- **Journal entries** — Create, edit, and list entries with titles, timestamps, and optional AI-generated summaries  
- **Emotion analysis** — Go Emotions–style scores, including a full ranked breakdown per entry  
- **Embeddings & semantic search** — Dense vectors (IBM Granite embedding model) for similarity and search  
- **Clustering** — Run HDBSCAN over your entries, tune UMAP/HDBSCAN parameters, visualize clusters, and inspect memberships  
- **Therapy assistant** — Ask questions grounded in your journal; conversations and messages are persisted  
- **Privacy** — Entries and derived data are scoped to the authenticated user  

On **non-localhost** deploys, the frontend can optionally call **Supabase** `signInWithIdToken` after Google sign-in (for hosted auth/session integration). Local dev uses only Google + your API JWT.

## Architecture (high level)

```mermaid
flowchart LR
  subgraph client [Browser]
    UI[React + Vite]
  end
  subgraph api [Backend]
    FastAPI[FastAPI]
  end
  subgraph workers [Async work]
    Celery[Celery worker]
  end
  UI -->|JWT| FastAPI
  FastAPI -->|enqueue| Redis[(Redis)]
  Celery --> Redis
  FastAPI --> DB[(PostgreSQL + pgvector)]
  Celery --> DB
```

## Tech stack

| Layer | Technologies |
|--------|----------------|
| API | FastAPI, SQLAlchemy, Pydantic, python-jose (JWT), google-auth |
| Jobs | Celery, Redis |
| ML / NLP | sentence-transformers, transformers, pgvector, hdbscan, umap-learn |
| LLM | LangChain, OpenAI-compatible client (e.g. OpenRouter) |
| Data | PostgreSQL 16 + pgvector |
| Frontend | React 18, Vite, react-markdown; optional `@supabase/supabase-js` |

## Prerequisites

- Python 3.10+  
- Node.js 18+  
- PostgreSQL (with pgvector), or Docker  
- Redis (required for Celery) — included in Docker Compose  
- Google Cloud project with OAuth **Web client** credentials  
- For therapy / LLM features: **OpenRouter** (or compatible) API key  

## Environment variables

Use a **single `.env` at the repository root** (loaded by `backend/env.py`).

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL URL (see below for host vs Docker) |
| `JWT_SECRET_KEY` | Secret for signing JWTs |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID (backend token verification) |
| `REDIS_URL` | Redis for Celery (optional locally: defaults to `redis://localhost:6379/0` or `redis://redis:6379/0` in Docker) |
| `OPENROUTER_API_KEY` | LLM calls (therapy, recommendations, etc.) |
| `OPENROUTER_INFERENCE_MODEL_ID` | Model id on OpenRouter |
| `HF_HOME` / `TRANSFORMERS_CACHE` | Hugging Face cache dirs (Docker uses `/tmp/.cache/huggingface` by default) |
| `VITE_API_URL` | Frontend: backend base URL in production builds |
| `VITE_GOOGLE_CLIENT_ID` | Frontend: same Google client ID as above |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | Optional; used when not on localhost |
| `LANGSMITH_*` | Optional LangSmith tracing |
| `FLY_API_TOKEN` / `FLY_WORKER_APP` | Optional; wake Fly.io Celery worker when queueing tasks |

**Database URL examples**

- App on your machine, Postgres in Docker (Compose maps **5433 → 5432**):  
  `postgresql://postgres:postgres@localhost:5433/reflectai`
- Backend **inside** Docker Compose (service name `postgres`, internal port **5432**):  
  `postgresql://postgres:postgres@postgres:5432/reflectai`

## Quick start (Docker Compose)

Recommended: Postgres, Redis, API, Celery worker, one-off model download, and nginx frontend.

1. Create `.env` in the project root (at minimum `JWT_SECRET_KEY`, `GOOGLE_CLIENT_ID`, and `OPENROUTER_*` if you use LLM features). For Compose, set `DATABASE_URL` only if you override the backend’s built-in URL; the compose file already injects the correct in-network DB URL.

2. Build and run:

```bash
docker compose up --build
```

3. Open **http://localhost** (frontend) and **http://localhost:8000/docs** (API). Postgres is on host port **5433**, Redis on **6379**.

Services: `postgres` (pgvector), `redis`, `backend`, `init-models` (downloads embedding + emotion models into a shared volume), `celery-worker`, `frontend`.

Stop: `docker compose down`. Remove data: `docker compose down -v`.

## Local development (without Docker)

1. Create DB and enable pgvector (match your local Postgres).  
2. Start **Redis** on `localhost:6379`.  
3. Backend:

```bash
cd backend
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
# From repo root, ensure .env exists with DATABASE_URL, JWT_SECRET_KEY, GOOGLE_CLIENT_ID, etc.
cd .. && python backend/download_models.py   # optional but avoids first-request downloads
cd backend && uvicorn main:app --reload
```

4. In another terminal, run the worker:

```bash
cd backend && source venv/bin/activate && celery -A celery_app worker --loglevel=info --concurrency=1
```

5. Frontend:

```bash
cd frontend
npm install
npm run dev
```

Frontend dev server: **http://localhost:5173**. Configure Google OAuth **JavaScript origin** for that URL. The app uses **http://localhost:8000** for the API when opened from localhost.

### Mixed setup (Vite + Docker API)

If the UI runs on localhost but the API is in Docker, ensure nothing else binds to port **8000**, then use the app as usual; requests go to `http://localhost:8000`. Check `docker compose logs -f backend` if calls fail.

## API overview

Long-running operations return a **task id**; poll **`GET /tasks/{task_id}`** for status and result.

| Area | Methods |
|------|---------|
| Health | `GET /`, `GET /status` |
| Auth | `POST /auth/google`, `GET /auth/me` |
| Entries | `GET/POST /entries`, `GET/PUT /entries/{id}` |
| Per entry | `POST /entries/{id}/analyze`, `.../tokenize`, `.../embed`, `GET .../similar` |
| Bulk | `POST /entries/embed-all`, `POST /admin/bulk-analyze` |
| Search | `POST /search/semantic` |
| Clustering | `POST /clustering/run`, `GET /clustering/recommend`, `GET /clustering/runs`, `GET /clustering/runs/{run_id}/visualization`, `GET /clustering/entries/{entry_id}/memberships`, `GET /clustering/clusters/{cluster_id}/entries` |
| Therapy | `POST /therapy/ask` |
| Conversations | `GET /conversations`, `GET /conversations/{id}`, `POST /conversations/messages`, `DELETE /conversations/{id}` |
| Tasks | `GET /tasks/{task_id}` |

Interactive docs: `/docs` (Swagger).

## Database schema (summary)

- **users** — `google_id`, `email`, `name`, `picture`, timestamps  
- **journal_entries** — `user_id`, `title`, `content`, `emotion`, `emotion_score`, `all_emotions` (JSON), `embedding` (384-d vector), `umap_x` / `umap_y`, `summary`, timestamps  
- **clustering_runs**, **clusters**, **entry_cluster_assignments** — clustering metadata and soft memberships  
- **conversations**, **conversation_messages** — therapy chat history (`role`, `content`, optional `steps` JSON)  

Tables are created on API startup (with retries if the DB is still starting).

## Security notes

- Journal and AI-derived data require a valid JWT; users only see their own data.  
- Google ID tokens are verified server-side with your `GOOGLE_CLIENT_ID`.  
- Keep `JWT_SECRET_KEY` and API keys out of version control.  

## Deployment notes

The repo includes **Fly.io** config for the API (`backend/fly.toml`) and a separate worker app (`backend/fly.worker.toml`). Production frontends should set **`VITE_API_URL`** to the deployed API origin instead of relying on code defaults. Celery workers need the same Redis, database, and model cache strategy as your API environment.

## Roadmap ideas

- Stronger export / backup story for entries  
- Tags, filters, and time-based mood views  
- Deeper analytics on clusters and emotions over time  
