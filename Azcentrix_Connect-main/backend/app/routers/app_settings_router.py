"""Application settings (prototype v17 "p25" Settings page).  Mounted at /api/v1/app-settings

GET    /                      → schema + effective values (+ notification matrix, number series)   [settings.view]
PATCH  /{category}/{key}      → save one setting (autosave, prototype "Saved · <label>")            [settings.manage]
POST   /{category}/reset      → reset a section to defaults                                          [settings.manage]
GET    /history               → change history (paginated)                                           [settings.view]
GET    /billing               → plan, seats, usage, invoices                                         [settings.view]
GET    /devices               → registered (active) sign-in sessions                                 [settings.view]
DELETE /devices/{id}          → revoke a device                                                      [settings.manage]
POST   /branding/{logo|fav}   → upload company logo / favicon                                        [settings.manage]
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.logging import log_audit_db
from app.database import get_master_db_dep
from app.dependencies import get_current_user, get_request_ip, get_tenant_db, user_has_permission
from app.models.all_models import User
from app.models.tenant import Tenant
from app.services import app_settings_service as S
from app.services.storage_usage_service import ensure_tenant_storage_available, refresh_tenant_storage_usage_for_slug

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Application settings"])

ADMIN_ROLES = ("admin", "ceo")
MANAGER_ROLES = ("admin", "ceo", "manager", "vp")
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico"}


def _tenant(request: Request, master_db: Session) -> Optional[Tenant]:
    slug = getattr(request.state, "tenant_slug", None)
    return master_db.query(Tenant).filter(Tenant.slug == slug).first() if slug else None


def viewer(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if (cu.role or "") not in MANAGER_ROLES and not user_has_permission(db, cu, "settings.view") \
            and not user_has_permission(db, cu, "settings.manage"):
        raise HTTPException(403, "You don't have access to Settings")
    S.ensure_schema(db)
    return cu


def manager(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if (cu.role or "") not in ADMIN_ROLES and not user_has_permission(db, cu, "settings.manage"):
        raise HTTPException(403, "You don't have permission to change settings")
    S.ensure_schema(db)
    return cu


class ValueIn(BaseModel):
    value: Any = None


@router.get("/")
def get_all(request: Request, db: Session = Depends(get_tenant_db), master_db: Session = Depends(get_master_db_dep),
            cu: User = Depends(viewer)):
    payload = dict(S.load(db, _tenant(request, master_db)))
    payload["can_manage"] = (cu.role or "") in ADMIN_ROLES or user_has_permission(db, cu, "settings.manage")
    return payload


@router.patch("/{category}/{key}")
def save_one(category: str, key: str, body: ValueIn, request: Request, db: Session = Depends(get_tenant_db),
             master_db: Session = Depends(get_master_db_dep), cu: User = Depends(manager)):
    out = S.save(db, master_db, _tenant(request, master_db), cu, category, key, body.value)
    try:
        log_audit_db(db, cu.id, "settings", "update", None, get_request_ip(request),
                     f"{out['change']['s']} · {out['label']}: {out['change']['o']} → {out['change']['n']}")
        db.commit()
    except Exception as exc:  # pragma: no cover – audit must never block a save
        logger.warning("settings audit log failed: %s", exc)
        db.rollback()
    return out


@router.post("/{category}/reset")
def reset_section(category: str, request: Request, db: Session = Depends(get_tenant_db),
                  master_db: Session = Depends(get_master_db_dep), cu: User = Depends(manager)):
    out = S.reset(db, master_db, _tenant(request, master_db), cu, category)
    try:
        log_audit_db(db, cu.id, "settings", "update", None, get_request_ip(request), f"{S.CATEGORIES[category]['n']} reset to defaults")
        db.commit()
    except Exception as exc:  # pragma: no cover
        logger.warning("settings audit log failed: %s", exc)
        db.rollback()
    return out


@router.get("/history")
def get_history(offset: int = Query(0, ge=0), limit: int = Query(40, ge=1, le=100), category: Optional[str] = None,
                db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return S.history(db, offset, limit, category)


@router.get("/billing")
def get_billing(request: Request, db: Session = Depends(get_tenant_db), master_db: Session = Depends(get_master_db_dep),
                _: User = Depends(viewer)):
    return S.billing(db, master_db, _tenant(request, master_db))


@router.get("/devices")
def get_devices(db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return {"items": S.devices(db)}


@router.delete("/devices/{session_id}")
def revoke_device(session_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    S.revoke_device(db, cu, session_id)
    try:
        log_audit_db(db, cu.id, "settings", "update", session_id, get_request_ip(request), "Device session revoked from Settings")
        db.commit()
    except Exception:  # pragma: no cover
        db.rollback()
    return {"ok": True}


@router.post("/branding/{kind}")
async def upload_brand_file(kind: Literal["logo", "fav"], request: Request, file: UploadFile = File(...),
                            db: Session = Depends(get_tenant_db), master_db: Session = Depends(get_master_db_dep),
                            cu: User = Depends(manager)):
    """Company logo / favicon.  The logo is stored under the existing theme_logo key so the header & login page use it."""
    tenant = _tenant(request, master_db)
    if tenant is None:
        raise HTTPException(400, "Tenant context is required")
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in IMAGE_EXT:
        raise HTTPException(400, "Upload a PNG, JPG, GIF, WEBP, SVG or ICO file")
    contents = await file.read()
    if not contents:
        raise HTTPException(400, "Uploaded file is empty")
    max_bytes = max(1, settings.MAX_UPLOAD_SIZE_MB) * 1024 * 1024
    if len(contents) > max_bytes:
        raise HTTPException(400, f"File exceeds {settings.MAX_UPLOAD_SIZE_MB} MB limit")
    folder = Path(settings.UPLOAD_DIR).resolve() / "tenant_settings" / tenant.slug
    folder.mkdir(parents=True, exist_ok=True)
    name = ("theme_logo" if kind == "logo" else "favicon") + suffix
    target = folder / name
    old_size = target.stat().st_size if target.exists() else 0
    ensure_tenant_storage_available(tenant.slug, max(0, len(contents) - old_size))
    for stale in folder.glob(("theme_logo" if kind == "logo" else "favicon") + ".*"):
        if stale != target:
            stale.unlink(missing_ok=True)
    target.write_bytes(contents)
    refresh_tenant_storage_usage_for_slug(tenant.slug)
    web_path = f"/uploads/tenant_settings/{tenant.slug}/{name}"
    if kind == "logo":
        S._upsert_theme(db, "theme_logo", web_path)
    out = S.save(db, master_db, tenant, cu, "branding", kind, name)
    out["url"] = web_path
    return out
