"""Masters (prototype v17 R.masters).  Mounted at /api/v1/masters360

GET  /tree                                   every master (standard + custom) with counts, screens, kinds, modules
GET  /{key}?q&offset&limit                   one master: definition, paginated values (+ parent labels, Used), parent choices, form usage
POST /{key}/values · PUT /{key}/values/{id} · DELETE /{key}/values/{id} · POST /{key}/values/{id}/move · POST /{key}/import
POST /                                       new custom master (name, description, type, parent master, initial values, add lookup field)
PUT  /{key} · DELETE /{key}                  rename / delete a custom master
POST /{key}/add-to-form                      add a Master lookup field for it to a module form (Customization Studio)

Reads: masters.view (or admin / ceo / manager / vp).  Writes: masters.manage (or admin / ceo).
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.logging import log_audit_db
from app.database import get_master_db_dep
from app.dependencies import get_current_user, get_request_ip, get_tenant_db, user_has_permission
from app.models.all_models import User
from app.models.tenant import Tenant
from app.services import masters360_service as S

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Masters"])
ADMIN_ROLES = ("admin", "ceo")
VIEW_ROLES = ("admin", "ceo", "manager", "vp")


def viewer(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if (cu.role or "") not in VIEW_ROLES and not user_has_permission(db, cu, "masters.view"):
        raise HTTPException(403, "You don't have access to Masters")
    S.ensure_schema(db)
    return cu


def manager(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if (cu.role or "") not in ADMIN_ROLES and not user_has_permission(db, cu, "masters.manage"):
        raise HTTPException(403, "You don't have permission to change masters")
    S.ensure_schema(db)
    return cu


def _company(request: Request, master_db: Session) -> str:
    slug = getattr(request.state, "tenant_slug", None)
    if slug:
        row = master_db.query(Tenant.name).filter(Tenant.slug == slug).first()
        if row and row[0]:
            return str(row[0])
    return str(slug or "Workspace")


def _audit(db: Session, request: Request, cu: User, action: str, rid: Optional[int], text: str) -> None:
    try:
        log_audit_db(db, cu.id, "masters", action, rid, get_request_ip(request), text)
        db.commit()
    except Exception as exc:  # pragma: no cover
        logger.warning("masters audit failed: %s", exc)
        db.rollback()


@router.get("/tree")
def tree(request: Request, db: Session = Depends(get_tenant_db), master_db: Session = Depends(get_master_db_dep), cu: User = Depends(viewer)):
    out = S.tree(db, _company(request, master_db))
    out["can_manage"] = (cu.role or "") in ADMIN_ROLES or user_has_permission(db, cu, "masters.manage")
    return out


class MasterIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    description: str = Field("", max_length=300)
    kind: str = "Simple list"
    parent_key: Optional[str] = Field(None, max_length=80)
    values: list[str] = Field(default_factory=list, max_length=2000)
    add_to: Optional[str] = Field(None, max_length=40)


class MasterPatch(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=300)


class ValueIn(BaseModel):
    v: str = Field(..., max_length=200)
    attrs: dict[str, Any] = Field(default_factory=dict)
    parent_id: Optional[int] = None


class ValuePatch(BaseModel):
    v: Optional[str] = Field(None, max_length=200)
    attrs: Optional[dict[str, Any]] = None
    parent_id: Optional[int] = None
    on: Optional[bool] = None


class MoveIn(BaseModel):
    dir: int = Field(..., ge=-1, le=1)


class ImportIn(BaseModel):
    values: list[str] = Field(..., min_length=1, max_length=2000)
    parent_id: Optional[int] = None


class AddToFormIn(BaseModel):
    module: str = Field(..., max_length=40)
    label: str = Field("", max_length=200)


@router.post("", status_code=201)
def create_master(body: MasterIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    key = S.create_master(db, cu, body.name, body.description, body.kind, body.parent_key, body.values, body.add_to)
    _audit(db, request, cu, "master_create", None, f"Master “{body.name}” created ({key}, {body.kind})")
    return {"key": key}


@router.get("/{key}")
def get_master(key: str, q: str = "", offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=500), db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return S.master(db, key, q=q.strip()[:120], offset=offset, limit=limit)


@router.put("/{key}")
def rename_master(key: str, body: MasterPatch, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    S.rename_master(db, key, body.name, body.description)
    _audit(db, request, cu, "master_rename", None, f"Master {key} renamed to “{body.name}”")
    return {"ok": True}


@router.delete("/{key}")
def delete_master(key: str, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    S.delete_master(db, key)
    _audit(db, request, cu, "master_delete", None, f"Master {key} deleted")
    return {"ok": True}


@router.post("/{key}/values", status_code=201)
def add_value(key: str, body: ValueIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    vid = S.add_value(db, key, body.v, body.attrs, body.parent_id)
    _audit(db, request, cu, "value_add", vid, f"{key}: “{body.v}” added")
    return {"id": vid}


@router.put("/{key}/values/{vid}")
def update_value(key: str, vid: int, body: ValuePatch, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    S.update_value(db, key, vid, body.model_dump(exclude_unset=True))
    _audit(db, request, cu, "value_update", vid, f"{key}: value #{vid} updated")
    return {"ok": True}


@router.delete("/{key}/values/{vid}")
def delete_value(key: str, vid: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    S.delete_value(db, key, vid)
    _audit(db, request, cu, "value_delete", vid, f"{key}: value #{vid} removed")
    return {"ok": True}


@router.post("/{key}/values/{vid}/move")
def move_value(key: str, vid: int, body: MoveIn, db: Session = Depends(get_tenant_db), _: User = Depends(manager)):
    S.move_value(db, key, vid, body.dir)
    return {"ok": True}


@router.post("/{key}/import")
def import_values(key: str, body: ImportIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    n = S.import_values(db, key, body.values, body.parent_id)
    _audit(db, request, cu, "value_import", None, f"{key}: {n} value(s) imported")
    return {"added": n}


@router.post("/{key}/add-to-form", status_code=201)
def add_to_form(key: str, body: AddToFormIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    fid = S.add_to_form(db, key, body.module, body.label)
    _audit(db, request, cu, "add_to_form", fid, f"{key}: lookup field added to {body.module}")
    return {"id": fid}
