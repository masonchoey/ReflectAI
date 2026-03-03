"""
Pre-downloads ML models into the HF_HOME volume so workers can load offline.
Checks local cache first — if both models are already present, exits immediately
without making any network calls.
"""
import os
import sys
import pathlib

HF_HOME = os.getenv("HF_HOME", os.path.expanduser("~/.cache/huggingface"))
os.makedirs(HF_HOME, exist_ok=True)

os.environ["HF_HOME"] = HF_HOME
os.environ["TRANSFORMERS_CACHE"] = HF_HOME
os.environ["HF_DATASETS_CACHE"] = HF_HOME
# Ensure offline flags are cleared so downloads can proceed if needed
os.environ.pop("HF_HUB_OFFLINE", None)
os.environ.pop("TRANSFORMERS_OFFLINE", None)

MODELS = [
    "ibm-granite/granite-embedding-30m-english",
    "SamLowe/roberta-base-go_emotions",
]


def is_cached(model_id: str, cache_dir: str) -> bool:
    """Return True if at least one snapshot of model_id exists in cache_dir.

    Checks both the legacy root layout and the newer HuggingFace Hub layout
    where models live under a 'hub/' sub-directory of HF_HOME.
    """
    model_key = "models--" + model_id.replace("/", "--")
    candidates = [
        pathlib.Path(cache_dir) / model_key / "snapshots",
        pathlib.Path(cache_dir) / "hub" / model_key / "snapshots",
    ]
    return any(p.exists() and any(p.iterdir()) for p in candidates)


print(f"Model volume: {HF_HOME}")

missing = [m for m in MODELS if not is_cached(m, HF_HOME)]
if not missing:
    print("All models already present in volume — skipping download.")
    sys.exit(0)

print(f"Downloading {len(missing)} missing model(s) — this only happens once per volume:\n")

if "ibm-granite/granite-embedding-30m-english" in missing:
    print("  [embedding] ibm-granite/granite-embedding-30m-english (~120 MB) ...")
    from sentence_transformers import SentenceTransformer
    SentenceTransformer("ibm-granite/granite-embedding-30m-english", cache_folder=HF_HOME)
    print("             Done.")

if "SamLowe/roberta-base-go_emotions" in missing:
    print("  [emotion]   SamLowe/roberta-base-go_emotions (~500 MB) ...")
    from transformers import pipeline
    pipeline("text-classification", model="SamLowe/roberta-base-go_emotions", cache_dir=HF_HOME)
    print("             Done.")

print("\nAll models present. Workers will load from volume with no network access.")
