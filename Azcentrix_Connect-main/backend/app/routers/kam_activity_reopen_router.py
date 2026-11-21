"""
KAM activity audit / GPS-history / manager-reopen workflow.

Kept in its own file, separate from kam_router.py (which already covers
activity CRUD plus targets, 360-summary, team-360, weekly-plan, etc.) so this
workflow's endpoints don't add more length to that file. Mounted with the
same "/api/v1/kam" prefix in main.py, so URLs read as a natural extension of
the existing activity routes:

  POST /api/v1/kam/activities/{activity_id}/complete
  POST /api/v1/kam/activities/{activity_id}/reopen
  GET  /api/v1/kam/activities/{activity_id}/logs
  GET  /api/v1/kam/activities/{activity_id}/cycles

Reuses kam_router.py's ownership/visibility helper (_get_visible_uids) and
response-shaping helper (_enrich_activity) rather than duplicating them —
this file imports from kam_router.py, never the other way round, so there's
no circular import between the two router modules.

Location and event history live together in one table (kam_log) — there is
no separate "location history" endpoint; each /logs row already carries its
own latitude/longitude (or null + permission_status if no fix was captured).
"""
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from pydantic import BaseModel, field_validator

from app.dependencies import get_tenant_db, get_current_user
from app.models.all_models import KAMActivity, KAMLog, KAMActivityExecutionCycle, User
from app.services.kam_activity_audit_service import complete_activity_cycle, reopen_activity_cycle
from app.routers.kam_router import _get_visible_uids, _enrich_activity, _reopen_hierarchy_scope_uids, _user_can_reopen_activities

router = APIRouter()


# --- Schemas -------------------------------------------------------------------

class ActivityCompleteIn(BaseModel):
    outcome: Optional[str] = None
    notes: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    accuracy_meters: Optional[float] = None
    permission_status: Optional[str] = None
    client_event_at: Optional[str] = None
    device_id: Optional[str] = None
    idempotency_key: Optional[str] = None


class ActivityReopenIn(BaseModel):
    reason: str
    new_activity_date: Optional[date] = None
    remarks: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    accuracy_meters: Optional[float] = None
    permission_status: Optional[str] = None
    client_event_at: Optional[str] = None
    device_id: Optional[str] = None
    idempotency_key: Optional[str] = None

    @field_validator("reason")
    @classmethod
    def _reason_required(cls, v):
        if not v or not v.strip():
            raise ValueError("reason is required")
        return v.strip()


def _safe_get(obj, field, default=None):
    try:
        v = getattr(obj, field, default)
        return default if v is None else v
    except Exception:
        return default


def _parse_client_event_at(value: Optional[str]):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _dict_or_empty(value):
    return value if isinstance(value, dict) else {}


def _first_nonempty_text(*values):
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return None


def _can_reopen_activity(cu: User, act: KAMActivity, db: Session) -> bool:
    if not _user_can_reopen_activities(cu, db):
        return False
    return int(act.user_id) in _reopen_hierarchy_scope_uids(cu, db)


# --- Complete --------------------------------------------------------------------

@router.post("/activities/{activity_id}/complete")
def complete_activity(
    activity_id: int, data: ActivityCompleteIn, request: Request,
    db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user),
):
    act = db.query(KAMActivity).filter(KAMActivity.id == activity_id).with_for_update().first()
    if not act: raise HTTPException(404, "Not found")
    if act.user_id not in _get_visible_uids(cu, db): raise HTTPException(403, "Not authorised")
    if act.status != "Completed" and not (data.outcome or _safe_get(act, "outcome") or "").strip():
        raise HTTPException(400, "Outcome required")

    try:
        complete_activity_cycle(
            db, act, cu,
            notes=data.notes, outcome=data.outcome or _safe_get(act, "outcome"),
            latitude=data.latitude, longitude=data.longitude, accuracy_meters=data.accuracy_meters,
            permission_status=data.permission_status, client_event_at=_parse_client_event_at(data.client_event_at),
            device_id=data.device_id, source="web", request=request, idempotency_key=data.idempotency_key,
        )
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Duplicate request")

    db.commit(); db.refresh(act)
    return _enrich_activity(act, db, include_reopen_info=True)


# --- Reopen ----------------------------------------------------------------------

@router.post("/activities/{activity_id}/reopen")
def reopen_activity(
    activity_id: int, data: ActivityReopenIn, request: Request,
    db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user),
):
    act = db.query(KAMActivity).filter(KAMActivity.id == activity_id).with_for_update().first()
    if not act: raise HTTPException(404, "Not found")
    if not _can_reopen_activity(cu, act, db): raise HTTPException(403, "Not authorised to reopen this activity")
    if not (data.remarks or "").strip(): raise HTTPException(400, "Remarks required")

    try:
        reopen_activity_cycle(
            db, act, cu,
            reason=data.reason, new_activity_date=data.new_activity_date, remarks=data.remarks,
            latitude=data.latitude, longitude=data.longitude, accuracy_meters=data.accuracy_meters,
            permission_status=data.permission_status, client_event_at=_parse_client_event_at(data.client_event_at),
            device_id=data.device_id, source="web", request=request, idempotency_key=data.idempotency_key,
        )
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Duplicate request")

    db.commit(); db.refresh(act)
    return _enrich_activity(act, db, include_reopen_info=True)


