"""Approvals (prototype v18 · Automation & Control → Approvals) over the existing approval stores:

  approvals            the legacy single-approver requests (Approval)
  approval_requests    the generic engine's multi-step requests (ApprovalRequest + steps)

* Rows are normalised to the v18 grid: Request · Purpose · What is being requested · Record · Customer · Value ·
  Requested by · Requested on · Waiting for · Approval chain · SLA · Priority · Status.
* Purpose (prototype apPurp) is derived on the server from the request's module / action (and, for deposits, the
  instrument type) – the frontend only renders the categories this service returns.
* SLA comes from the Process Designer stage policy that created the request (approval_request_meta.sla_hours), else
  the purpose default. Decisions are forwarded to the existing decide handlers, so routing, audit, notifications and
  every module callback (stage moves, Finance desk, product approvals …) stay exactly as they are.
* Stage gates: apply_stage_policy() makes the stage's policy (approver chain in order, value threshold, response
  SLA, auto-approve below threshold) govern the request created by Bids & Tenders, Deals, Quotes and Orders.
* Away: a new request step assigned to a user who is away is re-assigned to their delegate (after_request_created,
  called by the approval engine for every new request).
"""
from __future__ import annotations

import html
import logging
import re
import threading
from datetime import date, datetime, timedelta
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import bindparam, func, or_, text
from sqlalchemy.orm import Session, selectinload

from app.core.timezone import now_ist
from app.models.all_models import (EMDBG, ActivityLog, Approval, ApprovalRequest, ApprovalRequestStep, Customer, Lead, Quotation, Setting, Tender, User, WorkOrder)
from app.models.approvals360 import APPROVALS360_TABLES, ApprovalRequestMeta, ApprovalUserPref

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()

VIEWS = ["Pending on me", "Raised by me", "All pending", "Decided"]
PRIVILEGED = ("admin", "ceo")
MANAGERS = ("admin", "ceo", "manager", "vp")
DEFAULT_SLA = 24
# purpose key, label, icon, colour, why it needs approval, default SLA (h) – prototype APP / APD
PURPOSES = [
    ("tender", "Tender creation", "file", "#2F6DB5", "Bid / no-bid decision on a newly registered tender before the bid team starts work.", 24),
    ("deposit", "EMD & tender fee", "shield", "#B26B00", "Release of the earnest money or the tender document fee for a bid. On approval it moves to Finance to pay and enter the UTR.", 12),
    ("bg", "Bank guarantees", "card", "#7A4DB8", "Issue, extension or release of a bank guarantee against a bid or an order.", 24),
    ("customer", "Customer creation", "building", "#1B8559", "Onboarding a new customer – duplicate, GST and credit checks before the account becomes active.", 24),
    ("stage", "Stage approvals", "flow", "#0F6E8C", "Moving a record into a stage that has an approval gate in the Process Designer.", 24),
    ("pricing", "Pricing & discounts", "tag", "#B0447A", "Discounts or price revisions beyond the allowed limit.", 24),
    ("edit", "Edits & deletions", "edit", "#5C6978", "Changes to protected fields, or deletion of a record.", 24),
    ("convert", "Conversions", "git", "#3E63A8", "Converting a record into the next step of the sales flow.", 24),
    ("travel", "Travel & expense", "plane", "#6B7D2A", "A travel request or advance.", 24),
    ("order", "Order acceptance", "brief", "#C13B2A", "Accepting a customer purchase order.", 24),
    ("other", "Other", "more", "#5C6978", "A general approval request.", 24),
]
PURPOSE = {p[0]: p for p in PURPOSES}
QUICK_REMARKS = {"deposit": ["Funds available – pay before the deadline", "Reduce to the tender amount", "Use BG instead of cash"],
                 "tender": ["Go – strategic customer", "Eligibility gaps – clarify first", "No-go: low margin"],
                 "customer": ["GST and credit checks fine", "Share PAN and GST certificate", "Duplicate – use existing account"],
                 "other": ["Approved as per policy", "Please share more details", "Not within budget"]}
SORTS = {"sla": "SLA – most urgent first", "new": "Newest first", "val": "Highest value first", "old": "Oldest first"}
MODL = {"lead": "Leads", "leads": "Leads", "opportunity": "Deals", "opportunities": "Deals", "deal": "Deals", "tender": "Bids & Tenders", "tenders": "Bids & Tenders",
        "customer": "Customers", "customers": "Customers", "quotation": "Quotes", "quotations": "Quotes", "emdbg": "Guarantees & Deposits", "travel": "Travel & Expense",
        "tada": "Travel & Expense", "workorders": "Orders & Projects", "work_order": "Orders & Projects", "kam": "Field Sales 360", "document_management": "Document Hub",
        "product": "Product & Price Books", "price_book": "Product & Price Books", "forecast": "Forecasts"}
ROUTE = {"Leads": "/leads?open={id}", "Deals": "/opportunities?open={id}", "Bids & Tenders": "/tenders/{id}", "Customers": "/customers/{id}", "Quotes": "/quotations/{id}",
         "Guarantees & Deposits": "/emdbg?open={id}", "Travel & Expense": "/travel", "Orders & Projects": "/workorders?open={id}", "Product & Price Books": "/products/{id}"}


def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        for t in APPROVALS360_TABLES:
            t.create(bind=db.get_bind(), checkfirst=True)
        db.commit()
        _READY.add(slug)


def _label(action: str) -> str:
    a = (action or "").replace("_", " ").strip()
    for k, v in (("request 50l", "Deposit request"), ("request", "Request"), ("release", "Release"), ("extend", "Extension"), ("convert", "Conversion"), ("stage", "Stage move"),
                 ("create", "Create"), ("edit", "Edit"), ("delete", "Delete"), ("payment", "Payment"), ("price", "Price"), ("discount", "Discount"), ("override", "Price override"),
                 ("approve", "Approval"), ("change", "Change")):
        if k in a.lower():
            return v
    return (a[:1].upper() + a[1:]) or "Approval"


def purpose_of(module: str, action: str, rec: dict) -> str:
    """Prototype apPurp(): the purpose of a request from its module / action (+ the instrument type for deposits)."""
    m, a = (module or "").lower(), (action or "").lower()
    if m == "emdbg":
        if a in ("request", "request_50l"):
            return "deposit" if rec.get("itype") in ("EMD", "Tender fee") else "bg"
        return "bg"
    if "stage" in a:
        return "stage"
    if "convert" in a:
        return "convert"
    if m in ("tender", "tenders") and "create" in a:
        return "tender"
    if m in ("customer", "customers") and "create" in a:
        return "customer"
    if m in ("price_book",) or any(w in a for w in ("discount", "price", "revision", "override")) or (m in ("quotation", "quotations") and a == "submit"):
        return "pricing"
    if any(w in a for w in ("edit", "delete", "change", "update")) or (m == "product"):
        return "edit"
    if m in ("travel", "tada"):
        return "travel"
    if m in ("work_order", "workorders") and any(w in a for w in ("po", "accept", "order")):
        return "order"
    return "other"


def _prio(value: Optional[float], sla_left: Optional[int] = None) -> str:
    v = value or 0
    return "High" if v >= 5e6 or (sla_left is not None and sla_left < 0) else "Medium" if v >= 1e6 else "Low"


