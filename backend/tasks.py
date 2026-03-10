"""
Celery tasks for async processing of journal entries.
Models (SentenceTransformer, emotion classifier, hdbscan_clustering) are lazy-loaded
on first use to keep worker startup fast and memory low.
"""
import os
from celery import Task
from sqlalchemy.orm import Session
import numpy as np
from datetime import datetime, timezone
from typing import Optional
from database import SessionLocal
from models import JournalEntry
from celery_app import celery_app

# Model state - loaded lazily on first use
_embedding_model = None
_models_loaded = False
_emotion_classifier = None

# Configure Hugging Face cache directory
HF_HOME = os.getenv("HF_HOME", os.path.expanduser("~/.cache/huggingface"))
os.environ["HF_HOME"] = HF_HOME
os.environ["TRANSFORMERS_CACHE"] = HF_HOME
os.environ["HF_DATASETS_CACHE"] = HF_HOME

# Ensure cache directory exists
os.makedirs(HF_HOME, exist_ok=True)


def get_embedding_model():
    """Get or load the embedding model (lazy load on first use)."""
    global _embedding_model, _models_loaded

    if _embedding_model is None or not _models_loaded:
        from sentence_transformers import SentenceTransformer
        print(f"Loading ibm-granite/granite-embedding-30m-english model with HF_HOME={HF_HOME}...")
        _embedding_model = SentenceTransformer(
            "ibm-granite/granite-embedding-30m-english",
            cache_folder=HF_HOME
        )
        _models_loaded = True
        print("Granite-embedding-30m-english model loaded successfully!")

    return _embedding_model


