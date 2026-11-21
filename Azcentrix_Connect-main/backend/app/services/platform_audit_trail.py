"""Audit trail (Governance): the existing platform audit log (``platform_audit_logs``) – searched, filtered, sorted and
paged in the database, exported as signed CSV, and protected against modification.

* Result is derived from the action name: actions ending in ``_failed`` are Failed, ``_blocked`` Blocked, others Success.
* Tenant = the affected tenant for entries about a tenant (entity_type ``tenant``).
* Tenant-scoped staff see only entries about their tenants.
* Credentials are never returned: keys that name a secret and values shaped like hashes / tokens are redacted.
* Database triggers refuse UPDATE and DELETE on the table, so entries can't be changed through the application.
"""

from __future__ import annotations

import csv
import hashlib
import hmac
import io
import logging
import re
from datetime import date, datetime, time
from typing import Any, Optional

from sqlalchemy import and_, case, func, literal, not_, or_, text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.database import master_engine
from app.models.tenant import PlatformAuditLog, SuperAdmin

logger = logging.getLogger(__name__)

RESULTS = ("Success", "Failed", "Blocked")
EXPORT_LIMIT = 100_000
REDACTED = "••• redacted"
_SECRET_KEY = re.compile(r"(?:^|_)(password|passwd|secret|token|tokens|api_?key|private_?key|hash|pin|otp|credential|credentials|access_key)$", re.I)
_SECRET_VALUE = re.compile(r"^(\$2[aby]\$\d\d\$|eyJ[A-Za-z0-9_-]{10,}\.|-----BEGIN )")

_INDEXES = {
    "ix_pal_created": "(created_at, id)",                      # default order, date range
    "ix_pal_entity": "(entity_type, entity_id, created_at)",   # tenant scope / tenant filter
    "ix_pal_action": "(action, created_at)",                   # action filter, Result (action suffix)
}
_TRIGGERS = {
    "trg_platform_audit_logs_no_update": "BEFORE UPDATE",
    "trg_platform_audit_logs_no_delete": "BEFORE DELETE",
}
_ready: dict[str, bool] = {}


def ensure_schema() -> None:
    """Indexes for the audit trail's query patterns, and triggers that make the table append-only."""
    if _ready.get("schema"):
        return
    with master_engine.begin() as conn:
        existing = {r[2] for r in conn.execute(text("SHOW INDEX FROM platform_audit_logs"))}
        for name, cols in _INDEXES.items():
            if name not in existing:
                conn.execute(text(f"CREATE INDEX {name} ON platform_audit_logs {cols}"))
        triggers = {r[0] for r in conn.execute(text(
            "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'platform_audit_logs'"))}
        for name, timing in _TRIGGERS.items():
            if name not in triggers:
                conn.execute(text(f"CREATE TRIGGER {name} {timing} ON platform_audit_logs FOR EACH ROW "
                                  "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Audit log entries cannot be changed or deleted'"))
    _ready["schema"] = True


def outcome_of(action: Optional[str]) -> str:
    a = (action or "").lower()
    return "Failed" if a.endswith("_failed") else "Blocked" if a.endswith("_blocked") else "Success"


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: (REDACTED if _SECRET_KEY.search(str(k)) and v not in (None, "", [], {}) and not isinstance(v, bool) else redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, str) and _SECRET_VALUE.search(value):
        return REDACTED
    return value


# ─── Columns (grid keys → SQL) ───────────────────────────────────────────────

# Entries outlive accounts (super_admin_id has no foreign key): a removed account shows as "Deleted account #id".
_actor = case((and_(PlatformAuditLog.super_admin_id.isnot(None), SuperAdmin.id.is_(None)), func.concat("Deleted account #", PlatformAuditLog.super_admin_id)),
              else_=func.coalesce(SuperAdmin.full_name, SuperAdmin.username, literal("System")))
_event = func.coalesce(PlatformAuditLog.description, PlatformAuditLog.action)
_result = case((PlatformAuditLog.action.like("%\\_failed"), literal("Failed")), (PlatformAuditLog.action.like("%\\_blocked"), literal("Blocked")), else_=literal("Success"))
_tenant = case((PlatformAuditLog.entity_type == "tenant", PlatformAuditLog.entity_name), else_=literal(""))
COLUMNS = {"t": PlatformAuditLog.created_at, "u": _actor, "a": _event, "ip": PlatformAuditLog.ip_address, "r": _result,
           "tenant": _tenant, "action": PlatformAuditLog.action, "res": PlatformAuditLog.entity_type}
