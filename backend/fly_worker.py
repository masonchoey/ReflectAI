"""
Wake the Fly.io Celery worker app when the API enqueues a task.

When the worker app is scaled to 0, we run `fly scale count 1` so a machine
starts and processes the queue. Only runs when FLY_API_TOKEN and FLY_WORKER_APP are set.
"""

import os
import subprocess
import threading
import logging

logger = logging.getLogger(__name__)

FLY_API_TOKEN = os.getenv("FLY_API_TOKEN")
FLY_WORKER_APP = os.getenv("FLY_WORKER_APP")


def ensure_worker_running() -> None:
    """
    Ensure at least one worker machine is running so queued tasks get processed.
    If the worker app has 0 machines, run `fly scale count 1` (via flyctl).
    Intended to be called after enqueueing a Celery task; runs in a background
    thread so the HTTP response is not blocked.
    """
    if not FLY_API_TOKEN or not FLY_WORKER_APP:
        logger.warning("FLY_API_TOKEN or FLY_WORKER_APP not set; cannot scale worker")
        return
    threading.Thread(target=_scale_worker_up, daemon=True).start()


def _scale_worker_up() -> None:
    env = os.environ.copy()
    env["FLY_API_TOKEN"] = FLY_API_TOKEN
    try:
        # fly scale count 1 creates a machine if the app has 0
        result = subprocess.run(
            ["flyctl", "scale", "count", "1", "-a", FLY_WORKER_APP, "-y"],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            logger.warning(
                "fly scale count 1 failed: %s %s",
                result.stderr or result.stdout,
                result.returncode,
            )
    except FileNotFoundError:
        logger.warning("flyctl not found; cannot scale worker (OK if running locally)")
    except subprocess.TimeoutExpired:
        logger.warning("fly scale count 1 timed out")
    except Exception as e:
        logger.warning("ensure_worker_running failed: %s", e)
