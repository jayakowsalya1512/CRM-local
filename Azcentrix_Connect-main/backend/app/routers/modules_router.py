from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from sqlalchemy.orm import Session

from app.dependencies import get_current_user, get_tenant_db
from app.models.all_models import Module, Permission, Role, RolePermission, User
from app.services.tenant_module_service import SECTION_SORT_ORDER, DEFAULT_TENANT_PERMISSIONS
from app.services.cache_service import (
    CACHE_TTL_SECONDS,
    cache_get_json,
    cache_set_json,
    sidebar_cache_key,
    invalidate_sidebar_cache,
    tenant_slug_from_db,
)

router = APIRouter()

MODULE_PERMISSION_COMPAT: dict[str, set[str]] = {
    # Older tenant catalogues used settings.manage as the Settings module key.
    # Keep both keys visible while Settings moves to the role matrix View column.
    "settings": {"settings.view", "settings.manage"},
    # The Reports page is a parent module for granular report-tab permissions.
    # A role with any report tab permission should still see the Reports menu.
    "reports": {
        "reports.customers.view",
        "reports.leads.view",
        "reports.opportunities.view",
        "reports.tenders.view",
        "reports.quotations.view",
        "reports.workorders.view",
        "reports.emdbg.view",
        "reports.kam.view",
        "reports.travel.view",
        "reports.tada.view",
        "reports.oem.view",
        "reports.competitors.view",
    },
}

RECYCLE_BIN_MODULE_KEY = "recycle_bin"
RECYCLE_BIN_SECTION = "admin"
RECYCLE_BIN_SORT_ORDER = 99


def _module_section(row) -> str | None:
    if getattr(row, "key", None) == RECYCLE_BIN_MODULE_KEY:
        return RECYCLE_BIN_SECTION
    return getattr(row, "section", None)


def _module_sort_order(row) -> int:
    if getattr(row, "key", None) == RECYCLE_BIN_MODULE_KEY:
        return RECYCLE_BIN_SORT_ORDER
    return int(getattr(row, "sort_order", 0) or 0)


def _normalize_cached_modules(rows: list[dict]) -> list[dict]:
    normalized = []
    for row in rows:
        item = dict(row)
        if item.get("key") == RECYCLE_BIN_MODULE_KEY:
            item["section"] = RECYCLE_BIN_SECTION
            item["sort_order"] = RECYCLE_BIN_SORT_ORDER
        normalized.append(item)
    normalized.sort(
        key=lambda row: (
            SECTION_SORT_ORDER.get(str(row.get("section") or "").strip().lower(), 999),
            int(row.get("sort_order") or 0),
            str(row.get("label") or "").strip().lower(),
        )
    )
    return normalized


def _get_user_permission_keys(db: Session, current_user: User) -> set[str]:
    role_row = db.query(Role).filter(
        Role.name == current_user.role,
        Role.is_active == True,
    ).first()
    if not role_row:
        return set()

    permission_ids = [
        row.permission_id
        for row in db.query(RolePermission).filter(RolePermission.role_id == role_row.id).all()
    ]
    if not permission_ids:
        return set()

    return {
        row.key
        for row in db.query(Permission).filter(Permission.id.in_(permission_ids)).all()
    }


@router.get("")
def list_modules(
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    tenant_slug = tenant_slug_from_db(db)
    # cache key versioned so cached menus pick up the prototype v17 sidebar (groups, names, icons)
    cache_key = sidebar_cache_key(tenant_slug, current_user.id, "menu-v22") if tenant_slug else ""
    if cache_key:
        cached = cache_get_json(cache_key, "sidebar-menu")
        if cached is not None:
            if isinstance(cached, list):
                normalized = _normalize_cached_modules(cached)
                cache_set_json(cache_key, normalized, CACHE_TTL_SECONDS["sidebar"])
                return normalized
            return cached

    permission_keys = _get_user_permission_keys(db, current_user)
    rows = db.query(Module).filter(Module.is_active == True).all()

    items = [
        row
        for row in rows
        if (
            not row.permission_key
            or row.permission_key in permission_keys
            or bool(MODULE_PERMISSION_COMPAT.get(row.key, set()) & permission_keys)
        )
    ]
    items.sort(
        key=lambda row: (
            SECTION_SORT_ORDER.get((_module_section(row) or "").strip().lower(), 999),
            _module_sort_order(row),
            (row.label or "").strip().lower(),
        )
    )

    response = [
        {
            "id": row.id,
            "key": row.key,
            "label": row.display_name or row.label,
            "default_label": row.label,
            "display_name": row.display_name,
            "display_name_singular": row.display_name_singular,
            "icon": row.icon,
            "route": row.route,
            "section": _module_section(row),
            "sort_order": _module_sort_order(row),
            "parent_key": row.parent_key,
            "permission_key": row.permission_key,
            "is_active": bool(row.is_active),
            "is_system": bool(row.is_system),
        }
        for row in items
    ]
    if cache_key:
        cache_set_json(cache_key, response, CACHE_TTL_SECONDS["sidebar"])
    return response


class RenameLabelRequest(BaseModel):
    display_name: Optional[str] = None
    display_name_singular: Optional[str] = None


@router.patch("/{module_key}/label")
def rename_module_label(
    module_key: str,
    body: RenameLabelRequest,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    """Save custom display name(s) for a module. Requires modules.rename or settings.manage."""
    user_perms = _get_user_permission_keys(db, cu)
    if not ({"modules.rename", "settings.manage"} & user_perms):
        raise HTTPException(status_code=403, detail="Permission denied")

    module = db.query(Module).filter(Module.key == module_key).first()
    if not module:
        raise HTTPException(status_code=404, detail="Module not found")

    if body.display_name is not None:
        val = body.display_name.strip()[:100]
        module.display_name = val or None          # empty string → reset to default

    if body.display_name_singular is not None:
        module.display_name_singular = body.display_name_singular.strip()[:100] or None

    db.commit()
    invalidate_sidebar_cache(db)
    return {
        "key": module_key,
        "display_name": module.display_name,
        "display_name_singular": module.display_name_singular,
    }


@router.post("/sync-permissions")
def sync_missing_permissions(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    """Upsert any missing default permissions into this tenant's DB. Admin only."""
    user_perms = _get_user_permission_keys(db, cu)
    if not ({"settings.manage"} & user_perms):
        raise HTTPException(status_code=403, detail="Admin only")

    existing = {row.key for row in db.query(Permission).all()}
    added = []
    for key, module_name, action, description in DEFAULT_TENANT_PERMISSIONS:
        if key not in existing:
            db.add(Permission(key=key, module=module_name, action=action, description=description))
            added.append(key)
    db.commit()
    return {"added": added, "total_new": len(added)}
