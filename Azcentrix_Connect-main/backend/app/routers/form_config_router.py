"""Form Builder router — manage per-tenant form field configuration."""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.dependencies import get_current_user, get_tenant_db
from app.models.all_models import (
    FormField, Permission, Role, RolePermission, User,
)

logger = logging.getLogger(__name__)
router = APIRouter()

ALLOWED_MODULES = {"customers", "leads", "opportunities", "tenders", "work_orders", "travel", "users", "oem", "competitors"}
ALLOWED_TYPES = {"text", "number", "date", "select", "checkbox", "textarea", "email", "url", "phone"}


# ─── helpers ──────────────────────────────────────────────────────────────────

def _has_perm(db: Session, user: User, key: str) -> bool:
    role = db.query(Role).filter(Role.name == user.role, Role.is_active == True).first()
    if not role:
        return False
    perm = db.query(Permission).filter(Permission.key == key).first()
    if not perm:
        return False
    return db.query(RolePermission).filter(
        RolePermission.role_id == role.id,
        RolePermission.permission_id == perm.id,
    ).first() is not None


def _field_to_dict(f: FormField) -> dict:
    return {
        "id":          f.id,
        "module":      f.module,
        "section":     f.section,
        "field_key":   f.field_key,
        "field_type":  f.field_type,
        "label":       f.label,
        "placeholder": f.placeholder,
        "options":     f.options,
        "col_span":    f.col_span,
        "is_required": f.is_required,
        "is_visible":  f.is_visible,
        "is_custom":   f.is_custom,
        "sort_order":  f.sort_order,
    }


# ─── schemas ──────────────────────────────────────────────────────────────────

class FieldCreate(BaseModel):
    section:     str
    field_key:   str
    field_type:  str = "text"
    label:       str
    placeholder: Optional[str] = None
    options:     Optional[Any] = None
    col_span:    int = 1
    is_required: bool = False
    is_visible:  bool = True
    is_custom:   bool = True
    sort_order:  int = 0


class FieldUpdate(BaseModel):
    field_type:  Optional[str] = None
    label:       Optional[str] = None
    placeholder: Optional[str] = None
    options:     Optional[Any] = None
    col_span:    Optional[int] = None
    is_required: Optional[bool] = None
    is_visible:  Optional[bool] = None
    sort_order:  Optional[int] = None


class FieldOrder(BaseModel):
    field_key:  str
    sort_order: int


class FieldReorder(BaseModel):
    module:  str
    section: str
    orders:  list[FieldOrder]


# ─── endpoints ────────────────────────────────────────────────────────────────

@router.patch("/fields/reorder")
def reorder_fields(
    body: FieldReorder,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    if body.module not in ALLOWED_MODULES:
        raise HTTPException(400, f"Unknown module: {body.module}")
    if not _has_perm(db, current_user, "form_builder.manage"):
        raise HTTPException(403, "form_builder.manage permission required")

    section = body.section.strip()
    if not section:
        raise HTTPException(400, "section is required")

    field_keys = [order.field_key.strip() for order in body.orders]
    if not field_keys:
        return []
    if any(not key for key in field_keys):
        raise HTTPException(400, "field_key is required for every order item")
    if len(set(field_keys)) != len(field_keys):
        raise HTTPException(400, "Duplicate field_key values are not allowed")

    rows = (
        db.query(FormField)
        .filter(
            FormField.module == body.module,
            FormField.section == section,
            FormField.field_key.in_(field_keys),
        )
        .all()
    )
    row_by_key = {row.field_key: row for row in rows}
    missing = [key for key in field_keys if key not in row_by_key]
    if missing:
        raise HTTPException(
            404,
            f"Fields not found in section '{section}': {', '.join(missing)}",
        )

    for order in body.orders:
        row_by_key[order.field_key.strip()].sort_order = order.sort_order

    db.commit()

    fields = (
        db.query(FormField)
        .filter(FormField.module == body.module, FormField.section == section)
        .order_by(FormField.section, FormField.sort_order, FormField.id)
        .all()
    )
    return [_field_to_dict(f) for f in fields]


@router.get("/{module}")
def get_field_configs(
    module: str,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    if module not in ALLOWED_MODULES:
        raise HTTPException(400, f"Unknown module: {module}")
    fields = (
        db.query(FormField)
        .filter(FormField.module == module)
        .order_by(FormField.section, FormField.sort_order, FormField.id)
        .all()
    )
    return [_field_to_dict(f) for f in fields]


@router.post("/{module}", status_code=201)
def create_field(
    module: str,
    body: FieldCreate,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    if module not in ALLOWED_MODULES:
        raise HTTPException(400, f"Unknown module: {module}")
    if not _has_perm(db, current_user, "form_builder.manage"):
        raise HTTPException(403, "form_builder.manage permission required")
    if body.field_type not in ALLOWED_TYPES:
        raise HTTPException(400, f"Unsupported field_type: {body.field_type}")

    # Prevent duplicate field_key within same module+section
    exists = db.query(FormField).filter(
        FormField.module == module,
        FormField.section == body.section,
        FormField.field_key == body.field_key,
    ).first()
    if exists:
        raise HTTPException(409, f"field_key '{body.field_key}' already exists in section '{body.section}'")

    field = FormField(
        module=module,
        section=body.section,
        field_key=body.field_key,
        field_type=body.field_type,
        label=body.label,
        placeholder=body.placeholder,
        options=body.options,
        col_span=body.col_span,
        is_required=body.is_required,
        is_visible=body.is_visible,
        is_custom=body.is_custom,
        sort_order=body.sort_order,
    )
    db.add(field)
    db.commit()
    db.refresh(field)
    return _field_to_dict(field)


@router.put("/{module}/fields/{field_id}")
def update_field(
    module: str,
    field_id: int,
    body: FieldUpdate,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    if not _has_perm(db, current_user, "form_builder.manage"):
        raise HTTPException(403, "form_builder.manage permission required")
    field = db.query(FormField).filter(
        FormField.id == field_id, FormField.module == module,
    ).first()
    if not field:
        raise HTTPException(404, "Field not found")
    if body.field_type is not None:
        if body.field_type not in ALLOWED_TYPES:
            raise HTTPException(400, f"Unsupported field_type: {body.field_type}")
        field.field_type = body.field_type
    if body.label       is not None: field.label       = body.label
    if body.placeholder is not None: field.placeholder = body.placeholder
    if body.options     is not None: field.options     = body.options
    if body.col_span    is not None: field.col_span    = body.col_span
    if body.is_required is not None: field.is_required = body.is_required
    if body.is_visible  is not None: field.is_visible  = body.is_visible
    if body.sort_order  is not None: field.sort_order  = body.sort_order
    db.commit()
    db.refresh(field)
    return _field_to_dict(field)


@router.delete("/{module}/fields/{field_id}", status_code=204)
def delete_field(
    module: str,
    field_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    if not _has_perm(db, current_user, "form_builder.manage"):
        raise HTTPException(403, "form_builder.manage permission required")
    field = db.query(FormField).filter(
        FormField.id == field_id, FormField.module == module,
        FormField.is_custom == True,  # Only custom fields can be deleted; overrides use update
    ).first()
    if not field:
        raise HTTPException(404, "Custom field not found")
    db.delete(field)
    db.commit()
