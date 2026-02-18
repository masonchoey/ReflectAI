"""
Celery tasks for async processing of journal entries.
"""
import os
from celery import Task
from sqlalchemy.orm import Session
from sentence_transformers import SentenceTransformer
import numpy as np
from datetime import datetime, timezone
from typing import Optional
from database import SessionLocal
from models import JournalEntry
from celery_app import celery_app
from hdbscan_clustering import run_clustering

# Model state - loaded lazily on first use
_embedding_model = None
_models_loaded = False

# Configure Hugging Face cache directory
HF_HOME = os.getenv("HF_HOME", os.path.expanduser("~/.cache/huggingface"))
os.environ["HF_HOME"] = HF_HOME
os.environ["TRANSFORMERS_CACHE"] = HF_HOME
os.environ["HF_DATASETS_CACHE"] = HF_HOME

# Ensure cache directory exists
os.makedirs(HF_HOME, exist_ok=True)


def get_embedding_model():
    """Get or load the embedding model."""
    global _embedding_model, _models_loaded
    
    if _embedding_model is None or not _models_loaded:
        print(f"Loading BAAI/bge-m3 model with HF_HOME={HF_HOME}...")
        _embedding_model = SentenceTransformer(
            "BAAI/bge-m3",
            cache_folder=HF_HOME
        )
        _models_loaded = True
        print("BGE-M3 model loaded successfully!")
    
    return _embedding_model


class DatabaseTask(Task):
    """Base task class that provides database session management."""
    _db = None

    @property
    def db(self):
        """Get or create a database session."""
        if self._db is None:
            self._db = SessionLocal()
        return self._db

    def after_return(self, *args, **kwargs):
        """Close database session after task completion."""
        if self._db is not None:
            self._db.close()
            self._db = None


@celery_app.task(base=DatabaseTask, bind=True, name="tasks.vectorize_entry")
def vectorize_entry(self, entry_id: int):
    """
    Generate and store embedding for a single journal entry.
    
    Args:
        entry_id: The ID of the journal entry to vectorize
        
    Returns:
        dict: Result containing entry_id, token_count, embedding_dimension, and status
    """
    db: Session = None
    try:
        db = self.db
        
        # Get the entry
        entry = db.query(JournalEntry).filter(JournalEntry.id == entry_id).first()
        if entry is None:
            return {
                "status": "error",
                "entry_id": entry_id,
                "message": "Entry not found"
            }
        
        # Load embedding model
        model = get_embedding_model()
        
        # Generate embedding using BGE-M3
        embedding = model.encode(entry.content, normalize_embeddings=True)
        
        # Get token count
        tokenizer = model.tokenizer
        tokens = tokenizer.encode(entry.content)
        token_count = len(tokens)
        
        # Store embedding (pgvector accepts numpy arrays directly)
        entry.embedding = embedding
        db.commit()
        db.refresh(entry)
        
        return {
            "status": "success",
            "entry_id": entry.id,
            "token_count": token_count,
            "embedding_dimension": len(embedding),
            "message": f"Successfully generated embedding with {len(embedding)} dimensions"
        }
    except Exception as e:
        # Rollback on error
        if db is not None:
            db.rollback()
        return {
            "status": "error",
            "entry_id": entry_id,
            "message": f"Error vectorizing entry: {str(e)}"
        }


@celery_app.task(base=DatabaseTask, bind=True, name="tasks.vectorize_all_entries")
def vectorize_all_entries(self, user_id: int):
    """
    Generate embeddings for all user's entries that don't have one.
    
    Args:
        user_id: The ID of the user whose entries should be vectorized
        
    Returns:
        dict: Result containing status, total_entries, processed_count, and results
    """
    db: Session = None
    try:
        db = self.db
        
        # Get all entries without embeddings for this user
        entries = db.query(JournalEntry).filter(
            JournalEntry.user_id == user_id,
            JournalEntry.embedding == None
        ).all()
        
        if not entries:
            return {
                "status": "success",
                "user_id": user_id,
                "total_entries": 0,
                "processed_count": 0,
                "results": []
            }
        
        # Load embedding model
        model = get_embedding_model()
        tokenizer = model.tokenizer
        
        results = []
        
        # Batch encode for efficiency
        contents = [entry.content for entry in entries]
        embeddings = model.encode(contents, normalize_embeddings=True, show_progress_bar=True)
        
        for entry, embedding in zip(entries, embeddings):
            tokens = tokenizer.encode(entry.content)
            entry.embedding = embedding  # pgvector accepts numpy arrays directly
            
            results.append({
                "entry_id": entry.id,
                "token_count": len(tokens),
                "embedding_dimension": len(embedding),
                "status": "success"
            })
        
        db.commit()
        
        return {
            "status": "success",
            "user_id": user_id,
            "total_entries": len(entries),
            "processed_count": len(results),
            "results": results
        }
    except Exception as e:
        # Rollback on error
        if db is not None:
            db.rollback()
        return {
            "status": "error",
            "user_id": user_id,
            "message": f"Error vectorizing entries: {str(e)}"
        }


