"""Deals (prototype v17 · Sales → Deals) – list & board, full-page form, record drawer, stage engine, conversion,
import, bulk actions and Pipelines & Stages configuration.   /api/v1/deals

Permissions: opportunities.view / create / update / delete (+ data scope "opportunity"); pipeline configuration needs
settings.manage. Deals are the existing opportunity rows of ``leads``; creation goes through lead_router.create_lead and
conversion through lead_router.request_lead_conversion (approval rules, tender creation, events, audit).
"""
from __future__ import annotations

import csv
import io
import json
import logging
import re
from datetime import date
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field, field_validator, model_validator
from app.core import validators as V
from sqlalchemy.orm import Session

from app.core.validators import detail_text
from app.core.logging import log_audit_db, log_module_action
from app.core.timezone import now_ist, today_ist
from app.dependencies import get_current_user, get_request_ip, get_tenant_db, user_has_permission
from app.models.all_models import DocumentFolder, FormField, Lead, LeadSource, User
from app.models.deals import DealProfile
from app.models.lead360 import LeadNote
from app.services import deal_service as S

logger = logging.getLogger(__name__)
router = APIRouter()

VIEWS = ["All", "Tender workflow", "Quotation workflow", "My deals", "Closing ≤ 30 days"]
# prototype v17 opps grid: ID · Journey · Opportunity · Customer · Workflow · Value · Win % · Flow · Stage · Owner · Model · Vertical · Close
COLUMNS = ["ref", "jid", "name", "customer", "workflow", "value", "prob", "flow", "stage", "owner", "model", "vertical", "close"]


