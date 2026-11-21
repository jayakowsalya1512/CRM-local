"""Leads (prototype v17) – list with saved views, full-page form, detail drawer, workflow.  /api/v1/lead360

Masters are not duplicated: Company = customers (the Leads module's authorized customer set), Contact person =
customer_contacts of that customer, Source = lead_sources, Interested in = products_master, Owner = users.
Writes go through the existing Leads endpoints (lead_router) so numbering, assignment, notifications,
approvals, activity log and audit behave exactly as before; this router validates the master IDs first.
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
from app.core.logging import log_audit_db
from app.core.timezone import today_ist
from app.dependencies import get_current_user, get_request_ip, get_tenant_db, user_has_permission
from app.models.all_models import Customer, CustomerContact, Lead, LeadProduct, LeadSource, ProductMaster, User
from app.models.lead360 import LeadContactLink, LeadNote
from app.services import lead360_service as S

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Leads"])
# prototype v17 leads grid: ID · Journey · Company · Contact · Source · Interest · Value · Score · Flow · Stage · Owner · Model · Vertical · Follow-up
COLUMNS = ("ref", "jid", "company", "contact", "source", "interest", "value", "score", "flow", "stage", "owner", "model", "vertical", "follow_up")


def lead_user(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if not user_has_permission(db, cu, "leads.view"):
        raise HTTPException(403, "You don't have access to Leads")
    S.ensure_schema(db)
    return cu


def _need(db: Session, cu: User, key: str, what: str) -> None:
    if not user_has_permission(db, cu, key):
        raise HTTPException(403, f"You don't have permission to {what}")


def get_lead(db: Session, cu: User, lead_id: int) -> Lead:
    lead = S.lead_query(db, cu).filter(Lead.id == lead_id).first()
    if not lead:
        raise HTTPException(404, "Lead not found")
    return lead


def authorized_customers(db: Session, cu: User) -> list[dict[str, Any]]:
    from app.routers.lead_router import lead_team_customers
    return lead_team_customers(assigned_only=False, db=db, cu=cu)


def views(rules: dict[str, Any]) -> list[str]:
    return ["All", "My leads", f"Hot (score ≥ {int(rules.get('hot_threshold') or 75)})", "Follow-up due"]


# ─── meta & master lookups ────────────────────────────────────────────────────

def _approval_chain(db: Session, cu: User, request: Request, action: str) -> Optional[list[str]]:
    try:
        from app.routers.customer_router import _get_tenant_id
        from app.services.generic_approval_engine import find_matching_approval_rule, is_top_level_auto_approval_requester
        if is_top_level_auto_approval_requester(db, cu):
            return None
        rule = find_matching_approval_rule(db, tenant_id=_get_tenant_id(request), requester=cu, module_key="leads", action_key=action)
        if not rule:
            return None
        names = S.user_names(db, [st.approver_user_id for st in (rule.steps or [])])
        return [names.get(st.approver_user_id) or (st.approver_role or "approver").replace("_", " ").title() for st in sorted(rule.steps or [], key=lambda x: x.step_no)]
    except Exception as exc:
        logger.info("Lead approval preview unavailable: %s", exc)
        db.rollback()
        return None


@router.get("/meta")
def meta(request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(lead_user)):
    rules = S.scoring_rules(db)
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
        "company": company, "views": views(rules), "stages": S.stages(), "hot_threshold": int(rules.get("hot_threshold") or 75),
        "me": {"id": cu.id, "name": cu.full_name},
        "can": {"create": user_has_permission(db, cu, "leads.create"), "update": user_has_permission(db, cu, "leads.update"),
                "delete": user_has_permission(db, cu, "leads.delete"), "documents": user_has_permission(db, cu, "document_management.create"),
                "log_activity": user_has_permission(db, cu, "kam.create"), "customers": user_has_permission(db, cu, "customers.view")},
        "approval": {"create": _approval_chain(db, cu, request, "create"), "update": _approval_chain(db, cu, request, "update")},
        "lost": S.lost_reasons(db),
    }


@router.get("/customers")
def customers(q: str = "", limit: int = Query(50, ge=1, le=500), db: Session = Depends(get_tenant_db), cu: User = Depends(lead_user)):
    """Company lookup: the customers this user may raise leads for (same rule as the existing lead form)."""
    rows = [c for c in authorized_customers(db, cu) if (c.get("is_active") is not False) and (c.get("approval_status") or "").lower() != "rejected"]
    term = q.strip().lower()
    if term:
        rows = [c for c in rows if term in c["customer_name"].lower()]
    return {"items": [{"id": c["id"], "name": c["customer_name"]} for c in rows[:limit]], "total": len(rows)}


@router.get("/contacts")
def contacts(customer_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(lead_user)):
    if not any(c["id"] == customer_id for c in authorized_customers(db, cu)):
        raise HTTPException(404, "Customer not found")
    rows = (db.query(CustomerContact).filter(CustomerContact.customer_id == customer_id, CustomerContact.is_active == True)
            .order_by(CustomerContact.is_primary.desc(), CustomerContact.contact_name).all())
    return {"items": [{"id": c.id, "name": c.contact_name, "designation": c.designation or "", "department": c.department or "",
                       "mobile": c.mobile or c.office_phone or "", "email": c.office_email or "", "is_primary": bool(c.is_primary)} for c in rows]}


@router.get("/duplicates")
def duplicates(customer_id: Optional[int] = None, product_id: Optional[int] = None, exclude_id: Optional[int] = None,
               db: Session = Depends(get_tenant_db), cu: User = Depends(lead_user)):
    """Open leads for the same company (and product) – the form's "Possible duplicate" note."""
    if not customer_id:
        return {"items": []}
    q = S.lead_query(db, cu).filter(Lead.customer_id == customer_id, Lead.status.in_(S.OPEN_STAGES))
    if exclude_id:
        q = q.filter(Lead.id != exclude_id)
    rows = q.order_by(Lead.id.desc()).limit(20).all()
    prods = S.first_products(db, [r.id for r in rows])
    out = [{"id": r.id, "ref": r.lead_ref_id, "title": r.lead_title, "same_product": bool(product_id and prods.get(r.id, {}).get("product_id") == product_id)} for r in rows]
    out.sort(key=lambda x: not x["same_product"])
    return {"items": out[:3]}


