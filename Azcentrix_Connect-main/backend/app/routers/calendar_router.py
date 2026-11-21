"""Calendar & Tasks API (prototype v17 → Application → Calendar & Tasks).  Mounted at /api/v1/calendar.

Access follows the calendar.* permissions; every event source additionally applies its own module's view
permission and Data Visibility (see app.services.calendar_service).
"""
from __future__ import annotations

import json
import logging
from datetime import date, timedelta
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import and_, case, func, not_, or_
from sqlalchemy.orm import Session, aliased

from app.core.logging import log_audit_db
from app.core.timezone import now_ist, today_ist
from app.core.validators import check_date_range, check_text
from app.dependencies import get_current_user, get_request_ip, get_tenant_db, user_has_permission
from app.models.all_models import User
from app.models.calendar_tasks import TASK_PRIORITIES, TASK_STATUSES, CalendarConnection, CalendarSyncItem, CrmTask
from app.services import calendar_service as svc
from app.services.cache_service import invalidate_badges_cache, invalidate_notifications_cache

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Calendar & Tasks"])

COLUMNS = ("title", "related", "assignee", "priority", "due", "status")


# ─── Dependencies & helpers ───────────────────────────────────────────────────

def calendar_user(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if not user_has_permission(db, cu, "calendar.view"):
        raise HTTPException(403, "You don't have access to Calendar & Tasks")
    svc.ensure_calendar_schema(db)
    return cu


def _perm(db: Session, cu: User, action: str) -> None:
    if not user_has_permission(db, cu, f"calendar.{action}"):
        raise HTTPException(403, f"You don't have permission to {'create' if action == 'create' else 'change' if action == 'update' else 'delete'} tasks")


def _task(db: Session, cu: User, task_id: int) -> CrmTask:
    t = svc.visible_tasks(db, cu).filter(CrmTask.id == task_id).first()
    if not t:
        raise HTTPException(404, "Task not found")
    return t


def _out(db: Session, cu: User, tasks: list[CrmTask]) -> list[dict[str, Any]]:
    names = svc.user_names(db, [x for t in tasks for x in (t.assignee_id, t.created_by)])
    upd = user_has_permission(db, cu, "calendar.update")
    from app.utils.data_scope import get_module_data_scope
    wide = get_module_data_scope(db, cu, "calendar") in ("team", "all")
    dele = user_has_permission(db, cu, "calendar.delete")
    return [svc.task_dict(t, names, can_edit=upd, can_delete=dele and (wide or t.created_by == cu.id)) for t in tasks]


def _snap(t: CrmTask) -> dict[str, Any]:
    return {"title": t.title, "related": t.related_label, "assignee_id": t.assignee_id, "priority": t.priority,
            "due": t.due_date.isoformat() if t.due_date else None, "status": t.status}


def _audit(db: Session, request: Request, cu: User, action: str, t: CrmTask, description: str, old: Optional[dict] = None) -> None:
    log_audit_db(db, cu.id, "calendar", action, t.id, get_request_ip(request), description,
                 old_data=old, new_data=_snap(t) if action != "delete" else None, record_name=t.title[:200])


def _notify_assignee(db: Session, cu: User, t: CrmTask) -> None:
    if not t.assignee_id or t.assignee_id == cu.id:
        return
    try:
        from app.services.notification_service import upsert_notification
        due = t.due_date.strftime("%d %b") if t.due_date else ""
        rel = f" · {t.related_label}" if t.related_label else ""
        upsert_notification(db, t.assignee_id, "Task assigned", f"{cu.full_name} assigned you a task: {t.title} – due {due}{rel}",
                            module="calendar", record_id=t.id, action="task_assigned")
        invalidate_notifications_cache(db, t.assignee_id)
    except Exception as exc:  # a notification problem must not undo the task change
        logger.warning("Task assignment notification failed: %s", exc)


def _set_status(t: CrmTask, status: str) -> None:
    if t.status != status:
        t.status = status
        t.completed_at = now_ist() if status == "Done" else None


# ─── Meta (one call for the page: filters, people, permissions, sync status) ──

@router.get("/meta")
def meta(db: Session = Depends(get_tenant_db), cu: User = Depends(calendar_user)):
    return {
        "event_types": [{"key": k, "label": l} for k, l in svc.EVENT_TYPES],
        "statuses": list(TASK_STATUSES), "priorities": list(TASK_PRIORITIES), "today": today_ist().isoformat(),
        "people": [{"id": u.id, "name": u.full_name} for u in db.query(User.id, User.full_name).filter(User.is_active == True).order_by(User.full_name).all()],
        "me": {"id": cu.id, "name": cu.full_name},
        "can": {"create": user_has_permission(db, cu, "calendar.create"), "update": user_has_permission(db, cu, "calendar.update"),
                "delete": user_has_permission(db, cu, "calendar.delete")},
        "sync": svc.sync_status(db, cu),
    }


# ─── Calendar events ──────────────────────────────────────────────────────────

@router.get("/events")
def events(start: date, end: date, types: str = "", db: Session = Depends(get_tenant_db), cu: User = Depends(calendar_user)):
    if end < start or (end - start).days > 62:
        raise HTTPException(422, "Choose a range of at most 62 days")
    wanted = [t for t in types.split(",") if t] if types else None
    items = svc.collect_events(db, cu, start, end, wanted)
    return {"start": start.isoformat(), "end": end.isoformat(), "items": items}


# ─── Tasks: list / board ──────────────────────────────────────────────────────

_PRIO_ORDER = case((CrmTask.priority == "High", 0), (CrmTask.priority == "Medium", 1), else_=2)
_STATUS_ORDER = case((CrmTask.status == "To do", 0), (CrmTask.status == "In progress", 1), else_=2)


def _cols(assignee):
    return {"title": CrmTask.title, "related": func.coalesce(CrmTask.related_label, ""), "assignee": func.coalesce(assignee.full_name, ""),
            "priority": CrmTask.priority, "due": CrmTask.due_date, "status": CrmTask.status}


def _cond(col, k: str, op: str, v: str):
    """One prototype filter condition (OPS) as SQL."""
    v = (v or "").strip()
    if k == "due":
        if op in ("empty",):
            return col.is_(None)
        if op in ("nempty",):
            return col.isnot(None)
        try:
            d = date.fromisoformat(v[:10])
        except ValueError:
            raise HTTPException(422, "Use a date like 2026-11-30 for Due filters")
        return {"eq": col == d, "ne": col != d, "before": col < d, "lt": col < d, "after": col > d, "gt": col > d,
                "gte": col >= d, "lte": col <= d, "contains": col == d, "starts": col == d, "ncontains": col != d}.get(op, col == d)
    low = func.lower(col)
    lv = v.lower()
    esc = lv.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    like = "%" + esc + "%"
    return {
        "contains": low.like(like), "ncontains": not_(low.like(like)), "eq": low == lv, "ne": low != lv,
        "starts": low.like(esc + "%"), "gt": col > v, "lt": col < v, "gte": col >= v, "lte": col <= v,
        "before": col < v, "after": col > v, "empty": or_(col.is_(None), col == ""), "nempty": and_(col.isnot(None), col != ""),
    }.get(op, low.like(like))


@router.get("/tasks")
def list_tasks(
    q: str = "", status: str = "", priority: str = "", assignee_id: Optional[int] = None, mine: bool = False,
    f: str = Query("", description='quick filters, JSON {"title": "…", "status": "…"}'),
    adv: str = Query("", description='advanced filter, JSON {"logic": "AND", "conds": [{"k","op","v"}]}'),
    sorts: str = Query("", description='JSON [["due", 1], ["priority", -1]]'),
    offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=250),
    db: Session = Depends(get_tenant_db), cu: User = Depends(calendar_user),
):
    A = aliased(User)
    cols = _cols(A)
    base = svc.visible_tasks(db, cu).outerjoin(A, A.id == CrmTask.assignee_id)
    total_all = base.count()
    query = base
    if q.strip():
        like = "%" + q.strip().lower().replace("%", "\\%").replace("_", "\\_") + "%"
        query = query.filter(or_(func.lower(CrmTask.title).like(like), func.lower(func.coalesce(CrmTask.related_label, "")).like(like),
                                 func.lower(func.coalesce(A.full_name, "")).like(like), func.lower(CrmTask.status).like(like),
                                 func.lower(CrmTask.priority).like(like)))
    if status:
        query = query.filter(CrmTask.status.in_([s for s in status.split(",") if s]))
    if priority:
        query = query.filter(CrmTask.priority.in_([p for p in priority.split(",") if p]))
    if assignee_id:
        query = query.filter(CrmTask.assignee_id == assignee_id)
    if mine:
        query = query.filter(CrmTask.assignee_id == cu.id)
    try:
        quick = json.loads(f) if f else {}
        advf = json.loads(adv) if adv else {}
        order = json.loads(sorts) if sorts else []
    except ValueError:
        raise HTTPException(422, "Invalid filter or sort")
    for k, v in (quick or {}).items():
        if k in cols and str(v or "").strip():
            query = query.filter(_cond(cols[k], k, "contains", str(v)))
    conds = [c for c in (advf.get("conds") or []) if isinstance(c, dict) and c.get("k") in cols]
    if conds:
        parts = [_cond(cols[c["k"]], c["k"], str(c.get("op") or "contains"), str(c.get("v") or "")) for c in conds]
        query = query.filter(or_(*parts) if advf.get("logic") == "OR" else and_(*parts))
    total = query.count()
    order_by = []
    for item in order or []:
        if isinstance(item, (list, tuple)) and len(item) == 2 and item[0] in cols:
            expr = {"priority": _PRIO_ORDER, "status": _STATUS_ORDER}.get(item[0], cols[item[0]])
            order_by.append(expr.desc() if int(item[1]) < 0 else expr.asc())
    order_by = order_by or [_STATUS_ORDER.asc(), CrmTask.due_date.asc()]
    rows = query.order_by(*order_by, CrmTask.id.desc()).offset(offset).limit(limit).all()
    return {"items": _out(db, cu, rows), "total": total, "total_all": total_all, "offset": offset, "limit": limit}


