"""Environments & sandboxes (platform_sandboxes).

Under ``/api/v1/platform/environments`` – Databases permission (view to read, manage to create, refresh, extend,
delete and promote). Tenant-scoped staff see and act on their own tenants only. Promotion follows Control Center
"Change-set promotion needs approval": while on it goes to the approval queue (another Databases manager approves).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.platform_sandbox import PlatformSandbox, PlatformSandboxChangeSet
from app.models.tenant import Tenant
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_sandboxes as sandboxes
from app.services.platform_access import enforce_platform_access, require_tenant_in_scope, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/environments", dependencies=[Depends(enforce_platform_access)])
PAGE = 25


def _fail(exc: Exception):
    raise HTTPException(status_code=getattr(exc, "status_code", 422), detail=str(exc))


def _schema(db: Session) -> None:
    """Create the tables before this request reads them; end the access check's older snapshot if that just happened."""
    if not sandboxes._ready["schema"]:
        sandboxes.ensure_schema()
        db.rollback()


def _sandbox(db: Session, request: Request, sandbox_id: int) -> PlatformSandbox:
    sb = db.get(PlatformSandbox, sandbox_id)
    if sb is None or sb.status in ("deleted", "expired"):
        raise HTTPException(status_code=404, detail="Sandbox not found")
    require_tenant_in_scope(request, sb.tenant_id)
    return sb


def _change_set(db: Session, request: Request, cs_id: int) -> PlatformSandboxChangeSet:
    cs = db.get(PlatformSandboxChangeSet, cs_id)
    if cs is None:
        raise HTTPException(status_code=404, detail="Change set not found")
    require_tenant_in_scope(request, cs.tenant_id)
    return cs


def _audit(db: Session, request: Request, action: str, sb: PlatformSandbox, description: str, **data) -> None:
    tenant_name = db.query(Tenant.name).filter(Tenant.id == sb.tenant_id).scalar()
    _write_platform_audit(db, _get_platform_admin(request), action, "sandbox", sb.id, sb.name, f"{tenant_name}: {description}", get_request_ip(request),
                          new_data={"tenant_id": sb.tenant_id, "database": sb.db_name, **data})


@router.get("")
def overview(request: Request, offset: int = Query(0, ge=0), limit: int = Query(PAGE, ge=1, le=100),
             cs_offset: int = Query(0, ge=0), cs_limit: int = Query(PAGE, ge=1, le=100), db: Session = Depends(get_master_db_dep)):
    _schema(db)
    return sandboxes.overview(db, scoped_tenant_ids(request), offset, limit, cs_offset, cs_limit)


class SandboxBody(BaseModel):
    tenant_id: int
    name: str = Field(..., max_length=200)
    source: str = Field(..., max_length=10)
    days: int
    confirm_unmasked: bool = False


@router.post("", status_code=202)
def create(body: SandboxBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    require_tenant_in_scope(request, body.tenant_id)
    admin = _get_platform_admin(request)
    is_super = bool((getattr(request.state, "platform_access", None) or {}).get("is_super_admin"))
    try:
        sb = sandboxes.create(db, admin, is_super, body.tenant_id, body.name, body.source, body.days, body.confirm_unmasked)
    except sandboxes.SandboxError as exc:
        db.rollback()
        _fail(exc)
    _audit(db, request, "sandbox_created", sb, f"Sandbox '{sb.name}' requested ({sandboxes.SOURCES[sb.source]}, expires {sb.expires_at:%d %b %Y}) – database {sb.db_name}"
           + (" · UNMASKED production copy authorised" if sb.source == "full" else ""), source=sb.source, expires=sb.expires_at.isoformat())
    db.commit()
    sandboxes.start(sb.id)
    return {"id": sb.id, "status": "Provisioning", "database": sb.db_name}


@router.post("/{sandbox_id}/refresh", status_code=202)
def refresh(sandbox_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    sb = _sandbox(db, request, sandbox_id)
    try:
        sandboxes.refresh(db, sb)
    except sandboxes.SandboxError as exc:
        db.rollback()
        _fail(exc)
    _audit(db, request, "sandbox_refresh_requested", sb, f"Sandbox '{sb.name}' refresh from {sandboxes.SOURCES[sb.source]} started")
    db.commit()
    sandboxes.start(sb.id, refresh=True)
    return {"id": sb.id, "status": "Refreshing"}


@router.post("/{sandbox_id}/extend")
def extend(sandbox_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    sb = _sandbox(db, request, sandbox_id)
    old = sb.expires_at
    try:
        new = sandboxes.extend(sb)
    except sandboxes.SandboxError as exc:
        _fail(exc)
    _audit(db, request, "sandbox_extended", sb, f"Sandbox '{sb.name}' extended from {old:%d %b %Y} to {new:%d %b %Y}", old=old.isoformat(), new=new.isoformat())
    db.commit()
    return {"id": sb.id, "expires_at": f"{new.replace(microsecond=0).isoformat()}Z"}


@router.delete("/{sandbox_id}")
def delete(sandbox_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    sb = _sandbox(db, request, sandbox_id)
    db_name = sb.db_name
    try:
        sandboxes.remove(db, sb)
    except sandboxes.SandboxError as exc:
        db.rollback()
        _fail(exc)
    _audit(db, request, "sandbox_deleted", sb, f"Sandbox '{sb.name}' deleted – database {db_name} and its account dropped (production untouched)")
    db.commit()
    return {"deleted": sandbox_id}


@router.post("/change-sets/{cs_id}/promote")
def promote(cs_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    cs = _change_set(db, request, cs_id)
    try:
        result = sandboxes.request_promotion(db, _get_platform_admin(request), cs, get_request_ip(request))
    except sandboxes.SandboxError as exc:
        db.rollback()
        _fail(exc)
    db.commit()
    return result


@router.post("/change-sets/{cs_id}/rollback")
def rollback(cs_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    cs = _change_set(db, request, cs_id)
    try:
        return sandboxes.rollback(db, _get_platform_admin(request), cs, get_request_ip(request))
    except sandboxes.SandboxError as exc:
        db.rollback()
        _fail(exc)
