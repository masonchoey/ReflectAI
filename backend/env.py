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
    """

    repo_root = Path(__file__).resolve().parents[1]
    dotenv_path = repo_root / ".env"

    # Only load the single consolidated root env file.
    load_dotenv(dotenv_path=dotenv_path, override=False)