# --- Logs (combined event + GPS timeline) --------------------------------------------------------------------

@router.get("/activities/{activity_id}/logs")
def get_activity_logs(
    activity_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user),
):
    act = db.query(KAMActivity).filter(KAMActivity.id == activity_id).first()
    if not act: raise HTTPException(404, "Not found")
    if act.user_id not in _get_visible_uids(cu, db): raise HTTPException(403, "Not authorised")

    rows = (
        db.query(KAMLog)
        .filter(KAMLog.activity_id == activity_id)
        .order_by(KAMLog.event_at.asc(), KAMLog.id.asc())
        .all()
    )
    actor_ids = {r.actor_user_id for r in rows if r.actor_user_id}
    actors = {u.id: u for u in db.query(User).filter(User.id.in_(actor_ids)).all()} if actor_ids else {}

    out = []
    for r in rows:
        actor = actors.get(r.actor_user_id)
        new_values = _dict_or_empty(r.new_values_json)
        metadata = _dict_or_empty(r.metadata_json)
        outcome = _first_nonempty_text(
            new_values.get("outcome"),
            metadata.get("outcome"),
            metadata.get("completion_outcome"),
            new_values.get("cancellation_reason"),
        )
        remarks = _first_nonempty_text(
            r.remarks,
            new_values.get("remarks"),
            new_values.get("description"),
            metadata.get("remarks"),
            metadata.get("notes"),
        )
        out.append({
            "id": r.id,
            "event_type": r.event_type,
            "cycle_no": r.cycle_no,
            "previous_status": r.previous_status,
            "new_status": r.new_status,
            "actor_user_id": r.actor_user_id,
            "actor_name": actor.full_name if actor else None,
            "actor_role": r.actor_role,
            "reason": r.reason,
            "outcome": outcome,
            "remarks": remarks,
            "raw_remarks": r.remarks,
            "old_values": r.old_values_json,
            "new_values": r.new_values_json,
            "metadata": r.metadata_json,
            "latitude": float(r.latitude) if r.latitude is not None else None,
            "longitude": float(r.longitude) if r.longitude is not None else None,
            "accuracy_meters": float(r.accuracy_meters) if r.accuracy_meters is not None else None,
            "address": r.address,
            "permission_status": r.permission_status,
            "is_mock_location": r.is_mock_location,
            "client_event_at": r.client_event_at.isoformat() if r.client_event_at else None,
            "event_at": r.event_at.isoformat() if r.event_at else None,
            "source": r.source,
            "device_id": r.device_id,
        })
    return out


# --- Execution cycles ----------------------------------------------------------------------

@router.get("/activities/{activity_id}/cycles")
def get_activity_cycles(
    activity_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user),
):
    act = db.query(KAMActivity).filter(KAMActivity.id == activity_id).first()
    if not act: raise HTTPException(404, "Not found")
    if act.user_id not in _get_visible_uids(cu, db): raise HTTPException(403, "Not authorised")

    rows = (
        db.query(KAMActivityExecutionCycle)
        .filter(KAMActivityExecutionCycle.activity_id == activity_id)
        .order_by(KAMActivityExecutionCycle.cycle_no.asc())
        .all()
    )
    actor_ids = {uid for r in rows for uid in (r.opened_by, r.started_by, r.completed_by, r.reopened_by) if uid}
    users = {u.id: u for u in db.query(User).filter(User.id.in_(actor_ids)).all()} if actor_ids else {}

    def uname(uid):
        u = users.get(uid)
        return u.full_name if u else None

    return [{
        "id": r.id,
        "cycle_no": r.cycle_no,
        "status": r.status,
        "opened_at": r.opened_at.isoformat() if r.opened_at else None,
        "opened_by": r.opened_by,
        "opened_by_name": uname(r.opened_by),
        "open_reason": r.open_reason,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "started_by": r.started_by,
        "started_by_name": uname(r.started_by),
        "completed_at": r.completed_at.isoformat() if r.completed_at else None,
        "completed_by": r.completed_by,
        "completed_by_name": uname(r.completed_by),
        "completion_notes": r.completion_notes,
        "completion_outcome": r.completion_outcome,
        "actual_duration_minutes": r.actual_duration_minutes,
        "reopened_at": r.reopened_at.isoformat() if r.reopened_at else None,
        "reopened_by": r.reopened_by,
        "reopened_by_name": uname(r.reopened_by),
        "reopen_reason": r.reopen_reason,
    } for r in rows]
