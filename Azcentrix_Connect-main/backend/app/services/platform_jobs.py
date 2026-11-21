"""Jobs & queues (Data & infrastructure → Jobs & queues).

Scheduled jobs: the background loops started by app.main register here and run through run(), which records every run
(start, finish, result, error, duration, trigger) in platform_job_runs. "Run now" runs the same function on demand.

Queues: the Celery queues on the Redis broker. Depth and the oldest message come from Redis; workers, running tasks,
pause / resume come from Celery's remote control; throughput and failures are counted by signals in the workers
(celery_app), and tasks that finally failed are parked in a dead-letter list until "Retry failed" re-sends them.
Nothing is estimated: when the broker or the workers can't be reached, the page says so.
"""

from __future__ import annotations

import json
import logging
import os
import socket
import threading
import time
import traceback
from datetime import datetime, timedelta
from typing import Callable, Optional

from sqlalchemy import BigInteger, Column, DateTime, Index, Integer, String, Text, text

from app.core.config import settings
from app.database import Base, master_engine

logger = logging.getLogger(__name__)
KEEP_DAYS = 7
PREFIX = "platform:jobs"
WORKER = f"{socket.gethostname()}:{os.getpid()}"


class PlatformJobRun(Base):
    __tablename__ = "platform_job_runs"
    __table_args__ = (Index("ix_platform_job_runs_job_id", "job", "id"), Index("ix_platform_job_runs_started", "started_at"))
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    job = Column(String(60), nullable=False)
    trigger = Column(String(20), nullable=False, default="schedule")  # schedule | manual
    started_at = Column(DateTime, nullable=False)
    finished_at = Column(DateTime, nullable=True)
    status = Column(String(10), nullable=False, default="running")  # running | ok | failed
    duration_ms = Column(Integer, nullable=True)
    result = Column(String(500), nullable=True)
    error = Column(Text, nullable=True)
    worker = Column(String(80), nullable=False)
    actor = Column(String(200), nullable=True)


# ─── Scheduled jobs ──────────────────────────────────────────────────────────
JOBS: dict[str, dict] = {}  # key -> {"name", "schedule", "interval", "fn"}
_running: dict[str, threading.Lock] = {}
_schema = {"ready": False, "pruned": 0.0}


def register(key: str, name: str, schedule: str, interval: int, fn: Callable[[], object]) -> None:
    JOBS[key] = {"name": name, "schedule": schedule, "interval": interval, "fn": fn}
    _running.setdefault(key, threading.Lock())


def ensure_schema() -> None:
    if not _schema["ready"]:
        PlatformJobRun.__table__.create(bind=master_engine, checkfirst=True)
        _schema["ready"] = True


def _summary(value) -> Optional[str]:
    if value is None or value == {} or value == []:
        return None
    if isinstance(value, dict):
        value = {k: v for k, v in value.items() if v not in (None, 0, {}, [], "")} or "nothing to do"
    return (value if isinstance(value, str) else json.dumps(value, default=str))[:500]


def run(key: str, trigger: str = "schedule", actor: Optional[str] = None):
    """Run a registered job and record the run; returns the job's result (exceptions are recorded, then re-raised)."""
    job = JOBS[key]
    lock = _running[key]
    if not lock.acquire(blocking=False):  # this worker is still running it
        return {}
    run_id, started = None, time.time()
    try:
        try:
            ensure_schema()
            with master_engine.begin() as conn:
                run_id = conn.execute(text("INSERT INTO platform_job_runs (job, `trigger`, started_at, status, worker, actor) "
                                           "VALUES (:j, :t, :s, 'running', :w, :a)"),
                                      {"j": key, "t": trigger, "s": datetime.now(), "w": WORKER, "a": actor}).lastrowid
        except Exception:
            logger.debug("Job run %s could not be recorded", key, exc_info=True)
        try:
            result = job["fn"]()
        except Exception as exc:
            _finish(run_id, started, "failed", None, "".join(traceback.format_exception_only(type(exc), exc)).strip()[:4000])
            raise
        _finish(run_id, started, "ok", _summary(result), None)
        return result
    finally:
        lock.release()
        _prune()