@celery_app.task(base=DatabaseTask, bind=True, name="tasks.run_clustering")
def run_clustering_task(
    self,
    user_id: int,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    min_cluster_size: Optional[int] = None,
    min_samples: Optional[int] = None,
    membership_threshold: Optional[float] = None,
    cluster_selection_epsilon: Optional[float] = None,
    umap_n_components: Optional[int] = None,
    umap_n_neighbors: Optional[int] = None,
    umap_min_dist: Optional[float] = None
):
    """
    Run HDBSCAN clustering on a user's journal entries asynchronously.
    
    Args:
        user_id: The ID of the user whose entries should be clustered
        start_date: Optional start date (ISO format string) to filter entries
        end_date: Optional end date (ISO format string) to filter entries
        min_cluster_size: Optional minimum cluster size parameter
        min_samples: Optional minimum samples parameter
        membership_threshold: Optional membership threshold parameter
        cluster_selection_epsilon: Optional cluster selection epsilon parameter
        umap_n_components: Optional UMAP n_components parameter
        umap_n_neighbors: Optional UMAP n_neighbors parameter
        umap_min_dist: Optional UMAP min_dist parameter
        
    Returns:
        dict: Result containing status, run_id, and clustering statistics
    """
    # Log that clustering is starting with all parameters
    print("\n" + "="*60)
    print("STARTING CLUSTERING RUN")
    print("="*60)
    print(f"User ID: {user_id}")
    print(f"Date range: {start_date} to {end_date}")
    print(f"Clustering parameters:")
    print(f"  min_cluster_size: {min_cluster_size}")
    print(f"  min_samples: {min_samples}")
    print(f"  membership_threshold: {membership_threshold}")
    print(f"  cluster_selection_epsilon: {cluster_selection_epsilon}")
    print(f"UMAP parameters:")
    print(f"  umap_n_components: {umap_n_components}")
    print(f"  umap_n_neighbors: {umap_n_neighbors}")
    print(f"  umap_min_dist: {umap_min_dist}")
    print("="*60 + "\n")
    
    try:
        # Parse date strings to datetime objects if provided
        start_dt = None
        end_dt = None
        if start_date:
            start_dt = datetime.fromisoformat(start_date.replace('Z', '+00:00'))
        if end_date:
            end_dt = datetime.fromisoformat(end_date.replace('Z', '+00:00'))
        
        # Run clustering (this will save the run to the database)
        run_clustering(
            user_id=user_id,
            start_date=start_dt,
            end_date=end_dt,
            min_cluster_size=min_cluster_size,
            min_samples=min_samples,
            membership_threshold=membership_threshold,
            cluster_selection_epsilon=cluster_selection_epsilon,
            umap_n_components=umap_n_components,
            umap_n_neighbors=umap_n_neighbors,
            umap_min_dist=umap_min_dist,
            generate_topics=True  # Automatically generate topic labels after clustering
        )
        
        # Get the most recent run for this user
        db = self.db
        from models import ClusteringRun
        latest_run = db.query(ClusteringRun).filter(
            ClusteringRun.user_id == user_id
        ).order_by(ClusteringRun.run_timestamp.desc()).first()
        
        if latest_run is None:
            return {
                "status": "error",
                "user_id": user_id,
                "message": "Clustering completed but no run was found"
            }
        
        return {
            "status": "success",
            "user_id": user_id,
            "run_id": latest_run.id,
            "num_entries": latest_run.num_entries,
            "num_clusters": latest_run.num_clusters,
            "noise_entries": latest_run.noise_entries,
            "start_date": latest_run.start_date.isoformat() if latest_run.start_date else None,
            "end_date": latest_run.end_date.isoformat() if latest_run.end_date else None
        }
    except Exception as e:
        return {
            "status": "error",
            "user_id": user_id,
            "message": f"Error running clustering: {str(e)}"
        }
