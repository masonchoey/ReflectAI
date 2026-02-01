# ReflectAI Journal

A personal journaling application with FastAPI backend, React frontend, and PostgreSQL database.

## Features

- ✍️ Write and save journal entries
- ✏️ Edit previous journal entries
- 📅 Automatic timestamps for each entry
- 🕐 Track when entries were edited
- 📋 View all past entries in reverse chronological order

## Tech Stack

- **Backend**: FastAPI + SQLAlchemy + PostgreSQL
- **Frontend**: React + Vite

## Setup

### Prerequisites

- Python 3.10+
- Node.js 18+
- PostgreSQL

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

# If upgrading from a previous version, run the migration
python migrate_add_edited_at.py

# Set environment variable (optional - defaults to localhost)
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/reflectai

# Run the server
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

## API Endpoints

- `GET /` - Health check
- `GET /entries` - List all journal entries
- `POST /entries` - Create a new entry
- `GET /entries/{id}` - Get a specific entry
- `PUT /entries/{id}` - Update an existing entry

## Future Features (Roadmap)

- ML inference for sentiment analysis
- AI-powered daily summaries
