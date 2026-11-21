"""Trust & Safety (Governance): abuse cases, acceptable-use policies, user and tenant enforcement (platform_trust_safety).

Under ``/trust-safety`` (Tenants permission: view to read, manage to act). Tenant-scoped staff see and act on their
tenants only; acceptable-use policies apply to every tenant, so changing them needs all-tenant scope. Suspending or
terminating a tenant goes through four-eyes approval when it is on; policy-triggered actions are always approved first.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.tenant import Tenant
from app.routers.platform_router import _four_eyes_gate, _get_platform_admin, _write_platform_audit
from app.services import platform_trust_safety as ts
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/trust-safety", dependencies=[Depends(enforce_platform_access)])
PAGE = 25


def _actor(request: Request) -> str:
    admin = _get_platform_admin(request)
    return getattr(admin, "email", None) or getattr(admin, "username", None) or "platform admin"


def _audit(db: Session, request: Request, action: str, entity_type: str, entity_id, name, description: str, old=None, new=None) -> None:
    _write_platform_audit(db, _get_platform_admin(request), action, entity_type, entity_id, name, description, get_request_ip(request),
                          old_data=old, new_data=new)


def _fail(exc: ts.TrustSafetyError):
    raise HTTPException(status_code=exc.status_code, detail=str(exc))


def _tenant(db: Session, request: Request, tenant_id: int) -> Tenant:
    tenant = db.get(Tenant, tenant_id)
    allowed = scoped_tenant_ids(request)
    if tenant is None or (allowed is not None and tenant.id not in allowed):
        raise HTTPException(status_code=404, detail="Tenant not found")
    return tenant


def _case(db: Session, request: Request, case_id: Optional[int]):
    if not case_id:
        return None
    try:
        return ts.get_case(db, case_id, scoped_tenant_ids(request))
    except ts.TrustSafetyError as exc:
        _fail(exc)


@router.get("")
def overview(request: Request, db: Session = Depends(get_master_db_dep)):
    allowed = scoped_tenant_ids(request)
    users = ts.all_users(db, allowed, "", 0, PAGE)
    return {
        "kpis": ts.kpis(db, allowed, users["suspended"]),
        "cases": ts.cases(db, allowed, "all", 0, PAGE),
        "policies": ts.policies(db),
        "users": users,
        "history": ts.history(db, allowed, 0, PAGE),
        "options": {"categories": ts.CATEGORIES, "severities": ts.SEVERITIES, "user_reasons": ts.USER_REASONS, "tenant_reasons": ts.TENANT_REASONS,
                    "grace_days": ts.GRACE_DAYS},
        "tenants": [{"id": t.id, "name": t.name, "slug": t.slug, "status": t.status, "deletion_scheduled_at": t.deletion_scheduled_at}
                    for t in (db.query(Tenant) if allowed is None else db.query(Tenant).filter(Tenant.id.in_(allowed or [0]))).order_by(Tenant.name).all()],
        "all_scope": allowed is None,
    }


@router.get("/cases")
def list_cases(request: Request, status: str = Query("all", pattern="^(all|open|closed)$"), offset: int = Query(0, ge=0),
               limit: int = Query(PAGE, ge=1, le=100), db: Session = Depends(get_master_db_dep)):
    return ts.cases(db, scoped_tenant_ids(request), status, offset, limit)


class CaseReport(BaseModel):
    tenant_id: Optional[int] = None
    title: str = Field(..., max_length=300)
    category: str
    severity: str
    source: str = Field(..., max_length=120)
    evidence: str = Field("", max_length=20000)


@router.post("/cases", status_code=201)
def report_case(body: CaseReport, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, request, body.tenant_id) if body.tenant_id else None
    if tenant is None and scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail="Choose one of your tenants")
    admin = _get_platform_admin(request)
    try:
        case = ts.create_case(db, tenant, body.title, body.category, body.severity, body.source, body.evidence, _actor(request), getattr(admin, "id", None))
    except ts.TrustSafetyError as exc:
        _fail(exc)
    _audit(db, request, "report_abuse_case", "abuse_case", case.id, case.ref, f"Abuse case {case.ref} opened: {case.title} ({case.category}, {case.severity})",
           new={"tenant_id": case.tenant_id, "category": case.category, "severity": case.severity, "source": case.source})
    db.commit()
    return ts.case_detail(db, case)


@router.get("/cases/{case_id}")
def case_detail(case_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    return ts.case_detail(db, _case(db, request, case_id))


class CaseActionBody(BaseModel):
    note: str = Field("", max_length=1000)


@router.post("/cases/{case_id}/actions/{action}")
def case_action(case_id: int, action: str, body: CaseActionBody, request: Request, db: Session = Depends(get_master_db_dep)):
    case = _case(db, request, case_id)
    old = case.status
    try:
        message = ts.case_action(db, case, action, _actor(request), body.note)
    except ts.TrustSafetyError as exc:
        _fail(exc)
    _audit(db, request, f"abuse_case_{action}", "abuse_case", case.id, case.ref, f"{case.ref}: {message}", {"status": old}, {"status": case.status, "note": body.note or None})
    db.commit()
    return {"message": message, "case": ts.case_detail(db, case)}


class PolicyBody(BaseModel):
    enabled: bool


@router.put("/policies/{key}")
def set_policy(key: str, body: PolicyBody, request: Request, db: Session = Depends(get_master_db_dep)):
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail="Acceptable-use policies apply to every tenant – changing them needs all-tenant scope.")
    try:
        old, new = ts.set_policy(db, key, body.enabled, _actor(request))
    except ts.TrustSafetyError as exc:
        _fail(exc)
    if old != new:
        _audit(db, request, "update_aup_policy", "aup_policy", None, ts.POLICY_BY_KEY[key]["name"],
               f"Acceptable-use policy '{ts.POLICY_BY_KEY[key]['name']}' {'enabled' if new else 'disabled'}", {"enabled": old}, {"enabled": new})
    db.commit()
    return ts.policies(db)


@router.get("/users")
def users(request: Request, q: str = Query("", max_length=100), offset: int = Query(0, ge=0), limit: int = Query(PAGE, ge=1, le=500),
          tenant_id: Optional[int] = None, db: Session = Depends(get_master_db_dep)):
    if tenant_id is not None:
        _tenant(db, request, tenant_id)
    return ts.all_users(db, scoped_tenant_ids(request), q.strip(), offset, limit, tenant_id)


class TerminateUserBody(BaseModel):
    reason: str
    case_id: Optional[int] = None
    notes: str = Field("", max_length=2000)
    transfer_to: Optional[int] = None
    revoke: bool = True
    notify: bool = True
    block: bool = False
    legal_hold: bool = True
    confirm: str


@router.post("/tenants/{tenant_id}/users/{user_id}/terminate")
def terminate_user(tenant_id: int, user_id: int, body: TerminateUserBody, request: Request, db: Session = Depends(get_master_db_dep)):
    if body.confirm.strip() != "TERMINATE":
        raise HTTPException(status_code=422, detail="Type TERMINATE to confirm")
    if not body.legal_hold:
        raise HTTPException(status_code=422, detail="Evidence must be preserved under legal hold")
    tenant = _tenant(db, request, tenant_id)
    case = _case(db, request, body.case_id)
    try:
        result = ts.terminate_user(db, tenant, user_id, reason=body.reason, case=case, notes=body.notes, transfer_to=body.transfer_to,
                                   revoke=body.revoke, notify=body.notify, block=body.block, actor=_actor(request))
    except ts.TrustSafetyError as exc:
        _fail(exc)
    _audit(db, request, "ts_terminate_user", "tenant", tenant.id, tenant.name, f"User {result['email']} terminated by Trust & Safety ({body.reason})",
           new={"user_id": user_id, "reason": body.reason, "case": case.ref if case else None, "notes": body.notes or None,
                **{k: result.get(k) for k in ("evidence_id", "evidence_sha256", "revoked", "transferred", "blocked", "notified")}})
    db.commit()
    return result


@router.post("/tenants/{tenant_id}/users/{user_id}/{action}")
def user_status(tenant_id: int, user_id: int, action: str, request: Request, db: Session = Depends(get_master_db_dep)):
    if action not in ("suspend", "reinstate", "restore"):
        raise HTTPException(status_code=404, detail="Unknown action")
    tenant = _tenant(db, request, tenant_id)
    try:
        result = ts.restore_user(db, tenant, user_id, _actor(request)) if action == "restore" else ts.set_user_active(db, tenant, user_id, action == "reinstate", _actor(request))
    except ts.TrustSafetyError as exc:
        _fail(exc)
    label = {"suspend": "suspended", "reinstate": "reinstated", "restore": "restored (termination lifted)"}[action]
    _audit(db, request, f"ts_{action}_user", "tenant", tenant.id, tenant.name, f"User {result['email']} {label} by Trust & Safety", new={"user_id": user_id, **{k: v for k, v in result.items() if k in ('revoked', 'blocks_lifted')}})
    db.commit()
    return result


@router.get("/history")
def history(request: Request, offset: int = Query(0, ge=0), limit: int = Query(PAGE, ge=1, le=100), db: Session = Depends(get_master_db_dep)):
    return ts.history(db, scoped_tenant_ids(request), offset, limit)


class TenantEnforceBody(BaseModel):
    action: str = Field(..., pattern="^(suspend|terminate)$")
    reason: str
    case_id: Optional[int] = None
    confirm: str


def _run_tenant_action(db: Session, request: Request, tenant: Tenant, action: str, reason: str, case) -> dict:
    from app.services.password_reset_service import _resolve_frontend_base_url
    from app.services import tenant_data_transfer as transfer
    try:
        result = ts.tenant_enforce(db, tenant, action, reason, case, _actor(request), _resolve_frontend_base_url(request))
    except ts.TrustSafetyError as exc:
        _fail(exc)
    old = result.pop("old")
    _audit(db, request, f"ts_{action}_tenant", "tenant", tenant.id, tenant.name, f"{result['message']} (Trust & Safety: {reason})", old,
           {"status": tenant.status, "deletion_scheduled_at": tenant.deletion_scheduled_at.isoformat() if tenant.deletion_scheduled_at else None,
            "export_job": result.get("export_job"), "case": case.ref if case else None})
    db.commit()
    if result.get("export_job"):
        transfer.start_export(result["export_job"])
    return result


@router.post("/tenants/{tenant_id}/enforce")
def enforce_tenant(tenant_id: int, body: TenantEnforceBody, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, request, tenant_id)
    if body.confirm.strip().lower() != tenant.slug.lower():
        raise HTTPException(status_code=422, detail=f"Type the tenant short name ({tenant.slug}) to confirm")
    if body.reason not in ts.TENANT_REASONS:
        raise HTTPException(status_code=422, detail="Choose a reason")
    case = _case(db, request, body.case_id)
    action = f"ts_{body.action}_tenant"
    verb = "Suspend" if body.action == "suspend" else "Terminate"
    gate = _four_eyes_gate(db, request, action, "tenant", tenant.id, tenant.name, f"{verb} tenant '{tenant.name}' ({body.reason})",
                           {"tenant_id": tenant.id, "reason": body.reason, "case_id": case.id if case else None})
    if gate:
        if case is not None:
            ts._event(db, case, f"{verb} tenant sent for four-eyes approval", _actor(request))
            db.commit()
        return gate
    return _run_tenant_action(db, request, tenant, body.action, body.reason, case)


def execute_approved(action: str):
    """Four-eyes executors for ts_suspend_tenant / ts_terminate_tenant / ts_warn_tenant (registered in platform_router)."""
    def run(request: Request, db: Session, payload: dict) -> dict:
        tenant = db.get(Tenant, int(payload["tenant_id"]))
        if tenant is None:
            raise HTTPException(status_code=404, detail="Tenant not found")
        case = db.get(ts.PlatformAbuseCase, int(payload["case_id"])) if payload.get("case_id") else None
        if action == "ts_warn_tenant":
            result = ts.warn_tenant(db, tenant, case, payload.get("reason") or "Acceptable-use policy", _actor(request))
            db.commit()
            return result
        reason = payload.get("reason") or "Terms violation"
        if reason not in ts.TENANT_REASONS:   # policy-queued requests carry the policy name
            reason = {"fraud": "Fraud", "sanctions": "Sanctions", "illegal": "Illegal activity"}.get(payload.get("policy"), "Terms violation")
        return _run_tenant_action(db, request, tenant, "suspend" if action == "ts_suspend_tenant" else "terminate", reason, case)
    return run
