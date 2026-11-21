"""Travel & Expense (prototype v17 · Finance & Field → Travel & Expense) – Requests list, trip drawer (Itinerary & expenses),
Expense claims and the Upcoming & ongoing trips calendar, on the existing travel / TA-DA records.

* Trips        – travel_requests. Data visibility = Roles & Security travel data scope (travel_router._scope_user_ids);
                 approvers on a trip's chain keep access (travel_router._ensure_travel_record_access).
* Status shown – Draft · Pending (Submitted) · Approved · Completed · Rejected · Cancelled. The Requests filter offers the
                 prototype's Pending / Approved / Completed; Pending covers Draft + Submitted (not yet approved).
* Expenses     – tada_line_items on the trip's TA/DA claim (one open claim per trip, created by the first "Add expense").
                 Only the traveller adds expenses, only while the trip is Approved / Completed and the claim is Draft or
                 returned (Rejected). Receipts go through the existing TA/DA attachment upload (Document Hub lists them).
* Claim        – submitted with the existing TA/DA submission (manager → CEO → accounts chain, Approvals inbox,
                 notifications). Claim column: Draft · Pending (in the chain) · Approved (Accounts Approved / Paid) ·
                 Rejected (returned for correction – the traveller fixes and resubmits). Never derived from the trip status.
* Advances     – requested = travel_requests.advance_amount; issued = Σ disbursed − Σ refunded (travel_advance_txns);
                 adjusted = min(issued, claimed) once the claim is Accounts Approved / Paid; outstanding = issued − adjusted.
* Money        – Decimal throughout; floats only in the JSON response.
"""
from __future__ import annotations

import logging
import threading
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Iterable, Optional

from fastapi import HTTPException, Request
from sqlalchemy import func, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.timezone import now_ist, today_ist
from app.dependencies import user_has_permission
from app.models.all_models import (ActivityLog, Approval, ApprovalRequest, TADAAttachment, TADAClaim, TADALineItem, TravelRequest, User)
from app.models.travel_expense import ADVANCE_KINDS, TRAVEL_EXPENSE_TABLES, TravelAdvanceTxn, TravelTripNote

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()
CENT = Decimal("0.01")
MAX_AMOUNT = Decimal("100000000")              # ₹ 10 Cr per entry – anything above is a typing error
MAX_RECEIPT_MB = 10

MODES = ["Flight", "Train", "Car"]             # prototype form options
MODE_TO_DB = {"Flight": "Air", "Train": "Train", "Car": "Car (Company)"}
DB_TO_MODE = {"Air": "Flight", "Train": "Train", "Car (Company)": "Car", "Car (Personal)": "Car"}
HEADS = ["Transport Fare", "Auto/Cab", "Fuel", "Accommodation", "Meals", "Daily Allowance", "Communication", "Toll/Parking",
         "Visa/Passport", "Miscellaneous"]      # tada_line_items.category
STATUS_SHOWN = {"Draft": "Draft", "Submitted": "Pending", "Approved": "Approved", "Completed": "Completed",
                "Rejected": "Rejected", "Cancelled": "Cancelled"}
FILTER = {"Pending": ("Draft", "Submitted"), "Approved": ("Approved",), "Completed": ("Completed",)}
CLAIM_PENDING = ("Submitted", "Manager Approved", "CEO Approved")
CLAIM_APPROVED = ("Accounts Approved", "Paid")
CLAIM_OPEN = ("Draft", "Rejected")
VIEWS = ["All", "Upcoming", "Mine"]
FINANCE_ROLES = ("accounts", "admin", "ceo")   # same roles the existing accounts decision accepts


# ─── schema ───────────────────────────────────────────────────────────────────

def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        bind = db.get_bind()
        for t in TRAVEL_EXPENSE_TABLES:
            t.create(bind=bind, checkfirst=True)
        db.commit()
        _READY.add(slug)


def ensure_schema_all_tenants() -> None:
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant
    m = MasterSessionLocal()
    try:
        slugs = [t.slug for t in m.query(Tenant).all()]
    finally:
        m.close()
    for slug in slugs:
        try:
            db = get_tenant_session(slug)
        except Exception as exc:
            logger.warning("travel & expense schema: tenant %s unavailable: %s", slug, exc)
            continue
        try:
            db.info["tenant_slug"] = slug
            ensure_schema(db)
        except Exception as exc:
            logger.warning("travel & expense schema for %s failed: %s", slug, exc)
            db.rollback()
        finally:
            db.close()


# ─── helpers ──────────────────────────────────────────────────────────────────

def d(v: Any) -> Decimal:
    if v is None or v == "":
        return Decimal(0)
    return v if isinstance(v, Decimal) else Decimal(str(v))


def money(v: Any, what: str, *, positive: bool = False) -> Decimal:
    """Parse a rupee amount: numeric, finite, at most 2 decimals, ≥ 0 (> 0 when positive), ≤ MAX_AMOUNT."""
    try:
        x = Decimal(str(v).strip())
    except (InvalidOperation, ValueError, TypeError):
        raise HTTPException(422, f"{what} must be a number")
    if not x.is_finite():
        raise HTTPException(422, f"{what} must be a number")
    if x.as_tuple().exponent < -2:
        raise HTTPException(422, f"{what} can have at most 2 decimal places")
    if x < 0 or (positive and x == 0):
        raise HTTPException(422, f"{what} must be {'greater than zero' if positive else 'zero or more'}")
    if x > MAX_AMOUNT:
        raise HTTPException(422, f"{what} is too large")
    return x.quantize(CENT, rounding=ROUND_HALF_UP)