def _sla(created, status: str, hours: int) -> dict:
    if status != "Pending":
        return {"left": 10 ** 6, "txt": "—", "cls": "", "hours": hours, "due": None}
    if not created:
        return {"left": hours, "txt": f"Due in {hours} h", "cls": "", "hours": hours, "due": None}
    due = created + timedelta(hours=hours)
    left = round((due - now_ist()).total_seconds() / 3600)
    txt = f"Overdue {round(-left / 24)} d" if left < -48 else f"Overdue {-left} h" if left < 0 else f"Due in {round(left / 24)} d" if left > 48 else f"Due in {left} h"
    return {"left": left, "txt": txt, "cls": "tbad" if left < 0 else "twarn" if left <= 4 else "", "hours": hours, "due": due.isoformat()}


# ─── record lookups (one grouped query per module for the page) ───────────────

def _records(db: Session, module: str, ids: list[int]) -> dict[int, dict]:
    m = MODL.get(module, "")
    out: dict[int, dict] = {}
    if not ids:
        return out
    if m in ("Leads", "Deals"):
        for i, t, c, v, st, ref in db.query(Lead.id, Lead.lead_title, Customer.customer_name, Lead.est_value, Lead.status, Lead.lead_ref_id) \
                .outerjoin(Customer, Customer.id == Lead.customer_id).filter(Lead.id.in_(ids)).all():
            out[i] = {"label": t or ref or f"Lead #{i}", "ref": ref or f"LD-{i}", "cust": c or "", "value": float(v or 0), "stage": st or ""}
    elif m == "Bids & Tenders":
        for i, t, c, v, st, res, num in db.query(Tender.id, Tender.tender_title, Tender.customer_name, Tender.est_value, Tender.tender_status, Tender.result, Tender.tender_num) \
                .filter(Tender.id.in_(ids)).all():
            out[i] = {"label": t or num or f"Tender #{i}", "ref": num or f"TND-{i}", "cust": c or "", "value": float(v or 0), "stage": res if res in ("Won", "Lost") else (st or "")}
    elif m == "Customers":
        for i, n, st in db.query(Customer.id, Customer.customer_name, Customer.account_status).filter(Customer.id.in_(ids)).all():
            out[i] = {"label": n, "ref": f"CUS-{i}", "cust": n, "value": None, "stage": str(st or "")}
    elif m == "Quotes":
        for i, n, s, c, v, st in db.query(Quotation.id, Quotation.quotation_number, Quotation.subject, Customer.customer_name, Quotation.total_amount, Quotation.status) \
                .outerjoin(Customer, Customer.id == Quotation.customer_id).filter(Quotation.id.in_(ids)).all():
            out[i] = {"label": s or n, "ref": n, "cust": c or "", "value": float(v or 0), "stage": st or ""}
    elif m == "Guarantees & Deposits":
        for i, ref, c, v, st, it, tn in db.query(EMDBG.id, EMDBG.reference_num, EMDBG.client_name, EMDBG.amount, EMDBG.status, EMDBG.instrument_type, EMDBG.tender_num) \
                .filter(EMDBG.id.in_(ids)).all():
            out[i] = {"label": f"{it} {_inr(v)} for {tn or c or ref}", "ref": ref, "cust": c or "", "value": float(v or 0), "stage": str(st or ""), "itype": it}
    elif m == "Orders & Projects":
        for i, n, t, c, v, st in db.query(WorkOrder.id, WorkOrder.wo_number, WorkOrder.project_title, WorkOrder.customer_name, WorkOrder.wo_value, WorkOrder.status) \
                .filter(WorkOrder.id.in_(ids)).all():
            out[i] = {"label": t or n, "ref": n, "cust": c or "", "value": float(v or 0), "stage": str(st or "")}
    elif m == "Product & Price Books" and module == "product":
        for i, code, n, lp, st in db.execute(text("SELECT id, sku, name, list_price, record_status FROM products_master WHERE id IN :i").bindparams(
                bindparam("i", expanding=True)), {"i": ids}).all():
            out[i] = {"label": n, "ref": code or f"#{i}", "cust": "", "value": float(lp or 0), "stage": st or ""}
    return out


def _metas(db: Session, keys: list[str]) -> dict[str, ApprovalRequestMeta]:
    return {m.request_key: m for m in db.query(ApprovalRequestMeta).filter(ApprovalRequestMeta.request_key.in_(keys or ["-"])).all()}


def _enrich(db: Session, rows: list[dict]) -> None:
    by_mod: dict[str, set[int]] = {}
    for r in rows:
        by_mod.setdefault(r["_module"], set()).add(r["_rid"])
    cache = {m: _records(db, m, list(ids)) for m, ids in by_mod.items()}
    metas = _metas(db, [r["key"] for r in rows])
    for r in rows:
        rec = cache.get(r["_module"], {}).get(r["_rid"]) or {}
        meta = metas.get(r["key"])
        r["ref"] = rec.get("ref") or r["ref"]
        r["cust"] = rec.get("cust") or "—"
        r["value"] = float(meta.value) if meta is not None and meta.value is not None else rec.get("value")
        r["stage"] = rec.get("stage") or ""
        r["pp"] = purpose_of(r["_module"], r["_action"], rec)
        if meta is not None and (meta.from_stage or meta.to_stage):
            r["from"], r["to"] = meta.from_stage or r["stage"], meta.to_stage or ""
        r["title"] = r["title"] or (f"{r['type']} – {rec.get('label') or r['ref']}" + (f" → {r['to']}" if r.get("to") else ""))
        hours = (meta.sla_hours if meta is not None and meta.sla_hours else None) or PURPOSE[r["pp"]][5]
        r["sla"] = _sla(r["_created"], r["status"], hours)
        r["policy"] = (meta.policy if meta is not None else None) or ""
        r["escalated"] = bool(meta is not None and meta.escalation_status)
        r["info_open"] = bool(meta is not None and meta.info_open)
        r["priority"] = _prio(r["value"], r["sla"]["left"] if r["status"] == "Pending" else None)
        m = MODL.get(r["_module"], "")
        r["route"] = ROUTE.get(m, "").format(id=r["_rid"]) if m in ROUTE else None


# ─── normalised rows ──────────────────────────────────────────────────────────

def _status(s: Optional[str]) -> str:
    s = (s or "pending").lower()
    return {"pending": "Pending", "approved": "Approved", "rejected": "Rejected", "withdrawn": "Withdrawn", "skipped": "Skipped", "waiting": "Waiting"}.get(s, s.title())


def _legacy_row(a: Approval, users: dict[int, User]) -> dict:
    rq, ap = users.get(a.requested_by), users.get(a.requested_to)
    st = _status(a.status)
    chain = [{"step": 1, "user": ap.full_name if ap else "—", "user_id": a.requested_to, "role": (ap.role if ap else "") or "", "state": st,
              "date": a.decided_at.isoformat() if a.decided_at else None, "comment": a.decision_notes or a.rejection_reason or "", "current": st == "Pending"}]
    return {"key": f"a{a.id}", "id": f"APR-{a.id}", "src": "legacy", "type": _label(a.action), "title": a.record_ref or "", "_module": a.module, "_action": a.action or "",
            "_rid": int(a.record_id or 0), "_created": a.created_at, "module": MODL.get(a.module, (a.module or "").title()), "ref": a.record_ref or f"#{a.record_id}",
            "by": rq.full_name if rq else "—", "byRole": (rq.role if rq else "") or "", "by_id": a.requested_by, "req": a.created_at.isoformat() if a.created_at else None,
            "cur": ap.full_name if (ap and st == "Pending") else "—", "curRole": (ap.role if ap else "") or "", "cur_id": a.requested_to if st == "Pending" else None,
            "chain": chain, "status": st, "notes": a.request_notes or "", "decided": a.decided_at.isoformat() if a.decided_at else None, "from": "", "to": ""}


