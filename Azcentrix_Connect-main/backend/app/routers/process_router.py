"""Process Designer (prototype v17 R.workflow).  Mounted at /api/v1/process

GET  /overview                         everything the page shows (flows + stages + counts + config + roles)
PUT  /flows/{key}                      save the stages of one workflow (deal_* · tender · lead · quote · wo · lc_*)
POST /pipelines · PUT /pipelines/{key} · DELETE /pipelines/{key}       deal pipelines (flow manager + "New deal pipeline")
POST /lifecycles · DELETE /lifecycles/{key}                             order lifecycles (AMC, warranty …)
PUT  /config/names · PUT /config/objects · PUT /config/conv             terminology · objects on/off · conversion rules
POST /template · POST /publish · GET /approval-policies

Reads need workflow.view (or admin / ceo / manager / vp); writes need workflow.manage (or admin / ceo).
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.logging import log_audit_db
from app.database import get_master_db_dep
from app.dependencies import get_current_user, get_request_ip, get_tenant_db, user_has_permission
from app.models.all_models import User
from app.models.tenant import Tenant
from app.services import process_service as S

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Process Designer"])
ADMIN_ROLES = ("admin", "ceo")
VIEW_ROLES = ("admin", "ceo", "manager", "vp")


def viewer(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if (cu.role or "") not in VIEW_ROLES and not user_has_permission(db, cu, "workflow.view"):
        raise HTTPException(403, "You don't have access to the Process Designer")
    S.ensure_schema(db)
    return cu


def manager(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if (cu.role or "") not in ADMIN_ROLES and not user_has_permission(db, cu, "workflow.manage"):
        raise HTTPException(403, "You don't have permission to change the process design")
    S.ensure_schema(db)
    return cu


def _audit(db: Session, request: Request, cu: User, action: str, text: str, data: Optional[dict] = None) -> None:
    try:
        log_audit_db(db, cu.id, "workflow", action, None, get_request_ip(request), text, new_data=data)
        db.commit()
    except Exception as exc:  # pragma: no cover – audit must never block the action
        logger.warning("process audit failed: %s", exc)
        db.rollback()


def _company(request: Request, master_db: Session) -> str:
    slug = getattr(request.state, "tenant_slug", None)
    if slug:
        row = master_db.query(Tenant.name).filter(Tenant.slug == slug).first()
        if row and row[0]:
            return str(row[0])
    return str(slug or "Workspace")


@router.get("/overview")
def overview(request: Request, db: Session = Depends(get_tenant_db), master_db: Session = Depends(get_master_db_dep), cu: User = Depends(viewer)):
    out = S.overview(db, _company(request, master_db))
    out["can_manage"] = (cu.role or "") in ADMIN_ROLES or user_has_permission(db, cu, "workflow.manage")
    return out


# ─── stages ───────────────────────────────────────────────────────────────────

class StageIn(BaseModel):
    id: Optional[Any] = None
    name: str = Field(..., max_length=150)
    kind: str = "open"
    sla: int = 0
    gate: str = "None"
    owner_role: Optional[str] = None
    checklist: list[str] = Field(default_factory=list)
    exit: str = ""
    auto: str = ""
    forecast: Optional[str] = None
    prob: Optional[int] = None
    appr: Optional[dict[str, Any]] = None


class FlowIn(BaseModel):
    stages: list[StageIn] = Field(..., min_length=1, max_length=40)


@router.put("/flows/{key}")
def put_flow(key: str, body: FlowIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    S.save_flow(db, cu, key, [s.model_dump() for s in body.stages])
    _audit(db, request, cu, "stages_update", f"Workflow {key}: stages saved", {"stages": [s.name for s in body.stages]})
    return {"ok": True}


# ─── pipelines ────────────────────────────────────────────────────────────────

class PipelineIn(BaseModel):
    name: str = Field(..., max_length=60)
    copy_from: str = Field(..., max_length=40)
    creates: str = "tenders"
    biz: str = ""
    default: bool = False


class PipelinePatch(BaseModel):
    name: Optional[str] = Field(None, max_length=60)
    creates: Optional[str] = None
    auto: Optional[bool] = None
    biz: Optional[str] = None
    default: Optional[bool] = None


@router.post("/pipelines", status_code=201)
def post_pipeline(body: PipelineIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    key = S.create_pipeline(db, cu, body.name, body.copy_from, body.creates, body.biz, body.default)
    _audit(db, request, cu, "pipeline_create", f"Deal pipeline “{body.name}” created ({key})", body.model_dump())
    return {"key": key}


@router.put("/pipelines/{key}")
def patch_pipeline(key: str, body: PipelinePatch, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    patch = {k: v for k, v in body.model_dump().items() if v is not None and k != "name"}
    if body.name is not None:
        S.rename_pipeline(db, cu, key, body.name)
    if patch:
        S.save_pipeline_rule(db, cu, key, patch)
    _audit(db, request, cu, "pipeline_update", f"Deal pipeline {key} updated", body.model_dump(exclude_none=True))
    return {"ok": True}


@router.delete("/pipelines/{key}")
def delete_pipeline(key: str, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    S.delete_pipeline(db, cu, key)
    _audit(db, request, cu, "pipeline_delete", f"Deal pipeline {key} deleted")
    return {"ok": True}


# ─── lifecycles ───────────────────────────────────────────────────────────────

class LifecycleIn(BaseModel):
    name: str = Field(..., max_length=100)
    template: str = "AMC / service contract"
    trigger: str = "manual"


@router.post("/lifecycles", status_code=201)
def post_lifecycle(body: LifecycleIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    lc = S.create_lifecycle(db, cu, body.name, body.template, body.trigger)
    _audit(db, request, cu, "lifecycle_create", f"Order lifecycle “{lc.name}” created ({lc.key})", body.model_dump())
    return {"key": lc.key, "id": lc.id}


@router.delete("/lifecycles/{key}")
def delete_lifecycle(key: str, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    S.delete_lifecycle(db, cu, key)
    _audit(db, request, cu, "lifecycle_delete", f"Order lifecycle {key} deleted")
    return {"ok": True}


# ─── config ───────────────────────────────────────────────────────────────────

class NamesIn(BaseModel):
    names: dict[str, list[str]]


class ObjectsIn(BaseModel):
    objects: dict[str, bool]


class ConvIn(BaseModel):
    conv: dict[str, Any]


@router.put("/config/names")
def put_names(body: NamesIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    out = S.save_names(db, cu, body.names)
    _audit(db, request, cu, "terminology", "Terminology saved", out)
    return {"names": out}


@router.put("/config/objects")
def put_objects(body: ObjectsIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    out = S.save_objects(db, cu, body.objects)
    _audit(db, request, cu, "objects", "Objects enabled / disabled", out)
    return {"objects": out}


@router.put("/config/conv")
def put_conv(body: ConvIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    out = S.save_conv(db, cu, body.conv)
    _audit(db, request, cu, "conversion_rules", "Conversion rules saved", out)
    return {"conv": out}


# ─── templates · publish · policies ───────────────────────────────────────────

class TemplateIn(BaseModel):
    key: str = Field(..., max_length=60)


@router.post("/template")
def post_template(body: TemplateIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    out = S.apply_template(db, cu, body.key)
    _audit(db, request, cu, "template", f"Tender lifecycle replaced with {out['name']}", out)
    return out


@router.post("/publish")
def post_publish(request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    out = S.publish(db, cu)
    _audit(db, request, cu, "publish", f"Process design published as v{out['version']}", out)
    return out


@router.get("/approval-policies")
def approval_policies(request: Request, db: Session = Depends(get_tenant_db), master_db: Session = Depends(get_master_db_dep), _: User = Depends(viewer)):
    ov = S.overview(db, _company(request, master_db))
    return {"company": ov["company"], "items": S.approval_policies(db, ov["flows"])}
