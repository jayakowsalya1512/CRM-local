"""Users & Teams / Roles & Security (prototype v17).  Mounted at /api/v1/admin360

Users & Teams                                                            Roles & Security
  GET  /users/meta            roles, views, company                        GET  /roles/matrix          roles × modules × actions (+ scopes)
  POST /users/query           paginated grid (search, views, filter, sort) GET  /sharing-rules
  GET  /teams · POST /teams                                                POST /sharing-rules · PUT /sharing-rules/{id} · DELETE
  GET  /territories · POST · PUT /{id} · DELETE /{id}                      GET  /field-security?module= · PUT /field-security
  GET  /login-history

User create / edit / deactivate / reset-password stay on /auth/users; role create / permissions on /roles – this
router only adds the prototype views and the new tables.  Reads need users.view / roles.view (or an admin role);
writes need users.manage / roles.manage (or admin / ceo).
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.core import validators as V

from app.core.logging import log_audit_db
from app.database import get_master_db_dep
from app.dependencies import get_current_user, get_request_ip, get_tenant_db, user_has_permission
from app.models.all_models import User
from app.models.tenant import Tenant
from app.services import admin360_service as S

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Users & Teams / Roles & Security"])

ADMIN_ROLES = ("admin", "ceo")
VIEW_ROLES = ("admin", "ceo", "manager", "vp")


def _guard(perm: str, roles: tuple[str, ...], what: str):
    def dep(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
        if (cu.role or "") not in roles and not user_has_permission(db, cu, perm):
            raise HTTPException(403, f"You don't have access to {what}")
        S.ensure_schema(db)
        return cu
    return dep


users_viewer = _guard("users.view", VIEW_ROLES, "Users & Teams")
users_manager = _guard("users.manage", ADMIN_ROLES, "manage Users & Teams")
roles_viewer = _guard("roles.view", VIEW_ROLES, "Roles & Security")
roles_manager = _guard("roles.manage", ADMIN_ROLES, "manage Roles & Security")


def _audit(db: Session, request: Request, cu: User, module: str, action: str, rid: Optional[int], text: str) -> None:
    try:
        log_audit_db(db, cu.id, module, action, rid, get_request_ip(request), text)
        db.commit()
    except Exception as exc:  # pragma: no cover – audit must never block the action
        logger.warning("admin360 audit failed: %s", exc)
        db.rollback()


def _company(request: Request, master_db: Session) -> str:
    slug = getattr(request.state, "tenant_slug", None)
    if slug:
        row = master_db.query(Tenant.name).filter(Tenant.slug == slug).first()
        if row and row[0]:
            return str(row[0])
    return str(slug or "Workspace")


# ─── Users ────────────────────────────────────────────────────────────────────

class UsersQuery(BaseModel):
    view: str = "All"
    role: str = ""
    q: str = ""
    f: dict[str, str] = Field(default_factory=dict)
    adv: dict[str, Any] = Field(default_factory=lambda: {"logic": "AND", "conds": []})
    sorts: list[list[Any]] = Field(default_factory=list)
    offset: int = 0
    limit: int = 25


@router.get("/users/meta")
def users_meta(request: Request, db: Session = Depends(get_tenant_db), master_db: Session = Depends(get_master_db_dep), cu: User = Depends(users_viewer)):
    out = S.users_meta(db, cu, _company(request, master_db))
    out["can"] = {"manage": (cu.role or "") in ADMIN_ROLES or user_has_permission(db, cu, "users.manage")}
    return out


@router.post("/users/query")
def users_query(body: UsersQuery, db: Session = Depends(get_tenant_db), cu: User = Depends(users_viewer)):
    if body.view not in S.USER_VIEWS:
        body.view = "All"
    return S.users_query(db, cu, view=body.view, role=body.role.strip()[:50], q=body.q.strip()[:120], f=body.f, adv=body.adv,
                         sorts=body.sorts, offset=body.offset, limit=body.limit)


class NoteIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)

    @field_validator("text", mode="before")
    @classmethod
    def _text(cls, v: Any) -> str:
        return V.check_text(v, "Note", 1, 2000, required=True)  # type: ignore[return-value]


@router.get("/users/{user_id}")
def user_detail(user_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(users_viewer)):
    out = S.user_detail(db, cu, user_id)
    out["can"] = {"manage": (cu.role or "") in ADMIN_ROLES or user_has_permission(db, cu, "users.manage")}
    return out


@router.post("/users/{user_id}/notes", status_code=201)
def user_note(user_id: int, body: NoteIn, db: Session = Depends(get_tenant_db), cu: User = Depends(users_viewer)):
    return S.add_user_note(db, cu, user_id, body.text)


# ─── Teams & territories ──────────────────────────────────────────────────────

class TeamIn(BaseModel):
    name: str
    manager_id: Optional[int] = None
    description: str = ""

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, v: Any) -> str:
        return V.check_name(v, "Team name", 2, 100)

    @field_validator("description", mode="before")
    @classmethod
    def _desc(cls, v: Any) -> str:
        return V.check_text(v, "Description", 0, 500) or ""


class TerritoryIn(BaseModel):
    name: str
    states: list[str] = Field(default_factory=list)
    rule: str = ""
    owner_id: Optional[int] = None

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, v: Any) -> str:
        return V.check_name(v, "Territory name", 2, 100)

    @field_validator("rule", mode="before")
    @classmethod
    def _rule(cls, v: Any) -> str:
        return V.check_text(v, "Rule", 0, 200) or ""


@router.get("/teams")
def list_teams(db: Session = Depends(get_tenant_db), _: User = Depends(users_viewer)):
    return {"items": S.teams(db)}


@router.post("/teams", status_code=201)
def create_team(body: TeamIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(users_manager)):
    out = S.create_team(db, cu, body.name, body.manager_id, body.description)
    _audit(db, request, cu, "users", "create", out["id"], f"Team created: {out['n']}")
    return out


@router.get("/territories")
def list_territories(db: Session = Depends(get_tenant_db), _: User = Depends(users_viewer)):
    return {"items": S.territories(db)}


@router.post("/territories", status_code=201)
def create_territory(body: TerritoryIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(users_manager)):
    out = S.save_territory(db, cu, body.model_dump())
    _audit(db, request, cu, "users", "create", out["id"], f"Territory created: {body.name}")
    return out


@router.put("/territories/{territory_id}")
def update_territory(territory_id: int, body: TerritoryIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(users_manager)):
    out = S.save_territory(db, cu, body.model_dump(), territory_id)
    _audit(db, request, cu, "users", "update", territory_id, f"Territory updated: {body.name}")
    return out


@router.delete("/territories/{territory_id}")
def delete_territory(territory_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(users_manager)):
    S.delete_territory(db, territory_id)
    _audit(db, request, cu, "users", "delete", territory_id, "Territory removed")
    return {"ok": True}


# ─── Login history ────────────────────────────────────────────────────────────

@router.get("/login-history")
def login_history(q: str = "", result: str = "", offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=250),
                  db: Session = Depends(get_tenant_db), _: User = Depends(users_viewer)):
    return S.login_history(db, q=q.strip()[:120], result=result, offset=offset, limit=limit)


# ─── Roles & Security ─────────────────────────────────────────────────────────

@router.get("/roles/matrix")
def roles_matrix(db: Session = Depends(get_tenant_db), cu: User = Depends(roles_viewer)):
    out = S.roles_matrix(db)
    out["can"] = {"manage": (cu.role or "") in ADMIN_ROLES or user_has_permission(db, cu, "roles.manage")}
    return out


class SharingRuleIn(BaseModel):
    object: str
    rule: str
    shared_with_type: str = "role"
    shared_with_ref: str = ""
    access: str = "Read"

    @field_validator("rule", mode="before")
    @classmethod
    def _rule(cls, v: Any) -> str:
        return V.check_text(v, "Rule", 3, 300, required=True)  # type: ignore[return-value]

    @field_validator("shared_with_ref", mode="before")
    @classmethod
    def _ref(cls, v: Any) -> str:
        return V.check_text(v, "Shared with", 0, 120) or ""


@router.get("/sharing-rules")
def list_sharing_rules(db: Session = Depends(get_tenant_db), _: User = Depends(roles_viewer)):
    return {"items": S.sharing_rules(db), "objects": S.SHARING_OBJECTS}


@router.post("/sharing-rules", status_code=201)
def create_sharing_rule(body: SharingRuleIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(roles_manager)):
    out = S.save_sharing_rule(db, cu, body.model_dump())
    _audit(db, request, cu, "roles", "create", out["id"], f"Sharing rule created: {body.object} – {body.rule[:80]}")
    return out


@router.put("/sharing-rules/{rule_id}")
def update_sharing_rule(rule_id: int, body: SharingRuleIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(roles_manager)):
    out = S.save_sharing_rule(db, cu, body.model_dump(), rule_id)
    _audit(db, request, cu, "roles", "update", rule_id, f"Sharing rule updated: {body.object}")
    return out


@router.delete("/sharing-rules/{rule_id}")
def delete_sharing_rule(rule_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(roles_manager)):
    S.delete_sharing_rule(db, rule_id)
    _audit(db, request, cu, "roles", "delete", rule_id, "Sharing rule removed")
    return {"ok": True}


class FieldSecurityIn(BaseModel):
    module: str
    field_key: str
    role_id: int
    access: str


@router.get("/field-security")
def get_field_security(module: str = "tenders", db: Session = Depends(get_tenant_db), _: User = Depends(roles_viewer)):
    return S.field_security(db, module)


@router.put("/field-security")
def put_field_security(body: FieldSecurityIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(roles_manager)):
    S.set_field_security(db, cu, body.module, body.field_key, body.role_id, body.access)
    _audit(db, request, cu, "roles", "update", body.role_id, f"Field security: {body.module}.{body.field_key} → {body.access}")
    return {"ok": True}
