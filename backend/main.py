import os
import math
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException, status, Response, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session, load_only
from typing import List, Optional
from datetime import datetime, timezone, timedelta
import numpy as np
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests
from jose import JWTError, jwt
from env import load_root_env

from database import engine, get_db, Base
from database import enable_pgvector_extension
from models import JournalEntry, User, ClusteringRun, Cluster, EntryClusterAssignment, Conversation, ConversationMessage
from schemas import (
    JournalEntryCreate, JournalEntryUpdate, JournalEntryResponse,
    EmbeddingResponse,
    SimilarEntry, SemanticSearchResponse, TextSearchRequest, TextSearchResponse,
    TokenizationResponse, GoogleAuthRequest, AuthResponse, UserResponse,
    ClusteringRunRequest, ClusteringRunResponse, ClusterInfoResponse, ClusterPoint, 
    ClusterVisualizationResponse, ClusterMembership, EntryClusterMembershipsResponse,
    ClusterEntriesResponse, EntryClusterInfo, 
    TherapyQuestionRequest,
    TaskStatusResponse, ClusteringRecommendResponse, RecommendedClusterParams,
    BulkAnalyzeResponse, BulkAnalyzeRequest,
    ConversationResponse, ConversationListItem, SaveMessageRequest, SaveMessageResponse,
    ConversationMessageResponse,
)
from sqlalchemy import text, func
from tasks import (
    vectorize_entry,
    vectorize_all_entries,
    run_clustering_task,
    analyze_emotion_task,
    tokenize_entry_task,
    semantic_search_task,
    therapy_question_task,
)
from celery.result import AsyncResult
from celery_app import celery_app
from fly_worker import ensure_worker_running

load_root_env()

# JWT Configuration
SECRET_KEY = os.getenv("JWT_SECRET_KEY", "")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 7

# Google OAuth Configuration
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")

# Note: Database tables are created in the lifespan startup function
# to ensure the database is ready before attempting to create tables

# Security scheme for JWT
security = HTTPBearer(auto_error=False)