def iso(v: Any) -> Optional[str]:
    if not v:
        return None
    return (v.date() if isinstance(v, datetime) else v).isoformat()


def f(v: Decimal) -> float:
    return float(v.quantize(CENT))


def names(db: Session, ids: Iterable[Optional[int]]) -> dict[int, str]:
    s = {int(i) for i in ids if i}
    return {u.id: u.full_name for u in db.query(User.id, User.full_name).filter(User.id.in_(s)).all()} if s else {}


def scope(db: Session, cu: User) -> Optional[list[int]]:
    from app.routers.travel_router import _scope_user_ids
    return _scope_user_ids(db, cu)


def scoped_trips(db: Session, cu: User):
    q = db.query(TravelRequest)
    s = scope(db, cu)
    if s is not None:
        q = q.filter(TravelRequest.employee_id.in_(s or [-1]))
    return q


def get_trip(db: Session, cu: User, tid: int, *, lock: bool = False) -> TravelRequest:
    """A trip the caller may see – the id in the URL is re-checked against the caller's scope / approval role."""
    from app.routers.travel_router import _ensure_travel_record_access
    q = db.query(TravelRequest).filter(TravelRequest.id == tid)
    tr = (q.with_for_update() if lock else q).first()
    if not tr:
        raise HTTPException(404, "Trip not found")
    _ensure_travel_record_access(db, cu, "travel", tr)
    return tr


def is_finance(cu: User) -> bool:
    return str(cu.role or "").lower() in FINANCE_ROLES


def company_name(db: Session) -> Optional[str]:
    try:
        from app.routers.customer360_router import company_name as cn
        return cn(db)
    except Exception:
        return None


def creator_of(tr: TravelRequest) -> Optional[int]:
    cd = tr.custom_data if isinstance(tr.custom_data, dict) else {}
    return cd.get("created_by") or tr.employee_id


# ─── claims / expenses / advances (batched per list of trips) ─────────────────

def finance(db: Session, trips: list[TravelRequest]) -> dict[int, dict[str, Any]]:
    ids = [t.id for t in trips]
    out: dict[int, dict[str, Any]] = {t.id: {"claims": [], "claimed": Decimal(0), "items": 0, "disbursed": Decimal(0),
                                             "refunded": Decimal(0)} for t in trips}
    if not ids:
        return out
    claims = db.query(TADAClaim).filter(TADAClaim.travel_request_id.in_(ids)).order_by(TADAClaim.id).all()
    by_claim = {c.id: c.travel_request_id for c in claims}
    for c in claims:
        out[c.travel_request_id]["claims"].append(c)
    if by_claim:
        for cid, total, n in db.query(TADALineItem.claim_id, func.coalesce(func.sum(TADALineItem.amount), 0), func.count(TADALineItem.id)).filter(
                TADALineItem.claim_id.in_(list(by_claim))).group_by(TADALineItem.claim_id).all():
            o = out[by_claim[cid]]
            o["claimed"] += d(total)
            o["items"] += int(n)
    try:
        for tid, kind, amt in db.query(TravelAdvanceTxn.travel_request_id, TravelAdvanceTxn.kind, func.coalesce(func.sum(TravelAdvanceTxn.amount), 0)).filter(
                TravelAdvanceTxn.travel_request_id.in_(ids)).group_by(TravelAdvanceTxn.travel_request_id, TravelAdvanceTxn.kind).all():
            if kind in ADVANCE_KINDS:
                out[tid][kind] += d(amt)
    except Exception as exc:
        db.rollback()
        logger.warning("travel advances unavailable: %s", exc)
    for t in trips:
        o = out[t.id]
        latest = o["claims"][-1] if o["claims"] else None
        o["claim"] = latest
        issued = max(Decimal(0), o["disbursed"] - o["refunded"])
        approved = bool(latest and latest.overall_status in CLAIM_APPROVED)
        adjusted = min(issued, o["claimed"]) if approved else Decimal(0)
        o.update(issued=issued, adjusted=adjusted, outstanding=issued - adjusted, approved=approved,
                 balance=o["claimed"] - issued, requested=d(t.advance_amount))
    return out


def claim_label(c: Optional[TADAClaim]) -> str:
    if not c:
        return "—"
    if c.overall_status == "Draft":
        return "Draft"
    if c.overall_status in CLAIM_PENDING:
        return "Pending"
    if c.overall_status in CLAIM_APPROVED:
        return "Approved"
    return "Rejected"


def can_submit_claim(tr: TravelRequest, fin: dict, cu: User) -> bool:
    c = fin["claim"]
    return bool(c and c.overall_status in CLAIM_OPEN and fin["items"] > 0 and int(tr.employee_id) == int(cu.id))


def can_add_expense(db: Session, tr: TravelRequest, fin: dict, cu: User) -> bool:
    c = fin["claim"]
    return (tr.status in ("Approved", "Completed") and int(tr.employee_id) == int(cu.id)
            and (c is None or c.overall_status in CLAIM_OPEN) and user_has_permission(db, cu, "travel.create"))


