import os
import threading
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException, status, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from typing import List, Optional
from datetime import datetime, timezone, timedelta
from transformers import pipeline
from sentence_transformers import SentenceTransformer
import numpy as np
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests
from jose import JWTError, jwt
from env import load_root_env

from database import engine, get_db, Base
from models import JournalEntry, User, ClusteringRun, Cluster, EntryClusterAssignment
from schemas import (
    JournalEntryCreate, JournalEntryUpdate, JournalEntryResponse,
    EmotionAnalysisResponse, EmotionResult, EmbeddingResponse,
    SimilarEntry, SemanticSearchResponse, TextSearchRequest, TextSearchResponse,
    TokenizationResponse, GoogleAuthRequest, AuthResponse, UserResponse,
    ClusteringRunRequest, ClusteringRunResponse, ClusterInfoResponse, ClusterPoint, ClusterVisualizationResponse,
    TaskStatusResponse
)
from tasks import vectorize_entry, vectorize_all_entries, run_clustering_task
from celery.result import AsyncResult
from celery_app import celery_app

load_root_env()

# Configure Hugging Face cache directory
HF_HOME = os.getenv("HF_HOME", os.path.expanduser("~/.cache/huggingface"))
os.environ["HF_HOME"] = HF_HOME
os.environ["TRANSFORMERS_CACHE"] = HF_HOME
os.environ["HF_DATASETS_CACHE"] = HF_HOME

# Ensure cache directory exists
os.makedirs(HF_HOME, exist_ok=True)

# JWT Configuration
SECRET_KEY = os.getenv("JWT_SECRET_KEY", "")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 7

# Google OAuth Configuration
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")

Base.metadata.create_all(bind=engine)

# Security scheme for JWT
security = HTTPBearer(auto_error=False)

# Model state - loaded lazily on first use
emotion_classifier = None
embedding_model = None
models_loaded = False


def load_models():
    """Load models if they haven't been loaded yet."""
    global emotion_classifier, embedding_model, models_loaded

    # If models are already loaded, do nothing
    if models_loaded and emotion_classifier is not None and embedding_model is not None:
        return
    
    print(f"Loading models with HF_HOME={HF_HOME}...")
    
    print("Loading SamLowe/roberta-base-go_emotions model...")
    emotion_classifier = pipeline(
        "text-classification",
        model="SamLowe/roberta-base-go_emotions",
        top_k=None,
        cache_dir=HF_HOME
    )
    print("Emotion classifier loaded successfully!")
    
    print("Loading BAAI/bge-m3 model...")
    embedding_model = SentenceTransformer(
        "BAAI/bge-m3",
        cache_folder=HF_HOME
    )
    print("BGE-M3 model loaded successfully!")
    
    models_loaded = True
    print("All models loaded and ready!")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for startup/shutdown tasks."""
    # Check if model preloading is enabled (default: True for local development)
    # Set ENABLE_MODEL_PRELOAD=false in production to disable
    enable_preload = os.getenv("ENABLE_MODEL_PRELOAD", "true").lower() in ("true", "1", "yes")
    
    if enable_preload:
        # Preload models in background to reduce cold start latency
        def preload_models():
            try:
                load_models()
            except Exception as e:
                print(f"Warning: Failed to preload models: {e}")
        
        # Start model loading in background thread
        model_thread = threading.Thread(target=preload_models, daemon=True)
        model_thread.start()
        print("Model preloading enabled - starting background model load...")
    else:
        print("Model preloading disabled - models will be loaded on first use")
    
    yield
    # Cleanup (if needed)


app = FastAPI(title="ReflectAI Journal API", lifespan=lifespan)

# CORS configuration - allow both local development and production
# Accept comma-separated list of origins from environment variable
CORS_ORIGINS_STR = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://localhost:3000,http://localhost")
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
    
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found"
        )
    
    return user


# ============== Helper Functions ==============

def require_emotion_model():
    """Get the emotion classifier, loading models lazily if needed."""
    global emotion_classifier
    if emotion_classifier is None:
        load_models()
    return emotion_classifier


def require_embedding_model():
    """Get the embedding model, loading models lazily if needed."""
    global embedding_model
    if embedding_model is None:
        load_models()
    return embedding_model


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
        # Update last login and info
        user.last_login = datetime.now(timezone.utc)
        user.name = google_user.get('name')
        user.picture = google_user.get('picture')
    else:
        # Create new user
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
    """Get the status of the API and model loading."""
    return {
        "status": "ready" if models_loaded else "loading",
        "models_loaded": models_loaded,
        "emotion_model_ready": emotion_classifier is not None,
        "embedding_model_ready": embedding_model is not None,
        "hf_home": HF_HOME
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
    entries = db.query(JournalEntry).filter(
        JournalEntry.user_id == current_user.id
    ).order_by(JournalEntry.created_at.desc()).all()
    return [entry_to_response(e) for e in entries]


@app.get("/entries/{entry_id}", response_model=JournalEntryResponse)
def get_entry(
    entry_id: int,
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Get a specific journal entry (must belong to authenticated user)."""
    entry = db.query(JournalEntry).filter(
        JournalEntry.id == entry_id,
        JournalEntry.user_id == current_user.id
    ).first()
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    return entry_to_response(entry)


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
        print(f"Queued vectorization task {task.id} for entry {entry_id}")
    except Exception as e:
        print(f"Warning: Failed to queue vectorization task: {e}")
        # Continue without regenerating embedding - user can regenerate it later
    
    db.commit()
    db.refresh(entry)
    return entry_to_response(entry)