def get_emotion_classifier():
    """Get or load the emotion classifier (lazy load on first use)."""
    global _emotion_classifier

    if _emotion_classifier is None:
        from transformers import pipeline
        print(f"Loading SamLowe/roberta-base-go_emotions model with HF_HOME={HF_HOME}...")
        _emotion_classifier = pipeline(
            "text-classification",
            model="SamLowe/roberta-base-go_emotions",
            top_k=None,
            cache_dir=HF_HOME
        )
        print("Emotion classifier loaded successfully!")

    return _emotion_classifier


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
            try:
                self._db.rollback()
            except Exception:
                pass
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
        
        # Generate embedding using Granite-embedding-30m-english
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
    umap_min_dist: Optional[float] = None,
    demo_session_id: Optional[str] = None,
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
        demo_session_id: If set, results are stored in Redis only (no DB persistence)
        
    Returns:
        dict: Result containing status, run_id, and clustering statistics
    """
    # Log that clustering is starting with all parameters
    print("\n" + "="*60)
    print("STARTING CLUSTERING RUN")
    print("="*60)
    print(f"User ID: {user_id}")
    print(f"Date range: {start_date} to {end_date}")
    print(f"Demo session: {demo_session_id}")
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
        import json
        # Ensure backend dir is on path so lazy import works (worker may run from project root or /app)
        import sys
        _backend_dir = os.path.dirname(os.path.abspath(__file__))
        if _backend_dir not in sys.path:
            sys.path.insert(0, _backend_dir)
        # Lazy import to avoid loading HDBSCAN/UMAP/transformers at worker startup
        from hdbscan_clustering import run_clustering

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
        from models import ClusteringRun, Cluster, EntryClusterAssignment, JournalEntry
        latest_run = db.query(ClusteringRun).filter(
            ClusteringRun.user_id == user_id
        ).order_by(ClusteringRun.run_timestamp.desc()).first()
        
        if latest_run is None:
            return {
                "status": "error",
                "user_id": user_id,
                "message": "Clustering completed but no run was found"
            }

        if demo_session_id:
            # Build the full visualization JSON, store in Redis, then clean up the DB records
            from celery_app import REDIS_URL
            import redis as redis_lib

            run_id = latest_run.id

            # Fetch all the data needed to reconstruct the visualization response
            assignments = db.query(EntryClusterAssignment).filter(
                EntryClusterAssignment.run_id == run_id
            ).all()
            clusters_db = db.query(Cluster).filter(Cluster.run_id == run_id).all()

            entry_to_cluster: dict = {}
            entry_to_all_memberships: dict = {}
            for assignment in assignments:
                entry_to_all_memberships.setdefault(assignment.entry_id, []).append(assignment)
                if assignment.is_primary or assignment.entry_id not in entry_to_cluster:
                    entry_to_cluster[assignment.entry_id] = {
                        "cluster_id": assignment.cluster_id,
                        "probability": assignment.membership_probability,
                    }

            assigned_entry_ids = set(entry_to_cluster.keys())

            cluster_info_map = {}
            for cluster in clusters_db:
                cluster_info_map[cluster.cluster_id] = {
                    "name": cluster.topic_label or f"Cluster {cluster.cluster_id}",
                    "size": cluster.size,
                    "persistence": cluster.persistence,
                    "topic_label": cluster.topic_label,
                    "summary": cluster.summary,
                }

            slim_entries = (
                db.query(JournalEntry)
                .filter(
                    JournalEntry.user_id == user_id,
                    JournalEntry.id.in_(assigned_entry_ids),
                )
                .all()
            )

            umap_coords = {e.id: (e.umap_x, e.umap_y) for e in slim_entries
                          if e.umap_x is not None and e.umap_y is not None}

            points = []
            for entry in slim_entries:
                if entry.id not in umap_coords:
                    continue
                assignment = entry_to_cluster[entry.id]
                cluster_id = assignment["cluster_id"]
                cluster_name = (
                    "Noise" if cluster_id == -1
                    else cluster_info_map.get(cluster_id, {}).get("name", f"Cluster {cluster_id}")
                )
                all_memberships = []
                for m in sorted(
                    entry_to_all_memberships.get(entry.id, []),
                    key=lambda x: x.membership_probability,
                    reverse=True,
                ):
                    mem_name = (
                        "Noise" if m.cluster_id == -1
                        else cluster_info_map.get(m.cluster_id, {}).get("name", f"Cluster {m.cluster_id}")
                    )
                    all_memberships.append({
                        "cluster_id": m.cluster_id,
                        "cluster_name": mem_name,
                        "membership_probability": m.membership_probability,
                        "is_primary": m.is_primary,
                    })
                x, y = umap_coords[entry.id]
                points.append({
                    "entry_id": entry.id,
                    "title": entry.title,
                    "x": x,
                    "y": y,
                    "cluster_id": cluster_id,
                    "cluster_name": cluster_name,
                    "membership_probability": assignment["probability"],
                    "all_memberships": all_memberships,
                })

            clusters_list = [
                {
                    "cluster_id": c.cluster_id,
                    "size": c.size,
                    "persistence": c.persistence,
                    "topic_label": c.topic_label,
                    "summary": c.summary,
                }
                for c in clusters_db
            ]

            viz_data = {"points": points, "clusters": clusters_list}

            # Store in Redis under a negative run ID to distinguish from real DB runs
            DEMO_SESSION_TTL = 7 * 24 * 3600
            if REDIS_URL.startswith("rediss://"):
                r = redis_lib.from_url(REDIS_URL, decode_responses=True, ssl_cert_reqs=None)
            else:
                r = redis_lib.from_url(REDIS_URL, decode_responses=True)

            counter_key = f"demo:{demo_session_id}:run_counter"
            demo_run_id = -int(r.incr(counter_key))  # -1, -2, -3 ...
            r.expire(counter_key, DEMO_SESSION_TTL)

            r.setex(
                f"demo:{demo_session_id}:run:{demo_run_id}",
                DEMO_SESSION_TTL,
                json.dumps(viz_data),
            )

            run_meta = {
                "id": demo_run_id,
                "run_timestamp": latest_run.run_timestamp.isoformat(),
                "num_entries": latest_run.num_entries,
                "num_clusters": latest_run.num_clusters,
                "min_cluster_size": latest_run.min_cluster_size,
                "min_samples": latest_run.min_samples,
                "membership_threshold": latest_run.membership_threshold,
                "noise_entries": latest_run.noise_entries,
                "start_date": latest_run.start_date.isoformat() if latest_run.start_date else None,
                "end_date": latest_run.end_date.isoformat() if latest_run.end_date else None,
            }
            runs_key = f"demo:{demo_session_id}:runs"
            existing_runs = json.loads(r.get(runs_key) or "[]")
            existing_runs.insert(0, run_meta)
            r.setex(runs_key, DEMO_SESSION_TTL, json.dumps(existing_runs))

            # Clean up the temporary DB records (cascade deletes Cluster + EntryClusterAssignment)
            db.delete(latest_run)
            db.commit()

            return {
                "status": "success",
                "user_id": user_id,
                "run_id": demo_run_id,
                "num_entries": run_meta["num_entries"],
                "num_clusters": run_meta["num_clusters"],
                "noise_entries": run_meta["noise_entries"],
                "start_date": run_meta["start_date"],
                "end_date": run_meta["end_date"],
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


@celery_app.task(base=DatabaseTask, bind=True, name="tasks.analyze_emotion")
def analyze_emotion_task(self, entry_id: int):
    """
    Analyze emotions in a journal entry and persist the result to the database.

    Args:
        entry_id: The ID of the journal entry to analyze.

    Returns:
        dict with keys: status, entry_id, emotion, emotion_score, all_emotions (top 5).
    """
    db: Session = None
    try:
        db = self.db

        entry = db.query(JournalEntry).filter(JournalEntry.id == entry_id).first()
        if entry is None:
            return {
                "status": "error",
                "entry_id": entry_id,
                "message": "Entry not found",
            }

        classifier = get_emotion_classifier()

        # Model has a 512-token context window
        text = entry.content[:512]
        results = classifier(text)[0]

        sorted_results = sorted(results, key=lambda x: x["score"], reverse=True)
        top_emotion = sorted_results[0]

        all_emotions = [
            {"label": r["label"], "score": r["score"]} for r in sorted_results
        ]

        entry.emotion = top_emotion["label"]
        entry.emotion_score = top_emotion["score"]
        entry.all_emotions = all_emotions
        db.commit()
        db.refresh(entry)

        return {
            "status": "success",
            "entry_id": entry.id,
            "emotion": top_emotion["label"],
            "emotion_score": top_emotion["score"],
            "all_emotions": all_emotions,
        }
    except Exception as e:
        if db is not None:
            db.rollback()
        return {
            "status": "error",
            "entry_id": entry_id,
            "message": f"Error analyzing emotion: {str(e)}",
        }


@celery_app.task(name="tasks.analyze_demo_entry")
def analyze_demo_entry_task(demo_session_id: str, entry_id: int, content: str):
    """
    Analyze emotions for a demo entry (stored in Redis, not the DB).

    Runs the same emotion classifier as analyze_emotion_task but writes the result
    back to the Redis demo session instead of Postgres.

    Returns the same shape as analyze_emotion_task so the frontend can handle it
    identically.
    """
    import json
    from celery_app import REDIS_URL
    import redis as redis_lib

    DEMO_SESSION_TTL = 7 * 24 * 3600

    try:
        classifier = get_emotion_classifier()

        text = content[:512]
        results = classifier(text)[0]
        sorted_results = sorted(results, key=lambda x: x["score"], reverse=True)
        top_emotion = sorted_results[0]
        all_emotions = [{"label": r["label"], "score": r["score"]} for r in sorted_results]

        # Write emotion result back into the Redis entry
        if REDIS_URL.startswith("rediss://"):
            r = redis_lib.from_url(REDIS_URL, decode_responses=True, ssl_cert_reqs=None)
        else:
            r = redis_lib.from_url(REDIS_URL, decode_responses=True)

        entries_key = f"demo:{demo_session_id}:entries"
        session_entries = json.loads(r.get(entries_key) or "[]")
        for e in session_entries:
            if e["id"] == entry_id:
                e["emotion"] = top_emotion["label"]
                e["emotion_score"] = top_emotion["score"]
                e["all_emotions"] = all_emotions
                break
        r.setex(entries_key, DEMO_SESSION_TTL, json.dumps(session_entries))

        return {
            "status": "success",
            "entry_id": entry_id,
            "emotion": top_emotion["label"],
            "emotion_score": top_emotion["score"],
            "all_emotions": all_emotions,
        }
    except Exception as e:
        return {
            "status": "error",
            "entry_id": entry_id,
            "message": f"Error analyzing emotion: {str(e)}",
        }


THERAPY_SYSTEM_PROMPT = """You are a compassionate, insightful AI therapist assistant with direct access to the person's private journal entries through specialized tools. Your role is to help them gain deep self-understanding about their life patterns, emotions, experiences, and personal growth.

