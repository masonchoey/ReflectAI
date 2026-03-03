#!/bin/bash
# Fly.io worker startup: populate the model volume on first boot, then start the
# Celery worker in fully-offline mode so it never touches the HF network again.
set -e

# Unset offline flags so download_models.py can reach HuggingFace if needed.
# (fly.worker.toml sets HF_HUB_OFFLINE=1 for the worker process; we clear it
# here only for the download step, then re-export it before handing off.)
unset HF_HUB_OFFLINE
unset TRANSFORMERS_OFFLINE

echo "=== Checking model volume ==="
python /app/download_models.py

echo "=== Starting Celery worker (offline mode) ==="
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
exec python -u /app/worker_idle_exit.py