# ─── list / KPIs / calendar ───────────────────────────────────────────────────

def row(tr: TravelRequest, who: dict[int, str]) -> dict[str, Any]:
    return {"id": tr.id, "code": tr.request_number, "traveller": who.get(tr.employee_id, ""), "traveller_id": tr.employee_id,
            "purpose": tr.purpose or "", "from": tr.from_city or "", "to": tr.to_city or "", "start": iso(tr.travel_date),
            "end": iso(tr.return_date), "mode": DB_TO_MODE.get(tr.mode_of_travel or "", tr.mode_of_travel or ""),
            "cost": f(d(tr.estimated_total)), "status": STATUS_SHOWN.get(tr.status or "", tr.status or ""), "raw_status": tr.status}


def meta(db: Session, cu: User) -> dict[str, Any]:
    ensure_schema(db)
    s = scope(db, cu)
    uq = db.query(User.id, User.full_name, User.department, User.reporting_manager_id).filter(User.is_active == True)
    if s is not None:
        uq = uq.filter(User.id.in_(s or [cu.id]))
    travellers = [{"id": u.id, "name": u.full_name, "department": u.department or ""} for u in uq.order_by(User.full_name).all()]
    if not any(t["id"] == cu.id for t in travellers):
        travellers.insert(0, {"id": cu.id, "name": cu.full_name, "department": cu.department or ""})
    return {"company": company_name(db), "me": {"id": cu.id, "name": cu.full_name}, "views": VIEWS, "statuses": list(FILTER),
            "modes": MODES, "heads": HEADS, "travellers": travellers, "finance": is_finance(cu), "max_receipt_mb": MAX_RECEIPT_MB,
            "can": {"create": user_has_permission(db, cu, "travel.create"), "update": user_has_permission(db, cu, "travel.update"),
                    "delete": user_has_permission(db, cu, "travel.delete"), "export": user_has_permission(db, cu, "travel.export")}}


def list_trips(db: Session, cu: User, view: str, status: str) -> dict[str, Any]:
    trips = scoped_trips(db, cu).order_by(TravelRequest.travel_date.desc(), TravelRequest.id.desc()).all()
    t0 = today_ist()
    pred = {"All": lambda t: True, "Upcoming": lambda t: t.travel_date is not None and t.travel_date >= t0,
            "Mine": lambda t: int(t.employee_id) == int(cu.id)}
    counts = {v: sum(1 for t in trips if pred[v](t)) for v in VIEWS}
    rows = [t for t in trips if pred.get(view, pred["All"])(t)]
    if status in FILTER:
        rows = [t for t in rows if t.status in FILTER[status]]
    who = names(db, [t.employee_id for t in rows])
    return {"items": [row(t, who) for t in rows], "total_all": len(trips), "counts": counts}


def claims(db: Session, cu: User) -> dict[str, Any]:
    trips = scoped_trips(db, cu).filter(TravelRequest.status.notin_(("Draft", "Cancelled"))).order_by(TravelRequest.travel_date.desc(), TravelRequest.id.desc()).all()
    fin = finance(db, trips)
    who = names(db, [t.employee_id for t in trips])
    total = sum((fin[t.id]["claimed"] for t in trips), Decimal(0))
    outstanding = sum((fin[t.id]["outstanding"] for t in trips), Decimal(0))
    awaiting = sum(1 for t in trips for c in fin[t.id]["claims"] if c.overall_status in CLAIM_PENDING)
    items = []
    for t in trips:
        x = fin[t.id]
        items.append({"id": t.id, "code": t.request_number, "traveller": who.get(t.employee_id, ""), "purpose": t.purpose or "",
                      "claimed": f(x["claimed"]), "advance": f(x["issued"]), "advance_requested": f(x["requested"]),
                      "balance": f(x["balance"]), "claim": claim_label(x["claim"]), "claim_id": x["claim"].id if x["claim"] else None,
                      "claim_no": x["claim"].claim_number if x["claim"] else None, "items": x["items"],
                      "can_submit": can_submit_claim(t, x, cu)})
    return {"kpis": {"claimed": f(total), "outstanding": f(outstanding), "awaiting": awaiting}, "items": items}


def calendar(db: Session, cu: User) -> list[dict[str, Any]]:
    """Prototype: trips whose end date is at most 3 days ago, by start date (company time zone = IST)."""
    cutoff = today_ist() - timedelta(days=3)
    trips = scoped_trips(db, cu).filter(TravelRequest.return_date >= cutoff, TravelRequest.status.notin_(("Cancelled", "Rejected"))) \
        .order_by(TravelRequest.travel_date, TravelRequest.id).all()
    who = names(db, [t.employee_id for t in trips])
    return [row(t, who) for t in trips]


# ─── trip detail ──────────────────────────────────────────────────────────────

