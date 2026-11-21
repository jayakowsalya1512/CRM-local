"""
Platform staff access control: roles (None / View / Manage per module), tenant
scope, and the route guard shared by every protected platform router.
"""
import re
from typing import Optional

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import require_platform_super_admin
from app.models.tenant import PlatformRole, PlatformSetting, PlatformStaffAccess, SuperAdmin

MODULES = [
    ("tenants", "Tenants"),
    ("billing", "Plans & billing"),
    ("services", "Services"),
    ("feature_matrix", "Feature matrix"),
    ("team", "Platform team"),
    ("audit", "Audit logs"),
    ("backups", "Backups"),
    ("databases", "Databases"),
    ("monitoring", "Monitoring"),
    ("storage", "Documents & Storage"),
    ("data_transfer", "Data Export & Migration"),
    ("logs", "Logs Explorer"),
    ("jobs", "Jobs & Queues"),
    ("infrastructure", "Infrastructure & Releases"),
    ("changes", "Change & Maintenance"),
    ("settings", "Settings"),
]
MODULE_KEYS = [key for key, _ in MODULES]
MODULE_LABELS = dict(MODULES)
LEVELS = {"none": 0, "view": 1, "manage": 2}
SUPER_ADMIN_KEY = "super_admin"
SCOPES = {"all", "assigned"}
FOUR_EYES_KEY = "platform_four_eyes_enabled"


def fill(level: str, **overrides: str) -> dict:
    return {key: overrides.get(key, level) for key in MODULE_KEYS}


DEFAULT_ROLES = [
    (SUPER_ADMIN_KEY, "Super admin", fill("manage")),
    ("platform_engineer", "Platform engineer", fill("view", services="manage", feature_matrix="manage", backups="manage", databases="manage", monitoring="manage", storage="manage", data_transfer="manage", jobs="manage", infrastructure="manage", changes="manage", team="none", settings="none")),
    ("support_lead", "Support lead", fill("none", tenants="manage", services="view", feature_matrix="view", audit="view")),
    ("billing_admin", "Billing admin", fill("none", tenants="view", billing="manage")),
    ("security_officer", "Security officer", fill("view", team="manage", settings="manage", billing="none")),
    ("read_only_auditor", "Read-only auditor", fill("view")),
]

_roles_seeded = False


def ensure_default_roles(db: Session) -> None:
    global _roles_seeded
    if _roles_seeded:
        return
    existing = {role.key: role for role in db.query(PlatformRole).all()}
    missing = [role for role in DEFAULT_ROLES if role[0] not in existing]
    for key, name, permissions in missing:
        db.add(PlatformRole(key=key, name=name, is_system=True, permissions=permissions))
    # Modules added after a system role was stored start at that role's default level instead of "none".
    backfilled = False
    for key, _name, permissions in DEFAULT_ROLES:
        role = existing.get(key)
        if role is not None and role.is_system and any(module not in (role.permissions or {}) for module in MODULE_KEYS):
            role.permissions = {**permissions, **(role.permissions or {})}
            backfilled = True
    if missing or backfilled:
        db.commit()
    _roles_seeded = True


def normalize_permissions(permissions: Optional[dict]) -> dict:
    permissions = permissions or {}
    return {key: permissions.get(key) if permissions.get(key) in LEVELS else "none" for key in MODULE_KEYS}


def super_admin_role(db: Session) -> PlatformRole:
    ensure_default_roles(db)
    return db.query(PlatformRole).filter(PlatformRole.key == SUPER_ADMIN_KEY).one()


def staff_access(db: Session, admin: SuperAdmin) -> dict:
    """Effective role, permissions and tenant scope for one staff account."""
    row = db.query(PlatformStaffAccess).filter(PlatformStaffAccess.admin_id == admin.id).first()
    role = db.get(PlatformRole, row.role_id) if row else None
    if role is None:
        role = super_admin_role(db)
    is_super = role.key == SUPER_ADMIN_KEY
    scope = "all" if is_super or not row else row.scope
    return {
        "role_id": role.id,
        "role_key": role.key,
        "role_name": role.name,
        "is_super_admin": is_super,
        "permissions": fill("manage") if is_super else normalize_permissions(role.permissions),
        "scope": scope,
        "tenant_ids": sorted(int(t) for t in (row.tenant_ids or [])) if scope == "assigned" else [],
    }


def can(access: dict, module: str, level: str) -> bool:
    return LEVELS[access["permissions"].get(module, "none")] >= LEVELS[level]


def four_eyes_enabled(db: Session) -> bool:
    setting = db.query(PlatformSetting).filter(PlatformSetting.key == FOUR_EYES_KEY).first()
    return bool(setting.value_bool) if setting else False


def team_managers(db: Session, exclude_admin_id: Optional[int] = None) -> list[SuperAdmin]:
    admins = db.query(SuperAdmin).filter(SuperAdmin.is_active == True).all()
    return [a for a in admins if a.id != exclude_admin_id and can(staff_access(db, a), "team", "manage")]


