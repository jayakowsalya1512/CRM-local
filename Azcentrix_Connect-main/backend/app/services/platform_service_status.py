"""Services table (Infrastructure & releases → Services): the prototype's six services mapped to what runs them on our
self-hosted servers.

    api-gateway       FastAPI API processes (uvicorn / gunicorn)
    web-app           the built React app, served as static files by the web server at FRONTEND_BASE_URL
    workflow-engine   approval workflows – inside the API processes
    notification-svc  Celery workers on the Redis broker (e-mail / push queue)
    document-svc      document management & storage – inside the API processes, files on UPLOAD_DIR
    ai-svc            the local LLM server (Ollama at RFP_OLLAMA_URL) used by RFP analysis

Versions are reported by what runs: API processes by the release they loaded (backend/VERSION), Celery workers when they
start, the web build in /version.json, Ollama by its own API. Replicas, CPU and memory are the processes on this server
(psutil; CPU = % of all cores, memory = % of RAM). A service that is not running is "Unavailable" with no figures.
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from typing import Optional
from urllib.parse import urlparse

import requests

from app.core.config import settings
from app.core.version import RUNNING_VERSION, VERSION_SOURCE
from app.services import platform_controls as controls
from app.services import platform_jobs
from app.services import platform_monitoring as monitor

_CACHE: dict = {"at": 0.0, "value": None}
_CACHE_SECONDS = 15
_HEALTH = {"Operational": "Healthy", "Degraded": "Degraded", "Down": "Down", "Not configured": "Unavailable"}
IN_API = "Runs inside the API processes – CPU and memory are the API's"


def _row(name: str, health: str, detail: str, version: Optional[str] = None, version_source: Optional[str] = None,
         replicas: Optional[int] = None, usage: Optional[dict] = None, usage_note: Optional[str] = None) -> dict:
    available = health != "Unavailable"
    return {"name": name, "health": health, "detail": detail, "version": version if available else None,
            "version_source": version_source if available else None, "replicas": replicas if available else None,
            "cpu": usage["cpu"] if usage and available else None, "memory": usage["memory"] if usage and available else None,
            "usage_note": usage_note}


def _fetch_json(url: str) -> tuple[Optional[dict], Optional[str]]:
    try:
        response = requests.get(url, timeout=3)
        response.raise_for_status()
        data = response.json()
        return (data if isinstance(data, dict) else None), None
    except Exception as exc:
        return None, type(exc).__name__


def _api(procs: dict, limit: float) -> dict:
    api = procs.get("api")
    status, detail = monitor._error_status("api", limit)
    return _row("api-gateway", _HEALTH[status], detail, RUNNING_VERSION, VERSION_SOURCE, api["processes"] if api else None, api,
                None if api else "Process figures unavailable (psutil)")


def _web(procs: dict) -> dict:
    status, detail = monitor._web_status()
    health = _HEALTH.get(status, "Unavailable")
    base = (settings.FRONTEND_BASE_URL or "").rstrip("/")
    version, source = None, None
    if base and health in ("Healthy", "Degraded"):
        data, error = _fetch_json(f"{base}/version.json")
        version = str(data.get("version"))[:40] if data and data.get("version") else None
        source = "/version.json" if version else f"/version.json not published ({error or 'no version'})"
    web = procs.get("web")
    note = None if web else "The web server does not run on this server (or psutil is unavailable)"
    return _row("web-app", health, detail, version, source, web["processes"] if web else None, web, note)


def _in_api(name: str, procs: dict, status: tuple[str, str]) -> dict:
    api = procs.get("api")
    return _row(name, _HEALTH.get(status[0], "Unavailable"), status[1], RUNNING_VERSION, "API processes", api["processes"] if api else None, api, IN_API)


def _notifications(procs: dict) -> dict:
    state = platform_jobs.queues_overview()
    if not state["broker"]["ok"]:
        return _row("notification-svc", "Down", state["broker"]["error"])
    workers = state["workers"]
    if not workers["ok"]:
        return _row("notification-svc", "Unavailable", workers["error"] or "No Celery worker is running")
    try:
        reported = {k.decode(): v.decode() for k, v in platform_jobs._redis().hgetall(f"{platform_jobs.PREFIX}:worker_version").items()}
    except Exception:
        reported = {}
    versions = sorted({reported[name] for name in workers["names"] if name in reported})
    queued = state.get("queued") or 0
    health = "Degraded" if queued > 500 else "Healthy"
    detail = f"{workers['count']} worker(s) · {queued} queued"
    celery = procs.get("celery")
    source = "reported by workers" if versions else "workers started before version reporting – restart them to report"
    return _row("notification-svc", health, detail, " / ".join(versions) or None, source, workers["count"], celery,
                None if celery else "Workers run on another server – CPU and memory are not measured here")


def _ai(procs: dict) -> dict:
    url = urlparse(settings.RFP_OLLAMA_URL or "")
    if not url.scheme or not url.netloc:
        return _row("ai-svc", "Unavailable", "RFP_OLLAMA_URL is not set")
    base = f"{url.scheme}://{url.netloc}"
    started = time.perf_counter()
    data, error = _fetch_json(f"{base}/api/version")
    if data is None:
        return _row("ai-svc", "Unavailable", f"Ollama not reachable at {base} ({error})")
    ms = round((time.perf_counter() - started) * 1000)
    ai = procs.get("ai")
    return _row("ai-svc", "Degraded" if ms > 2000 else "Healthy", f"Ollama at {base} answered in {ms} ms · model {settings.RFP_LLM_MODEL}",
                str(data.get("version") or "")[:40] or None, "Ollama /api/version", ai["processes"] if ai else None, ai,
                None if ai else "Ollama runs on another server – CPU and memory are not measured here")


def services(db, force: bool = False) -> list[dict]:
    if not force and _CACHE["value"] is not None and time.time() - _CACHE["at"] < _CACHE_SECONDS:
        return _CACHE["value"]
    limit = float(controls.value(db, "alertErr") or 1)
    monitor.ensure_schema()  # before the parallel checks, which would race to create it
    procs = monitor.process_usage() or {}
    checks = [
        lambda: _api(procs, limit),
        lambda: _web(procs),
        lambda: _in_api("workflow-engine", procs, monitor._error_status("workflow", limit)),
        lambda: _notifications(procs),
        lambda: _in_api("document-svc", procs, monitor._documents_status()),
        lambda: _ai(procs),
    ]
    with ThreadPoolExecutor(max_workers=len(checks)) as pool:  # several checks wait on the network
        rows = list(pool.map(lambda check: check(), checks))
    _CACHE.update(at=time.time(), value=rows)
    return rows
