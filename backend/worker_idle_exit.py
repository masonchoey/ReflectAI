#!/usr/bin/env python3
"""
Run Celery worker and exit after idle (empty queue) for IDLE_MINUTES.
Then scale the Fly app to 0 so we don't burn Redis/VM cost when no work.
"""

import os
import subprocess
import sys
import time

# Same broker URL as celery_app so we can check queue length
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
FLY_WORKER_APP = os.getenv("FLY_WORKER_APP")
FLY_API_TOKEN = os.getenv("FLY_API_TOKEN")

# Exit after queue has been empty this many minutes (must be > task_time_limit so we
# don't kill the worker during a long task; task_time_limit is 30 min).
# Only used when FLY_WORKER_APP is set (production); otherwise worker runs forever.
IDLE_MINUTES = 5
CHECK_INTERVAL_SEC = 60


def redis_queue_len():
    """Return length of default Celery queue 'celery' in Redis. None on error."""
    try:
        import redis
        from urllib.parse import urlparse
        parsed = urlparse(REDIS_URL)
        use_ssl = parsed.scheme == "rediss"
        conn = redis.Redis(
            host=parsed.hostname or "localhost",
            port=parsed.port or 6379,
            db=int((parsed.path or "/0").strip("/") or 0),
            password=parsed.password or None,
            ssl=use_ssl,
            ssl_cert_reqs=None if use_ssl else None,
        )
        return conn.llen("celery")
    except Exception:
        return None


def scale_app_to_zero():
    if not FLY_API_TOKEN or not FLY_WORKER_APP:
        return
    env = os.environ.copy()
    env["FLY_API_TOKEN"] = FLY_API_TOKEN
    try:
        subprocess.run(
            ["flyctl", "scale", "count", "0", "-a", FLY_WORKER_APP, "-y"],
            env=env,
            capture_output=True,
            timeout=30,
        )
    except Exception:
        pass


def main():
    celery_proc = subprocess.Popen(
        ["celery", "-A", "celery_app", "worker", "--loglevel=info", "--concurrency=1"],
        stdin=subprocess.DEVNULL,
        stdout=sys.stdout,
        stderr=sys.stderr,
    )
    idle_count = 0
    target_idle = IDLE_MINUTES * (60 // CHECK_INTERVAL_SEC)  # e.g. 35 * 1 = 35

    try:
        while True:
            time.sleep(CHECK_INTERVAL_SEC)
            if celery_proc.poll() is not None:
                sys.exit(celery_proc.returncode or 1)
            qlen = redis_queue_len()
            if qlen is not None and qlen == 0:
                idle_count += 1
                if FLY_WORKER_APP and idle_count >= target_idle:
                    scale_app_to_zero()
                    celery_proc.terminate()
                    celery_proc.wait(timeout=30)
                    sys.exit(0)
            else:
                idle_count = 0
    except KeyboardInterrupt:
        celery_proc.terminate()
        celery_proc.wait(timeout=30)
        sys.exit(0)


if __name__ == "__main__":
    main()
