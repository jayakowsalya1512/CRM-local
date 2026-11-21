"""Customization Studio (prototype v17).  Mounted at /api/v1/studio

Layouts & fields        GET /layout/meta · GET /layout/{module} · PUT /layout/{module}
Picklists               GET /picklists
Custom objects          GET /objects · POST /objects · GET /objects/{id} · DELETE /objects/{id}
                        POST /objects/{id}/records/query · POST /objects/{id}/records · PUT /objects/{id}/records/{rid} · DELETE …
Validation rules        GET /rules · POST /rules · PUT /rules/{id} · PATCH /rules/{id}/toggle · DELETE /rules/{id}

Reads: admin / ceo / manager / vp or form_builder.manage.  Writes: admin / ceo or form_builder.manage.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.logging import log_audit_db
from app.dependencies import get_current_user, get_request_ip, get_tenant_db, user_has_permission
from app.models.all_models import User
from app.services import studio_service as S

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Customization Studio"])
PERM = "form_builder.manage"
ADMIN_ROLES = ("admin", "ceo")
VIEW_ROLES = ("admin", "ceo", "manager", "vp")


def viewer(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if (cu.role or "") not in VIEW_ROLES and not user_has_permission(db, cu, PERM):
        raise HTTPException(403, "You don't have access to the Customization Studio")
    S.ensure_schema(db)
    return cu


def manager(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if (cu.role or "") not in ADMIN_ROLES and not user_has_permission(db, cu, PERM):
        raise HTTPException(403, "You don't have permission to customise forms")
    S.ensure_schema(db)
    return cu


def _audit(db: Session, request: Request, cu: User, action: str, rid: Optional[int], text: str) -> None:
    try:
        log_audit_db(db, cu.id, "form_builder", action, rid, get_request_ip(request), text)
        db.commit()
    except Exception as exc:  # pragma: no cover
        logger.warning("studio audit failed: %s", exc)
        db.rollback()


# ─── Layouts & fields ─────────────────────────────────────────────────────────

class LayoutIn(BaseModel):
    fields: list[dict[str, Any]]


@router.get("/layout/meta")
def layout_meta(db: Session = Depends(get_tenant_db), cu: User = Depends(viewer)):
    out = S.meta()
    out["can_manage"] = (cu.role or "") in ADMIN_ROLES or user_has_permission(db, cu, PERM)
    return out


@router.get("/layout/{module}")
def get_layout(module: str, db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return S.layout(db, module)


@router.put("/layout/{module}")
def put_layout(module: str, body: LayoutIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    out = S.save_layout(db, cu, module, body.fields)
    _audit(db, request, cu, "update", None, f"Form layout saved: {S.MODULE_LABEL.get(module, module)} ({len(out['fields'])} fields)")
    return out


# ─── Picklists ────────────────────────────────────────────────────────────────

@router.get("/picklists")
def get_picklists(db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return S.picklists(db)


# ─── Custom objects ───────────────────────────────────────────────────────────

class ObjectIn(BaseModel):
    name: str
    plural: str = ""
    fields: list[dict[str, Any]] = Field(default_factory=list)


class RecordsQuery(BaseModel):
    q: str = ""
    sorts: list[list[Any]] = Field(default_factory=list)
    offset: int = 0
    limit: int = 25


class RecordIn(BaseModel):
    data: dict[str, Any] = Field(default_factory=dict)


@router.get("/objects")
def list_objects(db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return {"items": S.objects(db)}


@router.post("/objects", status_code=201)
def create_object(body: ObjectIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    out = S.create_object(db, cu, body.name, body.plural, body.fields)
    _audit(db, request, cu, "create", out["id"], f"Custom object created: {out['p']}")
    return out


@router.get("/objects/{object_id}")
def get_object(object_id: int, db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    o, fields = S.get_object(db, object_id)
    return S._obj_dict(o, fields, 0)


@router.delete("/objects/{object_id}")
def delete_object(object_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    S.delete_object(db, object_id)
    _audit(db, request, cu, "delete", object_id, "Custom object removed")
    return {"ok": True}


@router.post("/objects/{object_id}/records/query")
def query_records(object_id: int, body: RecordsQuery, db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return S.records(db, object_id, q=body.q.strip()[:120], sorts=body.sorts, offset=body.offset, limit=body.limit)


@router.post("/objects/{object_id}/records", status_code=201)
def create_record(object_id: int, body: RecordIn, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    return S.save_record(db, cu, object_id, body.data)


@router.put("/objects/{object_id}/records/{record_id}")
def update_record(object_id: int, record_id: int, body: RecordIn, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    return S.save_record(db, cu, object_id, body.data, record_id)


@router.delete("/objects/{object_id}/records/{record_id}")
def delete_record(object_id: int, record_id: int, db: Session = Depends(get_tenant_db), _: User = Depends(manager)):
    S.delete_record(db, object_id, record_id)
    return {"ok": True}


# ─── Validation rules ─────────────────────────────────────────────────────────

class RuleIn(BaseModel):
    name: str = ""
    object: str
    formula: str
    message: str
    on: Optional[bool] = None


class ToggleIn(BaseModel):
    on: bool


@router.get("/rules")
def list_rules(db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return S.rules(db)


@router.post("/rules", status_code=201)
def create_rule(body: RuleIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    out = S.save_rule(db, cu, body.model_dump(exclude_none=True))
    _audit(db, request, cu, "create", out["id"], f"Validation rule created: {out['n']}")
    return out


@router.put("/rules/{rule_id}")
def update_rule(rule_id: int, body: RuleIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    out = S.save_rule(db, cu, body.model_dump(exclude_none=True), rule_id)
    _audit(db, request, cu, "update", rule_id, f"Validation rule updated: {out['n']}")
    return out


@router.patch("/rules/{rule_id}/toggle")
def toggle_rule(rule_id: int, body: ToggleIn, db: Session = Depends(get_tenant_db), _: User = Depends(manager)):
    return S.toggle_rule(db, rule_id, body.on)


@router.delete("/rules/{rule_id}")
def delete_rule(rule_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    S.delete_rule(db, rule_id)
    _audit(db, request, cu, "delete", rule_id, "Validation rule removed")
    return {"ok": True}