def _finish(run_id, started: float, status: str, result: Optional[str], error: Optional[str]) -> None:
    if not run_id:
        return
    try:
        with master_engine.begin() as conn:
            conn.execute(text("UPDATE platform_job_runs SET finished_at = :f, status = :s, duration_ms = :d, result = :r, error = :e WHERE id = :i"),
                         {"f": datetime.now(), "s": status, "d": int((time.time() - started) * 1000), "r": result, "e": error, "i": run_id})
    except Exception:
        logger.debug("Job run %s could not be finished", run_id, exc_info=True)


def _prune() -> None:
    if time.time() - _schema["pruned"] < 3600:
        return
    _schema["pruned"] = time.time()
    try:
        with master_engine.begin() as conn:
            conn.execute(text("DELETE FROM platform_job_runs WHERE started_at < :c"), {"c": datetime.now() - timedelta(days=KEEP_DAYS)})
            # runs left 'running' by a worker that stopped
            conn.execute(text("UPDATE platform_job_runs SET status = 'failed', error = 'Interrupted (worker stopped)' "
                              "WHERE status = 'running' AND started_at < :c"), {"c": datetime.now() - timedelta(hours=6)})
    except Exception:
        pass


def run_now(key: str, actor: str) -> bool:
    """Start a job in the background on this worker; False if this worker is already running it."""
    if _running[key].locked():
        return False

    def target():
        try:
            run(key, "manual", actor)
        except Exception:
            logger.exception("Manual run of job %s failed", key)

    threading.Thread(target=target, name=f"job-{key}", daemon=True).start()
    return True


def scheduled_overview() -> list[dict]:
    ensure_schema()
    since = datetime.now() - timedelta(hours=24)
    with master_engine.connect() as conn:
        latest = {r[0]: r for r in conn.execute(text(
            "SELECT r.job, r.started_at, r.finished_at, r.status, r.duration_ms, r.result, r.error, r.`trigger` FROM platform_job_runs r "
            "JOIN (SELECT job, MAX(id) id FROM platform_job_runs GROUP BY job) m ON m.id = r.id")).all()}
        last_done = {r[0]: r for r in conn.execute(text(
            "SELECT r.job, r.started_at, r.status, r.duration_ms, r.result, r.error FROM platform_job_runs r "
            "JOIN (SELECT job, MAX(id) id FROM platform_job_runs WHERE status <> 'running' GROUP BY job) m ON m.id = r.id")).all()}
        last_scheduled = dict(conn.execute(text("SELECT job, MAX(started_at) FROM platform_job_runs WHERE `trigger` = 'schedule' GROUP BY job")).all())
        counts = {(j, s): n for j, s, n in conn.execute(text(
            "SELECT job, status, COUNT(*) FROM platform_job_runs WHERE started_at >= :s GROUP BY job, status"), {"s": since}).all()}
    out = []
    for key, job in JOBS.items():
        cur, done = latest.get(key), last_done.get(key)
        running = bool(cur and cur[3] == "running" and cur[1] > datetime.now() - timedelta(hours=6))
        nxt = last_scheduled.get(key) + timedelta(seconds=job["interval"]) if last_scheduled.get(key) else None
        out.append({"key": key, "name": job["name"], "schedule": job["schedule"], "running": running,
                    "last_run_at": done[1] if done else None, "last_status": done[2] if done else None, "last_duration_ms": done[3] if done else None,
                    "last_result": done[4] if done else None, "last_error": done[5] if done else None,
                    "next_run_at": nxt if nxt and nxt > datetime.now() else (datetime.now() if nxt else None),
                    "runs_24h": counts.get((key, "ok"), 0) + counts.get((key, "failed"), 0), "failed_24h": counts.get((key, "failed"), 0)})
    return out