TEXT_COLUMNS = ("u", "a", "ip", "r", "tenant", "action", "res")


class AuditQueryError(ValueError):
    pass


def _like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _day(value: str, end: bool) -> datetime:
    try:
        d = date.fromisoformat(value.strip()[:10])
    except ValueError:
        raise AuditQueryError(f"“{value}” is not a date (use YYYY-MM-DD)")
    return datetime.combine(d, time.max if end else time.min)


def _condition(k: str, op: str, v: str):
    """One grid filter condition (BwGrid's operators) as SQL. Values are bound parameters."""
    col = COLUMNS.get(k)
    if col is None:
        raise AuditQueryError(f"Unknown column {k}")
    v = (v or "").strip()
    if k == "t":
        if op in ("before", "lt"):
            return col < _day(v, False)
        if op in ("after", "gt"):
            return col > _day(v, True)
        if op == "gte":
            return col >= _day(v, False)
        if op == "lte":
            return col <= _day(v, True)
        if op in ("eq", "contains", "starts"):
            return and_(col >= _day(v, False), col <= _day(v, True))
        if op in ("empty", "nempty"):
            return literal(op == "nempty")
        raise AuditQueryError("Use before, after, at least, at most or equals for When")
    lowered, text_col = v.lower(), func.lower(func.coalesce(col, ""))
    if op == "contains":
        return text_col.like(f"%{_like(lowered)}%", escape="\\")
    if op == "ncontains":
        return not_(text_col.like(f"%{_like(lowered)}%", escape="\\"))
    if op == "starts":
        return text_col.like(f"{_like(lowered)}%", escape="\\")
    if op == "eq":
        return text_col == lowered
    if op == "ne":
        return text_col != lowered
    if op == "empty":
        return func.coalesce(col, "") == ""
    if op == "nempty":
        return func.coalesce(col, "") != ""
    raise AuditQueryError(f"The operator {op} doesn't apply to text columns")


def _filtered(db: Session, allowed: Optional[list[int]], q: str = "", quick: Optional[dict] = None, conds: Optional[list[dict]] = None,
              logic: str = "AND", tenant_id: Optional[int] = None, date_from: Optional[str] = None, date_to: Optional[str] = None):
    query = db.query(PlatformAuditLog.id).outerjoin(SuperAdmin, PlatformAuditLog.super_admin_id == SuperAdmin.id)
    if allowed is not None:   # tenant-scoped staff: entries about their tenants only
        query = query.filter(PlatformAuditLog.entity_type == "tenant", PlatformAuditLog.entity_id.in_(allowed or [0]))
    if tenant_id is not None:
        query = query.filter(PlatformAuditLog.entity_type == "tenant", PlatformAuditLog.entity_id == tenant_id)
    if date_from:
        query = query.filter(PlatformAuditLog.created_at >= _day(date_from, False))
    if date_to:
        query = query.filter(PlatformAuditLog.created_at <= _day(date_to, True))
    if q.strip():
        term = f"%{_like(q.strip().lower())}%"
        query = query.filter(or_(*[func.lower(func.coalesce(COLUMNS[k], "")).like(term, escape="\\") for k in ("u", "a", "ip", "r", "action", "tenant")],
                                 func.lower(func.coalesce(PlatformAuditLog.entity_name, "")).like(term, escape="\\")))
    for k, v in (quick or {}).items():
        if v and v.strip():
            query = query.filter(_condition(k, "eq" if k == "t" else "contains", v))
    parts = [_condition(c["k"], c.get("op", "contains"), c.get("v", "")) for c in (conds or []) if c.get("k")]
    if parts:
        query = query.filter(and_(*parts) if logic.upper() != "OR" else or_(*parts))
    return query


def _rows(filtered, sort: Optional[list[list]], offset: int, limit: int):
    """Select only the displayed columns for one page, joined to the actor in the same query."""
    order = []
    for key, direction in (sort or []):
        col = COLUMNS.get(key)
        if col is None:
            raise AuditQueryError(f"Can't sort by {key}")
        order.append(col.desc() if int(direction) < 0 else col.asc())
    order += [PlatformAuditLog.created_at.desc(), PlatformAuditLog.id.desc()]
    # Same joins and filters as the count; only the displayed columns are selected.
    return (filtered.with_entities(PlatformAuditLog.id, PlatformAuditLog.created_at, _actor.label("actor"), _event.label("event"), PlatformAuditLog.action,
                                   PlatformAuditLog.ip_address, PlatformAuditLog.entity_type, PlatformAuditLog.entity_id, PlatformAuditLog.entity_name,
                                   SuperAdmin.username)
            .order_by(*order).offset(offset).limit(limit).all())


