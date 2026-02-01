from sqlalchemy import Column, Integer, Text, DateTime
from sqlalchemy.sql import func
from database import Base
from datetime import datetime, timezone


class JournalEntry(Base):
    __tablename__ = "journal_entries"

    id = Column(Integer, primary_key=True, index=True)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    edited_at = Column(DateTime(timezone=True), nullable=True)