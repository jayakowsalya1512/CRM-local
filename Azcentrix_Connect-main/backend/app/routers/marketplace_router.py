"""Marketplace APIs outside the platform console:

* Publisher API (``X-Publisher-Key: azp_…``): submit an app for review, list own apps.
* Scanner API (``X-Scanner-Signature: sha256=<HMAC of the body with MARKETPLACE_SCANNER_SECRET>``): post a code-scan result.
* Tenant API (signed-in tenant admins): browse, install and uninstall apps for their own tenant.
"""

from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import _resolve_tenant_slug, get_current_user, get_request_ip
from app.models.all_models import User
from app.models.platform_marketplace import PlatformMarketApp
from app.models.tenant import Tenant
from app.routers.platform_router import _write_platform_audit
from app.services import platform_marketplace as mk


def _schema(db: Session = Depends(get_master_db_dep)) -> None:
    if mk.ensure_schema():
        db.rollback()


router = APIRouter(dependencies=[Depends(_schema)])


def _fail(exc: mk.MarketError):
    raise HTTPException(status_code=exc.status_code, detail=str(exc))


# ─── Publisher ───────────────────────────────────────────────────────────────

def _publisher(db: Session, key: Optional[str]):
    pub = mk.publisher_for(db, key)
    if pub is None:
        raise HTTPException(status_code=401, detail="Invalid publisher key")
    return pub


class SubmitBody(BaseModel):
    name: str = Field(..., max_length=150)
    category: str
    scopes: list[str]
    price_monthly: int = 0
    private_tenant: Optional[str] = Field(None, max_length=100)    # tenant slug for a tenant-only app


@router.post("/publisher/apps", status_code=201)
def submit(body: SubmitBody, request: Request, x_publisher_key: Optional[str] = Header(None), db: Session = Depends(get_master_db_dep)):
    pub = _publisher(db, x_publisher_key)
    try:
        app = mk.submit_app(db, pub, body.name, body.category, body.scopes, body.price_monthly, body.private_tenant)
    except mk.MarketError as exc:
        _fail(exc)
    _write_platform_audit(db, None, "marketplace_app_submitted", "market_app", app.id, app.name,
                          f"Marketplace app '{app.name}' submitted by {pub.name} (scope review: {app.scope_review})", get_request_ip(request),
                          new_data={"scopes": app.scopes, "scope_findings": app.scope_findings, "price_monthly": app.price_monthly, "private": bool(app.private_tenant_id)})
    db.commit()
    return {"id": app.id, "status": app.status, "security": mk.security(app)["label"], "scope_findings": app.scope_findings or []}


@router.get("/publisher/apps")
def my_apps(x_publisher_key: Optional[str] = Header(None), db: Session = Depends(get_master_db_dep)):
    pub = _publisher(db, x_publisher_key)
    return [{"id": a.id, "name": a.name, "status": a.status, "status_reason": a.status_reason, "security": mk.security(a)["label"]}
            for a in db.query(PlatformMarketApp).filter(PlatformMarketApp.publisher_id == pub.id).all()]


# ─── Scanner ─────────────────────────────────────────────────────────────────

@router.post("/scanner/results")
async def scan_result(request: Request, x_scanner_signature: Optional[str] = Header(None), db: Session = Depends(get_master_db_dep)):
    raw = await request.body()
    try:
        mk.verify_scanner(raw, x_scanner_signature)
        data = json.loads(raw or b"{}")
        app = db.get(PlatformMarketApp, int(data.get("app_id", 0)))
        if app is None:
            raise mk.MarketError("App not found", 404)
        changed = mk.record_scan(db, app, str(data.get("result", "")), int(data.get("findings", 0) or 0))
    except (ValueError, TypeError):
        raise HTTPException(status_code=422, detail="Body must be JSON with app_id, result and findings")
    except mk.MarketError as exc:
        _fail(exc)
    _write_platform_audit(db, None, "marketplace_scan_result", "market_app", app.id, app.name,
                          f"Security scan of '{app.name}': {app.scan_result}" + (f" – {changed} automatically" if changed else ""), get_request_ip(request),
                          new_data={"result": app.scan_result, "findings": app.scan_findings, "status": app.status})
    db.commit()
    return {"id": app.id, "security": mk.security(app)["label"], "status": app.status}


# ─── Tenant ──────────────────────────────────────────────────────────────────

def _tenant(request: Request, db: Session) -> Tenant:
    tenant = db.query(Tenant).filter(Tenant.slug == _resolve_tenant_slug(request)).first()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return tenant


def _tenant_admin(request: Request, user: User, db: Session, verb: str) -> Tenant:
    if (user.role or "").lower() != "admin":
        raise HTTPException(status_code=403, detail=f"Only tenant administrators can {verb} apps")
    return _tenant(request, db)


@router.get("/apps")
def browse(request: Request, current_user: User = Depends(get_current_user), db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(request, db)
    return {"access": mk.tenant_access(db, tenant), "apps": mk.visible_apps(db, tenant)}


class InstallBody(BaseModel):
    accept_scopes: list[str]


@router.post("/apps/{app_id}/install", status_code=201)
def install(app_id: int, body: InstallBody, request: Request, current_user: User = Depends(get_current_user), db: Session = Depends(get_master_db_dep)):
    tenant = _tenant_admin(request, current_user, db, "install")
    app = db.get(PlatformMarketApp, app_id)
    if app is None:
        raise HTTPException(status_code=404, detail="This app is not available")
    try:
        row = mk.install(db, tenant, app, body.accept_scopes, current_user.id)
    except mk.MarketError as exc:
        db.rollback()
        _fail(exc)
    _write_platform_audit(db, None, "marketplace_app_installed", "tenant", tenant.id, tenant.name,
                          f"App '{app.name}' installed by {current_user.email or current_user.username} (scopes: {', '.join(row.scopes_granted)})", get_request_ip(request),
                          new_data={"app_id": app.id, "scopes": row.scopes_granted})
    db.commit()
    return {"app_id": app.id, "installed": True, "scopes": row.scopes_granted}


@router.delete("/apps/{app_id}/install")
def uninstall(app_id: int, request: Request, current_user: User = Depends(get_current_user), db: Session = Depends(get_master_db_dep)):
    tenant = _tenant_admin(request, current_user, db, "uninstall")
    try:
        mk.uninstall(db, tenant, app_id)
    except mk.MarketError as exc:
        _fail(exc)
    _write_platform_audit(db, None, "marketplace_app_uninstalled", "tenant", tenant.id, tenant.name, f"App #{app_id} uninstalled by {current_user.email or current_user.username}",
                          get_request_ip(request), new_data={"app_id": app_id})
    db.commit()
    return {"app_id": app_id, "installed": False}