You have access to these tools to research their journals before responding:
- search_journals: Semantically find entries related to specific topics, themes, or events
- get_recent_entries: See what has been happening in their life recently
- get_entries_by_emotion: Explore entries filtered by specific emotional states
- get_journal_themes: Discover recurring themes identified across all journal entries
- get_emotional_timeline: Understand how emotions have shifted and evolved over time
- get_journal_statistics: Get an overview of their journaling journey

Guidelines for every response:
1. Use tools to ground your insights in their actual journal data — typically 2–3 tools when the question benefits from it, but you may use fewer if one search is enough
2. Search from multiple angles (e.g., search related topics, check emotional patterns, review themes)
3. Be warm, empathetic, non-judgmental, and genuinely curious about their inner world
4. Connect patterns you observe across multiple entries and different time periods
5. Speak directly and personally — use "you" and "your" rather than "the user" or "based on your journal entries". Talk to them as if you know them and have been reading their journal together.
6. Cite specific moments from their entries naturally, e.g. "I noticed that on [date] you wrote about..." rather than "based on the journal entries..."
7. Offer thoughtful reflections and gently actionable suggestions
8. Ask a meaningful follow-up question to invite deeper reflection
9. Treat their journal entries with the deepest respect and sensitivity

You are working with deeply personal material. Be thoughtful, compassionate, and speak directly to them as you would a trusted friend."""


def _cosine_similarity(vec1, vec2):
    """Compute cosine similarity between two vectors (lists or arrays)."""
    a = np.array(vec1, dtype=np.float64)
    b = np.array(vec2, dtype=np.float64)
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


@celery_app.task(base=DatabaseTask, bind=True, name="tasks.tokenize_entry")
def tokenize_entry_task(self, entry_id: int):
    """
    Tokenize a journal entry using the embedding model's tokenizer.

    Args:
        entry_id: The ID of the journal entry to tokenize.

    Returns:
        dict: entry_id, text, token_count, tokens, token_ids (same shape as TokenizationResponse).
    """
    db: Session = None
    try:
        db = self.db
        entry = db.query(JournalEntry).filter(JournalEntry.id == entry_id).first()
        if entry is None:
            return {"status": "error", "entry_id": entry_id, "message": "Entry not found"}

        model = get_embedding_model()
        tokenizer = model.tokenizer
        encoded = tokenizer.encode_plus(
            entry.content,
            add_special_tokens=True,
            return_tensors=None,
        )
        token_ids = encoded["input_ids"]
        tokens = tokenizer.convert_ids_to_tokens(token_ids)

        return {
            "status": "success",
            "entry_id": entry.id,
            "text": entry.content,
            "token_count": len(tokens),
            "tokens": tokens,
            "token_ids": token_ids,
        }
    except Exception as e:
        return {
            "status": "error",
            "entry_id": entry_id,
            "message": f"Error tokenizing entry: {str(e)}",
        }


@celery_app.task(base=DatabaseTask, bind=True, name="tasks.semantic_search")
def semantic_search_task(self, user_id: int, query: str, top_k: int = 5):
    """
    Encode the search query and find the most similar journal entries for the user.

    Args:
        user_id: The user whose entries to search.
        query: Search query text.
        top_k: Maximum number of results to return.

    Returns:
        dict: query, results (list of {id, title, content, similarity_score, created_at, emotion}).
    """
    db: Session = None
    try:
        db = self.db
        model = get_embedding_model()
        query_embedding = model.encode(query, normalize_embeddings=True)
        query_emb_list = (
            query_embedding.tolist()
            if hasattr(query_embedding, "tolist")
            else list(query_embedding)
        )

        entries = db.query(JournalEntry).filter(
            JournalEntry.user_id == user_id,
            JournalEntry.embedding != None,
        ).all()
        if not entries:
            return {"status": "success", "query": query, "results": []}

        similarities = []
        for entry in entries:
            entry_emb = entry.embedding
            if hasattr(entry_emb, "tolist"):
                entry_emb = entry_emb.tolist()
            elif not isinstance(entry_emb, list):
                entry_emb = list(entry_emb)
            sim = _cosine_similarity(query_emb_list, entry_emb)
            similarities.append((entry, sim))
        similarities.sort(key=lambda x: x[1], reverse=True)
        top = similarities[:top_k]

        results = []
        for e, score in top:
            results.append({
                "id": e.id,
                "title": e.title,
                "content": e.content,
                "similarity_score": round(score, 6),
                "created_at": e.created_at.isoformat() if e.created_at else None,
                "emotion": e.emotion,
            })
        return {"status": "success", "query": query, "results": results}
    except Exception as e:
        return {
            "status": "error",
            "query": query,
            "message": f"Error running semantic search: {str(e)}",
        }


@celery_app.task(base=DatabaseTask, bind=True, name="tasks.therapy_question")
def therapy_question_task(self, user_id: int, question: str):
    """
    Run a therapy-style question through a LangChain 1.0 agent that uses journal tools
    powered by LLama 3.3 70B via OpenRouter (:free tier).

    OpenRouter free tier: 20 requests/minute, ~50 requests/day. Each agent turn (LLM call)
    counts as one request; one user question can trigger 2–4+ calls. We use a recursion
    limit and retries with backoff to stay within limits.

    Args:
        user_id: The user whose journals will be searched.
        question: The life/reflection question to answer.

    Returns:
        dict: status, question, answer, steps (list of tool calls with observations).
    """
    import os
    import time
    from env import load_root_env

    # Ensure root .env is loaded (worker may run from backend/ or other CWD)
    load_root_env()

    # Propagate LangSmith tracing env vars so the LangChain callback system
    # picks them up even when running inside a Celery worker subprocess.
    for _ls_var in ("LANGSMITH_TRACING_V2", "LANGSMITH_API_KEY", "LANGSMITH_PROJECT"):
        _val = os.getenv(_ls_var)
        if _val:
            os.environ[_ls_var] = _val

    from langchain_openai import ChatOpenAI
    from langchain_core.tools import StructuredTool
    from langchain.agents import create_agent
    from langchain_core.messages import HumanMessage, AIMessage, ToolMessage
    from pydantic import BaseModel as PydanticBaseModel, Field

    db = self.db
    openrouter_api_key = os.getenv("OPENROUTER_API_KEY", "")

    if not openrouter_api_key:
        return {"status": "error", "message": "OpenRouter API key not configured"}

    # ── Tool implementations (closures over db and user_id) ──────────────────

    def search_journals(query: str, top_k: int = 8) -> str:
        try:
            model = get_embedding_model()
            query_embedding = model.encode(query, normalize_embeddings=True)
            query_emb_list = (
                query_embedding.tolist()
                if hasattr(query_embedding, "tolist")
                else list(query_embedding)
            )
            entries = db.query(JournalEntry).filter(
                JournalEntry.user_id == user_id,
                JournalEntry.embedding != None,
            ).all()

            if not entries:
                return "No indexed journal entries found. The user may need to generate embeddings first."

            similarities = []
            for entry in entries:
                emb = entry.embedding
                if hasattr(emb, "tolist"):
                    emb = emb.tolist()
                elif not isinstance(emb, list):
                    emb = list(emb)
                similarities.append((entry, _cosine_similarity(query_emb_list, emb)))

            similarities.sort(key=lambda x: x[1], reverse=True)
            parts = []
            for entry, score in similarities[:top_k]:
                date_str = entry.created_at.strftime("%Y-%m-%d") if entry.created_at else "unknown date"
                emotion_str = f" [Emotion: {entry.emotion}]" if entry.emotion else ""
                parts.append(
                    f"[{date_str}{emotion_str}] {entry.title or 'Untitled'}:\n{entry.content[:700]}"
                )
            return "\n\n---\n\n".join(parts) if parts else "No relevant entries found."
        except Exception as e:
            return f"Error searching journals: {str(e)}"

    def get_recent_entries(count: int = 10) -> str:
        try:
            entries = db.query(JournalEntry).filter(
                JournalEntry.user_id == user_id
            ).order_by(JournalEntry.created_at.desc()).limit(count).all()

            if not entries:
                return "No journal entries found."

            parts = []
            for entry in entries:
                date_str = entry.created_at.strftime("%Y-%m-%d") if entry.created_at else "unknown date"
                emotion_str = f" [Emotion: {entry.emotion}]" if entry.emotion else ""
                parts.append(
                    f"[{date_str}{emotion_str}] {entry.title or 'Untitled'}:\n{entry.content[:700]}"
                )
            return "\n\n---\n\n".join(parts)
        except Exception as e:
            return f"Error retrieving recent entries: {str(e)}"

    def get_entries_by_emotion(emotion: str) -> str:
        try:
            entries = db.query(JournalEntry).filter(
                JournalEntry.user_id == user_id,
                JournalEntry.emotion.ilike(f"%{emotion}%"),
            ).order_by(JournalEntry.created_at.desc()).limit(10).all()

            if not entries:
                return f"No entries found with emotion matching '{emotion}'."

            parts = []
            for entry in entries:
                date_str = entry.created_at.strftime("%Y-%m-%d") if entry.created_at else "unknown date"
                parts.append(
                    f"[{date_str}] {entry.title or 'Untitled'}:\n{entry.content[:600]}"
                )
            return "\n\n---\n\n".join(parts)
        except Exception as e:
            return f"Error retrieving entries by emotion: {str(e)}"

    def get_journal_themes() -> str:
        try:
            from models import ClusteringRun, Cluster

            latest_run = db.query(ClusteringRun).filter(
                ClusteringRun.user_id == user_id
            ).order_by(ClusteringRun.run_timestamp.desc()).first()

            if latest_run is None:
                return "No clustering analysis has been run yet. Journal themes are not available."

            clusters = db.query(Cluster).filter(
                Cluster.run_id == latest_run.id,
                Cluster.cluster_id != -1,
            ).order_by(Cluster.size.desc()).all()

            if not clusters:
                return "No distinct themes found in the clustering analysis."

            run_date = latest_run.run_timestamp.strftime("%Y-%m-%d")
            lines = [
                f"Recurring journal themes (analysed {latest_run.num_entries} entries on {run_date}):"
            ]
            for c in clusters:
                label = c.topic_label or f"Theme {c.cluster_id}"
                lines.append(f"  • {label}  ({c.size} entries)")
            return "\n".join(lines)
        except Exception as e:
            return f"Error retrieving journal themes: {str(e)}"

    def get_emotional_timeline() -> str:
        try:
            from collections import defaultdict, Counter

            entries = db.query(JournalEntry).filter(
                JournalEntry.user_id == user_id,
                JournalEntry.emotion != None,
            ).order_by(JournalEntry.created_at.asc()).all()

            if not entries:
                return "No entries with emotion data found. Emotion analysis may not have been run yet."

            weekly: dict = defaultdict(list)
            for entry in entries:
                if entry.created_at:
                    weekly[entry.created_at.strftime("%Y-W%U")].append(entry.emotion)

            lines = ["Emotional timeline (weekly, last 12 weeks):"]
            for week, emotions in sorted(weekly.items())[-12:]:
                top = Counter(emotions).most_common(3)
                lines.append("  " + week + ": " + ", ".join(f"{e} ({c}x)" for e, c in top))

            all_emotions = [e.emotion for e in entries if e.emotion]
            overall = Counter(all_emotions)
            lines.append("\nOverall emotion distribution (all time):")
            for emotion, count in overall.most_common(6):
                pct = count / len(all_emotions) * 100
                lines.append(f"  {emotion}: {count} entries ({pct:.1f}%)")
            return "\n".join(lines)
        except Exception as e:
            return f"Error retrieving emotional timeline: {str(e)}"

    def get_journal_statistics() -> str:
        try:
            entries = db.query(JournalEntry).filter(
                JournalEntry.user_id == user_id
            ).order_by(JournalEntry.created_at.asc()).all()

            if not entries:
                return "No journal entries found."

            total = len(entries)
            first_date = entries[0].created_at
            last_date = entries[-1].created_at
            avg_len = sum(len(e.content) for e in entries) / total
            with_emotions = sum(1 for e in entries if e.emotion)
            with_embeddings = sum(1 for e in entries if e.embedding is not None)

            return (
                f"Journal Statistics:\n"
                f"  Total entries: {total}\n"
                f"  Journaling since: {first_date.strftime('%Y-%m-%d') if first_date else 'unknown'}\n"
                f"  Most recent entry: {last_date.strftime('%Y-%m-%d') if last_date else 'unknown'}\n"
                f"  Average entry length: {avg_len:.0f} characters\n"
                f"  Entries with emotion analysis: {with_emotions}/{total}\n"
                f"  Entries with semantic index: {with_embeddings}/{total}"
            )
        except Exception as e:
            return f"Error retrieving journal statistics: {str(e)}"

    # ── Pydantic schemas for tool inputs ────────────────────────────────────

    class SearchInput(PydanticBaseModel):
        query: str = Field(description="Topic, theme, or concept to search for in journal entries")
        top_k: int = Field(default=8, description="Number of results to return (default 8)")

    class RecentInput(PydanticBaseModel):
        count: int = Field(default=10, description="How many recent entries to retrieve (default 10)")

    class EmotionInput(PydanticBaseModel):
        emotion: str = Field(
            description="Emotion label to filter by (e.g., joy, sadness, anger, fear, neutral, surprise, disgust, approval)"
        )

    class NoInput(PydanticBaseModel):
        pass

    # ── Build LangChain tools ────────────────────────────────────────────────

    tools = [
        StructuredTool.from_function(
            func=search_journals,
            name="search_journals",
            description=(
                "Semantically search all journal entries for entries related to a specific topic, "
                "theme, event, or concept. Returns the most relevant entries with dates and emotions. "
                "Use this frequently to find specific life experiences."
            ),
            args_schema=SearchInput,
        ),
        StructuredTool.from_function(
            func=get_recent_entries,
            name="get_recent_entries",
            description=(
                "Get the most recent journal entries to understand what has been happening in the "
                "user's life lately and their current state of mind."
            ),
            args_schema=RecentInput,
        ),
        StructuredTool.from_function(
            func=get_entries_by_emotion,
            name="get_entries_by_emotion",
            description=(
                "Find journal entries filtered by a specific detected emotion. Useful for exploring "
                "when and why the user felt a particular way. Common emotions: joy, sadness, anger, "
                "fear, neutral, surprise, disgust, approval, disapproval, gratitude, curiosity."
            ),
            args_schema=EmotionInput,
        ),
        StructuredTool.from_function(
            func=get_journal_themes,
            name="get_journal_themes",
            description=(
                "Get the recurring themes and topic clusters automatically identified across all "
                "journal entries. Use this to understand the major life areas the user writes about."
            ),
            args_schema=NoInput,
        ),
        StructuredTool.from_function(
            func=get_emotional_timeline,
            name="get_emotional_timeline",
            description=(
                "Get a timeline showing how the user's emotions have shifted and evolved over time. "
                "Use this to understand emotional growth, patterns, and trends."
            ),
            args_schema=NoInput,
        ),
        StructuredTool.from_function(
            func=get_journal_statistics,
            name="get_journal_statistics",
            description=(
                "Get an overview of the user's journaling habits: total entries, date range, "
                "average length, and analysis coverage."
            ),
            args_schema=NoInput,
        ),
    ]

    # ── LLM (LLama 3.3 70B via OpenRouter) ──────────────────────────────────

    llm = ChatOpenAI(
        model="arcee-ai/trinity-large-preview:free", #"meta-llama/llama-3.3-70b-instruct:free",
        openai_api_key=openrouter_api_key,
        openai_api_base="https://openrouter.ai/api/v1",
        temperature=0.7,
        max_tokens=2048,
    )

    # ── LangChain 1.0 agent (create_agent returns a CompiledStateGraph) ────────

    graph = create_agent(
        model=llm,
        tools=tools,
        system_prompt=THERAPY_SYSTEM_PROMPT,
        debug=False,
    )

    # Cap graph steps to limit OpenRouter API calls (each model turn = 1 request).
    # Free tier: 20 RPM, ~50 RPD. recursion_limit 8 ≈ at most 4 LLM rounds per question.
    result = None
    max_retries = 3
    for attempt in range(max_retries):
        try:
            result = graph.invoke(
                {"messages": [HumanMessage(content=question)]},
                config={
                    "recursion_limit": 20,
                    "run_name": "therapy-agent",
                    "metadata": {
                        "user_id": user_id,
                        "question_preview": question[:120],
                    },
                    "tags": ["reflectai", "therapy"],
                },
            )
            break
        except Exception as e:
            err_str = str(e).lower()
            is_retryable = "429" in err_str or "503" in err_str or "rate" in err_str
            if attempt < max_retries - 1 and is_retryable:
                time.sleep((2 ** attempt) * 2)  # 2, 4, 8 s
                continue
            return {
                "status": "error",
                "question": question,
                "message": f"Agent execution failed: {str(e)}",
            }
    if result is None:
        return {"status": "error", "question": question, "message": "Agent execution failed (no result)."}

    # ── Extract final answer and tool steps from message list ────────────────

    messages = result.get("messages", [])
    final_answer = ""
    steps = []
    pending_tool_calls = {}  # tool_call_id -> {tool, tool_input}

    def _message_content(msg) -> str:
        """Extract string content from a message (handles str or list of content blocks)."""
        raw = getattr(msg, "content", None)
        if isinstance(raw, str):
            return raw
        if isinstance(raw, list) and raw:
            part = raw[0]
            if isinstance(part, dict) and "text" in part:
                return part["text"]
            if hasattr(part, "get") and part.get("type") == "text":
                return part.get("text", "")
        return ""

    for msg in messages:
        if isinstance(msg, AIMessage):
            if getattr(msg, "tool_calls", None):
                for tc in msg.tool_calls:
                    tc_id = tc.get("id") if isinstance(tc, dict) else getattr(tc, "id", None)
                    name = tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", "")
                    args = tc.get("args") if isinstance(tc, dict) else getattr(tc, "args", {}) or {}
                    if tc_id:
                        pending_tool_calls[tc_id] = {"tool": name, "tool_input": args, "observation": None}
            else:
                content = _message_content(msg)
                if content:
                    final_answer = content
        elif isinstance(msg, ToolMessage):
            tc_id = getattr(msg, "tool_call_id", None)
            if tc_id and tc_id in pending_tool_calls:
                pending_tool_calls[tc_id]["observation"] = _message_content(msg) or getattr(msg, "content", "")
                steps.append(pending_tool_calls.pop(tc_id))

    # If we never got an AIMessage without tool_calls, use the last AI content we saw
    if not final_answer:
        for msg in reversed(messages):
            if isinstance(msg, AIMessage):
                content = _message_content(msg)
                if content:
                    final_answer = content
                    break

    # Serialize steps for the UI (truncate long observations)
    steps_serialized = []
    for s in steps:
        steps_serialized.append({
            "tool": s["tool"],
            "tool_input": s["tool_input"] if isinstance(s["tool_input"], dict) else {"input": str(s["tool_input"])},
            "observation": str(s.get("observation") or "")[:2000],
        })

    return {
        "status": "success",
        "question": question,
        "answer": final_answer or "I was unable to generate a response.",
        "steps": steps_serialized,
    }
