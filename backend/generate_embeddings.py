"""
Embedding Generation for Journal Entries

This script generates embeddings for journal entries using the BGE-M3 model
and saves them directly to the database's embedding field (vector 1024).
"""

import os
import sys
import numpy as np
from datetime import datetime
from typing import List, Optional, Tuple
from sqlalchemy.orm import Session
from sentence_transformers import SentenceTransformer
from tqdm import tqdm
from env import load_root_env

# Load environment variables (single consolidated root `.env`)
load_root_env()

# Configure Hugging Face cache directory
HF_HOME = os.getenv("HF_HOME", os.path.expanduser("~/.cache/huggingface"))
os.environ["HF_HOME"] = HF_HOME
os.environ["TRANSFORMERS_CACHE"] = HF_HOME
os.environ["HF_DATASETS_CACHE"] = HF_HOME

# Ensure cache directory exists
os.makedirs(HF_HOME, exist_ok=True)

# Add parent dir to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from database import SessionLocal
from models import JournalEntry, User


class EmbeddingGenerator:
    """Generates and manages embeddings for journal entries."""
    
    def __init__(self, model_name: str = "BAAI/bge-m3"):
        """
        Initialize the embedding generator.
        
        Args:
            model_name: The name of the sentence transformer model to use.
                       BGE-M3 produces 1024-dimensional embeddings.
        """
        self.model_name = model_name
        self.model = None
    
    def _load_model(self):
        """Lazy load the embedding model."""
        if self.model is None:
            print(f"Loading {self.model_name} model with HF_HOME={HF_HOME}...")
            self.model = SentenceTransformer(
                self.model_name,
                cache_folder=HF_HOME
            )
            print("Model loaded successfully.")
    
    def generate_embedding(self, text: str, max_length: int = 8192) -> np.ndarray:
        """
        Generate embedding for a single text.
        
        Args:
            text: The text to embed
            max_length: Maximum character length to truncate to
        
        Returns:
            1024-dimensional embedding vector
        """
        self._load_model()
        
        # Truncate text if needed (BGE-M3 supports ~8192 tokens)
        truncated_text = text[:max_length] if text else ""
        
        embedding = self.model.encode(
            truncated_text,
            normalize_embeddings=True,
            show_progress_bar=False
        )
        
        return embedding
    
    def generate_embeddings_batch(
        self,
        texts: List[str],
        batch_size: int = 8,
        max_length: int = 8192
    ) -> np.ndarray:
        """
        Generate embeddings for multiple texts in batches.
        
        Args:
            texts: List of texts to embed
            batch_size: Number of texts to process at once
            max_length: Maximum character length per text
        
        Returns:
            Array of embeddings with shape (n_texts, 1024)
        """
        self._load_model()
        
        # Truncate texts
        truncated_texts = [t[:max_length] if t else "" for t in texts]
        
        embeddings = self.model.encode(
            truncated_texts,
            normalize_embeddings=True,
            show_progress_bar=True,
            batch_size=batch_size
        )
        
        return embeddings


def get_entries_without_embeddings(
    db: Session,
    user_id: Optional[int] = None,
    limit: Optional[int] = None
) -> List[JournalEntry]:
    """
    Get journal entries that don't have embeddings yet.
    
    Args:
        db: Database session
        user_id: Optional user ID to filter by
        limit: Maximum number of entries to return
    
    Returns:
        List of JournalEntry objects without embeddings
    """
    query = db.query(JournalEntry).filter(JournalEntry.embedding.is_(None))
    
    if user_id is not None:
        query = query.filter(JournalEntry.user_id == user_id)
    
    query = query.order_by(JournalEntry.created_at)
    
    if limit is not None:
        query = query.limit(limit)
    
    return query.all()


def get_all_entries(
    db: Session,
    user_id: Optional[int] = None,
    limit: Optional[int] = None
) -> List[JournalEntry]:
    """
    Get all journal entries for a user.
    
    Args:
        db: Database session
        user_id: Optional user ID to filter by
        limit: Maximum number of entries to return
    
    Returns:
        List of JournalEntry objects
    """
    query = db.query(JournalEntry)
    
    if user_id is not None:
        query = query.filter(JournalEntry.user_id == user_id)
    
    query = query.order_by(JournalEntry.created_at)
    
    if limit is not None:
        query = query.limit(limit)
    
    return query.all()


def save_embedding_to_db(db: Session, entry: JournalEntry, embedding: np.ndarray):
    """
    Save an embedding to the database for a journal entry.
    
    Args:
        db: Database session
        entry: The journal entry to update
        embedding: The embedding vector (1024-dimensional)
    """
    # pgvector accepts numpy arrays directly
    entry.embedding = embedding
    db.commit()


