from pydantic import BaseModel
from datetime import datetime
from typing import Optional


class JournalEntryCreate(BaseModel):
    content: str


class JournalEntryUpdate(BaseModel):
    content: str


class JournalEntryResponse(BaseModel):
    id: int
    content: str
    created_at: datetime
    edited_at: Optional[datetime] = None

    class Config:
        from_attributes = True