def _flow_row(r: ApprovalRequest) -> dict:
    st = _status(r.status)
    steps = sorted(r.steps or [], key=lambda s: s.step_no)
    cur = next((s for s in steps if s.step_no == r.current_step_no), None) if st == "Pending" else None
    chain = [{"step": s.step_no, "user": s.approver.full_name if s.approver else (s.approver_role or "—"), "user_id": s.approver_user_id,
              "role": (s.approver_role or (s.approver.role if s.approver else "") or "").replace("_", " ").title(),
              "state": ("Waiting" if st == "Pending" and s.step_no > r.current_step_no and (s.status or "pending") == "pending" else _status(s.status)),
              "date": s.acted_at.isoformat() if s.acted_at else None, "comment": s.remarks or "", "current": cur is not None and s.id == cur.id} for s in steps]
    return {"key": f"r{r.id}", "id": f"REQ-{r.id}", "src": "flow", "type": _label(r.action_key or ""), "title": "", "_module": r.module_key, "_action": r.action_key or "",
            "_rid": int(r.record_id or 0), "_created": r.requested_at, "module": MODL.get(r.module_key, (r.module_key or "").title()), "ref": f"#{r.record_id}",
            "by": r.requester.full_name if r.requester else "—", "byRole": (r.requester.role if r.requester else "") or "", "by_id": r.requested_by,
            "req": r.requested_at.isoformat() if r.requested_at else None,
            "cur": (cur.approver.full_name if cur.approver else cur.approver_role or "—") if cur else "—",
            "curRole": ((cur.approver_role or (cur.approver.role if cur.approver else "")) or "").replace("_", " ").title() if cur else "",
            "cur_id": cur.approver_user_id if cur else None, "chain": chain, "status": st, "notes": "",
            "decided": r.final_decided_at.isoformat() if r.final_decided_at else None, "from": "", "to": ""}


def _legacy_q(db: Session, cu: User, view: str):
    q = db.query(Approval)
    if view == "Pending on me":
        q = q.filter(Approval.requested_to == cu.id, Approval.status == "pending")
    elif view == "Raised by me":
        q = q.filter(Approval.requested_by == cu.id)
    elif view == "All pending":
        q = q.filter(Approval.status == "pending")
        if cu.role not in MANAGERS:
            q = q.filter(or_(Approval.requested_by == cu.id, Approval.requested_to == cu.id))
    else:
        q = q.filter(Approval.status != "pending")
        if cu.role not in PRIVILEGED:
            q = q.filter(or_(Approval.requested_by == cu.id, Approval.requested_to == cu.id))
    return q


def _flow_q(db: Session, cu: User, view: str):
    q = db.query(ApprovalRequest)
    mine = db.query(ApprovalRequestStep.approval_request_id).filter(ApprovalRequestStep.approver_user_id == cu.id)
    if view == "Pending on me":
        q = q.join(ApprovalRequestStep, ApprovalRequestStep.approval_request_id == ApprovalRequest.id).filter(
            ApprovalRequest.status == "pending", ApprovalRequestStep.step_no == ApprovalRequest.current_step_no, ApprovalRequestStep.approver_user_id == cu.id,
            ApprovalRequestStep.status == "pending")
    elif view == "Raised by me":
        q = q.filter(ApprovalRequest.requested_by == cu.id)
    elif view == "All pending":
        q = q.filter(ApprovalRequest.status == "pending")
        if cu.role not in MANAGERS:
            q = q.filter(or_(ApprovalRequest.requested_by == cu.id, ApprovalRequest.id.in_(mine)))
    else:
        q = q.filter(ApprovalRequest.status != "pending")
        if cu.role not in PRIVILEGED:
            q = q.filter(or_(ApprovalRequest.requested_by == cu.id, ApprovalRequest.id.in_(mine)))
    return q


def _all(db: Session, cu: User, view: str, cap: int = 3000) -> list[dict]:
    la = _legacy_q(db, cu, view).order_by(Approval.created_at.desc()).limit(cap).all()
    fa = _flow_q(db, cu, view).options(selectinload(ApprovalRequest.steps).selectinload(ApprovalRequestStep.approver), selectinload(ApprovalRequest.requester)) \
        .order_by(ApprovalRequest.requested_at.desc()).limit(cap).all()
    uids = {a.requested_by for a in la} | {a.requested_to for a in la}
    users = {u.id: u for u in db.query(User).filter(User.id.in_(list(uids))).all()} if uids else {}
    rows = [_legacy_row(a, users) for a in la] + [_flow_row(r) for r in fa]
    _enrich(db, rows)
    return rows


def _clean(r: dict) -> dict:
    return {k: v for k, v in r.items() if not k.startswith("_") or k in ("_module", "_rid")}


def _sorter(key: str):
    if key == "new":
        return lambda r: (r["req"] or ""), True
    if key == "val":
        return lambda r: (r["value"] or 0), True
    if key == "old":
        return lambda r: (r["req"] or ""), False
    return lambda r: (r["sla"]["left"], r["req"] or ""), False


def rows(db: Session, cu: User, *, view: str, q: str = "", purpose: str = "", status: str = "", priority: str = "", requester: Optional[int] = None,
         approver: Optional[int] = None, date_from: Optional[str] = None, date_to: Optional[str] = None, sla: str = "", decided_days: Optional[int] = None,
         sort: str = "sla", offset: int = 0, limit: int = 25, hide: Optional[list[str]] = None) -> dict:
    base = [r for r in _all(db, cu, view) if r["pp"] not in set(hide or [])]
    if decided_days:
        since = (now_ist() - timedelta(days=decided_days)).isoformat()
        base = [r for r in base if r["decided"] and r["decided"] >= since]
    if status:
        base = [r for r in base if r["status"] == status]
    dist = [{"k": k, "l": l, "i": i, "c": c, "n": sum(1 for r in base if r["pp"] == k)} for k, l, i, c, _, _ in PURPOSES]
    sel = [r for r in base if not purpose or r["pp"] == purpose]
    if q:
        ql = q.lower()
        sel = [r for r in sel if any(ql in str(r.get(k) or "").lower() for k in ("id", "title", "cust", "by", "ref", "cur"))]
    if priority:
        sel = [r for r in sel if r["priority"] == priority]
    if requester:
        sel = [r for r in sel if r["by_id"] == requester]
    if approver:
        sel = [r for r in sel if r["cur_id"] == approver]
    if date_from:
        sel = [r for r in sel if (r["req"] or "") >= date_from]
    if date_to:
        sel = [r for r in sel if (r["req"] or "")[:10] <= date_to]
    if sla == "overdue":
        sel = [r for r in sel if r["status"] == "Pending" and r["sla"]["left"] < 0]
    keyf, rev = _sorter(sort)
    sel.sort(key=keyf, reverse=rev)
    return {"items": [_clean(r) for r in sel[offset: offset + limit]], "total": len(sel), "base": len(base), "purposes": [d for d in dist if d["n"]]}