def _init_db_sync() -> None:
    """Synchronous DB init; run via executor so it never blocks the event loop."""
    import time
    from sqlalchemy.exc import OperationalError

    max_retries = 5
    retry_delay = 2

    for attempt in range(max_retries):
        try:
            Base.metadata.create_all(bind=engine)
            print("Database tables initialized successfully")
            return
        except OperationalError as e:
            if attempt < max_retries - 1:
                print(f"Database not ready yet (attempt {attempt + 1}/{max_retries}): {e}")
                print(f"Retrying in {retry_delay} seconds...")
                time.sleep(retry_delay)
            else:
                print(f"Warning: Failed to initialize database tables after {max_retries} attempts: {e}")
        except Exception as e:
            print(f"Warning: Failed to create database tables: {e}")
            return


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for startup/shutdown tasks."""
    import asyncio

    loop = asyncio.get_event_loop()

    async def _init_db_background():
        """Run DB table creation and pgvector setup in the background so the
        server can bind and serve requests (e.g. the frontend) immediately."""
        try:
            await asyncio.wait_for(loop.run_in_executor(None, _init_db_sync), timeout=30.0)
        except asyncio.TimeoutError:
            print("Warning: Database initialization timed out after 30s")
        except Exception as e:
            print(f"Warning: Database initialization failed: {e}")

        try:
            await asyncio.wait_for(
                loop.run_in_executor(None, enable_pgvector_extension), timeout=15.0
            )
        except Exception as e:
            print(f"Warning: Could not ensure pgvector extension: {e}")

    # Fire DB init as a background task — server binds immediately without waiting.
    asyncio.create_task(_init_db_background())

    # Wake the Celery worker (already runs in a background thread internally)
    ensure_worker_running()

    yield
    # Cleanup (if needed)


app = FastAPI(title="ReflectAI Journal API", lifespan=lifespan)

# CORS configuration - allow both local development and production
# Accept comma-separated list of origins from environment variable
CORS_ORIGINS_STR = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://localhost:3000,http://localhost,https://reflect-ai-nine.vercel.app,https://reflect-ai-nine-*.vercel.app")
# Split and strip whitespace from each origin
CORS_ORIGINS = [origin.strip() for origin in CORS_ORIGINS_STR.split(",") if origin.strip()]

# Add default localhost origins if not in the list
default_origins = ["http://localhost:5173", "http://localhost:3000", "http://localhost"]
for origin in default_origins:
    if origin not in CORS_ORIGINS:
        CORS_ORIGINS.append(origin)

print(f"CORS allowed origins: {CORS_ORIGINS}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


# ============== Authentication Functions ==============

def create_access_token(data: dict) -> str:
    """Create a JWT access token."""
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt


def verify_google_token(token: str) -> dict:
    """Verify a Google ID token and return the user info."""
    try:
        idinfo = id_token.verify_oauth2_token(
            token,
            google_requests.Request(),
            GOOGLE_CLIENT_ID
        )
        
        # Verify the issuer
        if idinfo['iss'] not in ['accounts.google.com', 'https://accounts.google.com']:
            raise ValueError('Wrong issuer.')
        
        return {
            'google_id': idinfo['sub'],
            'email': idinfo['email'],
            'name': idinfo.get('name'),
            'picture': idinfo.get('picture')
        }
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid Google token: {str(e)}"
        )


def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: Session = Depends(get_db)
) -> Optional[User]:
    """Get the current authenticated user from JWT token."""
    if credentials is None:
        return None
    
    token = credentials.credentials
    
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: int = payload.get("user_id")
        if user_id is None:
            return None
    except JWTError:
        return None
    
    db.execute(text("SELECT set_config('app.current_user_id', :uid, true)"), {"uid": str(user_id)})
    user = db.query(User).filter(User.id == user_id).first()
    return user


def require_auth(
    credentials: HTTPAuthorizationCredentials = Depends(HTTPBearer()),
    db: Session = Depends(get_db)
) -> User:
    """Require authentication - raises 401 if not authenticated."""
    token = credentials.credentials
    
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: int = payload.get("user_id")
        if user_id is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication token"
            )
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token"
        )
    
    db.execute(text("SELECT set_config('app.current_user_id', :uid, true)"), {"uid": str(user_id)})
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found"
        )
    
    return user


# ============== Helper Functions ==============

def entry_to_response(entry: JournalEntry) -> JournalEntryResponse:
    """Convert a JournalEntry model to a response with computed has_embedding field."""
    return JournalEntryResponse(
        id=entry.id,
        user_id=entry.user_id,
        title=entry.title,
        content=entry.content,
        created_at=entry.created_at,
        edited_at=entry.edited_at,
        emotion=entry.emotion,
        emotion_score=entry.emotion_score,
        all_emotions=entry.all_emotions,
        has_embedding=entry.embedding is not None
    )


def compute_cosine_similarity(vec1: List[float], vec2: List[float]) -> float:
    """Compute cosine similarity between two vectors."""
    a = np.array(vec1)
    b = np.array(vec2)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


# ============== Auth Endpoints ==============

@app.post("/auth/google", response_model=AuthResponse)
def google_auth(auth_request: GoogleAuthRequest, db: Session = Depends(get_db)):
    """Authenticate with Google and return a JWT token."""
    # Verify the Google token
    google_user = verify_google_token(auth_request.credential)
    
    # Check if user exists
    user = db.query(User).filter(User.google_id == google_user['google_id']).first()
    
    if user:
        # Set session variable before UPDATE so the RLS policy allows it
        db.execute(text("SELECT set_config('app.current_user_id', :uid, true)"), {"uid": str(user.id)})
        user.last_login = datetime.now(timezone.utc)
        user.name = google_user.get('name')
        user.picture = google_user.get('picture')
    else:
        # INSERT is covered by an unrestricted INSERT policy — no session var needed
        user = User(
            google_id=google_user['google_id'],
            email=google_user['email'],
            name=google_user.get('name'),
            picture=google_user.get('picture')
        )
        db.add(user)
    
    db.commit()
    db.refresh(user)
    
    # Create JWT token
    access_token = create_access_token({"user_id": user.id})
    
    return AuthResponse(
        access_token=access_token,
        user=UserResponse(
            id=user.id,
            google_id=user.google_id,
            email=user.email,
            name=user.name,
            picture=user.picture,
            created_at=user.created_at
        )
    )


@app.get("/auth/me", response_model=UserResponse)
def get_current_user_info(current_user: User = Depends(require_auth)):
    """Get the current authenticated user's information."""
    return UserResponse(
        id=current_user.id,
        google_id=current_user.google_id,
        email=current_user.email,
        name=current_user.name,
        picture=current_user.picture,
        created_at=current_user.created_at
    )


# ============== Public Endpoints ==============

@app.get("/")
def read_root():
    return {"message": "Welcome to ReflectAI Journal API"}


@app.get("/status")
def get_status():
    """Get the status of the API. All ML models run on the Celery worker."""
    return {
        "status": "ready",
        "models": "celery_worker",
    }


# ============== Protected Journal Endpoints ==============

