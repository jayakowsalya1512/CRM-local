"""Logs explorer (Data & infrastructure → Logs explorer).

Every API worker and Celery worker attaches PlatformLogHandler to the root logger (next to the existing system/error
file handlers set up by app.core.logging), so all application log records – plus one access line per API request –
are written to platform_log_entries in the master database. Each line carries its service (from the logger or request
path), the tenant of the request that produced it, and a redacted message. A background thread writes in batches,
so logging never waits on the database. Retention follows the Control Center "Application log retention (days)".
"""

from __future__ import annotations

import logging
import os
import re
import socket
import threading
import time
from collections import deque
from contextvars import ContextVar
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import BigInteger, Column, DateTime, Index, String, Text, text
from sqlalchemy.dialects.mysql import DATETIME

from app.database import Base, MasterSessionLocal, master_engine

LEVELS = ("INFO", "WARN", "ERROR")
SERVICES = ("api", "auth", "workflow", "db", "notify", "docs", "ai", "integration", "billing", "audit", "platform", "jobs")
current_tenant: ContextVar[Optional[str]] = ContextVar("log_tenant", default=None)


class PlatformLogEntry(Base):
    __tablename__ = "platform_log_entries"
    __table_args__ = (Index("ix_platform_log_ts", "ts"), Index("ix_platform_log_level_ts", "level", "ts"),
                      Index("ix_platform_log_service_ts", "service", "ts"), Index("ix_platform_log_tenant_ts", "tenant_slug", "ts"))
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    ts = Column(DATETIME(fsp=3), nullable=False)
    level = Column(String(5), nullable=False)
    service = Column(String(20), nullable=False)
    tenant_slug = Column(String(100), nullable=True)
    logger = Column(String(120), nullable=False)
    message = Column(String(1000), nullable=False)
    detail = Column(Text, nullable=True)  # traceback / full text when longer than one line
    worker = Column(String(80), nullable=False)


