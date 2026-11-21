"""Change & maintenance: change calendar, change freeze and scheduling.

Under ``/changes`` (Change & Maintenance permission: view to read, manage to schedule or reschedule). Changes affect
every tenant, so scheduling needs all-tenant scope. Approving and rejecting go through the platform approval queue
(/team/approvals), where the approver needs Change & Maintenance manage access and can't be the requester.
"""

from __future__ import annotations

from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.platform_change import PlatformChange
from app.models.tenant import PlatformApprovalRequest, SuperAdmin
from app.routers.platform_router import _can_decide, _get_platform_admin
from app.services import platform_changes as changes
from app.services import platform_controls as controls
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/changes", dependencies=[Depends(enforce_platform_access)])


def _payloads(db: Session, request: Request, rows: list[PlatformChange]) -> list[dict]:
    access, admin = request.state.platform_access, _get_platform_admin(request)
    names = {a.id: a.full_name or a.username for a in db.query(SuperAdmin).all()}
    ids = [c.approval_request_id for c in rows if c.approval_request_id]
    requests = {r.id: r for r in db.query(PlatformApprovalRequest).filter(PlatformApprovalRequest.id.in_(ids)).all()} if ids else {}
    result = []
    for change in rows:
        row = requests.get(change.approval_request_id)
        result.append(changes.payload(change, names, row, bool(row is not None and _can_decide(access, admin, row))))
    return result


@router.get("")
def overview(request: Request, db: Session = Depends(get_master_db_dep)):
    changes.ensure_schema()  # before this session's first read
    changes.sync(db)
    today = date.today()
    periods = changes.freeze_periods(db)
    rows = db.query(PlatformChange).filter(PlatformChange.status != "cancelled").order_by(PlatformChange.window_start.desc(), PlatformChange.id.desc()).limit(500).all()
    upcoming = [(s, e) for s, e in periods if e >= today]
    current = changes.freeze_for(today, periods)
    nxt = current or (upcoming[0] if upcoming else None)
    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "changes": _payloads(db, request, rows),
        "types": list(changes.TYPES),
        "freeze": {
            "enabled": bool(controls.value(db, "relFreeze")), "active": current is not None,
            "start": nxt[0].isoformat() if nxt else None, "end": nxt[1].isoformat() if nxt else None,
            "periods": [{"start": s.isoformat(), "end": e.isoformat()} for s, e in upcoming],
            "changes_inside": sum(1 for c in rows if c.in_freeze and c.status in changes.ACTIVE and not c.executed_at),
        },
        "approval_board": bool(controls.value(db, "relApprove")),
        "all_scope": scoped_tenant_ids(request) is None,
    }


def _authorize(request: Request) -> None:
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail="Changes affect every tenant – scheduling needs all-tenant scope.")


def _run(fn, *args):
    try:
        return fn(*args)
    except changes.ChangeError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))


class ChangeCreate(BaseModel):
    description: str = Field(max_length=500)
    type: str
    window: date


@router.post("")
def schedule_change(data: ChangeCreate, request: Request, db: Session = Depends(get_master_db_dep)):
    _authorize(request)
    changes.ensure_schema()
    change = _run(changes.create, db, _get_platform_admin(request), data.description, data.type, data.window, get_request_ip(request))
    return _payloads(db, request, [change])[0]


class ChangeReschedule(BaseModel):
    window: date


@router.patch("/{change_id}")
def reschedule_change(change_id: int, data: ChangeReschedule, request: Request, db: Session = Depends(get_master_db_dep)):
    _authorize(request)
    changes.ensure_schema()
    change = db.get(PlatformChange, change_id)
    if change is None:
        raise HTTPException(status_code=404, detail="Change not found")
    change = _run(changes.reschedule, db, _get_platform_admin(request), change, data.window, get_request_ip(request))
    return _payloads(db, request, [change])[0]
