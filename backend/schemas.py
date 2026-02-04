from pydantic import BaseModel
from datetime import datetime
from typing import Optional, List


# Auth schemas
class GoogleAuthRequest(BaseModel):
    credential: str  # The ID token from Google Sign-In


class UserResponse(BaseModel):
    id: int
    google_id: str
    email: str
    name: Optional[str] = None
    picture: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse


# Journal entry schemas
class JournalEntryCreate(BaseModel):
    title: Optional[str] = None
    content: str


class JournalEntryUpdate(BaseModel):
    title: Optional[str] = None
    content: str


class JournalEntryResponse(BaseModel):
    id: int
    user_id: int
    title: Optional[str] = None
    content: str
    created_at: datetime
    edited_at: Optional[datetime] = None
    emotion: Optional[str] = None
    emotion_score: Optional[float] = None
    has_embedding: bool = False

    class Config:
        from_attributes = True


class EmotionResult(BaseModel):
    label: str
    score: float


class EmotionAnalysisResponse(BaseModel):
    entry_id: int
    emotion: str
    emotion_score: float
    all_emotions: List[EmotionResult]


class EmbeddingResponse(BaseModel):
    entry_id: int
    token_count: int
    embedding_dimension: int
    message: str


class SimilarEntry(BaseModel):
    id: int
    title: Optional[str] = None
    content: str
    similarity_score: float
    created_at: datetime
    emotion: Optional[str] = None


class SemanticSearchResponse(BaseModel):
    query_entry_id: int
    similar_entries: List[SimilarEntry]


class TextSearchRequest(BaseModel):
    query: str
    top_k: int = 5


class TextSearchResponse(BaseModel):
    query: str
    results: List[SimilarEntry]


class TokenizationResponse(BaseModel):
    entry_id: int
    text: str
    token_count: int
    tokens: List[str]
    token_ids: List[int]


# Cluster schemas
class ClusteringRunResponse(BaseModel):
    id: int
    run_timestamp: datetime
    num_entries: int
    num_clusters: int
    min_cluster_size: int
    min_samples: Optional[int] = None
    membership_threshold: float
    noise_entries: int

    class Config:
        from_attributes = True


class ClusterInfoResponse(BaseModel):
    cluster_id: int
    size: int
    persistence: Optional[float] = None
    topic_label: Optional[str] = None

    class Config:
        from_attributes = True


class ClusterPoint(BaseModel):
    entry_id: int
    title: Optional[str] = None
    x: float
    y: float
    cluster_id: int
    cluster_name: str
    membership_probability: float


class ClusterVisualizationResponse(BaseModel):
    run_id: int
    points: List[ClusterPoint]
    clusters: List[ClusterInfoResponse]