def detail(db: Session, cu: User, tid: int) -> dict[str, Any]:
    tr = get_trip(db, cu, tid)
    x = finance(db, [tr])[tr.id]
    claim_ids = [c.id for c in x["claims"]]
    items = db.query(TADALineItem).filter(TADALineItem.claim_id.in_(claim_ids or [-1])).order_by(TADALineItem.expense_date, TADALineItem.id).all()
    atts = db.query(TADAAttachment).filter(TADAAttachment.claim_id.in_(claim_ids or [-1])).order_by(TADAAttachment.id).all()
    by_item: dict[Optional[int], list] = defaultdict(list)
    for a in atts:
        by_item[getattr(a, "line_item_id", None)].append(a)
    who = names(db, [tr.employee_id, tr.approved_by, creator_of(tr)] + [a.uploaded_by for a in atts])
    txns = db.query(TravelAdvanceTxn).filter(TravelAdvanceTxn.travel_request_id == tr.id).order_by(TravelAdvanceTxn.txn_date, TravelAdvanceTxn.id).all()
    who.update(names(db, [t.created_by for t in txns]))
    can_upd = user_has_permission(db, cu, "travel.update")
    own = int(cu.id) in (int(tr.employee_id), int(creator_of(tr) or 0))
    c = x["claim"]
    emp = db.query(User.department, User.reporting_manager_id).filter(User.id == tr.employee_id).first()
    mgr = names(db, [emp.reporting_manager_id]).get(emp.reporting_manager_id) if emp and emp.reporting_manager_id else None
    return {
        "id": tr.id, "code": tr.request_number, "purpose": tr.purpose or "", "status": STATUS_SHOWN.get(tr.status or "", tr.status),
        "raw_status": tr.status, "company": company_name(db), "traveller": who.get(tr.employee_id, ""), "traveller_id": tr.employee_id,
        "department": emp.department if emp else None, "manager": mgr,
        "from": tr.from_city or "", "to": tr.to_city or "", "start": iso(tr.travel_date), "end": iso(tr.return_date),
        "mode": DB_TO_MODE.get(tr.mode_of_travel or "", tr.mode_of_travel or ""), "cost": f(d(tr.estimated_total)),
        "advance": f(x["requested"]), "advance_issued": f(x["issued"]), "advance_adjusted": f(x["adjusted"]),
        "advance_outstanding": f(x["outstanding"]), "claimed": f(x["claimed"]), "balance": f(x["balance"]),
        "rejection_reason": tr.rejection_reason, "approved_by": who.get(tr.approved_by or 0), "approved_at": iso(tr.approved_at),
        "created_at": tr.created_at.isoformat() if tr.created_at else None, "created_by": who.get(creator_of(tr) or 0),
        "claim": {"id": c.id, "no": c.claim_number, "label": claim_label(c), "status": c.overall_status,
                  "reason": c.manager_rejection_reason or c.accounts_rejection_reason, "net_payable": f(d(c.net_payable)),
                  "payment_date": iso(c.payment_date), "payment_reference": c.payment_reference} if c else None,
        "expenses": [{"id": i.id, "head": i.category, "amount": f(d(i.amount)), "date": iso(i.expense_date), "description": i.description,
                      "claim_id": i.claim_id, "receipts": [{"id": a.id, "name": a.file_name, "url": a.file_url, "type": a.doc_type,
                                                            "size_kb": a.file_size_kb} for a in by_item.get(i.id, [])]} for i in items],
        "documents": [{"id": a.id, "name": a.file_name, "url": a.file_url, "type": a.doc_type, "size_kb": a.file_size_kb,
                       "by": who.get(a.uploaded_by or 0, ""), "at": a.created_at.isoformat() if a.created_at else None,
                       "expense": next((f"{i.category} · ₹{f(d(i.amount)):,.2f}" for i in items if i.id == getattr(a, "line_item_id", None)), "Claim")} for a in atts],
        "advance_txns": [{"id": t.id, "kind": t.kind, "amount": f(d(t.amount)), "date": iso(t.txn_date), "reference": t.reference,
                          "mode": t.payment_mode, "by": who.get(t.created_by or 0, "")} for t in txns],
        "activity": activity(db, tr, claim_ids), "notes": notes(db, tr.id),
        "actions": {
            "edit": can_upd and own and tr.status in ("Draft", "Rejected"),
            "delete": own and tr.status in ("Draft", "Rejected") and not x["claims"] and user_has_permission(db, cu, "travel.delete"),
            "submit": can_upd and own and tr.status in ("Draft", "Rejected"),
            "complete": can_upd and (own or is_finance(cu)) and tr.status == "Approved" and tr.travel_date is not None and tr.travel_date <= today_ist(),
            "add_expense": can_add_expense(db, tr, x, cu),
            "submit_claim": can_upd and can_submit_claim(tr, x, cu),
            "advance": can_upd and is_finance(cu) and tr.status in ("Approved", "Completed"),
            "note": user_has_permission(db, cu, "travel.view"),
        },
    }


