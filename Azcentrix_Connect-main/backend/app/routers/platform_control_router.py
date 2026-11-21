"""Control Center: platform defaults and tenant overrides for every configurable platform control.

Paths sit under ``/settings/`` so the Settings permission of the caller's platform role applies (view to read,
manage to change). Changing the platform defaults needs all-tenant scope; tenant overrides need the tenant in scope.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.tenant import Tenant
from app.models.tenant_hierarchy import PlatformControlValue
from app.routers.platform_router import FourEyesUpdate, _get_platform_admin, _write_platform_audit, update_four_eyes
from app.services import platform_access
from app.services import platform_controls as controls
from app.services.platform_access import enforce_platform_access, require_tenant_in_scope, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform", dependencies=[Depends(enforce_platform_access)])

STATUS_LABELS = {
    "live": "Applied by the platform",
    "saved": "Saved and exported; not yet enforced by the platform",
    "planned": "Saved for a feature that is not available yet",
    "fixed": "Fixed by the self-hosted MariaDB architecture",
    "unsupported": "Not supported on self-hosted infrastructure",
}


class ControlUpdate(BaseModel):
    value: Any
    tenant_id: Optional[int] = None


class ControlReset(BaseModel):
    keys: list[str]
    tenant_id: Optional[int] = None


def _tenant(db: Session, request: Request, tenant_id: Optional[int]) -> Optional[Tenant]:
    if not tenant_id:
        return None
    require_tenant_in_scope(request, tenant_id)
    tenant = db.get(Tenant, tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return tenant


def _require_platform_scope(request: Request) -> None:
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail="Only staff with all-tenant scope can change platform defaults.")


def _actor(request: Request) -> str:
    admin = _get_platform_admin(request)
    return (admin.email or admin.name) if admin else "platform"


def _audit(db: Session, request: Request, action: str, tenant: Optional[Tenant], description: str, old: dict, new: dict) -> None:
    _write_platform_audit(db, _get_platform_admin(request), action, "tenant" if tenant else "platform_control",
                          tenant.id if tenant else None, tenant.name if tenant else "Platform defaults", description,
                          get_request_ip(request), old_data=old, new_data=new)


def _values_payload(db: Session, tenant: Optional[Tenant]) -> dict:
    scope = tenant.id if tenant else controls.PLATFORM_SCOPE
    rows = db.query(PlatformControlValue).filter(PlatformControlValue.tenant_id == scope).all()
    return {
        "platform": controls.platform_values(db),
        "overrides": controls.tenant_overrides(db, tenant.id) if tenant else None,
        "tenant": {"id": tenant.id, "name": tenant.name} if tenant else None,
        "updated": {r.control_key: {"by": r.updated_by, "at": r.updated_at.isoformat() if r.updated_at else None} for r in rows},
    }


@router.get("/settings/control/schema")
def control_schema(db: Session = Depends(get_master_db_dep)):
    return {"categories": controls.schema(db), "statuses": STATUS_LABELS}


@router.get("/settings/control/values")
def control_values(request: Request, tenant_id: Optional[int] = None, db: Session = Depends(get_master_db_dep)):
    return _values_payload(db, _tenant(db, request, tenant_id))


def _set_four_eyes(db: Session, request: Request, enabled: bool):
    """Four-eyes is the same platform setting as Platform Team → four-eyes; its rules (team permission, two managers,
    approval to turn off) apply here too."""
    if not platform_access.can(request.state.platform_access, "team", "manage"):
        raise HTTPException(status_code=403, detail="Changing four-eyes approval needs Platform Team manage permission.")
    return update_four_eyes(FourEyesUpdate(enabled=enabled), request, db)


def _set_platform_mfa(db: Session, request: Request, required: bool) -> None:
    """Require MFA for platform staff is the platform OTP policy's every-sign-in mode (one setting, two places)."""
    from app.services import platform_login_security
    old = platform_login_security.mfa_required(db)
    try:
        platform_login_security.set_mfa_required(db, required)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if old != required:
        _audit(db, request, "update_platform_control", None,
               f"Control center: Authentication policy → Require MFA for platform staff (platform default)", {"mfaPlat": old}, {"mfaPlat": required})