def kpis(db: Session, cu: User, hide: Optional[list[str]] = None) -> dict:
    hide_s = set(hide or [])
    pend = [r for r in _all(db, cu, "All pending") if r["pp"] not in hide_s]
    mine = [r for r in _all(db, cu, "Pending on me") if r["pp"] not in hide_s]
    since = (now_ist() - timedelta(days=30)).isoformat()
    dec = [r for r in _all(db, cu, "Decided") if r["pp"] not in hide_s and r["decided"] and r["decided"] >= since]
    hrs = [(datetime.fromisoformat(r["decided"]) - datetime.fromisoformat(r["req"])).total_seconds() / 3600 for r in dec if r["req"] and r["status"] in ("Approved", "Rejected")]
    return {"mine": len(mine), "pending": len(pend), "value": round(sum(r["value"] or 0 for r in pend), 2), "overdue": sum(1 for r in pend if r["sla"]["left"] < 0),
            "approved": sum(1 for r in dec if r["status"] == "Approved"), "rejected": sum(1 for r in dec if r["status"] == "Rejected"),
            "turnaround": round(sum(hrs) / len(hrs), 1) if hrs else None}


# ─── detail ───────────────────────────────────────────────────────────────────

def _find(db: Session, key: str):
    if key.startswith("a") and key[1:].isdigit():
        a = db.get(Approval, int(key[1:]))
        if a is None:
            raise HTTPException(404, "Approval not found")
        return "legacy", a
    if key.startswith("r") and key[1:].isdigit():
        r = db.query(ApprovalRequest).options(selectinload(ApprovalRequest.steps).selectinload(ApprovalRequestStep.approver), selectinload(ApprovalRequest.requester)) \
            .filter(ApprovalRequest.id == int(key[1:])).first()
        if r is None:
            raise HTTPException(404, "Approval not found")
        return "flow", r
    raise HTTPException(404, "Approval not found")


def _visible(kind: str, obj, cu: User) -> bool:
    if cu.role in PRIVILEGED:
        return True
    if kind == "legacy":
        return obj.requested_to == cu.id or obj.requested_by == cu.id or cu.role in MANAGERS
    return obj.requested_by == cu.id or any(s.approver_user_id == cu.id for s in obj.steps or []) or (cu.role in MANAGERS and obj.status == "pending")


def _kv(rows: list) -> list[list]:
    return [[k, v] for k, v in rows if v not in (None, "")]


def _inr(v: Any) -> str:
    """Indian digit grouping: ₹25,00,000."""
    n = round(float(v or 0))
    neg, n = n < 0, abs(n)
    t = str(n)
    if len(t) > 3:
        head, tail = t[:-3], t[-3:]
        head = ",".join([head[max(0, i - 2):i] for i in range(len(head), 0, -2)][::-1])
        t = f"{head},{tail}"
    return ("-" if neg else "") + "₹" + t


def _tender_block(db: Session, t: Tender, full: bool) -> list[dict]:
    from app.services import bid_service
    st = ""
    try:
        fl = bid_service.flows(db, include_inactive=True)
        _, cur = bid_service.sync(db, [t], fl)
        st = (cur.get(t.id) or {}).get("name", "")
    except Exception:
        db.rollback()
    owner = db.query(User.full_name).filter(User.id == t.assigned_to).scalar() if t.assigned_to else None
    portal = db.execute(text("SELECT name FROM lead_sources WHERE id = :i"), {"i": t.source_id}).scalar() if getattr(t, "source_id", None) else None
    prof = db.execute(text("SELECT c.name AS cat, o.name AS oem FROM bid_profiles p LEFT JOIN lead_categories c ON c.id = p.category_id LEFT JOIN oems o ON o.id = p.oem_id "
                           "WHERE p.tender_id = :t"), {"t": t.id}).mappings().first()
    secs = [{"t": "Tender", "i": "file", "kv": _kv([["Tender no.", t.portal_ref_number or t.tender_num], ["Customer", t.customer_name], ["Portal", portal],
                                                     ["Category", prof["cat"] if prof else None], ["Estimated value", _inr(t.est_value)], ["EMD", _inr(t.emd_amount)],
                                                     ["Tender fee", _inr(t.tender_fee_amount)], ["Submission", t.submission_date.isoformat() if t.submission_date else None],
                                                     ["Bid manager", owner], ["Stage", st], ["Location", t.site_loc], ["Principal OEM", prof["oem"] if prof else None]]),
             "link": {"t": f"Open tender {t.tender_num or t.id}", "to": f"/tenders/{t.id}"}}]
    if full:
        chk = []
        if t.submission_date:
            d = (t.submission_date - now_ist().date()).days
            chk.append(["ba" if d < 3 else "wa" if d < 8 else "ok", "Time to submit", "Deadline passed" if d < 0 else f"{d} days left"])
        el = db.execute(text("SELECT COUNT(*), SUM(ok) FROM bid_checklist_items WHERE tender_id = :t AND kind = 'eligibility'"), {"t": t.id}).first()
        if el and el[0]:
            chk.append(["ok" if int(el[1] or 0) == int(el[0]) else "wa", "Eligibility", f"{int(el[1] or 0)} of {int(el[0])} criteria met"])
        else:
            chk.append(["inf", "Eligibility", "No eligibility criteria recorded"])
        try:
            from app.services.instrument_service import dep_clear, ensure_schema as ens_ins
            ens_ins(db)
            g = dep_clear(db, t)
            chk.append(["ok" if g["ok"] else "wa", "EMD & tender fee", "Cleared" if g["ok"] else ", ".join(g["missing"])])
        except Exception:
            db.rollback()
        past = db.execute(text("SELECT COUNT(*), SUM(result = 'Won') FROM tenders WHERE customer_name = :c AND id <> :i AND (is_deleted = 0 OR is_deleted IS NULL)"),
                          {"c": t.customer_name or "", "i": t.id}).first()
        n, won = int(past[0] or 0), int(past[1] or 0)
        chk.append(["wa" if n and won / n < .3 else "ok", "History with customer", f"{n} earlier bids · {won} won" if n else "First bid with this customer"])
        comp = []
        try:
            comp = [r[0] for r in db.execute(text("SELECT DISTINCT competitor_name FROM tender_competitors WHERE tender_id = :t LIMIT 3"), {"t": t.id}).all() if r[0]]
        except Exception:
            db.rollback()
        chk.append(["wa" if comp else "inf", "Likely competition", ", ".join(comp) + " expected" if comp else "No competitor recorded"])
        secs.append({"t": "Bid readiness", "i": "check", "chk": chk})
    return secs


