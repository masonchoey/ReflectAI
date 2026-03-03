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

# Create engine with connection pool settings for better reliability
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,  # Verify connections before using them
    pool_recycle=3600,  # Recycle connections after 1 hour
    pool_size=10,  # Number of connections to maintain
    max_overflow=20,  # Maximum number of connections beyond pool_size
    connect_args={
        "connect_timeout": 10,       # Initial TCP connection timeout (seconds)
        "options": "-c statement_timeout=30000",  # 30 second per-statement timeout
        # TCP keepalives detect dead connections in ~80s (30s idle + 10s * 5 probes)
        # without this, a dropped connection can hang for hours
        "keepalives": 1,
        "keepalives_idle": 30,
        "keepalives_interval": 10,
        "keepalives_count": 5,
    }
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
    finally:
        db.close()
