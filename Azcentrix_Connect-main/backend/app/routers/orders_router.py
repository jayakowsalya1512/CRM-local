"""Orders & Projects (prototype v17 · Sales → Orders & Projects)   /api/v1/orders

List & board (views All · Running · Delayed · Billing gap; lifecycle type tabs), New order form (+ duplicates, Form
Builder fields), record drawer (stage path, journey, milestones & billing, activity, documents, notes), stage engine +
approvals, milestones / invoices / progress, follow-on contracts, quote & tender conversion, bulk actions, CSV import,
Settings → Orders & projects and the order lifecycles (Process Designer).

Permissions: workorders.view / create / update / delete / export (+ data scope "workorders"); configuration needs
settings.manage. The legacy /api/v1/workorders API (reports, drill-downs, Field Sales 360) is unchanged.
"""
from __future__ import annotations

import csv
import io
import json
from datetime import date, date as Date, timedelta
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator, model_validator
from app.core import validators as V
from sqlalchemy.orm import Session

from app.core.validators import detail_text
from app.core.logging import log_audit_db
from app.core.timezone import today_ist
from app.dependencies import get_current_user, get_request_ip, get_tenant_db, user_has_permission
from app.models.all_models import DocumentFolder, User, WorkOrder
from app.models.orders import OrderNote
from app.services import order_service as S
from app.services import order_payment_service as P

router = APIRouter()
# prototype colsOf(wo): WO no. | Company | Journey | Type | Work | Customer | PO | Value | Progress | Billed | Stage | PM | Due (+ row ⋯ menu)
# v18 adds Received · Awaiting finance (payment collection) before Stage
COLUMNS = ["ref", "company", "jid", "type", "title", "customer", "po", "value", "progress", "billed", "received", "awaiting", "stage", "pm", "due"]