BOARD_LIMIT = 200


@router.get("/tasks/board")
def board(db: Session = Depends(get_tenant_db), cu: User = Depends(calendar_user)):
    base = svc.visible_tasks(db, cu)
    counts = dict(base.with_entities(CrmTask.status, func.count(CrmTask.id)).group_by(CrmTask.status).all())
    cols = []
    for s in TASK_STATUSES:
        q = base.filter(CrmTask.status == s)
        q = q.order_by(CrmTask.completed_at.desc(), CrmTask.id.desc()) if s == "Done" else q.order_by(CrmTask.due_date.asc(), _PRIO_ORDER.asc(), CrmTask.id.asc())
        cols.append({"status": s, "count": int(counts.get(s, 0)), "items": _out(db, cu, q.limit(BOARD_LIMIT).all())})
    return {"columns": cols, "limit": BOARD_LIMIT}


@router.get("/tasks/{task_id}")
def get_task(task_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(calendar_user)):
    return _out(db, cu, [_task(db, cu, task_id)])[0]


# ─── Tasks: create / edit / status / delete ───────────────────────────────────

class TaskIn(BaseModel):
    title: str = Field(..., max_length=300)
    due: date
    priority: Literal["High", "Medium", "Low"] = "Medium"
    status: Literal["To do", "In progress", "Done"] = "To do"
    assignee_id: Optional[int] = None
    related_module: Optional[str] = None
    related_id: Optional[int] = None

    @field_validator("title")
    @classmethod
    def _title(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("Enter a task title")
        return check_text(v, "Task title", 2, 300, required=True)

    @field_validator("due")
    @classmethod
    def _due(cls, v: date) -> date:
        return check_date_range(v, "Due date")


class StatusIn(BaseModel):
    status: Literal["To do", "In progress", "Done"]


class BulkIn(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=500)
    action: Literal["status", "delete"]
    status: Optional[Literal["To do", "In progress", "Done"]] = None


def _apply(db: Session, cu: User, t: CrmTask, body: TaskIn) -> None:
    if body.assignee_id:
        ok = db.query(User.id).filter(User.id == body.assignee_id, User.is_active == True).first()
        if not ok:
            raise HTTPException(422, "Choose an active user as assignee")
    rel_changed = (body.related_module, body.related_id) != (t.related_module, t.related_id)
    if body.related_module and body.related_id:
        if rel_changed:
            rec = svc.resolve_related(db, cu, body.related_module, body.related_id)
            if not rec:
                raise HTTPException(422, "The related record was not found or you can't access it")
            t.related_module, t.related_id, t.related_label = rec["module"], rec["id"], rec["label"][:300]
    else:
        t.related_module = t.related_id = t.related_label = None
    t.title = body.title
    t.due_date = body.due
    t.priority = body.priority
    t.assignee_id = body.assignee_id
    _set_status(t, body.status)


@router.post("/tasks", status_code=201)
def create_task(body: TaskIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(calendar_user)):
    _perm(db, cu, "create")
    t = CrmTask(created_by=cu.id, source="manual", status="To do")
    if body.assignee_id is None:
        body.assignee_id = cu.id
    _apply(db, cu, t, body)
    db.add(t)
    db.flush()
    _audit(db, request, cu, "create", t, f"Created task '{t.title}'")
    _notify_assignee(db, cu, t)
    db.commit()
    invalidate_badges_cache(db)
    return _out(db, cu, [t])[0]


@router.put("/tasks/{task_id}")
def update_task(task_id: int, body: TaskIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(calendar_user)):
    _perm(db, cu, "update")
    t = _task(db, cu, task_id)
    old, old_assignee = _snap(t), t.assignee_id
    _apply(db, cu, t, body)
    _audit(db, request, cu, "update", t, f"Updated task '{t.title}'", old)
    if t.assignee_id != old_assignee:
        _notify_assignee(db, cu, t)
    db.commit()
    return _out(db, cu, [t])[0]


@router.patch("/tasks/{task_id}/status")
def change_status(task_id: int, body: StatusIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(calendar_user)):
    _perm(db, cu, "update")
    t = _task(db, cu, task_id)
    old = _snap(t)
    if t.status != body.status:
        _set_status(t, body.status)
        _audit(db, request, cu, "status_change", t, f"Task '{t.title}': {old['status']} → {t.status}", old)
        db.commit()
    return _out(db, cu, [t])[0]


@router.delete("/tasks/{task_id}")
def delete_task(task_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(calendar_user)):
    _perm(db, cu, "delete")
    t = _task(db, cu, task_id)
    if not svc.can_delete_task(db, cu, t):
        raise HTTPException(403, "Only the person who created this task can delete it")
    old = _snap(t)
    _audit(db, request, cu, "delete", t, f"Deleted task '{t.title}'", old)
    db.delete(t)
    db.commit()
    return {"ok": True, "id": task_id}


@router.post("/tasks/bulk")
def bulk(body: BulkIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(calendar_user)):
    _perm(db, cu, "update" if body.action == "status" else "delete")
    if body.action == "status" and not body.status:
        raise HTTPException(422, "Choose a status")
    tasks = svc.visible_tasks(db, cu).filter(CrmTask.id.in_(body.ids)).all()
    done, skipped = 0, 0
    for t in tasks:
        old = _snap(t)
        if body.action == "status":
            if t.status != body.status:
                _set_status(t, body.status)
                _audit(db, request, cu, "status_change", t, f"Task '{t.title}': {old['status']} → {t.status} (bulk)", old)
            done += 1
        elif svc.can_delete_task(db, cu, t):
            _audit(db, request, cu, "delete", t, f"Deleted task '{t.title}' (bulk)", old)
            db.delete(t)
            done += 1
        else:
            skipped += 1
    db.commit()
    return {"ok": True, "done": done, "skipped": skipped + (len(set(body.ids)) - len(tasks))}


# ─── Related records ──────────────────────────────────────────────────────────

@router.get("/related")
def related(q: str = "", db: Session = Depends(get_tenant_db), cu: User = Depends(calendar_user)):
    return {"items": svc.search_related(db, cu, q)}


# ─── Google Calendar sync ─────────────────────────────────────────────────────

class SyncIn(BaseModel):
    return_origin: Optional[str] = None


@router.get("/sync/status")
def sync_status(db: Session = Depends(get_tenant_db), cu: User = Depends(calendar_user)):
    return svc.sync_status(db, cu)


@router.post("/sync")
def sync_now(body: SyncIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(calendar_user)):
    """Run a sync.  Not connected yet → returns the Google consent URL (status needs_auth)."""
    if not svc.google_configured():
        raise HTTPException(409, "Google Calendar sync is not configured for this workspace. Ask your administrator to add the Google OAuth client (GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET).")
    conn = db.query(CalendarConnection).filter_by(user_id=cu.id, provider="google").first()
    slug = db.info.get("tenant_slug") or request.headers.get("X-Tenant-Slug") or ""
    origin = svc.allowed_return_origin(body.return_origin or request.headers.get("origin"))
    if not conn or not conn.token_blob or conn.status == "auth_failed":
        return {"status": "needs_auth", "auth_url": svc.auth_url(svc.make_state(slug, cu.id, origin)),
                "message": "Connect your Google account to sync" if not conn else "Google access expired – reconnect to sync"}
    try:
        result = svc.run_google_sync(db, cu, conn)
    except svc.SyncError as exc:
        log_audit_db(db, cu.id, "calendar", "sync_failed", conn.id, get_request_ip(request), str(exc)[:500])
        if exc.status == "auth_failed":
            return {"status": "needs_auth", "auth_url": svc.auth_url(svc.make_state(slug, cu.id, origin)), "message": str(exc),
                    "sync": svc.sync_status(db, cu)}
        raise HTTPException(exc.http_status, str(exc))
    c = result["counts"]
    log_audit_db(db, cu.id, "calendar", "sync", conn.id, get_request_ip(request),
                 f"Google Calendar sync: {c['created']} created, {c['updated']} updated, {c['deleted']} removed, {c['unchanged']} unchanged, {c['failed']} failed")
    return {"status": "partial" if c["failed"] else "ok", **result, "sync": svc.sync_status(db, cu)}


@router.get("/sync/google/callback", include_in_schema=False)
def google_callback(state: str = "", code: str = "", error: str = ""):
    """OAuth redirect target (opened by the browser, so there is no bearer token – the signed state carries tenant and user)."""
    try:
        data = svc.read_state(state)
    except svc.SyncError:
        return RedirectResponse(f"{svc.allowed_return_origin(None)}/calendar?gcal=invalid", status_code=302)
    back = f"{data['o']}/calendar"
    if error or not code:
        return RedirectResponse(f"{back}?gcal=denied", status_code=302)
    from app.database import get_tenant_session
    db = get_tenant_session(data["t"])
    try:
        db.info["tenant_slug"] = data["t"]
        svc.ensure_calendar_schema(db)
        user = db.query(User).filter(User.id == int(data["u"]), User.is_active == True).first()
        if not user:
            return RedirectResponse(f"{back}?gcal=invalid", status_code=302)
        tokens = svc.exchange_code(code)
        conn = svc.save_connection(db, user.id, tokens)
        log_audit_db(db, user.id, "calendar", "sync_connect", conn.id, "oauth-callback", f"Connected Google Calendar {conn.account_email or ''}".strip())
        db.commit()
        return RedirectResponse(f"{back}?gcal=connected", status_code=302)
    except svc.SyncError as exc:
        db.rollback()
        logger.warning("Google Calendar connect failed: %s", exc)
        return RedirectResponse(f"{back}?gcal=failed", status_code=302)
    finally:
        db.close()


@router.delete("/sync/google")
def disconnect(request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(calendar_user)):
    conn = db.query(CalendarConnection).filter_by(user_id=cu.id, provider="google").first()
    if not conn:
        return {"ok": True}
    svc.revoke(conn)
    db.query(CalendarSyncItem).filter_by(connection_id=conn.id).delete()
    db.delete(conn)
    log_audit_db(db, cu.id, "calendar", "sync_disconnect", None, get_request_ip(request), "Disconnected Google Calendar")
    db.commit()
    return {"ok": True}
