from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from typing import List
from datetime import datetime, timezone

from database import engine, get_db, Base
from models import JournalEntry
from schemas import JournalEntryCreate, JournalEntryUpdate, JournalEntryResponse

Base.metadata.create_all(bind=engine)

app = FastAPI(title="ReflectAI Journal API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def read_root():
    return {"message": "Welcome to ReflectAI Journal API"}


@app.post("/entries", response_model=JournalEntryResponse)
def create_entry(entry: JournalEntryCreate, db: Session = Depends(get_db)):
    db_entry = JournalEntry(content=entry.content)
    db.add(db_entry)
    db.commit()
    db.refresh(db_entry)
    return db_entry


@app.get("/entries", response_model=List[JournalEntryResponse])
def get_entries(db: Session = Depends(get_db)):
    entries = db.query(JournalEntry).order_by(JournalEntry.created_at.desc()).all()
    return entries


@app.get("/entries/{entry_id}", response_model=JournalEntryResponse)
def get_entry(entry_id: int, db: Session = Depends(get_db)):
    entry = db.query(JournalEntry).filter(JournalEntry.id == entry_id).first()
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    return entry


@app.put("/entries/{entry_id}", response_model=JournalEntryResponse)
def update_entry(entry_id: int, entry_update: JournalEntryUpdate, db: Session = Depends(get_db)):
    entry = db.query(JournalEntry).filter(JournalEntry.id == entry_id).first()
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    
    entry.content = entry_update.content
    entry.edited_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(entry)
    return entry
