"""Tenants & Hierarchy module: parent groups, hierarchy, consolidated reporting and tenant detail tabs.

Reuses the existing tenant endpoints in platform_router (CRUD, suspend/reactivate, features,
backups, plan history, tenant audit logs) and adds only what those do not cover.
"""

from __future__ import annotations

import logging
import re
import secrets
from urllib.parse import urlparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, EmailStr, field_validator
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.database import get_master_db_dep, get_tenant_session
from app.dependencies import get_request_ip
from app.models.platform_backup import TenantBackup
from app.models.tenant import Plan, PlatformAuditLog, Tenant
from app.models.tenant_hierarchy import VISIBILITY_LEVELS, TenantExportJob, TenantGroup, TenantMigration
from app.routers.platform_router import TenantCreate, _get_platform_admin, _write_platform_audit, create_tenant
from app.services import platform_controls as controls
from app.services import platform_infrastructure, platform_traffic, platform_uptime
from app.services import tenant_hierarchy as hierarchy
from app.services import tenant_data_transfer as transfer
from app.services import tenant_migration as migrations
from app.services import tenant_onboarding
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids
from app.services.platform_backup_service import BACKUP_DIR
from app.services.platform_login_security import CAPTCHA_MODES, OTP_MODES

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/platform", dependencies=[Depends(enforce_platform_access)])
# Signed export download links are opened from email/browser without a platform session; the token is the credential.
public_router = APIRouter(prefix="/api/v1/platform")

DELETION_GRACE_DAYS = 30


# ─── Schemas ────────────────────────────────────────────────────────────────

