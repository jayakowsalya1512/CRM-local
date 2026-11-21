"""SLA & customer satisfaction (Governance) – platform console API (platform_sla).

Under ``/sla`` (Tenants permission: view to read, manage to change policies and the SLA calendar). Tenant-scoped staff
see only their tenants' tickets and ratings; policies and the calendar are platform-wide and need all-tenant scope to edit.
``public_router`` serves the e-mailed rating link (the one-time token is the credential).
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.tenant import Plan, Tenant
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_sla as sla
from app.services import platform_support as support
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/sla", dependencies=[Depends(enforce_platform_access)])
public_router = APIRouter(prefix="/api/v1/support-csat")


def _actor(request: Request) -> str:
    return getattr(_get_platform_admin(request), "email", None) or "platform admin"


def _all_scope(request: Request) -> None:
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail="SLA policies apply to every tenant – only staff with all-tenant scope can change them.")


def _err(exc: sla.SlaError):
    return HTTPException(status_code=exc.status_code, detail=str(exc))


@router.get("")
def overview(request: Request, db: Session = Depends(get_master_db_dep)):
    """Everything the page shows, in one request."""
    support.ensure_schema()
    scope = scoped_tenant_ids(request)
    out = {"kpis": sla.kpis(db, scope), "policies": sla.policies(db), "csat": sla.csat_trend(db, scope), "breaches": sla.breaches_by_priority(db, scope),
           "canned": sla.canned(db), "calendar": sla.calendar_dict(sla.calendar(db)), "coverage": sla.COVERAGE, "channels": sla.CHANNELS,
           "all_scope": scope is None}
    db.commit()   # seeded policies of new plans
    return out


@router.get("/kpis")
def kpis(request: Request, db: Session = Depends(get_master_db_dep)):
    return sla.kpis(db, scoped_tenant_ids(request))


@router.get("/policies")
def policies(db: Session = Depends(get_master_db_dep)):
    out = sla.policies(db)
    db.commit()
    return out


class PolicyBody(BaseModel):
    first_response_h: Optional[float] = None
    resolution_h: Optional[float] = None
    coverage: Optional[str] = None
    channels: Optional[list[str]] = None


@router.put("/policies/{plan_id}")
def update_policy(plan_id: int, body: PolicyBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _all_scope(request)
    actor = _actor(request)
    try:
        before, after, version = sla.update_policy(db, plan_id, body.model_dump(), actor)
    except sla.SlaError as exc:
        db.rollback()
        raise _err(exc)
    if version is not None:
        plan = db.get(Plan, plan_id)
        _write_platform_audit(db, _get_platform_admin(request), "sla_policy_updated", "plan", plan_id, plan.name if plan else str(plan_id),
                              f"SLA policy of {plan.name if plan else plan_id} changed to v{version}: first response {after['first_response_h']:g} h, "
                              f"resolution {after['resolution_h']:g} h, {sla.COVERAGE[after['coverage']]}, {sla.channels_label(after['channels'])}",
                              get_request_ip(request), old_data=before, new_data={**after, "version": version})
    db.commit()
    return {"changed": version is not None, "version": version, "policy": next(p for p in sla.policies(db) if p["plan_id"] == plan_id)}


@router.get("/calendar")
def get_calendar(db: Session = Depends(get_master_db_dep)):
    return sla.calendar_dict(sla.calendar(db))


class CalendarBody(BaseModel):
    days: list[int]
    day_start: str = Field(..., max_length=5)
    day_end: str = Field(..., max_length=5)
    holidays: list[dict] = Field(default_factory=list, max_length=200)


@router.put("/calendar")
def update_calendar(body: CalendarBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _all_scope(request)
    try:
        before, after = sla.update_calendar(db, body.days, body.day_start, body.day_end, body.holidays, _actor(request))
    except sla.SlaError as exc:
        db.rollback()
        raise _err(exc)
    _write_platform_audit(db, _get_platform_admin(request), "sla_calendar_updated", "platform_setting", None, "SLA calendar",
                          f"SLA business hours set to {after['day_start']}–{after['day_end']}, {len(after['days'])} working day(s), {len(after['holidays'])} holiday(s) "
                          "(applies to tickets opened from now on)", get_request_ip(request), old_data=before, new_data=after)
    db.commit()
    return after


@router.get("/csat")
def csat(request: Request, db: Session = Depends(get_master_db_dep)):
    return sla.csat_trend(db, scoped_tenant_ids(request))


@router.get("/breaches")
def breaches(request: Request, db: Session = Depends(get_master_db_dep)):
    return sla.breaches_by_priority(db, scoped_tenant_ids(request))


@router.get("/canned-responses")
def canned(db: Session = Depends(get_master_db_dep)):
    return sla.canned(db)


# ─── Rating link (no sign-in) ────────────────────────────────────────────────

@public_router.get("/{token}")
def rating_ticket(token: str, db: Session = Depends(get_master_db_dep)):
    try:
        t = sla.ticket_for_token(db, token)
    except sla.SlaError as exc:
        raise _err(exc)
    tenant = db.get(Tenant, t.tenant_id)
    return {"ref": t.ref, "subject": t.subject, "tenant": tenant.name if tenant else None, "resolved_at": sla._utc(t.closed_at)}


class RatingBody(BaseModel):
    rating: int
    feedback: str = Field("", max_length=2000)


@public_router.post("/{token}", status_code=201)
def rate(token: str, body: RatingBody, request: Request, db: Session = Depends(get_master_db_dep)):
    try:
        t = sla.ticket_for_token(db, token)
        row = sla.submit_csat(db, t, body.rating, body.feedback, t.requester_email or t.requester_name or "rating link", "email")
    except sla.SlaError as exc:
        db.rollback()
        raise _err(exc)
    _write_platform_audit(db, None, "support_csat_submitted", "tenant", t.tenant_id, t.ref, f"CSAT {row.rating}/5 for {t.ref} via the e-mailed link",
                          get_request_ip(request), new_data={"ticket": t.ref, "rating": row.rating, "channel": "email"})
    db.commit()
    return sla.csat_dict(row)