def deal_user(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if not user_has_permission(db, cu, "opportunities.view"):
        raise HTTPException(403, "You do not have access to Deals")
    from app.services import lead360_service
    lead360_service.ensure_schema(db)     # lead_notes + lost-reason setting (shared with Leads)
    S.ensure_schema(db)
    return cu


def _need(db: Session, cu: User, key: str, what: str) -> None:
    if not user_has_permission(db, cu, key):
        raise HTTPException(403, f"You do not have permission to {what}")


def authorized_customers(db: Session, cu: User) -> list[dict[str, Any]]:
    from app.routers.lead_router import lead_team_customers
    return [c for c in lead_team_customers(assigned_only=False, db=db, cu=cu)
            if c.get("is_active") is not False and (c.get("approval_status") or "").lower() != "rejected"]


# ─── meta & lookups ───────────────────────────────────────────────────────────

@router.get("/meta")
def meta(request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(deal_user)):
    from app.services.lead360_service import lost_reasons
    company = None
    try:
        from app.database import MasterSessionLocal
        from app.models.tenant import Tenant
        m = MasterSessionLocal()
        try:
            t = m.query(Tenant).filter(Tenant.slug == db.info.get("tenant_slug")).first()
            company = t.name if t else None
        finally:
            m.close()
    except Exception:
        pass
    return {
        "company": company, "views": VIEWS, "pipelines": S.pipelines(db), "me": {"id": cu.id, "name": cu.full_name},
        "lost": lost_reasons(db),
        "can": {"create": user_has_permission(db, cu, "opportunities.create"), "update": user_has_permission(db, cu, "opportunities.update"),
                "delete": user_has_permission(db, cu, "opportunities.delete"), "export": user_has_permission(db, cu, "opportunities.export"),
                "documents": user_has_permission(db, cu, "document_management.create"), "log_activity": user_has_permission(db, cu, "kam.create"),
                "customers": user_has_permission(db, cu, "customers.view"), "configure": user_has_permission(db, cu, "settings.manage")},
    }


@router.get("/customers")
def customers(q: str = "", limit: int = Query(50, ge=1, le=500), db: Session = Depends(get_tenant_db), cu: User = Depends(deal_user)):
    rows = authorized_customers(db, cu)
    term = q.strip().lower()
    if term:
        rows = [c for c in rows if term in c["customer_name"].lower()]
    return {"items": [{"id": c["id"], "name": c["customer_name"]} for c in rows[:limit]], "total": len(rows)}


@router.get("/duplicates")
def duplicates(customer_id: Optional[int] = None, name: str = "", exclude_id: Optional[int] = None, db: Session = Depends(get_tenant_db),
               cu: User = Depends(deal_user)):
    """Open deals for the same customer – the form's "Possible duplicate" note (same name first)."""
    if not customer_id:
        return {"items": []}
    q = S.deal_query(db, cu).filter(Lead.customer_id == customer_id, Lead.status == "Opportunity Created")
    if exclude_id:
        q = q.filter(Lead.id != exclude_id)
    rows = q.order_by(Lead.id.desc()).limit(20).all()
    nm = name.strip().lower()
    out = [{"id": r.id, "ref": r.opportunity_ref_id or r.lead_ref_id, "name": r.lead_title, "same_name": bool(nm) and r.lead_title.strip().lower() == nm} for r in rows]
    out.sort(key=lambda x: not x["same_name"])
    return {"items": out[:3]}


# ─── list / board ─────────────────────────────────────────────────────────────

def _txt(r: dict, k: str) -> str:
    v = r.get(k)
    return "" if v is None else str(v)


def _cond(r: dict, k: str, op: str, v: str) -> bool:
    t, tl, vl = _txt(r, k), _txt(r, k).lower(), (v or "").lower()
    try:
        n, vn = float(r.get(k) or 0), float(v)
    except (TypeError, ValueError):
        n = vn = None
    return {
        "contains": vl in tl, "ncontains": vl not in tl, "eq": tl == vl or (n is not None and n == vn), "ne": not (tl == vl or (n is not None and n == vn)),
        "starts": tl.startswith(vl), "gt": n is not None and n > vn, "lt": n is not None and n < vn, "gte": n is not None and n >= vn,
        "lte": n is not None and n <= vn, "empty": t.strip() in ("", "—"), "nempty": t.strip() not in ("", "—"), "before": t < v, "after": t > v,
    }.get(op, True)


def _in_view(r: dict, view: str, me: int, today: str, in30: str) -> bool:
    if view == "Tender workflow":
        return r["destination"] == "tender"
    if view == "Quotation workflow":
        return r["destination"] == "quotation"
    if view == "My deals":
        return r["owner_id"] == me
    if view.startswith("Closing"):
        return bool(r["close"]) and today <= r["close"] <= in30
    return True


@router.get("/list")
def list_deals(view: str = "All", pipeline: str = "", stage: str = "", q: str = "", f: str = "", adv: str = "", sorts: str = "",
               offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=1000),
               db: Session = Depends(get_tenant_db), cu: User = Depends(deal_user)):
    from datetime import timedelta
    try:
        quick, advf, order = (json.loads(f) if f else {}), (json.loads(adv) if adv else {}), (json.loads(sorts) if sorts else [])
    except ValueError:
        raise HTTPException(422, "Invalid filter or sort")
    rows, _ = S.list_rows(db, cu)
    today = today_ist()
    t0, t30 = today.isoformat(), (today + timedelta(days=30)).isoformat()
    counts = {v: sum(1 for r in rows if _in_view(r, v, cu.id, t0, t30)) for v in VIEWS}
    sel = [r for r in rows if _in_view(r, view, cu.id, t0, t30)]
    if pipeline:
        sel = [r for r in sel if r["pipeline"] == pipeline]
    if stage:
        sel = [r for r in sel if r["stage"] == stage]
    if q.strip():
        ql = q.strip().lower()
        sel = [r for r in sel if any(ql in _txt(r, k).lower() for k in COLUMNS)]
    for k, v in (quick or {}).items():
        if k in COLUMNS and str(v or "").strip():
            sel = [r for r in sel if str(v).lower() in _txt(r, k).lower()]
    conds = [c for c in (advf.get("conds") or []) if isinstance(c, dict) and c.get("k") in COLUMNS]
    if conds:
        test = all if advf.get("logic") != "OR" else any
        sel = [r for r in sel if test(_cond(r, c["k"], str(c.get("op") or "contains"), str(c.get("v") or "")) for c in conds)]
    sort_items = [x for x in order if isinstance(x, (list, tuple)) and len(x) == 2 and x[0] in COLUMNS]
    for k, d in reversed(sort_items):
        num = k in ("value", "prob")
        sel.sort(key=lambda r: (r[k] or 0) if num else (r["id"] if k == "ref" else _txt(r, k).lower()), reverse=int(d) < 0)
    if not sort_items:
        sel.sort(key=lambda r: -r["id"])
    return {"items": sel[offset:offset + limit], "total": len(sel), "total_all": len(rows), "counts": counts, "value_total": sum(r["value"] for r in sel)}


