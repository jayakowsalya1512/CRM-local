"""Quotes (prototype v17 · Sales → Quotes) – list & board, New quote form, quote page (revisions, line items, pricing,
revision note, commercial terms), stage engine + approvals, PDF preview / Document Hub, work-order conversion, import,
bulk actions, Settings → Quotes and the quote lifecycle configuration.   /api/v1/quotes

Permissions: quotations.view / create / update / delete (+ data scope "quotations"); configuration needs settings.manage.
"""
from __future__ import annotations

import csv
import io
import json
from datetime import date, timedelta
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
from app.models.all_models import QuotationLineItem, User
from app.services import quote_service as S

router = APIRouter()

VIEWS = ["All", "My quotes", "Multiple revisions", "Expiring ≤ 7d"]
# prototype v17 colsOf(quotes): Quote no. | Company | Journey | Subject | Customer | Revision | Latest value | Stage | Owner | Valid till | row actions (⋯)
COLUMNS = ["ref", "company", "jid", "subject", "customer", "rev", "value", "stage", "owner", "valid_till"]


def quote_user(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if not user_has_permission(db, cu, "quotations.view"):
        raise HTTPException(403, "You do not have access to Quotes")
    from app.services import lead360_service
    lead360_service.ensure_schema(db)          # shared lost-reason setting
    S.ensure_schema(db)
    return cu


def _need(db: Session, cu: User, key: str, what: str) -> None:
    if not user_has_permission(db, cu, key):
        raise HTTPException(403, f"You do not have permission to {what}")


def _ctx(db: Session, cu: User, quote_id: int):
    rows = S.get_group(db, cu, quote_id)
    st = S.stages(db)
    profiles, cur = S.sync(db, {rows[-1].quotation_number: rows}, st)
    rid = S.root_id(rows)
    return rows, profiles[rid], cur[rid], st


def _can(db: Session, cu: User) -> dict[str, bool]:
    return {"create": user_has_permission(db, cu, "quotations.create"), "update": user_has_permission(db, cu, "quotations.update"),
            "delete": user_has_permission(db, cu, "quotations.delete"), "export": user_has_permission(db, cu, "quotations.export"),
            "documents": user_has_permission(db, cu, "document_management.create"), "workorders": user_has_permission(db, cu, "workorders.view"),
            "configure": user_has_permission(db, cu, "settings.manage")}


# ─── meta & lookups ───────────────────────────────────────────────────────────

@router.get("/meta")
def meta(db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    from app.services.lead360_service import lost_reasons
    return {"company": S.tenant_info(db)["name"], "views": VIEWS, "stages": S.stages(db), "me": {"id": cu.id, "name": cu.full_name},
            "lost": lost_reasons(db), "config": S.config(db), "can": _can(db, cu)}


@router.get("/customers")
def customers(q: str = "", limit: int = Query(50, ge=1, le=500), db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    from app.routers.deals_router import authorized_customers
    rows = authorized_customers(db, cu)
    t = q.strip().lower()
    if t:
        rows = [c for c in rows if t in c["customer_name"].lower()]
    return {"items": [{"id": c["id"], "name": c["customer_name"]} for c in rows[:limit]], "total": len(rows)}


@router.get("/catalog")
def catalog(q: str = "", book_id: Optional[int] = None, db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    """Add from product catalogue: approved products with the effective price of the chosen price book."""
    return {"items": S.catalog(db, q, book_id), **S.catalog_meta(db)}


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


def _in_view(r: dict, view: str, me: int, t0: str, t7: str) -> bool:
    if view == "My quotes":
        return r["owner_id"] == me
    if view == "Multiple revisions":
        return r["revs"] > 1
    if view.startswith("Expiring"):
        return bool(r["valid_till"]) and t0 <= r["valid_till"] <= t7
    return True


@router.get("/list")
def list_quotes(view: str = "All", stage: str = "", q: str = "", f: str = "", adv: str = "", sorts: str = "",
                offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=1000), db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    try:
        quick, advf, order = (json.loads(f) if f else {}), (json.loads(adv) if adv else {}), (json.loads(sorts) if sorts else [])
    except ValueError:
        raise HTTPException(422, "Invalid filter or sort")
    rows, _ = S.list_rows(db, cu)
    today = today_ist()
    t0, t7 = today.isoformat(), (today + timedelta(days=7)).isoformat()
    counts = {v: sum(1 for r in rows if _in_view(r, v, cu.id, t0, t7)) for v in VIEWS}
    sel = [r for r in rows if _in_view(r, view, cu.id, t0, t7)]
    if stage:
        sel = [r for r in sel if r["stage"] == stage]
    if q.strip():
        ql = q.strip().lower()
        sel = [r for r in sel if any(ql in _txt(r, k).lower() for k in COLUMNS + ["enquiry"])]
    for k, v in (quick or {}).items():
        if k in COLUMNS and str(v or "").strip():
            sel = [r for r in sel if str(v).lower() in (f"rev {r['rev']} of {r['revs']}" if k == "rev" else _txt(r, k)).lower()]
    conds = [c for c in (advf.get("conds") or []) if isinstance(c, dict) and c.get("k") in COLUMNS]
    if conds:
        test = all if advf.get("logic") != "OR" else any
        sel = [r for r in sel if test(_cond(r, c["k"], str(c.get("op") or "contains"), str(c.get("v") or "")) for c in conds)]
    items = [x for x in order if isinstance(x, (list, tuple)) and len(x) == 2 and x[0] in COLUMNS]
    for k, d in reversed(items):
        num = k in ("value", "rev")
        sel.sort(key=lambda r: (r[k] or 0) if num else (r["id"] if k == "ref" else _txt(r, k).lower()), reverse=int(d) < 0)
    if not items:
        sel.sort(key=lambda r: -r["id"])
    return {"items": sel[offset:offset + limit], "total": len(sel), "total_all": len(rows), "counts": counts, "value_total": sum(r["value"] for r in sel)}


@router.get("/export")
def export_csv(view: str = "All", db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    _need(db, cu, "quotations.export", "export quotes")
    rows, _ = S.list_rows(db, cu)
    today = today_ist()
    t0, t7 = today.isoformat(), (today + timedelta(days=7)).isoformat()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Quote no.", "Company", "Journey", "Subject", "Customer", "Revision", "Latest value", "Stage", "Owner", "Valid till"])
    for r in sorted((r for r in rows if _in_view(r, view, cu.id, t0, t7)), key=lambda r: -r["id"]):
        w.writerow([r["ref"], r["company"], r["jid"] or "", r["subject"], r["customer"], f"Rev {r['rev']} of {r['revs']}", f"{r['value']:.2f}", r["stage"], r["owner"], r["valid_till"] or ""])
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="quotes.csv"'})


# ─── create / header ──────────────────────────────────────────────────────────

class QuoteIn(BaseModel):
    subject: str = Field(..., min_length=1, max_length=500)
    customer_id: int
    enquiry: Optional[str] = Field(None, max_length=120)
    valid_till: Optional[date] = None
    owner_id: Optional[int] = None
    custom_data: Optional[dict[str, Any]] = None
    deal_id: Optional[int] = None

    @field_validator("subject")
    @classmethod
    def _txt4(cls, v):
        return V.check_text(v, "Subject", 3, 500, required=True)

    @field_validator("enquiry")
    @classmethod
    def _txt5(cls, v):
        return V.check_text(v, "Enquiry reference", 0, 120, required=False)

    @field_validator("valid_till")
    @classmethod
    def _dates(cls, v, info):
        return V.check_date_range(v, info.field_name.replace("_", " ").capitalize())


@router.post("", status_code=201)
def create(body: QuoteIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    _need(db, cu, "quotations.create", "create quotes")
    body.custom_data = V.validate_module_custom_data(db, "quotations", body.custom_data)
    row = S.create(db, cu, request, subject=body.subject, customer_id=body.customer_id, enquiry=body.enquiry, valid_till=body.valid_till,
                   owner_id=body.owner_id, custom_data=body.custom_data, deal_id=body.deal_id)
    db.commit()
    return {"id": row.id, "ref": row.quotation_number}


@router.put("/{quote_id}")
def update(quote_id: int, body: QuoteIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    _need(db, cu, "quotations.update", "edit quotes")
    rows, prof, cur, _ = _ctx(db, cu, quote_id)
    if body.custom_data is not None:
        body.custom_data = V.validate_module_custom_data(db, "quotations", body.custom_data)
    S.update_header(db, cu, request, rows, prof, subject=body.subject, customer_id=body.customer_id, enquiry=body.enquiry, valid_till=body.valid_till,
                    owner_id=body.owner_id, custom_data=body.custom_data)
    db.commit()
    return {"id": S.root_id(rows)}


@router.post("/{quote_id}/duplicate", status_code=201)
def duplicate(quote_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    """Row menu → Duplicate (prototype dupRec)."""
    _need(db, cu, "quotations.create", "create quotes")
    new = S.duplicate(db, cu, request, S.get_group(db, cu, quote_id))
    db.commit()
    return {"id": new.id, "ref": new.quotation_number, "message": f"Duplicated as {new.quotation_number}"}


@router.delete("/{quote_id}")
def delete(quote_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    _need(db, cu, "quotations.delete", "delete quotes")
    rows = S.get_group(db, cu, quote_id)
    S.delete_quote(db, cu, request, rows)
    db.commit()
    return {"ok": True}


# ─── quote page ───────────────────────────────────────────────────────────────

@router.get("/{quote_id}")
def get_detail(quote_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    d = S.detail(db, cu, S.get_group(db, cu, quote_id))
    d["can"] = _can(db, cu)
    return d


class StageIn(BaseModel):
    stage_id: int
    reason: Optional[str] = Field(None, max_length=120)
    comment: Optional[str] = Field(None, max_length=1000)
    checklist: Optional[list[str]] = None


@router.post("/{quote_id}/stage")
def change_stage(quote_id: int, body: StageIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    _need(db, cu, "quotations.update", "move quotes")
    rows = S.get_group(db, cu, quote_id)
    return S.move(db, cu, request, rows, body.stage_id, reason=body.reason, comment=body.comment, checklist=body.checklist)


@router.post("/{quote_id}/send-for-approval")
def send_for_approval(quote_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    """Prototype qsend(): move to the approval-gated stage of the lifecycle (approval rules apply)."""
    _need(db, cu, "quotations.update", "send quotes for approval")
    rows, prof, cur, st = _ctx(db, cu, quote_id)
    nx = S.send_for_approval_target(st, cur)
    if not nx or nx["id"] == cur["id"] or [s["id"] for s in st].index(nx["id"]) < [s["id"] for s in st].index(cur["id"]):
        raise HTTPException(400, f"The quote is already past {nx['name'] if nx else 'the approval stage'}")
    return S.move(db, cu, request, rows, nx["id"])


class RevNoteIn(BaseModel):
    note: str = Field("", max_length=2000)


@router.post("/{quote_id}/revisions", status_code=201)
def new_revision(quote_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    _need(db, cu, "quotations.update", "revise quotes")
    rows, prof, cur, _ = _ctx(db, cu, quote_id)
    new = S.new_revision(db, cu, request, rows, prof)
    db.commit()
    return {"id": new.id, "n": len(rows), "message": f"Revision {len(rows)} created – Rev {len(rows) - 1} is now locked"}


@router.patch("/{quote_id}/revisions/{rev_id}/note")
def revision_note(quote_id: int, rev_id: int, body: RevNoteIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    _need(db, cu, "quotations.update", "edit quotes")
    rows, prof, cur, _ = _ctx(db, cu, quote_id)
    if rev_id != rows[-1].id:
        raise HTTPException(409, "Older revisions are locked – only the latest revision note can change")
    if prof.pending_stage_id:
        raise HTTPException(409, "Waiting for approval – the revision is locked")
    row = rows[-1]
    old, row.notes = row.notes, body.note.strip()
    S._log(db, cu, request, S.root_id(rows), row.quotation_number, "note", f"Rev {len(rows) - 1} note updated", old={"note": old}, new={"note": row.notes}, icon="📝")
    db.commit()
    return {"ok": True}


@router.get("/{quote_id}/compare")
def compare(quote_id: int, rev: int = Query(..., ge=1), db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    """Revision comparison (prototype "Δ vs prev"): line-by-line amount change of revision ``rev`` against ``rev - 1``."""
    rows = S.get_group(db, cu, quote_id)
    if rev >= len(rows):
        raise HTTPException(404, "Revision not found")
    li = S.lines_by_row(db, [rows[rev].id, rows[rev - 1].id])
    cur, prev = li.get(rows[rev].id, []), li.get(rows[rev - 1].id, [])
    out = []
    for i, x in enumerate(cur):
        a = float(S.line_amount(x))
        p = float(S.line_amount(prev[i])) if i < len(prev) else None
        out.append({"line_id": x.id, "amount": a, "prev": p, "delta": None if p is None else round(a - p, 2)})
    t1, t0 = S.totals(rows[rev], cur), S.totals(rows[rev - 1], prev)
    return {"rev": rev, "lines": out, "removed": max(0, len(prev) - len(cur)), "total": t1["total"], "prev_total": t0["total"],
            "pct": round((t1["total"] / t0["total"] - 1) * 100, 1) if t0["total"] else None}


class LineIn(BaseModel):
    description: Optional[str] = Field(None, max_length=500)
    qty: Optional[float] = None
    rate: Optional[float] = None
    disc: Optional[float] = None
    tax: Optional[float] = None
    product_id: Optional[int] = None
    price_book_id: Optional[int] = None


@router.post("/{quote_id}/revisions/{rev_id}/lines", status_code=201)
def add_line(quote_id: int, rev_id: int, body: LineIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    """Add line / From catalog (product_id: description, list price and GST % from Product & Price Books)."""
    _need(db, cu, "quotations.update", "edit quotes")
    rows, prof, cur, _ = _ctx(db, cu, quote_id)
    row = S.assert_editable(db, rows, prof, cur, rev_id)
    kw: dict[str, Any] = {}
    if body.product_id:
        p = next((x for x in S.catalog(db, "", body.price_book_id) if x["id"] == body.product_id), None)
        if not p:
            raise HTTPException(422, "That product is not available for quotes (it must be active and approved in Product & Price Books)")
        kw = {"description": p["name"], "rate": p["price"] if p["price"] is not None else (p["list"] or 0), "tax": p["gst"], "product_id": p["id"]}
    for k in ("description", "qty", "rate", "disc", "tax"):
        v = getattr(body, k)
        if v is not None:
            kw[k] = v
    li = S.add_line(db, row, **kw)
    S._log(db, cu, request, S.root_id(rows), row.quotation_number, "line_add", f"Rev {len(rows) - 1}: line added – {li.description}",
           new={"description": li.description, "product_id": li.product_id, "price_book_id": body.price_book_id}, icon="➕")
    warnings = S.price_checks(db, li.product_id, li.unit_price, getattr(li, "discount_percent", 0))
    db.commit()
    return {"id": li.id, "warnings": warnings}


@router.patch("/{quote_id}/revisions/{rev_id}/lines/{line_id}")
def edit_line(quote_id: int, rev_id: int, line_id: int, body: LineIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    _need(db, cu, "quotations.update", "edit quotes")
    rows, prof, cur, _ = _ctx(db, cu, quote_id)
    row = S.assert_editable(db, rows, prof, cur, rev_id)
    li = db.query(QuotationLineItem).filter(QuotationLineItem.id == line_id, QuotationLineItem.quotation_id == row.id).first()
    if not li:
        raise HTTPException(404, "Line not found")
    old, new = {}, {}
    for k, col in S.LINE_FIELDS.items():
        v = getattr(body, k)
        if v is None:
            continue
        nv = S._validate_line(db, col, v)
        ov = getattr(li, col)
        if str(ov) != str(nv):
            old[k], new[k] = str(ov), str(nv)
            setattr(li, col, nv)
    if new:
        S.recompute(db, row)
        S._log(db, cu, request, S.root_id(rows), row.quotation_number, "line_edit", f"Rev {len(rows) - 1}: line {li.description[:60]} – " + ", ".join(new),
               old=old, new=new, icon="✏️")
        db.commit()
    return {"ok": True, "warnings": S.price_checks(db, li.product_id, li.unit_price, getattr(li, "discount_percent", 0))}


@router.delete("/{quote_id}/revisions/{rev_id}/lines/{line_id}")
def delete_line(quote_id: int, rev_id: int, line_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    _need(db, cu, "quotations.update", "edit quotes")
    rows, prof, cur, _ = _ctx(db, cu, quote_id)
    row = S.assert_editable(db, rows, prof, cur, rev_id)
    li = db.query(QuotationLineItem).filter(QuotationLineItem.id == line_id, QuotationLineItem.quotation_id == row.id).first()
    if not li:
        raise HTTPException(404, "Line not found")
    desc = li.description
    db.delete(li)
    db.flush()
    S.recompute(db, row)
    S._log(db, cu, request, S.root_id(rows), row.quotation_number, "line_delete", f"Rev {len(rows) - 1}: line removed – {desc}", old={"description": desc}, icon="➖")
    db.commit()
    return {"ok": True}


class TermsIn(BaseModel):
    payment: Optional[str] = Field(None, max_length=1000)
    delivery: Optional[str] = Field(None, max_length=1000)
    warranty: Optional[str] = Field(None, max_length=1000)


@router.put("/{quote_id}/terms")
def save_terms(quote_id: int, body: TermsIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    """Quote-specific commercial terms (empty = the Settings → Quotes default)."""
    _need(db, cu, "quotations.update", "edit quotes")
    rows, prof, cur, _ = _ctx(db, cu, quote_id)
    if prof.pending_stage_id:
        raise HTTPException(409, "Waiting for approval – the quote is locked")
    if S.work_order_for(db, prof, rows):
        raise HTTPException(409, "A work order has been created from this quote")
    old = {"payment": prof.payment_terms, "delivery": prof.delivery_terms, "warranty": prof.warranty_terms}
    prof.payment_terms = (body.payment or "").strip() or None
    prof.delivery_terms = (body.delivery or "").strip() or None
    prof.warranty_terms = (body.warranty or "").strip() or None
    new = {"payment": prof.payment_terms, "delivery": prof.delivery_terms, "warranty": prof.warranty_terms}
    if old != new:
        S._log(db, cu, request, S.root_id(rows), rows[-1].quotation_number, "terms", "Commercial terms updated", old=old, new=new, icon="📃")
    db.commit()
    return {"ok": True}


# ─── PDF / documents ──────────────────────────────────────────────────────────

@router.get("/{quote_id}/pdf-data")
def pdf_data(quote_id: int, rev_id: Optional[int] = None, db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    return S.pdf_data(db, S.get_group(db, cu, quote_id), rev_id)


@router.post("/{quote_id}/revisions/{rev_id}/pdf", status_code=201)
async def upload_pdf(quote_id: int, rev_id: int, request: Request, file: UploadFile = File(...), db: Session = Depends(get_tenant_db),
                     cu: User = Depends(quote_user)):
    _need(db, cu, "document_management.create", "attach documents")
    rows = S.get_group(db, cu, quote_id)
    doc = S.store_pdf(db, cu, request, rows, rev_id, file.filename or "quotation.pdf", await file.read())
    db.commit()
    return doc


@router.get("/{quote_id}/documents")
def documents(quote_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    rows = S.get_group(db, cu, quote_id)
    if not user_has_permission(db, cu, "document_management.view"):
        return {"items": [], "allowed": False}
    return {"items": S.documents(db, rows), "allowed": True}


# ─── work order ───────────────────────────────────────────────────────────────

@router.post("/{quote_id}/work-order", status_code=201)
def work_order(quote_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    _need(db, cu, "quotations.update", "convert quotes")
    _need(db, cu, "workorders.create", "create work orders")
    rows = S.get_group(db, cu, quote_id)
    try:
        wo = S.create_work_order(db, cu, request, rows)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {"id": wo.id, "wo_number": wo.wo_number, "lead_id": wo.lead_id, "tender_id": wo.tender_id, "message": f"Work order created → {wo.wo_number}"}


# ─── bulk & import ────────────────────────────────────────────────────────────

class BulkIn(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=500)
    action: Literal["reassign", "delete"]
    value: Optional[str] = None


@router.post("/bulk")
def bulk(body: BulkIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    _need(db, cu, "quotations.delete" if body.action == "delete" else "quotations.update", "change these quotes")
    uid = None
    if body.action == "reassign":
        uid = int(body.value or 0)
        S.active_user(db, uid)
    who = db.query(User.full_name).filter(User.id == uid).scalar() if uid else None
    done, failed = 0, []
    for qid in dict.fromkeys(body.ids):
        try:
            rows = S.get_group(db, cu, qid)
            if body.action == "delete":
                S.delete_quote(db, cu, request, rows)
            else:
                latest = rows[-1]
                if S.owner_of(latest) != uid:
                    old = S.owner_of(latest)
                    latest.signatory_user_id = uid
                    S._log(db, cu, request, S.root_id(rows), latest.quotation_number, "reassign", f"Owner changed to {who}", old={"owner_id": old},
                           new={"owner_id": uid}, icon="👤")
                    S._notify(db, uid, "Quote assigned", f"{cu.full_name} assigned quote {latest.quotation_number} – {latest.subject} to you.", S.root_id(rows), "assigned")
            db.commit()
            done += 1
        except HTTPException as exc:
            db.rollback()
            failed.append({"id": qid, "error": detail_text(exc.detail, "Not allowed")})
    return {"done": done, "failed": failed}


IMPORT_COLUMNS = ["Subject", "Customer", "Enquiry reference", "Valid till (YYYY-MM-DD)", "Owner email"]


@router.get("/import/template")
def import_template(cu: User = Depends(quote_user)):
    return Response(",".join(IMPORT_COLUMNS) + "\n", media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="quotes-import-template.csv"'})


@router.post("/import")
async def import_quotes(request: Request, file: UploadFile = File(...), dry_run: bool = Query(False), db: Session = Depends(get_tenant_db),
                        cu: User = Depends(quote_user)):
    """Each row is matched to the masters by name (customer, owner e-mail) and created through the same validated path as
    the form (Rev 0 without lines). Same customer + subject already open, or repeated in the file → duplicate."""
    from app.routers.deals_router import authorized_customers
    _need(db, cu, "quotations.create", "import quotes")
    raw = (await file.read()).decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(raw))
    if not reader.fieldnames or "Subject" not in reader.fieldnames or "Customer" not in reader.fieldnames:
        raise HTTPException(422, "Use the import template (Subject, Customer, Enquiry reference, …)")
    custs = {c["customer_name"].strip().lower(): c["id"] for c in authorized_customers(db, cu)}
    users = {(u.email or "").strip().lower(): u.id for u in db.query(User).filter(User.is_active == True).all() if u.email}
    rows, _ = S.list_rows(db, cu)
    existing = {(r["customer_id"] or 0, r["subject"].strip().lower()) for r in rows if r["stage_kind"] == "open"}
    created, errors, dups, seen = 0, [], [], set()
    for i, row in enumerate(reader, start=2):
        g = lambda k: str(row.get(k) or "").strip()
        subj = g("Subject")
        try:
            if not subj:
                raise ValueError("Subject is empty")
            cid = custs.get(g("Customer").lower())
            if not cid:
                raise ValueError(f"Customer '{g('Customer')}' is not in your customers")
            key = (cid, subj.lower())
            if key in existing or key in seen:
                dups.append({"row": i, "name": subj, "error": "Duplicate – an open quote with this subject exists for the customer"})
                continue
            seen.add(key)
            vt = date.fromisoformat(g("Valid till (YYYY-MM-DD)")) if g("Valid till (YYYY-MM-DD)") else None
            owner = users.get(g("Owner email").lower()) if g("Owner email") else None
            if g("Owner email") and not owner:
                raise ValueError(f"No active user with e-mail {g('Owner email')}")
            if dry_run:
                S.authorized_customer(db, cu, cid)
            else:
                S.create(db, cu, request, subject=subj, customer_id=cid, enquiry=g("Enquiry reference") or None, valid_till=vt, owner_id=owner, custom_data=None)
                db.commit()
            created += 1
        except (ValueError, HTTPException) as exc:
            db.rollback()
            errors.append({"row": i, "name": subj, "error": exc.detail if isinstance(exc, HTTPException) else str(exc)})
    log_audit_db(db, cu.id, "quotations", "import", None, get_request_ip(request), f"Quotes import: {created} {'valid' if dry_run else 'created'}, "
                 f"{len(dups)} duplicates, {len(errors)} errors", new_data={"file": file.filename, "dry_run": dry_run}, record_name=file.filename)
    db.commit()
    return {"created": created, "dry_run": dry_run, "duplicates": dups, "errors": errors[:200], "error_count": len(errors), "duplicate_count": len(dups)}


# ─── configuration: Settings → Quotes and the quote lifecycle ────────────────

class ConfigIn(BaseModel):
    gst_percent: Optional[str] = None
    validity_days: Optional[str] = None
    max_discount: Optional[str] = None
    payment: Optional[str] = Field(None, max_length=1000)
    delivery: Optional[str] = Field(None, max_length=1000)
    warranty: Optional[str] = Field(None, max_length=1000)


@router.get("/config/settings")
def get_config(db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    return {**S.config(db), "can_configure": user_has_permission(db, cu, "settings.manage")}


@router.put("/config/settings")
def put_config(body: ConfigIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    _need(db, cu, "settings.manage", "change quote settings")
    before = S.config(db)
    after = S.save_config(db, cu, body.model_dump(exclude_unset=True))
    log_audit_db(db, cu.id, "settings", "quotes_config", None, get_request_ip(request), "Quote settings updated", old_data=before, new_data=after,
                 record_name="Settings → Quotes")
    db.commit()
    return after


@router.get("/config/stages")
def get_stages(db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    st = S.stages(db)
    counts = S.stage_counts(db)
    for s in st:
        s["quotes"] = counts.get(s["id"], 0)
    return {"items": st, "can_configure": user_has_permission(db, cu, "settings.manage")}


class StageCfg(BaseModel):
    id: Optional[int] = None
    name: str = Field(..., max_length=150)
    kind: Literal["open", "won", "lost"] = "open"
    sla: int = Field(0, ge=0, le=365)
    gate: Literal["None", "Approval", "Checklist"] = "None"
    owner_role: Optional[str] = None
    checklist: Optional[list[str]] = None


@router.put("/config/stages")
def put_stages(body: list[StageCfg], request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(quote_user)):
    _need(db, cu, "settings.manage", "configure the quote lifecycle")
    before = S.stages(db)
    S.save_stages(db, [s.model_dump() for s in body])
    log_audit_db(db, cu.id, "quotations", "lifecycle_update", None, get_request_ip(request), "Quote lifecycle updated", old_data={"stages": before},
                 new_data={"stages": [s.model_dump() for s in body]}, record_name="Quote lifecycle")
    db.commit()
    return {"items": S.stages(db)}
