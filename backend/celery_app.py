"""
Celery application configuration for async task processing.
"""
import os
from celery import Celery
from env import load_root_env

load_root_env()

# Redis configuration
# If REDIS_URL is explicitly set, use it. Otherwise, try to detect the environment.
# Default to localhost for local development, 'redis' for Docker
if os.getenv("REDIS_URL"):
    REDIS_URL = os.getenv("REDIS_URL")
    print(f"Celery Redis URL (from env): {REDIS_URL}")
else:
    # Check if we're in Docker by looking for common Docker environment indicators
    is_docker = os.path.exists("/.dockerenv") or os.getenv("DOCKER_CONTAINER") == "true"
    default_redis_host = "redis" if is_docker else "localhost"
    REDIS_URL = f"redis://{default_redis_host}:6379/0"
    print(f"Celery Redis URL (auto-detected): {REDIS_URL} (Docker: {is_docker})")

# Create Celery app
celery_app = Celery(
    "reflectai",
    broker=REDIS_URL,
    backend=REDIS_URL,
    include=["tasks"]
)

# Celery configuration
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_time_limit=1800,  # 30 minutes max per task (clustering can take a while)
    task_soft_time_limit=1500,  # 25 minutes soft limit
    worker_prefetch_multiplier=1,  # Process one task at a time for memory efficiency
    worker_max_tasks_per_child=50,  # Restart worker after 50 tasks to prevent memory leaks
    broker_connection_retry_on_startup=True,  # Retry connection on startup
    broker_connection_retry=True,  # Enable connection retries
    broker_connection_max_retries=10,  # Maximum retry attempts
)