def _deposit_block(db: Session, e: EMDBG) -> tuple[str, list[dict]]:
    from app.models.instruments import InstrumentProfile
    p = db.query(InstrumentProfile).filter(InstrumentProfile.emdbg_id == e.id).first()
    refundable = e.instrument_type != "Tender fee"
    bg_types = ("BG", "Performance BG", "FDR", "Advance BG", "Retention BG")
    live = db.query(EMDBG).filter(EMDBG.status.in_(("Active", "Release Requested", "Received – ack pending", "Renewed")), EMDBG.instrument_type != "Tender fee").all()
    cust_out = sum(float(x.amount or 0) for x in live if x.client_name == e.client_name)
    bg_used = sum(float(x.amount or 0) for x in live if x.instrument_type in bg_types)
    lim = db.query(Setting.value).filter(Setting.key == "instrument_bg_limit").scalar()
    try:
        lim_v = float(lim) if lim not in (None, "") else None
    except ValueError:
        lim_v = None
    what = (f"Release <b>{_inr(e.amount)}</b> as {'the tender document fee' if e.instrument_type == 'Tender fee' else 'earnest money' if e.instrument_type == 'EMD' else html.escape(e.instrument_type)} "
            f"for <b>{html.escape(e.tender_num or e.po_number or e.client_name or '')}</b>. On approval it moves to the Finance desk to "
            + ("arrange the instrument." if e.instrument_type in bg_types or (p and p.mode and re.search(r"Bank guarantee|surety|FDR", p.mode)) else "pay and enter the UTR."))
    secs = [{"t": "Request details", "i": "shield", "kv": _kv([["Instrument", e.instrument_type], ["Amount", _inr(e.amount)], ["Mode of payment", p.mode if p else None],
                                                              ["Beneficiary", (p.beneficiary if p else None) or e.client_name], ["Payable at", p.payable_at if p else None],
                                                              ["Required by", p.required_by.isoformat() if p and p.required_by else None], ["Preferred bank", e.bank_name],
                                                              ["Refundable", "Yes – refund after result" if refundable else "No"], ["Remarks", e.notes]]),
             "link": {"t": f"Open {e.reference_num} in Guarantees & Deposits", "to": f"/emdbg?open={e.id}"}},
            {"t": "Funds position", "i": "card", "chk": [["ok", f"Outstanding with {(e.client_name or '')[:26]}", _inr(cust_out)],
                                                         (["ba" if bg_used / lim_v > .8 else "wa" if bg_used / lim_v > .6 else "ok", "BG limit used", f"{_inr(bg_used)} of {_inr(lim_v)} sanctioned"]
                                                          if lim_v else ["inf", "BG limit used", f"{_inr(bg_used)} · no sanctioned limit configured"]),
                                                         ["ok", "Outstanding across the company", _inr(sum(float(x.amount or 0) for x in live))]]}]
    if e.tender_id:
        t = db.get(Tender, e.tender_id)
        if t:
            secs += _tender_block(db, t, False)
    return what, secs


def _customer_block(db: Session, c: Customer) -> list[dict]:
    g = lambda k: getattr(c, k, None)  # noqa: E731
    kam = db.query(User.full_name).filter(User.id == g("assigned_to")).scalar() if g("assigned_to") else None
    gst = g("gstin") or g("gst_number") or ""
    first = (c.customer_name or "").split(" ")[0].lower()
    sim = [n for (n,) in db.query(Customer.customer_name).filter(Customer.id != c.id, func.lower(Customer.customer_name).like(f"{first}%")).limit(3).all()] if len(first) > 2 else []
    ok_gst = bool(re.fullmatch(r"\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z0-9]", gst or ""))
    lead = db.query(Lead.lead_ref_id).filter(Lead.customer_id == c.id).first()
    contacts = []
    try:
        contacts = [{"name": r[0], "role": r[1] or "", "phone": r[2] or "", "email": r[3] or ""} for r in db.execute(text(
            "SELECT contact_name, designation, phone, email FROM customer_contacts WHERE customer_id = :c LIMIT 6"), {"c": c.id}).all()]
    except Exception:
        db.rollback()
    return [{"t": "Customer details", "i": "building", "kv": _kv([["Customer name", c.customer_name], ["Type", g("customer_type")], ["Industry", g("industry")], ["GSTIN", gst],
                                                                 ["City / state", ", ".join(x for x in (g("city"), g("state")) if x)], ["Key account manager", kam],
                                                                 ["Tier", g("tier") or g("account_tier")], ["Email", g("email")], ["Phone", g("phone")],
                                                                 ["Proposed credit limit", _inr(g("credit_limit")) if g("credit_limit") else None], ["Payment terms", g("payment_terms")]]),
             "contacts": contacts, "link": {"t": f"Open {c.customer_name}", "to": f"/customers/{c.id}"}},
            {"t": "Onboarding checks", "i": "check", "chk": [["wa" if sim else "ok", "Duplicate check", ("Similar: " + ", ".join(sim[:2])) if sim else "No similar customer found"],
                                                            ["ok" if ok_gst else "wa", "GSTIN format", ("Valid format" if ok_gst else "Check format") if gst else "Not provided"],
                                                            ["inf", "Credit check", "No credit bureau integration – review the proposed limit"],
                                                            ["ok" if lead else "inf", "Source", f"Converted from lead {lead[0]}" if lead else "Created directly"]]}]


def _what(r: dict, rec_label: str) -> str:
    """'What happens on approval' – HTML with <b> only; every record value is escaped."""
    r = {**r, **{k: html.escape(str(r.get(k) or "")) for k in ("ref", "from", "to", "stage", "type")}}
    rec_label = html.escape(rec_label or "")
    if r.get("to"):
        return f"Move <b>{r['ref']}</b> from <b>{r.get('from') or r['stage'] or 'its current stage'}</b> to <b>{r['to']}</b>. If rejected it stays where it is."
    pp, a = r["pp"], r["_action"].lower()
    if pp == "tender":
        return f"Approve bidding for <b>{rec_label}</b>. The tender becomes active and the bid team can request the EMD and tender fee."
    if pp == "customer":
        return f"Activate <b>{rec_label}</b> as a customer. If rejected the account stays inactive."
    if pp == "pricing":
        return f"Apply the requested price / discount on <b>{r['ref']}</b>. If rejected the current price stays."
    if pp == "edit":
        return f"Apply the proposed change to <b>{r['ref']}</b>. If rejected, nothing changes."
    if pp == "convert":
        return f"Run the conversion for <b>{r['ref']}</b> and create the next record in the journey."
    if pp == "bg" and "release" in a:
        return f"Request the release / refund of <b>{r['ref']}</b> from the customer – it moves to Release Requested."
    if pp == "bg" and "extend" in a:
        return f"Extend the validity of <b>{r['ref']}</b> as requested."
    return f"{r['type']} for <b>{r['ref']}</b>."