# ─── list ─────────────────────────────────────────────────────────────────────

def _txt(r: dict, k: str) -> str:
    v = r.get(k)
    if k == "stage":                      # search / sort / filter on the shown stage name (New, Converted, Disqualified…)
        grp = S.stage_of(v)
        return grp["label"] if grp else ("" if v is None else str(v))
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


def _in_view(r: dict, view: str, me: int, hot: int, today: str) -> bool:
    if view == "My leads":
        return r["owner_id"] == me
    if view.startswith("Hot"):
        return r["score"] >= hot
    if view == "Follow-up due":
        return bool(r["follow_up"]) and r["follow_up"] <= today and r["stage"] in S.OPEN_STAGES
    return True


@router.get("/list")
def list_leads(view: str = "All", stage: str = "", q: str = "", f: str = "", adv: str = "", sorts: str = "",
               offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=250),
               db: Session = Depends(get_tenant_db), cu: User = Depends(lead_user)):
    try:
        quick, advf, order = (json.loads(f) if f else {}), (json.loads(adv) if adv else {}), (json.loads(sorts) if sorts else [])
    except ValueError:
        raise HTTPException(422, "Invalid filter or sort")
    rules = S.scoring_rules(db)
    hot, today = int(rules.get("hot_threshold") or 75), today_ist().isoformat()
    rows = S.list_rows(db, cu)
    vs = views(rules)
    counts = {v: sum(1 for r in rows if _in_view(r, v, cu.id, hot, today)) for v in vs}
    sel = [r for r in rows if _in_view(r, view, cu.id, hot, today)]
    if stage:
        grp = S.stage_of(stage)
        statuses = set(grp["values"]) if grp and grp["key"] == stage else {stage}
        sel = [r for r in sel if r["stage"] in statuses]
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
        num = k in ("value", "score")
        sel.sort(key=lambda r: (r[k] or 0) if num else (r["id"] if k == "ref" else _txt(r, k).lower()), reverse=int(d) < 0)
    if not sort_items:
        sel.sort(key=lambda r: -r["id"])
    return {"items": sel[offset:offset + limit], "total": len(sel), "total_all": len(rows), "counts": counts, "value_total": sum(r["value"] for r in sel)}


# ─── create / edit (validated masters → existing lead endpoints) ──────────────

class LeadIn(BaseModel):
    customer_id: int
    contact_id: Optional[int] = None
    source_id: Optional[int] = None
    est_value: Optional[float] = Field(None, ge=0)
    product_id: Optional[int] = None
    assigned_to: Optional[int] = None
    follow_up: Optional[date] = None
    custom_data: Optional[dict[str, Any]] = None

    @field_validator("follow_up")
    @classmethod
    def _dates(cls, v, info):
        return V.check_date_range(v, info.field_name.replace("_", " ").capitalize())

    @field_validator("est_value")
    @classmethod
    def _value(cls, v):
        return V.check_amount(v, "Expected value")