def activity(db: Session, tr: TravelRequest, claim_ids: list[int]) -> list[dict[str, Any]]:
    rows = db.query(ActivityLog).filter(((ActivityLog.module == "travel") & (ActivityLog.record_id == tr.id)) |
                                        ((ActivityLog.module == "tada") & (ActivityLog.record_id.in_(claim_ids or [-1])))).order_by(ActivityLog.created_at.desc()).limit(80).all()
    apr = db.query(Approval).filter(((Approval.module == "travel") & (Approval.record_id == tr.id)) |
                                    ((Approval.module == "tada") & (Approval.record_id.in_(claim_ids or [-1])))).all()
    who = names(db, [r.user_id for r in rows] + [a.requested_to for a in apr] + [a.requested_by for a in apr])
    out = [{"t": r.description or r.action, "by": who.get(r.user_id or 0, "System"), "d": r.created_at.isoformat() if r.created_at else None} for r in rows]
    for a in apr:
        when = a.decided_at or a.created_at
        note = a.rejection_reason or a.decision_notes
        out.append({"t": f"{'Claim' if a.module == 'tada' else 'Trip'} approval {a.status} – {who.get(a.requested_to or 0, 'approver')}" + (f": {note}" if note else ""),
                    "by": who.get(a.requested_by or 0, ""), "d": when.isoformat() if when else None})
    try:
        for r in db.query(ApprovalRequest).filter(ApprovalRequest.module_key == "travel", ApprovalRequest.record_id == tr.id).all():
            when = r.final_decided_at or r.requested_at
            out.append({"t": f"Trip approval request {str(r.status or '').lower()} (step {r.current_step_no})", "by": names(db, [r.requested_by]).get(r.requested_by, ""),
                        "d": when.isoformat() if when else None})
    except Exception:
        db.rollback()
    out.sort(key=lambda x: x["d"] or "", reverse=True)
    return out


def notes(db: Session, tid: int) -> list[dict[str, Any]]:
    rows = db.query(TravelTripNote).filter(TravelTripNote.travel_request_id == tid).order_by(TravelTripNote.id.desc()).all()
    who = names(db, [n.created_by for n in rows])
    return [{"id": n.id, "body": n.body, "by": who.get(n.created_by or 0, ""), "at": n.created_at.isoformat() if n.created_at else None} for n in rows]


# ─── trip create / update / submit / complete / delete ───────────────────────

def _next_number(db: Session) -> str:
    prefix = f"TR-{now_ist().strftime('%Y%m')}-"
    last = db.query(func.max(TravelRequest.request_number)).filter(TravelRequest.request_number.like(f"{prefix}%")).scalar()
    try:
        n = int(str(last).rsplit("-", 1)[-1]) + 1 if last else 1
    except ValueError:
        n = (db.query(func.count(TravelRequest.id)).scalar() or 0) + 1
    while db.query(TravelRequest.id).filter(TravelRequest.request_number == f"{prefix}{n:04d}").first():
        n += 1
    return f"{prefix}{n:04d}"


def _validate_trip(db: Session, cu: User, b: Any) -> dict[str, Any]:
    purpose = (b.purpose or "").strip()
    if len(purpose) < 3:
        raise HTTPException(422, "Purpose is required (at least 3 characters)")
    if len(purpose) > 500:
        raise HTTPException(422, "Purpose is too long")
    dest = (b.to or "").strip()
    origin = (b.from_ or "").strip()
    if len(dest) < 2:
        raise HTTPException(422, "Destination is required")
    if len(origin) < 2:
        raise HTTPException(422, "Origin is required")
    if len(dest) > 100 or len(origin) > 100:
        raise HTTPException(422, "Origin / destination is too long")
    if origin.lower() == dest.lower():
        raise HTTPException(422, "Origin and destination must be different")
    if not b.start or not b.end:
        raise HTTPException(422, "Departure and return dates are required")
    if b.start > b.end:
        raise HTTPException(422, "Departure cannot be later than return")
    if (b.end - b.start).days > 365:
        raise HTTPException(422, "A trip cannot be longer than a year")
    if b.mode not in MODES:
        raise HTTPException(422, "Choose a travel mode")
    traveller = int(b.traveller_id or cu.id)
    if traveller != int(cu.id):
        s = scope(db, cu)
        if s is not None and traveller not in set(s):
            raise HTTPException(403, "You can't create a trip for this employee")
    u = db.query(User).filter(User.id == traveller, User.is_active == True).first()
    if not u:
        raise HTTPException(422, "Traveller must be an active employee")
    return {"purpose": purpose, "from_city": origin, "to_city": dest, "travel_date": b.start, "return_date": b.end,
            "total_days": (b.end - b.start).days + 1, "mode_of_travel": MODE_TO_DB[b.mode],
            "estimated_total": money(b.cost if b.cost is not None else 0, "Estimated cost"),
            "advance_amount": money(b.advance if b.advance is not None else 0, "Advance amount"), "employee_id": traveller, "user": u}