@app.post("/entries", response_model=JournalEntryResponse)
def create_entry(
    entry: JournalEntryCreate,
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Create a new journal entry for the authenticated user."""
    db_entry = JournalEntry(
        title=entry.title,
        content=entry.content,
        user_id=current_user.id
    )
    db.add(db_entry)
    db.commit()
    db.refresh(db_entry)
    
    # Queue vectorization task asynchronously
    try:
        task = vectorize_entry.delay(db_entry.id)
        ensure_worker_running()
        print(f"Queued vectorization task {task.id} for entry {db_entry.id}")
    except Exception as e:
        print(f"Warning: Failed to queue vectorization task: {e}")
        # Continue without embedding - user can generate it later
    
    return entry_to_response(db_entry)


@app.get("/entries", response_model=List[JournalEntryResponse])
def get_entries(
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Get all journal entries for the authenticated user."""
    rows = db.query(
        JournalEntry.id,
        JournalEntry.user_id,
        JournalEntry.title,
        JournalEntry.content,
        JournalEntry.created_at,
        JournalEntry.edited_at,
        JournalEntry.emotion,
        JournalEntry.emotion_score,
        JournalEntry.all_emotions,
        (JournalEntry.embedding.isnot(None)).label('has_embedding'),
    ).filter(
        JournalEntry.user_id == current_user.id
    ).order_by(JournalEntry.created_at.desc()).all()
    return [
        JournalEntryResponse(
            id=r.id,
            user_id=r.user_id,
            title=r.title,
            content=r.content,
            created_at=r.created_at,
            edited_at=r.edited_at,
            emotion=r.emotion,
            emotion_score=r.emotion_score,
            all_emotions=r.all_emotions,
            has_embedding=r.has_embedding,
        )
        for r in rows
    ]


@app.get("/entries/{entry_id}", response_model=JournalEntryResponse)
def get_entry(
    entry_id: int,
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Get a specific journal entry (must belong to authenticated user)."""
    row = db.query(
        JournalEntry.id,
        JournalEntry.user_id,
        JournalEntry.title,
        JournalEntry.content,
        JournalEntry.created_at,
        JournalEntry.edited_at,
        JournalEntry.emotion,
        JournalEntry.emotion_score,
        JournalEntry.all_emotions,
        (JournalEntry.embedding.isnot(None)).label('has_embedding'),
    ).filter(
        JournalEntry.id == entry_id,
        JournalEntry.user_id == current_user.id
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    return JournalEntryResponse(
        id=row.id,
        user_id=row.user_id,
        title=row.title,
        content=row.content,
        created_at=row.created_at,
        edited_at=row.edited_at,
        emotion=row.emotion,
        emotion_score=row.emotion_score,
        all_emotions=row.all_emotions,
        has_embedding=row.has_embedding,
    )


@app.put("/entries/{entry_id}", response_model=JournalEntryResponse)
def update_entry(
    entry_id: int,
    entry_update: JournalEntryUpdate,
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Update a journal entry (must belong to authenticated user)."""
    entry = db.query(JournalEntry).filter(
        JournalEntry.id == entry_id,
        JournalEntry.user_id == current_user.id
    ).first()
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    
    entry.title = entry_update.title
    entry.content = entry_update.content
    entry.edited_at = datetime.now(timezone.utc)
    
    # Queue vectorization task asynchronously to regenerate embedding
    try:
        task = vectorize_entry.delay(entry_id)
        ensure_worker_running()
        print(f"Queued vectorization task {task.id} for entry {entry_id}")
    except Exception as e:
        print(f"Warning: Failed to queue vectorization task: {e}")
        # Continue without regenerating embedding - user can regenerate it later
    
    db.commit()
    db.refresh(entry)
    return entry_to_response(entry)


@app.post("/entries/{entry_id}/analyze", response_model=TaskStatusResponse)
def analyze_emotion(
    entry_id: int,
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Queue emotion analysis for a journal entry (must belong to authenticated user).

    Returns a task_id that can be polled at GET /tasks/{task_id}.
    On SUCCESS the result contains: entry_id, emotion, emotion_score, all_emotions.
    """
    exists = db.query(JournalEntry.id).filter(
        JournalEntry.id == entry_id,
        JournalEntry.user_id == current_user.id
    ).first()
    if exists is None:
        raise HTTPException(status_code=404, detail="Entry not found")

    task = analyze_emotion_task.delay(entry_id)
    ensure_worker_running()

    return TaskStatusResponse(
        task_id=task.id,
        status=task.state,
        result=None
    )


ADMIN_EMAIL = "mason@choey.com"


@app.post("/admin/bulk-analyze", response_model=BulkAnalyzeResponse)
def bulk_analyze_emotions(
    body: BulkAnalyzeRequest = Body(default_factory=BulkAnalyzeRequest),
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Queue emotion analysis for all entries belonging to a user that are
    missing emotion data. Admin-only. Specify user_id or email to target another user;
    omit both to use the current user."""
    if current_user.email != ADMIN_EMAIL:
        raise HTTPException(status_code=403, detail="Forbidden")

    if body.user_id is not None:
        target_user = db.query(User).filter(User.id == body.user_id).first()
        if target_user is None:
            raise HTTPException(status_code=404, detail=f"User with id {body.user_id} not found")
    elif body.email is not None and body.email.strip():
        target_user = db.query(User).filter(User.email == body.email.strip()).first()
        if target_user is None:
            raise HTTPException(status_code=404, detail=f"User with email {body.email!r} not found")
    else:
        target_user = current_user

    rows = db.query(JournalEntry.id).filter(
        JournalEntry.user_id == target_user.id,
        (JournalEntry.emotion == None) | (JournalEntry.emotion_score == None) | (JournalEntry.all_emotions == None)
    ).all()

    task_ids = []
    entry_ids = [r.id for r in rows]
    for eid in entry_ids:
        task = analyze_emotion_task.delay(eid)
        task_ids.append(task.id)

    ensure_worker_running()

    return BulkAnalyzeResponse(
        queued=len(entry_ids),
        task_ids=task_ids,
        entry_ids=entry_ids
    )


@app.post("/entries/{entry_id}/tokenize", response_model=TaskStatusResponse)
def tokenize_entry(
    entry_id: int,
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Queue tokenization for a journal entry (must belong to authenticated user).
    Poll GET /tasks/{task_id} for result; on SUCCESS, result has entry_id, text, token_count, tokens, token_ids."""
    exists = db.query(JournalEntry.id).filter(
        JournalEntry.id == entry_id,
        JournalEntry.user_id == current_user.id
    ).first()
    if exists is None:
        raise HTTPException(status_code=404, detail="Entry not found")

    task = tokenize_entry_task.delay(entry_id)
    ensure_worker_running()
    return TaskStatusResponse(task_id=task.id, status=task.state, result=None)


@app.post("/entries/{entry_id}/embed", response_model=TaskStatusResponse)
def embed_entry(
    entry_id: int,
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Queue embedding generation for a journal entry (must belong to authenticated user)."""
    exists = db.query(JournalEntry.id).filter(
        JournalEntry.id == entry_id,
        JournalEntry.user_id == current_user.id
    ).first()
    if exists is None:
        raise HTTPException(status_code=404, detail="Entry not found")

    # Queue vectorization task
    task = vectorize_entry.delay(entry_id)
    ensure_worker_running()

    return TaskStatusResponse(
        task_id=task.id,
        status=task.state,
        result=None
    )


@app.post("/entries/embed-all", response_model=TaskStatusResponse)
def embed_all_entries(
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Queue embedding generation for all user's entries that don't have one."""
    # Queue vectorization task for all entries
    task = vectorize_all_entries.delay(current_user.id)
    ensure_worker_running()

    return TaskStatusResponse(
        task_id=task.id,
        status=task.state,
        result=None
    )


@app.get("/entries/{entry_id}/similar", response_model=SemanticSearchResponse)
def find_similar_entries(
    entry_id: int,
    top_k: int = 5,
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Find similar journal entries (only searches user's own entries)."""
    entry = db.query(JournalEntry).options(load_only(
        JournalEntry.id,
        JournalEntry.embedding,
    )).filter(
        JournalEntry.id == entry_id,
        JournalEntry.user_id == current_user.id
    ).first()
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")

    if entry.embedding is None:
        raise HTTPException(status_code=400, detail="Entry has no embedding. Call /entries/{entry_id}/embed first.")

    # Get all other entries with embeddings for this user
    other_entries = db.query(JournalEntry).options(load_only(
        JournalEntry.id,
        JournalEntry.content,
        JournalEntry.created_at,
        JournalEntry.emotion,
        JournalEntry.embedding,
    )).filter(
        JournalEntry.id != entry_id,
        JournalEntry.user_id == current_user.id,
        JournalEntry.embedding != None
    ).all()
    
    if not other_entries:
        return SemanticSearchResponse(query_entry_id=entry_id, similar_entries=[])
    
    # Compute similarities
    similarities = []
    query_embedding = entry.embedding
    # Convert to list if it's a numpy array or vector type
    if hasattr(query_embedding, 'tolist'):
        query_embedding = query_embedding.tolist()
    elif not isinstance(query_embedding, list):
        query_embedding = list(query_embedding)
    
    for other in other_entries:
        other_emb = other.embedding
        # Convert to list if it's a numpy array or vector type
        if hasattr(other_emb, 'tolist'):
            other_emb = other_emb.tolist()
        elif not isinstance(other_emb, list):
            other_emb = list(other_emb)
        similarity = compute_cosine_similarity(query_embedding, other_emb)
        similarities.append((other, similarity))
    
    # Sort by similarity (descending) and take top_k
    similarities.sort(key=lambda x: x[1], reverse=True)
    top_similar = similarities[:top_k]
    
    similar_entries = [
        SimilarEntry(
            id=e.id,
            content=e.content,
            similarity_score=score,
            created_at=e.created_at,
            emotion=e.emotion
        )
        for e, score in top_similar
    ]
    
    return SemanticSearchResponse(
        query_entry_id=entry_id,
        similar_entries=similar_entries
    )


@app.post("/search/semantic", response_model=TaskStatusResponse)
def semantic_search(
    request: TextSearchRequest,
    current_user: User = Depends(require_auth),
):
    """Queue semantic search over user's journal entries.
    Poll GET /tasks/{task_id} for result; on SUCCESS, result has query and results (list of SimilarEntry)."""
    task = semantic_search_task.delay(
        user_id=current_user.id,
        query=request.query,
        top_k=request.top_k,
    )
    ensure_worker_running()
    return TaskStatusResponse(task_id=task.id, status=task.state, result=None)


# ============== Cluster Visualization Endpoints ==============

@app.post("/clustering/run", response_model=TaskStatusResponse)
def create_clustering_run(
    request: ClusteringRunRequest,
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Queue clustering task for the authenticated user's entries with optional date filtering."""
    try:
        # Prepare date strings for the task
        start_date_str = None
        end_date_str = None
        if request.start_date:
            start_date_str = request.start_date.isoformat()
        if request.end_date:
            end_date_str = request.end_date.isoformat()
        
        # Queue the clustering task
        task = run_clustering_task.delay(
            user_id=current_user.id,
            start_date=start_date_str,
            end_date=end_date_str,
            min_cluster_size=request.min_cluster_size,
            min_samples=request.min_samples,
            membership_threshold=request.membership_threshold,
            cluster_selection_epsilon=request.cluster_selection_epsilon,
            umap_n_components=request.umap_n_components,
            umap_n_neighbors=request.umap_n_neighbors,
            umap_min_dist=request.umap_min_dist
        )
        ensure_worker_running()

        return TaskStatusResponse(
            task_id=task.id,
            status=task.state,
            result=None
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to queue clustering task: {str(e)}"
        )


@app.get("/clustering/recommend", response_model=ClusteringRecommendResponse)
def recommend_clustering_params(
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Analyze the user's journal entries and return heuristically recommended clustering parameters."""
    entries = db.query(JournalEntry).options(load_only(
        JournalEntry.id,
        JournalEntry.content,
        JournalEntry.emotion,
    )).filter(
        JournalEntry.user_id == current_user.id,
        JournalEntry.content.isnot(None)
    ).all()

    n = len(entries)

    if n < 5:
        return ClusteringRecommendResponse(
            params=RecommendedClusterParams(
                min_cluster_size=2,
                min_samples=1,
                membership_threshold=0.05,
                cluster_selection_epsilon=0.0,
                umap_n_components=5,
                umap_n_neighbors=5,
                umap_min_dist=0.0,
            ),
            reasoning=f"Not enough entries ({n}) for data-driven recommendations. Using defaults — add more entries for better suggestions.",
            embedding_coverage=0.0,
        )

    from hdbscan_clustering import analyze_entry_lengths
    length_stats = analyze_entry_lengths(entries)
    avg_words = float(length_stats["word_count"]["mean"])
    std_words = float(length_stats["word_count"]["std"])
    cv = std_words / avg_words if avg_words > 0 else 0.0

    emotions = [e.emotion for e in entries if e.emotion]
    distinct_emotions = len(set(emotions))
    n_embedded = db.query(func.count(JournalEntry.id)).filter(
        JournalEntry.user_id == current_user.id,
        JournalEntry.embedding.isnot(None)
    ).scalar()
    embedding_coverage = n_embedded / n if n > 0 else 0.0

    # --- Heuristic formulas ---

    # min_cluster_size: ~5% of entries; scale down for high emotion variety
    base_mcs = max(2, round(n * 0.05))
    if distinct_emotions >= 6:
        emotion_scale = 0.7
    elif distinct_emotions >= 4:
        emotion_scale = 0.85
    else:
        emotion_scale = 1.0
    min_cluster_size = max(2, min(20, round(base_mcs * emotion_scale)))

    # min_samples: 1 for clean data, 2 for high-variance/noisy journals
    min_samples = 2 if cv > 0.8 else 1

    # membership_threshold: low to allow multi-cluster membership for diverse journals
    membership_threshold = 0.05 if (distinct_emotions >= 5 or cv > 0.8) else 0.1

    # umap_n_neighbors: scales with sqrt(n) — more neighbors = more global structure
    umap_n_neighbors = max(5, min(50, round(math.sqrt(n) * 1.5)))

    # umap_n_components: log-scaled — more entries benefit from more dimensions
    umap_n_components = max(5, min(30, round(math.log2(max(n, 2)) * 1.5)))

    # cluster_selection_epsilon: small positive value merges nearby micro-clusters for sparse data
    cluster_selection_epsilon = 0.1 if n < 20 else 0.0

    # umap_min_dist: always 0.0 for tightest text clusters
    umap_min_dist = 0.0

    # Build human-readable reasoning
    reasoning_parts = [f"Based on {n} entries"]
    reasoning_parts.append(f"averaging {round(avg_words)} words")
    if distinct_emotions > 0:
        emotion_frac = len(emotions) / n
        reasoning_parts.append(
            f"{distinct_emotions} distinct emotion{'s' if distinct_emotions != 1 else ''} detected"
            f" across {round(emotion_frac * 100)}% of entries"
        )
    if cv > 0.8:
        reasoning_parts.append("high length variance suggests noisy/diverse writing")
    if embedding_coverage < 0.5:
        reasoning_parts.append(f"only {round(embedding_coverage * 100)}% of entries have embeddings — run 'Embed All' for best results")
    reasoning = ". ".join(reasoning_parts) + "."

    return ClusteringRecommendResponse(
        params=RecommendedClusterParams(
            min_cluster_size=min_cluster_size,
            min_samples=min_samples,
            membership_threshold=round(membership_threshold, 2),
            cluster_selection_epsilon=round(cluster_selection_epsilon, 1),
            umap_n_components=umap_n_components,
            umap_n_neighbors=umap_n_neighbors,
            umap_min_dist=umap_min_dist,
        ),
        reasoning=reasoning,
        embedding_coverage=round(embedding_coverage, 3),
    )


@app.get("/clustering/runs", response_model=List[ClusteringRunResponse])
def get_clustering_runs(
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Get all clustering runs for the authenticated user."""
    runs = db.query(ClusteringRun).filter(
        ClusteringRun.user_id == current_user.id
    ).order_by(ClusteringRun.run_timestamp.desc()).all()
    
    return [
        ClusteringRunResponse(
            id=run.id,
            run_timestamp=run.run_timestamp,
            num_entries=run.num_entries,
            num_clusters=run.num_clusters,
            min_cluster_size=run.min_cluster_size,
            min_samples=run.min_samples,
            membership_threshold=run.membership_threshold,
            noise_entries=run.noise_entries,
            start_date=run.start_date,
            end_date=run.end_date
        )
        for run in runs
    ]


@app.get("/clustering/runs/{run_id}/visualization", response_model=ClusterVisualizationResponse)
def get_cluster_visualization(
    run_id: int,
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Get cluster visualization data for a specific run."""
    run = db.query(ClusteringRun).filter(
        ClusteringRun.id == run_id,
        ClusteringRun.user_id == current_user.id
    ).first()

    if run is None:
        raise HTTPException(status_code=404, detail="Clustering run not found")

    # Get cluster assignments for this run
    assignments = db.query(EntryClusterAssignment).filter(
        EntryClusterAssignment.run_id == run_id
    ).all()

    # Build entry_id -> primary assignment and all-memberships maps
    entry_to_cluster: dict = {}
    entry_to_all_memberships: dict = {}

    for assignment in assignments:
        entry_to_all_memberships.setdefault(assignment.entry_id, []).append(assignment)
        if assignment.is_primary or assignment.entry_id not in entry_to_cluster:
            entry_to_cluster[assignment.entry_id] = {
                'cluster_id': assignment.cluster_id,
                'probability': assignment.membership_probability
            }

    assigned_entry_ids = set(entry_to_cluster.keys())
    if not assigned_entry_ids:
        raise HTTPException(status_code=400, detail="No entries found for this clustering run")

    # Get cluster metadata
    clusters = db.query(Cluster).filter(Cluster.run_id == run_id).all()
    cluster_info_map = {}
    for cluster in clusters:
        cluster_info_map[cluster.cluster_id] = {
            'name': cluster.topic_label or f"Cluster {cluster.cluster_id}",
            'size': cluster.size,
            'persistence': cluster.persistence,
            'topic_label': cluster.topic_label,
            'summary': cluster.summary
        }

    # --- Fast path: use pre-computed 2D coordinates stored on journal_entries ---
    # Load only the lightweight columns; skip the 384-dim embedding vector entirely.
    slim_entries = (
        db.query(JournalEntry)
        .options(load_only(
            JournalEntry.id,
            JournalEntry.title,
            JournalEntry.created_at,
            JournalEntry.umap_x,
            JournalEntry.umap_y,
        ))
        .filter(
            JournalEntry.user_id == current_user.id,
            JournalEntry.id.in_(assigned_entry_ids),
        )
        .order_by(JournalEntry.created_at.asc())
        .all()
    )

    has_coords = bool(slim_entries) and all(
        e.umap_x is not None and e.umap_y is not None for e in slim_entries
    )

    if has_coords:
        entries_with_assignments = slim_entries
        umap_coords = {e.id: (e.umap_x, e.umap_y) for e in slim_entries}
    else:
        # --- Migration guardrail: coordinates missing (pre-feature run or first time) ---
        # Compute UMAP on the fly over ALL user entries, save results, then continue.
        all_entries = db.query(JournalEntry).options(load_only(
            JournalEntry.id,
            JournalEntry.title,
            JournalEntry.created_at,
            JournalEntry.embedding,
        )).filter(
            JournalEntry.user_id == current_user.id,
            JournalEntry.embedding != None  # noqa: E711
        ).order_by(JournalEntry.created_at.asc()).all()

        if not all_entries:
            raise HTTPException(status_code=400, detail="No entries with embeddings found")

        entry_ids_for_umap = [e.id for e in all_entries]
        embedding_list = []
        for e in all_entries:
            emb = e.embedding
            if hasattr(emb, 'tolist'):
                embedding_list.append(np.array(emb, dtype=np.float32))
            elif isinstance(emb, list):
                embedding_list.append(np.array(emb, dtype=np.float32))
            else:
                embedding_list.append(np.array(list(emb), dtype=np.float32))
        embeddings = np.array(embedding_list)

        # Release the DB transaction before the UMAP computation so the connection
        # does not sit "idle in transaction" for the duration of the CPU-bound work.
        # expunge_all() keeps loaded attribute values accessible on the now-detached
        # objects (title, id, etc.) without requiring any further DB round-trips.
        db.expunge_all()
        db.rollback()

        try:
            import umap as umap_lib
            reducer = umap_lib.UMAP(
                n_components=2,
                n_neighbors=15,
                min_dist=0.1,
                metric='euclidean',
                random_state=42
            )
            embedding_2d = reducer.fit_transform(embeddings)
        except ImportError:
            raise HTTPException(
                status_code=503,
                detail="UMAP not available. Install with: pip install umap-learn"
            )

        from sqlalchemy import update as _sa_update
        umap_coords = {}
        update_rows = []
        for i, entry in enumerate(all_entries):
            x, y = float(embedding_2d[i, 0]), float(embedding_2d[i, 1])
            umap_coords[entry.id] = (x, y)
            update_rows.append({"id": entry_ids_for_umap[i], "umap_x": x, "umap_y": y})
        db.execute(_sa_update(JournalEntry), update_rows)
        db.commit()

        entries_with_assignments = [e for e in all_entries if e.id in assigned_entry_ids]
        if not entries_with_assignments:
            raise HTTPException(status_code=400, detail="No entries found for this clustering run")

    # Build response points
    points = []
    for entry in entries_with_assignments:
        assignment = entry_to_cluster[entry.id]
        cluster_id = assignment['cluster_id']
        cluster_name = (
            "Noise" if cluster_id == -1
            else cluster_info_map.get(cluster_id, {}).get('name', f"Cluster {cluster_id}")
        )

        all_memberships = []
        for membership in sorted(
            entry_to_all_memberships.get(entry.id, []),
            key=lambda x: x.membership_probability,
            reverse=True
        ):
            mem_cluster_name = (
                "Noise" if membership.cluster_id == -1
                else cluster_info_map.get(membership.cluster_id, {}).get('name', f"Cluster {membership.cluster_id}")
            )
            all_memberships.append(ClusterMembership(
                cluster_id=membership.cluster_id,
                cluster_name=mem_cluster_name,
                membership_probability=membership.membership_probability,
                is_primary=membership.is_primary
            ))

        x, y = umap_coords[entry.id]
        points.append(ClusterPoint(
            entry_id=entry.id,
            title=entry.title,
            x=x,
            y=y,
            cluster_id=cluster_id,
            cluster_name=cluster_name,
            membership_probability=assignment['probability'],
            all_memberships=all_memberships
        ))

    clusters_list = [
        ClusterInfoResponse(
            cluster_id=cluster.cluster_id,
            size=cluster.size,
            persistence=cluster.persistence,
            topic_label=cluster.topic_label,
            summary=cluster.summary
        )
        for cluster in clusters
    ]

    return ClusterVisualizationResponse(
        run_id=run_id,
        points=points,
        clusters=clusters_list
    )


@app.get("/clustering/entries/{entry_id}/memberships", response_model=EntryClusterMembershipsResponse)
def get_entry_cluster_memberships(
    entry_id: int,
    run_id: Optional[int] = None,
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """
    Get all cluster memberships for a specific entry.
    If run_id is not provided, uses the latest clustering run.
    """
    # Verify the entry belongs to the user
    exists = db.query(JournalEntry.id).filter(
        JournalEntry.id == entry_id,
        JournalEntry.user_id == current_user.id
    ).first()

    if exists is None:
        raise HTTPException(status_code=404, detail="Entry not found")

    # Get the clustering run
    if run_id is None:
        # Get latest run for this user
        latest_run = db.query(ClusteringRun).filter(
            ClusteringRun.user_id == current_user.id
        ).order_by(ClusteringRun.run_timestamp.desc()).first()
        
        if latest_run is None:
            raise HTTPException(status_code=404, detail="No clustering runs found for this user")
        
        run_id = latest_run.id
    else:
        # Verify the run belongs to the user
        run = db.query(ClusteringRun).filter(
            ClusteringRun.id == run_id,
            ClusteringRun.user_id == current_user.id
        ).first()
        
        if run is None:
            raise HTTPException(status_code=404, detail="Clustering run not found")
    
    # Get all cluster assignments for this entry in this run
    assignments = db.query(EntryClusterAssignment).filter(
        EntryClusterAssignment.entry_id == entry_id,
        EntryClusterAssignment.run_id == run_id
    ).order_by(EntryClusterAssignment.membership_probability.desc()).all()
    
    if not assignments:
        raise HTTPException(status_code=404, detail="No cluster assignments found for this entry")
    
    # Get cluster info to get names
    clusters = db.query(Cluster).filter(
        Cluster.run_id == run_id
    ).all()
    
    cluster_info_map = {}
    for cluster in clusters:
        cluster_name = cluster.topic_label or f"Cluster {cluster.cluster_id}"
        cluster_info_map[cluster.cluster_id] = cluster_name
    
    # Build memberships list
    memberships = []
    for assignment in assignments:
        cluster_name = (
            "Noise" if assignment.cluster_id == -1 
            else cluster_info_map.get(assignment.cluster_id, f"Cluster {assignment.cluster_id}")
        )
        memberships.append(ClusterMembership(
            cluster_id=assignment.cluster_id,
            cluster_name=cluster_name,
            membership_probability=assignment.membership_probability,
            is_primary=assignment.is_primary
        ))
    
    return EntryClusterMembershipsResponse(
        entry_id=entry_id,
        run_id=run_id,
        memberships=memberships
    )


@app.get("/clustering/clusters/{cluster_id}/entries", response_model=ClusterEntriesResponse)
def get_cluster_entries(
    cluster_id: int,
    run_id: Optional[int] = None,
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """
    Get all entries in a specific cluster.
    If run_id is not provided, uses the latest clustering run.
    """
    # Get the clustering run
    if run_id is None:
        # Get latest run for this user
        latest_run = db.query(ClusteringRun).filter(
            ClusteringRun.user_id == current_user.id
        ).order_by(ClusteringRun.run_timestamp.desc()).first()
        
        if latest_run is None:
            raise HTTPException(status_code=404, detail="No clustering runs found for this user")
        
        run_id = latest_run.id
    else:
        # Verify the run belongs to the user
        run = db.query(ClusteringRun).filter(
            ClusteringRun.id == run_id,
            ClusteringRun.user_id == current_user.id
        ).first()
        
        if run is None:
            raise HTTPException(status_code=404, detail="Clustering run not found")
    
    # Get cluster info
    cluster = db.query(Cluster).filter(
        Cluster.run_id == run_id,
        Cluster.cluster_id == cluster_id
    ).first()
    
    if cluster is None:
        raise HTTPException(status_code=404, detail="Cluster not found")
    
    cluster_name = cluster.topic_label or f"Cluster {cluster_id}"
    
    # Get all entries in this cluster
    assignments = db.query(EntryClusterAssignment).filter(
        EntryClusterAssignment.cluster_id == cluster_id,
        EntryClusterAssignment.run_id == run_id
    ).order_by(EntryClusterAssignment.membership_probability.desc()).all()
    
    if not assignments:
        return ClusterEntriesResponse(
            cluster_id=cluster_id,
            run_id=run_id,
            cluster_name=cluster_name,
            entries=[]
        )
    
    # Get the actual entry data
    entry_ids = [a.entry_id for a in assignments]
    entries = db.query(JournalEntry).options(load_only(
        JournalEntry.id,
        JournalEntry.title,
        JournalEntry.content,
        JournalEntry.created_at,
    )).filter(
        JournalEntry.id.in_(entry_ids),
        JournalEntry.user_id == current_user.id
    ).all()
    
    entry_map = {e.id: e for e in entries}
    
    # Build entries list
    entries_list = []
    for assignment in assignments:
        entry = entry_map.get(assignment.entry_id)
        if entry:
            entries_list.append(EntryClusterInfo(
                entry_id=entry.id,
                title=entry.title,
                content=entry.content,
                membership_probability=assignment.membership_probability,
                is_primary=assignment.is_primary,
                created_at=entry.created_at
            ))
    
    return ClusterEntriesResponse(
        cluster_id=cluster_id,
        run_id=run_id,
        cluster_name=cluster_name,
        entries=entries_list
    )


# ============== Therapy Question Endpoints ==============

@app.post("/therapy/ask", response_model=TaskStatusResponse)
def ask_therapy_question(
    request: TherapyQuestionRequest,
    current_user: User = Depends(require_auth),
):
    """
    Queue a therapy-style question to be answered by a LangChain agent
    (LLama 3.3 70B via OpenRouter) that searches the user's journal entries.

    Poll GET /tasks/{task_id} for the result. On SUCCESS the result contains:
      question, answer, steps (list of tool calls with observations).
    """
    if not request.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    task = therapy_question_task.delay(
        user_id=current_user.id,
        question=request.question.strip(),
    )
    ensure_worker_running()

    return TaskStatusResponse(task_id=task.id, status=task.state, result=None)


# ============== Conversation Endpoints ==============

@app.get("/conversations", response_model=List[ConversationListItem])
def list_conversations(
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db),
):
    """List all conversations for the current user, newest first."""
    conversations = (
        db.query(Conversation)
        .filter(Conversation.user_id == current_user.id)
        .order_by(Conversation.updated_at.desc())
        .all()
    )
    result = []
    for conv in conversations:
        count = db.query(func.count(ConversationMessage.id)).filter(
            ConversationMessage.conversation_id == conv.id
        ).scalar()
        result.append(ConversationListItem(
            id=conv.id,
            title=conv.title,
            created_at=conv.created_at,
            updated_at=conv.updated_at,
            message_count=count or 0,
        ))
    return result


@app.get("/conversations/{conversation_id}", response_model=ConversationResponse)
def get_conversation(
    conversation_id: int,
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db),
):
    """Get a conversation with all its messages."""
    conv = db.query(Conversation).filter(
        Conversation.id == conversation_id,
        Conversation.user_id == current_user.id,
    ).first()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


@app.post("/conversations/messages", response_model=SaveMessageResponse)
def save_message(
    request: SaveMessageRequest,
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db),
):
    """
    Append a message to a conversation. If conversation_id is None, a new
    conversation is created automatically. The conversation title is derived
    from the first user message (truncated to 80 chars).
    """
    if request.conversation_id:
        conv = db.query(Conversation).filter(
            Conversation.id == request.conversation_id,
            Conversation.user_id == current_user.id,
        ).first()
        if not conv:
            raise HTTPException(status_code=404, detail="Conversation not found")
    else:
        title = None
        if request.role == "user":
            title = request.content[:80] + ("…" if len(request.content) > 80 else "")
        conv = Conversation(user_id=current_user.id, title=title)
        db.add(conv)
        db.flush()

    msg = ConversationMessage(
        conversation_id=conv.id,
        role=request.role,
        content=request.content,
        steps=request.steps,
        is_error=request.is_error,
    )
    db.add(msg)

    # Update conversation timestamp and set title from first user message if not yet set
    conv.updated_at = datetime.now(timezone.utc)
    if conv.title is None and request.role == "user":
        conv.title = request.content[:80] + ("…" if len(request.content) > 80 else "")

    db.commit()
    db.refresh(msg)
    return SaveMessageResponse(conversation_id=conv.id, message_id=msg.id)


@app.delete("/conversations/{conversation_id}", status_code=204)
def delete_conversation(
    conversation_id: int,
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db),
):
    """Delete a conversation and all its messages."""
    conv = db.query(Conversation).filter(
        Conversation.id == conversation_id,
        Conversation.user_id == current_user.id,
    ).first()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    db.delete(conv)
    db.commit()
    return Response(status_code=204)


# ============== Task Status Endpoints ==============

@app.get("/tasks/{task_id}", response_model=TaskStatusResponse)
def get_task_status(
    task_id: str,
    current_user: User = Depends(require_auth)
):
    """Get the status of a Celery task."""
    task_result = AsyncResult(task_id, app=celery_app)
    
    response = TaskStatusResponse(
        task_id=task_id,
        status=task_result.state,
        result=None,
        error=None
    )
    
    if task_result.ready():
        if task_result.successful():
            response.result = task_result.result
        else:
            response.error = str(task_result.info)
    else:
        # Task is still pending or in progress
        if task_result.state == "PENDING":
            response.result = {"message": "Task is waiting to be processed"}
        elif task_result.state == "STARTED":
            response.result = {"message": "Task is being processed"}
    
    return response
