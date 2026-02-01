from pydantic import BaseModel
from datetime import datetime
from typing import Optional, List


class JournalEntryCreate(BaseModel):
    content: str


class JournalEntryUpdate(BaseModel):
    content: str


class JournalEntryResponse(BaseModel):
    id: int
    content: str
    created_at: datetime
    edited_at: Optional[datetime] = None
    emotion: Optional[str] = None
    emotion_score: Optional[float] = None

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