def detail(db: Session, cu: User, key: str) -> dict:
    kind, obj = _find(db, key)
    if not _visible(kind, obj, cu):
        raise HTTPException(403, "Not authorised to view this approval")
    if kind == "legacy":
        users = {u.id: u for u in db.query(User).filter(User.id.in_([obj.requested_by, obj.requested_to])).all()}
        row = _legacy_row(obj, users)
        can = obj.requested_to == cu.id and obj.status == "pending"
    else:
        row = _flow_row(obj)
        can = bool(row["cur_id"]) and row["cur_id"] == cu.id
    _enrich(db, [row])
    meta = _metas(db, [key]).get(key)
    rec = _records(db, row["_module"], [row["_rid"]]).get(row["_rid"]) or {}
    m = MODL.get(row["_module"], "")
    what, secs = _what(row, rec.get("label") or row["ref"]), []
    try:
        if m == "Guarantees & Deposits" and row["pp"] in ("deposit", "bg") and row["_action"] in ("request", "request_50l"):
            e = db.get(EMDBG, row["_rid"])
            if e:
                what, secs = _deposit_block(db, e)
        elif m == "Guarantees & Deposits":
            e = db.get(EMDBG, row["_rid"])
            if e:
                secs = _deposit_block(db, e)[1]
        elif m == "Bids & Tenders":
            t = db.get(Tender, row["_rid"])
            if t:
                secs = _tender_block(db, t, row["pp"] in ("tender", "stage"))
        elif m == "Customers":
            c = db.get(Customer, row["_rid"])
            if c:
                secs = _customer_block(db, c)
        else:
            snap = _snapshot(db, row["_module"], row["_rid"])
            if snap:
                secs = [{"t": f"{m or 'Record'} details", "i": "file", "kv": snap, "link": {"t": f"Open {row['ref']}", "to": row["route"]} if row["route"] else None}]
    except Exception:
        db.rollback()
        logger.warning("approval detail sections for %s failed", key, exc_info=True)
    if meta is not None and meta.changes:
        secs.insert(0, {"t": "Proposed changes", "i": "edit", "diff": [[f, (v or [None, None])[0], (v or [None, None])[1]] for f, v in meta.changes.items()]})
    # activity: raised · steps · notes (delegate / escalate / info / answer)
    hist = [{"t": f"Request raised by {row['by']}", "d": row["req"], "by": row["by"]}]
    if kind == "flow":
        for s in sorted(obj.steps or [], key=lambda x: x.step_no):
            if s.acted_at:
                hist.append({"t": f"Step {s.step_no} {_status(s.status).lower()} by {s.approver.full_name if s.approver else s.approver_role or '—'}" + (f" – “{s.remarks}”" if s.remarks else ""),
                             "d": s.acted_at.isoformat(), "by": s.approver.full_name if s.approver else ""})
    elif obj.decided_at:
        hist.append({"t": f"{row['status']} by {row['chain'][0]['user']}" + (f" – “{obj.decision_notes or obj.rejection_reason}”" if (obj.decision_notes or obj.rejection_reason) else ""),
                     "d": row["decided"], "by": row["chain"][0]["user"]})
    acts = db.query(ActivityLog, User.full_name).outerjoin(User, User.id == ActivityLog.user_id).filter(ActivityLog.module == "approvals360", ActivityLog.record_id == obj.id,
                                                                                                        ActivityLog.action == kind).order_by(ActivityLog.created_at).all()
    hist += [{"t": a.description, "d": a.created_at.isoformat() if a.created_at else None, "by": n or "System"} for a, n in acts]
    hist.sort(key=lambda h: h["d"] or "")
    pf = prefs(db, cu)
    done = sum(1 for c in row["chain"] if c["state"] == "Approved")
    out = _clean(row)
    pmeta = PURPOSE[row["pp"]]
    out.update({"purpose": {"k": pmeta[0], "l": pmeta[1], "i": pmeta[2], "c": pmeta[3], "why": pmeta[4]}, "what": what, "sections": secs, "history": hist,
                "step": {"done": done, "of": len(row["chain"])}, "company": _company(db), "source": "Process Designer stage gate" if row["to"] else MODL.get(row["_module"], "Approvals"),
                "policy": (meta.policy if meta is not None and meta.policy else ("Process Designer stage gate" if row["to"] else f"{MODL.get(row['_module'], 'Module')} approval rule")),
                "info": {"open": bool(meta is not None and meta.info_open), "question": meta.info_question if meta is not None else None},
                "escalation": {"status": meta.escalation_status if meta is not None else None, "at": meta.escalated_at.isoformat() if meta is not None and meta.escalated_at else None},
                "can_decide": can and not (row["by_id"] == cu.id and not _self_ok(db)), "can_delegate": (can or cu.role in PRIVILEGED) and row["status"] == "Pending",
                "can_escalate": row["status"] == "Pending" and (can or row["by_id"] == cu.id or cu.role in MANAGERS),
                "can_answer": row["status"] == "Pending" and row["by_id"] == cu.id and bool(meta is not None and meta.info_open),
                "self_blocked": can and row["by_id"] == cu.id and not _self_ok(db),
                "quick_remarks": pf.get("remarks") or QUICK_REMARKS.get(row["pp"], QUICK_REMARKS["other"])})
    return out


def _company(db: Session) -> str:
    try:
        from app.services.quote_service import tenant_info
        return tenant_info(db)["name"] or ""
    except Exception:
        return ""


def _snapshot(db: Session, module: str, rid: int) -> list[list[str]]:
    m = MODL.get(module, "")
    rec = _records(db, module, [rid]).get(rid) or {}
    if m in ("Leads", "Deals"):
        l = db.get(Lead, rid)
        return _kv([["Title", l.lead_title], ["Customer", rec.get("cust")], ["Expected value", _inr(l.est_value)], ["Stage", l.status]]) if l else []
    if m == "Quotes":
        q = db.get(Quotation, rid)
        return _kv([["Quotation", q.quotation_number], ["Subject", q.subject], ["Customer", rec.get("cust")], ["Total", _inr(q.total_amount)], ["Status", q.status]]) if q else []
    if m == "Orders & Projects":
        w = db.get(WorkOrder, rid)
        return _kv([["Work order", w.wo_number], ["Work", w.project_title], ["Customer", w.customer_name], ["PO", w.po_number], ["Value", _inr(w.wo_value)],
                    ["Status", str(w.status or "")]]) if w else []
    if rec:
        return _kv([["Record", rec.get("ref")], ["Description", rec.get("label")], ["Value", _inr(rec["value"]) if rec.get("value") else None], ["Status", rec.get("stage")]])
    return []


# ─── actions ──────────────────────────────────────────────────────────────────

def _self_ok(db: Session) -> bool:
    v = db.query(Setting.value).filter(Setting.key == "approvals_allow_self_approval").scalar()
    return str(v or "").lower() in ("1", "true", "yes", "on")


def _current_approver(kind: str, obj) -> Optional[int]:
    if kind == "legacy":
        return obj.requested_to if obj.status == "pending" else None
    cur = next((s for s in obj.steps or [] if s.step_no == obj.current_step_no), None)
    return cur.approver_user_id if cur is not None and obj.status == "pending" else None


def decide(db: Session, cu: User, request, key: str, decision: str, remarks: str) -> None:
    kind, obj = _find(db, key)
    if decision not in ("approved", "rejected"):
        raise HTTPException(422, "decision must be approved or rejected")
    if decision == "rejected" and not (remarks or "").strip():
        raise HTTPException(422, "A remark is required to reject")
    if (obj.status or "").lower() != "pending":
        raise HTTPException(409, "This request has already been decided")
    if _current_approver(kind, obj) != cu.id:
        raise HTTPException(403, "Only the current approver can decide this request")
    if obj.requested_by == cu.id and not _self_ok(db):
        raise HTTPException(403, "You cannot approve your own request – delegate it to another approver")
    if kind == "legacy":
        from app.routers.approvals_router import DecideIn, decide_approval
        decide_approval(obj.id, DecideIn(decision=decision, notes=remarks or None, rejection_reason=remarks or None), request, db, cu)
    else:
        from app.routers.approval_workflow_router import ApprovalDecisionInput, decide_approval_request
        decide_approval_request(obj.id, ApprovalDecisionInput(decision=decision, remarks=remarks or ""), db, cu)
    meta = _meta(db, key, create=False)
    if meta is not None and meta.info_open:
        meta.info_open = False
        db.commit()


def _note(db: Session, cu: Optional[User], kind: str, rid: int, text_: str) -> None:
    db.add(ActivityLog(user_id=cu.id if cu else None, module="approvals360", record_id=rid, action=kind, description=text_[:1000], icon="📝"))


def _meta(db: Session, key: str, create: bool = True) -> Optional[ApprovalRequestMeta]:
    m = db.query(ApprovalRequestMeta).filter(ApprovalRequestMeta.request_key == key).first()
    if m is None and create:
        m = ApprovalRequestMeta(request_key=key)
        db.add(m)
        db.flush()
    return m


