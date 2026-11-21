"""Partners & OEM / Competitive Intel (prototype v17 Directory).  Mounted at /api/v1/directory

Partners & OEM      GET /oems/meta · POST /oems/query · GET /oems/{id} · POST /oems · PUT /oems/{id} · POST /oems/delete
Competitive Intel   GET /competitors/meta · POST /competitors/query · GET /competitors/{id} · POST /competitors · PUT /competitors/{id} · POST /competitors/delete

Permissions: oems.view / oems.create / oems.update / oems.delete and competitors.* (admin / ceo always pass).
The classic forms stay on /oems and /masters/competitors.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator, model_validator
from app.core import validators as V
from sqlalchemy.orm import Session

from app.core.logging import log_audit_db
from app.database import get_master_db_dep
from app.dependencies import get_current_user, get_request_ip, get_tenant_db, user_has_permission
from app.models.all_models import User
from app.models.tenant import Tenant
from app.services import directory_service as S

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Partners & OEM / Competitive Intel"])
ADMIN_ROLES = ("admin", "ceo")


def _guard(perm: str, what: str):
    def dep(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
        if (cu.role or "") not in ADMIN_ROLES and not user_has_permission(db, cu, perm):
            raise HTTPException(403, f"You don't have permission to {what}")
        S.ensure_schema(db)
        return cu
    return dep


oem_viewer, oem_creator, oem_editor, oem_deleter = _guard("oems.view", "view Partners & OEM"), _guard("oems.create", "add partners"), \
    _guard("oems.update", "edit partners"), _guard("oems.delete", "delete partners")
comp_viewer, comp_creator, comp_editor, comp_deleter = _guard("competitors.view", "view Competitive Intel"), _guard("competitors.create", "add competitors"), \
    _guard("competitors.update", "edit competitors"), _guard("competitors.delete", "delete competitors")


def _can(db: Session, cu: User, module: str) -> dict:
    adm = (cu.role or "") in ADMIN_ROLES
    return {a: adm or user_has_permission(db, cu, f"{module}.{a}") for a in ("create", "update", "delete")}


def _company(request: Request, master_db: Session) -> str:
    slug = getattr(request.state, "tenant_slug", None)
    if slug:
        row = master_db.query(Tenant.name).filter(Tenant.slug == slug).first()
        if row and row[0]:
            return str(row[0])
    return str(slug or "Workspace")


def _audit(db: Session, request: Request, cu: User, module: str, action: str, rid: Optional[int], text: str) -> None:
    try:
        log_audit_db(db, cu.id, module, action, rid, get_request_ip(request), text)
        db.commit()
    except Exception as exc:  # pragma: no cover
        logger.warning("directory audit failed: %s", exc)
        db.rollback()


class ListQuery(BaseModel):
    view: str = "All"
    category: str = ""
    q: str = ""
    f: dict[str, str] = Field(default_factory=dict)
    adv: dict[str, Any] = Field(default_factory=lambda: {"logic": "AND", "conds": []})
    sorts: list[list[Any]] = Field(default_factory=list)
    offset: int = Field(0, ge=0)
    limit: int = Field(25, ge=1, le=250)


class IdsIn(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=500)


# ─── Partners & OEM ───────────────────────────────────────────────────────────

class OemIn(BaseModel):
    name: Optional[str] = Field(None, max_length=200)
    category: Optional[str] = Field(None, max_length=100)
    contact: Optional[str] = Field(None, max_length=100)
    auth: Optional[str] = Field(None, max_length=10)
    discount: Optional[float] = None
    rating: Optional[int] = None
    status: Optional[str] = Field(None, max_length=20)
    notes: Optional[str] = Field(None, max_length=5000)

    @field_validator("name")
    @classmethod
    def _txt13(cls, v):
        return V.check_text(v, "Name", 2, 200, required=False)

    @field_validator("discount")
    @classmethod
    def _disc(cls, v):
        return V.check_percent(v, "Discount %")

    @field_validator("rating")
    @classmethod
    def _rating(cls, v):
        if v is not None and not (0 <= v <= 5):
            raise ValueError("Rating must be between 0 and 5.")
        return v


@router.get("/oems/meta")
def oems_meta(request: Request, db: Session = Depends(get_tenant_db), master_db: Session = Depends(get_master_db_dep), cu: User = Depends(oem_viewer)):
    out = S.oem_meta(db, _company(request, master_db))
    out["can"] = _can(db, cu, "oems")
    return out


@router.post("/oems/query")
def oems_query(body: ListQuery, db: Session = Depends(get_tenant_db), _: User = Depends(oem_viewer)):
    return S.oem_list(db, view=body.view if body.view in S.OEM_VIEWS else "All", category=body.category.strip()[:100], q=body.q.strip()[:120], f=body.f, adv=body.adv,
                      sorts=body.sorts, offset=body.offset, limit=body.limit)


@router.get("/oems/{oem_id}")
def oem_detail(oem_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(oem_viewer)):
    out = S.oem_detail(db, oem_id)
    out["can"] = _can(db, cu, "oems")
    return out


@router.post("/oems", status_code=201)
def oem_create(body: OemIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(oem_creator)):
    rid = S.oem_create(db, cu, body.model_dump())
    _audit(db, request, cu, "oems", "create", rid, f"Partner created: {body.name}")
    return {"id": rid}


@router.put("/oems/{oem_id}")
def oem_update(oem_id: int, body: OemIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(oem_editor)):
    S.oem_update(db, cu, oem_id, body.model_dump(exclude_unset=True))
    _audit(db, request, cu, "oems", "update", oem_id, "Partner updated: " + ", ".join(body.model_dump(exclude_unset=True).keys()))
    return {"ok": True}


@router.post("/oems/delete")
def oem_delete(body: IdsIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(oem_deleter)):
    n = S.oem_delete(db, body.ids)
    _audit(db, request, cu, "oems", "delete", None, f"{n} partner(s) deleted")
    return {"deleted": n}


# ─── Competitive Intel ────────────────────────────────────────────────────────

class CompIn(BaseModel):
    name: Optional[str] = Field(None, max_length=200)
    hq: Optional[str] = Field(None, max_length=100)
    strength: Optional[str] = Field(None, max_length=2000)
    weak: Optional[str] = Field(None, max_length=2000)
    notes: Optional[str] = Field(None, max_length=5000)

    @field_validator("name")
    @classmethod
    def _txt14(cls, v):
        return V.check_text(v, "Name", 2, 200, required=False)


@router.get("/competitors/meta")
def comps_meta(request: Request, db: Session = Depends(get_tenant_db), master_db: Session = Depends(get_master_db_dep), cu: User = Depends(comp_viewer)):
    out = S.comp_meta(_company(request, master_db))
    out["can"] = _can(db, cu, "competitors")
    return out


@router.post("/competitors/query")
def comps_query(body: ListQuery, db: Session = Depends(get_tenant_db), _: User = Depends(comp_viewer)):
    return S.comp_list(db, view=body.view if body.view in S.COMP_VIEWS else "All", q=body.q.strip()[:120], f=body.f, adv=body.adv, sorts=body.sorts,
                       offset=body.offset, limit=body.limit)


@router.get("/competitors/{cid}")
def comp_detail(cid: int, db: Session = Depends(get_tenant_db), cu: User = Depends(comp_viewer)):
    out = S.comp_detail(db, cid)
    out["can"] = _can(db, cu, "competitors")
    return out


@router.post("/competitors", status_code=201)
def comp_create(body: CompIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(comp_creator)):
    rid = S.comp_create(db, body.model_dump())
    _audit(db, request, cu, "competitors", "create", rid, f"Competitor created: {body.name}")
    return {"id": rid}


@router.put("/competitors/{cid}")
def comp_update(cid: int, body: CompIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(comp_editor)):
    S.comp_update(db, cid, body.model_dump(exclude_unset=True))
    _audit(db, request, cu, "competitors", "update", cid, "Competitor updated: " + ", ".join(body.model_dump(exclude_unset=True).keys()))
    return {"ok": True}


@router.post("/competitors/delete")
def comp_delete(body: IdsIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(comp_deleter)):
    n = S.comp_delete(db, body.ids)
    _audit(db, request, cu, "competitors", "delete", None, f"{n} competitor(s) deleted")
    return {"deleted": n}