def _validate(db: Session, cu: User, body: LeadIn, current: Optional[Lead] = None) -> dict[str, Any]:
    """Every selected master ID must exist, be active and be allowed for this user. Values that were valid when
    the lead was saved stay valid on edit even if the master record was deactivated later (history is kept)."""
    out: dict[str, Any] = {}
    body.custom_data = V.validate_module_custom_data(db, "leads", body.custom_data)
    cust_ok = {c["id"]: c["customer_name"] for c in authorized_customers(db, cu)}
    if body.customer_id not in cust_ok and not (current and current.customer_id == body.customer_id):
        raise V.field_error("customer_id", "Choose a company from your customer list.")
    cust = db.query(Customer).filter(Customer.id == body.customer_id, Customer.is_deleted == False).first()
    if not cust:
        raise HTTPException(422, "The selected company no longer exists")
    out["customer"] = cust
    if body.contact_id:
        ct = db.query(CustomerContact).filter(CustomerContact.id == body.contact_id, CustomerContact.customer_id == cust.id).first()
        prev = db.query(LeadContactLink.contact_id).filter(LeadContactLink.lead_id == current.id).scalar() if current else None
        if not ct or (not ct.is_active and ct.id != prev):
            raise HTTPException(422, "The contact person must be an active contact of the selected company")
        out["contact"] = ct
    if body.source_id is not None:
        src = db.query(LeadSource).filter(LeadSource.id == body.source_id).first()
        if not src or (not src.is_active and not (current and current.source_id == src.id)):
            raise HTTPException(422, "Choose an active lead source")
    if body.product_id is not None:
        p = db.query(ProductMaster).filter(ProductMaster.id == body.product_id).first()
        prev_p = S.first_products(db, [current.id]).get(current.id, {}).get("product_id") if current else None
        if not p or (p.is_active is False and p.id != prev_p):
            raise HTTPException(422, "Choose an active product / service")
        out["product"] = p
    if body.assigned_to is not None:
        u = db.query(User).filter(User.id == body.assigned_to).first()
        if not u or (not u.is_active and not (current and current.assigned_to == u.id)):
            raise HTTPException(422, "Choose an active user as owner")
    return out


def _set_contact(db: Session, lead_id: int, contact_id: Optional[int]) -> None:
    link = db.query(LeadContactLink).filter(LeadContactLink.lead_id == lead_id).first()
    if link:
        link.contact_id = contact_id
    elif contact_id:
        db.add(LeadContactLink(lead_id=lead_id, contact_id=contact_id))
    db.commit()


@router.post("", status_code=201)
def create(body: LeadIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(lead_user)):
    from app.routers.lead_router import LeadCreate, ProductEntry, create_lead
    _need(db, cu, "leads.create", "create leads")
    v = _validate(db, cu, body)
    cust, ct, p = v["customer"], v.get("contact"), v.get("product")
    payload = LeadCreate(
        customer_id=cust.id, customer_name=cust.customer_name, lead_title=(p.name if p else f"Lead – {cust.customer_name}")[:500],
        source_id=body.source_id, est_value=body.est_value or 0, assigned_to=body.assigned_to,
        follow_up=body.follow_up.isoformat() if body.follow_up else None, custom_data=body.custom_data or None,
        contact_person=ct.contact_name if ct else None, designation=(ct.designation if ct else None), department=(ct.department if ct else None),
        mobile=(ct.mobile or ct.office_phone) if ct else None, email=ct.office_email if ct else None,
        products=[ProductEntry(product_id=p.id, product_name=p.name)] if p else [], lead_type="lead",
    )
    res = create_lead(payload, request, db=db, cu=cu)
    lead_id = res["id"] if isinstance(res, dict) else getattr(res, "id")
    if body.custom_data:
        # lead_router.create_lead does not persist custom_data (only update_lead does) – store the Form Builder values here
        row = db.query(Lead).filter(Lead.id == lead_id).first()
        if row is not None:
            row.custom_data = body.custom_data
            db.commit()
    if ct:
        _set_contact(db, lead_id, ct.id)
    return {"id": lead_id, "approval_status": (res.get("approval_status") if isinstance(res, dict) else getattr(res, "approval_status", None))}


