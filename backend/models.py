from sqlalchemy import Column, Integer, Text, DateTime, String, Float, JSON, ForeignKey, Boolean, Index
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from pgvector.sqlalchemy import Vector
from database import Base
from datetime import datetime, timezone


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    google_id = Column(String(255), unique=True, index=True, nullable=False)
    email = Column(String(255), unique=True, index=True, nullable=False)
    name = Column(String(255), nullable=True)
    picture = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    last_login = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    # Relationship to journal entries
    entries = relationship("JournalEntry", back_populates="user")


class JournalEntry(Base):
    __tablename__ = "journal_entries"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    title = Column(String(200), nullable=True)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    edited_at = Column(DateTime(timezone=True), nullable=True)
    emotion = Column(String(50), nullable=True)
    emotion_score = Column(Float, nullable=True)
    all_emotions = Column(JSON, nullable=True)  # Full ranked emotion breakdown [{label, score}, ...]
    embedding = Column(Vector(384), nullable=True)  # Granite-embedding-30m-english dense embedding vector (384 dimensions)
    umap_x = Column(Float, nullable=True)  # 2D UMAP x-coordinate for visualization (computed during clustering)
    umap_y = Column(Float, nullable=True)  # 2D UMAP y-coordinate for visualization (computed during clustering)
    summary=Column(Text, nullable=True)

    # Relationship to user
    user = relationship("User", back_populates="entries")


class ClusteringRun(Base):
    """Represents a single clustering run for a user."""
    __tablename__ = "clustering_runs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, nullable=False, index=True)
    run_timestamp = Column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))
    num_entries = Column(Integer, nullable=False)
    num_clusters = Column(Integer, nullable=False)
    min_cluster_size = Column(Integer, nullable=False)
    min_samples = Column(Integer, nullable=True)
    membership_threshold = Column(Float, nullable=False)
    noise_entries = Column(Integer, nullable=False)
    start_date = Column(DateTime(timezone=True), nullable=True)
    end_date = Column(DateTime(timezone=True), nullable=True)

    # Relationships
    clusters = relationship("Cluster", back_populates="run", cascade="all, delete-orphan")
    assignments = relationship("EntryClusterAssignment", back_populates="run", cascade="all, delete-orphan")


class Cluster(Base):
    """Represents a single cluster from a clustering run."""
    __tablename__ = "clusters"

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, ForeignKey("clustering_runs.id", ondelete="CASCADE"), nullable=False, index=True)
    cluster_id = Column(Integer, nullable=False)  # The cluster ID from HDBSCAN
    size = Column(Integer, nullable=False)
    persistence = Column(Float, nullable=True)
    centroid_entry_id = Column(Integer, nullable=True)
    topic_label = Column(Text, nullable=True)
    summary = Column(Text, nullable=True)

    # Relationships
    run = relationship("ClusteringRun", back_populates="clusters")
    # Note: assignments relationship removed - cluster_id is HDBSCAN ID, not FK to Cluster.id


class EntryClusterAssignment(Base):
    """Represents an entry's assignment to a cluster (supports multiple clusters per entry)."""
    __tablename__ = "entry_cluster_assignments"

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, ForeignKey("clustering_runs.id", ondelete="CASCADE"), nullable=False, index=True)
    entry_id = Column(Integer, nullable=False, index=True)
    cluster_id = Column(Integer, nullable=False, index=True)
    membership_probability = Column(Float, nullable=False)
    is_primary = Column(Boolean, nullable=False, default=False)

    # Relationships
    run = relationship("ClusteringRun", back_populates="assignments")
    # Note: cluster relationship removed - cluster_id is HDBSCAN ID, not FK to Cluster.id

    # Create composite index for common queries
    __table_args__ = (
        Index('idx_entry_run', 'entry_id', 'run_id'),
        Index('idx_cluster_run', 'cluster_id', 'run_id'),
    )


class Conversation(Base):
    """A named conversation session between the user and the AI assistant."""
    __tablename__ = "conversations"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    title = Column(String(300), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    # Relationships
    user = relationship("User")
    messages = relationship("ConversationMessage", back_populates="conversation", cascade="all, delete-orphan", order_by="ConversationMessage.created_at")


class ConversationMessage(Base):
    """A single message (user or assistant) within a conversation."""
    __tablename__ = "conversation_messages"

    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    role = Column(String(20), nullable=False)  # 'user' or 'assistant'
    content = Column(Text, nullable=False)
    steps = Column(JSON, nullable=True)  # Tool-call steps for assistant messages [{tool, tool_input, observation}]
    is_error = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    # Relationships
    conversation = relationship("Conversation", back_populates="messages")
