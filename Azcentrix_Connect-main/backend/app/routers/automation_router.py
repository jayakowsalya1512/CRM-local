"""Automation Studio (prototype v17). Mounted at /api/v1/automation

GET  /meta                 modules / triggers / actions / operators for the rule builder
GET  /overview              KPI tiles for the Overview tab
GET  /rules · POST /rules · PUT /rules/{id} · DELETE /rules/{id} · PUT /rules/{id}/toggle · POST /rules/{id}/run
GET  /scoring-rules · POST · PUT /{id} · DELETE /{id}
GET  /assignment-rules · POST · PUT /{id} · DELETE /{id}
GET  /sla-rules · PUT /sla-rules/{key}/toggle · POST /sla-rules/{key}/run
GET  /run-log

Approval policies stay on the existing /approval-workflows router (the approval matrix); webhooks stay on the
existing /integrations360 router – both are only read from the Automation Studio frontend shell, not duplicated
here. Reads need automation.view (or an admin role); writes need automation.manage (or admin / ceo).
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.dependencies import get_current_user, get_tenant_db, user_has_permission
from app.models.all_models import User
from app.services import automation_service as S

router = APIRouter(tags=["Automation Studio"])

ADMIN_ROLES = ("admin", "ceo")
VIEW_ROLES = ("admin", "ceo", "manager", "vp")


def _guard(perm: str, roles: tuple[str, ...], what: str):
    def dep(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
        if (cu.role or "") not in roles and not user_has_permission(db, cu, perm):
            raise HTTPException(403, f"You don't have access to {what}")
        S.ensure_schema(db)
        return cu
    return dep


viewer = _guard("automation.view", VIEW_ROLES, "Automation Studio")
manager = _guard("automation.manage", ADMIN_ROLES, "manage Automation Studio")


class RuleIn(BaseModel):
    n: str
    mod: str
    trig: str = "create"
    stage: str = ""
    conds: list[dict[str, Any]] = Field(default_factory=list)
    acts: list[dict[str, Any]] = Field(default_factory=list)
    on: bool = True


class ScoringIn(BaseModel):
    c: str
    p: int = 0
    on: bool = True


class AssignmentIn(BaseModel):
    a: str
    b: str
    on: bool = True


class ToggleIn(BaseModel):
    on: bool


@router.get("/meta")
def meta(_: User = Depends(viewer)):
    return S.catalog()


@router.get("/overview")
def overview(db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return S.overview(db)


@router.get("/rules")
def list_rules(db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return {"items": S.list_rules(db)}


@router.post("/rules", status_code=201)
def create_rule(body: RuleIn, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    return S.save_rule(db, cu, body.model_dump())


@router.put("/rules/{rule_id}")
def update_rule(rule_id: int, body: RuleIn, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    return S.save_rule(db, cu, body.model_dump(), rule_id)


@router.put("/rules/{rule_id}/toggle")
def toggle_rule(rule_id: int, body: ToggleIn, db: Session = Depends(get_tenant_db), _: User = Depends(manager)):
    S.toggle_rule(db, rule_id, body.on)
    return {"ok": True}


@router.delete("/rules/{rule_id}")
def delete_rule(rule_id: int, db: Session = Depends(get_tenant_db), _: User = Depends(manager)):
    S.delete_rule(db, rule_id)
    return {"ok": True}


@router.post("/rules/{rule_id}/run")
def run_rule(rule_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    return S.run_rule(db, cu, rule_id)


@router.get("/scoring-rules")
def list_scoring(db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return {"items": S.scoring_rules(db)}


@router.post("/scoring-rules", status_code=201)
def create_scoring(body: ScoringIn, db: Session = Depends(get_tenant_db), _: User = Depends(manager)):
    return S.save_scoring_rule(db, body.model_dump())


@router.put("/scoring-rules/{rule_id}")
def update_scoring(rule_id: int, body: ScoringIn, db: Session = Depends(get_tenant_db), _: User = Depends(manager)):
    return S.save_scoring_rule(db, body.model_dump(), rule_id)


@router.delete("/scoring-rules/{rule_id}")
def delete_scoring(rule_id: int, db: Session = Depends(get_tenant_db), _: User = Depends(manager)):
    S.delete_scoring_rule(db, rule_id)
    return {"ok": True}


@router.get("/assignment-rules")
def list_assignment(db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return {"items": S.assignment_rules(db)}


@router.post("/assignment-rules", status_code=201)
def create_assignment(body: AssignmentIn, db: Session = Depends(get_tenant_db), _: User = Depends(manager)):
    return S.save_assignment_rule(db, body.model_dump())


@router.put("/assignment-rules/{rule_id}")
def update_assignment(rule_id: int, body: AssignmentIn, db: Session = Depends(get_tenant_db), _: User = Depends(manager)):
    return S.save_assignment_rule(db, body.model_dump(), rule_id)


@router.delete("/assignment-rules/{rule_id}")
def delete_assignment(rule_id: int, db: Session = Depends(get_tenant_db), _: User = Depends(manager)):
    S.delete_assignment_rule(db, rule_id)
    return {"ok": True}


@router.get("/sla-rules")
def list_sla(db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return {"items": S.sla_rules(db)}


@router.put("/sla-rules/{key}/toggle")
def toggle_sla(key: str, body: ToggleIn, db: Session = Depends(get_tenant_db), _: User = Depends(manager)):
    S.toggle_sla_rule(db, key, body.on)
    return {"ok": True}


@router.post("/sla-rules/{key}/run")
def run_sla(key: str, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    return S.run_sla_rule(db, cu, key)


@router.get("/run-log")
def list_run_log(db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return {"items": S.run_log(db)}
