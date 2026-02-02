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