# ─── Queues (Celery on Redis) ────────────────────────────────────────────────
def _redis():
    import redis
    return redis.Redis.from_url(settings.CELERY_BROKER_URL, socket_connect_timeout=1, socket_timeout=2)


def _queue_of(task) -> str:
    info = getattr(getattr(task, "request", None), "delivery_info", None) or {}
    return info.get("routing_key") or getattr(task.app.conf, "task_default_queue", None) or "celery"


def _count(queue: str, kind: str) -> None:
    try:
        client = _redis()
        key = f"{PREFIX}:count:{queue}:{int(time.time() // 60)}:{kind}"
        pipe = client.pipeline()
        pipe.incr(key)
        pipe.expire(key, 26 * 3600)
        pipe.sadd(f"{PREFIX}:queues", queue)
        pipe.execute()
    except Exception:
        pass


# Signal handlers (connected in celery_app): run in the worker / producer processes.
def on_publish(headers=None, routing_key=None, **_):
    if isinstance(headers, dict):
        headers.setdefault("sent_at", time.time())  # lets the page show the age of the oldest waiting message
    if routing_key:
        try:
            _redis().sadd(f"{PREFIX}:queues", routing_key)
        except Exception:
            pass


def on_success(sender=None, **_):
    _count(_queue_of(sender), "ok")


def on_retry(sender=None, request=None, **_):
    _count((getattr(request, "delivery_info", None) or {}).get("routing_key") or "celery", "retry")


def on_failure(sender=None, task_id=None, exception=None, args=None, kwargs=None, **_):
    """A task raised and will not run again: count it and park it in the dead-letter list (its arguments stay server-side)."""
    queue = _queue_of(sender)
    _count(queue, "failed")
    try:
        entry = {"id": task_id, "task": getattr(sender, "name", "?"), "queue": queue, "args": list(args or []), "kwargs": dict(kwargs or {}),
                 "error": f"{type(exception).__name__}: {exception}"[:500], "at": time.time()}
        client = _redis()
        client.lpush(f"{PREFIX}:dead:{queue}", json.dumps(entry, default=str))
        client.ltrim(f"{PREFIX}:dead:{queue}", 0, 999)
    except Exception:
        pass


def on_worker_ready(sender=None, **_):
    """A (re)started worker honours queues that platform staff paused and reports the release it runs."""
    try:
        from app.core.version import RUNNING_VERSION

        _redis().hset(f"{PREFIX}:worker_version", sender.hostname, RUNNING_VERSION)
    except Exception:
        pass
    try:
        paused = {q.decode() for q in _redis().smembers(f"{PREFIX}:paused")}
        for queue in paused:
            sender.app.control.cancel_consumer(queue, destination=[sender.hostname])
    except Exception:
        pass


_cache: dict = {"at": 0.0, "value": None}


CELERY_MISSING = "Celery is not installed in this backend's Python environment – run: pip install -r requirements.txt"


def _celery():
    """The Celery app, or a clear error when the package isn't installed (the queues still read straight from Redis)."""
    try:
        from app.celery_app import celery_app
    except ImportError as exc:
        raise RuntimeError(CELERY_MISSING) from exc
    return celery_app