def create_trip(db: Session, cu: User, b: Any, request: Request) -> dict[str, Any]:
    from app.routers.travel_router import _get_tenant_id
    from app.services.travel_approval_service import submit_travel_request_with_policy
    v = _validate_trip(db, cu, b)
    if v["advance_amount"] > v["estimated_total"] and v["estimated_total"] > 0:
        raise HTTPException(422, "Advance cannot exceed the estimated cost")
    # duplicate guard: the same trip submitted twice (double click / retry) within 2 minutes returns the first one
    dup = db.query(TravelRequest).filter(TravelRequest.employee_id == v["employee_id"], TravelRequest.purpose == v["purpose"],
                                         TravelRequest.to_city == v["to_city"], TravelRequest.travel_date == v["travel_date"],
                                         TravelRequest.return_date == v["return_date"],
                                         TravelRequest.created_at >= now_ist() - timedelta(minutes=2)).first()
    if dup:
        raise HTTPException(409, f"This trip was already created as {dup.request_number}")
    u = v.pop("user")
    for attempt in range(3):
        tr = TravelRequest(request_number=_next_number(db), purpose=v["purpose"], visit_type="Customer Visit", from_city=v["from_city"],
                           to_city=v["to_city"], travel_date=v["travel_date"], return_date=v["return_date"], total_days=v["total_days"],
                           mode_of_travel=v["mode_of_travel"], estimated_total=v["estimated_total"], advance_amount=v["advance_amount"],
                           advance_required=v["advance_amount"] > 0, employee_id=v["employee_id"], status="Draft",
                           custom_data={"created_by": cu.id, "source": "travel_expense_v17"})
        if "source" in TravelRequest.__table__.columns:
            tr.source = "direct"
        db.add(tr)
        try:
            db.flush()
            break
        except IntegrityError:
            db.rollback()
            if attempt == 2:
                raise HTTPException(409, "Could not allocate a trip number – please try again")
    db.add(ActivityLog(user_id=cu.id, module="travel", record_id=tr.id, action="created", description=f"Trip {tr.request_number} created",
                       icon="✈", color="#EFF6FF"))
    res = submit_travel_request_with_policy(db, tr, actor=cu, requester=u, tenant_id=_get_tenant_id(request))
    db.commit()
    return {"id": tr.id, "code": tr.request_number, "status": STATUS_SHOWN.get(tr.status, tr.status), "message": res.get("message")}


def update_trip(db: Session, cu: User, tid: int, b: Any, request: Request) -> dict[str, Any]:
    from app.routers.travel_router import _get_tenant_id
    from app.services.travel_approval_service import submit_travel_request_with_policy
    tr = get_trip(db, cu, tid, lock=True)
    if int(cu.id) not in (int(tr.employee_id), int(creator_of(tr) or 0)):
        raise HTTPException(403, "Only the traveller or the person who raised the trip can edit it")
    if tr.status not in ("Draft", "Rejected"):
        raise HTTPException(400, f"A {STATUS_SHOWN.get(tr.status, tr.status).lower()} trip can't be edited")
    v = _validate_trip(db, cu, b)
    if v["advance_amount"] > v["estimated_total"] and v["estimated_total"] > 0:
        raise HTTPException(422, "Advance cannot exceed the estimated cost")
    u = v.pop("user")
    old = {k: str(getattr(tr, k)) for k in v}
    for k, val in v.items():
        setattr(tr, k, val)
    tr.advance_required = v["advance_amount"] > 0
    changed = [k for k in v if old[k] != str(getattr(tr, k))]
    db.add(ActivityLog(user_id=cu.id, module="travel", record_id=tr.id, action="updated",
                       description=f"Trip {tr.request_number} edited" + (f" ({', '.join(changed)})" if changed else ""), icon="✎", color="#EFF6FF"))
    res = submit_travel_request_with_policy(db, tr, actor=cu, requester=u, tenant_id=_get_tenant_id(request))
    db.commit()
    return {"id": tr.id, "status": STATUS_SHOWN.get(tr.status, tr.status), "message": res.get("message")}


def complete_trip(db: Session, cu: User, tid: int) -> dict[str, Any]:
    tr = get_trip(db, cu, tid, lock=True)
    if not (int(cu.id) in (int(tr.employee_id), int(creator_of(tr) or 0)) or is_finance(cu)):
        raise HTTPException(403, "Only the traveller can mark the trip completed")
    if tr.status != "Approved":
        raise HTTPException(400, "Only an approved trip can be completed")
    if tr.travel_date and tr.travel_date > today_ist():
        raise HTTPException(400, "The trip hasn't started yet")
    tr.status = "Completed"
    tr.updated_at = now_ist()
    db.add(ActivityLog(user_id=cu.id, module="travel", record_id=tr.id, action="completed", description=f"Trip {tr.request_number} marked completed",
                       icon="✓", color="#F0FDF4"))
    db.commit()
    return {"id": tr.id, "status": "Completed"}


def delete_trip(db: Session, cu: User, tid: int) -> dict[str, Any]:
    tr = get_trip(db, cu, tid, lock=True)
    if not user_has_permission(db, cu, "travel.delete"):
        raise HTTPException(403, "You don't have permission to delete trips")
    if int(cu.id) not in (int(tr.employee_id), int(creator_of(tr) or 0)):
        raise HTTPException(403, "Only the traveller can delete this trip")
    if tr.status not in ("Draft", "Rejected"):
        raise HTTPException(400, "Only a draft or rejected trip can be deleted")
    if db.query(TADAClaim.id).filter(TADAClaim.travel_request_id == tr.id).first():
        raise HTTPException(400, "This trip has an expense claim and can't be deleted")
    if db.query(TravelAdvanceTxn.id).filter(TravelAdvanceTxn.travel_request_id == tr.id).first():
        raise HTTPException(400, "This trip has advance transactions and can't be deleted")
    code = tr.request_number
    db.query(Approval).filter(Approval.module == "travel", Approval.record_id == tr.id, Approval.status == "pending").update(
        {Approval.status: "rejected", Approval.decision_notes: "Trip deleted by the requester", Approval.decided_at: now_ist()}, synchronize_session=False)
    db.add(ActivityLog(user_id=cu.id, module="travel", record_id=tr.id, action="deleted", description=f"Trip {code} deleted", icon="🗑", color="#FEF2F2"))
    db.delete(tr)
    db.commit()
    return {"id": tid, "deleted": True}


