"""In-process API traffic counters for the platform Command Center.

The request-logging middleware calls record() for every /api request. Data is
kept per second for the last few minutes in this worker process only; it is a
live view, not a history store.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict

import redis

from app.core.config import settings
from app.services import platform_monitoring, platform_usage

_WINDOW_SECONDS = 300
_SERIES_POINTS = 40
_SERIES_STEP = 3
_MAX_LATENCIES_PER_SECOND = 500
_SELF_POLLING_PREFIXES = (
    "/api/v1/platform/dashboard/command-center",
    "/api/v1/platform/dashboard/infrastructure",
    "/api/v1/platform/infrastructure/node-metrics",
    "/api/v1/platform/monitoring",
)

_lock = threading.Lock()
_buckets: dict[int, dict] = {}


def _bucket(second: int) -> dict:
    bucket = _buckets.get(second)
    if bucket is None:
        bucket = _buckets[second] = {"count": 0, "errors": 0, "latencies": [], "tenants": defaultdict(int), "tenant_detail": {}}
        for old in [key for key in _buckets if key <= second - _WINDOW_SECONDS]:
            del _buckets[old]
    return bucket


def record(path: str, status_code: int, duration_ms: float, tenant_slug: str | None, bytes_out: int = 0) -> None:
    # The Command Center's own polling would otherwise dominate the traffic it reports.
    if not path.startswith("/api") or path.startswith(_SELF_POLLING_PREFIXES):
        return
    platform_monitoring.record_request(path, status_code, duration_ms)  # persisted per-minute history for Monitoring
    platform_usage.record_request(tenant_slug, path, status_code, bytes_out)  # hourly tenant meters for Usage monitoring
    with _lock:
        bucket = _bucket(int(time.time()))
        bucket["count"] += 1
        if status_code >= 500:
            bucket["errors"] += 1
        if len(bucket["latencies"]) < _MAX_LATENCIES_PER_SECOND:
            bucket["latencies"].append(duration_ms)
        if tenant_slug:
            bucket["tenants"][tenant_slug] += 1
            detail = bucket["tenant_detail"].setdefault(tenant_slug, {"errors": 0, "latencies": []})
            if status_code >= 500:
                detail["errors"] += 1
            if len(detail["latencies"]) < _MAX_LATENCIES_PER_SECOND:
                detail["latencies"].append(duration_ms)


def tenant_snapshot(tenant_slug: str, apdex_target_ms: float) -> dict:
    """Live traffic for one tenant over the last few minutes of this worker."""
    now = int(time.time())
    with _lock:
        rows = {
            second: (b["tenants"].get(tenant_slug, 0), dict(b["tenant_detail"].get(tenant_slug, {"errors": 0, "latencies": []})))
            for second, b in _buckets.items() if second > now - _WINDOW_SECONDS
        }
        rows = {second: (count, {"errors": d["errors"], "latencies": list(d["latencies"])}) for second, (count, d) in rows.items()}
    total = sum(count for count, _ in rows.values())
    errors = sum(d["errors"] for _, d in rows.values())
    latencies = [ms for _, d in rows.values() for ms in d["latencies"]]
    satisfied = sum(1 for ms in latencies if ms <= apdex_target_ms)
    tolerating = sum(1 for ms in latencies if apdex_target_ms < ms <= apdex_target_ms * 4)
    series = []
    for index in range(_SERIES_POINTS):
        end = now - (_SERIES_POINTS - 1 - index) * _SERIES_STEP
        count = sum(rows[s][0] for s in range(end - _SERIES_STEP + 1, end + 1) if s in rows)
        series.append({"seconds_ago": now - end, "requests_per_min": round(count / _SERIES_STEP * 60, 1)})
    return {
        "window_seconds": _WINDOW_SECONDS,
        "requests_per_minute": round(total / (_WINDOW_SECONDS / 60), 1),
        "p95_ms": _p95(latencies),
        "error_rate": round(errors / total * 100, 2) if total else 0.0,
        "apdex": round((satisfied + tolerating / 2) / len(latencies), 2) if latencies else None,
        "requests": total,
        "series": series,
    }


def _p95(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))], 1)


def _queue_depth() -> int | None:
    try:
        client = redis.Redis.from_url(settings.CELERY_BROKER_URL, socket_connect_timeout=1, socket_timeout=1)
        return int(client.llen("celery"))
    except Exception:
        return None


def dead_letter_count(limit: int = 5000) -> int | None:
    """Failed Celery tasks still held in the result backend (Celery has no dead-letter queue)."""
    try:
        client = redis.Redis.from_url(settings.CELERY_RESULT_BACKEND, socket_connect_timeout=1, socket_timeout=2)
        failed = 0
        for index, key in enumerate(client.scan_iter("celery-task-meta-*", count=500)):
            if index >= limit:
                break
            raw = client.get(key)
            if raw and b'"FAILURE"' in raw:
                failed += 1
        return failed
    except Exception:
        return None


def snapshot() -> dict:
    now = int(time.time())
    with _lock:
        recent = {second: bucket for second, bucket in _buckets.items() if second > now - _WINDOW_SECONDS}
        copied = {second: (b["count"], b["errors"], list(b["latencies"]), dict(b["tenants"])) for second, b in recent.items()}

    def window(seconds: int):
        return [copied[s] for s in range(now - seconds + 1, now + 1) if s in copied]

    last_minute = window(60)
    last_five = window(_WINDOW_SECONDS)
    total_five = sum(c for c, _, _, _ in last_five)
    errors_five = sum(e for _, e, _, _ in last_five)
    tenant_totals: dict[str, int] = defaultdict(int)
    for _, _, _, tenants in last_five:
        for slug, count in tenants.items():
            tenant_totals[slug] += count

    series = []
    for index in range(_SERIES_POINTS):
        end = now - (_SERIES_POINTS - 1 - index) * _SERIES_STEP
        slice_ = [copied[s] for s in range(end - _SERIES_STEP + 1, end + 1) if s in copied]
        series.append({
            "seconds_ago": now - end,
            "rps": round(sum(c for c, _, _, _ in slice_) / _SERIES_STEP, 2),
            "p95_ms": _p95([ms for _, _, lat, _ in slice_ for ms in lat]),
        })

    return {
        "window_seconds": _WINDOW_SECONDS,
        "requests_per_second": round(sum(c for c, _, _, _ in last_minute) / 60, 2),
        "p95_ms": _p95([ms for _, _, lat, _ in last_five for ms in lat]),
        "error_rate": round(errors_five / total_five * 100, 2) if total_five else 0.0,
        "requests_5m": total_five,
        "errors_5m": errors_five,
        "tenant_requests_per_minute": {slug: round(count / (_WINDOW_SECONDS / 60), 1) for slug, count in tenant_totals.items()},
        "queue_depth": _queue_depth(),
        "series": series,
    }
