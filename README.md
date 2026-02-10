# ReflectAI Journal

A personal journaling application with FastAPI backend, React frontend, PostgreSQL database, and Google OAuth2 authentication.

## Features

- **Google OAuth2 Authentication** - Secure sign-in with your Google account
- Write and save journal entries
- Edit previous journal entries
- Automatic timestamps for each entry
- Track when entries were edited
- View all past entries in reverse chronological order
- AI-powered emotion analysis
- Semantic search across entries
- Private entries - only see your own journal entries

## Tech Stack

- **Backend**: FastAPI + SQLAlchemy + PostgreSQL
- **Frontend**: React + Vite
- **Authentication**: Google OAuth2 + JWT

## Setup

### Prerequisites

- Python 3.10+
- Node.js 18+
- PostgreSQL
- Google Cloud Console account (for OAuth2)
- Docker and Docker Compose (for containerized deployment)

### Google OAuth2 Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Navigate to **APIs & Services > Credentials**
4. Click **Create Credentials > OAuth 2.0 Client ID**
5. Select **Web application** as the application type
6. Add the following:
   - **Authorized JavaScript origins**: `http://localhost:5173`
   - **Authorized redirect URIs**: `http://localhost:5173`
7. Copy the **Client ID** (you'll need this for both backend and frontend)

### Database Setup

1. Create a PostgreSQL database:
```sql
CREATE DATABASE reflectai;
```

### Backend Setup

```bash
cd backend

# Create virtual environment
python -m venv venv

# Activate virtual environment
source venv/bin/activate  # On macOS/Linux
# or: venv\Scripts\activate  # On Windows

# Install dependencies
pip install -r requirements.txt

# Create a single consolidated .env file in the project root
cd ..
cat > .env << EOF
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/reflectai
JWT_SECRET_KEY=$(python -c "import secrets; print(secrets.token_hex(32))")
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
VITE_GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
EOF

# Run the server
cd backend
uvicorn main:app --reload
```

The API will be available at `http://localhost:8000`

### Frontend Setup

```bash
cd frontend

# Install dependencies
npm install

# Run development server
npm run dev
```

The frontend will be available at `http://localhost:5173`

### Docker Setup (Recommended)

The application is fully containerized using Docker. This setup includes:
- **Eager model loading**: Models are loaded at startup for faster response times
- **HF_HOME caching**: Hugging Face models are cached to a persistent volume
- **PostgreSQL with pgvector**: Database with vector extension pre-configured

#### Quick Start with Docker

1. **Create a `.env` file** in the project root:
```bash
cat > .env << EOF
DATABASE_URL=postgresql://postgres:postgres@postgres:5433/reflectai
JWT_SECRET_KEY=$(python -c "import secrets; print(secrets.token_hex(32))")
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
HF_HOME=/app/.cache/huggingface
EOF
```

2. **Build and start all services**:
```bash
docker-compose up --build
```

3. **Access the application**:
   - Frontend: `http://localhost`
   - Backend API: `http://localhost:8000`
   - API Docs: `http://localhost:8000/docs`

#### Docker Services

- **postgres**: PostgreSQL database with pgvector extension
- **backend**: FastAPI backend with eager model loading
- **frontend**: React frontend served via nginx

#### Docker Volumes

- `postgres_data`: Persistent database storage
- `huggingface_cache`: Persistent Hugging Face model cache (shared across container restarts)

#### Stopping and Cleaning Up

```bash
# Stop all services
docker-compose down

# Stop and remove volumes (deletes data)
docker-compose down -v
```

#### Development with Docker

For development, you can mount your code as volumes:

```bash
# The docker-compose.yml already mounts backend code for hot-reload
# Frontend changes require rebuilding the image
docker-compose up --build frontend
```

## Environment Variables

### Consolidated Root `.env`

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `JWT_SECRET_KEY` | Secret key for signing JWT tokens | Yes |
| `GOOGLE_CLIENT_ID` | Google OAuth2 Client ID | Yes |
| `HF_HOME` | Hugging Face cache directory (defaults to `~/.cache/huggingface`) | No |
| `VITE_API_URL` | Backend API URL for the frontend | No (defaults to `http://localhost:8000`) |
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth2 Client ID (for frontend) | Yes |

## API Endpoints

### Public
- `GET /` - Health check

### Authentication
- `POST /auth/google` - Authenticate with Google ID token
- `GET /auth/me` - Get current user info (requires auth)

### Journal Entries (all require authentication)
- `GET /entries` - List all your journal entries
- `POST /entries` - Create a new entry
- `GET /entries/{id}` - Get a specific entry
- `PUT /entries/{id}` - Update an existing entry
- `POST /entries/{id}/analyze` - Analyze emotions in entry
- `POST /entries/{id}/embed` - Generate embedding for entry
- `GET /entries/{id}/similar` - Find similar entries
- `POST /entries/embed-all` - Generate embeddings for all entries
- `POST /search/semantic` - Semantic search across entries

## Database Schema

### Users Table
- `id` - Primary key
- `google_id` - Google account ID (unique)
- `email` - User email (unique)
- `name` - Display name
- `picture` - Profile picture URL
- `created_at` - Account creation timestamp
- `last_login` - Last login timestamp

### Journal Entries Table
- `id` - Primary key
- `user_id` - Foreign key to users table
- `content` - Entry text content
- `created_at` - Entry creation timestamp
- `edited_at` - Last edit timestamp
- `emotion` - Detected emotion
- `emotion_score` - Confidence score
- `embedding` - Vector embedding for semantic search

## Security

- All journal entries are protected by JWT authentication
- Users can only access their own entries
- Google OAuth2 provides secure authentication
- JWT tokens expire after 7 days

## Future Features (Roadmap)

- AI-powered daily summaries
- Mood tracking over time
- Export journal entries
- Tags and categories