def _offset() -> str:
    """The database stamps entries with its own local time (NOW()); its UTC offset, read once, e.g. "+05:30"."""
    if "offset" not in _ready:
        with master_engine.connect() as conn:
            minutes = int(conn.execute(text("SELECT TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW())")).scalar() or 0)
        minutes = int(round(minutes / 15) * 15)
        _ready["offset"] = f"{'+' if minutes >= 0 else '-'}{abs(minutes) // 60:02d}:{abs(minutes) % 60:02d}"
    return _ready["offset"]


def _at(value: Optional[datetime]) -> Optional[str]:
    return f"{value.replace(microsecond=0).isoformat()}{_offset()}" if value else None


def _item(r) -> dict:
    return {"id": r.id, "at": _at(r.created_at), "actor": r.actor, "actor_username": r.username,
            "event": r.event, "action": r.action, "ip": r.ip_address, "result": outcome_of(r.action),
            "tenant": r.entity_name if r.entity_type == "tenant" else None, "tenant_id": r.entity_id if r.entity_type == "tenant" else None,
            "resource_type": r.entity_type, "resource": r.entity_name}


def page(db: Session, allowed: Optional[list[int]], *, offset: int, limit: int, sort=None, **filters) -> dict:
    ensure_schema()
    ids = _filtered(db, allowed, **filters)
    total = ids.order_by(None).count()
    rows = _rows(ids, sort, offset, limit)
    return {"items": [_item(r) for r in rows], "total": total, "offset": offset, "limit": limit}


def detail(db: Session, allowed: Optional[list[int]], entry_id: int) -> Optional[dict]:
    ensure_schema()
    q = db.query(PlatformAuditLog, SuperAdmin.full_name, SuperAdmin.username, SuperAdmin.email) \
        .outerjoin(SuperAdmin, PlatformAuditLog.super_admin_id == SuperAdmin.id).filter(PlatformAuditLog.id == entry_id)
    if allowed is not None:
        q = q.filter(PlatformAuditLog.entity_type == "tenant", PlatformAuditLog.entity_id.in_(allowed or [0]))
    row = q.first()
    if row is None:
        return None
    log, name, username, email = row
    actor = name or username or (f"Deleted account #{log.super_admin_id}" if log.super_admin_id else "System")
    return {"id": log.id, "at": _at(log.created_at), "actor": actor,
            "actor_username": username, "actor_email": email, "action": log.action, "event": log.description or log.action,
            "result": outcome_of(log.action), "resource_type": log.entity_type, "resource_id": log.entity_id, "resource": log.entity_name,
            "tenant": log.entity_name if log.entity_type == "tenant" else None, "ip": log.ip_address,
            "old_data": redact(log.old_data), "new_data": redact(log.new_data)}


def export_csv(db: Session, allowed: Optional[list[int]], sort=None, **filters) -> tuple[str, int, str]:
    """CSV of every entry matching the filters (up to EXPORT_LIMIT), and its HMAC-SHA256 signature."""
    ensure_schema()
    ids = _filtered(db, allowed, **filters)
    total = ids.order_by(None).count()
    if total > EXPORT_LIMIT:
        raise AuditQueryError(f"{total} entries match – narrow the filters to at most {EXPORT_LIMIT:,} to export")
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow([f"When (UTC{_offset()})", "Actor", "Actor username", "Event", "Action", "Tenant", "Resource type", "Resource", "IP address", "Result"])
    for r in _rows(ids, sort, 0, max(total, 1)):
        i = _item(r)
        w.writerow([i["at"], i["actor"], i["actor_username"] or "", _safe_cell(i["event"]), i["action"], i["tenant"] or "",
                    i["resource_type"] or "", _safe_cell(i["resource"] or ""), i["ip"] or "", i["result"]])
    body = out.getvalue()
    return body, total, sign(body)


def _safe_cell(value: str) -> str:
    """Stop spreadsheet formula injection from recorded text."""
    return "'" + value if value[:1] in ("=", "+", "-", "@") else value


def sign(body: str) -> str:
    return hmac.new(settings.SECRET_KEY.encode(), body.encode("utf-8"), hashlib.sha256).hexdigest()


def verify(body: str, signature: str) -> bool:
    return hmac.compare_digest(sign(body), signature or "")