def generate_and_save_embeddings(
    user_id: Optional[int] = None,
    regenerate: bool = False,
    batch_size: int = 8,
    limit: Optional[int] = None
) -> Tuple[int, int]:
    """
    Generate embeddings for journal entries and save them to the database.
    
    Args:
        user_id: Optional user ID to filter entries (None for all users)
        regenerate: If True, regenerate embeddings even for entries that have them
        batch_size: Number of entries to process at once
        limit: Maximum number of entries to process
    
    Returns:
        Tuple of (total_processed, newly_generated)
    """
    print(f"\n{'='*60}")
    print("Embedding Generation for Journal Entries")
    print(f"{'='*60}\n")
    
    db = SessionLocal()
    generator = EmbeddingGenerator()
    
    try:
        # Check user if specified
        if user_id is not None:
            user = db.query(User).filter(User.id == user_id).first()
            if user:
                print(f"User: {user.email} (ID: {user.id})")
            else:
                print(f"Warning: User ID {user_id} not found")
        
        # Get entries to process
        if regenerate:
            entries = get_all_entries(db, user_id=user_id, limit=limit)
            print(f"Regenerating embeddings for ALL {len(entries)} entries")
        else:
            entries = get_entries_without_embeddings(db, user_id=user_id, limit=limit)
            print(f"Found {len(entries)} entries without embeddings")
        
        if not entries:
            print("No entries to process.")
            return 0, 0
        
        # Process in batches
        total_batches = (len(entries) + batch_size - 1) // batch_size
        newly_generated = 0
        
        for batch_idx in tqdm(range(total_batches)):
            start_idx = batch_idx * batch_size
            end_idx = min((batch_idx + 1) * batch_size, len(entries))
            batch_entries = entries[start_idx:end_idx]
            
            print(f"\nProcessing batch {batch_idx + 1}/{total_batches} "
                  f"(entries {start_idx + 1}-{end_idx})...")
            
            # Get texts for batch
            texts = [e.content for e in batch_entries]
            
            # Generate embeddings
            embeddings = generator.generate_embeddings_batch(texts, batch_size=batch_size)
            
            # Save each embedding to database
            for entry, embedding in zip(batch_entries, embeddings):
                save_embedding_to_db(db, entry, embedding)
                newly_generated += 1
            
            print(f"  Saved {len(batch_entries)} embeddings to database")
        
        print(f"\n{'='*60}")
        print(f"Embedding generation complete!")
        print(f"Total entries processed: {len(entries)}")
        print(f"Embeddings generated: {newly_generated}")
        print(f"{'='*60}\n")
        
        return len(entries), newly_generated
        
    finally:
        db.close()


def check_embedding_status(user_id: Optional[int] = None):
    """
    Check the embedding status for journal entries.
    
    Args:
        user_id: Optional user ID to filter by
    """
    db = SessionLocal()
    
    try:
        # Count total entries
        total_query = db.query(JournalEntry)
        if user_id is not None:
            total_query = total_query.filter(JournalEntry.user_id == user_id)
        total_count = total_query.count()
        
        # Count entries with embeddings
        with_embedding_query = db.query(JournalEntry).filter(
            JournalEntry.embedding.isnot(None)
        )
        if user_id is not None:
            with_embedding_query = with_embedding_query.filter(
                JournalEntry.user_id == user_id
            )
        with_embedding_count = with_embedding_query.count()
        
        # Count entries without embeddings
        without_embedding_count = total_count - with_embedding_count
        
        print(f"\n{'='*60}")
        print("Embedding Status Report")
        print(f"{'='*60}")
        if user_id is not None:
            print(f"User ID: {user_id}")
        print(f"Total entries: {total_count}")
        print(f"With embeddings: {with_embedding_count} ({100*with_embedding_count/total_count:.1f}%)" if total_count > 0 else "With embeddings: 0")
        print(f"Without embeddings: {without_embedding_count}")
        print(f"{'='*60}\n")
        
    finally:
        db.close()


def clear_embeddings(user_id: Optional[int] = None, confirm: bool = False):
    """
    Clear all embeddings from the database.
    
    Args:
        user_id: Optional user ID to filter by (None for all users)
        confirm: Must be True to actually clear embeddings
    """
    if not confirm:
        print("WARNING: This will clear all embeddings. Pass confirm=True to proceed.")
        return
    
    db = SessionLocal()
    
    try:
        query = db.query(JournalEntry)
        if user_id is not None:
            query = query.filter(JournalEntry.user_id == user_id)
        
        entries = query.all()
        count = 0
        
        for entry in entries:
            if entry.embedding is not None:
                entry.embedding = None
                count += 1
        
        db.commit()
        print(f"Cleared {count} embeddings from database.")
        
    finally:
        db.close()


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(
        description="Generate embeddings for journal entries"
    )
    parser.add_argument(
        "--user-id", type=int, default=None,
        help="User ID to process (default: all users)"
    )
    parser.add_argument(
        "--regenerate", action="store_true",
        help="Regenerate embeddings even for entries that have them"
    )
    parser.add_argument(
        "--batch-size", type=int, default=8,
        help="Batch size for processing (default: 8)"
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Maximum number of entries to process"
    )
    parser.add_argument(
        "--status", action="store_true",
        help="Show embedding status report only"
    )
    parser.add_argument(
        "--clear", action="store_true",
        help="Clear all embeddings (use with --confirm)"
    )
    parser.add_argument(
        "--confirm", action="store_true",
        help="Confirm destructive operations"
    )
    
    args = parser.parse_args()
    
    if args.status:
        check_embedding_status(user_id=args.user_id)
    elif args.clear:
        clear_embeddings(user_id=args.user_id, confirm=args.confirm)
    else:
        generate_and_save_embeddings(
            user_id=args.user_id,
            regenerate=args.regenerate,
            batch_size=args.batch_size,
            limit=args.limit
        )
