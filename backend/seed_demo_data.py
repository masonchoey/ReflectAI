#!/usr/bin/env python3
"""
Seed the database with demo clustering run and one therapy question conversation.

Prerequisites:
- Demo user must exist (google_id = demo_google_id_001)
- Demo user must have journal entries with embeddings (run generate_embeddings.py --user-id <demo_user_id> first)

Usage:
    cd backend && python seed_demo_data.py

Or with Docker:
    docker compose exec backend python seed_demo_data.py
"""

import os
import sys
from datetime import datetime, timezone

# Ensure we can import from backend
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from env import load_root_env
load_root_env()

from database import SessionLocal
from models import User, JournalEntry, Conversation, ConversationMessage, ClusteringRun

DEMO_USER_GOOGLE_ID = "demo_google_id_001"


def get_demo_user(db):
    """Get the demo user or raise."""
    user = db.query(User).filter(User.google_id == DEMO_USER_GOOGLE_ID).first()
    if not user:
        raise SystemExit(
            "Demo user not found. Seed the database with the demo user first "
            "(google_id = demo_google_id_001, email = demo@reflectai.app)."
        )
    return user


def ensure_embeddings(db, user_id):
    """Check that demo user has entries with embeddings."""
    total = db.query(JournalEntry).filter(JournalEntry.user_id == user_id).count()
    with_emb = db.query(JournalEntry).filter(
        JournalEntry.user_id == user_id,
        JournalEntry.embedding.isnot(None),
    ).count()
    if total == 0:
        raise SystemExit("Demo user has no journal entries. Import entries first.")
    if with_emb < 5:
        raise SystemExit(
            f"Demo user has only {with_emb} entries with embeddings (need at least 5). "
            f"Run: python generate_embeddings.py --user-id {user_id}"
        )
    return with_emb


def run_clustering_for_demo(db, user_id):
    """
    Run clustering with suggested parameters for ~100 entries.
    Suggested params from main.recommend_clustering_params heuristic for n=100:
    - min_cluster_size=5, min_samples=1, membership_threshold=0.1
    - umap_n_components=10, umap_n_neighbors=15, umap_min_dist=0.0
    - cluster_selection_epsilon=0.0
    """
    from hdbscan_clustering import run_clustering

    print("Running clustering with suggested parameters...")
    run_clustering(
        user_id=user_id,
        min_cluster_size=5,
        min_samples=1,
        membership_threshold=0.1,
        cluster_selection_epsilon=0.0,
        umap_n_components=10,
        umap_n_neighbors=15,
        umap_min_dist=0.0,
        generate_topics=False,  # Skip LLM topic generation for faster seeding
    )
    # run_clustering saves to DB via ClusterMetadataDB
    run = db.query(ClusteringRun).filter(
        ClusteringRun.user_id == user_id
    ).order_by(ClusteringRun.run_timestamp.desc()).first()
    return run.id if run else None


def seed_demo_conversation(db, user_id):
    """Create one therapy question conversation with a sample Q&A."""
    # Check if we already have a seeded conversation
    existing = db.query(Conversation).filter(
        Conversation.user_id == user_id,
        Conversation.title == "What patterns do you see in my journal entries?",
    ).first()
    if existing:
        print(f"Demo conversation already exists (id={existing.id}), skipping.")
        return existing.id

    conv = Conversation(
        user_id=user_id,
        title="What patterns do you see in my journal entries?",
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    db.add(conv)
    db.flush()

    # User message
    user_msg = ConversationMessage(
        conversation_id=conv.id,
        role="user",
        content="What patterns do you see in my journal entries?",
        created_at=datetime.now(timezone.utc),
    )
    db.add(user_msg)

    # Assistant message with sample tool steps (realistic LangChain-style response)
    assistant_msg = ConversationMessage(
        conversation_id=conv.id,
        role="assistant",
        content=(
            "Based on your journal entries, I see several recurring patterns:\n\n"
            "**1. Work and productivity** – You often reflect on goals, deadlines, and balancing "
            "responsibilities. There's a theme of wanting to be more consistent and intentional.\n\n"
            "**2. Relationships and connection** – Entries frequently mention family, friends, and "
            "moments of gratitude. You value quality time and meaningful conversations.\n\n"
            "**3. Self-reflection and growth** – You regularly examine your habits, emotions, and "
            "progress. There's an underlying desire to understand yourself better and make small "
            "improvements over time.\n\n"
            "**4. Moments of overwhelm** – Occasionally you write about feeling stretched thin or "
            "uncertain. These entries often end with a note of resilience or a small step forward.\n\n"
            "Would you like to explore any of these themes in more depth?"
        ),
        steps=[
            {
                "tool": "get_journal_themes",
                "tool_input": {},
                "observation": "Recurring journal themes (analysed 100 entries): Work & goals, Relationships, Self-reflection, Stress & resilience...",
            },
            {
                "tool": "search_journals",
                "tool_input": {"query": "patterns and recurring themes in life", "top_k": 8},
                "observation": "[2025-02-15] Entry about work goals... [2025-02-10] Entry about family...",
            },
        ],
        is_error=False,
        created_at=datetime.now(timezone.utc),
    )
    db.add(assistant_msg)

    db.commit()
    db.refresh(conv)
    print(f"Created demo conversation (id={conv.id}) with 2 messages.")
    return conv.id


def main():
    db = SessionLocal()
    try:
        demo_user = get_demo_user(db)
        user_id = demo_user.id
        print(f"Demo user: {demo_user.email} (id={user_id})")

        ensure_embeddings(db, user_id)
        print("Embeddings OK.")

        # Run clustering (uses its own DB session internally)
        run_id = run_clustering_for_demo(db, user_id)
        if run_id:
            print(f"Clustering run created (id={run_id})")

        # Seed conversation
        conv_id = seed_demo_conversation(db, user_id)
        print(f"Demo conversation (id={conv_id})")

        print("\nDone. Demo users will now see one clustering run and one therapy question.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
