"""
Shared audit / GPS / execution-cycle helpers for the KAM activity reopen
workflow.

Every action (create/update/start/complete/cancel/postpone/reopen) is logged
as ONE row in the combined `kam_log` table — event fields and GPS fields
live together on the same row, so a plain edit with no GPS just has null
location columns, and a location-only capture with no status change still
gets an event_type describing what happened.

Kept out of both kam_router.py and kam_activity_reopen_router.py so the two
router modules can each import it without depending on one another.

None of these functions commit — the caller owns the transaction and commits
once, so the activity row, the cycle row and the kam_log row all land in the
same COMMIT.
"""
import logging
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any, Optional

from fastapi import HTTPException, Request
from sqlalchemy.orm import Session

from app.core.timezone import now_ist
from app.models.all_models import KAMActivity, KAMLog, KAMActivityExecutionCycle

logger = logging.getLogger(__name__)


def json_safe(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    return value


def _request_meta(request: Optional[Request]):
    if request is None:
        return None, None, None
    ip = None
    try:
        from app.dependencies import get_request_ip
        ip = get_request_ip(request)
    except Exception:
        ip = None
    request_id = request.headers.get("x-request-id")
    device_id = request.headers.get("x-device-id")
    return ip, request_id, device_id


def find_existing_log(db: Session, activity_id: int, idempotency_key: Optional[str]):
    if not idempotency_key:
        return None
    return db.query(KAMLog).filter(
        KAMLog.activity_id == activity_id,
        KAMLog.idempotency_key == idempotency_key,
    ).first()


def log_kam_activity(
    db: Session,
    *,
    activity_id: int,
    event_type: str,
    cycle_no: int = 1,
    actor=None,
    previous_status: Optional[str] = None,
    new_status: Optional[str] = None,
    reason: Optional[str] = None,
    remarks: Optional[str] = None,
    old_values: Optional[dict] = None,
    new_values: Optional[dict] = None,
    metadata: Optional[dict] = None,
    source: str = "web",
    request: Optional[Request] = None,
    idempotency_key: Optional[str] = None,
    event_at=None,
    # GPS — every field optional; a capture with no fix still logs the event
    # with latitude/longitude NULL and permission_status explaining why.
    latitude=None,
    longitude=None,
    accuracy_meters=None,
    address: Optional[str] = None,
    locality: Optional[str] = None,
    district: Optional[str] = None,
    state: Optional[str] = None,
    postal_code: Optional[str] = None,
    permission_status: Optional[str] = None,
    is_mock_location: bool = False,
    capture_source: Optional[str] = None,
    client_event_at=None,
    device_id: Optional[str] = None,
) -> KAMLog:
    """Insert one append-only kam_log row. Never commits, never updates an
    existing row — corrections must be new rows."""
    if latitude is not None:
        lat = float(latitude)
        if not (-90 <= lat <= 90):
            raise HTTPException(400, "latitude must be between -90 and 90")
        latitude = lat
    if longitude is not None:
        lng = float(longitude)
        if not (-180 <= lng <= 180):
            raise HTTPException(400, "longitude must be between -180 and 180")
        longitude = lng

    ip, req_id, hdr_device_id = _request_meta(request)
    row = KAMLog(
        activity_id=activity_id,
        cycle_no=cycle_no,
        event_type=event_type,
        previous_status=previous_status,
        new_status=new_status,
        actor_user_id=getattr(actor, "id", None),
        actor_role=getattr(actor, "role", None),
        reason=reason,
        remarks=remarks,
        old_values_json=json_safe(old_values) if old_values else None,
        new_values_json=json_safe(new_values) if new_values else None,
        metadata_json=json_safe(metadata) if metadata else None,
        latitude=latitude,
        longitude=longitude,
        accuracy_meters=accuracy_meters,
        address=address,
        locality=locality,
        district=district,
        state=state,
        postal_code=postal_code,
        permission_status=permission_status,
        is_mock_location=bool(is_mock_location),
        capture_source=capture_source,
        client_event_at=client_event_at,
        event_at=event_at or now_ist(),
        source=source,
        device_id=device_id or hdr_device_id,
        ip_address=ip,
        request_id=req_id,
        idempotency_key=idempotency_key,
    )
    db.add(row)
    db.flush()
    return row


def get_or_create_open_cycle(db: Session, act: KAMActivity) -> KAMActivityExecutionCycle:
    """
    Load the activity's current execution cycle with a row lock, creating
    cycle 1 on the fly for legacy activities that predate this workflow —
    i.e. the per-tenant schema hotfix has run but migrate_kam_activity_reopen.py's
    backfill hasn't reached this tenant yet. Caller must already hold a lock
    on `act` (SELECT ... FOR UPDATE) before calling this.
    """
    cycle_no = act.current_cycle_no or 1
    cycle = (
        db.query(KAMActivityExecutionCycle)
        .filter(
            KAMActivityExecutionCycle.activity_id == act.id,
            KAMActivityExecutionCycle.cycle_no == cycle_no,
        )
        .with_for_update()
        .first()
    )
    if cycle:
        return cycle
    cycle = KAMActivityExecutionCycle(
        activity_id=act.id,
        cycle_no=cycle_no,
        status=act.status if act.status in ("In Progress", "Completed") else "Open",
        opened_at=act.created_at or now_ist(),
        opened_by=act.created_by or act.user_id,
        started_at=act.created_at if act.status == "In Progress" else None,
    )
    db.add(cycle)
    db.flush()
    return cycle


def complete_activity_cycle(
    db: Session,
    act: KAMActivity,
    cu,
    *,
    notes: Optional[str] = None,
    outcome: Optional[str] = None,
    extra_old_values: Optional[dict] = None,
    extra_new_values: Optional[dict] = None,
    latitude=None,
    longitude=None,
    accuracy_meters=None,
    address: Optional[str] = None,
    permission_status: Optional[str] = None,
    capture_source: Optional[str] = None,
    client_event_at=None,
    device_id: Optional[str] = None,
    source: str = "web",
    request: Optional[Request] = None,
    idempotency_key: Optional[str] = None,
) -> dict:
    """
    Shared completion bookkeeping, used both by the dedicated
    POST /activities/{id}/complete endpoint and by PATCH /activities/{id}
    when the existing generic-update flow sets status="Completed" — so both
    paths produce identical cycle/log records instead of drifting apart.
    Caller must have already loaded `act` with SELECT ... FOR UPDATE and must
    commit once, together with everything else in the request.
    """
    existing = find_existing_log(db, act.id, idempotency_key)
    if existing:
        return {"activity": act, "already_applied": True}

    if act.status == "Completed":
        raise HTTPException(400, "Activity is already completed")

    previous_status = act.status
    cycle = get_or_create_open_cycle(db, act)
    completed_at = now_ist()
    duration = None
    if cycle.started_at:
        duration = int((completed_at - cycle.started_at).total_seconds() // 60)

    cycle.status = "Completed"
    cycle.completed_at = completed_at
    cycle.completed_by = cu.id
    cycle.completion_notes = notes
    cycle.completion_outcome = outcome
    cycle.actual_duration_minutes = duration

    act.status = "Completed"
    act.updated_at = completed_at
    if latitude is not None and longitude is not None:
        act.latitude = latitude
        act.longitude = longitude

    log_old_values = dict(extra_old_values or {})
    log_new_values = dict(extra_new_values or {})
    if outcome:
        log_new_values["outcome"] = outcome

    log = log_kam_activity(
        db,
        activity_id=act.id,
        event_type="ACTIVITY_COMPLETED",
        cycle_no=cycle.cycle_no,
        actor=cu,
        previous_status=previous_status,
        new_status="Completed",
        remarks=notes,
        old_values=log_old_values or None,
        new_values=log_new_values or None,
        latitude=latitude,
        longitude=longitude,
        accuracy_meters=accuracy_meters,
        address=address,
        permission_status=permission_status,
        capture_source=capture_source,
        client_event_at=client_event_at,
        device_id=device_id,
        source=source,
        request=request,
        idempotency_key=idempotency_key,
    )

    return {"activity": act, "cycle": cycle, "log": log, "already_applied": False}


def reopen_activity_cycle(
    db: Session,
    act: KAMActivity,
    cu,
    *,
    reason: str,
    new_activity_date=None,
    remarks: Optional[str] = None,
    latitude=None,
    longitude=None,
    accuracy_meters=None,
    address: Optional[str] = None,
    permission_status: Optional[str] = None,
    capture_source: Optional[str] = None,
    client_event_at=None,
    device_id: Optional[str] = None,
    source: str = "web",
    request: Optional[Request] = None,
    idempotency_key: Optional[str] = None,
) -> dict:
    """
    Caller must have already loaded `act` with SELECT ... FOR UPDATE — the
    row lock is what prevents two concurrent reopen calls from minting
    duplicate cycle numbers (the second call blocks until the first commits,
    then re-reads a status that is no longer 'Completed' and is rejected).
    """
    existing = find_existing_log(db, act.id, idempotency_key)
    if existing:
        return {"activity": act, "already_applied": True}

    if act.status != "Completed":
        raise HTTPException(400, f"Only a completed activity can be reopened (current status: {act.status})")

    old_cycle = get_or_create_open_cycle(db, act)
    reopened_at = now_ist()
    previous_cycle_no = old_cycle.cycle_no
    previous_completed_at = old_cycle.completed_at

    old_cycle.status = "Reopened"
    old_cycle.reopened_at = reopened_at
    old_cycle.reopened_by = cu.id
    old_cycle.reopen_reason = reason

    new_cycle_no = (act.current_cycle_no or 1) + 1
    new_cycle = KAMActivityExecutionCycle(
        activity_id=act.id,
        cycle_no=new_cycle_no,
        status="Open",
        opened_at=reopened_at,
        opened_by=cu.id,
        open_reason=reason,
    )
    db.add(new_cycle)
    db.flush()

    act.status = "Reopened"
    act.current_cycle_no = new_cycle_no
    act.reopen_count = (act.reopen_count or 0) + 1
    act.last_reopened_at = reopened_at
    act.last_reopened_by = cu.id
    if new_activity_date:
        act.activity_date = new_activity_date
    act.updated_at = reopened_at

    log = log_kam_activity(
        db,
        activity_id=act.id,
        event_type="ACTIVITY_REOPENED",
        cycle_no=new_cycle_no,
        actor=cu,
        previous_status="Completed",
        new_status="Reopened",
        reason=reason,
        remarks=remarks,
        metadata={
            "previous_cycle_no": previous_cycle_no,
            "previous_completed_at": json_safe(previous_completed_at),
        },
        latitude=latitude,
        longitude=longitude,
        accuracy_meters=accuracy_meters,
        address=address,
        permission_status=permission_status,
        capture_source=capture_source,
        client_event_at=client_event_at,
        device_id=device_id,
        source=source,
        request=request,
        idempotency_key=idempotency_key,
    )

    return {"activity": act, "old_cycle": old_cycle, "new_cycle": new_cycle, "log": log, "already_applied": False}


def get_latest_reopen_info(db: Session, act: KAMActivity) -> Optional[dict]:
    """
    Builds the `latest_reopen` block for activity-detail enrichment, sourced
    from the most recently reopened execution-cycle row (it already carries
    reopened_at/reopened_by/reopen_reason — no need to also query kam_log).
    """
    if not (act.reopen_count or 0):
        return None
    cycle = (
        db.query(KAMActivityExecutionCycle)
        .filter(
            KAMActivityExecutionCycle.activity_id == act.id,
            KAMActivityExecutionCycle.status == "Reopened",
        )
        .order_by(KAMActivityExecutionCycle.cycle_no.desc())
        .first()
    )
    if not cycle:
        return None
    from app.models.all_models import User
    reopener = db.query(User).filter(User.id == cycle.reopened_by).first() if cycle.reopened_by else None
    return {
        "reopened_at": json_safe(cycle.reopened_at),
        "reopened_by": cycle.reopened_by,
        "reopened_by_name": reopener.full_name if reopener else None,
        "reason": cycle.reopen_reason,
    }