# ─── Redaction ───────────────────────────────────────────────────────────────
_REDACT = [
    (re.compile(r"(?i)\b(bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{12,}"), r"\1 [REDACTED]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), "[JWT]"),
    (re.compile(r"(?i)\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|otp|pin|client_secret|authorization)"
                r"(\s*[=:]\s*|\"\s*:\s*\")([^\s,&\"';|]+)"), r"\1\2[REDACTED]"),
    (re.compile(r"(?i)([?&](?:token|key|signature|sig|code|otp|password)=)[^&\s]+"), r"\1[REDACTED]"),
    (re.compile(r"(?i)(mysql\+pymysql|mysql|postgresql|redis|amqp)://([^:/@\s]+):([^@\s]+)@"), r"\1://\2:[REDACTED]@"),
    (re.compile(r"\b\d(?:[ -]?\d){12,15}\b"), "[CARD]"),
    (re.compile(r"\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b"), r"\1***@\2"),
]


def redact(value: str) -> str:
    for pattern, replacement in _REDACT:
        value = pattern.sub(replacement, value)
    return value


# ─── Service and tenant of a line ────────────────────────────────────────────
_PATH_SERVICES = [("/api/v1/auth", "auth"), ("/api/v1/platform", "platform"), ("/api/v1/approval", "workflow"), ("/api/v1/workflow", "workflow"),
                  ("/api/v1/notifications", "notify"), ("/api/v1/alerts", "notify"), ("/api/v1/document", "docs"), ("/api/v1/preview", "docs"),
                  ("/api/v1/storage", "docs"), ("/api/v1/letters", "docs"), ("/api/v1/rfp", "ai"), ("/api/v1/search", "ai"),
                  ("/api/v1/lead-integrations", "integration"), ("/api/v1/integrations", "integration"), ("/api/v1/webhook", "integration")]
_LOGGER_SERVICES = [("audit", "audit"), ("auth", "auth"), ("celery", "jobs"), ("sqlalchemy", "db"), ("pymysql", "db"), ("backup", "db"),
                    ("database", "db"), ("migration", "db"), ("notification", "notify"), ("email", "notify"), ("fcm", "notify"),
                    ("approval", "workflow"), ("workflow", "workflow"), ("escalation", "workflow"), ("document", "docs"), ("storage", "docs"),
                    ("preview", "docs"), ("file", "docs"), ("letter", "docs"), ("rfp", "ai"), ("ai_", "ai"), ("search", "ai"),
                    ("integration", "integration"), ("webhook", "integration"), ("billing", "billing"), ("subscription", "billing"),
                    ("platform", "platform"), ("tenant_", "platform"), ("uvicorn", "api")]
# Explicit mentions only ("tenant=ascent", "tenant: 'ascent'", "tenant 'ascent'") – "Tenant SMTP send failed" names no tenant.
_TENANT_IN_TEXT = re.compile(r"(?i)\btenant(?:\s*[=:]\s*['\"]?|\s+['\"])([a-z0-9_]{2,100})")


def service_for_path(path: str) -> str:
    return next((svc for prefix, svc in _PATH_SERVICES if path.startswith(prefix)), "api")


def service_for_logger(name: str, worker_kind: str) -> str:
    n = name.lower()
    if worker_kind == "celery" and not n.startswith(("app.services.platform", "app.services.tenant_")):
        return next((svc for word, svc in _LOGGER_SERVICES if word in n and svc not in ("api",)), "jobs")
    return next((svc for word, svc in _LOGGER_SERVICES if word in n), "api")


# ─── Collection ──────────────────────────────────────────────────────────────
_IGNORED = ("uvicorn.access", "watchfiles", "httpcore", "httpx", "multipart", "PIL", "asyncio", "python_multipart", "passlib", "urllib3")
_buffer: deque = deque(maxlen=20000)
_local = threading.local()
_state = {"installed": False, "worker": f"{socket.gethostname()}:{os.getpid()}", "kind": "api", "dropped": 0, "schema": False, "pruned": 0.0, "slugs": (0.0, set())}


class PlatformLogHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        if record.levelno < logging.INFO or getattr(_local, "writing", False) or record.name.startswith(_IGNORED):
            return
        if record.name.startswith("sqlalchemy") and record.levelno < logging.WARNING:  # SQL echo, not application events
            return
        if record.name == "app.main" and isinstance(record.msg, str) and record.msg.startswith(("API %s", "SLOW API %s")):
            return  # same request as the access line record_request writes (which also has the status code)
        try:
            text_ = record.getMessage()
            if record.exc_info and not record.exc_text:
                record.exc_text = logging.Formatter().formatException(record.exc_info)
            full = f"{text_}\n{record.exc_text}" if record.exc_text else text_
            first = full.strip().splitlines()[0] if full.strip() else ""
            # Candidates in order: the request's tenant, then tenants named in the message; the writer keeps the first real one.
            tenant = tuple(dict.fromkeys([t for t in [current_tenant.get()] if t] + [m.lower() for m in _TENANT_IN_TEXT.findall(text_)]))
            add(datetime.fromtimestamp(record.created), "ERROR" if record.levelno >= logging.ERROR else "WARN" if record.levelno >= logging.WARNING else "INFO",
                service_for_logger(record.name, _state["kind"]), tenant, record.name, first, full if full.strip() != first else None)
        except Exception:  # logging must never break the caller
            pass


def add(ts: datetime, level: str, service: str, tenant, logger_name: str, message: str, detail: Optional[str] = None) -> None:
    """tenant: a slug or a tuple of candidate slugs (the first one that exists is stored)."""
    if len(_buffer) == _buffer.maxlen:
        _state["dropped"] += 1
    _buffer.append((ts, level, service, tenant, logger_name[:120], redact(message)[:1000], redact(detail)[:20000] if detail else None))


def record_request(method: str, path: str, status: int, ms: float, tenant: Optional[str]) -> None:
    """Access line per API request (the prototype's 'GET /v2/bids 200 in 38ms'); the platform console's own polling is skipped."""
    if not path.startswith("/api") or (path.startswith("/api/v1/platform") and method in ("GET", "HEAD", "OPTIONS") and status < 400):
        return
    level = "ERROR" if status >= 500 else "WARN" if status >= 400 or ms >= 1000 else "INFO"
    add(datetime.now(), level, service_for_path(path), tenant, "access", f"{method} {path} {status} in {ms:.0f}ms")


def _known_slugs() -> set:
    at, slugs = _state["slugs"]
    if time.time() - at > 300:
        try:
            with master_engine.connect() as conn:
                slugs = {s for (s,) in conn.execute(text("SELECT slug FROM tenants"))}
            _state["slugs"] = (time.time(), slugs)
        except Exception:
            pass
    return slugs


def ensure_schema() -> None:
    if not _state["schema"]:
        PlatformLogEntry.__table__.create(bind=master_engine, checkfirst=True)
        _state["schema"] = True


def flush() -> int:
    """Write buffered lines (runs on the writer thread; its own SQL is never logged back)."""
    from app.services.platform_monitoring import _Quiet

    rows = []
    while _buffer and len(rows) < 2000:
        rows.append(_buffer.popleft())
    if not rows:
        return 0
    _local.writing = True
    try:
        ensure_schema()
        slugs = _known_slugs()
        pick = lambda t: next((s for s in ((t,) if isinstance(t, str) else (t or ())) if s in slugs), None)  # noqa: E731
        values = [{"ts": ts, "level": lv, "service": svc, "tenant": pick(t), "logger": lg, "message": m or "(empty)", "detail": d,
                   "worker": _state["worker"]} for ts, lv, svc, t, lg, m, d in rows]
        with _Quiet(), master_engine.begin() as conn:
            conn.execute(text("INSERT INTO platform_log_entries (ts, level, service, tenant_slug, logger, message, detail, worker) "
                              "VALUES (:ts, :level, :service, :tenant, :logger, :message, :detail, :worker)"), values)
        return len(values)
    except Exception:
        for row in reversed(rows):  # keep them for the next attempt (the buffer is bounded)
            _buffer.appendleft(row)
        time.sleep(5)
        return 0
    finally:
        _local.writing = False


def prune() -> int:
    """Delete lines older than the Control Center log retention (default 30 days), at most hourly."""
    if time.time() - _state["pruned"] < 3600:
        return 0
    _state["pruned"] = time.time()
    from app.services import platform_controls as controls

    _local.writing = True
    try:
        with MasterSessionLocal() as db:
            days = int(controls.value(db, "logKeep") or 30)
        cutoff, removed = datetime.now() - timedelta(days=max(1, days)), 0
        while True:
            with master_engine.begin() as conn:
                n = conn.execute(text("DELETE FROM platform_log_entries WHERE ts < :c LIMIT 10000"), {"c": cutoff}).rowcount
            removed += n
            if n < 10000:
                return removed
    except Exception:
        return 0
    finally:
        _local.writing = False


def _writer() -> None:
    while True:
        try:
            if not flush():
                time.sleep(1)
            prune()
        except Exception:
            time.sleep(5)


def install(kind: str = "api") -> None:
    """Attach the handler to the root logger once per process and start the writer thread."""
    if _state["installed"]:
        return
    _state["installed"], _state["kind"] = True, kind
    handler = PlatformLogHandler(level=logging.INFO)
    logging.getLogger().addHandler(handler)
    for name in ("auth", "audit"):  # these loggers may not propagate to root
        lg = logging.getLogger(name)
        if not lg.propagate:
            lg.addHandler(handler)
    start_writer()


def start_writer() -> None:
    _state["worker"] = f"{socket.gethostname()}:{os.getpid()}"
    threading.Thread(target=_writer, name="platform-log-writer", daemon=True).start()


# ─── Query ───────────────────────────────────────────────────────────────────
_FILTER_COLUMNS = {"t": "DATE_FORMAT(ts, '%Y-%m-%d %H:%i:%s')", "lv": "level", "svc": "service", "ten": "COALESCE(tenant_slug, '')", "msg": "message"}


def query(*, q: str = "", filters: dict | None = None, tenants: Optional[set] = None, before_id: Optional[int] = None, after_id: Optional[int] = None,
          limit: int = 500) -> dict:
    """Newest-first page of lines. q searches every column; filters are the grid's per-column 'contains' filters.
    tenants=None means every line; a set limits to those tenants' lines (platform-wide lines are hidden)."""
    ensure_schema()
    where, params = [], {}
    if tenants is not None:
        if not tenants:
            return {"rows": [], "matched": 0, "has_more": False}
        where.append("tenant_slug IN :tenants")
        params["tenants"] = tuple(tenants)
    if q.strip():
        where.append("(" + " OR ".join(f"{expr} LIKE :q" for expr in _FILTER_COLUMNS.values()) + ")")
        params["q"] = f"%{_like(q.strip())}%"
    for key, value in (filters or {}).items():
        if key in _FILTER_COLUMNS and (value or "").strip():
            where.append(f"{_FILTER_COLUMNS[key]} LIKE :f_{key}")
            params[f"f_{key}"] = f"%{_like(value.strip())}%"
    base = " AND ".join(where) or "1=1"
    page = base
    if before_id:
        page += " AND id < :before"
        params["before"] = before_id
    if after_id:
        page += " AND id > :after"
        params["after"] = after_id
    from sqlalchemy import bindparam
    stmt = lambda sql: text(sql).bindparams(bindparam("tenants", expanding=True)) if "tenants" in params else text(sql)  # noqa: E731
    with master_engine.connect() as conn:
        rows = conn.execute(stmt(f"SELECT id, ts, level, service, tenant_slug, logger, message, detail, worker FROM platform_log_entries "
                                 f"WHERE {page} ORDER BY id DESC LIMIT :lim"), {**params, "lim": limit + 1}).all()
        matched = conn.execute(stmt(f"SELECT COUNT(*) FROM (SELECT 1 FROM platform_log_entries WHERE {base} LIMIT 100001) x"), params).scalar()
    return {"rows": [{"id": r[0], "ts": r[1].isoformat(timespec="milliseconds"), "level": r[2], "service": r[3], "tenant": r[4], "logger": r[5],
                      "message": r[6], "detail": r[7], "worker": r[8]} for r in rows[:limit]],
            "matched": matched, "matched_capped": matched > 100000, "has_more": len(rows) > limit}


def _like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def status() -> dict:
    ensure_schema()
    with master_engine.connect() as conn:
        first, last, total = conn.execute(text("SELECT MIN(ts), MAX(ts), COUNT(*) FROM platform_log_entries")).one()
    return {"collecting_since": first.isoformat() if first else None, "latest": last.isoformat() if last else None, "total": total,
            "buffered": len(_buffer), "dropped": _state["dropped"], "installed": _state["installed"]}
