"""Mobile app control (Mobile & ecosystem) – platform console API (platform_mobile).

Under ``/mobile`` (Tenants permission: view to read, manage to change). Tenant-scoped staff see and act on their own
tenants' devices and settings; releases, the security policy, minimum versions and all-tenant switches need all-tenant
scope. Destructive device actions (wipe, block) and forced updates / kill switch need ``confirm: true``.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.platform_mobile import PlatformMobileDevice, PlatformMobilePush, PlatformMobileRelease
from app.models.tenant import Tenant
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_mobile as mob
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids

def _schema(db: Session = Depends(get_master_db_dep)) -> None:
    # A transaction opened before the tables existed can't read them (MariaDB 1412): start a fresh one after creating.
    if mob.ensure_schema():
        db.rollback()


router = APIRouter(prefix="/api/v1/platform/mobile", dependencies=[Depends(enforce_platform_access), Depends(_schema)])
PAGE = 25


def _actor(request: Request) -> str:
    return getattr(_get_platform_admin(request), "email", None) or "platform admin"


def _audit(db: Session, request: Request, action: str, entity_type: str, entity_id, name, description: str, old=None, new=None) -> None:
    _write_platform_audit(db, _get_platform_admin(request), action, entity_type, entity_id, name, description, get_request_ip(request),
                          old_data=old, new_data=new)


def _fail(exc: mob.MobileError):
    raise HTTPException(status_code=exc.status_code, detail=str(exc))


def _all_scope(request: Request, what: str) -> None:
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail=f"{what} applies to every tenant – it needs all-tenant scope.")


def _tenants(db: Session, request: Request) -> list[Tenant]:
    allowed = scoped_tenant_ids(request)
    q = db.query(Tenant).filter(Tenant.status != "cancelled")
    if allowed is not None:
        q = q.filter(Tenant.id.in_(allowed or [0]))
    return q.order_by(Tenant.name).all()


@router.get("")
def overview(request: Request, db: Session = Depends(get_master_db_dep)):
    tenants = _tenants(db, request)
    unreachable = mob.sync_devices(db, tenants)
    data = mob.overview(db, tenants, scoped_tenant_ids(request))
    settings_by = mob.tenant_settings(db, tenants)
    active = db.query(PlatformMobileDevice.id).filter(PlatformMobileDevice.tenant_id.in_([t.id for t in tenants] or [0]), PlatformMobileDevice.status == "Active").count()
    s = mob.settings(db)
    return {**data, "active_devices": active, "releases": mob.releases(db),
            "settings": {"min_supported": s["min_supported"], "soft_prompt": s["soft_prompt"], "blocked": s["blocked"]},
            "policy": [{"key": k, "label": l, "type": t, "value": s["policy"].get(k), "enforcement": e} for k, l, t, _, e in mob.POLICY],
            "tenants": [{"id": t.id, "name": t.name, **settings_by[t.id]} for t in tenants],
            "unreachable": sorted(set(unreachable) | set(data["unreachable"])), "all_scope": scoped_tenant_ids(request) is None,
            "audiences": mob.AUDIENCES, "when": list(mob.WHEN)}


# ─── Devices ─────────────────────────────────────────────────────────────────

@router.get("/devices")
def devices(request: Request, q: str = Query("", max_length=100), offset: int = Query(0, ge=0), limit: int = Query(PAGE, ge=1, le=200),
            db: Session = Depends(get_master_db_dep)):
    return mob.devices_page(db, scoped_tenant_ids(request), q.strip(), offset, limit)


class DeviceAction(BaseModel):
    confirm: bool = False


def _do_device(db: Session, request: Request, device: PlatformMobileDevice, action: str) -> dict:
    tenant = db.get(Tenant, device.tenant_id)
    try:
        result = mob.device_action(db, device, tenant, action, _actor(request))
    except mob.MobileError as exc:
        _fail(exc)
    _audit(db, request, f"mobile_device_{action}", "tenant", tenant.id, tenant.name,
           f"Mobile device #{device.id} ({device.model or 'device'}, {device.user_name or 'user #' + str(device.user_id)}): {action}"
           + (" – wipe queued, done only when the app confirms" if action == "wipe" else ""), new=result)
    return result


@router.post("/devices/{device_id}/{action}")
def device_action(device_id: int, action: str, body: DeviceAction, request: Request, db: Session = Depends(get_master_db_dep)):
    mob.ensure_schema()
    device = db.get(PlatformMobileDevice, device_id)
    allowed = scoped_tenant_ids(request)
    if device is None or (allowed is not None and device.tenant_id not in allowed):
        raise HTTPException(status_code=404, detail="Device not found")
    if action in ("wipe", "block") and not body.confirm:
        raise HTTPException(status_code=422, detail=f"Confirm the {action} first")
    result = _do_device(db, request, device, action)
    db.commit()
    return {"id": device.id, **result}


class BulkAction(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=200)
    action: str
    confirm: bool = False


@router.post("/devices/bulk")
def bulk(body: BulkAction, request: Request, db: Session = Depends(get_master_db_dep)):
    if body.action not in ("lock", "wipe", "block"):
        raise HTTPException(status_code=422, detail="Bulk actions are lock, wipe and block")
    if body.action in ("wipe", "block") and not body.confirm:
        raise HTTPException(status_code=422, detail=f"Confirm the {body.action} first")
    allowed = scoped_tenant_ids(request)
    devices = db.query(PlatformMobileDevice).filter(PlatformMobileDevice.id.in_(body.ids)).all()
    done, skipped = [], []
    for d in devices:
        if allowed is not None and d.tenant_id not in allowed:
            skipped.append({"id": d.id, "reason": "outside your tenant scope"})
            continue
        try:
            _do_device(db, request, d, body.action)
            done.append(d.id)
        except HTTPException as exc:
            skipped.append({"id": d.id, "reason": exc.detail})
    db.commit()
    return {"done": done, "skipped": skipped, "missing": sorted(set(body.ids) - {d.id for d in devices})}


# ─── Tenant controls & branding ──────────────────────────────────────────────

class TenantChanges(BaseModel):
    changes: dict[str, Any]


@router.put("/tenants/{tenant_id}")
def update_tenant(tenant_id: int, body: TenantChanges, request: Request, db: Session = Depends(get_master_db_dep)):
    allowed = scoped_tenant_ids(request)
    tenant = db.get(Tenant, tenant_id)
    if tenant is None or (allowed is not None and tenant.id not in allowed):
        raise HTTPException(status_code=404, detail="Tenant not found")
    try:
        old, new = mob.update_tenant(db, tenant, body.changes, _actor(request))
    except mob.MobileError as exc:
        _fail(exc)
    _audit(db, request, "update_mobile_tenant", "tenant", tenant.id, tenant.name, f"Mobile settings changed for '{tenant.name}': {', '.join(new)}", old, new)
    db.commit()
    return mob.tenant_settings(db, [tenant])[tenant.id]


class AllTenants(BaseModel):
    enabled: bool
    confirm: bool = False


@router.post("/tenants/all")
def all_tenants(body: AllTenants, request: Request, db: Session = Depends(get_master_db_dep)):
    _all_scope(request, "Switching the mobile app for all tenants")
    if not body.confirm:
        raise HTTPException(status_code=422, detail="Confirm the change first")
    tenants = _tenants(db, request)
    for t in tenants:
        mob.update_tenant(db, t, {"enabled": body.enabled}, _actor(request))
    _audit(db, request, "update_mobile_all_tenants", "platform_setting", None, "Mobile app", f"Mobile app {'enabled' if body.enabled else 'disabled'} for all {len(tenants)} tenants",
           new={"enabled": body.enabled, "tenants": len(tenants)})
    db.commit()
    return {"enabled": body.enabled, "tenants": len(tenants)}


# ─── Releases & versions ─────────────────────────────────────────────────────

class ReleaseBody(BaseModel):
    version: str = Field(..., max_length=20)
    platform: str
    channel: str
    rollout: int = 10
    notes: str = Field("", max_length=500)


@router.post("/releases", status_code=201)
def create_release(body: ReleaseBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _all_scope(request, "A mobile release")
    try:
        row = mob.create_release(db, body.version, body.platform, body.channel, body.rollout, body.notes, _actor(request))
    except mob.MobileError as exc:
        _fail(exc)
    _audit(db, request, "create_mobile_release", "mobile_release", row.id, f"{row.version} {row.platform}",
           f"Mobile release {row.version} ({row.platform}, {row.channel}) recorded at {row.rollout}% rollout – not submitted to a store", new=mob.release_dict(row))
    db.commit()
    return mob.release_dict(row)


class Confirm(BaseModel):
    confirm: bool = False


@router.post("/releases/{release_id}/{action}")
def release_action(release_id: int, action: str, body: Confirm, request: Request, db: Session = Depends(get_master_db_dep)):
    _all_scope(request, "A mobile release")
    mob.ensure_schema()
    row = db.get(PlatformMobileRelease, release_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Release not found")
    if action in ("force", "block") and not body.confirm:
        raise HTTPException(status_code=422, detail="Confirm first")
    old = mob.release_dict(row)
    try:
        msg = mob.release_action(db, row, action, _actor(request))
    except mob.MobileError as exc:
        _fail(exc)
    _audit(db, request, f"mobile_release_{action}", "mobile_release", row.id, f"{row.version} {row.platform}", msg, old, mob.release_dict(row))
    db.commit()
    return {"message": msg, "release": mob.release_dict(row), "settings": {k: mob.settings(db)[k] for k in ("min_supported", "blocked")}}


class MinBody(BaseModel):
    platform: str
    version: str = Field(..., max_length=20)


@router.put("/min-supported")
def min_supported(body: MinBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _all_scope(request, "The minimum supported version")
    try:
        old, new = mob.set_min_supported(db, body.platform, body.version, _actor(request))
    except mob.MobileError as exc:
        _fail(exc)
    _audit(db, request, "update_mobile_min_version", "platform_setting", None, "Mobile minimum version", f"Minimum supported {body.platform} version set to {new}",
           {"min_supported": old}, {"platform": body.platform, "version": new})
    db.commit()
    return mob.settings(db)["min_supported"]


class Toggle(BaseModel):
    enabled: bool


@router.put("/soft-prompt")
def soft_prompt(body: Toggle, request: Request, db: Session = Depends(get_master_db_dep)):
    _all_scope(request, "The update prompt")
    old = mob.save_setting(db, "soft_prompt", body.enabled, _actor(request))
    _audit(db, request, "update_mobile_soft_prompt", "platform_setting", None, "Mobile update prompt",
           f"Soft “update available” prompt {'on' if body.enabled else 'off'}", {"soft_prompt": old}, {"soft_prompt": body.enabled})
    db.commit()
    return {"soft_prompt": body.enabled}


class PolicyBody(BaseModel):
    value: Any


@router.put("/policy/{key}")
def policy(key: str, body: PolicyBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _all_scope(request, "The mobile security policy")
    try:
        old, new = mob.set_policy(db, key, body.value, _actor(request))
    except mob.MobileError as exc:
        _fail(exc)
    label = next(p[1] for p in mob.POLICY if p[0] == key)
    if old != new:
        _audit(db, request, "update_mobile_policy", "platform_setting", None, "Mobile security policy", f"Mobile policy: {label} → {new}", {key: old}, {key: new})
    db.commit()
    return {"key": key, "value": new}


# ─── Push ────────────────────────────────────────────────────────────────────

@router.get("/pushes")
def pushes(request: Request, db: Session = Depends(get_master_db_dep)):
    mob.ensure_schema()
    rows = db.query(PlatformMobilePush).order_by(PlatformMobilePush.created_at.desc(), PlatformMobilePush.id.desc()).limit(50 if scoped_tenant_ids(request) is None else 0).all()
    return [mob.push_dict(p) for p in rows]


@router.get("/providers")
def providers(request: Request, db: Session = Depends(get_master_db_dep)):
    return mob.providers(db, _tenants(db, request))


class PushBody(BaseModel):
    audience: str = Field(..., max_length=40)
    when: str
    title: str = Field(..., max_length=200)
    message: str = Field(..., max_length=2000)


@router.post("/pushes", status_code=201)
def send_push(body: PushBody, request: Request, db: Session = Depends(get_master_db_dep)):
    if not body.audience.startswith("tenant:"):
        _all_scope(request, "A push to every tenant")
    try:
        p = mob.create_push(db, body.audience, body.when, body.title, body.message, scoped_tenant_ids(request), _actor(request))
    except mob.MobileError as exc:
        _fail(exc)
    what = "scheduled" if p.status == "scheduled" else f"sent: {p.accepted} of {p.targeted} accepted by FCM" + (f" ({p.error})" if p.error else "")
    _audit(db, request, "mobile_push" if p.status != "failed" else "mobile_push_failed", "mobile_push", p.id, p.title,
           f"Push “{p.title}” to {p.audience_label} {what}", new=mob.push_dict(p))
    db.commit()
    return mob.push_dict(p)
