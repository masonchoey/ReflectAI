from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from typing import List
from datetime import datetime, timezone
from transformers import pipeline

from database import engine, get_db, Base
from models import JournalEntry
from schemas import JournalEntryCreate, JournalEntryUpdate, JournalEntryResponse, EmotionAnalysisResponse, EmotionResult

Base.metadata.create_all(bind=engine)

app = FastAPI(title="ReflectAI Journal API")

# Load the emotion classification model at startup
emotion_classifier = pipeline(
    "text-classification",
    model="SamLowe/roberta-base-go_emotions",
    top_k=None
)

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


@app.post("/entries/{entry_id}/analyze", response_model=EmotionAnalysisResponse)
def analyze_emotion(entry_id: int, db: Session = Depends(get_db)):
    entry = db.query(JournalEntry).filter(JournalEntry.id == entry_id).first()
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
