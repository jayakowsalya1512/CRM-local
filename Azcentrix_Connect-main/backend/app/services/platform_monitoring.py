"""Monitoring module (Data & infrastructure → Monitoring).

Collection
  * Every API request is recorded by platform_traffic.record() → record_request(); every SQL statement the API runs
    is timed through SQLAlchemy engine events → the "database" service. Each API worker keeps per-minute counters
    and a latency histogram in memory and flush() writes finished minutes to MariaDB (platform_metric_minutes).
  * The uptime probe (platform_uptime.sample) stores each server's CPU / memory / disk per minute
    (platform_resource_samples) and its online minutes (Redis), which give availability and the error budget.
Percentiles come from merged histograms whose buckets grow by 10 %, so p50 / p95 / p99 are accurate to ±5 %.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import smtplib
import socket
import ssl
import threading
import time
from collections import Counter
from datetime import datetime, timedelta
from email.message import EmailMessage
from pathlib import Path
from typing import Optional

import requests
from sqlalchemy import event, text
from sqlalchemy.engine import Engine

from app.core.config import settings
from app.database import MasterSessionLocal, master_engine
from app.models.platform_monitoring import PlatformAlertRule, PlatformIncident, PlatformMetricMinute, PlatformResourceSample

try:
    import psutil
except ImportError:
    psutil = None

logger = logging.getLogger(__name__)

# ─── Services ────────────────────────────────────────────────────────────────
# Filter label → key. "all" and "api" both read every API request; "database" reads SQL statements.
SERVICES = {
    "All services": "all", "API gateway": "api", "Web app": "web", "Workflow engine": "workflow",
    "Notification service": "notification", "Document store": "documents", "AI service": "ai", "Database": "database",
}
SERVICE_PATHS = {
    "workflow": ("/api/v1/approvals", "/api/v1/approval-workflows"),
    "notification": ("/api/v1/notifications", "/api/v1/alerts"),
    "documents": ("/api/v1/document-management", "/api/v1/storage", "/api/v1/letters"),
    "ai": ("/api/v1/search/ask",),  # the only endpoint that calls the AI model (ai_search_service)
    "integrations": ("/api/v1/integrations",),
}
RANGES = {"1h": 60, "6h": 360, "24h": 1440, "7d": 10080}
_VERSION_RE = re.compile(r"^/api/(v\d+)/")
POINTS = 24
RETENTION_MINUTES = 8 * 1440
WORKER = f"{socket.gethostname()}:{os.getpid()}"[:80]

# ─── Histogram ───────────────────────────────────────────────────────────────
_GROWTH = 1.1
_MAX_BUCKET = 140  # 1.1 ** 140 ≈ 6 × 10^5 ms


def bucket(ms: float) -> int:
    return 0 if ms < 1 else min(_MAX_BUCKET, int(math.log(ms) / math.log(_GROWTH)) + 1)


def _bucket_value(index: int) -> float:
    """Geometric middle of a bucket (bucket 0 holds < 1 ms)."""
    return 0.5 if index == 0 else _GROWTH ** (index - 0.5)


def percentile(hist: Counter, q: float) -> Optional[float]:
    total = sum(hist.values())
    if not total:
        return None
    rank, seen = q * total, 0
    for index in sorted(hist):
        seen += hist[index]
        if seen >= rank:
            return round(_bucket_value(index), 1)
    return round(_bucket_value(max(hist)), 1)


def apdex(hist: Counter, target_ms: float) -> Optional[float]:
    total = sum(hist.values())
    if not total:
        return None
    satisfied = sum(n for i, n in hist.items() if _bucket_value(i) <= target_ms)
    tolerating = sum(n for i, n in hist.items() if target_ms < _bucket_value(i) <= target_ms * 4)
    return round((satisfied + tolerating / 2) / total, 2)


# ─── In-process collection ───────────────────────────────────────────────────
_lock = threading.Lock()
_buffer: dict[tuple[int, str], dict] = {}
_local = threading.local()  # .quiet suppresses statement timing for the monitor's own queries


def _add(service: str, ms: float, error: bool) -> None:
    key = (int(time.time() // 60), service)
    with _lock:
        entry = _buffer.get(key)
        if entry is None:
            entry = _buffer[key] = {"requests": 0, "errors": 0, "hist": Counter()}
        entry["requests"] += 1
        entry["errors"] += int(error)
        entry["hist"][bucket(ms)] += 1


def record_request(path: str, status_code: int, duration_ms: float) -> None:
    error = status_code >= 500
    _add("api", duration_ms, error)
    version = _VERSION_RE.match(path)
    if version:   # per API version, for adoption on Rate limits & API keys (not a Monitoring service filter)
        _add(f"ver:{version.group(1)}", duration_ms, error)
    for service, prefixes in SERVICE_PATHS.items():
        if path.startswith(prefixes):
            _add(service, duration_ms, error)


@event.listens_for(Engine, "before_cursor_execute")
def _statement_start(conn, cursor, statement, parameters, context, executemany):
    conn.info.setdefault("platform_monitor_start", []).append(time.perf_counter())


@event.listens_for(Engine, "after_cursor_execute")
def _statement_end(conn, cursor, statement, parameters, context, executemany):
    starts = conn.info.get("platform_monitor_start")
    if starts:
        started = starts.pop()
        if not getattr(_local, "quiet", False):
            _add("database", (time.perf_counter() - started) * 1000, False)


@event.listens_for(Engine, "handle_error")
def _statement_error(context):
    starts = context.connection.info.get("platform_monitor_start") if context.connection is not None else None
    if starts:
        started = starts.pop()
        if not getattr(_local, "quiet", False):
            _add("database", (time.perf_counter() - started) * 1000, True)


class _Quiet:
    def __enter__(self):
        _local.quiet = True

    def __exit__(self, *exc):
        _local.quiet = False


_schema_ready = False


def ensure_schema() -> None:
    global _schema_ready
    if not _schema_ready:
        with _Quiet():
            for model in (PlatformMetricMinute, PlatformResourceSample, PlatformAlertRule, PlatformIncident):
                model.__table__.create(bind=master_engine, checkfirst=True)
        _schema_ready = True


def flush() -> None:
    """Write this worker's finished minutes to MariaDB (run once a minute in every worker)."""
    current = int(time.time() // 60)
    with _lock:
        done = {key: _buffer.pop(key) for key in [k for k in _buffer if k[0] < current]}
    if not done:
        return
    ensure_schema()
    with _Quiet():
        db = MasterSessionLocal()
        try:
            for (minute, service), entry in done.items():
                db.add(PlatformMetricMinute(minute=minute, service=service, worker=WORKER, requests=entry["requests"],
                                            errors=entry["errors"], hist={str(k): v for k, v in entry["hist"].items()}))
            if current % 60 == 0:
                db.query(PlatformMetricMinute).filter(PlatformMetricMinute.minute < current - RETENTION_MINUTES).delete(synchronize_session=False)
                db.query(PlatformResourceSample).filter(PlatformResourceSample.minute < current - RETENTION_MINUTES).delete(synchronize_session=False)
            db.commit()
        except Exception:
            db.rollback()
            logger.exception("Monitoring flush failed; %d minute(s) dropped", len(done))
        finally:
            db.close()


def record_server_sample(result: dict) -> None:
    """Called by the uptime probe with platform_infrastructure.probe_server() output."""
    metrics = result.get("metrics") or {}
    if not metrics.get("available"):
        return
    ensure_schema()
    minute = int(time.time() // 60)
    with _Quiet():
        db = MasterSessionLocal()
        try:
            db.add(PlatformResourceSample(minute=minute, server=result["name"], roles=",".join(result.get("roles") or []),
                                          cpu=metrics.get("cpu_percent"), memory=metrics.get("memory_percent"), disk=metrics.get("disk_percent")))
            db.commit()
        except Exception:
            db.rollback()  # duplicate minute from a second probe
        finally:
            db.close()


# ─── Queries ─────────────────────────────────────────────────────────────────

def _minutes(service: str, start: int, end: int) -> dict[int, dict]:
    """{minute: {requests, errors, hist}} merged over workers, including this worker's unflushed minutes."""
    ensure_schema()
    merged: dict[int, dict] = {}

    def add(minute, requests_, errors, hist):
        entry = merged.setdefault(minute, {"requests": 0, "errors": 0, "hist": Counter()})
        entry["requests"] += requests_
        entry["errors"] += errors
        for k, v in hist.items():
            entry["hist"][int(k)] += v

    with _Quiet():
        db = MasterSessionLocal()
        try:
            rows = db.query(PlatformMetricMinute.minute, PlatformMetricMinute.requests, PlatformMetricMinute.errors, PlatformMetricMinute.hist).filter(
                PlatformMetricMinute.service == service, PlatformMetricMinute.minute >= start, PlatformMetricMinute.minute <= end).all()
        finally:
            db.close()
    for minute, requests_, errors, hist in rows:
        add(minute, requests_, errors, hist if isinstance(hist, dict) else json.loads(hist or "{}"))
    with _lock:
        local = [(m, dict(e["hist"]), e["requests"], e["errors"]) for (m, s), e in _buffer.items() if s == service and start <= m <= end]
    for minute, hist, requests_, errors in local:
        add(minute, requests_, errors, hist)
    return merged


def window_stats(service: str, minutes: int) -> dict:
    end = int(time.time() // 60)
    data = _minutes(service, end - minutes + 1, end)
    hist = Counter()
    for entry in data.values():
        hist.update(entry["hist"])
    total = sum(e["requests"] for e in data.values())
    errors = sum(e["errors"] for e in data.values())
    return {"requests": total, "errors": errors, "error_rate": round(errors / total * 100, 2) if total else None,
            "p50": percentile(hist, .5), "p95": percentile(hist, .95), "p99": percentile(hist, .99), "hist": hist,
            "rps": round(total / max((minutes - 1) * 60 + time.time() % 60, 1), 2)}


def series(service: str, range_key: str) -> list[dict]:
    minutes = RANGES[range_key]
    now = time.time()
    end = int(now // 60)
    start = end - minutes + 1
    data = _minutes(service, start, end)
    points = []
    for p in range(POINTS):
        first, last = start + p * minutes // POINTS, start + (p + 1) * minutes // POINTS - 1
        hist, total, errors = Counter(), 0, 0
        for m in range(first, last + 1):
            entry = data.get(m)
            if entry:
                hist.update(entry["hist"])
                total += entry["requests"]
                errors += entry["errors"]
        # The newest slot includes the minute in progress: divide by the seconds that have actually elapsed.
        seconds = (last - first) * 60 + (now - end * 60 if last == end else 60)
        points.append({"minutes_ago": end - last, "rps": round(total / max(seconds, 1), 3), "requests": total,
                       "p50": percentile(hist, .5), "p95": percentile(hist, .95), "p99": percentile(hist, .99),
                       "error_rate": round(errors / total * 100, 2) if total else None})
    return points


def first_minute(service: str) -> Optional[int]:
    """Earliest stored minute for a service, i.e. when collection began (None before the first flush)."""
    ensure_schema()
    from sqlalchemy import func

    with _Quiet():
        db = MasterSessionLocal()
        try:
            return db.query(func.min(PlatformMetricMinute.minute)).filter(PlatformMetricMinute.service == service).scalar()
        finally:
            db.close()


def cpu_by_server(minutes: int, role: Optional[str] = None) -> dict[str, float]:
    """Average CPU per server over the window from the uptime probe samples."""
    ensure_schema()
    end = int(time.time() // 60)
    with _Quiet():
        db = MasterSessionLocal()
        try:
            rows = db.query(PlatformResourceSample.server, PlatformResourceSample.roles, PlatformResourceSample.cpu).filter(
                PlatformResourceSample.minute > end - minutes, PlatformResourceSample.cpu.isnot(None)).all()
        finally:
            db.close()
    values: dict[str, list[float]] = {}
    for server, roles, cpu in rows:
        if role is None or role in (roles or "").split(","):
            values.setdefault(server, []).append(cpu)
    return {server: round(sum(v) / len(v), 1) for server, v in values.items()}


def latest_server_sample(server: str) -> Optional[PlatformResourceSample]:
    ensure_schema()
    with _Quiet():
        db = MasterSessionLocal()
        try:
            return db.query(PlatformResourceSample).filter(PlatformResourceSample.server == server).order_by(PlatformResourceSample.minute.desc()).first()
        finally:
            db.close()


# ─── Process usage (CPU / memory by service) ────────────────────────────────
_PROCESS_CACHE: dict = {"at": 0.0, "value": None}


def _process_groups() -> dict[str, list]:
    groups = {"api": [], "celery": [], "database": [], "web": [], "ai": []}
    me = os.getpid()
    for proc in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            name = (proc.info["name"] or "").lower()
            cmd = " ".join(proc.info["cmdline"] or []).lower()
        except (psutil.Error, OSError):
            continue
        if proc.info["pid"] == me or ("uvicorn" in cmd and "app.main" in cmd) or ("gunicorn" in cmd and "app.main" in cmd):
            groups["api"].append(proc)
        elif "celery" in cmd and "worker" in cmd:
            groups["celery"].append(proc)
        elif name.startswith(("mysqld", "mariadbd")):
            groups["database"].append(proc)
        elif name.startswith(("nginx", "httpd", "apache2", "caddy")):
            groups["web"].append(proc)
        elif name.startswith("ollama"):
            groups["ai"].append(proc)
    return groups


def process_usage() -> Optional[dict[str, dict]]:
    """CPU (% of all cores) and memory (% of RAM) of the API, Celery, database, web server and Ollama processes; cached 10 s."""
    if psutil is None:
        return None
    if _PROCESS_CACHE["value"] is not None and time.time() - _PROCESS_CACHE["at"] < 10:
        return _PROCESS_CACHE["value"]
    groups = _process_groups()
    for procs in groups.values():
        for proc in procs:
            try:
                proc.cpu_percent(None)
            except psutil.Error:
                pass
    time.sleep(0.5)
    cores = psutil.cpu_count() or 1
    result = {}
    for key, procs in groups.items():
        cpu = mem = 0.0
        alive = 0
        for proc in procs:
            try:
                cpu += proc.cpu_percent(None) / cores
                mem += proc.memory_percent()
                alive += 1
            except psutil.Error:
                continue
        result[key] = {"cpu": round(cpu, 1), "memory": round(mem, 1), "processes": alive} if alive else None
    _PROCESS_CACHE.update(at=time.time(), value=result)
    return result


# ─── Status page ─────────────────────────────────────────────────────────────
_STATUS_CACHE: dict = {"at": 0.0, "value": None}


def _error_status(service: str, limit: float) -> tuple[str, str]:
    stats = window_stats(service, 15)
    if not stats["requests"]:
        return "Operational", "No requests in the last 15 min"
    detail = f"{stats['error_rate']}% errors · {stats['requests']} requests in 15 min"
    return ("Degraded" if stats["error_rate"] > limit else "Operational"), detail


def _celery_status() -> tuple[str, str]:
    import redis

    try:
        client = redis.Redis.from_url(settings.CELERY_BROKER_URL, socket_connect_timeout=1, socket_timeout=1)
        client.ping()
        depth = int(client.llen("celery"))
    except Exception as exc:
        return "Down", f"Queue broker unreachable: {exc}"
    try:
        from app.celery_app import celery_app

        workers = celery_app.control.ping(timeout=1.0) or []
    except Exception:
        workers = []
    if not workers:
        return "Degraded", f"No Celery worker is running; {depth} message(s) waiting"
    return ("Degraded" if depth > 500 else "Operational"), f"{len(workers)} worker(s) · {depth} queued"


def _web_status() -> tuple[str, str]:
    url = (settings.FRONTEND_BASE_URL or "").strip()
    if not url:
        return "Not configured", "FRONTEND_BASE_URL is not set"
    started = time.perf_counter()
    try:
        response = requests.get(url, timeout=4, allow_redirects=True)
    except Exception as exc:
        return "Down", f"{url} unreachable: {type(exc).__name__}"
    ms = round((time.perf_counter() - started) * 1000)
    if response.status_code >= 500:
        return "Down", f"HTTP {response.status_code} from {url}"
    return ("Degraded" if ms > 2000 or response.status_code >= 400 else "Operational"), f"HTTP {response.status_code} in {ms} ms"


def _documents_status() -> tuple[str, str]:
    root = Path(settings.UPLOAD_DIR).resolve()
    try:
        root.mkdir(parents=True, exist_ok=True)
        probe = root / f".monitor-{os.getpid()}"
        probe.write_text("ok")
        probe.unlink()
    except OSError as exc:
        return "Down", f"Upload storage not writable: {exc}"
    if psutil is not None:
        usage = psutil.disk_usage(str(root))
        # Network shares can report free > total; their numbers are meaningless (same rule as the infrastructure probe).
        if usage.total > 0 and 0 <= usage.used <= usage.total:
            return ("Degraded" if usage.percent >= 90 else "Operational"), f"Storage {usage.percent:.0f}% used"
    return "Operational", "Upload storage writable; disk usage not reported for this volume"


def status_page(error_limit: float) -> list[dict]:
    """Health of each prototype status-page service; cached 30 s."""
    if _STATUS_CACHE["value"] is not None and time.time() - _STATUS_CACHE["at"] < 30:
        return _STATUS_CACHE["value"]
    from app.services.ai_search_service import is_configured as ai_search_is_configured

    api = _error_status("api", error_limit)
    checks = [
        ("API", api),
        ("Web application", _web_status()),
        ("Workflow engine", _error_status("workflow", error_limit)),
        ("Notifications", _celery_status()),
        ("Documents", _documents_status()),
        ("AI Copilot", _error_status("ai", error_limit) if ai_search_is_configured() else ("Not configured", "AI_SEARCH_ENABLED / OPENAI_API_KEY not set")),
        ("Integrations", _error_status("integrations", error_limit)),
    ]
    value = [{"name": name, "status": status, "detail": detail} for name, (status, detail) in checks]
    _STATUS_CACHE.update(at=time.time(), value=value)
    return value


# ─── Alert rules ─────────────────────────────────────────────────────────────
METRICS = {  # key: (label, unit, default window)
    "api_p95": ("API p95", "ms", 5),
    "error_rate": ("Error rate", "%", 5),
    "db_cpu": ("DB CPU", "%", 10),
    "replication_lag": ("Replication lag", "s", 1),
    "queue_depth": ("Queue depth", "", 1),
    "tenant_storage": ("Tenant storage", "%", 1),
}
ACTIONS = {"page_oncall": "Page on-call", "slack": "Slack #infra", "email_tenant_admin": "Email tenant admin", "email": "Email"}
DEFAULT_RULES = [  # prototype alert rules
    ("api_p95", 400, 5, "page_oncall", "SEV2"),
    ("error_rate", 1, 5, "page_oncall", "SEV2"),
    ("db_cpu", 70, 10, "slack", "SEV3"),
    ("replication_lag", 10, 1, "page_oncall", "SEV2"),
    ("queue_depth", 500, 1, "slack", "SEV3"),
    ("tenant_storage", 90, 1, "email_tenant_admin", "SEV3"),
]
_WINDOWED = {"api_p95", "error_rate", "db_cpu"}
NOTIFY_COOLDOWN = timedelta(minutes=30)  # at most one alert email per rule in this time, however often it re-fires


def rule_label(rule: PlatformAlertRule) -> str:
    label, unit, _ = METRICS[rule.metric]
    value = f"{rule.threshold:g}{(' ' + unit) if unit in ('ms', 's') else unit}"
    return f"{label} > {value}" + (f" for {rule.duration_minutes} min" if rule.metric in _WINDOWED and rule.metric != "error_rate" else "")


def seed_rules(db) -> None:
    ensure_schema()
    if db.query(PlatformAlertRule.id).first() is None:
        for metric, threshold, duration, action, severity in DEFAULT_RULES:
            db.add(PlatformAlertRule(metric=metric, threshold=threshold, duration_minutes=duration, action=action, severity=severity, created_by="system"))
        db.commit()


def _measure(db, rule: PlatformAlertRule) -> tuple[Optional[float], str, dict]:
    """Current value of a rule's metric: (value, state when no value, detail)."""
    from app.models.tenant import Tenant

    if rule.metric == "api_p95":
        stats = window_stats("api", rule.duration_minutes)
        return stats["p95"], "no_data", {"requests": stats["requests"]}
    if rule.metric == "error_rate":
        stats = window_stats("api", rule.duration_minutes)
        return stats["error_rate"], "no_data", {"requests": stats["requests"], "errors": stats["errors"]}
    if rule.metric == "db_cpu":
        values = cpu_by_server(rule.duration_minutes, "Database")
        return (max(values.values()) if values else None), "unavailable", {"servers": values, "reason": None if values else "No CPU samples from a database server (metrics agent needed for remote database hosts)"}
    if rule.metric == "replication_lag":
        from app.services import platform_databases as dbs

        servers = dbs.probe_all(with_qps=False)
        lags = {s["name"]: s["replication"].get("lag_seconds") for s in servers if (s.get("replication") or {}).get("role") == "Replica"}
        if not lags:
            return None, "unavailable", {"reason": "No database replication is configured"}
        known = [v for v in lags.values() if v is not None]
        return (max(known) if known else float("inf")), "unavailable", {"replicas": lags}
    if rule.metric == "queue_depth":
        from app.services.platform_traffic import _queue_depth

        depth = _queue_depth()
        return (float(depth) if depth is not None else None), "unavailable", {"reason": None if depth is not None else "Queue broker (Redis) unreachable"}
    if rule.metric == "tenant_storage":
        rows = {}
        for tenant in db.query(Tenant).filter(Tenant.storage_limit_mb > 0).all():
            rows[tenant.id] = round(float(tenant.used_storage or 0) / float(tenant.storage_limit_mb) * 100, 1)
        over = [tid for tid, pct in rows.items() if pct > rule.threshold]
        return (max(rows.values()) if rows else None), "no_data", {"tenants_over": over}
    return None, "unavailable", {"reason": "Unknown metric"}


def _send_email(recipients: list[str], subject: str, body: str) -> str:
    if not (settings.SMTP_HOST and settings.SMTP_USER and settings.SMTP_PASSWORD):
        return "not sent: SMTP is not configured"
    if not recipients:
        return "not sent: no recipients"
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = settings.EMAILS_FROM or settings.SMTP_USER
    message["To"] = ", ".join(recipients)
    message.set_content(body)
    try:
        with smtplib.SMTP(settings.SMTP_HOST, int(settings.SMTP_PORT), timeout=30) as server:
            server.starttls(context=ssl.create_default_context())
            server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            server.send_message(message)
        return f"e-mailed {len(recipients)} recipient(s)"
    except Exception as exc:
        logger.warning("Alert e-mail failed: %s", exc)
        return f"e-mail failed: {exc}"


def _notify(db, rule: PlatformAlertRule, subject: str, body: str, tenant_ids: Optional[list[int]] = None) -> str:
    from app.models.tenant import SuperAdmin, Tenant

    if rule.action == "page_oncall":
        admins = [a.email for a in db.query(SuperAdmin).filter(SuperAdmin.is_active == True).all() if a.email]  # noqa: E712
        return _send_email(admins, subject, body)
    if rule.action == "email":
        return _send_email([e.strip() for e in (rule.target or "").split(",") if e.strip()], subject, body)
    if rule.action == "email_tenant_admin":
        emails = [t.admin_email for t in db.query(Tenant).filter(Tenant.id.in_(tenant_ids or [0])).all() if t.admin_email]
        return _send_email(emails, subject, body)
    if rule.action == "slack":
        if not rule.target:
            return "not sent: no Slack webhook URL on this rule"
        try:
            response = requests.post(rule.target, json={"text": f"*{subject}*\n{body}"}, timeout=10)
            return f"Slack HTTP {response.status_code}"
        except Exception as exc:
            return f"Slack failed: {exc}"
    return "not sent: unknown action"


def _open_incident(db, source: str, title: str, severity: str, detail: str) -> None:
    if db.query(PlatformIncident.id).filter(PlatformIncident.source == source, PlatformIncident.status == "Open").first() is None:
        db.add(PlatformIncident(source=source, title=title[:300], severity=severity, status="Open", detail=detail))


def _resolve_incidents(db, source: str, keep: set[str] = frozenset()) -> None:
    """Resolve open incidents of `source` and its children (`source:…`) except those in `keep`."""
    from sqlalchemy import or_

    matches = or_(PlatformIncident.source == source, PlatformIncident.source.like(source + ":%"))
    for incident in db.query(PlatformIncident).filter(PlatformIncident.status == "Open", matches).all():
        if incident.source not in keep:
            incident.status, incident.resolved_at = "Resolved", datetime.utcnow()


def evaluate_rule(db, rule: PlatformAlertRule) -> None:
    from app.models.tenant import Tenant

    value, empty_state, detail = _measure(db, rule)
    now = datetime.utcnow()
    firing = value is not None and value > rule.threshold
    source = f"rule:{rule.id}"
    label = rule_label(rule)
    if rule.metric == "tenant_storage":
        over = detail.get("tenants_over", [])
        previous = set((rule.last_detail or {}).get("tenants_over", []))
        new = [tid for tid in over if tid not in previous]
        names = {t.id: t.name for t in db.query(Tenant).filter(Tenant.id.in_(over or [0])).all()}
        for tid in over:
            _open_incident(db, f"{source}:{tid}", f"{names.get(tid, 'Tenant')} storage above {rule.threshold:g}%", rule.severity, label)
        _resolve_incidents(db, source, {f"{source}:{tid}" for tid in over})
        if new:
            detail["delivery"] = _notify(db, rule, f"[{rule.severity}] Tenant storage above {rule.threshold:g}%",
                                         "Storage is above the alert threshold for: " + ", ".join(names.get(t, str(t)) for t in new), new)
            rule.last_fired_at = now
    elif firing and rule.state != "firing":
        # "for N min": the condition must hold on every evaluation for the rule's duration before it fires,
        # so a short spike (a few slow requests in a quiet window) doesn't page anyone.
        since = (rule.last_detail or {}).get("pending_since")
        since_at = datetime.fromisoformat(since) if since else now
        if (now - since_at).total_seconds() < rule.duration_minutes * 60 - 30:
            detail["pending_since"] = since_at.isoformat()
            firing = False  # stays OK (pending) until the duration has passed
        else:
            _open_incident(db, source, f"{label} (now {value:g})", rule.severity, json.dumps(detail, default=str))
            # One alert email per rule per NOTIFY_COOLDOWN: a metric that keeps flapping across the threshold opens
            # incidents (Monitoring) but doesn't send a fresh email each time.
            if rule.last_fired_at and now - rule.last_fired_at < NOTIFY_COOLDOWN:
                detail["delivery"] = f"not sent: already alerted at {rule.last_fired_at:%H:%M} UTC (repeat emails are held for {int(NOTIFY_COOLDOWN.total_seconds() // 60)} min)"
            else:
                detail["delivery"] = _notify(db, rule, f"[{rule.severity}] {label}", f"Alert '{label}' is firing. Current value: {value:g}.\nDetail: {json.dumps(detail, default=str)}")
                rule.last_fired_at = now
    elif firing:
        detail["delivery"] = (rule.last_detail or {}).get("delivery")
    else:
        _resolve_incidents(db, source)
    rule.state = ("firing" if (over if rule.metric == "tenant_storage" else firing) else "ok") if value is not None else empty_state
    rule.last_value = None if value is None or value == float("inf") else value
    rule.last_detail = detail
    rule.last_evaluated_at = now


def evaluate() -> None:
    """Evaluate every enabled rule and track server outages as incidents (one worker per minute)."""
    from app.services import platform_uptime

    minute = int(time.time() // 60)
    try:
        if not platform_uptime._client().set(f"platform:monitoring:eval:{minute}", "1", nx=True, ex=120):
            return
    except Exception:
        pass  # without Redis every worker evaluates; incidents are de-duplicated by source
    ensure_schema()
    with _Quiet():
        db = MasterSessionLocal()
        try:
            seed_rules(db)
            for rule in db.query(PlatformAlertRule).all():
                if not rule.enabled:
                    _resolve_incidents(db, f"rule:{rule.id}")
                    continue
                try:
                    evaluate_rule(db, rule)
                except Exception:
                    logger.exception("Alert rule %s evaluation failed", rule.id)
            down = {item["server"]: item["state"] for item in platform_uptime.open_incidents()}
            for server, state in down.items():
                _open_incident(db, f"server:{server}", f"{server}: {state.lower()}", "SEV1" if state == "Offline" else "SEV2", state)
            _resolve_incidents(db, "server", {f"server:{s}" for s in down})
            db.commit()
        except Exception:
            db.rollback()
            logger.exception("Alert evaluation failed")
        finally:
            db.close()
