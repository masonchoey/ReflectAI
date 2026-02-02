import os
from fastapi import FastAPI, Depends, HTTPException, status
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
from dotenv import load_dotenv

from database import engine, get_db, Base
from models import JournalEntry, User
from schemas import (
    JournalEntryCreate, JournalEntryUpdate, JournalEntryResponse,
    EmotionAnalysisResponse, EmotionResult, EmbeddingResponse,
    SimilarEntry, SemanticSearchResponse, TextSearchRequest, TextSearchResponse,
    TokenizationResponse, GoogleAuthRequest, AuthResponse, UserResponse
)

load_dotenv()

# JWT Configuration
SECRET_KEY = os.getenv("JWT_SECRET_KEY", "")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 7

# Google OAuth Configuration
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")

Base.metadata.create_all(bind=engine)

app = FastAPI(title="ReflectAI Journal API")

# Security scheme for JWT
security = HTTPBearer(auto_error=False)

# Load the emotion classification model at startup
emotion_classifier = pipeline(
    "text-classification",
    model="SamLowe/roberta-base-go_emotions",
    top_k=None
)

# Load the BGE-M3 embedding model at startup
print("Loading BAAI/bge-m3 model...")
embedding_model = SentenceTransformer("BAAI/bge-m3")
print("BGE-M3 model loaded successfully!")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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
    entry = db.query(JournalEntry).filter(
        JournalEntry.id == entry_id,
        JournalEntry.user_id == current_user.id
    ).first()
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    
    # Truncate text if too long (model has max token limit)
    text = entry.content[:512]
    
    # Run emotion classification
    results = emotion_classifier(text)[0]
    
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
    entry = db.query(JournalEntry).filter(
        JournalEntry.id == entry_id,
        JournalEntry.user_id == current_user.id
    ).first()
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    
    tokenizer = embedding_model.tokenizer
    
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


@app.post("/entries/{entry_id}/embed", response_model=EmbeddingResponse)
def embed_entry(
    entry_id: int,
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Generate and store embedding for a journal entry (must belong to authenticated user)."""
    entry = db.query(JournalEntry).filter(
        JournalEntry.id == entry_id,
        JournalEntry.user_id == current_user.id
    ).first()
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    
    # Generate embedding using BGE-M3
    embedding = embedding_model.encode(entry.content, normalize_embeddings=True)
    
    # Get token count
    tokenizer = embedding_model.tokenizer
    tokens = tokenizer.encode(entry.content)
    token_count = len(tokens)
    
    # Store embedding
    entry.embedding = embedding.tolist()
    db.commit()
    db.refresh(entry)
    
    return EmbeddingResponse(
        entry_id=entry.id,
        token_count=token_count,
        embedding_dimension=len(embedding),
        message=f"Successfully generated embedding with {len(embedding)} dimensions"
    )


@app.post("/entries/embed-all", response_model=List[EmbeddingResponse])
def embed_all_entries(
    current_user: User = Depends(require_auth),
    db: Session = Depends(get_db)
):
    """Generate embeddings for all user's entries that don't have one."""
    entries = db.query(JournalEntry).filter(
        JournalEntry.user_id == current_user.id,
        JournalEntry.embedding == None
    ).all()
    
    if not entries:
        return []
    
    results = []
    tokenizer = embedding_model.tokenizer
    
    # Batch encode for efficiency
    contents = [entry.content for entry in entries]
    embeddings = embedding_model.encode(contents, normalize_embeddings=True, show_progress_bar=True)
    
    for entry, embedding in zip(entries, embeddings):
        tokens = tokenizer.encode(entry.content)
        entry.embedding = embedding.tolist()
        
        results.append(EmbeddingResponse(
            entry_id=entry.id,
            token_count=len(tokens),
            embedding_dimension=len(embedding),
            message=f"Successfully generated embedding"
        ))
    
    db.commit()
    return results


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
    
    for other in other_entries:
        similarity = compute_cosine_similarity(query_embedding, other.embedding)
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
    # Generate embedding for the query text
    query_embedding = embedding_model.encode(request.query, normalize_embeddings=True)
    
    # Get all entries with embeddings for this user
    entries = db.query(JournalEntry).filter(
        JournalEntry.user_id == current_user.id,
        JournalEntry.embedding != None
    ).all()
    
    if not entries:
        return TextSearchResponse(query=request.query, results=[])
    
    # Compute similarities
    similarities = []
    for entry in entries:
        similarity = compute_cosine_similarity(query_embedding.tolist(), entry.embedding)
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
