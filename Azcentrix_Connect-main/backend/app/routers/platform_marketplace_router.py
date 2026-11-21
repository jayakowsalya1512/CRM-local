"""Marketplace administration (Mobile & ecosystem) – platform console API (platform_marketplace).

Under ``/marketplace`` (Tenants permission: view to read, manage to act). The marketplace spans tenants, so changes need
all-tenant scope.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.platform_marketplace import PlatformMarketApp
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_marketplace as mk
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids


def _schema(db: Session = Depends(get_master_db_dep)) -> None:
    if mk.ensure_schema():   # a transaction older than the tables can't read them (MariaDB 1412)
        db.rollback()


router = APIRouter(prefix="/api/v1/platform/marketplace", dependencies=[Depends(enforce_platform_access), Depends(_schema)])
PAGE = 25


def _actor(request: Request) -> str:
    return getattr(_get_platform_admin(request), "email", None) or "platform admin"


def _all_scope(request: Request) -> None:
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail="The marketplace spans tenants – changing it needs all-tenant scope.")


@router.get("")
def overview(request: Request, db: Session = Depends(get_master_db_dep)):
    plans = mk.plan_access(db)
    db.commit()
    pol = mk.policy(db)
    return {"kpis": mk.kpis(db), "apps": mk.apps_page(db, "", 0, PAGE), "plans": plans,
            "policy": [{"key": k, "label": label, "enabled": pol[k]} for k, label, _ in mk.POLICY],
            "scanner_connected": bool(mk.scanner_secret()), "all_scope": scoped_tenant_ids(request) is None}


@router.get("/apps")
def apps(q: str = Query("", max_length=100), offset: int = Query(0, ge=0), limit: int = Query(PAGE, ge=1, le=200), db: Session = Depends(get_master_db_dep)):
    return mk.apps_page(db, q.strip(), offset, limit)


class ActionBody(BaseModel):
    reason: str = Field("", max_length=300)


@router.post("/apps/{app_id}/{action}")
def app_action(app_id: int, action: str, body: ActionBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _all_scope(request)
    app = db.get(PlatformMarketApp, app_id)
    if app is None:
        raise HTTPException(status_code=404, detail="App not found")
    try:
        old, new = mk.change_status(db, app, action, body.reason, _actor(request))
    except mk.MarketError as exc:
        db.rollback()
        _write_platform_audit(db, _get_platform_admin(request), f"marketplace_{action}_refused", "market_app", app.id, app.name,
                              f"Marketplace: {action} refused for '{app.name}' – {exc}", get_request_ip(request), new_data={"status": app.status})
        db.commit()
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    _write_platform_audit(db, _get_platform_admin(request), f"marketplace_{action}", "market_app", app.id, app.name,
                          f"Marketplace app '{app.name}' {old} → {new}" + (f" ({app.status_reason})" if app.status_reason else ""), get_request_ip(request),
                          old_data={"status": old}, new_data={"status": new, "reason": app.status_reason})
    db.commit()
    return {"id": app.id, "status": new}


class PolicyBody(BaseModel):
    enabled: bool


@router.put("/policy/{key}")
def set_policy(key: str, body: PolicyBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _all_scope(request)
    try:
        old, new = mk.set_policy(db, key, body.enabled, _actor(request))
    except mk.MarketError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    if old != new:
        label = next(lbl for k, lbl, _ in mk.POLICY if k == key)
        _write_platform_audit(db, _get_platform_admin(request), "update_marketplace_policy", "platform_setting", None, "Marketplace policy",
                              f"Marketplace policy: {label} {'on' if new else 'off'}", get_request_ip(request), old_data={key: old}, new_data={key: new})
    db.commit()
    return {"key": key, "enabled": new}


class PublisherBody(BaseModel):
    name: str = Field(..., max_length=200)
    contact_email: str = Field("", max_length=200)


@router.post("/publishers", status_code=201)
def create_publisher(body: PublisherBody, request: Request, db: Session = Depends(get_master_db_dep)):
    """Register a publisher and return its API key once (backend-only; there is no developer portal screen)."""
    _all_scope(request)
    try:
        row, raw = mk.create_publisher(db, body.name, body.contact_email, _actor(request))
    except mk.MarketError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    _write_platform_audit(db, _get_platform_admin(request), "create_market_publisher", "market_publisher", row.id, row.name,
                          f"Marketplace publisher '{row.name}' registered (key {row.key_prefix}…)", get_request_ip(request), new_data={"key_prefix": row.key_prefix})
    db.commit()
    return {"id": row.id, "name": row.name, "key": raw, "note": "Store this key now – it is not shown again."}