def notify(db: Session, uid: Optional[int], title: str, msg: str, key: str, action: str) -> None:
    """In-app / email per the user's Inbox delivery preference for approvals (WhatsApp has no sender configured)."""
    if not uid:
        return
    try:
        from app.services.inbox_service import delivery_channels_for
        app_on, mail_on = delivery_channels_for(db, uid, module="approvals", action=action, title=title, message=msg, category="approval")
        if not app_on and not mail_on:
            return
        from app.services.notification_service import upsert_notification
        upsert_notification(db, uid, title, msg, module="approvals", action=action, action_url=f"/approvals?open={key}", send_email=mail_on)
    except Exception as exc:
        logger.warning("approval notification failed: %s", exc)


def delegate(db: Session, cu: User, key: str, user_id: int, remarks: str, until: Optional[str] = None, action: str = "Delegated") -> dict:
    kind, obj = _find(db, key)
    target = db.query(User).filter(User.id == user_id, User.is_active.is_(True)).first()
    if target is None:
        raise HTTPException(404, "User not found")
    if (obj.status or "").lower() != "pending":
        raise HTTPException(409, "Already decided")
    cur_id = _current_approver(kind, obj)
    if action == "Delegated" and cur_id != cu.id and cu.role not in PRIVILEGED:
        raise HTTPException(403, "Only the current approver can delegate")
    if target.id == obj.requested_by:
        raise HTTPException(422, "The request cannot be delegated to its requester")
    if target.id == cur_id:
        raise HTTPException(422, f"{target.full_name} is already the approver")
    orig = db.get(User, cur_id) if cur_id else None
    if kind == "legacy":
        obj.requested_to = target.id
    else:
        cur = next((s for s in obj.steps if s.step_no == obj.current_step_no), None)
        cur.approver_user_id = target.id
        cur.resolved_from = action.lower()
        obj.approver_user_ids = [target.id if i == cur_id else i for i in list(obj.approver_user_ids or [])] or [target.id]
    _note(db, cu, kind, obj.id, f"{action} from {orig.full_name if orig else '—'} to {target.full_name}" + (f" until {until}" if until else "") + (f": {remarks}" if remarks else ""))
    notify(db, target.id, f"Approval {action.lower()} to you", f"{cu.full_name} {action.lower()} an approval to you" + (f": {remarks}" if remarks else "."), key, action.lower())
    db.commit()
    return {"to": target.full_name}


def escalate(db: Session, cu: User, key: str, remarks: str) -> dict:
    kind, obj = _find(db, key)
    if (obj.status or "").lower() != "pending":
        raise HTTPException(409, "Already decided")
    cur_id = _current_approver(kind, obj)
    if not (cur_id == cu.id or obj.requested_by == cu.id or cu.role in MANAGERS):
        raise HTTPException(403, "Only the approver, the requester or a manager can escalate")
    cur = db.get(User, cur_id) if cur_id else None
    to = db.get(User, cur.reporting_manager_id) if cur and cur.reporting_manager_id else None
    if to is None or not to.is_active:
        raise HTTPException(409, "The current approver has no reporting manager to escalate to (Users & Teams → reporting manager)")
    res = delegate(db, cu, key, to.id, remarks, action="Escalated")
    meta = _meta(db, key)
    meta.escalation_status, meta.escalated_to, meta.escalated_at, meta.escalation_reason = "escalated", to.id, now_ist(), (remarks or "")[:2000] or None
    db.commit()
    return res


def ask_info(db: Session, cu: User, key: str, question: str) -> dict:
    kind, obj = _find(db, key)
    question = (question or "").strip()
    if not question:
        raise HTTPException(422, "Write the question first")
    if (obj.status or "").lower() != "pending":
        raise HTTPException(409, "Already decided")
    if _current_approver(kind, obj) != cu.id and cu.role not in PRIVILEGED:
        raise HTTPException(403, "Only the current approver can ask for information")
    meta = _meta(db, key)
    meta.info_open, meta.info_question, meta.info_asked_by, meta.info_asked_at = True, question[:2000], cu.id, now_ist()
    _note(db, cu, kind, obj.id, f"Information requested by {cu.full_name}: {question}")
    notify(db, obj.requested_by, "Approval needs information", f"{cu.full_name} asked: {question[:300]}", key, "info_requested")
    db.commit()
    return {"ok": True}


def answer_info(db: Session, cu: User, key: str, answer: str) -> dict:
    kind, obj = _find(db, key)
    answer = (answer or "").strip()
    if not answer:
        raise HTTPException(422, "Write your answer first")
    if obj.requested_by != cu.id:
        raise HTTPException(403, "Only the requester can answer")
    meta = _meta(db, key, create=False)
    if meta is None or not meta.info_open:
        raise HTTPException(409, "No information is requested on this approval")
    meta.info_open = False
    _note(db, cu, kind, obj.id, f"Information submitted by {cu.full_name}: {answer}")
    notify(db, meta.info_asked_by or _current_approver(kind, obj), "Information submitted", f"{cu.full_name} answered: {answer[:300]}", key, "info_submitted")
    db.commit()
    return {"ok": True}


def people(db: Session) -> list[dict]:
    return [{"id": u.id, "name": u.full_name, "role": u.role or ""} for u in db.query(User).filter(User.is_active.is_(True)).order_by(User.full_name).limit(500).all()]


# ─── My approval preferences ──────────────────────────────────────────────────

DEFAULT_PREFS = {"tab": "Pending on me", "sort": "sla", "cat": "all", "next": "next", "hide": [], "away": False, "away_to": None, "away_till": None, "remarks": []}


def prefs(db: Session, cu: User) -> dict:
    row = db.get(ApprovalUserPref, cu.id)
    return {**DEFAULT_PREFS, **(row.data if row and isinstance(row.data, dict) else {})}


def notify_prefs(db: Session, cu: User) -> dict:
    from app.services.inbox_service import get_delivery_prefs
    d = {p["key"]: p for p in get_delivery_prefs(db, cu.id)}
    ap, dg = d.get("approvals") or {}, d.get("daily_digest") or {}
    ch = ap.get("channels") or [] if ap.get("enabled", True) else []
    return {"app": "app" in ch, "email": "email" in ch, "digest": bool(dg.get("enabled")) and dg.get("digest_time") == "09:00", "digest_time": dg.get("digest_time"),
            "whatsapp": False, "whatsapp_available": False}