def order_user(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if not user_has_permission(db, cu, "workorders.view"):
        raise HTTPException(403, "You do not have access to Orders & Projects")
    S.ensure_schema(db)
    return cu


def _need(db: Session, cu: User, key: str, what: str) -> None:
    if not user_has_permission(db, cu, key):
        raise HTTPException(403, f"You do not have permission to {what}")


def _can(db: Session, cu: User) -> dict[str, bool]:
    return {"create": user_has_permission(db, cu, "workorders.create"), "update": user_has_permission(db, cu, "workorders.update"),
            "delete": user_has_permission(db, cu, "workorders.delete"), "export": user_has_permission(db, cu, "workorders.export"),
            "documents": user_has_permission(db, cu, "document_management.create"), "log_activity": user_has_permission(db, cu, "kam.create"),
            "customers": user_has_permission(db, cu, "customers.view"), "configure": user_has_permission(db, cu, "settings.manage")}


def _company(db: Session) -> Optional[str]:
    from app.services.quote_service import tenant_info
    try:
        return tenant_info(db)["name"]
    except Exception:
        return None


# ─── meta & lookups ───────────────────────────────────────────────────────────

@router.get("/meta")
def meta(db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    return {"company": _company(db), "views": S.VIEWS, "lifecycles": S.lifecycles(db), "me": {"id": cu.id, "name": cu.full_name},
            "config": S.config(db), "can": _can(db, cu), "templates": list(S.TEMPLATES), "triggers": S.TRIGGERS,
            "billing_models": list(S.BILLING_MODELS), "number_formats": list(S.NUMBER_FORMATS)}


@router.get("/customers")
def customers(q: str = "", limit: int = Query(50, ge=1, le=500), db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    from app.routers.deals_router import authorized_customers
    rows = authorized_customers(db, cu)
    t = q.strip().lower()
    if t:
        rows = [c for c in rows if t in (c["customer_name"] or "").lower()]
    return {"items": [{"id": c["id"], "name": c["customer_name"]} for c in rows[:limit]], "total": len(rows)}


@router.get("/duplicates")
def duplicates(customer_id: int, title: str = "", po: str = "", exclude_id: Optional[int] = None, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    return {"items": S.duplicates(db, cu, customer_id, title, po, exclude_id)}


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


@router.get("/list")
def list_orders(view: str = "All", type: str = "", stage: str = "", q: str = "", f: str = "", adv: str = "", sorts: str = "",
                offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=1000), db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    try:
        quick, advf, order = (json.loads(f) if f else {}), (json.loads(adv) if adv else {}), (json.loads(sorts) if sorts else [])
    except ValueError:
        raise HTTPException(422, "Invalid filter or sort")
    rows, lcs = S.list_rows(db, cu)
    type_counts = {l["type"]: sum(1 for r in rows if r["lifecycle"] == l["key"]) for l in lcs if l["active"]}
    if type:
        rows = [r for r in rows if r["type"] == type]
    counts = {v: sum(1 for r in rows if S.in_view(r, v)) for v in S.VIEWS}
    sel = [r for r in rows if S.in_view(r, view)]
    if stage:
        sel = [r for r in sel if r["stage"] == stage]
    if q.strip():
        ql = q.strip().lower()
        sel = [r for r in sel if any(ql in _txt(r, k).lower() for k in COLUMNS + ["jid"])]
    for k, v in (quick or {}).items():
        if k in COLUMNS and str(v or "").strip():
            sel = [r for r in sel if str(v).lower() in _txt(r, k).lower()]
    conds = [c for c in (advf.get("conds") or []) if isinstance(c, dict) and c.get("k") in COLUMNS]
    if conds:
        test = all if advf.get("logic") != "OR" else any
        sel = [r for r in sel if test(_cond(r, c["k"], str(c.get("op") or "contains"), str(c.get("v") or "")) for c in conds)]
    for k, d in reversed([x for x in order if isinstance(x, (list, tuple)) and len(x) == 2 and x[0] in COLUMNS]):
        num = k in ("value", "progress", "billed", "received", "awaiting")
        sel.sort(key=lambda r: (r.get(k) is None, (r.get(k) or 0) if num else _txt(r, k).lower()), reverse=d == -1)
    return {"items": sel[offset: offset + limit], "total": len(sel), "total_all": len(rows), "counts": counts, "type_counts": type_counts,
            "value_total": sum(r["value"] for r in sel), "pending_finance": sum(r["pending_receipts"] for r in rows)}


# ─── v18 · Collections & finance ──────────────────────────────────────────────

@router.get("/collections")
def collections(db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    """Collections & finance segment: KPI strip, Finance acknowledgement queue, payment schedule (all orders), receipts."""
    return P.collections(db, cu)


# ─── create / edit / delete ───────────────────────────────────────────────────

class OrderIn(BaseModel):
    title: str = Field(..., max_length=300)
    customer_id: int
    po: Optional[str] = Field(None, max_length=100)
    value: Optional[float] = Field(None, ge=0)
    start: Optional[date] = None
    due: Optional[date] = None
    pm_id: Optional[int] = None
    lifecycle: Optional[str] = None
    custom_data: Optional[dict[str, Any]] = None

    @field_validator("title")
    @classmethod
    def _txt10(cls, v):
        return V.check_text(v, "Order title", 3, 300, required=True)

    @field_validator("po")
    @classmethod
    def _txt11(cls, v):
        return V.check_text(v, "PO number", 0, 100, required=False)

    @field_validator("start", "due")
    @classmethod
    def _dates(cls, v, info):
        return V.check_date_range(v, info.field_name.replace("_", " ").capitalize())

    @field_validator("value")
    @classmethod
    def _value(cls, v):
        return V.check_amount(v, "Order value")

    @model_validator(mode="after")
    def _due_after_start(self):
        if self.start and self.due and self.due < self.start:
            raise V.field_error("due", "Due date cannot be before the start date.")
        return self


@router.post("", status_code=201)
def create(body: OrderIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    _need(db, cu, "workorders.create", "create orders")
    body.custom_data = V.validate_module_custom_data(db, S.FORM_MODULE, body.custom_data, enforce_required=False)
    v = S.validate(db, cu, body.model_dump())
    wo = S.create_order(db, cu, request, v, lifecycle=body.lifecycle or S.DEFAULT_KEY)
    return {"id": wo.id, "ref": wo.wo_number}


@router.put("/{wo_id}")
def update(wo_id: int, body: OrderIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    _need(db, cu, "workorders.update", "edit orders")
    wo = S.get_order(db, cu, wo_id)
    body.custom_data = V.validate_module_custom_data(db, S.FORM_MODULE, body.custom_data, enforce_required=False)
    S.update_order(db, cu, request, wo, S.validate(db, cu, body.model_dump(), current=wo))
    return {"id": wo.id}


@router.delete("/{wo_id}")
def delete(wo_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    _need(db, cu, "workorders.delete", "delete orders")
    S.delete_order(db, cu, request, S.get_order(db, cu, wo_id))
    return {"ok": True}


# ─── record drawer ────────────────────────────────────────────────────────────

@router.get("/{wo_id}")
def get_detail(wo_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    d = S.detail(db, cu, S.get_order(db, cu, wo_id))
    d["can"] = _can(db, cu)
    return d


class StageIn(BaseModel):
    stage_id: int
    checklist: Optional[list[str]] = None


@router.post("/{wo_id}/stage")
def change_stage(wo_id: int, body: StageIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    _need(db, cu, "workorders.update", "move orders")
    return S.move(db, cu, request, S.get_order(db, cu, wo_id), body.stage_id, body.checklist)


class ProgressIn(BaseModel):
    progress: int = Field(..., ge=0, le=100)


@router.patch("/{wo_id}/progress")
def progress(wo_id: int, body: ProgressIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    _need(db, cu, "workorders.update", "update progress")
    S.set_progress(db, cu, request, S.get_order(db, cu, wo_id), body.progress)
    return {"ok": True}


class MilestoneIn(BaseModel):
    name: str = Field(..., max_length=200)
    date: Optional[Date] = None
    amount: Optional[float] = Field(0, ge=0)
    done: bool = False
    completed: Optional[Date] = None
    notes: Optional[str] = Field(None, max_length=2000)


@router.get("/{wo_id}/milestones")
def get_milestones(wo_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    return S.milestones(db, S.get_order(db, cu, wo_id))


@router.post("/{wo_id}/milestones", status_code=201)
def add_milestone(wo_id: int, body: MilestoneIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    _need(db, cu, "workorders.update", "edit milestones")
    m = S.save_milestone(db, cu, request, S.get_order(db, cu, wo_id), None, body.model_dump())
    return {"id": m.id}


@router.put("/{wo_id}/milestones/{mid}")
def edit_milestone(wo_id: int, mid: int, body: MilestoneIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    _need(db, cu, "workorders.update", "edit milestones")
    S.save_milestone(db, cu, request, S.get_order(db, cu, wo_id), mid, body.model_dump())
    return {"id": mid}


@router.delete("/{wo_id}/milestones/{mid}")
def remove_milestone(wo_id: int, mid: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    _need(db, cu, "workorders.update", "edit milestones")
    S.delete_milestone(db, cu, request, S.get_order(db, cu, wo_id), mid)
    return {"ok": True}


class InvoiceIn(BaseModel):
    number: str = Field(..., max_length=100)
    date: Optional[Date] = None
    due: Optional[Date] = None
    amount: float = Field(..., gt=0)
    gst: Optional[float] = Field(0, ge=0)
    milestone_id: Optional[int] = None
    notes: Optional[str] = Field(None, max_length=2000)


@router.post("/{wo_id}/invoices", status_code=201)
def add_invoice(wo_id: int, body: InvoiceIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    _need(db, cu, "workorders.update", "record invoices")
    inv = S.add_invoice(db, cu, request, S.get_order(db, cu, wo_id), body.model_dump())
    return {"id": inv.id}


# ─── v18 · order payments (Payments tab) ─────────────────────────────────────

@router.get("/{wo_id}/payments")
def get_payments(wo_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    return P.payments(db, cu, S.get_order(db, cu, wo_id))


class PlanRow(BaseModel):
    id: Optional[int] = None
    name: str = Field(..., max_length=200)
    pct: float = Field(..., gt=0, le=100)
    due: Optional[Date] = None
    invoice_ref: Optional[str] = Field(None, max_length=120)


class PlanIn(BaseModel):
    plan: Literal["Single", "Stage-wise"]
    stages: list[PlanRow] = Field(..., min_length=1, max_length=60)


@router.put("/{wo_id}/payment-plan")
def put_plan(wo_id: int, body: PlanIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    _need(db, cu, "workorders.update", "change payment plans")
    return P.save_plan(db, cu, request, S.get_order(db, cu, wo_id), body.plan, [r.model_dump() for r in body.stages])


class ReceiptIn(BaseModel):
    stage_id: int
    amount: float = Field(..., gt=0)
    received_on: Date
    mode: str = Field(..., max_length=40)
    reference: str = Field(..., max_length=120)
    collected_by: Optional[int] = None
    remarks: Optional[str] = Field(None, max_length=500)


@router.post("/{wo_id}/receipts", status_code=201)
def add_receipt(wo_id: int, body: ReceiptIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    _need(db, cu, "workorders.update", "record customer payments")
    return P.record_receipt(db, cu, request, S.get_order(db, cu, wo_id), body.model_dump())


@router.put("/{wo_id}/receipts/{rid}")
def correct_receipt(wo_id: int, rid: int, body: ReceiptIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    _need(db, cu, "workorders.update", "correct customer payments")
    return P.correct_receipt(db, cu, request, S.get_order(db, cu, wo_id), rid, body.model_dump())


class AckIn(BaseModel):
    bank_date: Optional[Date] = None
    bank_ref: Optional[str] = Field(None, max_length=120)
    credited_to: Optional[str] = Field(None, max_length=120)
    credited_amount: Optional[float] = Field(None, gt=0)
    remarks: Optional[str] = Field(None, max_length=500)


@router.post("/{wo_id}/receipts/{rid}/acknowledge")
def ack_receipt(wo_id: int, rid: int, body: AckIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    return P.acknowledge(db, cu, request, S.get_order(db, cu, wo_id), rid, body.model_dump(), credited=True)


@router.post("/{wo_id}/receipts/{rid}/not-credited")
def not_credited(wo_id: int, rid: int, body: AckIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    return P.acknowledge(db, cu, request, S.get_order(db, cu, wo_id), rid, body.model_dump(), credited=False)


@router.get("/{wo_id}/receipts/{rid}/history")
def receipt_history(wo_id: int, rid: int, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    return {"items": P.history(db, S.get_order(db, cu, wo_id), rid)}


class FollowIn(BaseModel):
    lifecycle: str


@router.post("/{wo_id}/follow-on", status_code=201)
def follow_on(wo_id: int, body: FollowIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    _need(db, cu, "workorders.create", "create orders")
    parent = S.get_order(db, cu, wo_id)
    wo = S.follow_on(db, cu, request, parent, body.lifecycle)
    db.commit()
    return {"id": wo.id, "ref": wo.wo_number, "message": f"Contract {wo.wo_number} created from {parent.wo_number}"}


@router.get("/{wo_id}/documents")
def documents(wo_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    """Document Hub files linked to the order (source Work Orders): File | Folder | Updated."""
    S.get_order(db, cu, wo_id)
    if not user_has_permission(db, cu, "document_management.view"):
        return {"items": [], "allowed": False}
    from app.routers.document_management_router import DOCUMENT_SOURCE_LABELS, _collect_documents, _filter_documents_by_trash_state, _prepare_document_payload
    docs, _ = _collect_documents(db, cu, source_filter=S.MODULE, limit=500)
    docs = [d for d in docs if int(d.get("record_id") or 0) == wo_id]
    docs = _filter_documents_by_trash_state(db, docs, trash_view=False)
    folders = {f.id: f.name for f in db.query(DocumentFolder).filter(DocumentFolder.id.in_([d.get("folder_id") for d in docs if d.get("folder_id")] or [-1])).all()}
    cleaned, _ = _prepare_document_payload(db, cu, docs, 200)
    lbl = DOCUMENT_SOURCE_LABELS.get(S.MODULE, "Work Orders")
    fid = {str(d.get("id")): folders.get(d.get("folder_id")) for d in docs}
    return {"items": [{"id": d["id"], "name": d["name"], "folder": fid.get(str(d["id"])) or lbl, "updated_at": d.get("updated_at"), "url": d.get("url"),
                       "type": d.get("doc_type"), "size_kb": d.get("size_kb"), "owner": d.get("owner")} for d in cleaned], "allowed": True}


class NoteIn(BaseModel):
    body: str = Field(..., min_length=1, max_length=5000)


@router.post("/{wo_id}/notes", status_code=201)
def add_note(wo_id: int, body: NoteIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    wo = S.get_order(db, cu, wo_id)
    t = body.body.strip()
    if not t:
        raise HTTPException(422, "Write a note first")
    n = OrderNote(wo_id=wo.id, body=t, created_by=cu.id)
    db.add(n)
    db.flush()
    log_audit_db(db, cu.id, S.MODULE, "note", wo.id, get_request_ip(request), "Note added", new_data={"note": t[:500]}, record_name=wo.wo_number)
    from app.routers.deals_router import MENTION_RE
    ids = {u.id for u in db.query(User).filter(User.is_active == True, User.id != cu.id).all()  # noqa: E712
           for m in MENTION_RE.findall(t) if u.full_name.lower().startswith(m.lower())}
    for uid in ids:
        S.notify(db, uid, "You were mentioned", f"{cu.full_name} mentioned you on order {wo.wo_number}: {t[:160]}", wo.id, "mention")
    db.commit()
    return {"id": n.id, "mentioned": len(ids)}


@router.put("/{wo_id}/notes/{note_id}")
def edit_note(wo_id: int, note_id: int, body: NoteIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    wo = S.get_order(db, cu, wo_id)
    n = db.query(OrderNote).filter(OrderNote.id == note_id, OrderNote.wo_id == wo.id).first()
    if not n:
        raise HTTPException(404, "Note not found")
    if n.created_by != cu.id and not user_has_permission(db, cu, "settings.manage"):
        raise HTTPException(403, "You can edit only your own notes")
    old, n.body = n.body, body.body.strip()
    log_audit_db(db, cu.id, S.MODULE, "note_edit", wo.id, get_request_ip(request), "Note edited", old_data={"note": old[:500]}, new_data={"note": n.body[:500]},
                 record_name=wo.wo_number)
    db.commit()
    return {"id": n.id}


# ─── quote / tender → order conversion ────────────────────────────────────────

class ConvertIn(BaseModel):
    source: Literal["quote", "tender"]
    id: int


@router.post("/convert", status_code=201)
async def convert(body: ConvertIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    """Accepted quote / won tender → work order through the source module's own conversion (its permission, approval and
    duplicate rules; the source record is not modified beyond its work-order link)."""
    _need(db, cu, "workorders.create", "create orders")
    if body.source == "quote":
        from app.routers.quotes_router import quote_user, work_order as quote_wo
        r = quote_wo(body.id, request, db, quote_user(db, cu))
        return {"id": r.get("id"), "ref": r.get("wo_number"), "message": r.get("message")}
    from app.routers.bids_router import bid_user, create_work_order as tender_wo
    r = await tender_wo(body.id, request, db, bid_user(db, cu))
    return {"id": r.get("wo_id"), "ref": r.get("wo_number"), "message": f"Work order {r.get('wo_number')} created"}


# ─── bulk & import ────────────────────────────────────────────────────────────

class BulkIn(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=500)
    action: Literal["reassign", "delete", "stage"]
    value: Optional[str] = None


@router.post("/bulk")
def bulk(body: BulkIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    _need(db, cu, "workorders.delete" if body.action == "delete" else "workorders.update", "change these orders")
    done, failed = 0, []
    pm = None
    if body.action == "reassign":
        pm = db.query(User).filter(User.id == int(body.value or 0), User.is_active == True).first()  # noqa: E712
        if not pm:
            raise HTTPException(422, "Choose an active project manager")
    for i in body.ids:
        try:
            wo = S.get_order(db, cu, i)
            if body.action == "delete":
                S.delete_order(db, cu, request, wo)
            elif body.action == "reassign":
                prev = wo.project_manager_id
                wo.project_manager_id = pm.id
                if prev != pm.id:
                    S._log(db, cu, request, wo, "update", f"Project manager changed to {pm.full_name}", old={"pm": prev}, new={"pm": pm.id}, icon="👤")
                    if pm.id != cu.id:
                        S.notify(db, pm.id, "Order assigned", f"{cu.full_name} made you project manager of {wo.wo_number} – {wo.project_title}.", wo.id, "assigned")
                db.commit()
            else:
                r = S.move(db, cu, request, wo, int(body.value or 0))
                if r["status"] == "pending":
                    failed.append({"id": i, "error": r["message"]})
                    continue
            done += 1
        except HTTPException as e:
            db.rollback()
            d = e.detail
            failed.append({"id": i, "error": d if isinstance(d, str) else (d or {}).get("message", "Not changed")})
    return {"done": done, "failed": failed}


IMPORT_COLS = ["Work order title", "Customer", "PO number", "Order value", "Start date", "Due date", "Project manager email"]


@router.get("/import/template")
def import_template(cu: User = Depends(order_user)):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(IMPORT_COLS)
    w.writerow(["Supply & installation of 40 kVA UPS", "Acme Industries Ltd", "PO/1234/2026", "1850000", today_ist().isoformat(),
                (today_ist() + timedelta(days=120)).isoformat(), ""])
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="orders-import-template.csv"'})


@router.post("/import")
async def import_csv(request: Request, file: UploadFile = File(...), dry_run: bool = False, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    _need(db, cu, "workorders.create", "import orders")
    raw = await file.read()
    if len(raw) > 5 * 1024 * 1024:
        raise HTTPException(413, "The file is larger than 5 MB")
    try:
        rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))
    except UnicodeDecodeError:
        raise HTTPException(422, "Save the file as UTF-8 CSV")
    if not rows:
        raise HTTPException(422, "The file has no rows")
    if len(rows) > 2000:
        raise HTTPException(422, "Import at most 2,000 rows at a time")
    from app.routers.deals_router import authorized_customers
    custs = {(c["customer_name"] or "").strip().lower(): c for c in authorized_customers(db, cu)}
    users = {(u.email or "").lower(): u.id for u in db.query(User.id, User.email).filter(User.is_active == True).all()}  # noqa: E712
    created, errors, dups, seen = 0, [], [], set()

    def dt(s: str) -> Optional[date]:
        s = (s or "").strip()
        return date.fromisoformat(s) if s else None

    for n, r in enumerate(rows, start=2):
        g = lambda k: (r.get(k) or "").strip()  # noqa: E731
        name = g("Work order title")
        try:
            c = custs.get(g("Customer").lower())
            if not c:
                raise ValueError(f"Customer “{g('Customer')}” not found or not accessible")
            pm = users.get(g("Project manager email").lower()) if g("Project manager email") else None
            if g("Project manager email") and not pm:
                raise ValueError("Project manager email does not match an active user")
            val = float(g("Order value").replace(",", "")) if g("Order value") else None
            body = {"title": name, "customer_id": c["id"], "po": g("PO number") or None, "value": val, "start": dt(g("Start date")), "due": dt(g("Due date")), "pm_id": pm}
            k = (c["id"], (body["po"] or "").lower())
            if body["po"] and k in seen:
                dups.append({"row": n, "name": name, "error": f"PO {body['po']} appears twice in the file"})
                continue
            v = S.validate(db, cu, body)
            seen.add(k)
            if not dry_run:
                S.create_order(db, cu, request, v)
            created += 1
        except HTTPException as e:
            db.rollback()
            d = detail_text(e.detail, "Invalid row")
            (dups if e.status_code == 409 else errors).append({"row": n, "name": name, "error": d})
        except ValueError as e:
            errors.append({"row": n, "name": name, "error": str(e) or "Invalid value"})
    return {"created": created, "dry_run": dry_run, "errors": errors[:200], "duplicates": dups[:200], "error_count": len(errors), "duplicate_count": len(dups)}


# ─── Settings → Orders & projects · order lifecycles ──────────────────────────

class SettingsIn(BaseModel):
    milestones: Optional[bool] = None
    billing_model: Optional[str] = None
    retention: Optional[bool] = None
    retention_pct: Optional[float] = None
    auto_pm: Optional[bool] = None
    slip_alert: Optional[bool] = None
    number_format: Optional[str] = None
    number_custom: Optional[str] = None


@router.get("/config/settings")
def get_settings(db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    return {**S.config(db), "can_configure": user_has_permission(db, cu, "settings.manage"), "next_number": S.next_number(db)}


@router.put("/config/settings")
def put_settings(body: SettingsIn, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    _need(db, cu, "settings.manage", "change Orders & projects settings")
    return S.save_config(db, cu, body.model_dump(exclude_none=True))


@router.get("/config/lifecycles")
def get_lifecycles(db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    from sqlalchemy import text
    used = dict(db.execute(text("SELECT lifecycle, COUNT(*) FROM order_profiles GROUP BY lifecycle")).all())
    return {"items": [{**l, "orders": int(used.get(l["key"], 0))} for l in S.lifecycles(db)], "templates": list(S.TEMPLATES), "triggers": S.TRIGGERS}


class LifecycleIn(BaseModel):
    name: str = Field(..., max_length=80)
    template: str
    trigger: Literal["manual", "closure", "won"] = "manual"


@router.post("/config/lifecycles", status_code=201)
def post_lifecycle(body: LifecycleIn, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    _need(db, cu, "settings.manage", "configure order lifecycles")
    return S.create_lifecycle(db, cu, body.name, body.template, body.trigger)


class StageCfg(BaseModel):
    id: Optional[int] = None
    name: str
    kind: Literal["open", "won"] = "open"
    sla_days: int = Field(0, ge=0, le=3650)
    gate: Literal["None", "Approval", "Checklist"] = "None"
    owner_role: Optional[str] = None
    checklist: Optional[list[str]] = None


@router.put("/config/lifecycles/{key}/stages")
def put_stages(key: str, stages: list[StageCfg], db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    _need(db, cu, "settings.manage", "configure order lifecycles")
    S.save_stages(db, cu, key, [s.model_dump() for s in stages])
    return next(l for l in S.lifecycles(db) if l["key"] == key)


@router.delete("/config/lifecycles/{key}")
def delete_lifecycle(key: str, db: Session = Depends(get_tenant_db), cu: User = Depends(order_user)):
    _need(db, cu, "settings.manage", "configure order lifecycles")
    return {"moved": S.delete_lifecycle(db, cu, key)}
