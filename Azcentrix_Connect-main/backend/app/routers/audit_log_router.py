"""Read-only audit history from the authenticated tenant's database."""
import json
import re
from datetime import date, datetime, time

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import String, and_, cast, func, not_, or_
from sqlalchemy.orm import Session

from app.core.logging import log_module_action
from app.dependencies import get_current_user, get_request_ip, get_tenant_db, require_permission
from app.models.all_models import AuditLog, Module, User

router = APIRouter(tags=["Audit Logs"])

_QUOTED_NAME = re.compile(r"'([^']+)'")

# The full set of action types the Audit Logs Action filter should always offer,
# regardless of whether any module has produced a row for them yet — same idea
# as the Module filter listing every module, not just ones with existing rows.
ACTION_TAXONOMY = [
    "create", "update", "delete", "restore", "permanent_delete",
    "assign", "reassign", "status_change", "activate", "deactivate",
    "approve", "reject", "submit_for_approval", "import", "export",
    "upload", "download", "merge", "convert",
    "workflow_create", "workflow_update", "workflow_enable", "workflow_disable",
    "configuration_change", "permission_change", "role_change",
    "integration_change", "bulk_update", "bulk_delete",
]


# Actions a client can legitimately self-report, since they happen entirely in
# the browser with no corresponding server mutation to log (e.g. generating a
# CSV/Excel/PDF from data already on screen). Anything that changes real data
# must still go through its own endpoint's own log_module_action call — this
# is not a general-purpose "log anything" backdoor.
CLIENT_REPORTABLE_ACTIONS = {"export", "import", "download", "upload"}


class ClientAuditEvent(BaseModel):
    module: str = Field(..., max_length=100)
    action: str = Field(..., max_length=100)
    record_name: str | None = Field(None, max_length=255)
    description: str | None = Field(None, max_length=500)


