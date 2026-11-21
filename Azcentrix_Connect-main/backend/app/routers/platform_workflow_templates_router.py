"""Workflow templates: list the central templates and push one to a tenant (platform_workflow_templates).

Under ``/workflow-templates`` (Tenants permission: view to read, manage to push). A push changes only the selected
tenant's database, so it is limited to tenants within the admin's scope.
"""

from __future__ import annotations

import logging
import secrets
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.platform_workflow import PlatformWorkflowTemplate, PlatformWorkflowTemplateStage
from app.models.tenant import Tenant
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_workflow_templates as wt
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/platform/workflow-templates", dependencies=[Depends(enforce_platform_access)])


@router.get("")
def overview(request: Request, db: Session = Depends(get_master_db_dep)):
    allowed = scoped_tenant_ids(request)
    return {"templates": wt.templates(db, allowed), "all_scope": allowed is None}


@router.get("/tenants")
def tenants(request: Request, q: str = Query("", max_length=100), offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=200),
            db: Session = Depends(get_master_db_dep)):
    return wt.tenants_page(db, scoped_tenant_ids(request), q.strip(), offset, limit)


class StageBody(BaseModel):
    name: str = Field(..., max_length=150)
    sla_days: int = 0
    gate: str = "None"
    owner_role: Optional[str] = Field(None, max_length=100)
    checklist: list[str] = []


class TemplateBody(BaseModel):
    name: str = Field(..., max_length=150)
    stages: list[StageBody] = Field(..., min_length=1, max_length=40)


@router.post("", status_code=201)
def create(body: TemplateBody, request: Request, db: Session = Depends(get_master_db_dep)):
    """New central template: the open stages given, then the Won / Lost outcomes every pushable workflow ends with."""
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail="Templates are shared by every tenant – creating one needs all-tenant scope.")
    wt.ensure_schema()
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Enter a template name")
    if db.query(PlatformWorkflowTemplate.id).filter(PlatformWorkflowTemplate.name == name).first():
        raise HTTPException(status_code=409, detail=f"A template named “{name}” already exists")
    stages = [{"name": s.name.strip(), "kind": "open", "sla_days": s.sla_days, "gate": s.gate, "owner_role": (s.owner_role or "").strip() or None,
               "checklist": [c.strip() for c in s.checklist if c.strip()] or None} for s in body.stages]
    stages += [{"name": n, "kind": n.lower(), "sla_days": 0, "gate": "None", "owner_role": None, "checklist": None} for n in wt.OUTCOMES]
    try:
        wt.validate_stages(stages)
    except wt.WorkflowTemplateError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    order = (db.query(func.max(PlatformWorkflowTemplate.sort_order)).scalar() or 0) + 1
    template = PlatformWorkflowTemplate(key=f"c{secrets.token_hex(6)}", name=name, workflow=wt.WORKFLOW, sort_order=order)
    db.add(template)
    db.flush()
    db.add_all(PlatformWorkflowTemplateStage(template_id=template.id, position=i, **s) for i, s in enumerate(stages))
    open_stages = [s["name"] for s in stages if s["kind"] == "open"]
    _write_platform_audit(db, _get_platform_admin(request), "create_workflow_template", "workflow_template", template.id, name,
                          f"Workflow template “{name}” created ({len(open_stages)} stages)", get_request_ip(request),
                          new_data={"name": name, "stages": open_stages, "gates": {s["name"]: s["gate"] for s in stages if s["gate"] != "None"}})
    db.commit()
    return {"id": template.id, "name": name}


class PushBody(BaseModel):
    tenant_id: int


@router.post("/{template_id}/push")
def push(template_id: int, body: PushBody, request: Request, db: Session = Depends(get_master_db_dep)):
    template, stages = wt.template_with_stages(db, template_id)
    if template is None or not template.is_active:
        raise HTTPException(status_code=404, detail="Workflow template not found")
    try:
        wt.validate_stages(stages)
    except wt.WorkflowTemplateError as exc:
        raise HTTPException(status_code=422, detail=f"{template.name} can't be pushed: {exc}")
    tenant = db.get(Tenant, body.tenant_id)
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    allowed = scoped_tenant_ids(request)
    if allowed is not None and tenant.id not in allowed:
        raise HTTPException(status_code=403, detail="This tenant is outside your tenant scope")
    if tenant.status == "cancelled" or tenant.deletion_scheduled_at is not None:
        raise HTTPException(status_code=409, detail=f"{tenant.name} is {'cancelled' if tenant.status == 'cancelled' else 'scheduled for deletion'} – its workflow can't be changed")

    admin, ip = _get_platform_admin(request), get_request_ip(request)
    actor = getattr(admin, "email", None) or "platform admin"
    try:
        result = wt.apply_to_tenant(tenant.slug, template.key, template.name, stages, actor)
    except Exception as exc:  # noqa: BLE001 - the tenant transaction is already rolled back; report and audit the failure
        logger.warning("Workflow template push to %s failed: %s", tenant.slug, exc, exc_info=not isinstance(exc, wt.WorkflowTemplateError))
        db.rollback()
        _write_platform_audit(db, admin, "apply_workflow_template_failed", "tenant", tenant.id, tenant.name,
                              f"Workflow template “{template.name}” not applied – nothing was changed: {str(exc)[:200]}", ip,
                              new_data={"template_id": template.id, "template": template.name})
        db.commit()
        if isinstance(exc, wt.WorkflowTemplateError):
            raise HTTPException(status_code=409, detail=f"Template not applied: {exc}")
        raise HTTPException(status_code=502, detail=f"Template not applied – the tenant database could not be updated ({str(exc)[:200]})")

    previous_id = wt.record_assignment(db, tenant.id, template.id, result["revision"], result["records"], actor)
    previous = db.get(PlatformWorkflowTemplate, previous_id).name if previous_id else None
    open_stages = [s["name"] for s in stages if s["kind"] == "open"]
    _write_platform_audit(db, admin, "apply_workflow_template", "tenant", tenant.id, tenant.name,
                          f"Workflow template “{template.name}” pushed ({len(open_stages)} stages) · {result['records']} tender(s) mapped, "
                          f"{result['records_moved']} moved to a new stage", ip,
                          old_data={"template": previous, "revision": result["previous_revision"]},
                          new_data={"template_id": template.id, "template": template.name, "revision": result["revision"], "stages": open_stages,
                                    "gates": {s["name"]: s["gate"] for s in stages if s["gate"] != "None"}, "moved": result["moved"]})
    db.commit()
    try:
        from app.services.tenant_onboarding import record_workflow_choice
        record_workflow_choice(db, tenant, actor, f"Workflow template “{template.name}” applied")
    except Exception:  # noqa: BLE001 - onboarding progress is informational; the push itself succeeded
        logger.warning("Onboarding step not recorded for %s", tenant.slug, exc_info=True)
        db.rollback()
    return {"tenant": {"id": tenant.id, "name": tenant.name}, "template": {"id": template.id, "name": template.name},
            "previous_template": previous, **result}