@app.post("/entries/{entry_id}/analyze", response_model=EmotionAnalysisResponse)
def analyze_emotion(
    entry_id: int,
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Analyze emotions in a journal entry (must belong to authenticated user)."""
    classifier = require_emotion_model()
    
    entry = db.query(JournalEntry).filter(
        JournalEntry.id == entry_id,
        JournalEntry.user_id == current_user.id
    ).first()
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    
    # Truncate text if too long (model has max token limit)
    text = entry.content[:512]
    
    # Run emotion classification
    results = classifier(text)[0]
    
    # Sort by score and get top emotion
    sorted_results = sorted(results, key=lambda x: x['score'], reverse=True)
    top_emotion = sorted_results[0]
    
    # Save emotion to database
    entry.emotion = top_emotion['label']
    entry.emotion_score = top_emotion['score']
    db.commit()
    db.refresh(entry)
    
    # Return full analysis
    all_emotions = [EmotionResult(label=r['label'], score=r['score']) for r in sorted_results[:5]]
    
    return EmotionAnalysisResponse(
        entry_id=entry.id,
        emotion=top_emotion['label'],
        emotion_score=top_emotion['score'],
        all_emotions=all_emotions
    )


@app.get("/entries/{entry_id}/tokenize", response_model=TokenizationResponse)
def tokenize_entry(
    entry_id: int,
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Tokenize a journal entry (must belong to authenticated user)."""
    model = require_embedding_model()
    
    entry = db.query(JournalEntry).filter(
        JournalEntry.id == entry_id,
        JournalEntry.user_id == current_user.id
    ).first()
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    
    tokenizer = model.tokenizer
    
    # Tokenize the text
    encoded = tokenizer.encode_plus(
        entry.content,
        add_special_tokens=True,
        return_tensors=None
    )
    
    token_ids = encoded['input_ids']
    tokens = tokenizer.convert_ids_to_tokens(token_ids)
    
    return TokenizationResponse(
        entry_id=entry.id,
        text=entry.content,
        token_count=len(tokens),
        tokens=tokens,
        token_ids=token_ids
    )


@app.post("/entries/{entry_id}/embed", response_model=TaskStatusResponse)
def embed_entry(
    entry_id: int,
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Queue embedding generation for a journal entry (must belong to authenticated user)."""
    entry = db.query(JournalEntry).filter(
        JournalEntry.id == entry_id,
        JournalEntry.user_id == current_user.id
    ).first()
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    
    # Queue vectorization task
    task = vectorize_entry.delay(entry_id)
    
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
    entry = db.query(JournalEntry).filter(
        JournalEntry.id == entry_id,
        JournalEntry.user_id == current_user.id
    ).first()
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    
    if entry.embedding is None:
        raise HTTPException(status_code=400, detail="Entry has no embedding. Call /entries/{entry_id}/embed first.")
    
    # Get all other entries with embeddings for this user
    other_entries = db.query(JournalEntry).filter(
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


@app.post("/search/semantic", response_model=TextSearchResponse)
def semantic_search(
    request: TextSearchRequest,
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Search user's journal entries using semantic similarity."""
    model = require_embedding_model()
    
    # Generate embedding for the query text
    query_embedding = model.encode(request.query, normalize_embeddings=True)
    
    # Get all entries with embeddings for this user
    entries = db.query(JournalEntry).filter(
        JournalEntry.user_id == current_user.id,
        JournalEntry.embedding != None
    ).all()
    
    if not entries:
        return TextSearchResponse(query=request.query, results=[])
    
    # Compute similarities
    similarities = []
    query_emb_list = query_embedding.tolist() if hasattr(query_embedding, 'tolist') else list(query_embedding)
    for entry in entries:
        entry_emb = entry.embedding
        # Convert to list if it's a numpy array or vector type
        if hasattr(entry_emb, 'tolist'):
            entry_emb = entry_emb.tolist()
        elif not isinstance(entry_emb, list):
            entry_emb = list(entry_emb)
        similarity = compute_cosine_similarity(query_emb_list, entry_emb)
        similarities.append((entry, similarity))
    
    # Sort by similarity and take top_k
    similarities.sort(key=lambda x: x[1], reverse=True)
    top_results = similarities[:request.top_k]
    
    results = [
        SimilarEntry(
            id=e.id,
            content=e.content,
            similarity_score=score,
            created_at=e.created_at,
            emotion=e.emotion
        )
        for e, score in top_results
    ]
    
    return TextSearchResponse(query=request.query, results=results)


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
    # Verify the run belongs to the user
    run = db.query(ClusteringRun).filter(
        ClusteringRun.id == run_id,
        ClusteringRun.user_id == current_user.id
    ).first()
    
    if run is None:
        raise HTTPException(status_code=404, detail="Clustering run not found")
    
    # Get all entries with embeddings for this user, sorted by created_at
    entries = db.query(JournalEntry).filter(
        JournalEntry.user_id == current_user.id,
        JournalEntry.embedding != None
    ).order_by(JournalEntry.created_at.asc()).all()
    
    if not entries:
        raise HTTPException(status_code=400, detail="No entries with embeddings found")
    
    # Get cluster assignments for this run
    assignments = db.query(EntryClusterAssignment).filter(
        EntryClusterAssignment.run_id == run_id
    ).all()
    
    # Create a mapping: entry_id -> primary cluster assignment
    entry_to_cluster = {}
    for assignment in assignments:
        if assignment.is_primary or assignment.entry_id not in entry_to_cluster:
            entry_to_cluster[assignment.entry_id] = {
                'cluster_id': assignment.cluster_id,
                'probability': assignment.membership_probability
            }
    
    # Get cluster info
    clusters = db.query(Cluster).filter(
        Cluster.run_id == run_id
    ).all()
    
    cluster_info_map = {}
    for cluster in clusters:
        cluster_name = cluster.topic_label or f"Cluster {cluster.cluster_id}"
        cluster_info_map[cluster.cluster_id] = {
            'name': cluster_name,
            'size': cluster.size,
            'persistence': cluster.persistence,
            'topic_label': cluster.topic_label
        }
    
    # Filter entries that have assignments in this run
    entries_with_assignments = [e for e in entries if e.id in entry_to_cluster]
    
    if not entries_with_assignments:
        raise HTTPException(status_code=400, detail="No entries found for this clustering run")
    
    # Extract embeddings
    embedding_list = []
    for e in entries_with_assignments:
        emb = e.embedding
        # Convert to numpy array if needed
        if hasattr(emb, 'tolist'):
            embedding_list.append(emb)
        elif isinstance(emb, list):
            embedding_list.append(np.array(emb, dtype=np.float32))
        else:
            embedding_list.append(np.array(list(emb), dtype=np.float32))
    embeddings = np.array(embedding_list)
    
    # Use UMAP to reduce to 2D for visualization
    try:
        import umap
        reducer = umap.UMAP(
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
    
    # Build points list
    points = []
    for i, entry in enumerate(entries_with_assignments):
        assignment = entry_to_cluster[entry.id]
        cluster_id = assignment['cluster_id']
        
        # Handle noise points (cluster_id = -1)
        if cluster_id == -1:
            cluster_name = "Noise"
        else:
            cluster_name = cluster_info_map.get(cluster_id, {}).get('name', f"Cluster {cluster_id}")
        
        points.append(ClusterPoint(
            entry_id=entry.id,
            title=entry.title,
            x=float(embedding_2d[i, 0]),
            y=float(embedding_2d[i, 1]),
            cluster_id=cluster_id,
            cluster_name=cluster_name,
            membership_probability=assignment['probability']
        ))
    
    # Build clusters list
    clusters_list = [
        ClusterInfoResponse(
            cluster_id=cluster.cluster_id,
            size=cluster.size,
            persistence=cluster.persistence,
            topic_label=cluster.topic_label
        )
        for cluster in clusters
    ]
    
    return ClusterVisualizationResponse(
        run_id=run_id,
        points=points,
        clusters=clusters_list
    )


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
