"""
Centralized environment loading.

We intentionally load env vars from the **repo root** (one consolidated .env),
instead of per-service env files under backend/ or frontend/.
"""

from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv


def load_root_env() -> None:
    """
    Load environment variables from the repository root `.env` file.

    - Does not error if the file does not exist (same behavior as python-dotenv).
    - Does not override already-exported environment variables.
    - If repo root has no .env, also tries CWD and CWD.parent (for workers started from backend/).
    """

    repo_root = Path(__file__).resolve().parents[1]
    dotenv_path = repo_root / ".env"
    load_dotenv(dotenv_path=dotenv_path, override=False)

    # Fallback: if no .env at repo root, try cwd and parent (e.g. worker run from backend/)
    if not dotenv_path.exists():
        for candidate in (Path.cwd(), Path.cwd().parent):
            if candidate != repo_root:
                fallback = candidate / ".env"
                if fallback.exists():
                    load_dotenv(dotenv_path=fallback, override=False)
                    break