@router.put("/{lead_id}")
def update(lead_id: int, body: LeadIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(lead_user)):
    from app.routers.lead_router import LeadUpdate, update_lead
    _need(db, cu, "leads.update", "edit leads")
    lead = get_lead(db, cu, lead_id)
    v = _validate(db, cu, body, lead)
    cust, ct, p = v["customer"], v.get("contact"), v.get("product")
    fields: dict[str, Any] = {"customer_id": cust.id, "customer_name": cust.customer_name, "source_id": body.source_id, "est_value": body.est_value or 0,
                              "assigned_to": body.assigned_to, "follow_up": body.follow_up.isoformat() if body.follow_up else None}
    if body.custom_data is not None:
        fields["custom_data"] = body.custom_data
    if ct:
        fields.update(contact_person=ct.contact_name, designation=ct.designation, department=ct.department, mobile=ct.mobile or ct.office_phone, email=ct.office_email)
    update_lead(lead_id, LeadUpdate(**fields), request, db=db, cu=cu)
    # "Interested in" is the lead's first product line: replace only that line so any other products / OEMs stay
    if p:
        first = S.first_products(db, [lead_id]).get(lead_id)
        if not first:
            db.add(LeadProduct(lead_id=lead_id, product_id=p.id, product_name=p.name, quantity=1, sort_order=0))
        elif first["product_id"] != p.id:
            row = db.query(LeadProduct).filter(LeadProduct.id == first["row_id"]).first()
            row.product_id, row.product_name = p.id, p.name
        if not first or first["product_id"] != p.id:
            lead = db.query(Lead).filter(Lead.id == lead_id).first()
            if first is None or (lead.lead_title or "") == (first or {}).get("name"):
                lead.lead_title = p.name[:500]
            log_audit_db(db, cu.id, "leads", "update", lead_id, get_request_ip(request), f"Interested in → {p.name}", record_name=lead.lead_title)
            db.commit()
    _set_contact(db, lead_id, ct.id if ct else None)
    return {"id": lead_id}


@router.delete("/{lead_id}")
def delete(lead_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(lead_user)):
    from app.routers.lead_router import delete_lead
    get_lead(db, cu, lead_id)
    delete_lead(lead_id, request, db=db, cu=cu)
    return {"ok": True}


# ─── workflow ─────────────────────────────────────────────────────────────────

class StageIn(BaseModel):
    stage: str
    reason: Optional[str] = Field(None, max_length=120)
    comment: Optional[str] = Field(None, max_length=1000)


def _move(db: Session, cu: User, request: Request, lead_id: int, stage: str, reason: Optional[str], comment: Optional[str]):
    """One stage move through the existing status endpoint; a lost stage records its reason (setting lead_lost_reasons)."""
    from app.routers.lead_router import update_lead_status
    lead = get_lead(db, cu, lead_id)
    st = next((s for s in S.stages() if s["key"] == stage), None)
    if not st:
        raise HTTPException(422, "Unknown stage")
    if stage == "Converted":
        raise HTTPException(400, "A lead is converted from its deal – use Convert")
    lost = st["kind"] == "lost" and lead.status != stage
    if lost:
        cfg = S.lost_reasons(db)
        reason = (reason or "").strip() or None
        if reason and reason not in cfg["reasons"]:
            raise HTTPException(422, "Choose a lost reason from the list")
        if cfg["required"] and not reason:
            raise HTTPException(422, "Choose why this lead was lost")
    res = update_lead_status(lead_id, {"status": stage}, request, db=db, cu=cu)
    if lost and (reason or (comment or "").strip()):
        text_ = f"Marked as {st['label']}" + (f" · Reason: {reason}" if reason else "") + (f" – {comment.strip()}" if (comment or "").strip() else "")
        db.add(LeadNote(lead_id=lead_id, body=text_, created_by=cu.id))
        log_audit_db(db, cu.id, "leads", "lost_reason", lead_id, get_request_ip(request), text_,
                     new_data={"reason": reason, "comment": (comment or "").strip() or None}, record_name=lead.lead_title)
        db.commit()
    return res


@router.post("/{lead_id}/stage")
def change_stage(lead_id: int, body: StageIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(lead_user)):
    """Move along the lead workflow through the existing status endpoint (its rules, activity log, audit, notifications)."""
    return _move(db, cu, request, lead_id, body.stage, body.reason, body.comment)


class ConvertIn(BaseModel):
    target: Literal["deal", "tender", "quotation"] = "deal"