# ─── expenses / claim ─────────────────────────────────────────────────────────

def _open_claim(db: Session, tr: TravelRequest, cu: User) -> TADAClaim:
    from app.routers.travel_router import _ta_num
    c = db.query(TADAClaim).filter(TADAClaim.travel_request_id == tr.id).order_by(TADAClaim.id.desc()).with_for_update().first()
    if c and c.overall_status in CLAIM_OPEN:
        return c
    if c:
        raise HTTPException(400, f"The expense claim is {claim_label(c).lower()} – expenses can't be added now")
    emp = db.query(User).filter(User.id == tr.employee_id).first()
    num = _ta_num(db)
    while db.query(TADAClaim.id).filter(TADAClaim.claim_number == num).first():
        num = f"{num}-{db.query(func.max(TADAClaim.id)).scalar() or 0}"
    c = TADAClaim(claim_number=num, travel_request_id=tr.id, employee_id=tr.employee_id, claim_date=today_ist(), claim_type="travel",
                  travel_date_from=tr.travel_date, travel_date_to=tr.return_date, num_days=tr.total_days, from_city=tr.from_city,
                  to_city=tr.to_city, purpose=tr.purpose, mode_of_travel=DB_TO_MODE.get(tr.mode_of_travel or "", tr.mode_of_travel),
                  department=emp.department if emp else None, total_amount=0, advance_taken=0, net_payable=0, overall_status="Draft",
                  manager_status="pending", accounts_status="pending")
    db.add(c)
    db.flush()
    db.add(ActivityLog(user_id=cu.id, module="tada", record_id=c.id, action="created", description=f"Expense claim {c.claim_number} opened for trip {tr.request_number}",
                       icon="🧾", color="#F0FDF4"))
    return c


def _recalc(db: Session, c: TADAClaim) -> None:
    total = d(db.query(func.coalesce(func.sum(TADALineItem.amount), 0)).filter(TADALineItem.claim_id == c.id).scalar())
    c.total_amount = total
    c.net_payable = total - d(c.advance_taken)


def add_expense(db: Session, cu: User, tid: int, b: Any) -> dict[str, Any]:
    if not user_has_permission(db, cu, "travel.create"):
        raise HTTPException(403, "You don't have permission to add expenses")
    tr = get_trip(db, cu, tid, lock=True)
    if int(tr.employee_id) != int(cu.id):
        raise HTTPException(403, "Only the traveller can add expenses to this trip")
    if tr.status not in ("Approved", "Completed"):
        raise HTTPException(400, "Expenses can be added once the trip is approved")
    if b.head not in HEADS:
        raise HTTPException(422, "Choose an expense head")
    amount = money(b.amount, "Amount", positive=True)
    day = b.date or today_ist()
    if day > today_ist():
        raise HTTPException(422, "Expense date can't be in the future")
    if tr.travel_date and day < tr.travel_date - timedelta(days=30):
        raise HTTPException(422, "Expense date is too long before the trip")
    desc = (b.description or "").strip() or b.head
    if len(desc) > 500:
        raise HTTPException(422, "Description is too long")
    c = _open_claim(db, tr, cu)
    dup = db.query(TADALineItem.id).filter(TADALineItem.claim_id == c.id, TADALineItem.category == b.head, TADALineItem.amount == amount,
                                           TADALineItem.expense_date == day, TADALineItem.description == desc).first()
    if dup and not b.allow_duplicate:
        raise HTTPException(409, "The same expense (head, amount, date, description) is already on this trip")
    item = TADALineItem(claim_id=c.id, expense_date=day, category=b.head, description=desc[:500], amount=amount, approved_amount=amount,
                        from_place=tr.from_city, to_place=tr.to_city)
    db.add(item)
    db.flush()
    _recalc(db, c)
    db.add(ActivityLog(user_id=cu.id, module="tada", record_id=c.id, action="expense_added",
                       description=f"Expense added: {b.head} ₹{amount:,.2f} ({tr.request_number})", icon="+", color="#F0FDF4"))
    db.commit()
    return {"id": item.id, "claim_id": c.id}


def delete_expense(db: Session, cu: User, tid: int, item_id: int) -> dict[str, Any]:
    tr = get_trip(db, cu, tid, lock=True)
    item = db.query(TADALineItem).join(TADAClaim, TADAClaim.id == TADALineItem.claim_id).filter(
        TADALineItem.id == item_id, TADAClaim.travel_request_id == tr.id).first()
    if not item:
        raise HTTPException(404, "Expense not found")
    c = db.query(TADAClaim).filter(TADAClaim.id == item.claim_id).with_for_update().first()
    if int(tr.employee_id) != int(cu.id) or c.overall_status not in CLAIM_OPEN:
        raise HTTPException(403, "This expense can no longer be removed")
    db.delete(item)
    db.flush()
    _recalc(db, c)
    db.add(ActivityLog(user_id=cu.id, module="tada", record_id=c.id, action="expense_removed", description=f"Expense removed: {item.category} ₹{d(item.amount):,.2f}",
                       icon="-", color="#FEF2F2"))
    db.commit()
    return {"deleted": True}


