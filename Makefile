# ReflectAI — developer convenience targets
#
# Local model cache (persists across runs; override with: make worker LOCAL_HF_HOME=/path)
LOCAL_HF_HOME ?= $(HOME)/.cache/huggingface

.PHONY: populate-worker-volume refresh-worker-volume download-models worker help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-28s\033[0m %s\n", $$1, $$2}'

# ── Fly.io ────────────────────────────────────────────────────────────────────

populate-worker-volume: ## Pre-populate (or refresh) the Fly.io worker model volume (full rebuild)
	@echo "Building worker image and running download_models.py against the persistent volume..."
	@echo "This may take several minutes on the first run (~900 MB of model weights)."
	fly machine run . \
	  --app reflectai-worker \
	  --dockerfile backend/Dockerfile.worker \
	  -v reflectai_worker_models:/data/huggingface \
	  -e HF_HOME=/data/huggingface \
	  -e TRANSFORMERS_CACHE=/data/huggingface \
	  -e HF_DATASETS_CACHE=/data/huggingface \
	  --vm-memory 2048 \
	  --vm-cpu-kind shared \
	  --vm-cpus 1 \
	  -r lax \
	  python /app/download_models.py
	@echo "Done. Models are cached on reflectai_worker_models — subsequent worker boots will skip the download."

refresh-worker-volume: ## Re-run download_models.py on the already-running worker machine (fast path)
	fly ssh console -a reflectai-worker \
	  -C "/bin/sh -c 'HF_HOME=/data/huggingface TRANSFORMERS_CACHE=/data/huggingface HF_DATASETS_CACHE=/data/huggingface python /app/download_models.py'"

# ── Local ─────────────────────────────────────────────────────────────────────

download-models: ## Download ML models to the local persistent cache (skips if already cached)
	@echo "Checking local model cache at $(LOCAL_HF_HOME) ..."
	cd backend && HF_HOME="$(LOCAL_HF_HOME)" \
	  TRANSFORMERS_CACHE="$(LOCAL_HF_HOME)" \
	  HF_DATASETS_CACHE="$(LOCAL_HF_HOME)" \
	  python download_models.py

worker: download-models ## Run the Celery worker locally with a persistent model cache (offline after first download)
	@echo "Starting Celery worker (offline mode — models loaded from $(LOCAL_HF_HOME)) ..."
	cd backend && \
	  HF_HOME="$(LOCAL_HF_HOME)" \
	  TRANSFORMERS_CACHE="$(LOCAL_HF_HOME)" \
	  HF_DATASETS_CACHE="$(LOCAL_HF_HOME)" \
	  HF_HUB_OFFLINE=1 \
	  TRANSFORMERS_OFFLINE=1 \
	  celery -A celery_app worker --loglevel=info --concurrency=1