@router.post("/{lead_id}/convert")
def convert(lead_id: int, body: ConvertIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(lead_user)):
    """Lead → Deal (Opportunity Created, as configured in the lead workflow); Deal → Tender / Quotation through the
    existing conversion request, which applies the approval rules (admin / CEO direct, others via approval)."""
    from app.routers.lead_router import ConversionRequestBody, request_lead_conversion, update_lead_status
    lead = get_lead(db, cu, lead_id)
    if body.target == "deal":
        if lead.status not in S.OPEN_STAGES:
            raise HTTPException(400, f"A lead in '{lead.status}' cannot be converted to a deal")
        return update_lead_status(lead_id, {"status": "Opportunity Created"}, request, db=db, cu=cu)
    return request_lead_conversion(lead_id, request, ConversionRequestBody(conversion_target=body.target), db=db, cu=cu)


# ─── drawer ───────────────────────────────────────────────────────────────────

@router.get("/{lead_id}")
def get_detail(lead_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(lead_user)):
    d = S.detail(db, cu, get_lead(db, cu, lead_id))
    d["can"] = {"update": user_has_permission(db, cu, "leads.update"), "delete": user_has_permission(db, cu, "leads.delete"),
                "documents": user_has_permission(db, cu, "document_management.create"), "log_activity": user_has_permission(db, cu, "kam.create")}
    return d


@router.get("/{lead_id}/documents")
def documents(lead_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(lead_user)):
    get_lead(db, cu, lead_id)
    if not user_has_permission(db, cu, "document_management.view"):
        return {"items": [], "allowed": False}
    from app.routers.document_management_router import _collect_documents, _filter_documents_by_trash_state, _prepare_document_payload
    docs, _ = _collect_documents(db, cu, source_filter="leads", limit=500)
    docs = [d for d in docs if int(d.get("record_id") or 0) == lead_id]
    docs = _filter_documents_by_trash_state(db, docs, trash_view=False)
    cleaned, _ = _prepare_document_payload(db, cu, docs, 200)
    return {"items": [{"id": d["id"], "name": d["name"], "type": d.get("doc_type"), "updated_at": d.get("updated_at"), "url": d.get("url"),
                       "size_kb": d.get("size_kb"), "owner": d.get("owner")} for d in cleaned], "allowed": True}


class NoteIn(BaseModel):
    body: str = Field(..., min_length=1, max_length=5000)


MENTION_RE = re.compile(r"@([A-Za-z][\w.\-]*(?:\s[A-Z][\w.\-]*)?)")


@router.post("/{lead_id}/notes", status_code=201)
def add_note(lead_id: int, body: NoteIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(lead_user)):
    lead = get_lead(db, cu, lead_id)
    text = body.body.strip()
    if not text:
        raise HTTPException(422, "Write a note first")
    n = LeadNote(lead_id=lead.id, body=text, created_by=cu.id)
    db.add(n)
    db.flush()
    log_audit_db(db, cu.id, "leads", "note", lead.id, get_request_ip(request), "Note added", new_data={"note": text[:500]}, record_name=lead.lead_title)
    # @mentions → in-app notification (honours the user's Mentions delivery preference)
    users = db.query(User).filter(User.is_active == True, User.id != cu.id).all()
    mentioned = {u.id for u in users for m in MENTION_RE.findall(text) if u.full_name.lower().startswith(m.lower()) or (u.username or "").lower() == m.lower()}
    if mentioned:
        try:
            from app.services.notification_service import upsert_notification
            for uid in mentioned:
                upsert_notification(db, uid, "You were mentioned", f"{cu.full_name} mentioned you on lead {lead.lead_ref_id or lead.id}: {text[:160]}",
                                    module="leads", record_id=lead.id, action="mention", send_email=False)
        except Exception as exc:
            logger.warning("Mention notification failed: %s", exc)
    db.commit()
    return {"id": n.id, "body": n.body, "by": cu.full_name, "at": n.created_at.isoformat() if n.created_at else None, "mentioned": len(mentioned)}


# ─── bulk & import ────────────────────────────────────────────────────────────

class BulkIn(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=500)
    action: Literal["reassign", "delete", "stage"]
    value: Optional[str] = None
    reason: Optional[str] = Field(None, max_length=120)
    comment: Optional[str] = Field(None, max_length=1000)


