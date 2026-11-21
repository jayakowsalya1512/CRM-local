"""Rate limits & API keys (Platform admin) – platform console API (platform_rate_limits, platform_api_keys).

Under ``/api-webhooks`` with the API & webhooks module (Tenants permission: view to read, manage to change). Plan limits
and API versions apply to every tenant, so changing them needs all-tenant scope; tenant-scoped staff see, rotate and
revoke only their tenants' keys. Responses never contain a key except the one issued by a rotation, once.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.platform_api import PlatformApiKey
from app.models.tenant import Plan, Tenant
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_api_keys as keys
from app.services import platform_rate_limits as rl
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/api-webhooks", dependencies=[Depends(enforce_platform_access)])
PAGE = 25


def _actor(request: Request) -> str:
    return getattr(_get_platform_admin(request), "email", None) or "platform admin"


def _all_scope(request: Request, what: str) -> None:
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail=f"{what} apply to every tenant – only staff with all-tenant scope can change them.")


@router.get("/rate-limits")
def overview(request: Request, db: Session = Depends(get_master_db_dep)):
    """KPIs, plan limits and API versions – the page's top half in one request (keys are paged separately)."""
    scope = scoped_tenant_ids(request)
    out = {"kpis": rl.kpis(db, scope), "plans": keys.plan_limits(db), "versions": rl.versions(db), "overlap_hours": keys.overlap_hours(db),
           "rotate_after_days": keys.ROTATE_AFTER_DAYS, "all_scope": scope is None}
    db.commit()   # default limits / detected versions stored on first read
    return out


@router.get("/rate-limits/kpis")
def kpis(request: Request, db: Session = Depends(get_master_db_dep)):
    return rl.kpis(db, scoped_tenant_ids(request))


@router.get("/rate-limits/plans")
def plans(db: Session = Depends(get_master_db_dep)):
    out = keys.plan_limits(db)
    db.commit()
    return out


class LimitBody(BaseModel):
    per_minute: Optional[int] = None
    burst: Optional[int] = None
    daily_cap: Optional[int] = None


@router.put("/rate-limits/plans/{plan_id}")
def update_plan(plan_id: int, body: LimitBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _all_scope(request, "Rate limits")
    try:
        before, after = keys.update_plan_limit(db, plan_id, body.model_dump(), _actor(request))
    except keys.ApiKeyError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    changed = after != before
    if changed:
        plan = db.get(Plan, plan_id)
        _write_platform_audit(db, _get_platform_admin(request), "rate_limit_updated", "plan", plan_id, plan.name if plan else str(plan_id),
                              f"API rate limit of {plan.name if plan else plan_id}: {after['per_minute']:,}/min, burst {after['burst']:,}, "
                              f"daily cap {after['daily_cap']:,} (was {before['per_minute']:,}/min, burst {before['burst']:,}, daily cap {before['daily_cap']:,})",
                              get_request_ip(request), old_data=before, new_data=after)
    db.commit()
    return {"changed": changed, "plan": next(p for p in keys.plan_limits(db) if p["plan_id"] == plan_id), "applies_within_seconds": keys.LIMIT_CACHE_SECONDS}


@router.get("/versions")
def versions(db: Session = Depends(get_master_db_dep)):
    out = rl.versions(db)
    db.commit()
    return out


class VersionBody(BaseModel):
    status: Optional[str] = None
    sunset: Optional[str] = Field(None, max_length=10)
    clear_sunset: bool = False


@router.put("/versions/{version}")
def update_version(version: str, body: VersionBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _all_scope(request, "API versions")
    try:
        before, after = rl.update_version(db, version, body.status, body.sunset, body.clear_sunset, _actor(request))
    except rl.RateLimitError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    if after != before:
        _write_platform_audit(db, _get_platform_admin(request), "api_version_updated", "platform_setting", None, f"API {version}",
                              f"API {version} set to {after['status']}{' – sunset ' + after['sunset'] if after['sunset'] else ''} (still served)",
                              get_request_ip(request), old_data=before, new_data=after)
    db.commit()
    return next(v for v in rl.versions(db) if v["version"] == version)


@router.get("/api-keys")
def list_keys(request: Request, q: str = "", status: str = "", sort: str = "", offset: int = Query(0, ge=0), limit: int = Query(PAGE, ge=1, le=200),
              db: Session = Depends(get_master_db_dep)):
    return rl.key_page(db, scoped_tenant_ids(request), q, status, sort, offset, limit)


def _key(db: Session, request: Request, key_id: int) -> tuple[PlatformApiKey, Tenant]:
    keys.ensure_schema()
    row = db.get(PlatformApiKey, key_id)
    scope = scoped_tenant_ids(request)
    if row is None or (scope is not None and row.tenant_id not in scope):
        raise HTTPException(status_code=404, detail="API key not found")
    return row, db.get(Tenant, row.tenant_id)


@router.post("/api-keys/{key_id}/rotate")
def rotate(key_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    row, tenant = _key(db, request, key_id)
    if tenant is None or tenant.status in ("suspended", "cancelled") or tenant.deletion_scheduled_at is not None:
        raise HTTPException(status_code=409, detail="The tenant isn't active – it can't get a new key")
    try:
        new, raw, hours = keys.rotate(db, row, _actor(request))
    except keys.ApiKeyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    _write_platform_audit(db, _get_platform_admin(request), "rotate_api_key", "tenant", tenant.id, tenant.name,
                          f"API key '{row.name}' ({row.prefix}…) rotated to {new.prefix}…; the old key "
                          + (f"works for {hours} more hour(s)" if hours else "stopped at once (no overlap)"), get_request_ip(request),
                          new_data={"old_key_id": row.id, "new_key_id": new.id, "new_prefix": new.prefix, "overlap_hours": hours,
                                    "old_expires_at": rl._iso(row.expires_at)})
    db.commit()
    return {"key": raw, "new": rl.key_dict(new, tenant.name), "old": rl.key_dict(row, tenant.name), "overlap_hours": hours,
            "note": "Copy the key now – only a hash is stored, so it can't be shown again."}


class RevokeBody(BaseModel):
    confirm: bool = False
    reason: str = Field("", max_length=300)


@router.post("/api-keys/{key_id}/revoke")
def revoke(key_id: int, body: RevokeBody, request: Request, db: Session = Depends(get_master_db_dep)):
    if not body.confirm:
        raise HTTPException(status_code=428, detail="Confirm the revocation – the key stops working immediately")
    row, tenant = _key(db, request, key_id)
    actor = _actor(request)
    try:
        keys.revoke(db, row, actor)
    except keys.ApiKeyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    _write_platform_audit(db, _get_platform_admin(request), "revoke_api_key", "tenant", row.tenant_id, tenant.name if tenant else None,
                          f"API key '{row.name}' ({row.prefix}…) revoked{': ' + body.reason.strip() if body.reason.strip() else ''}", get_request_ip(request),
                          new_data={"key_id": row.id, "prefix": row.prefix, "reason": body.reason.strip() or None})
    db.commit()
    return rl.key_dict(row, tenant.name if tenant else None)