# ── Route guard ──────────────────────────────────────────────────────────────
# Paths are relative to /api/v1/platform. GET/HEAD need "view", anything else
# "manage". OPEN routes need only a valid platform session; ANY_VIEW routes are
# reference data needed across pages. Unmatched routes need Super admin.
OPEN = "open"
ANY_VIEW = "any_view"
_TENANT_LIST_MODULES = ("tenants", "backups", "feature_matrix", "billing", "audit")
_RULES: list[tuple[str, Optional[str], object]] = [
    (r"^/(me|account-activity|logout|request-password-reset|change-password|system-status|session/activity|stats)$", None, OPEN),
    (r"^/dashboard/", None, OPEN),
    (r"^/kpi/", "GET", OPEN),  # each KPI checks its own module (platform_kpi_router)
    (r"^/team/(me|approvals)(/|$)", None, OPEN),
    (r"^/settings/(session-timeout|maintenance)$", "GET", OPEN),
    (r"^/(plans|features|services)$", "GET", ANY_VIEW),
    (r"^/entitlements/modules$", "GET", ANY_VIEW),  # module list shared by Plans & Entitlements and tenant onboarding
    (r"^/tenants$", "GET", _TENANT_LIST_MODULES),
    (r"^/(tenants|plans)/\d+/features$", None, "feature_matrix"),
    (r"^/tenants/\d+/backup$", None, "backups"),
    (r"^/tenants/\d+/audit-logs$", None, "audit"),
    (r"^/tenants/\d+/(exports|migrations)(/|$)", None, ("tenants", "data_transfer")),
    (r"^/tenant-hierarchy/(export|migration)-options$", "GET", ("tenants", "data_transfer")),
    (r"^/(tenants|tenant-users)(/|$)", None, "tenants"),
    (r"^/usage-monitoring$", "GET", "tenants"),
    (r"^/tenant-(groups|hierarchy)(/|$)", None, "tenants"),
    (r"^/(plans|subscriptions)(/|$)", None, "billing"),
    (r"^/(services|features)(/|$)", None, "services"),
    (r"^/audit-logs(/|$)", "GET", "audit"),
    (r"^/(super-admins|team)(/|$)", None, "team"),
    (r"^/settings/", None, "settings"),
    (r"^/backups(/|$)", None, "backups"),
    (r"^/databases(/|$)", None, "databases"),
    (r"^/environments(/|$)", None, "databases"),
    (r"^/monitoring(/|$)", None, "monitoring"),
    (r"^/storage(/|$)", None, "storage"),
    (r"^/data-transfer(/|$)", None, "data_transfer"),
    (r"^/logs(/|$)", "GET", "logs"),
    (r"^/jobs(/|$)", None, "jobs"),
    (r"^/billing(/|$)", None, "billing"),
    (r"^/discounts(/|$)", None, "billing"),
    (r"^/invoicing(/|$)", None, "billing"),
    (r"^/addons(/|$)", None, "billing"),
    (r"^/entitlements(/|$)", None, "feature_matrix"),
    (r"^/workflow-templates(/|$)", None, "tenants"),
    (r"^/security(/|$)", "GET", "settings"),
    (r"^/trust-safety(/|$)", None, "tenants"),
    (r"^/support(/|$)", None, "tenants"),
    (r"^/sla(/|$)", None, "tenants"),
    (r"^/announcements/maintenance$", None, "changes"),
    (r"^/announcements(/|$)", None, "tenants"),
    (r"^/api-webhooks(/|$)", None, "tenants"),
    (r"^/resellers(/|$)", None, "billing"),
    (r"^/mobile(/|$)", None, "tenants"),
    (r"^/marketplace(/|$)", None, "tenants"),
    (r"^/revenue(/|$)", None, "billing"),
    (r"^/finops(/|$)", None, "billing"),
    (r"^/customer-success(/|$)", None, "tenants"),
    (r"^/infrastructure(/|$)", None, "infrastructure"),
    (r"^/regions(/|$)", None, "infrastructure"),
    (r"^/changes(/|$)", None, "changes"),
]
_RULES_COMPILED = [(re.compile(pattern), method, target) for pattern, method, target in _RULES]


def _platform_path(request: Request) -> str:
    path = request.url.path
    marker = "/api/v1/platform"
    return path.split(marker, 1)[1] if marker in path else path


def enforce_platform_access(
    request: Request,
    admin: SuperAdmin = Depends(require_platform_super_admin),
    db: Session = Depends(get_master_db_dep),
) -> SuperAdmin:
    access = staff_access(db, admin)
    request.state.platform_access = access
    if access["is_super_admin"]:
        return admin

    path, method = _platform_path(request), request.method.upper()
    level = "view" if method in ("GET", "HEAD") else "manage"
    target: object = None
    for pattern, rule_method, rule_target in _RULES_COMPILED:
        if pattern.search(path) and (rule_method is None or rule_method == method):
            target = rule_target
            break

    if target == OPEN:
        allowed = True
    elif target == ANY_VIEW:
        allowed = any(can(access, module, "view") for module in MODULE_KEYS)
    elif isinstance(target, tuple):
        allowed = any(can(access, module, level) for module in target)
    elif isinstance(target, str):
        allowed = can(access, target, level)
    else:
        allowed = False
    if not allowed:
        area = MODULE_LABELS.get(target, "this area") if isinstance(target, str) else "this area"
        raise HTTPException(status_code=403, detail=f"Your platform role ({access['role_name']}) can't {'change' if level == 'manage' else 'view'} {area}.")

    tenant_id = request.path_params.get("tenant_id")
    if tenant_id is not None:
        require_tenant_in_scope(request, int(tenant_id))
    elif access["scope"] == "assigned" and method == "POST" and path == "/tenants":
        raise HTTPException(status_code=403, detail="Only staff with all-tenant scope can onboard new tenants.")
    return admin


def scoped_tenant_ids(request: Request) -> Optional[set[int]]:
    """Tenant ids the caller may see, or None for every tenant."""
    access = getattr(request.state, "platform_access", None)
    if not access or access["scope"] != "assigned":
        return None
    return set(access["tenant_ids"])


def require_tenant_in_scope(request: Request, tenant_id: int) -> None:
    allowed = scoped_tenant_ids(request)
    if allowed is not None and tenant_id not in allowed:
        raise HTTPException(status_code=403, detail="This tenant is outside your assigned scope.")
