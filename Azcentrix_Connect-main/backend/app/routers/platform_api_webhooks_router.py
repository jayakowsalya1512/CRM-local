"""API & webhooks (Platform admin): API traffic KPIs, per-plan API rate limits, webhook deliveries, tenant API keys.

Under ``/api-webhooks`` (Tenants permission: view to read, manage to create keys). Key rotation and revocation, plan
limit editing and API versions are in platform_rate_limits_router (Rate limits & API keys). Tenant-scoped staff see their
tenants' traffic and deliveries and can create keys only for their tenants.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.platform_api import PlatformWebhookDelivery
from app.models.platform_monitoring import PlatformTenantUsageHour
from app.models.tenant import Tenant
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_api_keys as keys, platform_webhooks as wh
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/api-webhooks", dependencies=[Depends(enforce_platform_access)])
PAGE = 25
STATUS_LABEL = {"delivered": "Done", "failed": "Failed", "retrying": "Retrying", "pending": "Pending", "sending": "Pending"}


def _scope(q, column, allowed: Optional[list[int]]):
    return q if allowed is None else q.filter(column.in_(allowed or [0]))


def _kpis(db: Session, allowed: Optional[list[int]]) -> dict:
    since_hour = int(time.time() // 3600) - 23          # the current hour and the 23 before it
    meters = db.query(PlatformTenantUsageHour.meter, func.sum(PlatformTenantUsageHour.value)) \
        .filter(PlatformTenantUsageHour.hour >= since_hour, PlatformTenantUsageHour.meter.in_(("api", "rate_limited")))
    if allowed is not None:
        slugs = [s for (s,) in db.query(Tenant.slug).filter(Tenant.id.in_(allowed or [0])).all()]
        meters = meters.filter(PlatformTenantUsageHour.tenant_slug.in_(slugs or [""]))
    m = {k: float(v or 0) for k, v in meters.group_by(PlatformTenantUsageHour.meter).all()}
    wh.ensure_schema()
    status = dict(_scope(db.query(PlatformWebhookDelivery.status, func.count(PlatformWebhookDelivery.id))
                         .filter(PlatformWebhookDelivery.created_at >= datetime.utcnow() - timedelta(hours=24)), PlatformWebhookDelivery.tenant_id, allowed)
                  .group_by(PlatformWebhookDelivery.status).all())
    done, failed = int(status.get("delivered", 0)), int(status.get("failed", 0))
    api, limited = int(m.get("api", 0)), int(m.get("rate_limited", 0))
    return {"api_requests_24h": api, "webhook_deliveries_24h": int(sum(status.values())),
            "delivery_success": round(100 * done / (done + failed), 1) if done + failed else None, "delivered": done, "failed": failed,
            "rate_limited": round(100 * limited / api, 2) if api else None, "rate_limited_requests": limited}


def _deliveries(db: Session, allowed: Optional[list[int]], offset: int, limit: int) -> dict:
    wh.ensure_schema()
    q = _scope(db.query(PlatformWebhookDelivery), PlatformWebhookDelivery.tenant_id, allowed)
    total = q.order_by(None).count()
    # The page by time alone (walks the created_at index), then the tenant names of that page in one batch query.
    page = q.order_by(PlatformWebhookDelivery.created_at.desc(), PlatformWebhookDelivery.id.desc()).offset(offset).limit(limit).all()
    names = dict(db.query(Tenant.id, Tenant.name).filter(Tenant.id.in_({d.tenant_id for d in page} or {0})).all())
    rows = [(d, names.get(d.tenant_id, f"Tenant #{d.tenant_id}")) for d in page]
    return {"items": [{"id": d.id, "tenant": name, "event": d.event_type, "status": STATUS_LABEL.get(d.status, d.status), "latency_ms": d.latency_ms,
                       "attempts": d.attempts, "response_code": d.response_code, "error": d.last_error,
                       "at": f"{d.created_at.replace(microsecond=0).isoformat()}Z"} for d, name in rows],
            "total": total, "offset": offset, "limit": limit}


@router.get("")
def overview(request: Request, db: Session = Depends(get_master_db_dep)):
    allowed = scoped_tenant_ids(request)
    limits = keys.plan_limits(db)
    db.commit()   # stores default limits for plans that had none
    tenants = _scope(db.query(Tenant.id, Tenant.name).filter(Tenant.status != "cancelled"), Tenant.id, allowed).order_by(Tenant.name).all()
    return {"kpis": _kpis(db, allowed), "rate_limits": limits, "deliveries": _deliveries(db, allowed, 0, PAGE),
            "tenants": [{"id": t.id, "name": t.name} for t in tenants], "events": list(wh.EVENTS), "all_scope": allowed is None}


@router.get("/deliveries")
def deliveries(request: Request, offset: int = Query(0, ge=0), limit: int = Query(PAGE, ge=1, le=100), db: Session = Depends(get_master_db_dep)):
    return _deliveries(db, scoped_tenant_ids(request), offset, limit)


class KeyBody(BaseModel):
    tenant_id: int
    user_id: int
    name: str = Field(..., max_length=120)
    scopes: list[str] = Field(default_factory=lambda: ["read", "write"], max_length=2)


@router.post("/keys", status_code=201)
def create_key(body: KeyBody, request: Request, db: Session = Depends(get_master_db_dep)):
    allowed = scoped_tenant_ids(request)
    tenant = db.get(Tenant, body.tenant_id)
    if tenant is None or (allowed is not None and tenant.id not in allowed):
        raise HTTPException(status_code=404, detail="Tenant not found")
    if tenant.status in ("suspended", "cancelled") or tenant.deletion_scheduled_at is not None:
        raise HTTPException(status_code=409, detail=f"{tenant.name} is {tenant.status} – it can't get new API keys")
    admin = _get_platform_admin(request)
    try:
        row, raw = keys.create_key(db, tenant, body.user_id, body.name, getattr(admin, "email", None) or "platform admin", body.scopes)
    except keys.ApiKeyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    per_minute, burst, daily_cap = keys.tenant_limit(db, tenant)
    _write_platform_audit(db, admin, "create_api_key", "tenant", tenant.id, tenant.name,
                          f"API key '{row.name}' ({row.prefix}…, scopes {row.scopes}) created for user #{row.user_id}", get_request_ip(request),
                          new_data={"key_id": row.id, "prefix": row.prefix, "name": row.name, "user_id": row.user_id, "scopes": row.scopes})
    db.commit()
    return {"id": row.id, "name": row.name, "prefix": row.prefix, "tenant": tenant.name, "user_id": row.user_id, "key": raw, "scopes": row.scopes.split(","),
            "rate_limit": {"per_minute": per_minute, "burst": burst, "daily_cap": daily_cap}, "note": "Copy the key now – it is not stored and can't be shown again."}
