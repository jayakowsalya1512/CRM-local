"""
Role & Permission router
========================
Endpoints:
  GET    /roles                                      — list all roles with permission counts
  GET    /roles/my-permissions                       — current user's resolved permissions
  GET    /roles/all-permissions                      — all permissions grouped by module
  GET    /roles/{role_id}                            — role detail with full permissions
  POST   /roles                                      — create a role (custom OR provision a preset)
  PUT    /roles/{role_id}                            — update role metadata
  DELETE /roles/{role_id}                            — delete non-system role
  GET    /roles/{role_id}/permissions                — permission IDs for a role
  PUT    /roles/{role_id}/permissions                — bulk replace all permissions for a role
  POST   /roles/{role_id}/permissions/{perm_id}     — grant a single permission
  DELETE /roles/{role_id}/permissions/{perm_id}     — revoke a single permission

  GET    /roles/permissions/all                      — raw list of all permissions (flat, ungrouped)
  POST   /roles/permissions                          — create a new permission
  DELETE /roles/permissions/{perm_id}               — delete a permission (non-system only)

IMPORTANT:
  Static routes (/my-permissions, /all-permissions, /permissions/*)
  MUST be registered before the dynamic /{role_id} route to prevent
  FastAPI from trying to cast "my-permissions" as an integer.
"""
import logging
from typing import Any, Optional, List
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func
from sqlalchemy.orm import Session
from pydantic import BaseModel, field_validator
from app.core import validators as V
from app.dependencies import get_tenant_db, get_current_user
from app.models.all_models import Module, Role, Permission, RolePermission, User
from app.core.logging import log_module_action, model_snapshot
from app.services.tenant_module_service import (
    DEFAULT_TENANT_MODULE_KEYS,
    DEFAULT_TENANT_PERMISSIONS,
    SECTION_SORT_ORDER,
)
from app.services.cache_service import (
    CACHE_TTL_SECONDS,
    cache_get_json,
    cache_set_json,
    invalidate_permissions_cache,
    permissions_cache_key,
    tenant_slug_from_db,
)

logger = logging.getLogger(__name__)
router = APIRouter()


# ─── Schemas ──────────────────────────────────────────────────────────────────

class RoleCreate(BaseModel):
    name:         str
    display_name: str
    level:        int            = 10
    description:  Optional[str] = None
    color:        Optional[str] = None
    icon:         Optional[str] = None
    is_system:    bool           = False   # allow provisioning as system role if needed

    @field_validator('name', mode='before')
    @classmethod
    def _name(cls, v: Any) -> str:
        return V.check_text(v, 'Role name', 2, 50, required=True)  # type: ignore[return-value]

    @field_validator('display_name', mode='before')
    @classmethod
    def _display_name(cls, v: Any) -> str:
        return V.check_name(v, 'Role name', 2, 100)

    @field_validator('description', mode='before')
    @classmethod
    def _description(cls, v: Any) -> Optional[str]:
        return V.check_text(v, 'Description', 0, 500)

    @field_validator('level')
    @classmethod
    def _level(cls, v: int) -> int:
        if not 0 <= v <= 999:
            raise ValueError('Level must be between 0 and 999.')
        return v