@router.post("/bulk")
def bulk(body: BulkIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(lead_user)):
    from app.routers.lead_router import LeadUpdate, delete_lead, update_lead, update_lead_status
    done, failed = 0, []
    for lid in dict.fromkeys(body.ids):
        try:
            lead = get_lead(db, cu, lid)
            if body.action == "delete":
                delete_lead(lid, request, db=db, cu=cu)
            elif body.action == "reassign":
                uid = int(body.value or 0)
                if not db.query(User.id).filter(User.id == uid, User.is_active == True).first():
                    raise HTTPException(422, "Choose an active user")
                update_lead(lid, LeadUpdate(assigned_to=uid), request, db=db, cu=cu)
            else:
                if body.value not in [s["key"] for s in S.stages()] or body.value == "Converted":
                    raise HTTPException(422, "Choose a stage")
                _move(db, cu, request, lid, body.value, body.reason, body.comment)
            done += 1
        except HTTPException as exc:
            db.rollback()
            failed.append({"id": lid, "error": detail_text(exc.detail, "Not allowed")})
    return {"done": done, "failed": failed}


IMPORT_COLUMNS = ["Company", "Contact person", "Source", "Expected value", "Interested in", "Owner email", "Next follow-up (YYYY-MM-DD)"]


@router.get("/import/template")
def import_template(cu: User = Depends(lead_user)):
    from fastapi.responses import Response
    return Response(",".join(IMPORT_COLUMNS) + "\n", media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="leads-import-template.csv"'})


@router.post("/import")
async def import_leads(request: Request, file: UploadFile = File(...), db: Session = Depends(get_tenant_db), cu: User = Depends(lead_user)):
    """Each row is matched to the masters by name (company, contact, source, product, owner e-mail) and created through
    the same validated path as the form; rows that do not match a master are reported, never guessed."""
    _need(db, cu, "leads.create", "create leads")
    raw = await file.read()
    if len(raw) > 2_000_000:
        raise HTTPException(413, "The file is larger than 2 MB")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or "Company" not in [h.strip() for h in reader.fieldnames]:
        raise HTTPException(422, "The CSV needs a 'Company' column – download the template")
    custs = {c["customer_name"].strip().lower(): c["id"] for c in authorized_customers(db, cu)}
    sources = {s.name.strip().lower(): s.id for s in db.query(LeadSource).filter(LeadSource.is_active == True).all()}
    products = {p.name.strip().lower(): p.id for p in db.query(ProductMaster).filter(ProductMaster.is_active != False).all()}
    owners = {(u.email or "").lower(): u.id for u in db.query(User).filter(User.is_active == True).all()}
    created, errors = 0, []
    for n, row in enumerate(reader, start=2):
        if n > 1001:
            errors.append({"row": n, "error": "Only the first 1,000 rows are imported"}); break
        r = {(k or "").strip(): (v or "").strip() for k, v in row.items()}
        if not r.get("Company"):
            continue
        try:
            cid = custs.get(r["Company"].lower())
            if not cid:
                raise HTTPException(422, f"Company '{r['Company']}' is not in your customer list")
            contact_id = None
            if r.get("Contact person"):
                ct = db.query(CustomerContact).filter(CustomerContact.customer_id == cid, CustomerContact.is_active == True,
                                                      CustomerContact.contact_name == r["Contact person"]).first()
                if not ct:
                    raise HTTPException(422, f"Contact '{r['Contact person']}' is not an active contact of {r['Company']}")
                contact_id = ct.id
            def pick(col, table, what):
                val = r.get(col)
                if not val:
                    return None
                if val.lower() not in table:
                    raise HTTPException(422, f"{what} '{val}' is not in the masters")
                return table[val.lower()]
            fu = r.get("Next follow-up (YYYY-MM-DD)") or None
            body = LeadIn(customer_id=cid, contact_id=contact_id, source_id=pick("Source", sources, "Source"),
                          est_value=float(r["Expected value"].replace(",", "")) if r.get("Expected value") else None,
                          product_id=pick("Interested in", products, "Product"), assigned_to=pick("Owner email", owners, "Owner"),
                          follow_up=date.fromisoformat(fu) if fu else None)
            create(body, request, db=db, cu=cu)
            created += 1
        except HTTPException as exc:
            db.rollback(); errors.append({"row": n, "company": r.get("Company"), "error": detail_text(exc.detail, "Rejected")})
        except ValueError as exc:
            db.rollback(); errors.append({"row": n, "company": r.get("Company"), "error": f"Invalid value: {exc}"[:200]})
    return {"created": created, "errors": errors[:200], "error_count": len(errors)}