def receipt_target(db: Session, cu: User, tid: int, item_id: int) -> TADAClaim:
    """The traveller may attach receipts while the claim is open (Draft / returned)."""
    tr = get_trip(db, cu, tid)
    item = db.query(TADALineItem).join(TADAClaim, TADAClaim.id == TADALineItem.claim_id).filter(
        TADALineItem.id == item_id, TADAClaim.travel_request_id == tr.id).first()
    if not item:
        raise HTTPException(404, "Expense not found")
    c = db.query(TADAClaim).filter(TADAClaim.id == item.claim_id).first()
    if int(tr.employee_id) != int(cu.id):
        raise HTTPException(403, "Only the traveller can attach receipts")
    if c.overall_status not in CLAIM_OPEN:
        raise HTTPException(400, "The claim has been submitted – receipts can't be changed now")
    return c


def submit_claim(db: Session, cu: User, tid: int) -> dict[str, Any]:
    """Validate, set the advance in hand, then hand over to the existing TA/DA submission (approval chain + notifications)."""
    from app.routers.travel_router import submit_tada_claim
    tr = get_trip(db, cu, tid, lock=True)
    x = finance(db, [tr])[tr.id]
    c = x["claim"]
    if not c:
        raise HTTPException(400, "Add at least one expense before submitting the claim")
    c = db.query(TADAClaim).filter(TADAClaim.id == c.id).with_for_update().first()
    if c.overall_status not in CLAIM_OPEN:
        raise HTTPException(409, f"This claim was already submitted ({claim_label(c)})")
    if int(tr.employee_id) != int(cu.id):
        raise HTTPException(403, "Only the traveller can submit this claim")
    bad = db.query(TADALineItem.id).filter(TADALineItem.claim_id == c.id, (TADALineItem.amount <= 0) | (TADALineItem.amount.is_(None))).first()
    if bad:
        raise HTTPException(400, "Every expense needs an amount greater than zero")
    c.advance_taken = x["issued"]
    _recalc(db, c)
    db.flush()
    res = submit_tada_claim(c.id, db, cu)          # commits; raises 400 when a receipt is missing
    return {**res, "claim_id": c.id, "claim": claim_label(db.query(TADAClaim).filter(TADAClaim.id == c.id).first())}


# ─── advances ─────────────────────────────────────────────────────────────────

def add_advance_txn(db: Session, cu: User, tid: int, b: Any) -> dict[str, Any]:
    if not (is_finance(cu) and user_has_permission(db, cu, "travel.update")):
        raise HTTPException(403, "Only finance (accounts) can record advance transactions")
    tr = get_trip(db, cu, tid, lock=True)
    if b.kind not in ADVANCE_KINDS:
        raise HTTPException(422, "Unknown transaction type")
    if tr.status not in ("Approved", "Completed"):
        raise HTTPException(400, "Advances are paid only on approved trips")
    amount = money(b.amount, "Amount", positive=True)
    x = finance(db, [tr])[tr.id]
    if b.kind == "disbursed" and x["disbursed"] - x["refunded"] + amount > x["requested"]:
        raise HTTPException(422, f"Disbursement would exceed the approved advance of ₹{x['requested']:,.2f}")
    if b.kind == "refunded" and amount > x["outstanding"]:
        raise HTTPException(422, f"Refund is more than the outstanding advance of ₹{x['outstanding']:,.2f}")
    if b.date and b.date > today_ist():
        raise HTTPException(422, "Transaction date can't be in the future")
    t = TravelAdvanceTxn(travel_request_id=tr.id, kind=b.kind, amount=amount, txn_date=b.date or today_ist(), reference=(b.reference or "").strip()[:120] or None,
                         payment_mode=(b.mode or "").strip()[:30] or None, created_by=cu.id)
    db.add(t)
    db.add(ActivityLog(user_id=cu.id, module="travel", record_id=tr.id, action=f"advance_{b.kind}",
                       description=f"Advance {b.kind}: ₹{amount:,.2f}" + (f" (ref {t.reference})" if t.reference else ""), icon="₹", color="#ECFDF5"))
    if b.kind == "disbursed":
        from app.services.approval_service import _create_notification
        try:
            _create_notification(db, tr.employee_id, title=f"Travel advance paid: {tr.request_number}",
                                 message=f"₹{amount:,.2f} advance has been disbursed for {tr.purpose}.", module="travel", record_id=tr.id, notif_type="success")
        except Exception as exc:
            logger.warning("advance notification skipped: %s", exc)
    db.commit()
    return {"id": t.id}


def add_note(db: Session, cu: User, tid: int, body: str) -> dict[str, Any]:
    tr = get_trip(db, cu, tid)
    body = (body or "").strip()
    if not body:
        raise HTTPException(422, "Write a note first")
    if len(body) > 5000:
        raise HTTPException(422, "Note is too long")
    db.add(TravelTripNote(travel_request_id=tr.id, body=body, created_by=cu.id))
    db.commit()
    return {"notes": notes(db, tr.id)}