def queues_overview(force: bool = False) -> dict:
    """Broker, worker and per-queue figures (cached for 5 s – the remote-control calls wait for worker replies)."""
    if not force and _cache["value"] and time.time() - _cache["at"] < 5:
        return _cache["value"]
    try:
        celery_app = _celery()
    except RuntimeError:
        celery_app = None

    default = (celery_app.conf.task_default_queue if celery_app else None) or "celery"
    result = {"broker": {"ok": False, "url": settings.CELERY_BROKER_URL.split("@")[-1], "error": None},
              "workers": {"ok": False, "count": 0, "names": [], "error": None}, "queues": [], "running": None, "dead_letter": None,
              "failed_24h": None, "throughput_per_min": None}
    try:
        client = _redis()
        client.ping()
        result["broker"]["ok"] = True
    except Exception as exc:
        result["broker"]["error"] = f"Redis broker unreachable ({settings.CELERY_BROKER_URL.split('@')[-1]}): {exc}"
        _cache.update(at=time.time(), value=result)
        return result
    names = {default} | {q.decode() for q in client.smembers(f"{PREFIX}:queues")} | {q.decode() for q in client.smembers(f"{PREFIX}:paused")}
    consumers: dict[str, list[str]] = {}
    active: Optional[int] = None
    try:
        if celery_app is None:
            raise RuntimeError(CELERY_MISSING)
        inspect = celery_app.control.inspect(timeout=1.0)
        replies = inspect.active_queues() or {}
        if replies:
            result["workers"].update(ok=True, count=len(replies), names=sorted(replies))
            for worker, queues in replies.items():
                for q in queues:
                    consumers.setdefault(q["name"], []).append(worker)
                    names.add(q["name"])
            active = sum(len(v) for v in (inspect.active() or {}).values())
        else:
            result["workers"]["error"] = "No Celery worker answered – start one with: celery -A app.celery_app worker"
    except Exception as exc:
        result["workers"]["error"] = str(exc) if celery_app is None else f"Workers could not be inspected: {exc}"
    minute = int(time.time() // 60)
    paused = {q.decode() for q in client.smembers(f"{PREFIX}:paused")}

    def summed(queue: str, kind: str, minutes: int) -> int:
        keys = [f"{PREFIX}:count:{queue}:{m}:{kind}" for m in range(minute - minutes + 1, minute + 1)]
        return sum(int(v) for v in client.mget(keys) if v)

    total_dead = total_failed = 0
    rate_total = 0.0
    for name in sorted(names):
        depth = client.llen(name)
        oldest = None
        if depth:
            try:
                message = json.loads(client.lindex(name, -1))  # kombu pushes on the left, workers take from the right
                sent = (message.get("headers") or {}).get("sent_at")
                oldest = max(0, int(time.time() - float(sent))) if sent else None
            except Exception:
                oldest = None
        done_15 = summed(name, "ok", 15) + summed(name, "failed", 15)
        failed = summed(name, "failed", 24 * 60)
        dead = client.llen(f"{PREFIX}:dead:{name}")
        total_dead += dead
        total_failed += failed
        rate_total += done_15 / 15
        result["queues"].append({"name": name, "depth": depth, "workers": len(consumers.get(name, [])), "rate_per_min": round(done_15 / 15, 1),
                                 "failed_24h": failed, "retries_24h": summed(name, "retry", 24 * 60), "dead_letter": dead, "oldest_seconds": oldest,
                                 "paused": name in paused})
    result.update(running=active, dead_letter=total_dead, failed_24h=total_failed, throughput_per_min=round(rate_total, 1),
                  queued=sum(q["depth"] for q in result["queues"]))
    _cache.update(at=time.time(), value=result)
    return result


def set_paused(queue: str, paused: bool) -> int:
    """Stop / restart consuming a queue on every worker; returns how many workers acknowledged."""
    celery_app = _celery()

    client = _redis()
    (client.sadd if paused else client.srem)(f"{PREFIX}:paused", queue)
    replies = (celery_app.control.cancel_consumer(queue, reply=True, timeout=2.0) if paused
               else celery_app.control.add_consumer(queue, reply=True, timeout=2.0)) or []
    _cache["at"] = 0
    return len(replies)


def retry_dead(queue: str) -> int:
    """Re-send every parked task of the queue, oldest first; returns how many were re-sent."""
    celery_app = _celery()

    client = _redis()
    sent = 0
    while True:
        raw = client.rpop(f"{PREFIX}:dead:{queue}")
        if raw is None:
            break
        entry = json.loads(raw)
        try:
            celery_app.send_task(entry["task"], args=entry.get("args") or [], kwargs=entry.get("kwargs") or {}, queue=entry.get("queue") or queue)
            sent += 1
        except Exception:
            client.rpush(f"{PREFIX}:dead:{queue}", raw)  # keep it parked
            raise
    _cache["at"] = 0
    return sent