@router.post("/client-event", status_code=204)
def log_client_audit_event(
    payload: ClientAuditEvent,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Record a client-only action (e.g. a browser-generated export) that never
    reaches a server mutation endpoint, so it still shows up in the Audit Log."""
    if payload.action not in CLIENT_REPORTABLE_ACTIONS:
        raise HTTPException(422, f"action must be one of {sorted(CLIENT_REPORTABLE_ACTIONS)}")
    description = payload.description or f"{payload.action.capitalize()}ed {payload.record_name or payload.module}"
    log_module_action(
        db=db, user_id=current_user.id, module=payload.module, action=payload.action,
        record_id=None, record_name=payload.record_name,
        ip=get_request_ip(request), description=description,
    )
    db.commit()


def _record_name(row: AuditLog) -> str | None:
    """Prefer the stored record_name; fall back to whatever older rows (written
    before that column existed) already carry: a quoted name in the description
    (e.g. "Customer 'Acme Corp' updated"), or a "title" in old_data (recycle-bin
    restore/permanent-delete rows). Session actions (login/logout) have no
    separate record — record_id there is just the user's own id, not a distinct
    entity — so they're intentionally left blank rather than repeating the user's
    name under a different column."""
    if row.record_name:
        return row.record_name
    if row.description and (match := _QUOTED_NAME.search(row.description)):
        return match.group(1)
    if isinstance(row.old_data, dict) and row.old_data.get("title"):
        return row.old_data["title"]
    return None


def _like(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


# Grid columns (shared BwGrid: sort, quick filters, advanced filter) → SQL expressions
def _grid_columns():
    return {
        "created_at": AuditLog.created_at, "user": func.coalesce(User.full_name, ""), "module": AuditLog.module, "action": AuditLog.action,
        "record_name": func.coalesce(AuditLog.record_name, cast(AuditLog.record_id, String), ""), "ip_address": func.coalesce(AuditLog.ip_address, ""),
    }


def _text_cond(col, op: str, v: str):
    t, lv = _like(v), v.lower()
    low = func.lower(col)
    return {
        "contains": low.like(f"%{t.lower()}%", escape="\\"), "ncontains": not_(low.like(f"%{t.lower()}%", escape="\\")),
        "eq": low == lv, "ne": low != lv, "starts": low.like(f"{t.lower()}%", escape="\\"),
        "empty": col == "", "nempty": col != "",
    }.get(op)


def _date_cond(op: str, v: str):
    try:
        d = date.fromisoformat(v[:10])
    except ValueError:
        return None
    lo, hi = datetime.combine(d, time.min), datetime.combine(d, time.max)
    col = AuditLog.created_at
    return {"before": col < lo, "after": col > hi, "eq": and_(col >= lo, col <= hi), "lt": col < lo, "gt": col > hi,
            "lte": col <= hi, "gte": col >= lo, "contains": and_(col >= lo, col <= hi)}.get(op)


@router.get("")
def list_audit_logs(
    search: str = Query("", max_length=200),
    module: str = Query("", max_length=100),
    action: str = Query("", max_length=100),
    user_id: int | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=250),
    offset: int | None = Query(None, ge=0),
    sorts: str = Query("", max_length=1000),
    f: str = Query("", max_length=2000),
    adv: str = Query("", max_length=4000),
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("audit_logs.view")),
):
    if date_from and date_to and date_from > date_to:
        raise HTTPException(422, "Start date must be before end date")
    query = db.query(AuditLog, User.full_name).outerjoin(User, User.id == AuditLog.user_id)
    if module:
        query = query.filter(AuditLog.module == module)
    if action:
        query = query.filter(AuditLog.action == action)
    if user_id:
        query = query.filter(AuditLog.user_id == user_id)
    if date_from:
        query = query.filter(AuditLog.created_at >= datetime.combine(date_from, time.min))
    if date_to:
        query = query.filter(AuditLog.created_at <= datetime.combine(date_to, time.max))
    if search.strip():
        term = search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        query = query.filter(or_(*[
            field.ilike(f"%{term}%", escape="\\")
            for field in (AuditLog.description, User.full_name, AuditLog.module,
                          AuditLog.action, AuditLog.record_name, cast(AuditLog.record_id, String))
        ]))
    # shared grid: per-column quick filters (f), advanced filter (adv) and column sorting (sorts)
    try:
        # Direct service calls in tests and internal code don't pass through
        # FastAPI's dependency/default resolution, so Query objects can arrive
        # here instead of the declared string defaults.
        quick = json.loads(f) if isinstance(f, str) and f else {}
        advf = json.loads(adv) if isinstance(adv, str) and adv else {}
        order = json.loads(sorts) if isinstance(sorts, str) and sorts else []
    except ValueError:
        raise HTTPException(422, "Invalid filter or sort")
    cols = _grid_columns()
    for k, v in (quick if isinstance(quick, dict) else {}).items():
        v = str(v or "").strip()
        if not v or k not in cols:
            continue
        if k == "created_at":
            cond = _date_cond("contains", v)
            if cond is not None:
                query = query.filter(cond)
            else:
                query = query.filter(cast(AuditLog.created_at, String).like(f"%{_like(v)}%", escape="\\"))
        else:
            query = query.filter(_text_cond(cols[k], "contains", v))
    conds = []
    for c in (advf.get("conds") or []) if isinstance(advf, dict) else []:
        if not isinstance(c, dict) or c.get("k") not in cols:
            continue
        op, v = str(c.get("op") or "contains"), str(c.get("v") or "")
        cond = _date_cond(op, v) if c["k"] == "created_at" else _text_cond(cols[c["k"]], op, v)
        if cond is not None:
            conds.append(cond)
    if conds:
        query = query.filter(or_(*conds) if advf.get("logic") == "OR" else and_(*conds))
    total = query.count()
    ordering = []
    for item in order if isinstance(order, list) else []:
        if isinstance(item, (list, tuple)) and len(item) == 2 and item[0] in cols:
            ordering.append(cols[item[0]].desc() if item[1] == -1 else cols[item[0]].asc())
    ordering += [AuditLog.created_at.desc(), AuditLog.id.desc()]
    # Ignore FastAPI parameter descriptors when this handler is called as a
    # plain function (for example, from unit tests).
    offset = offset if isinstance(offset, int) and offset >= 0 else None
    page = page if isinstance(page, int) and page >= 1 else 1
    page_size = page_size if isinstance(page_size, int) and page_size >= 1 else 50
    start = offset if offset is not None else (page - 1) * page_size
    rows = query.order_by(*ordering).offset(start).limit(page_size).all()

    # Every module in the app (not just the ones that already have audit rows), plus
    # any module value seen in the audit trail that isn't a sidebar module (e.g. "auth").
    module_labels = {m.key: (m.label or m.key) for m in db.query(Module).filter(Module.is_active.is_(True)).all()}
    for key in [r[0] for r in db.query(AuditLog.module).distinct().all()]:
        module_labels.setdefault(key, key.replace("_", " ").title())

    return {
        "items": [{
            "id": row.id, "user_id": row.user_id, "user_name": name,
            "module": row.module, "action": row.action, "record_id": row.record_id,
            "record_name": _record_name(row),
            "description": row.description, "ip_address": row.ip_address,
            "old_data": row.old_data, "new_data": row.new_data,
            "created_at": row.created_at.isoformat() if row.created_at else None,
        } for row, name in rows],
        "total": total, "page": page, "page_size": page_size,
        "modules": [{"key": key, "label": label} for key, label in sorted(module_labels.items(), key=lambda kv: kv[1].lower())],
        "actions": sorted(set(ACTION_TAXONOMY) | {r[0] for r in db.query(AuditLog.action).distinct().all()}),
        "users": [{"id": uid, "name": name} for uid, name in db.query(AuditLog.user_id, User.full_name)
                  .join(User, User.id == AuditLog.user_id).filter(AuditLog.user_id.isnot(None))
                  .distinct().order_by(User.full_name).all()],
    }
