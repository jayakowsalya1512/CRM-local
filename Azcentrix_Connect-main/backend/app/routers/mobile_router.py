"""Mobile app API (for the Flutter app): configuration, version check, device registration and remote commands.

All routes need a signed-in tenant user (the tenant is the one the request is signed in to), except the version check,
which the app may call before sign-in.
"""

from __future__ import annotations

import hashlib
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import _resolve_tenant_slug, get_current_user
from app.models.all_models import User
from app.models.platform_mobile import PlatformMobileCommand, PlatformMobileDevice
from app.models.tenant import Tenant
from app.services import platform_mobile as mob

def _schema(master_db: Session = Depends(get_master_db_dep)) -> None:
    if mob.ensure_schema():
        master_db.rollback()


router = APIRouter(dependencies=[Depends(_schema)])


def _tenant(request: Request, master_db: Session) -> Tenant:
    tenant = master_db.query(Tenant).filter(Tenant.slug == _resolve_tenant_slug(request)).first()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return tenant


@router.get("/version-check")
def version_check(platform: str = Query(..., max_length=10), version: str = Query(..., max_length=20), device: str = Query("", max_length=128),
                  master_db: Session = Depends(get_master_db_dep)):
    try:
        return mob.version_check(master_db, platform, version, device)
    except mob.MobileError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))


@router.get("/config")
def config(request: Request, current_user: User = Depends(get_current_user), master_db: Session = Depends(get_master_db_dep)):
    return mob.app_config(master_db, _tenant(request, master_db))


class DeviceBody(BaseModel):
    device_id: str = Field(..., min_length=8, max_length=200)     # the app's stable install id (hashed before storage)
    platform: str
    model: str = Field("", max_length=120)
    os: str = Field("", max_length=60)
    app_version: str = Field("", max_length=20)
    integrity: Optional[str] = None                                # verified | compromised (from the app's attestation)


def _device_ref(raw: str) -> str:
    return hashlib.sha256(("mobile-device:" + raw).encode()).hexdigest()


@router.post("/devices")
def register_device(body: DeviceBody, request: Request, current_user: User = Depends(get_current_user), master_db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(request, master_db)
    mob.ensure_schema()
    if body.platform not in mob.PLATFORMS:
        raise HTTPException(status_code=422, detail="platform must be iOS or Android")
    if body.app_version:
        try:
            mob.parse_version(body.app_version)
        except mob.MobileError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
    ref = _device_ref(body.device_id)
    device = master_db.query(PlatformMobileDevice).filter(PlatformMobileDevice.tenant_id == tenant.id, PlatformMobileDevice.source == "app",
                                                          PlatformMobileDevice.source_ref == ref).first()
    if device is None:
        limit = mob.tenant_settings(master_db, [tenant])[tenant.id]["max_devices"]
        count = master_db.query(PlatformMobileDevice.id).filter(PlatformMobileDevice.tenant_id == tenant.id, PlatformMobileDevice.user_id == current_user.id,
                                                                PlatformMobileDevice.source == "app", PlatformMobileDevice.status != "Wiped").count()
        if count >= limit:
            raise HTTPException(status_code=409, detail=f"You already have {count} registered devices (limit {limit}). Ask your administrator to remove one.")
        device = PlatformMobileDevice(tenant_id=tenant.id, user_id=current_user.id, source="app", source_ref=ref, status="Active", created_at=datetime.utcnow())
        master_db.add(device)
    elif device.user_id != current_user.id:
        raise HTTPException(status_code=409, detail="This device is registered to another user")
    device.user_name, device.platform = current_user.full_name, body.platform
    device.model, device.os, device.app_version = body.model or None, body.os or None, body.app_version or None
    device.integrity = body.integrity if body.integrity in ("verified", "compromised") else None
    device.last_seen = datetime.utcnow()
    master_db.commit()
    check = mob.version_check(master_db, body.platform, body.app_version, ref) if body.app_version else None
    return {"device": device.id, "status": device.status, "version": check, "config": mob.app_config(master_db, tenant)}


def _own_device(master_db: Session, tenant: Tenant, device_id: str) -> PlatformMobileDevice:
    """Commands are authenticated by the device's install id (known only to the app, stored hashed), not by the user's
    session – a lock or wipe revokes the session, and the device must still be able to fetch and confirm the command."""
    device = master_db.query(PlatformMobileDevice).filter(PlatformMobileDevice.tenant_id == tenant.id, PlatformMobileDevice.source == "app",
                                                          PlatformMobileDevice.source_ref == _device_ref(device_id)).first()
    if device is None:
        raise HTTPException(status_code=404, detail="Device not registered")
    return device


@router.get("/commands")
def commands(request: Request, device_id: str = Query(..., min_length=8, max_length=200), master_db: Session = Depends(get_master_db_dep)):
    device = _own_device(master_db, _tenant(request, master_db), device_id)
    rows = master_db.query(PlatformMobileCommand).filter(PlatformMobileCommand.device_id == device.id, PlatformMobileCommand.status == "pending").all()
    return [{"id": c.id, "command": c.command, "requested_at": c.requested_at} for c in rows]


@router.post("/commands/{command_id}/ack")
def acknowledge(command_id: int, request: Request, device_id: str = Query(..., min_length=8, max_length=200), master_db: Session = Depends(get_master_db_dep)):
    """The app confirms it carried out the command – only now is a wipe reported as done."""
    device = _own_device(master_db, _tenant(request, master_db), device_id)
    cmd = master_db.get(PlatformMobileCommand, command_id)
    if cmd is None or cmd.device_id != device.id or cmd.status != "pending":
        raise HTTPException(status_code=404, detail="No pending command")
    cmd.status, cmd.acknowledged_at = "acknowledged", datetime.utcnow()
    if cmd.command == "wipe":
        device.status = "Wiped"
    master_db.commit()
    return {"id": cmd.id, "status": cmd.status, "device_status": device.status}
