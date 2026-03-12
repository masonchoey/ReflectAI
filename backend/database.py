import os
import time
from sqlalchemy import create_engine, text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from sqlalchemy.exc import OperationalError
from env import load_root_env

load_root_env()

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/reflectai"
)


def _build_connect_args(database_url: str) -> dict:
    """
    Build connect_args for SQLAlchemy.

    Some managed Postgres frontends (including Supabase's direct DB endpoint)
    reject the `options` startup parameter with "unsupported startup parameter: options".
    When connecting to those hosts, we omit the `options` field.
    """
    base_args = {
        "connect_timeout": 10,       # Initial TCP connection timeout (seconds)
        # TCP keepalives detect dead connections in ~80s (30s idle + 10s * 5 probes)
        # without this, a dropped connection can hang for hours
        "keepalives": 1,
        "keepalives_idle": 30,
        "keepalives_interval": 10,
        "keepalives_count": 5,
    }

    # If we're talking to Supabase's direct DB host, avoid sending `options`
    # because their router may reject it. For other hosts (local dev, plain Postgres)
    # we keep statement/idle timeouts via options.
    if "supabase.co" in database_url:
        return base_args

    base_args["options"] = (
        "-c statement_timeout=30000 "
        "-c idle_in_transaction_session_timeout=60000"
    )
    return base_args


# Create engine with connection pool settings for better reliability
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,  # Verify connections before using them
    pool_recycle=3600,  # Recycle connections after 1 hour
    pool_size=10,  # Number of connections to maintain
    max_overflow=20,  # Maximum number of connections beyond pool_size
    connect_args=_build_connect_args(DATABASE_URL),
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# Called from app lifespan (main.py), not at import time, so the server can bind
# before connecting to the database (avoids blocking/crashing before listen on 0.0.0.0).
def enable_pgvector_extension():
    """Enable the pgvector extension in the database with retry logic."""
    max_retries = 5
    retry_delay = 2  # seconds
    
    for attempt in range(max_retries):
        try:
            with engine.begin() as conn:
                conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            print("pgvector extension enabled successfully")
            return
        except OperationalError as e:
            if attempt < max_retries - 1:
                print(f"Failed to enable pgvector extension (attempt {attempt + 1}/{max_retries}): {e}")
                print(f"Retrying in {retry_delay} seconds...")
                time.sleep(retry_delay)
            else:
                print(f"Failed to enable pgvector extension after {max_retries} attempts: {e}")
                raise

def get_db():
    db = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