class GroupCreate(BaseModel):
    name: str
    slug: Optional[str] = None
    industry: Optional[str] = None
    color: Optional[str] = None
    plan_id: Optional[int] = None
    default_visibility: Optional[str] = None  # None = Control center default parent visibility
    notes: Optional[str] = None

    @field_validator("default_visibility")
    @classmethod
    def _visibility(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and value not in VISIBILITY_LEVELS:
            raise ValueError("Visibility must be full, reports or none")
        return value


class GroupUpdate(BaseModel):
    name: Optional[str] = None
    industry: Optional[str] = None
    color: Optional[str] = None
    plan_id: Optional[int] = None
    default_visibility: Optional[str] = None
    notes: Optional[str] = None


class HierarchyUpdate(BaseModel):
    parent_group_id: Optional[int] = None
    parent_visibility: Optional[str] = None
    shared_masters: Optional[bool] = None
    inherit_parent_policies: Optional[bool] = None
    industry: Optional[str] = None
    color: Optional[str] = None
    detach: bool = False

    @field_validator("parent_visibility")
    @classmethod
    def _visibility(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and value not in VISIBILITY_LEVELS:
            raise ValueError("Visibility must be full, reports or none")
        return value


class UserStatusUpdate(BaseModel):
    is_active: bool


class MaintenanceRequest(BaseModel):
    action: str


class QueryRequest(BaseModel):
    sql: str


class DeletionRequest(BaseModel):
    confirm_name: str


class SecurityUpdate(BaseModel):
    otp_mode: Optional[str] = None
    captcha_mode: Optional[str] = None
    force_password_change_on_first_login: Optional[bool] = None
    new_device_login_alert_enabled: Optional[bool] = None
    forgot_password_enabled: Optional[bool] = None
    password_expiry_enabled: Optional[bool] = None
    password_expiry_days: Optional[int] = None
    inactivity_timeout_minutes: Optional[int] = None


# ─── Helpers ────────────────────────────────────────────────────────────────

def _scoped_tenants(request: Request, db: Session):
    query = db.query(Tenant)
    allowed = scoped_tenant_ids(request)
    if allowed is not None:
        query = query.filter(Tenant.id.in_(allowed or [0]))
    return query


def _tenant(db: Session, tenant_id: int) -> Tenant:
    tenant = db.get(Tenant, tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return tenant


def _group(request: Request, db: Session, group_id: int) -> TenantGroup:
    group = db.get(TenantGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Parent group not found")
    allowed = scoped_tenant_ids(request)
    if allowed is not None and not db.query(Tenant.id).filter(Tenant.parent_group_id == group_id, Tenant.id.in_(allowed or [0])).first():
        raise HTTPException(status_code=403, detail="This parent group is outside your assigned scope.")
    return group


def _require_all_scope(request: Request) -> None:
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail="Only staff with access to all tenants can manage parent groups.")


def _audit(db, request, action, entity_type, entity_id, entity_name, description, old=None, new=None):
    _write_platform_audit(db=db, admin=_get_platform_admin(request), action=action, entity_type=entity_type,
                          entity_id=entity_id, entity_name=entity_name, description=description,
                          ip=get_request_ip(request), old_data=old, new_data=new)


def _plans(db: Session) -> dict[int, Plan]:
    return {plan.id: plan for plan in db.query(Plan).all()}


def _mrr(tenant: Tenant, plans: dict[int, Plan]) -> int:
    plan = plans.get(tenant.plan_id)
    return int(plan.price_monthly or 0) if plan and tenant.status == "active" else 0


def _workspace_url(tenant: Tenant) -> Optional[str]:
    """Tenant sign-in URL: the tenant's subdomain on the configured frontend domain (None for single-host setups)."""
    parsed = urlparse(settings.FRONTEND_BASE_URL or "")
    labels = (parsed.hostname or "").split(".")
    if len(labels) < 3 or not tenant.subdomain:
        return None
    host = ".".join([tenant.subdomain, *labels[1:]])
    return f"{parsed.scheme}://{host}{f':{parsed.port}' if parsed.port else ''}/login"


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:90] or "group"


def _tenant_row(tenant: Tenant, plans, groups, placement, metrics) -> dict:
    plan = plans.get(tenant.plan_id)
    group = groups.get(tenant.parent_group_id)
    db_info = placement["databases"].get(tenant.db_name, {})
    return {
        "kind": "tenant",
        "id": tenant.id,
        "name": tenant.name,
        "slug": tenant.slug,
        "subdomain": tenant.subdomain,
        "type": "company" if group else "standalone",
        "parent_group_id": group.id if group else None,
        "parent_name": group.name if group else None,
        "parent_visibility": tenant.parent_visibility,
        "shared_masters": bool(tenant.shared_masters),
        "inherit_parent_policies": bool(tenant.inherit_parent_policies),
        "plan_id": tenant.plan_id,
        "plan_name": plan.name if plan else None,
        "industry": tenant.industry,
        "color": tenant.primary_color,
        "db_name": tenant.db_name,
        "server": db_info.get("server"),
        "db_size_mb": db_info.get("size_mb"),
        "db_available": tenant.db_name in placement["databases"],
        "users": metrics.get("users"),
        "active_users": metrics.get("active_users"),   # the count the tenant's user limit applies to
        "max_users": tenant.max_users,
        "storage_mb": round(float(tenant.used_storage or 0), 2),
        "storage_limit_mb": tenant.storage_limit_mb,
        "health": hierarchy.health_score(metrics),
        "weekly_active": metrics.get("weekly_active"),
        "tender_stages": metrics.get("tender_stages"),
        "workspace_url": _workspace_url(tenant),
        "mrr": _mrr(tenant, plans),
        "status": tenant.status,
        "deletion_scheduled_at": tenant.deletion_scheduled_at,
        "created_at": tenant.created_at,
    }


def _group_row(group: TenantGroup, children: list[dict], plans) -> dict:
    plan = plans.get(group.plan_id)
    return {
        "kind": "group",
        "id": group.id,
        "name": group.name,
        "slug": group.slug,
        "type": "group",
        "industry": group.industry,
        "color": group.color,
        "plan_id": group.plan_id,
        "plan_name": plan.name if plan else None,
        "default_visibility": group.default_visibility,
        "notes": group.notes,
        "children": len(children),
        "child_ids": [c["id"] for c in children],
        "users": sum(c["users"] or 0 for c in children),
        "storage_mb": round(sum(c["storage_mb"] for c in children), 2),
        "db_size_mb": round(sum(c["db_size_mb"] or 0 for c in children), 2),
        "mrr": sum(c["mrr"] for c in children),
        "status": group.status,
        "created_at": group.created_at,
    }


def _collect(request: Request, db: Session) -> tuple[list[dict], list[dict]]:
    tenants = _scoped_tenants(request, db).order_by(Tenant.name).all()
    plans = _plans(db)
    groups = {group.id: group for group in db.query(TenantGroup).order_by(TenantGroup.name).all()}
    placement = platform_infrastructure.database_placements()
    with ThreadPoolExecutor(max_workers=8) as pool:
        metrics = list(pool.map(hierarchy.tenant_metrics, tenants))
    rows = [_tenant_row(t, plans, groups, placement, m) for t, m in zip(tenants, metrics)]
    visible_group_ids = {r["parent_group_id"] for r in rows if r["parent_group_id"]}
    show_all_groups = scoped_tenant_ids(request) is None
    group_rows = [
        _group_row(group, [r for r in rows if r["parent_group_id"] == group.id], plans)
        for group in groups.values() if show_all_groups or group.id in visible_group_ids
    ]
    return rows, group_rows


# ─── List & hierarchy ───────────────────────────────────────────────────────

@router.get("/tenant-hierarchy")
def tenant_hierarchy(request: Request, db: Session = Depends(get_master_db_dep)):
    """Rows for the Table and Hierarchy views: every tenant plus every parent group."""
    tenants, groups = _collect(request, db)
    return {"tenants": tenants, "groups": groups}


@router.put("/tenants/{tenant_id}/hierarchy")
def update_tenant_hierarchy(tenant_id: int, data: HierarchyUpdate, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    old = {"parent_group_id": tenant.parent_group_id, "parent_visibility": tenant.parent_visibility,
           "shared_masters": tenant.shared_masters, "inherit_parent_policies": tenant.inherit_parent_policies, "industry": tenant.industry}
    if data.detach:
        tenant.parent_group_id = None
    elif data.parent_group_id is not None:
        group = _group(request, db, data.parent_group_id)
        if tenant.parent_group_id != group.id:
            # Control center → Hierarchy & groups / Naming & limits
            if not controls.value(db, "grpEnable"):
                raise HTTPException(status_code=409, detail="Parent-group tenants are turned off in Control center")
            limit = controls.value(db, "maxGroupKids")
            if limit and db.query(Tenant).filter(Tenant.parent_group_id == group.id).count() >= limit:
                raise HTTPException(status_code=409, detail=f"'{group.name}' already has the maximum of {limit} companies (Control center)")
            if data.parent_visibility is None:
                tenant.parent_visibility = group.default_visibility
            if data.shared_masters is None:
                tenant.shared_masters = bool(controls.value(db, "grpShareMaster", tenant.id))
        tenant.parent_group_id = group.id
    if data.shared_masters and not controls.value(db, "grpShareMaster", tenant.id):
        raise HTTPException(status_code=409, detail="Shared master data across companies is turned off in Control center")
    for field in ("parent_visibility", "shared_masters", "inherit_parent_policies", "industry"):
        value = getattr(data, field)
        if value is not None:
            setattr(tenant, field, value)
    if data.color is not None:
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", data.color):
            raise HTTPException(status_code=422, detail="Brand colour must be a hex colour like #5646C2")
        old["primary_color"] = tenant.primary_color
        tenant.primary_color = data.color
    new = {key: getattr(tenant, key) for key in old}
    if new != old:
        _audit(db, request, "update_tenant_hierarchy", "tenant", tenant.id, tenant.name, f"Hierarchy updated for '{tenant.slug}'", old, new)
    db.commit()
    return new


class PushWorkflowRequest(BaseModel):
    source_tenant_id: int
    tenant_ids: list[int]
    rule_ids: Optional[list[int]] = None


class AnnouncementRequest(BaseModel):
    tenant_ids: list[int]
    title: str
    message: str


def _scoped_ids(request: Request, db: Session, ids: list[int]) -> list[Tenant]:
    tenants = _scoped_tenants(request, db).filter(Tenant.id.in_(ids or [0])).all()
    if len(tenants) != len(set(ids)):
        raise HTTPException(status_code=403, detail="One or more tenants are outside your scope or do not exist.")
    return tenants


@router.get("/tenant-hierarchy/servers")
def hierarchy_servers():
    """Database servers available as a target for Move cluster."""
    placement = platform_infrastructure.database_placements()
    counts: dict[str, int] = {}
    for info in placement["databases"].values():
        counts[info["server"]] = counts.get(info["server"], 0) + 1
    return [{"name": name, **{k: v for k, v in s.items() if k != "health"}, "status": (s["health"] or {}).get("status"), "databases": counts.get(name, 0)}
            for name, s in placement["servers"].items()]


@router.get("/tenant-hierarchy/onboarding")
def onboarding_pipeline(request: Request, db: Session = Depends(get_master_db_dep)):
    """Onboarding & Provisioning: blueprint progress per tenant plus pipeline KPIs."""
    tenants = _scoped_tenants(request, db).order_by(Tenant.created_at.desc()).all()
    return tenant_onboarding.pipeline(db, tenants, _workspace_url)


class WizardTenantCreate(BaseModel):
    name: str
    subdomain: str
    plan_id: Optional[int] = None
    feature_ids: list[int] = []
    admin_name: str
    admin_email: EmailStr


@router.post("/tenant-hierarchy/tenants", status_code=201)
def wizard_create_tenant(data: WizardTenantCreate, request: Request, db: Session = Depends(get_master_db_dep)):
    """New-tenant wizard: tenant record, MariaDB database, tables, modules and administrator.

    Delegates to the existing platform create_tenant (which rolls the record back if provisioning fails).
    The administrator gets an unguessable server-side password and signs in only through the invitation link.
    """
    _require_all_scope(request)
    name, sub = data.name.strip(), data.subdomain.strip().lower()
    if not name or not data.admin_name.strip():
        raise HTTPException(status_code=422, detail="Enter the tenant name and the first admin's name")
    plan = db.get(Plan, data.plan_id) if data.plan_id else None
    if data.plan_id and not plan:
        raise HTTPException(status_code=422, detail="Plan not found")
    # Control center → Tenancy & provisioning
    pattern = controls.value(db, "slugPattern")
    if pattern and not re.fullmatch(pattern, sub):
        raise HTTPException(status_code=422, detail=f"Sub-domain '{sub}' does not match the tenant slug pattern {pattern} (Control center)")
    limit = controls.value(db, "maxTenants")
    if limit and db.query(Tenant).count() >= limit:
        raise HTTPException(status_code=409, detail=f"The platform has reached its maximum of {limit} tenants (Control center)")
    on_trial = controls.value(db, "trialAuto")
    payload = TenantCreate(
        name=name, slug=sub, subdomain=sub, admin_email=data.admin_email, admin_name=data.admin_name.strip(),
        admin_password=secrets.token_urlsafe(32) + "aA1!", plan_id=data.plan_id, max_users=plan.max_users if plan else 5,
        selected_feature_ids=data.feature_ids or None, trial_days=int(controls.value(db, "trialDays")),
        billing_status="trial" if on_trial else "active",
    )
    tenant = create_tenant(payload, request, db)
    if not on_trial:
        tenant.status, tenant.trial_ends_at = "active", None
        db.commit()
    return {"id": tenant.id, "slug": tenant.slug, "db_name": tenant.db_name, "status": tenant.status}


@router.post("/tenants/{tenant_id}/invite-admin")
def invite_tenant_admin(tenant_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    admin = _get_platform_admin(request)
    actor = (getattr(admin, "full_name", None) or getattr(admin, "email", None)) if admin else "platform admin"
    try:
        note = tenant_onboarding.send_admin_invitation(db, request, tenant, actor)
    except tenant_onboarding.InvitationError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    _audit(db, request, "invite_tenant_admin", "tenant", tenant.id, tenant.name, note)
    db.commit()
    return {"message": note}


@router.post("/tenants/{tenant_id}/onboarding/workflow-blank")
def record_blank_workflow(tenant_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    admin = _get_platform_admin(request)
    actor = (getattr(admin, "full_name", None) or getattr(admin, "email", None)) if admin else "platform admin"
    tenant_onboarding.record_workflow_choice(db, tenant, actor, "Blank template selected in the new-tenant wizard")
    return {"recorded": True}


class BlueprintStepUpdate(BaseModel):
    enabled: bool


@router.put("/tenant-hierarchy/onboarding/blueprint/{step_key}")
def update_blueprint_step(step_key: str, data: BlueprintStepUpdate, request: Request, db: Session = Depends(get_master_db_dep)):
    """Switch a provisioning-blueprint step on or off for every tenant's pipeline."""
    _require_all_scope(request)
    try:
        tenant_onboarding.set_step_enabled(db, step_key, data.enabled)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    label = next(label for key, label, _ in tenant_onboarding.STEPS if key == step_key)
    _audit(db, request, "update_onboarding_blueprint", "platform_setting", None, label,
           f"Blueprint step '{label}' {'enabled' if data.enabled else 'disabled'}", None, {"step": step_key, "enabled": data.enabled})
    db.commit()
    return {"key": step_key, "enabled": data.enabled}


@router.post("/tenants/{tenant_id}/onboarding/next")
def onboarding_run_next_step(tenant_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    admin = _get_platform_admin(request)
    actor = (getattr(admin, "full_name", None) or getattr(admin, "email", None)) if admin else "platform admin"
    try:
        result = tenant_onboarding.run_next_step(db, tenant, actor, _workspace_url(tenant))
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    if result["step"]:
        _audit(db, request, "onboarding_step", "tenant", tenant.id, tenant.name, f"Onboarding step '{result['step']}' completed for '{tenant.slug}'")
        db.commit()
    return result


@router.get("/tenants/{tenant_id}/workflow-templates")
def tenant_workflow_templates(tenant_id: int, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    try:
        return hierarchy.workflow_rules(tenant)
    except Exception:
        raise HTTPException(status_code=503, detail="Tenant database is unreachable")


@router.post("/tenant-hierarchy/push-workflow")
def push_workflow_template(data: PushWorkflowRequest, request: Request, db: Session = Depends(get_master_db_dep)):
    """Copy role-based approval rules from a source tenant into the selected tenants."""
    source = _scoped_ids(request, db, [data.source_tenant_id])[0]
    targets = [t for t in _scoped_ids(request, db, data.tenant_ids) if t.id != source.id]
    results = []
    for target in targets:
        try:
            result = hierarchy.push_workflow_rules(source, target, data.rule_ids)
        except Exception as exc:
            logger.exception("Workflow push to %s failed", target.slug)
            result = {"tenant_id": target.id, "tenant": target.name, "copied": [], "skipped": [], "error": str(exc)}
        results.append(result)
        _audit(db, request, "push_workflow_template", "tenant", target.id, target.name,
               f"Approval workflows pushed from '{source.slug}': {len(result['copied'])} copied, {len(result['skipped'])} kept",
               None, {"source_tenant_id": source.id, "copied": result["copied"], "skipped": result["skipped"]})
    db.commit()
    return {"results": results}


@router.post("/tenant-hierarchy/announce")
def send_tenant_announcement(data: AnnouncementRequest, request: Request, db: Session = Depends(get_master_db_dep)):
    """Send an in-app announcement to every active user of the selected tenants."""
    title, message = data.title.strip(), data.message.strip()
    if not title or not message:
        raise HTTPException(status_code=422, detail="Enter a title and a message")
    results = []
    for tenant in _scoped_ids(request, db, data.tenant_ids):
        try:
            sent = hierarchy.send_announcement(tenant, title[:200], message)
            results.append({"tenant_id": tenant.id, "tenant": tenant.name, "recipients": sent})
            _audit(db, request, "send_announcement", "tenant", tenant.id, tenant.name, f"Announcement '{title[:80]}' sent to {sent} users", None, {"title": title, "message": message})
        except Exception as exc:
            logger.exception("Announcement to %s failed", tenant.slug)
            results.append({"tenant_id": tenant.id, "tenant": tenant.name, "recipients": 0, "error": str(exc)})
    db.commit()
    return {"results": results}


# ─── Parent groups ──────────────────────────────────────────────────────────

@router.get("/tenant-groups")
def list_groups(request: Request, db: Session = Depends(get_master_db_dep)):
    return _collect(request, db)[1]


@router.post("/tenant-groups", status_code=201)
def create_group(data: GroupCreate, request: Request, db: Session = Depends(get_master_db_dep)):
    _require_all_scope(request)
    if not controls.value(db, "grpEnable"):
        raise HTTPException(status_code=409, detail="Parent-group tenants are turned off in Control center")
    name = data.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Enter a parent group name")
    slug = _slugify(data.slug or name)
    if db.query(TenantGroup).filter(TenantGroup.slug == slug).first():
        raise HTTPException(status_code=409, detail=f"A parent group with slug '{slug}' already exists")
    if data.plan_id is not None and not db.get(Plan, data.plan_id):
        raise HTTPException(status_code=422, detail="Plan not found")
    group = TenantGroup(name=name, slug=slug, industry=data.industry, color=data.color, plan_id=data.plan_id,
                        default_visibility=data.default_visibility or controls.visibility_code(db), notes=data.notes)
    db.add(group)
    db.flush()
    _audit(db, request, "create_tenant_group", "tenant_group", group.id, group.name, f"Parent group '{slug}' created", None, {"name": name, "slug": slug})
    db.commit()
    return {"id": group.id, "slug": group.slug}


@router.get("/tenant-groups/{group_id}")
def get_group(group_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    group = _group(request, db, group_id)
    tenants, groups = _collect(request, db)
    row = next(g for g in groups if g["id"] == group.id)
    return {**row, "companies": [t for t in tenants if t["parent_group_id"] == group.id]}


@router.put("/tenant-groups/{group_id}")
def update_group(group_id: int, data: GroupUpdate, request: Request, db: Session = Depends(get_master_db_dep)):
    _require_all_scope(request)
    group = _group(request, db, group_id)
    changes = data.model_dump(exclude_unset=True)
    if "default_visibility" in changes and changes["default_visibility"] not in VISIBILITY_LEVELS:
        raise HTTPException(status_code=422, detail="Visibility must be full, reports or none")
    if changes.get("plan_id") is not None and not db.get(Plan, changes["plan_id"]):
        raise HTTPException(status_code=422, detail="Plan not found")
    old = {key: getattr(group, key) for key in changes}
    for key, value in changes.items():
        setattr(group, key, value.strip() if key == "name" and value else value)
    _audit(db, request, "update_tenant_group", "tenant_group", group.id, group.name, f"Parent group '{group.slug}' updated", old, changes)
    db.commit()
    return {"id": group.id}


@router.post("/tenant-groups/{group_id}/suspend")
def suspend_group(group_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    _require_all_scope(request)
    group = _group(request, db, group_id)
    group.status = "suspended"
    _audit(db, request, "suspend_tenant_group", "tenant_group", group.id, group.name, f"Parent group '{group.slug}' suspended", None, {"status": "suspended"})
    db.commit()
    return {"status": group.status}


@router.post("/tenant-groups/{group_id}/reactivate")
def reactivate_group(group_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    _require_all_scope(request)
    group = _group(request, db, group_id)
    group.status = "active"
    _audit(db, request, "reactivate_tenant_group", "tenant_group", group.id, group.name, f"Parent group '{group.slug}' reactivated", None, {"status": "active"})
    db.commit()
    return {"status": group.status}


@router.delete("/tenant-groups/{group_id}")
def delete_group(group_id: int, data: DeletionRequest, request: Request, db: Session = Depends(get_master_db_dep)):
    _require_all_scope(request)
    group = _group(request, db, group_id)
    if data.confirm_name.strip() != group.name:
        raise HTTPException(status_code=422, detail="Name does not match")
    if db.query(Tenant.id).filter(Tenant.parent_group_id == group.id).first():
        raise HTTPException(status_code=409, detail="Detach every company from this group before deleting it")
    _audit(db, request, "delete_tenant_group", "tenant_group", group.id, group.name, f"Parent group '{group.slug}' deleted")
    db.delete(group)
    db.commit()
    return {"deleted": True}


@router.get("/tenant-groups/{group_id}/report")
def group_report(group_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    """Consolidated group reporting. Companies with visibility 'none' are excluded (tenant isolation)."""
    group = _group(request, db, group_id)
    children = _scoped_tenants(request, db).filter(Tenant.parent_group_id == group.id).order_by(Tenant.name).all()
    visible = [t for t in children if t.parent_visibility in ("full", "reports")]
    with ThreadPoolExecutor(max_workers=8) as pool:
        metrics = list(pool.map(lambda t: hierarchy.tenant_metrics(t, records=True), visible))
    placement = platform_infrastructure.database_placements()
    plans = _plans(db)
    companies = []
    for tenant, m in zip(visible, metrics):
        companies.append({
            "id": tenant.id, "name": tenant.name, "visibility": tenant.parent_visibility, "status": tenant.status,
            "available": m["available"], "users": m["users"], "weekly_active": m["weekly_active"], "active_sessions": m["active_sessions"],
            "records": m["records"], "storage_mb": round(float(tenant.used_storage or 0), 2),
            "db_size_mb": placement["databases"].get(tenant.db_name, {}).get("size_mb"), "mrr": _mrr(tenant, plans),
        })
    record_labels = [label for _, label in hierarchy.RECORD_TABLES]
    totals = {
        "users": sum(c["users"] or 0 for c in companies),
        "weekly_active": sum(c["weekly_active"] or 0 for c in companies),
        "active_sessions": sum(c["active_sessions"] or 0 for c in companies),
        "storage_mb": round(sum(c["storage_mb"] for c in companies), 2),
        "db_size_mb": round(sum(c["db_size_mb"] or 0 for c in companies), 2),
        "mrr": sum(c["mrr"] for c in companies),
        "records": {label: sum(c["records"].get(label, 0) for c in companies) for label in record_labels},
    }
    excluded = [{"id": t.id, "name": t.name, "reason": "Parent visibility is None (fully isolated)"} for t in children if t not in visible]
    return {"generated_at": datetime.now().isoformat(), "record_labels": record_labels, "companies": companies, "totals": totals, "excluded": excluded}


@router.get("/tenant-groups/{group_id}/users")
def group_users(group_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    """Users of companies whose parent visibility is 'full' (data & workspace access)."""
    group = _group(request, db, group_id)
    children = _scoped_tenants(request, db).filter(Tenant.parent_group_id == group.id).order_by(Tenant.name).all()
    users, hidden = [], []
    for tenant in children:
        if tenant.parent_visibility != "full":
            hidden.append({"id": tenant.id, "name": tenant.name, "visibility": tenant.parent_visibility})
            continue
        users.extend({**u, "tenant_id": tenant.id, "company": tenant.name} for u in _tenant_users(tenant))
    return {"users": users, "hidden_companies": hidden}


@router.get("/tenant-groups/{group_id}/audit")
def group_audit(group_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    group = _group(request, db, group_id)
    return _audit_rows(db, "tenant_group", group.id)


# ─── Tenant detail tabs ─────────────────────────────────────────────────────

def _placement_for(tenant: Tenant) -> tuple[Optional[str], dict, dict]:
    placement = platform_infrastructure.database_placements()
    info = placement["databases"].get(tenant.db_name, {})
    server = info.get("server")
    return server, info, placement["servers"].get(server, {}) if server else {}


@router.get("/tenants/{tenant_id}/overview")
def tenant_overview(tenant_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    plans = _plans(db)
    plan = plans.get(tenant.plan_id)
    group = db.get(TenantGroup, tenant.parent_group_id) if tenant.parent_group_id else None
    server, db_info, server_info = _placement_for(tenant)
    metrics = hierarchy.tenant_metrics(tenant, records=True)
    last_backup = db.query(TenantBackup).filter(TenantBackup.tenant_id == tenant.id, TenantBackup.status == "completed").order_by(TenantBackup.completed_at.desc()).first()
    return {
        "id": tenant.id, "name": tenant.name, "slug": tenant.slug, "subdomain": tenant.subdomain, "status": tenant.status,
        "type": "company" if group else "standalone", "parent_group_id": group.id if group else None, "parent_name": group.name if group else None,
        "industry": tenant.industry, "color": tenant.primary_color, "created_at": tenant.created_at, "trial_ends_at": tenant.trial_ends_at,
        "admin_name": tenant.admin_name, "admin_email": tenant.admin_email,
        "plan": {"id": plan.id, "name": plan.name, "price_monthly": plan.price_monthly, "max_users": plan.max_users} if plan else None,
        "db_name": tenant.db_name, "server": server, "server_ip": server_info.get("ip"), "region": server_info.get("region"),
        "db_size_mb": db_info.get("size_mb"), "db_available": bool(db_info),
        "max_users": tenant.max_users, "storage_mb": round(float(tenant.used_storage or 0), 2), "storage_limit_mb": tenant.storage_limit_mb,
        "metrics": metrics, "health": hierarchy.health_score(metrics), "mrr": _mrr(tenant, plans),
        "last_backup_at": last_backup.completed_at if last_backup else None,
        "deletion_scheduled_at": tenant.deletion_scheduled_at, "maintenance_mode": tenant.maintenance_mode,
    }


# Tenant settings that override a platform default (column default on the Tenant model).
_OVERRIDE_SECTIONS = [
    ("Session & sign-in", [("normal_login_expiry_minutes", "Login session length (min)"), ("remember_me_expiry_minutes", "Remember-me session (min)"),
                           ("inactivity_timeout_minutes", "Inactivity timeout (min)"), ("session_warning_minutes", "Session warning (min)")]),
    ("Authentication policy", [("otp_mode", "OTP verification"), ("captcha_mode", "CAPTCHA"), ("force_password_change_on_first_login", "Force password change on first login"),
                               ("new_device_login_alert_enabled", "New device login alert"), ("password_expiry_enabled", "Password expiry"), ("password_expiry_days", "Password expiry (days)")]),
    ("Password recovery", [("forgot_password_enabled", "Forgot password"), ("self_service_reset_limit_count", "Self-service resets allowed"),
                           ("self_service_reset_limit_days", "Reset window (days)"), ("forgot_password_send_max_attempts", "Reset emails per window"),
                           ("forgot_password_send_window_minutes", "Reset email window (min)"), ("forgot_password_ip_max_attempts", "Reset attempts per IP"),
                           ("forgot_password_ip_window_minutes", "IP window (min)")]),
    ("Metering & quotas", [("max_users", "Maximum users"), ("storage_limit_mb", "Storage limit (MB)")]),
    ("Email, SMS & messaging", [("smtp_use_tls", "SMTP TLS"), ("smtp_use_ssl", "SMTP SSL")]),
    ("Tenancy & provisioning", [("maintenance_mode", "Maintenance mode"), ("country", "Country")]),
]


@router.get("/tenants/{tenant_id}/settings-overrides")
def tenant_settings_overrides(tenant_id: int, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    columns = Tenant.__table__.columns
    sections = []
    for title, fields in _OVERRIDE_SECTIONS:
        rows = []
        for key, label in fields:
            default = columns[key].default.arg if columns[key].default is not None else None
            default = None if callable(default) else default
            value = getattr(tenant, key)
            rows.append({"key": key, "label": label, "platform_default": default, "value": value, "overridden": default is not None and value != default})
        sections.append({"title": title, "settings": rows})
    return {"sections": sections}


@router.get("/tenants/{tenant_id}/database")
def tenant_database(tenant_id: int, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    server, _, server_info = _placement_for(tenant)
    try:
        details = hierarchy.database_details(tenant)
    except Exception as exc:
        logger.warning("Database details failed for %s: %s", tenant.slug, exc)
        raise HTTPException(status_code=503, detail="Tenant database is unreachable")
    last_backup = db.query(TenantBackup).filter(TenantBackup.tenant_id == tenant.id, TenantBackup.status == "completed").order_by(TenantBackup.completed_at.desc()).first()
    return {**details, "server": server, "server_ip": server_info.get("ip"), "last_backup_at": last_backup.completed_at if last_backup else None}


@router.post("/tenants/{tenant_id}/database/maintenance")
def tenant_database_maintenance(tenant_id: int, data: MaintenanceRequest, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    if data.action not in ("analyze", "optimize", "schema_sync"):
        raise HTTPException(status_code=422, detail="Unknown maintenance action")
    try:
        result = hierarchy.run_maintenance(tenant, data.action)
    except Exception as exc:
        logger.exception("Maintenance %s failed for %s", data.action, tenant.slug)
        raise HTTPException(status_code=500, detail=f"Maintenance failed: {exc}")
    _audit(db, request, f"db_{data.action}", "tenant", tenant.id, tenant.name, f"{result['message']} on {tenant.db_name}")
    db.commit()
    return result


@router.post("/tenants/{tenant_id}/database/query")
def tenant_database_query(tenant_id: int, data: QueryRequest, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    try:
        result = hierarchy.run_readonly_query(tenant, data.sql)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc.args[-1] if getattr(exc, "args", None) else exc))
    _audit(db, request, "db_readonly_query", "tenant", tenant.id, tenant.name, f"Read-only query on {tenant.db_name}", None, {"sql": data.sql[:2000]})
    db.commit()
    return result


@router.get("/tenants/{tenant_id}/monitoring")
def tenant_monitoring(tenant_id: int, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    server, _, _ = _placement_for(tenant)
    metrics = hierarchy.tenant_metrics(tenant)
    uptime = platform_uptime.uptime([server]) if server else {"servers": {}, "tracked_minutes": 0}
    return {
        "traffic": platform_traffic.tenant_snapshot(tenant.slug, controls.value(db, "sloLat", tenant.id)),
        "active_sessions": metrics.get("active_sessions"),
        "server": server,
        "uptime_30d": uptime["servers"].get(server) if server else None,
        "uptime_tracked_minutes": uptime.get("tracked_minutes", 0),
        "availability": platform_uptime.daily_availability(server) if server else [],
        "targets": {"p95_ms": controls.value(db, "sloLat", tenant.id), "sla_percent": controls.value(db, "sloAvail", tenant.id)},
    }


@router.get("/tenants/{tenant_id}/backups")
def tenant_backups(tenant_id: int, db: Session = Depends(get_master_db_dep)):
    _tenant(db, tenant_id)
    rows = db.query(TenantBackup).filter(TenantBackup.tenant_id == tenant_id).order_by(TenantBackup.created_at.desc()).all()
    result = []
    for b in rows:
        path = (BACKUP_DIR / b.file_name) if b.file_name else None
        exists = bool(path and path.is_file())
        result.append({"id": b.id, "name": b.name, "status": b.status, "frequency": b.frequency, "created_at": b.created_at,
                       "completed_at": b.completed_at, "next_run_at": b.next_run_at, "error": b.error, "available": exists,
                       "size_mb": round(path.stat().st_size / 1024 ** 2, 2) if exists else None})
    return result


@router.post("/backups/{backup_id}/restore")
def restore_tenant_backup(backup_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    """Restore a backup into a new database `<db>_restore_<timestamp>`; the live database is untouched."""
    backup = db.get(TenantBackup, backup_id)
    if not backup:
        raise HTTPException(status_code=404, detail="Backup not found")
    allowed = scoped_tenant_ids(request)
    if allowed is not None and backup.tenant_id not in allowed:
        raise HTTPException(status_code=403, detail="This tenant is outside your assigned scope.")
    tenant = _tenant(db, backup.tenant_id)
    if backup.status != "completed" or not backup.file_name:
        raise HTTPException(status_code=409, detail="Only completed backups can be restored")
    try:
        target = hierarchy.restore_backup(tenant, BACKUP_DIR / backup.file_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.exception("Restore of backup %s failed", backup_id)
        raise HTTPException(status_code=500, detail=f"Restore failed: {exc}")
    _audit(db, request, "restore_tenant_backup", "tenant", tenant.id, tenant.name, f"Backup #{backup.id} restored into {target}", None, {"database": target})
    db.commit()
    return {"database": target, "message": f"Restored into new database {target}. The live database {tenant.db_name} is unchanged."}


def _tenant_users(tenant: Tenant) -> list[dict]:
    session = get_tenant_session(tenant.slug)
    try:
        rows = session.execute(text(
            "SELECT u.id, u.full_name, u.email, u.username, u.role, u.is_active, u.last_login, "
            "(SELECT MAX(s.last_active) FROM user_sessions s WHERE s.user_id = u.id) AS last_active "
            "FROM users u ORDER BY u.full_name"
        )).mappings().all()
    finally:
        session.close()
    mfa = (tenant.otp_mode or "never") != "never"
    return [{"id": r["id"], "name": r["full_name"], "email": r["email"], "username": r["username"], "role": r["role"],
             "is_active": bool(r["is_active"]), "mfa": mfa, "last_login": r["last_login"], "last_active": r["last_active"]} for r in rows]


@router.get("/tenants/{tenant_id}/users")
def tenant_users(tenant_id: int, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    try:
        return [{**u, "tenant_id": tenant.id, "company": tenant.name} for u in _tenant_users(tenant)]
    except Exception:
        raise HTTPException(status_code=503, detail="Tenant database is unreachable")


@router.post("/tenants/{tenant_id}/users/{user_id}/status")
def tenant_user_status(tenant_id: int, user_id: int, data: UserStatusUpdate, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    session = get_tenant_session(tenant.slug)
    try:
        user = session.execute(text("SELECT full_name, is_active FROM users WHERE id = :id"), {"id": user_id}).first()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        if data.is_active:
            session.execute(text("UPDATE users SET is_active = 1 WHERE id = :id"), {"id": user_id})
        else:
            session.execute(text("UPDATE users SET is_active = 0, force_logout_after = NOW() WHERE id = :id"), {"id": user_id})
        session.commit()
    finally:
        session.close()
    action = "reinstate_tenant_user" if data.is_active else "suspend_tenant_user"
    _audit(db, request, action, "tenant", tenant.id, tenant.name, f"User '{user[0]}' {'reinstated' if data.is_active else 'suspended'} in '{tenant.slug}'",
           {"is_active": bool(user[1])}, {"is_active": data.is_active, "user_id": user_id})
    db.commit()
    return {"id": user_id, "is_active": data.is_active}


@router.post("/tenants/{tenant_id}/users/{user_id}/sign-out")
def tenant_user_sign_out(tenant_id: int, user_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    session = get_tenant_session(tenant.slug)
    try:
        user = session.execute(text("SELECT full_name FROM users WHERE id = :id"), {"id": user_id}).first()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        session.execute(text("UPDATE users SET force_logout_after = NOW() WHERE id = :id"), {"id": user_id})
        revoked = session.execute(text(
            "UPDATE user_sessions SET is_active = 0, revoked_at = NOW(), revoke_reason = 'Signed out by platform admin', revoke_scope = 'platform' "
            "WHERE user_id = :id AND is_active = 1 AND revoked_at IS NULL"
        ), {"id": user_id}).rowcount
        session.commit()
    finally:
        session.close()
    _audit(db, request, "sign_out_tenant_user", "tenant", tenant.id, tenant.name, f"User '{user[0]}' signed out of '{tenant.slug}' ({revoked} session(s))")
    db.commit()
    return {"revoked_sessions": revoked}


@router.get("/tenants/{tenant_id}/security")
def tenant_security(tenant_id: int, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    return {field: getattr(tenant, field) for field in SecurityUpdate.model_fields} | {"otp_modes": OTP_MODES, "captcha_modes": CAPTCHA_MODES}


@router.put("/tenants/{tenant_id}/security")
def update_tenant_security(tenant_id: int, data: SecurityUpdate, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    changes = data.model_dump(exclude_unset=True)
    if changes.get("otp_mode") is not None and changes["otp_mode"] not in OTP_MODES:
        raise HTTPException(status_code=422, detail="Unknown OTP mode")
    if changes.get("captcha_mode") is not None and changes["captcha_mode"] not in CAPTCHA_MODES:
        raise HTTPException(status_code=422, detail="Unknown CAPTCHA mode")
    for key in ("password_expiry_days", "inactivity_timeout_minutes"):
        if changes.get(key) is not None:
            changes[key] = max(1, int(changes[key]))
    old = {key: getattr(tenant, key) for key in changes}
    for key, value in changes.items():
        if value is not None:
            setattr(tenant, key, value)
    _audit(db, request, "update_tenant_security", "tenant", tenant.id, tenant.name, f"Security settings updated for '{tenant.slug}'", old, changes)
    db.commit()
    return {field: getattr(tenant, field) for field in SecurityUpdate.model_fields}


@router.get("/tenants/{tenant_id}/configuration")
def tenant_configuration(tenant_id: int, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    try:
        counts = hierarchy.configuration_counts(tenant)
    except Exception:
        counts = None
    return {
        "counts": counts,
        "identity": {
            "subdomain": tenant.subdomain, "from_email": tenant.from_email, "company_mail": tenant.company_mail,
            "smtp_host": tenant.smtp_host, "smtp_port": tenant.smtp_port, "logo_url": tenant.logo_url, "primary_color": tenant.primary_color,
            "otp_mode": tenant.otp_mode, "captcha_mode": tenant.captcha_mode, "country": tenant.country,
        },
    }


@router.get("/tenants/{tenant_id}/metering")
def tenant_metering(tenant_id: int, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    metrics = hierarchy.tenant_metrics(tenant, records=True)
    _, db_info, _ = _placement_for(tenant)
    traffic = platform_traffic.tenant_snapshot(tenant.slug, controls.value(db, "sloLat", tenant.id))
    meters = [
        {"meter": "Active seats", "used": metrics.get("active_users"), "included": tenant.max_users, "unit": "users"},
        {"meter": "Document storage", "used": round(float(tenant.used_storage or 0), 2), "included": tenant.storage_limit_mb, "unit": "MB"},
        {"meter": "Database size", "used": db_info.get("size_mb"), "included": None, "unit": "MB"},
        {"meter": "API requests (last 5 min)", "used": traffic["requests"], "included": None, "unit": "requests"},
    ] + [{"meter": label, "used": count, "included": None, "unit": "records"} for label, count in metrics.get("records", {}).items()]
    for meter in meters:
        used, included = meter["used"], meter["included"]
        meter["overage"] = max(0, used - included) if used is not None and included else 0
    return {"meters": meters}


def _audit_rows(db: Session, entity_type: str, entity_id: int) -> list[dict]:
    rows = db.query(PlatformAuditLog).filter(PlatformAuditLog.entity_type == entity_type, PlatformAuditLog.entity_id == entity_id).order_by(PlatformAuditLog.created_at.desc()).limit(100).all()
    return [{"id": r.id, "created_at": r.created_at, "actor_id": r.super_admin_id, "action": r.action, "description": r.description, "ip": r.ip_address} for r in rows]


@router.get("/tenants/{tenant_id}/platform-audit")
def tenant_platform_audit(tenant_id: int, db: Session = Depends(get_master_db_dep)):
    _tenant(db, tenant_id)
    from app.models.tenant import SuperAdmin
    rows = _audit_rows(db, "tenant", tenant_id)
    admins = {a.id: a for a in db.query(SuperAdmin).filter(SuperAdmin.id.in_({r["actor_id"] for r in rows if r["actor_id"]} or {0})).all()}
    for r in rows:
        admin = admins.get(r.pop("actor_id"))
        r["actor"] = (getattr(admin, "full_name", None) or getattr(admin, "email", None)) if admin else "system"
    return rows


@router.post("/tenants/{tenant_id}/schedule-deletion")
def schedule_tenant_deletion(tenant_id: int, data: DeletionRequest, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    if data.confirm_name.strip() != tenant.name:
        raise HTTPException(status_code=422, detail="Name does not match")
    old = {"status": tenant.status, "deletion_scheduled_at": tenant.deletion_scheduled_at}
    tenant.status = "suspended"
    tenant.deletion_scheduled_at = datetime.utcnow() + timedelta(days=DELETION_GRACE_DAYS)
    _audit(db, request, "schedule_tenant_deletion", "tenant", tenant.id, tenant.name,
           f"Tenant '{tenant.slug}' suspended and scheduled for deletion on {tenant.deletion_scheduled_at:%d %b %Y}", old,
           {"status": "suspended", "deletion_scheduled_at": tenant.deletion_scheduled_at.isoformat()})
    db.commit()
    return {"status": tenant.status, "deletion_scheduled_at": tenant.deletion_scheduled_at}


@router.post("/tenants/{tenant_id}/cancel-deletion")
def cancel_tenant_deletion(tenant_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    if not tenant.deletion_scheduled_at:
        raise HTTPException(status_code=409, detail="No deletion is scheduled for this tenant")
    tenant.deletion_scheduled_at = None
    _audit(db, request, "cancel_tenant_deletion", "tenant", tenant.id, tenant.name, f"Scheduled deletion of '{tenant.slug}' cancelled")
    db.commit()
    return {"deletion_scheduled_at": None}


# ─── Data & migration: exports ──────────────────────────────────────────────

class ExportRequest(BaseModel):
    components: list[str]
    format: str
    pii: str = "Include"
    encryption: str = "AES-256 (platform key)"
    delivery: str = "Secure download link"
    link_days: int = 7
    pgp_key: Optional[str] = None


def _actor(request: Request) -> str:
    admin = _get_platform_admin(request)
    return (getattr(admin, "full_name", None) or getattr(admin, "email", None)) if admin else "platform admin"


def _export_row(job: TenantExportJob) -> dict:
    return {"id": job.id, "job": f"EXP-{job.id}", "components": job.components, "format": job.format, "pii": job.pii, "encryption": job.encryption,
            "delivery": job.delivery, "link_days": job.link_days, "status": job.status, "progress": job.progress, "size_bytes": job.size_bytes,
            "sha256": job.sha256, "manifest": job.manifest, "requested_by": job.requested_by, "error": job.error,
            "file_sha256": (job.options or {}).get("file_sha256"), "pgp_fingerprint": (job.options or {}).get("pgp_fingerprint"),
            "file_available": transfer.file_available(job) if job.status == "ready" else None,
            "attempts": (job.options or {}).get("attempts", 1), "estimated_bytes": (job.options or {}).get("estimated_bytes"),
            "expires_at": (job.completed_at + timedelta(days=job.link_days)) if job.completed_at and job.status == "ready" else None,
            "created_at": job.created_at, "completed_at": job.completed_at}


@router.get("/tenant-hierarchy/export-options")
def export_options():
    return {"components": [{"key": k, "label": l} for k, l in transfer.EXPORT_COMPONENTS], "formats": list(transfer.EXPORT_FORMATS),
            "pii": list(transfer.PII_MODES), "encryption": list(transfer.ENCRYPTIONS), "delivery": list(transfer.DELIVERIES),
            "unavailable": {k: v for k, v in transfer.option_status().items() if v}}


@router.get("/tenants/{tenant_id}/exports")
def list_exports(tenant_id: int, db: Session = Depends(get_master_db_dep)):
    _tenant(db, tenant_id)
    return [_export_row(j) for j in db.query(TenantExportJob).filter(TenantExportJob.tenant_id == tenant_id).order_by(TenantExportJob.id.desc()).all()]


@router.get("/tenants/{tenant_id}/exports/estimate")
def estimate_export(tenant_id: int, components: str = Query(""), db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    keys = [c for c in components.split(",") if c in dict(transfer.EXPORT_COMPONENTS)]
    return transfer.estimate(tenant, keys) if keys else {"tables": 0, "database_bytes": 0, "file_bytes": 0, "total_bytes": 0}


@router.post("/tenants/{tenant_id}/exports", status_code=201)
def start_export(tenant_id: int, data: ExportRequest, request: Request, db: Session = Depends(get_master_db_dep)):
    from app.services.password_reset_service import _resolve_frontend_base_url
    tenant = _tenant(db, tenant_id)
    components = [c for c in data.components if c in dict(transfer.EXPORT_COMPONENTS)]
    if not components:
        raise HTTPException(status_code=422, detail="Select at least one component")
    if data.format not in transfer.EXPORT_FORMATS or data.pii not in transfer.PII_MODES or data.encryption not in transfer.ENCRYPTIONS or data.delivery not in transfer.DELIVERIES:
        raise HTTPException(status_code=422, detail="Unsupported export option")
    unavailable = transfer.option_status()
    for choice in (data.format, data.encryption, data.delivery):
        if unavailable.get(choice):
            raise HTTPException(status_code=422, detail=f"{choice}: {unavailable[choice]}")
    if data.delivery == "Encrypted email" and data.encryption == "None":
        raise HTTPException(status_code=422, detail="Encrypted email needs AES-256 or PGP encryption")
    options = {"attempts": 1}
    if data.encryption == transfer.ENCRYPTIONS[1]:
        try:
            options.update(pgp_key=data.pgp_key, pgp_fingerprint=transfer.pgp_fingerprint(data.pgp_key or ""))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
    try:  # shown as the expected size until the package exists
        options["estimated_bytes"] = transfer.estimate(tenant, components)["total_bytes"]
    except Exception:
        logger.warning("Export size estimate failed for %s", tenant.slug, exc_info=True)
    job = TenantExportJob(tenant_id=tenant.id, components=components, format=data.format, pii=data.pii, encryption=data.encryption,
                          delivery=data.delivery, link_days=max(1, min(int(data.link_days), 30)), status="queued", options=options,
                          base_url=_resolve_frontend_base_url(request), requested_by=_actor(request))
    db.add(job)
    db.flush()
    _audit(db, request, "start_tenant_export", "tenant", tenant.id, tenant.name, f"Export EXP-{job.id} started ({data.format}, personal data: {data.pii})",
           None, {"components": components, "encryption": data.encryption, "delivery": data.delivery})
    db.commit()
    transfer.start_export(job.id)
    return _export_row(job)


@router.post("/tenants/{tenant_id}/exports/{job_id}/link")
def export_link(tenant_id: int, job_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    job = db.get(TenantExportJob, job_id)
    if not job or job.tenant_id != tenant.id:
        raise HTTPException(status_code=404, detail="Export not found")
    if job.status == "expired":
        raise HTTPException(status_code=410, detail="This export's download window has passed and its file was removed. Retry the export.")
    if job.status != "ready":
        raise HTTPException(status_code=409, detail="The export is not ready yet")
    if not transfer.file_available(job):  # don't sign a link to a file that is gone
        transfer.mark_missing(job)
        db.commit()
        raise HTTPException(status_code=410, detail=transfer.MISSING)
    url, expires = transfer.download_url(job)
    if expires < datetime.now():
        raise HTTPException(status_code=410, detail="This export's download window has passed. Start a new export.")
    _audit(db, request, "export_link_issued", "tenant", tenant.id, tenant.name, f"Download link issued for EXP-{job.id}")
    db.commit()
    return {"url": url, "expires_at": expires, "sha256": job.sha256}


@public_router.get("/exports/download")
def download_export(token: str, db: Session = Depends(get_master_db_dep)):
    try:
        job_id = transfer.job_from_token(token)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    job = db.get(TenantExportJob, job_id)
    if not job or job.status != "ready" or not job.file_name:
        raise HTTPException(status_code=404, detail="Export not found")
    path = transfer.EXPORT_DIR / job.file_name
    if not path.is_file():
        raise HTTPException(status_code=410, detail="The export file is no longer available")
    tenant = db.get(Tenant, job.tenant_id)
    _write_platform_audit(db=db, admin=None, action="export_downloaded", entity_type="tenant", entity_id=tenant.id, entity_name=tenant.name,
                          description=f"EXP-{job.id} downloaded through its signed link")
    db.commit()

    def plain():
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                yield block

    pgp = job.file_name.endswith(".gpg")  # encrypted for the customer's own key: delivered as is
    name = f"{tenant.slug}-export-{job.id}.zip" + (".gpg" if pgp else "")
    headers = {"Content-Disposition": f'attachment; filename="{name}"',
               "X-Content-SHA256": ((job.options or {}).get("file_sha256") if pgp else job.sha256) or ""}
    body = transfer.decrypt_stream(path) if job.file_name.endswith(".enc") else plain()
    return StreamingResponse(body, media_type="application/pgp-encrypted" if pgp else "application/zip", headers=headers)


def _export_job(db: Session, tenant_id: int, job_id: int) -> TenantExportJob:
    job = db.get(TenantExportJob, job_id)
    if not job or job.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Export not found")
    return job


@router.post("/tenants/{tenant_id}/exports/{job_id}/retry")
def retry_export(tenant_id: int, job_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    job = _export_job(db, tenant.id, job_id)
    try:
        transfer.retry_export(db, job)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    _audit(db, request, "retry_tenant_export", "tenant", tenant.id, tenant.name, f"Export EXP-{job.id} retried (attempt {job.options['attempts']})")
    db.commit()
    transfer.start_export(job.id)
    return _export_row(job)


@router.post("/tenants/{tenant_id}/exports/{job_id}/verify")
def verify_export(tenant_id: int, job_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    job = _export_job(db, tenant.id, job_id)
    if job.status == "ready" and not transfer.file_available(job):
        transfer.mark_missing(job)
        _audit(db, request, "verify_tenant_export", "tenant", tenant.id, tenant.name, f"Checksum of EXP-{job.id} not possible: package file missing, export expired")
        db.commit()
        raise HTTPException(status_code=409, detail=transfer.MISSING)
    try:
        result = transfer.verify_export(job)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    _audit(db, request, "verify_tenant_export", "tenant", tenant.id, tenant.name,
           f"Checksum of EXP-{job.id} {'verified' if result['verified'] else 'did NOT match'}")
    db.commit()
    return result


# ─── Data & migration: migrations ───────────────────────────────────────────

class MigrationUpdate(BaseModel):
    mapping: Optional[dict] = None
    rules: Optional[dict] = None


def _migration(db: Session, tenant_id: int, migration_id: int) -> TenantMigration:
    migration = db.get(TenantMigration, migration_id)
    if not migration or migration.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Migration not found")
    return migration


def _migration_row(m: TenantMigration) -> dict:
    dry = dict(m.dry_run or {})
    dry.pop("issues", None)
    rollback_until = m.completed_at + migrations.ROLLBACK_WINDOW if m.completed_at and m.status == "Completed" else None
    return {"id": m.id, "project": f"MIG-{m.id}", "source": m.source, "files": m.files, "datasets": m.datasets, "mapping": m.mapping,
            "rules": m.rules, "dry_run": dry or None, "result": m.result, "status": m.status, "progress": m.progress, "records": m.records,
            "created_by": m.created_by, "error": m.error, "created_at": m.created_at, "completed_at": m.completed_at, "rollback_until": rollback_until,
            "scheduled_at": m.scheduled_at, "pull": (m.result or {}).get("pull") if m.status == "Fetching" else None,
            "checkpoint": (m.result or {}).get("cursor") if m.status in migrations.RESUMABLE else None,
            "can_rollback": m.status in migrations.RESUMABLE and bool((m.result or {}).get("cursor")) or rollback_until is not None}


@router.get("/tenant-hierarchy/migration-options")
def migration_options(db: Session = Depends(get_master_db_dep)):
    from app.models.tenant_hierarchy import PlatformMigrationConnector
    from app.services import migration_connectors as mc
    saved = {c.source: c for c in db.query(PlatformMigrationConnector).all()}
    connectors = {s: {"method": mc.CONNECTORS[s].method, "status": saved[s].status if s in saved else "not_configured",
                      "account": saved[s].account if s in saved else None, "detail": saved[s].detail if s in saved else "Not configured",
                      "objects": (saved[s].objects if s in saved and saved[s].objects else [{"name": o, "count": None} for o in mc.CONNECTORS[s].objects])}
                  for s in mc.CONNECTORS}
    return {"sources": mc.SOURCES, "file_sources": list(migrations.MIGRATION_SOURCES), "connectors": connectors,
            "duplicates": list(migrations.DUPLICATE_RULES), "owners": list(migrations.OWNER_RULES),
            "targets": {k: {"label": v["label"], "fields": [{"key": f, "label": l, "required": r} for f, l, r in v["fields"]]} for k, v in migrations.TARGETS.items()}}


@router.get("/tenants/{tenant_id}/migrations")
def list_migrations(tenant_id: int, db: Session = Depends(get_master_db_dep)):
    _tenant(db, tenant_id)
    return [_migration_row(m) for m in db.query(TenantMigration).filter(TenantMigration.tenant_id == tenant_id).order_by(TenantMigration.id.desc()).all()]


@router.post("/tenants/{tenant_id}/migrations", status_code=201)
async def create_migration(tenant_id: int, request: Request, source: str = Form(...), files: list[UploadFile] = File(...),
                           db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    uploads = [(f.filename or "upload", await f.read()) for f in files]
    if sum(len(c) for _, c in uploads) > 200 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Uploads are limited to 200 MB per migration")
    try:
        migration = migrations.create_migration(db, tenant, source, uploads, _actor(request))
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        db.rollback()
        logger.exception("Migration upload failed for %s", tenant.slug)
        raise HTTPException(status_code=400, detail=f"The source could not be read: {exc}")
    _audit(db, request, "create_tenant_migration", "tenant", tenant.id, tenant.name, f"Migration MIG-{migration.id} created from {source} ({', '.join(migration.files or [])})")
    db.commit()
    return _migration_row(migration)


@router.get("/tenants/{tenant_id}/migrations/{migration_id}")
def get_migration(tenant_id: int, migration_id: int, db: Session = Depends(get_master_db_dep)):
    return _migration_row(_migration(db, tenant_id, migration_id))


@router.put("/tenants/{tenant_id}/migrations/{migration_id}")
def update_migration(tenant_id: int, migration_id: int, data: MigrationUpdate, db: Session = Depends(get_master_db_dep)):
    migration = _migration(db, tenant_id, migration_id)
    if migration.status not in ("Draft", "Dry run passed") or migration.scheduled_at:
        raise HTTPException(status_code=409, detail=f"A {migration.status.lower()}{' and scheduled' if migration.scheduled_at else ''} migration can't be changed")
    if data.mapping is not None:
        keys = {d["key"] for d in migration.datasets or []}
        migration.mapping = {k: v for k, v in data.mapping.items() if k in keys}
    if data.rules is not None:
        migration.rules = {**(migration.rules or {}), **data.rules}
    migration.dry_run, migration.status = None, "Draft"
    db.commit()
    return _migration_row(migration)


@router.post("/tenants/{tenant_id}/migrations/{migration_id}/dry-run")
def migration_dry_run(tenant_id: int, migration_id: int, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    migration = _migration(db, tenant_id, migration_id)
    if not any(True for _ in migrations.mapped(migration)):
        raise HTTPException(status_code=422, detail="Map at least one source object to a target")
    migrations.dry_run(migration, tenant)
    db.commit()
    return _migration_row(migration)


@router.get("/tenants/{tenant_id}/migrations/{migration_id}/errors.csv")
def migration_errors(tenant_id: int, migration_id: int, db: Session = Depends(get_master_db_dep)):
    migration = _migration(db, tenant_id, migration_id)
    return Response(migrations.error_report(migration), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="MIG-{migration.id}-issues.csv"'})


@router.post("/tenants/{tenant_id}/migrations/{migration_id}/run")
def migration_run(tenant_id: int, migration_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    migration = _migration(db, tenant_id, migration_id)
    if migration.status != "Dry run passed":
        raise HTTPException(status_code=409, detail="Run a dry run first")
    migration.status, migration.progress = "Running", 0
    _audit(db, request, "run_tenant_migration", "tenant", tenant.id, tenant.name, f"Migration MIG-{migration.id} started")
    db.commit()
    migrations.start_migration(migration.id)
    return _migration_row(migration)


class ConnectorMigrationRequest(BaseModel):
    source: str
    objects: list[str]


@router.post("/tenants/{tenant_id}/migrations/connector", status_code=201)
def create_connector_migration(tenant_id: int, data: ConnectorMigrationRequest, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    try:
        migration = migrations.create_connector_migration(db, tenant, data.source, data.objects, _actor(request))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    _audit(db, request, "create_tenant_migration", "tenant", tenant.id, tenant.name,
           f"Migration MIG-{migration.id} created from {data.source} ({', '.join(data.objects)})")
    db.commit()
    migrations.start_pull(migration.id)
    return _migration_row(migration)


@router.post("/tenants/{tenant_id}/migrations/{migration_id}/pause")
def migration_pause(tenant_id: int, migration_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    migration = _migration(db, tenant_id, migration_id)
    if migration.status != "Running":
        raise HTTPException(status_code=409, detail="Only a running migration can be paused")
    migration.status = "Pausing"  # the worker stops at its next checkpoint
    _audit(db, request, "pause_tenant_migration", "tenant", tenant.id, tenant.name, f"Migration MIG-{migration.id} paused")
    db.commit()
    return _migration_row(migration)


@router.post("/tenants/{tenant_id}/migrations/{migration_id}/resume")
def migration_resume(tenant_id: int, migration_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    migration = _migration(db, tenant_id, migration_id)
    if migration.status not in migrations.RESUMABLE or migration.dry_run is None:
        raise HTTPException(status_code=409, detail="Only a paused, interrupted or failed import can be resumed")
    migration.status, migration.error = "Running", None
    _audit(db, request, "resume_tenant_migration", "tenant", tenant.id, tenant.name,
           f"Migration MIG-{migration.id} resumed from row {(migration.result or {}).get('cursor') or 0}")
    db.commit()
    migrations.start_migration(migration.id)
    return _migration_row(migration)


class ScheduleRequest(BaseModel):
    at: Optional[datetime] = None  # None cancels the schedule


@router.post("/tenants/{tenant_id}/migrations/{migration_id}/schedule")
def migration_schedule(tenant_id: int, migration_id: int, data: ScheduleRequest, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    migration = _migration(db, tenant_id, migration_id)
    if migration.status != "Dry run passed":
        raise HTTPException(status_code=409, detail="Schedule the cut-over after a dry run has passed")
    at = data.at.replace(tzinfo=None) if data.at and data.at.tzinfo is None else (data.at.astimezone().replace(tzinfo=None) if data.at else None)
    if at and at <= datetime.now():
        raise HTTPException(status_code=422, detail="Pick a time in the future")
    migration.scheduled_at = at
    _audit(db, request, "schedule_tenant_migration", "tenant", tenant.id, tenant.name,
           f"Cut-over of MIG-{migration.id} {'scheduled for ' + at.strftime('%d %b %Y %H:%M') if at else 'schedule cancelled'}")
    db.commit()
    return _migration_row(migration)


@router.post("/tenants/{tenant_id}/migrations/{migration_id}/rollback")
def migration_rollback(tenant_id: int, migration_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(db, tenant_id)
    migration = _migration(db, tenant_id, migration_id)
    try:
        counts = migrations.rollback(migration, tenant)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    removed = ", ".join(f"{n} {migrations.TARGETS[t]['label'].lower()}" for t, n in counts.items() if n) or "nothing"
    _audit(db, request, "rollback_tenant_migration", "tenant", tenant.id, tenant.name, f"Migration MIG-{migration.id} rolled back ({removed} removed)")
    db.commit()
    return {**_migration_row(migration), "removed": counts}
