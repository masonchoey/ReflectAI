# ReflectAI Journal

A personal journaling application with FastAPI backend, React frontend, PostgreSQL database, and Google OAuth2 authentication.

## Features

- 🔐 **Google OAuth2 Authentication** - Secure sign-in with your Google account
- ✍️ Write and save journal entries
- ✏️ Edit previous journal entries
- 📅 Automatic timestamps for each entry
- 🕐 Track when entries were edited
- 📋 View all past entries in reverse chronological order
- 🔮 AI-powered emotion analysis
- 🔍 Semantic search across entries
- 🔒 Private entries - only see your own journal entries

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

# Create a .env file with your configuration
cat > .env << EOF
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/reflectai
JWT_SECRET_KEY=$(python -c "import secrets; print(secrets.token_hex(32))")
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
EOF

# Run the server
uvicorn main:app --reload
```

The API will be available at `http://localhost:8000`

### Frontend Setup

```bash
cd frontend

# Install dependencies
npm install

# Create a .env file with your Google Client ID
echo "VITE_GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com" > .env

# Run development server
npm run dev
```

The frontend will be available at `http://localhost:5173`

## Environment Variables

### Backend (.env)

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `JWT_SECRET_KEY` | Secret key for signing JWT tokens | Yes |
| `GOOGLE_CLIENT_ID` | Google OAuth2 Client ID | Yes |

### Frontend (.env)

| Variable | Description | Required |
|----------|-------------|----------|
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth2 Client ID (same as backend) | Yes |

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