@router.put("/settings/control/values/{key}")
def update_control(key: str, data: ControlUpdate, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, request, data.tenant_id)
    if not tenant:
        _require_platform_scope(request)
    try:
        new_value = controls.coerce(db, key, data.value, tenant.id if tenant else None)
    except controls.ControlError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    c = controls.control(key)
    if key == "fourEyes":
        result = _set_four_eyes(db, request, new_value)
        if isinstance(result, JSONResponse):
            return result
        return _values_payload(db, None)
    if key == "mfaPlat":
        _set_platform_mfa(db, request, new_value)
        db.commit()
        return _values_payload(db, None)
    old, new = controls.store(db, key, new_value, tenant.id if tenant else controls.PLATFORM_SCOPE, _actor(request))
    if old != new:
        where = f"override for {tenant.name}" if tenant else "platform default"
        _audit(db, request, "update_platform_control", tenant, f"Control center: {c['category']} → {c['label']} ({where})",
               {key: old}, {key: new})
    db.commit()
    return _values_payload(db, tenant)


@router.post("/settings/control/reset")
def reset_controls(data: ControlReset, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, request, data.tenant_id)
    if not tenant:
        _require_platform_scope(request)
    if not data.keys:
        raise HTTPException(status_code=400, detail="Nothing to reset")
    try:
        for key in data.keys:
            controls.control(key)
    except controls.ControlError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    keys = list(data.keys)
    if not tenant and "fourEyes" in keys:
        keys.remove("fourEyes")
        default = controls.control("fourEyes")["default"]
        if platform_access.four_eyes_enabled(db) != default:
            result = _set_four_eyes(db, request, default)
            if isinstance(result, JSONResponse):
                return result
    if not tenant and "mfaPlat" in keys:
        keys.remove("mfaPlat")
        _set_platform_mfa(db, request, controls.control("mfaPlat")["default"])
    changed = controls.reset(db, keys, tenant.id if tenant else controls.PLATFORM_SCOPE)
    if changed:
        names = [controls.control(k)["label"] for k in changed]
        where = f"overrides for {tenant.name}" if tenant else "platform defaults"
        summary = names[0] if len(names) == 1 else f"{len(names)} controls"
        _audit(db, request, "reset_platform_control", tenant, f"Control center: reset {summary} ({where})",
               {k: v[0] for k, v in changed.items()}, {k: v[1] for k, v in changed.items()})
    db.commit()
    return _values_payload(db, tenant)


@router.get("/settings/control/export")
def export_controls(request: Request, tenant_id: Optional[int] = None, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, request, tenant_id)
    platform = controls.platform_values(db)
    overrides = controls.tenant_overrides(db, tenant.id) if tenant else {}
    categories = []
    for cat in controls.schema(db):
        groups = []
        for g in cat["groups"]:
            items = []
            for c in g["controls"]:
                effective = overrides.get(c["key"], platform[c["key"]])
                item = {"key": c["key"], "label": c["label"], "value": effective, "default": c["default"], "status": c["status"],
                        "changed": platform[c["key"]] != c["default"]}
                if tenant:
                    item["overridden"] = c["key"] in overrides
                items.append(item)
            groups.append({"name": g["name"], "controls": items})
        categories.append({"name": cat["name"], "groups": groups})
    body = {
        "scope": f"tenant:{tenant.slug}" if tenant else "platform",
        "tenant": tenant.name if tenant else None,
        "exported_at": datetime.utcnow().isoformat() + "Z",
        "exported_by": _actor(request),
        "categories": categories,
    }
    _audit(db, request, "export_platform_controls", tenant, "Control center configuration exported", {}, {"scope": body["scope"]})
    db.commit()
    name = f"control-config-{tenant.slug if tenant else 'platform'}-{datetime.utcnow():%Y%m%d}.json"
    return Response(json.dumps(body, indent=2, ensure_ascii=False), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})