def save_prefs(db: Session, cu: User, body: dict) -> dict:
    out = dict(DEFAULT_PREFS)
    if body.get("tab") in VIEWS:
        out["tab"] = body["tab"]
    if body.get("sort") in SORTS:
        out["sort"] = body["sort"]
    if body.get("cat") == "all" or body.get("cat") in PURPOSE:
        out["cat"] = body["cat"]
    out["next"] = "close" if body.get("next") == "close" else "next"
    out["hide"] = [k for k in body.get("hide") or [] if k in PURPOSE]
    if len(out["hide"]) == len(PURPOSES):
        raise HTTPException(422, "Keep at least one purpose visible")
    out["remarks"] = [str(x).strip()[:200] for x in body.get("remarks") or [] if str(x).strip()][:12]
    out["away"] = bool(body.get("away"))
    if out["away"]:
        to = body.get("away_to")
        u = db.query(User).filter(User.id == int(to or 0), User.is_active.is_(True)).first() if to else None
        if not u or u.id == cu.id:
            raise HTTPException(422, "Choose another active user to delegate to while you are away")
        till = str(body.get("away_till") or "")[:10]
        try:
            if date.fromisoformat(till) < now_ist().date():
                raise ValueError
        except ValueError:
            raise HTTPException(422, "Choose an 'until' date from today")
        out["away_to"], out["away_till"] = u.id, till
    row = db.get(ApprovalUserPref, cu.id)
    if row is None:
        db.add(ApprovalUserPref(user_id=cu.id, data=out))
    else:
        row.data = out
    # notification channels → Inbox & Notifications delivery preferences (the user's own rows only)
    n = body.get("notify") or {}
    if n:
        from app.models.inbox import NotificationDeliveryPreference as NDP
        r = db.query(NDP).filter(NDP.user_id == cu.id, NDP.pref_key == "approvals").first() or NDP(user_id=cu.id, pref_key="approvals")
        ch = [c for c, on in (("app", n.get("app")), ("email", n.get("email"))) if on]
        r.enabled, r.channels = bool(ch), ch or ["app"]
        db.add(r)
        if n.get("digest") is not None:
            d = db.query(NDP).filter(NDP.user_id == cu.id, NDP.pref_key == "daily_digest").first() or NDP(user_id=cu.id, pref_key="daily_digest", channels=["email"])
            d.enabled = bool(n.get("digest"))
            if n.get("digest"):
                d.digest_time = "09:00"
            db.add(d)
    db.commit()
    return {**prefs(db, cu), "notify": notify_prefs(db, cu)}


def reset_prefs(db: Session, cu: User) -> dict:
    row = db.get(ApprovalUserPref, cu.id)
    if row is not None:
        db.delete(row)
        db.commit()
    return {**DEFAULT_PREFS, "notify": notify_prefs(db, cu)}


# ─── engine hooks: away delegation · Process Designer stage policies ─────────

def after_request_created(db: Session, req: ApprovalRequest) -> None:
    """Called by the approval engine for every new request: re-assign a pending step whose approver is away."""
    if (req.status or "").lower() != "pending":
        return
    # Runs inside the caller's open transaction (e.g. creating a customer): create our tables on the engine's own
    # connection and never commit the caller's half-saved record from here.
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug not in _READY:
        with _LOCK:
            if slug not in _READY:
                for t in APPROVALS360_TABLES:
                    t.create(bind=db.get_bind().engine if hasattr(db.get_bind(), "engine") else db.get_bind(), checkfirst=True)
                _READY.add(slug)
    today = now_ist().date().isoformat()
    for s in req.steps or []:
        if (s.status or "pending") != "pending" or not s.approver_user_id:
            continue
        p = db.get(ApprovalUserPref, s.approver_user_id)
        d = p.data if p and isinstance(p.data, dict) else {}
        if not d.get("away") or not d.get("away_to") or (d.get("away_till") or "") < today:
            continue
        to = db.query(User).filter(User.id == int(d["away_to"]), User.is_active.is_(True)).first()
        if not to or to.id == req.requested_by:
            continue
        frm = s.approver_user_id
        s.approver_user_id, s.resolved_from = to.id, "away_delegate"
        req.approver_user_ids = [to.id if i == frm else i for i in list(req.approver_user_ids or [])] or [to.id]
        who = db.query(User.full_name).filter(User.id == frm).scalar() or "approver"
        db.add(ActivityLog(user_id=None, module="approvals360", record_id=req.id, action="flow", description=f"{who} is away until {d['away_till']} – step {s.step_no} delegated to {to.full_name}", icon="📝"))
    db.flush()


def _policy_for(db: Session, flow_key: Optional[str], to_stage: str, from_stage: Optional[str]) -> Optional[dict]:
    from app.services.process_service import overview
    try:
        flows = overview(db, "")["flows"]
    except Exception:
        db.rollback()
        logger.warning("process designer overview failed", exc_info=True)
        return None
    def hit(f):  # noqa: E306
        return next((s for s in f["stages"] if s["name"] == to_stage and s.get("gate") == "Approval"), None)
    cands = [f for f in flows if f.get("key") == flow_key] + [f for f in flows if from_stage and any(s["name"] == from_stage for s in f["stages"])] + flows
    for f in cands:
        s = hit(f)
        if s is not None:
            a = s.get("appr") or {"chain": [s.get("owner_role") or "Sales Head"], "min": 0, "sla": 24, "auto": True}
            return {**a, "flow": f.get("label") or f.get("key"), "stage": s["name"], "explicit": bool(s.get("appr"))}
    return None


def _user_for_role(db: Session, role: str, exclude: int) -> Optional[User]:
    want = re.sub(r"[^a-z]", "", (role or "").lower())
    for u in db.query(User).filter(User.is_active.is_(True), User.id != exclude).order_by(User.id).all():
        if re.sub(r"[^a-z]", "", (u.role or "").lower()) == want or re.sub(r"[^a-z]", "", (getattr(u, "designation", "") or "").lower()) == want:
            return u
    return None


def apply_stage_policy(db: Session, req: ApprovalRequest, flow_key: Optional[str], to_stage: str, from_stage: Optional[str], value: float) -> ApprovalRequest:
    """Process Designer → stage approval policy on a stage-gate request: below the value threshold the request is
    auto-approved (when the policy says so); otherwise the configured approver chain (in order, one user per role)
    replaces the engine's default routing and the response SLA is stored for SLA tracking. Never raises."""
    try:
        ensure_schema(db)
        key = f"r{req.id}"
        pol = _policy_for(db, flow_key, to_stage, from_stage)
        meta = _meta(db, key)
        meta.from_stage, meta.to_stage, meta.value = (from_stage or "")[:150] or None, to_stage[:150], value or 0
        if pol is None:
            db.flush()
            return req
        meta.policy, meta.sla_hours, meta.threshold = f"{pol['flow']} · {pol['stage']}"[:200], int(pol.get("sla") or DEFAULT_SLA), pol.get("min") or 0
        if (req.status or "").lower() != "pending":
            db.flush()
            return req
        if pol.get("min") and (value or 0) < float(pol["min"]) and pol.get("auto", True):
            req.status, req.final_decided_at = "approved", now_ist()
            for s in req.steps or []:
                if (s.status or "pending") == "pending":
                    s.status, s.remarks, s.acted_at = "skipped", f"Auto-approved – value below the {_inr(pol['min'])} threshold", now_ist()
            db.add(ActivityLog(user_id=None, module="approvals360", record_id=req.id, action="flow",
                               description=f"Auto-approved – value {_inr(value)} is below the policy threshold {_inr(pol['min'])}", icon="📝"))
            db.flush()
            return req
        if pol.get("explicit"):
            users = []
            for role in pol["chain"]:
                u = _user_for_role(db, role, req.requested_by)
                if u is None or u.id in [x[1].id for x in users]:
                    continue
                users.append((role, u))
            if users:
                for s in list(req.steps or []):
                    db.delete(s)
                db.flush()
                for i, (role, u) in enumerate(users, start=1):
                    db.add(ApprovalRequestStep(approval_request_id=req.id, step_no=i, approver_user_id=u.id, approver_role=role, status="pending"))
                req.current_step_no, req.approver_user_ids, req.approval_mode = 1, [u.id for _, u in users], "sequential"
                db.flush()
                db.refresh(req)
        after_request_created(db, req)
        db.flush()
    except Exception:
        logger.warning("stage policy for approval request %s not applied", getattr(req, "id", None), exc_info=True)
    return req