class RoleUpdate(BaseModel):
    display_name: Optional[str]  = None
    level:        Optional[int]  = None
    description:  Optional[str]  = None
    color:        Optional[str]  = None
    icon:         Optional[str]  = None
    is_active:    Optional[bool] = None

    @field_validator('display_name', mode='before')
    @classmethod
    def _display_name(cls, v: Any) -> Optional[str]:
        return None if v is None else V.check_name(v, 'Role name', 2, 100)

    @field_validator('description', mode='before')
    @classmethod
    def _description(cls, v: Any) -> Optional[str]:
        return V.check_text(v, 'Description', 0, 500)

    @field_validator('level')
    @classmethod
    def _level(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and not 0 <= v <= 999:
            raise ValueError('Level must be between 0 and 999.')
        return v


class PermissionCreate(BaseModel):
    key:         str
    module:      str
    action:      str
    description: Optional[str] = None


class ModuleScopeIn(BaseModel):
    module: str
    data_scope: str = "own"


class PermissionsBulk(BaseModel):
    permission_ids: List[int]
    module_scopes: List[ModuleScopeIn] = []


def _permission_audit_snapshot(db: Session, role_id: int) -> dict:
    """Return the role permission state in a stable, readable audit format."""
    assignments = (
        db.query(RolePermission, Permission)
        .join(Permission, Permission.id == RolePermission.permission_id)
        .filter(RolePermission.role_id == role_id)
        .order_by(Permission.key)
        .all()
    )
    scopes = {
        (permission.module or "unassigned").strip().lower(): assignment.data_scope or "own"
        for assignment, permission in assignments
    }
    return {
        "permission_count": len(assignments),
        "permissions": [permission.key for _, permission in assignments],
        "module_scopes": scopes,
    }

# ─── Guards ───────────────────────────────────────────────────────────────────

def _require_role_admin(cu: User):
    """Only admin or ceo can manage roles and permissions."""
    if cu.role not in ('admin', 'ceo'):
        raise HTTPException(403, "Insufficient role to manage roles and permissions")


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _role_dict(
    db: Session,
    role: Role,
    *,
    role_permissions: Optional[List[RolePermission]] = None,
    permission_map: Optional[dict[int, Permission]] = None,
) -> dict:
    """Serialize a Role with its full permission list and count."""
    if role_permissions is None:
        role_permissions = db.query(RolePermission).filter(
            RolePermission.role_id == role.id
        ).all()

    perm_ids = [rp.permission_id for rp in role_permissions]

    if permission_map is None:
        perms = db.query(Permission).filter(
            Permission.id.in_(perm_ids)
        ).all() if perm_ids else []
    else:
        perms = [permission_map[pid] for pid in perm_ids if pid in permission_map]

    permission_module_map = {
        p.id: (p.module or "").strip().lower()
        for p in perms
    }

    module_scopes = {}
    for rp in role_permissions:
        module_key = permission_module_map.get(rp.permission_id)
        if module_key:
            module_scopes[module_key] = getattr(rp, "data_scope", "own") or "own"
    return {
        "id":               role.id,
        "name":             role.name,
        "display_name":     role.display_name,
        "level":            role.level,
        "description":      role.description,
        "is_system":        role.is_system,
        "is_active":        role.is_active,
        "color":            getattr(role, 'color', None),
        "icon":             getattr(role, 'icon',  None),
        "created_at":       getattr(role, 'created_at', None),
        "permission_count": len(perms),
        "module_scopes": module_scopes,
        "permissions": [
            {
                "id":          p.id,
                "key":         p.key,
                "module":      p.module,
                "action":      p.action,
                "description": p.description,
            }
            for p in perms
        ],
    }


def _permission_dict(permission: Permission, module_key: str) -> dict:
    return {
        "id":          permission.id,
        "key":         permission.key,
        "module":      module_key,
        "action":      permission.action,
        "description": permission.description,
    }


def _module_active_lookup(db: Session) -> dict[str, bool]:
    return {
        (row.key or "").strip().lower(): bool(row.is_active)
        for row in db.query(Module.key, Module.is_active).all()
        if (row.key or "").strip()
    }


def _permission_module_is_enabled(
    permission: Permission,
    module_active_by_key: dict[str, bool],
) -> bool:
    module_key = (permission.module or "").strip().lower()
    if not module_key:
        return True
    if module_key in DEFAULT_TENANT_MODULE_KEYS:
        return module_active_by_key.get(module_key, False)
    return module_active_by_key.get(module_key, True)


def _filter_enabled_module_permissions(db: Session, permissions: list[Permission]) -> list[Permission]:
    module_active_by_key = _module_active_lookup(db)
    return [
        permission
        for permission in permissions
        if _permission_module_is_enabled(permission, module_active_by_key)
    ]


def _ensure_permissions_assignable(db: Session, permissions: list[Permission]) -> None:
    module_active_by_key = _module_active_lookup(db)
    disabled = [
        permission.key
        for permission in permissions
        if not _permission_module_is_enabled(permission, module_active_by_key)
    ]
    if disabled:
        raise HTTPException(
            400,
            f"Permission(s) belong to disabled modules: {', '.join(sorted(disabled))}",
        )


def _ensure_document_management_permissions_present(db: Session) -> None:
    """Backfill the role-editor catalog for tenants created before doc CRUD perms."""
    default_rows = [
        (key, module_name, action, description)
        for key, module_name, action, description in DEFAULT_TENANT_PERMISSIONS
        if module_name == "document_management"
    ]
    if not default_rows:
        return

    default_keys = [key for key, _, _, _ in default_rows]
    existing_permissions = {
        permission.key: permission
        for permission in db.query(Permission)
        .filter(Permission.key.in_(default_keys))
        .all()
    }

    changed = False
    for key, module_name, action, description in default_rows:
        permission = existing_permissions.get(key)
        if not permission:
            permission = Permission(key=key)
            db.add(permission)
            changed = True

        if (
            permission.module != module_name
            or permission.action != action
            or permission.description != description
        ):
            permission.module = module_name
            permission.action = action
            permission.description = description
            changed = True

    if not changed:
        return

    try:
        db.commit()
        invalidate_permissions_cache(db)
    except Exception as exc:
        db.rollback()
        logger.warning("Unable to backfill document-management permissions: %s", exc)


def _permissions_grouped(db: Session) -> list:
    """Return role-editor permissions using modules as the source of truth."""
    _ensure_document_management_permissions_present(db)

    modules = db.query(Module).filter(Module.is_active == True).all()
    modules.sort(
        key=lambda row: (
            SECTION_SORT_ORDER.get((row.section or "").strip().lower(), 999),
            int(row.sort_order or 0),
            (row.label or "").strip().lower(),
        )
    )

    permissions = db.query(Permission).order_by(Permission.module, Permission.action).all()
    permissions_by_module: dict[str, list[Permission]] = {}
    permissions_by_key: dict[str, Permission] = {}
    for permission in permissions:
        module_key = (permission.module or "").strip().lower()
        permissions_by_module.setdefault(module_key, []).append(permission)
        permissions_by_key[(permission.key or "").strip().lower()] = permission

    groups: list[dict] = []
    for module in modules:
        module_key = (module.key or "").strip().lower()
        if not module_key:
            continue

        grouped_permissions: list[Permission] = []
        seen_permission_ids: set[int] = set()

        for permission in permissions_by_module.get(module_key, []):
            grouped_permissions.append(permission)
            seen_permission_ids.add(permission.id)

        permission_key = (module.permission_key or "").strip().lower()
        permission = permissions_by_key.get(permission_key)
        if permission and permission.id not in seen_permission_ids:
            grouped_permissions.append(permission)
            seen_permission_ids.add(permission.id)

        if not grouped_permissions:
            continue

        grouped_permissions.sort(key=lambda item: ((item.action or "").strip().lower(), item.id))
        groups.append({
            "module": module_key,
            "label": module.label or module_key,
            "section": module.section,
            "sort_order": module.sort_order,
            "parent_key": module.parent_key,
            "permission_key": module.permission_key,
            "permissions": [
                _permission_dict(permission, module_key)
                for permission in grouped_permissions
            ],
        })

    return groups


# ═══════════════════════════════════════════════════════════════════════════════
# STATIC ROUTES — must come BEFORE /{role_id}
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("")
def list_roles(
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    """Return all roles ordered by level, each with permission count."""
    roles = db.query(Role).order_by(Role.level).all()
    role_ids = [int(role.id) for role in roles if role.id]
    role_permissions_by_role: dict[int, list[RolePermission]] = {role_id: [] for role_id in role_ids}
    permission_ids: set[int] = set()
    if role_ids:
        role_permissions = (
            db.query(RolePermission)
            .filter(RolePermission.role_id.in_(role_ids))
            .all()
        )
        for role_permission in role_permissions:
            role_permissions_by_role.setdefault(int(role_permission.role_id), []).append(role_permission)
            if role_permission.permission_id:
                permission_ids.add(int(role_permission.permission_id))

    permission_map = {
        int(permission.id): permission
        for permission in db.query(Permission).filter(Permission.id.in_(permission_ids)).all()
    } if permission_ids else {}

    return [
        _role_dict(
            db,
            role,
            role_permissions=role_permissions_by_role.get(int(role.id), []),
            permission_map=permission_map,
        )
        for role in roles
    ]


@router.get("/my-permissions")
def get_my_permissions(
    fresh: bool = False,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    """
    Return permission keys for the current user's role.
    Frontend sidebar calls this to decide which nav items to show.
    Registered before /{role_id} to prevent integer-cast errors.
    """
    tenant_slug = tenant_slug_from_db(db)
    cache_key = permissions_cache_key(tenant_slug, cu.id) if tenant_slug else ""
    # ?fresh=1 – re-read from the database (the frontend uses it before showing "Access Restricted", so a permission
    # granted after sign-in is honoured at once); the result still refreshes the cache.
    if cache_key and not fresh:
        cached = cache_get_json(cache_key, "permissions")
        if cached is not None:
            return cached

    role_row = db.query(Role).filter(
        Role.name == cu.role,
        Role.is_active == True,
    ).first()

    if not role_row:
        response = {
            "permissions":  [],
            "role":         cu.role,
            "role_id":      None,
            "role_display": cu.role,
            "role_icon":    None,
            "role_color":   None,
            "warning":      f"Role '{cu.role}' is not yet provisioned in the roles table",
        }
        if cache_key:
            cache_set_json(cache_key, response, CACHE_TTL_SECONDS["permissions"])
        return response

    perm_ids = [
        rp.permission_id
        for rp in db.query(RolePermission).filter(RolePermission.role_id == role_row.id).all()
    ]
    keys = []
    if perm_ids:
        permissions = db.query(Permission).filter(Permission.id.in_(perm_ids)).all()
        keys = [p.key for p in _filter_enabled_module_permissions(db, permissions)]

    response = {
        "permissions":  keys,
        "role":         cu.role,
        "role_id":      role_row.id,
        "role_display": role_row.display_name,
        "role_icon":    getattr(role_row, 'icon',  None),
        "role_color":   getattr(role_row, 'color', None),
    }
    if cache_key:
        cache_set_json(cache_key, response, CACHE_TTL_SECONDS["permissions"])
    return response


@router.get("/all-permissions")
def get_all_permissions(
    db: Session = Depends(get_tenant_db),
    _:  User    = Depends(get_current_user),
):
    """All permissions grouped by module — used by the role editor matrix."""
    return _permissions_grouped(db)


# ─── Permission CRUD (static, must stay above /{role_id}) ────────────────────

@router.get("/permissions/all")
def list_all_permissions(
    db: Session = Depends(get_tenant_db),
    _:  User    = Depends(get_current_user),
):
    """Flat list of all permissions."""
    perms = _filter_enabled_module_permissions(
        db,
        db.query(Permission).order_by(Permission.module, Permission.action).all(),
    )
    return [
        {
            "id":          p.id,
            "key":         p.key,
            "module":      p.module,
            "action":      p.action,
            "description": p.description,
        }
        for p in perms
    ]


@router.post("/permissions", status_code=201)
def create_permission(
    data: PermissionCreate,
    db:   Session = Depends(get_tenant_db),
    cu:   User    = Depends(get_current_user),
):
    """Create a new permission entry (admin / ceo only)."""
    _require_role_admin(cu)

    # Normalise key
    key = data.key.strip().lower().replace(" ", ".")
    if not key:
        raise HTTPException(400, "Permission key cannot be empty")

    if db.query(Permission).filter(Permission.key == key).first():
        raise HTTPException(400, f"Permission '{key}' already exists")

    perm = Permission(
        key         = key,
        module      = data.module.strip().lower(),
        action      = data.action.strip().lower(),
        description = data.description or f"{data.module} {data.action}",
    )
    db.add(perm)
    db.commit()
    db.refresh(perm)
    invalidate_permissions_cache(db)
    return {
        "id":          perm.id,
        "key":         perm.key,
        "module":      perm.module,
        "action":      perm.action,
        "description": perm.description,
    }


@router.delete("/permissions/{perm_id}")
def delete_permission(
    perm_id: int,
    db:      Session = Depends(get_tenant_db),
    cu:      User    = Depends(get_current_user),
):
    """Delete a permission and remove it from all roles."""
    _require_role_admin(cu)

    perm = db.query(Permission).filter(Permission.id == perm_id).first()
    if not perm:
        raise HTTPException(404, "Permission not found")

    # Remove from all role_permissions first
    db.query(RolePermission).filter(RolePermission.permission_id == perm_id).delete()
    db.delete(perm)
    db.commit()
    invalidate_permissions_cache(db)
    return {"message": f"Permission '{perm.key}' deleted and removed from all roles"}


# ═══════════════════════════════════════════════════════════════════════════════
# DYNAMIC ROUTES — /{role_id} below static routes
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/{role_id}")
def get_role(
    role_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    role = db.query(Role).filter(Role.id == role_id).first()
    if not role:
        raise HTTPException(404, "Role not found")
    return _role_dict(db, role)


@router.post("", status_code=201)
def create_role(
    data:    RoleCreate,
    request: Request,
    db:      Session = Depends(get_tenant_db),
    cu:      User    = Depends(get_current_user),
):
    """
    Create a custom role OR provision a preset role that doesn't exist yet.
    The frontend "provision" flow calls this endpoint with a preset name/display_name.
    """
    _require_role_admin(cu)

    clean_name = data.name.lower().strip().replace(" ", "_")
    if not clean_name:
        raise V.field_error("name", "Role name cannot be empty.", 400)

    if db.query(Role).filter(Role.name == clean_name).first():
        raise V.field_error("name", f'A role "{data.display_name.strip()}" already exists. Please use a different name.', 409)
    if db.query(Role.id).filter(func.lower(Role.display_name) == data.display_name.strip().lower()).first():
        raise V.field_error("display_name", f'A role named "{data.display_name.strip()}" already exists. Please use a different name.', 409)

    role = Role(
        name         = clean_name,
        display_name = data.display_name.strip(),
        level        = data.level,
        description  = data.description,
        is_system    = data.is_system,
        is_active    = True,
    )  
    if hasattr(role, 'color'): role.color = data.color
    if hasattr(role, 'icon'):  role.icon  = data.icon

    db.add(role)
    db.flush()  # get ID before logging

    try:
        log_module_action(
            db=db, user_id=cu.id, module="roles", action="create",
            record_id=role.id, record_name=role.display_name,
            ip=request.client.host if request.client else "",
        )
    except Exception:
        pass  # logging must not block the create

    db.commit()
    db.refresh(role)
    invalidate_permissions_cache(db)
    return _role_dict(db, role)


@router.put("/{role_id}")
def update_role(
    role_id: int,
    data:    RoleUpdate,
    request: Request,
    db:      Session = Depends(get_tenant_db),
    cu:      User    = Depends(get_current_user),
):
    _require_role_admin(cu)

    role = db.query(Role).filter(Role.id == role_id).first()
    if not role:
        raise HTTPException(404, "Role not found")

    before = model_snapshot(role)
    updates = data.model_dump(exclude_unset=True)
    new_display = updates.get("display_name")
    if new_display and db.query(Role.id).filter(func.lower(Role.display_name) == new_display.lower(), Role.id != role.id).first():
        raise V.field_error("display_name", f'A role named "{new_display}" already exists. Please use a different name.', 409)
    for field, val in updates.items():
        if hasattr(role, field):
            setattr(role, field, val)

    try:
        log_module_action(
            db=db, user_id=cu.id, module="roles", action="update",
            record_id=role.id, record_name=role.display_name,
            ip=request.client.host if request.client else "",
            old_data=before,
            new_data=model_snapshot(role),
        )
    except Exception:
        pass

    db.commit()
    db.refresh(role)
    invalidate_permissions_cache(db)
    return _role_dict(db, role)


@router.delete("/{role_id}")
def delete_role(
    role_id: int,
    request: Request,
    db:      Session = Depends(get_tenant_db),
    cu:      User    = Depends(get_current_user),
):
    _require_role_admin(cu)

    role = db.query(Role).filter(Role.id == role_id).first()
    if not role:
        raise HTTPException(404, "Role not found")

    if role.is_system:
        raise HTTPException(400, "System roles cannot be deleted")

    users_with_role = db.query(User).filter(User.role == role.name).count()
    if users_with_role > 0:
        raise HTTPException(
            400,
            f"Cannot delete: {users_with_role} user(s) still have this role. Reassign them first.",
        )

    before = model_snapshot(role)
    db.query(RolePermission).filter(RolePermission.role_id == role_id).delete()
    db.delete(role)

    try:
        log_module_action(
            db=db, user_id=cu.id, module="roles", action="delete",
            record_id=role_id, record_name=role.display_name,
            ip=request.client.host if request.client else "", old_data=before,
        )
    except Exception:
        pass

    db.commit()
    invalidate_permissions_cache(db)
    return {"message": f"Role '{role.display_name}' deleted successfully"}


# ─── Permission assignment for a role ─────────────────────────────────────────

@router.get("/{role_id}/permissions")
def get_role_permissions(
    role_id: int,
    db: Session = Depends(get_tenant_db),
    _:  User    = Depends(get_current_user),
):
    """Return permission IDs currently assigned to a role."""
    role = db.query(Role).filter(Role.id == role_id).first()
    if not role:
        raise HTTPException(404, "Role not found")

    granted = (
        db.query(Permission)
        .join(RolePermission, RolePermission.permission_id == Permission.id)
        .filter(RolePermission.role_id == role_id)
        .all()
    )
    # Stale grants for since-disabled modules aren't editable in the UI, so
    # don't surface them here either - keeps the selected count truthful and
    # matches what a save of this role will actually persist.
    perm_ids = [p.id for p in _filter_enabled_module_permissions(db, granted)]
    return {"role_id": role_id, "permission_ids": perm_ids}


@router.put("/{role_id}/permissions")
def set_role_permissions(
    role_id: int,
    data: PermissionsBulk,
    request: Request,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    _require_role_admin(cu)

    role = db.query(Role).filter(Role.id == role_id).first()
    if not role:
        raise HTTPException(404, "Role not found")

    before = _permission_audit_snapshot(db, role_id)

    allowed_scopes = {"own", "team", "all", "none"}

    scope_by_module = {
        item.module.strip().lower(): item.data_scope
        for item in data.module_scopes
        if item.module and item.data_scope in allowed_scopes
    }

    if data.permission_ids:
        permissions = db.query(Permission).filter(
            Permission.id.in_(data.permission_ids)
        ).all()

        valid_ids = {p.id for p in permissions}
        invalid = set(data.permission_ids) - valid_ids

        if invalid:
            raise HTTPException(400, f"Unknown permission IDs: {sorted(invalid)}")

        # Permissions for modules disabled since this role was last saved are
        # invisible in the editor, so a save must drop them rather than block
        # the whole request over stale ids the user never touched.
        permissions = _filter_enabled_module_permissions(db, permissions)
    else:
        permissions = []

    permission_map = {p.id: p for p in permissions}

    db.query(RolePermission).filter(
        RolePermission.role_id == role_id
    ).delete(synchronize_session=False)

    for pid, permission in permission_map.items():
        module_key = (permission.module or "").strip().lower()

        db.add(RolePermission(
            role_id=role_id,
            permission_id=pid,
            data_scope=scope_by_module.get(module_key, "own"),
        ))

    # Flush makes the replacement assignments queryable before the audit row is
    # created, while retaining a single transaction with the update itself.
    db.flush()
    after = _permission_audit_snapshot(db, role_id)

    try:
        log_module_action(
            db=db,
            user_id=cu.id,
            module="roles",
            action="permission_change",
            record_id=role_id,
            record_name=role.display_name,
            ip=request.client.host if request.client else "",
            old_data=before,
            new_data=after,
        )
    except Exception:
        pass

    db.commit()
    invalidate_permissions_cache(db)

    return {
        "message": "Permissions updated",
        "role_id": role_id,
        "permission_count": len(permission_map),
        "module_scopes": scope_by_module,
    }

@router.post("/{role_id}/permissions/{perm_id}")
def grant_permission(
    role_id: int,
    perm_id: int,
    request: Request,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    """Grant a single permission to a role (idempotent)."""
    _require_role_admin(cu)

    role = db.query(Role).filter(Role.id == role_id).first()
    if not role:
        raise HTTPException(404, "Role not found")
    permission = db.query(Permission).filter(Permission.id == perm_id).first()
    if not permission:
        raise HTTPException(404, "Permission not found")
    _ensure_permissions_assignable(db, [permission])

    existing = db.query(RolePermission).filter(
        RolePermission.role_id       == role_id,
        RolePermission.permission_id == perm_id,
    ).first()

    if not existing:
        before = _permission_audit_snapshot(db, role_id)
        db.add(RolePermission(role_id=role_id, permission_id=perm_id))
        db.flush()
        log_module_action(
            db=db, user_id=cu.id, module="roles", action="permission_change",
            record_id=role_id, record_name=role.display_name,
            ip=request.client.host if request.client else "",
            old_data=before,
            new_data=_permission_audit_snapshot(db, role_id),
        )
        db.commit()
        invalidate_permissions_cache(db)
        return {"message": "Permission granted"}

    return {"message": "Permission already granted"}


@router.delete("/{role_id}/permissions/{perm_id}")
def revoke_permission(
    role_id: int,
    perm_id: int,
    request: Request,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    """Revoke a single permission from a role (idempotent)."""
    _require_role_admin(cu)

    rp = db.query(RolePermission).filter(
        RolePermission.role_id       == role_id,
        RolePermission.permission_id == perm_id,
    ).first()

    if rp:
        role = db.query(Role).filter(Role.id == role_id).first()
        permission = db.query(Permission).filter(Permission.id == perm_id).first()
        before = _permission_audit_snapshot(db, role_id)
        db.delete(rp)
        db.flush()
        log_module_action(
            db=db, user_id=cu.id, module="roles", action="permission_change",
            record_id=role_id, record_name=role.display_name if role else None,
            ip=request.client.host if request.client else "",
            old_data=before,
            new_data=_permission_audit_snapshot(db, role_id),
        )
        db.commit()
        invalidate_permissions_cache(db)
        return {"message": "Permission revoked"}

    return {"message": "Permission was not assigned"}