# ─── create / edit ────────────────────────────────────────────────────────────

class DealIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=500)
    customer_id: int
    pipeline: str
    value: Optional[float] = Field(None, ge=0)
    close: Optional[date] = None
    owner_id: Optional[int] = None
    source_id: Optional[int] = None
    emd_required: bool = False
    custom_data: Optional[dict[str, Any]] = None

    @field_validator("name")
    @classmethod
    def _txt1(cls, v):
        return V.check_text(v, "Deal name", 2, 500, required=True)

    @field_validator("close")
    @classmethod
    def _dates(cls, v, info):
        return V.check_date_range(v, info.field_name.replace("_", " ").capitalize())

    @field_validator("value")
    @classmethod
    def _value(cls, v):
        return V.check_amount(v, "Deal value")


def _validate(db: Session, cu: User, body: DealIn, current: Optional[Lead] = None, prof: Optional[DealProfile] = None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    body.custom_data = V.validate_module_custom_data(db, "opportunities", body.custom_data)
    if not (current and current.customer_id == body.customer_id):
        c = next((x for x in authorized_customers(db, cu) if x["id"] == body.customer_id), None)
        if not c:
            raise V.field_error("customer_id", "Choose a customer you can work with.")
        out["customer_name"] = c["customer_name"]
    else:
        out["customer_name"] = current.customer_name
    pipe = S.pipeline_by_key(S.pipelines(db, include_inactive=bool(current))).get(body.pipeline)
    if not pipe or (not pipe["active"] and not (prof and prof.pipeline == body.pipeline)):
        raise HTTPException(422, "Choose an active workflow type")
    out["pipe"] = pipe
    if body.owner_id is not None and not (current and current.assigned_to == body.owner_id):
        if not db.query(User.id).filter(User.id == body.owner_id, User.is_active == True).first():
            raise HTTPException(422, "Choose an active user as owner")
    if body.source_id is not None and not (current and current.source_id == body.source_id):
        if not db.query(LeadSource.id).filter(LeadSource.id == body.source_id, LeadSource.is_active == True).first():
            raise HTTPException(422, "Choose an active lead source")
    cd = body.custom_data or {}
    miss = [f.label for f in S.required_custom(db) if cd.get(f.field_key) in (None, "", False)]
    if miss:
        raise HTTPException(422, "Required: " + ", ".join(miss))
    return out


@router.post("", status_code=201)
def create(body: DealIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(deal_user)):
    from app.routers.lead_router import LeadCreate, create_lead
    _need(db, cu, "opportunities.create", "create deals")
    v = _validate(db, cu, body)
    pipe = v["pipe"]
    payload = LeadCreate(customer_id=body.customer_id, customer_name=v["customer_name"], lead_title=body.name.strip(), source_id=body.source_id,
                         est_value=body.value or 0, assigned_to=body.owner_id or cu.id, status="Opportunity Created", lead_type="direct_opportunity",
                         conversion_target=pipe["destination"], products=[])
    res = create_lead(payload, request, db=db, cu=cu)
    lead_id = res["id"] if isinstance(res, dict) else res.id
    lead = db.query(Lead).filter(Lead.id == lead_id).first()
    if body.custom_data:
        lead.custom_data = body.custom_data
    first = next(s for s in pipe["stages"] if s["kind"] == "open")
    db.add(DealProfile(lead_id=lead_id, pipeline=pipe["key"], close_date=body.close, emd_required=bool(body.emd_required), stage_entered_at=now_ist()))
    from sqlalchemy import text
    db.execute(text("INSERT INTO workflow_record_stages (workflow, record_id, stage_id, mapped_at) VALUES (:w, :r, :s, :now)"),
               {"w": pipe["key"], "r": lead_id, "s": first["id"], "now": now_ist()})
    log_module_action(db=db, user_id=cu.id, module="opportunities", action="create", record_id=lead_id, record_name=lead.lead_title,
                      ip=get_request_ip(request), new_data={"pipeline": pipe["key"], "stage": first["name"], "close": body.close.isoformat() if body.close else None,
                                                           "emd_required": bool(body.emd_required)})
    db.commit()
    return {"id": lead_id, "ref": lead.opportunity_ref_id}


def _update(db: Session, cu: User, request: Request, lead: Lead, body: DealIn) -> None:
    from app.routers.lead_router import _dispatch_lead_event
    pipes = S.pipelines(db, include_inactive=True)
    profiles, st = S.sync(db, [lead], pipes)
    prof = profiles[lead.id]
    v = _validate(db, cu, body, lead, prof)
    pipe = v["pipe"]
    old = {"name": lead.lead_title, "customer_id": lead.customer_id, "pipeline": prof.pipeline, "value": float(lead.est_value or 0),
           "close": prof.close_date.isoformat() if prof.close_date else None, "owner_id": lead.assigned_to, "source_id": lead.source_id,
           "emd_required": bool(prof.emd_required), "custom_data": lead.custom_data}
    if pipe["key"] != prof.pipeline:
        if lead.status == "Converted":
            raise HTTPException(400, "A converted deal keeps its workflow type")
        cur = st[lead.id]["stage"]
        target = next((s for s in pipe["stages"] if s["name"].lower() == cur["name"].lower() and s["kind"] == cur["kind"]), None) or \
            next(s for s in pipe["stages"] if s["kind"] == (cur["kind"] if cur["kind"] != "open" else "open"))
        from sqlalchemy import text
        db.execute(text("DELETE FROM workflow_record_stages WHERE workflow = :w AND record_id = :r"), {"w": prof.pipeline, "r": lead.id})
        db.execute(text("INSERT INTO workflow_record_stages (workflow, record_id, stage_id, mapped_at) VALUES (:w, :r, :s, :now)"),
                   {"w": pipe["key"], "r": lead.id, "s": target["id"], "now": now_ist()})
        prof.pipeline, prof.stage_entered_at = pipe["key"], now_ist()
        lead.conversion_target = pipe["destination"]
    lead.lead_title = body.name.strip()
    lead.customer_id, lead.customer_name = body.customer_id, v["customer_name"]
    if body.value is not None:
        lead.est_value = body.value
    old_owner = lead.assigned_to
    lead.assigned_to = body.owner_id or lead.assigned_to
    lead.source_id = body.source_id
    prof.close_date, prof.emd_required = body.close, bool(body.emd_required)
    if body.custom_data is not None:
        lead.custom_data = body.custom_data
    new = {"name": lead.lead_title, "customer_id": lead.customer_id, "pipeline": prof.pipeline, "value": float(lead.est_value or 0),
           "close": prof.close_date.isoformat() if prof.close_date else None, "owner_id": lead.assigned_to, "source_id": lead.source_id,
           "emd_required": bool(prof.emd_required), "custom_data": lead.custom_data}
    changed = {k: new[k] for k in new if old[k] != new[k]}
    if changed:
        log_module_action(db=db, user_id=cu.id, module="opportunities", action="update", record_id=lead.id, record_name=lead.lead_title,
                          ip=get_request_ip(request), old_data={k: old[k] for k in changed}, new_data=changed)
    if old_owner != lead.assigned_to and lead.assigned_to:
        who = db.query(User.full_name).filter(User.id == lead.assigned_to).scalar()
        _dispatch_lead_event(db, lead=lead, event_key="lead_assignment", title="Deal Assigned",
                             message=f"Deal '{lead.lead_title}' was assigned to {who} by {cu.full_name}.", actor_user_id=cu.id)


@router.put("/{deal_id}")
def update(deal_id: int, body: DealIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(deal_user)):
    _need(db, cu, "opportunities.update", "edit deals")
    lead = S.get_deal(db, cu, deal_id)
    _update(db, cu, request, lead, body)
    db.commit()
    return {"id": lead.id}


class FieldIn(BaseModel):
    field: Literal["close"]
    value: Optional[str] = None


@router.patch("/{deal_id}/field")
def patch_field(deal_id: int, body: FieldIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(deal_user)):
    """Grid inline edit (prototype EDIT.opps: Close)."""
    _need(db, cu, "opportunities.update", "edit deals")
    lead = S.get_deal(db, cu, deal_id)
    profiles, _ = S.sync(db, [lead], S.pipelines(db, include_inactive=True))
    prof = profiles[lead.id]
    try:
        new = V.check_date_range(date.fromisoformat(body.value), "Close date") if body.value else None
    except ValueError as e:
        raise V.field_error("value", str(e) if "between" in str(e) else "Enter a valid date.")
    old = prof.close_date.isoformat() if prof.close_date else None
    prof.close_date = new
    log_module_action(db=db, user_id=cu.id, module="opportunities", action="update", record_id=lead.id, record_name=lead.lead_title,
                      ip=get_request_ip(request), old_data={"close": old}, new_data={"close": body.value or None})
    db.commit()
    return {"id": lead.id, "close": body.value or None}


def _delete(db: Session, cu: User, request: Request, lead: Lead) -> None:
    from app.core.logging import model_snapshot
    before = model_snapshot(lead)
    lead.is_deleted = True
    log_module_action(db=db, user_id=cu.id, module="leads", action="delete", record_id=lead.id, record_name=lead.lead_title,
                      ip=get_request_ip(request), old_data=before)


@router.delete("/{deal_id}")
def delete(deal_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(deal_user)):
    _need(db, cu, "opportunities.delete", "delete deals")
    lead = S.get_deal(db, cu, deal_id)
    if lead.approval_status == "pending":
        raise HTTPException(409, "This deal is waiting for approval – it cannot be deleted yet")
    _delete(db, cu, request, lead)
    db.commit()
    return {"ok": True}


# ─── workflow ─────────────────────────────────────────────────────────────────

class StageIn(BaseModel):
    stage_id: int
    reason: Optional[str] = Field(None, max_length=120)
    comment: Optional[str] = Field(None, max_length=1000)
    checklist: Optional[list[str]] = None


@router.post("/{deal_id}/stage")
def change_stage(deal_id: int, body: StageIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(deal_user)):
    _need(db, cu, "opportunities.update", "move deals")
    lead = S.get_deal(db, cu, deal_id)
    return S.move(db, cu, request, lead, body.stage_id, reason=body.reason, comment=body.comment, checklist=body.checklist)


@router.post("/{deal_id}/convert")
def convert(deal_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(deal_user)):
    """Prototype convertOpp(): Deal → Tender (tender record created) or Deal → Quotation, through the existing
    conversion request (approval rules; admins / top level convert directly). Duplicates are refused there."""
    from app.routers.lead_router import ConversionRequestBody, request_lead_conversion
    _need(db, cu, "opportunities.update", "convert deals")
    lead = S.get_deal(db, cu, deal_id)
    pipes = S.pipelines(db, include_inactive=True)
    profiles, st = S.sync(db, [lead], pipes)
    if profiles[lead.id].pending_stage_id:
        raise HTTPException(409, "A stage change is waiting for approval")
    if lead.status != "Opportunity Created":
        raise HTTPException(400, "Only open deals can be converted" if lead.status != "Converted" else "This deal is already converted")
    dest = st[lead.id]["pipe"]["destination"]
    res = request_lead_conversion(lead.id, request, ConversionRequestBody(conversion_target=dest), db=db, cu=cu)
    db.refresh(lead)
    S.sync(db, [lead], pipes)
    return {**(res if isinstance(res, dict) else {}), "status": lead.status, "approval_status": lead.approval_status}


# ─── drawer ───────────────────────────────────────────────────────────────────

@router.get("/{deal_id}")
def get_detail(deal_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(deal_user)):
    d = S.detail(db, cu, S.get_deal(db, cu, deal_id))
    d["can"] = {"update": user_has_permission(db, cu, "opportunities.update"), "delete": user_has_permission(db, cu, "opportunities.delete"),
                "documents": user_has_permission(db, cu, "document_management.create"), "log_activity": user_has_permission(db, cu, "kam.create"),
                "customers": user_has_permission(db, cu, "customers.view")}
    return d


@router.get("/{deal_id}/documents")
def documents(deal_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(deal_user)):
    """Files linked to the deal's journey record (Document Hub, source Leads): File | Folder | Updated."""
    S.get_deal(db, cu, deal_id)
    if not user_has_permission(db, cu, "document_management.view"):
        return {"items": [], "allowed": False}
    from app.routers.document_management_router import DOCUMENT_SOURCE_LABELS, _collect_documents, _filter_documents_by_trash_state, _prepare_document_payload
    docs, _ = _collect_documents(db, cu, source_filter="leads", limit=500)
    docs = [d for d in docs if int(d.get("record_id") or 0) == deal_id]
    docs = _filter_documents_by_trash_state(db, docs, trash_view=False)
    folders = {f.id: f.name for f in db.query(DocumentFolder).filter(DocumentFolder.id.in_([d.get("folder_id") for d in docs if d.get("folder_id")] or [-1])).all()}
    folder_of = {str(d.get("id")): folders.get(d.get("folder_id")) or DOCUMENT_SOURCE_LABELS.get("leads", "Leads") for d in docs}
    cleaned, _ = _prepare_document_payload(db, cu, docs, 200)
    return {"items": [{"id": d["id"], "name": d["name"], "folder": folder_of.get(str(d["id"])) or "Leads", "updated_at": d.get("updated_at"), "url": d.get("url"),
                       "type": d.get("doc_type"), "size_kb": d.get("size_kb"), "owner": d.get("owner")} for d in cleaned], "allowed": True}


class NoteIn(BaseModel):
    body: str = Field(..., min_length=1, max_length=5000)


MENTION_RE = re.compile(r"@([A-Za-z][\w.\-]*(?:\s[A-Z][\w.\-]*)?)")


def _mentions(db: Session, cu: User, lead: Lead, text_: str) -> int:
    users = db.query(User).filter(User.is_active == True, User.id != cu.id).all()
    ids = {u.id for u in users for m in MENTION_RE.findall(text_) if u.full_name.lower().startswith(m.lower()) or (u.username or "").lower() == m.lower()}
    if ids:
        try:
            from app.services.notification_service import upsert_notification
            for uid in ids:
                upsert_notification(db, uid, "You were mentioned", f"{cu.full_name} mentioned you on deal {lead.opportunity_ref_id or lead.id}: {text_[:160]}",
                                    module="opportunities", record_id=lead.id, action="mention", send_email=False)
        except Exception as exc:
            logger.warning("Mention notification failed: %s", exc)
    return len(ids)


@router.post("/{deal_id}/notes", status_code=201)
def add_note(deal_id: int, body: NoteIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(deal_user)):
    lead = S.get_deal(db, cu, deal_id)
    text_ = body.body.strip()
    if not text_:
        raise HTTPException(422, "Write a note first")
    n = LeadNote(lead_id=lead.id, body=text_, created_by=cu.id)
    db.add(n)
    db.flush()
    log_audit_db(db, cu.id, "opportunities", "note", lead.id, get_request_ip(request), "Note added", new_data={"note": text_[:500]}, record_name=lead.lead_title)
    k = _mentions(db, cu, lead, text_)
    db.commit()
    return {"id": n.id, "mentioned": k}


@router.put("/{deal_id}/notes/{note_id}")
def edit_note(deal_id: int, note_id: int, body: NoteIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(deal_user)):
    """Notes can be edited by their author (or a settings manager); the change is audit-logged."""
    lead = S.get_deal(db, cu, deal_id)
    n = db.query(LeadNote).filter(LeadNote.id == note_id, LeadNote.lead_id == lead.id).first()
    if not n:
        raise HTTPException(404, "Note not found")
    if n.created_by != cu.id and not user_has_permission(db, cu, "settings.manage"):
        raise HTTPException(403, "You can edit only your own notes")
    old, n.body = n.body, body.body.strip()
    log_audit_db(db, cu.id, "opportunities", "note_edit", lead.id, get_request_ip(request), "Note edited", old_data={"note": old[:500]},
                 new_data={"note": n.body[:500]}, record_name=lead.lead_title)
    db.commit()
    return {"id": n.id}


# ─── bulk & import ────────────────────────────────────────────────────────────

class BulkIn(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=500)
    action: Literal["reassign", "delete"]
    value: Optional[str] = None


@router.post("/bulk")
def bulk(body: BulkIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(deal_user)):
    from app.routers.lead_router import _dispatch_lead_event
    _need(db, cu, "opportunities.delete" if body.action == "delete" else "opportunities.update", "change these deals")
    uid = None
    if body.action == "reassign":
        uid = int(body.value or 0)
        if not db.query(User.id).filter(User.id == uid, User.is_active == True).first():
            raise HTTPException(422, "Choose an active user")
    who = db.query(User.full_name).filter(User.id == uid).scalar() if uid else None
    done, failed = 0, []
    for did in dict.fromkeys(body.ids):
        try:
            lead = S.get_deal(db, cu, did)
            if body.action == "delete":
                if lead.approval_status == "pending":
                    raise HTTPException(409, "Waiting for approval")
                _delete(db, cu, request, lead)
            elif lead.assigned_to != uid:
                old = lead.assigned_to
                lead.assigned_to = uid
                log_module_action(db=db, user_id=cu.id, module="opportunities", action="reassign", record_id=lead.id, record_name=lead.lead_title,
                                  ip=get_request_ip(request), old_data={"assigned_to": old}, new_data={"assigned_to": uid})
                _dispatch_lead_event(db, lead=lead, event_key="lead_assignment", title="Deal Assigned",
                                     message=f"Deal '{lead.lead_title}' was assigned to {who} by {cu.full_name}.", actor_user_id=cu.id)
            db.commit()
            done += 1
        except HTTPException as exc:
            db.rollback()
            failed.append({"id": did, "error": detail_text(exc.detail, "Not allowed")})
    return {"done": done, "failed": failed}


IMPORT_COLUMNS = ["Opportunity name", "Customer", "Workflow type", "Value", "Expected close (YYYY-MM-DD)", "Owner email", "Source", "EMD required (Yes/No)"]


@router.get("/import/template")
def import_template(cu: User = Depends(deal_user)):
    from fastapi.responses import Response
    return Response(",".join(IMPORT_COLUMNS) + "\n", media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="deals-import-template.csv"'})


@router.post("/import")
async def import_deals(request: Request, file: UploadFile = File(...), dry_run: bool = Query(False), db: Session = Depends(get_tenant_db),
                       cu: User = Depends(deal_user)):
    """Each row is matched to the masters by name (customer, workflow type, source, owner e-mail) and created through the
    same validated path as the form. Rows already present as an open deal (same customer + opportunity name, or twice in
    the file) are reported as duplicates; nothing is guessed. dry_run=true validates without creating."""
    _need(db, cu, "opportunities.create", "import deals")
    raw = (await file.read()).decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(raw))
    if not reader.fieldnames or "Opportunity name" not in reader.fieldnames or "Customer" not in reader.fieldnames:
        raise HTTPException(422, "Use the import template (Opportunity name, Customer, Workflow type, …)")
    custs = {c["customer_name"].strip().lower(): c["id"] for c in authorized_customers(db, cu)}
    pipes = {p["name"].strip().lower(): p["key"] for p in S.pipelines(db)} | {p["label"].strip().lower(): p["key"] for p in S.pipelines(db)}
    srcs = {s.name.strip().lower(): s.id for s in db.query(LeadSource).filter(LeadSource.is_active == True).all()}
    users = {(u.email or "").strip().lower(): u.id for u in db.query(User).filter(User.is_active == True).all() if u.email}
    existing = {((r.customer_id or 0), r.lead_title.strip().lower()) for r in S.deal_query(db, cu).filter(Lead.status == "Opportunity Created").all()}
    created, errors, dups, seen = 0, [], [], set()
    for i, row in enumerate(reader, start=2):
        g = lambda k: str(row.get(k) or "").strip()
        name = g("Opportunity name")
        try:
            if not name:
                raise ValueError("Opportunity name is empty")
            cid = custs.get(g("Customer").lower())
            if not cid:
                raise ValueError(f"Customer '{g('Customer')}' is not in your customers")
            pk = pipes.get(g("Workflow type").lower()) if g("Workflow type") else None
            if not pk:
                raise ValueError(f"Workflow type '{g('Workflow type')}' is not configured")
            key = (cid, name.lower())
            if key in existing or key in seen:
                dups.append({"row": i, "name": name, "error": "Duplicate – an open deal with this name exists for the customer"})
                continue
            seen.add(key)
            val = float(g("Value").replace(",", "")) if g("Value") else None
            if val is not None and val < 0:
                raise ValueError("Value must be zero or more")
            close = date.fromisoformat(g("Expected close (YYYY-MM-DD)")) if g("Expected close (YYYY-MM-DD)") else None
            owner = users.get(g("Owner email").lower()) if g("Owner email") else None
            if g("Owner email") and not owner:
                raise ValueError(f"No active user with e-mail {g('Owner email')}")
            src = srcs.get(g("Source").lower()) if g("Source") else None
            if g("Source") and not src:
                raise ValueError(f"Lead source '{g('Source')}' is not in the master")
            emd = g("EMD required (Yes/No)").lower() in ("yes", "y", "true", "1")
            body = DealIn(name=name, customer_id=cid, pipeline=pk, value=val, close=close, owner_id=owner, source_id=src, emd_required=emd)
            if dry_run:
                _validate(db, cu, body)
            else:
                create(body, request, db=db, cu=cu)
            created += 1
        except (ValueError, HTTPException) as exc:
            db.rollback()
            errors.append({"row": i, "name": name, "error": exc.detail if isinstance(exc, HTTPException) else str(exc)})
    log_audit_db(db, cu.id, "opportunities", "import", None, get_request_ip(request), f"Deals import: {created} {'valid' if dry_run else 'created'}, "
                 f"{len(dups)} duplicates, {len(errors)} errors", new_data={"file": file.filename, "dry_run": dry_run}, record_name=file.filename)
    db.commit()
    return {"created": created, "dry_run": dry_run, "duplicates": dups, "errors": errors[:200], "error_count": len(errors), "duplicate_count": len(dups)}


# ─── Pipelines & Stages configuration ────────────────────────────────────────

@router.get("/config/pipelines")
def get_pipelines(db: Session = Depends(get_tenant_db), cu: User = Depends(deal_user)):
    rows = S.pipelines(db, include_inactive=True)
    from sqlalchemy import text
    counts = dict(db.execute(text("SELECT stage_id, COUNT(*) FROM workflow_record_stages WHERE workflow LIKE 'deal%' GROUP BY stage_id")).all())
    for p in rows:
        for s in p["stages"]:
            s["deals"] = int(counts.get(s["id"], 0))
    return {"items": rows, "can_configure": user_has_permission(db, cu, "settings.manage")}


class StageCfg(BaseModel):
    id: Optional[int] = None
    name: str
    kind: Literal["open", "won", "lost"] = "open"
    sla: int = Field(0, ge=0, le=365)
    gate: Literal["None", "Approval", "Checklist"] = "None"
    owner_role: Optional[str] = None
    checklist: Optional[list[str]] = None
    probability: Optional[int] = Field(None, ge=0, le=100)


class PipelineCfg(BaseModel):
    name: Optional[str] = Field(None, max_length=60)
    label: Optional[str] = Field(None, max_length=60)
    destination: Optional[Literal["tender", "quotation"]] = None
    active: Optional[bool] = None
    stages: list[StageCfg]


@router.put("/config/pipelines/{key}")
def put_pipeline(key: str, body: PipelineCfg, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(deal_user)):
    _need(db, cu, "settings.manage", "configure pipelines")
    before = S.pipeline_by_key(S.pipelines(db, include_inactive=True)).get(key)
    S.save_pipeline(db, key, [s.model_dump() for s in body.stages], body.name, body.label, body.destination, body.active)
    log_audit_db(db, cu.id, "opportunities", "pipeline_update", None, get_request_ip(request), f"Pipeline {key} updated",
                 old_data=before, new_data=body.model_dump(), record_name=key)
    db.commit()
    return S.pipeline_by_key(S.pipelines(db, include_inactive=True)).get(key)


class NewPipelineCfg(PipelineCfg):
    key: str = Field(..., pattern=r"^[a-z0-9_]{2,30}$")
    name: str = Field(..., min_length=1, max_length=60)
    label: str = Field(..., min_length=1, max_length=60)
    destination: Literal["tender", "quotation"]


@router.post("/config/pipelines", status_code=201)
def post_pipeline(body: NewPipelineCfg, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(deal_user)):
    _need(db, cu, "settings.manage", "configure pipelines")
    key = body.key if body.key.startswith("deal_") else f"deal_{body.key}"
    S.create_pipeline(db, key, body.name, body.label, body.destination, [s.model_dump() for s in body.stages])
    log_audit_db(db, cu.id, "opportunities", "pipeline_create", None, get_request_ip(request), f"Pipeline {key} created", new_data=body.model_dump(), record_name=key)
    db.commit()
    return S.pipeline_by_key(S.pipelines(db, include_inactive=True)).get(key)
