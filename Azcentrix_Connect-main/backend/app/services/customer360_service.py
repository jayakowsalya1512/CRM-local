"""Customers & Contacts – Customer 360 (prototype v17 → Application → Customers & Contacts).

Every figure is computed from the tenant's own records:

* Orders            – won tenders (the Orders & Projects module lists won tenders) plus work orders that
                      are not tied to a tender.  Order value = PO value, else WO value, else bid amount.
* FY revenue        – order value with an order date (PO date, else result date) in the current Indian FY
                      (1 Apr – 31 Mar).  Lifetime revenue = all orders.
* Billing           – billed = work-order invoice totals. Collections come from the Orders & Projects payment
                      ledger (order_payment_service.ledger): collected = Finance-acknowledged receipts, outstanding =
                      unpaid balance of payment stages due to date, payment delay = bank credit date − stage due date.
* Open pipeline     – open deals (opportunities not yet converted / lost) + live bids (tenders not closed,
                      result pending), at estimated value.
* Win rate          – tenders won ÷ (won + lost) together with quotations accepted ÷ (accepted + rejected).
* Health            – average of five drivers (engagement, pipeline coverage, payment behaviour,
                      relationship depth, competitive position) – see health_drivers().

Account-level metrics (KPIs, health, revenue) describe the customer as a whole.  Record tables in the tabs
are filtered by each module's own view permission and Data Visibility.
"""
from __future__ import annotations

import json
import logging
import threading
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Iterable, Optional

from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session

from app.core.timezone import today_ist
from app.models.all_models import (
    EMDBG, ApprovalRequest, Customer, CustomerContact, KAMActivity, Lead, Quotation, Tender, User, WorkOrder,
)
from app.models.customer360 import CUSTOMER360_TABLES, BUYING_ROLES, HIERARCHY_LEVELS, CustomerContactRole, CustomerProfile

logger = logging.getLogger(__name__)

TIER_OF = {"High": "A", "Medium": "B", "Low": "C"}
POTENTIAL_OF = {v: k for k, v in TIER_OF.items()}
STATUSES = ("Active", "Prospect", "Inactive", "Churned")
VALUE_BANDS = ("Strategic", "Growth", "Maintain")
LEVEL_BADGE = {"Head Office": ("HO", "l1"), "LHO / Regional Office": ("LHO", "l2"), "Zone": ("ZONE", "l3"),
               "Divisional Office": ("DO", "l4"), "Branch / Site": ("BR", "l5")}
OPEN_QUOTE = ("Draft", "Sent", "Approved")
DONE_WO = ("Completed", "Closed", "Cancelled", "Lost")

_READY: set[str] = set()
_LOCK = threading.Lock()


# ─── schema ───────────────────────────────────────────────────────────────────

def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        bind = db.get_bind()
        for t in CUSTOMER360_TABLES:
            t.create(bind=bind, checkfirst=True)
        db.commit()   # MariaDB: a table created after this transaction's snapshot is unreadable until it ends
        _READY.add(slug)


def ensure_schema_all_tenants() -> None:
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant
    master = MasterSessionLocal()
    try:
        slugs = [t.slug for t in master.query(Tenant).all()]
    except Exception as exc:  # pragma: no cover
        logger.warning("Customer 360 schema sync: unable to list tenants: %s", exc)
        return
    finally:
        master.close()
    for slug in slugs:
        try:
            db = get_tenant_session(slug)
            try:
                db.info["tenant_slug"] = slug
                ensure_schema(db)
            finally:
                db.close()
        except Exception as exc:
            logger.warning("Customer 360 schema sync failed for %s: %s", slug, exc)


# ─── small helpers ────────────────────────────────────────────────────────────

def f(v: Any) -> float:
    if v is None:
        return 0.0
    return float(v) if isinstance(v, (int, float, Decimal)) else float(v or 0)


def iso(d: Any) -> Optional[str]:
    if not d:
        return None
    return d.isoformat()[:10] if hasattr(d, "isoformat") else str(d)[:10]


def as_date(d: Any) -> Optional[date]:
    if d is None:
        return None
    return d.date() if isinstance(d, datetime) else d


def fy_bounds(today: Optional[date] = None) -> tuple[date, date]:
    t = today or today_ist()
    start = date(t.year if t.month >= 4 else t.year - 1, 4, 1)
    return start, date(start.year + 1, 3, 31)


def cust_ref(cid: int) -> str:
    return f"CUS-{cid:04d}"


def is_opp_expr():
    return or_(Lead.lead_type == "direct_opportunity", Lead.status.in_(("Opportunity Created", "Converted")))


def vertical_of(c: Customer) -> str:
    """Vertical: the Industry field, else the Customer type (Customer Segment value)."""
    return ((c.industry or "").strip() or (c.customer_vertical or "").strip() or "Unclassified")


def segment_of(c: Customer) -> tuple[str, str]:
    """Segment = Group Name, Sub-segment = Division / Department – the customer form's own fields."""
    return ((c.group_name or "").strip() or "—", (c.division or "").strip() or "—")


class Segments:
    """Resolves the stored Customer Segment value against the segment / sub-segment masters.

    The customer form stores a sub-segment name, "Segment / Sub-segment" when a sub-segment name is
    shared by several segments, or a segment name when the tenant has no sub-segments.
    """

    def __init__(self, db: Session):
        self.sectors: dict[str, str] = {}
        self.subs: dict[str, str] = {}
        try:
            from app.models.all_models import VerticalSector, VerticalSubSector
            names = {s.id: (s.name or "").strip() for s in db.query(VerticalSector).all()}
            self.sectors = {n.casefold(): n for n in names.values() if n}
            for sub in db.query(VerticalSubSector).all():
                if sub.name and sub.name.strip():
                    self.subs.setdefault(sub.name.strip().casefold(), names.get(sub.sector_id, ""))
        except Exception as exc:  # masters missing on an old tenant
            logger.info("Segment masters unavailable: %s", exc)
            db.rollback()

    def of(self, c: Customer) -> tuple[str, str]:
        v = (c.customer_vertical or "").strip()
        div = (c.division or "").strip() or "—"
        if not v:
            return "—", div
        if " / " in v:
            seg, sub = (x.strip() for x in v.split(" / ", 1))
            if seg.casefold() in self.sectors:
                return self.sectors[seg.casefold()], sub
        if v.casefold() in self.sectors:
            return self.sectors[v.casefold()], div
        if v.casefold() in self.subs and self.subs[v.casefold()]:
            return self.subs[v.casefold()], v
        return v, div

    def options(self, db: Session) -> list[str]:
        """Values the customer form offers for Customer Segment (active sub-segments, else segments)."""
        try:
            from app.models.all_models import VerticalSector, VerticalSubSector
            active = {s.id: s.name.strip() for s in db.query(VerticalSector).filter(VerticalSector.is_active == True).all() if s.name}
            subs = [x for x in db.query(VerticalSubSector).filter(VerticalSubSector.is_active == True).all() if x.name and x.sector_id in active]
            counts = Counter(x.name.strip().casefold() for x in subs)
            vals = [f"{active[x.sector_id]} / {x.name.strip()}" if counts[x.name.strip().casefold()] > 1 else x.name.strip() for x in subs]
            return sorted(set(vals or active.values()))
        except Exception:
            db.rollback()
            return []


def can(db: Session, user: User, key: str) -> bool:
    from app.dependencies import user_has_permission
    return user_has_permission(db, user, key)


def user_names(db: Session, ids: Iterable[Optional[int]]) -> dict[int, str]:
    want = {int(i) for i in ids if i}
    if not want:
        return {}
    return {u.id: u.full_name for u in db.query(User.id, User.full_name).filter(User.id.in_(want)).all()}


# ─── orders & billing (shared by metrics and the Orders tab) ──────────────────

def order_rows(db: Session, ids: Optional[set[int]] = None) -> list[dict[str, Any]]:
    """Won tenders + standalone work orders, with their linked work order (status / progress / type)."""
    tq = db.query(Tender).filter(Tender.result == "Won", Tender.is_deleted == False, Tender.customer_id.isnot(None))
    if ids is not None:
        tq = tq.filter(Tender.customer_id.in_(ids or [-1]))
    tenders = tq.all()
    wq = db.query(WorkOrder)
    if ids is not None:
        wq = wq.filter(or_(WorkOrder.customer_id.in_(ids or [-1]), WorkOrder.tender_id.in_([t.id for t in tenders] or [-1])))
    wos = wq.all()
    wo_by_tender = {w.tender_id: w for w in wos if w.tender_id}
    out = []
    for t in tenders:
        w = wo_by_tender.get(t.id)
        value = f(t.po_value) or f(t.wo_value) or (f(w.po_value) or f(w.wo_value) if w else 0) or f(t.bid_amount)
        out.append({
            "customer_id": t.customer_id, "kind": "tender", "id": t.id, "wo_id": w.id if w else None,
            "ref": (w.wo_number if w else None) or t.po_num or t.tender_num or f"TND-{t.id}",
            "title": t.tender_title or t.tender_num or "", "type": (w.wo_type if w else None) or "Supply",
            "value": value, "date": as_date(t.po_date) or as_date(t.result_date) or as_date(t.submission_date),
            "status": (w.status if w else None) or "Active", "progress": int(w.progress_percent or 0) if w else 0,
            "warranty_expiry": as_date(w.warranty_expiry) if w else None, "route": f"/workorders/{t.id}/edit",
        })
    for w in wos:
        if w.tender_id or not w.customer_id or w.status in ("Lost", "Cancelled"):
            continue
        out.append({
            "customer_id": w.customer_id, "kind": "wo", "id": w.id, "wo_id": w.id, "ref": w.wo_number,
            "title": w.project_title or w.wo_number, "type": w.wo_type or "Supply", "value": f(w.po_value) or f(w.wo_value),
            "date": as_date(w.po_date) or as_date(w.created_at), "status": w.status or "Draft",
            "progress": int(w.progress_percent or 0), "warranty_expiry": as_date(w.warranty_expiry), "route": "/workorders",
        })
    return out


def invoice_rows(db: Session, wo_ids: Iterable[int]) -> list[Any]:
    from app.models.all_models import WOInvoice
    ids = list({i for i in wo_ids if i})
    if not ids:
        return []
    try:
        return db.query(WOInvoice).filter(WOInvoice.wo_id.in_(ids)).all()
    except Exception as exc:  # invoice table missing on an old tenant
        logger.info("Invoices unavailable: %s", exc)
        db.rollback()
        return []


def milestone_rows(db: Session, wo_ids: Iterable[int]) -> list[Any]:
    from app.models.all_models import WOMilestone
    ids = list({i for i in wo_ids if i})
    if not ids:
        return []
    try:
        return db.query(WOMilestone).filter(WOMilestone.wo_id.in_(ids)).order_by(WOMilestone.wo_id, WOMilestone.id).all()
    except Exception as exc:
        logger.info("Milestones unavailable: %s", exc)
        db.rollback()
        return []


# ─── account metrics (list columns, KPI cards, health) ────────────────────────

def health_drivers(m: dict[str, Any]) -> list[tuple[str, int, str]]:
    """(name, score 0-99, what it is based on). Deterministic rules over the account's real activity."""
    # Same rules as the prototype's healthDrv(), fed with the account's recorded activity.
    acts = m["acts_12m"]
    eng = min(99, 50 + acts * 8)
    open_n = m["open_deals"] + m["live_bids"]
    pipe = min(99, 35 + open_n * 18)
    if m["due"] > 0:   # payment stages due to date (Orders & Projects payment schedule)
        delay_pen = min(12, max(0, int(m["avg_delay"] or 0)) // 5)
        pay = max(20, 92 - round(m["outstanding"] / m["due"] * 60) - delay_pen)
        pay_note = f"{round(m['outstanding'] / m['due'] * 100)}% of payments due still outstanding" + (f", paid {round(m['avg_delay'])} d after due on average" if m["avg_delay"] is not None else "")
    else:
        pay, pay_note = 75, "No payments due yet – neutral score"
    rel = min(99, 40 + m["contacts"] * 14)
    closed = m["won"] + m["lost"]
    comp = max(25, min(99, 78 - m["lost"] * 14 + m["won"] * 4))
    return [
        ("Engagement", eng, f"{acts} activities in the last 12 months"),
        ("Pipeline coverage", pipe, f"{m['open_deals']} open deals, {m['live_bids']} live bids"),
        ("Payment behaviour", pay, pay_note),
        ("Relationship depth", rel, f"{m['contacts']} active contacts"),
        ("Competitive position", comp, f"{m['won']} won, {m['lost']} lost" if closed else "No closed bids or quotes yet"),
    ]


def _empty_metrics() -> dict[str, Any]:
    return {"lifetime": 0.0, "fy": 0.0, "open_pipe": 0.0, "open_deals": 0, "live_bids": 0, "won": 0, "lost": 0, "win_rate": 0,
            "active_orders": 0, "orders": 0, "billed": 0.0, "due": 0.0, "collected": 0.0, "awaiting": 0.0, "outstanding": 0.0, "avg_delay": None,
            "guarantees": 0.0, "last_touch": None, "acts_12m": 0, "contacts": 0, "health": 0, "month_rev": defaultdict(float)}


def account_metrics(db: Session, ids: Optional[set[int]] = None) -> dict[int, dict[str, Any]]:
    """Metrics per customer id. ids=None → every customer (used for list / peer comparisons)."""
    today = today_ist()
    fy0, fy1 = fy_bounds(today)
    M: dict[int, dict[str, Any]] = defaultdict(_empty_metrics)
    flt = (lambda col, q: q.filter(col.in_(ids or [-1]))) if ids is not None else (lambda col, q: q)

    def safe(fn):
        try:
            fn()
        except Exception as exc:  # one source must not break the whole list
            logger.warning("Customer metrics source failed: %s", exc)
            db.rollback()

    def orders():
        rows = order_rows(db, ids)
        wo_cust = {}
        for o in rows:
            m = M[o["customer_id"]]
            m["lifetime"] += o["value"]
            m["orders"] += 1
            if o["date"] and fy0 <= o["date"] <= fy1:
                m["fy"] += o["value"]
            if o["date"]:
                m["month_rev"][o["date"].strftime("%Y-%m")] += o["value"]
            if o["status"] not in DONE_WO:
                m["active_orders"] += 1
            if o["wo_id"]:
                wo_cust[o["wo_id"]] = o["customer_id"]
        for inv in invoice_rows(db, wo_cust):
            cid = wo_cust.get(inv.wo_id)
            if cid is not None:
                M[cid]["billed"] += f(inv.total_amount)
        # collections – the Orders & Projects payment ledger (same figures as Collections & finance):
        # collected = Finance-acknowledged receipts, outstanding = unpaid balance of stages due to date,
        # payment delay = bank credit date − stage due date of each acknowledged receipt
        from app.services.order_payment_service import ledger
        L = ledger(db, list(wo_cust))
        delays: dict[int, list[int]] = defaultdict(list)
        for wid, a in L["orders"].items():
            cid = wo_cust.get(wid)
            if cid is not None:
                M[cid]["collected"] += a["received"]
                M[cid]["awaiting"] += a["awaiting"]
                M[cid]["outstanding"] += a["receivable"]
                M[cid]["due"] += a["due"]
        for r in L["receipts"]:
            cid = wo_cust.get(r["wo_id"])
            if cid is not None and r["status"] == "Acknowledged" and r["stage_due"] and r["credited_on"]:
                delays[cid].append((date.fromisoformat(r["credited_on"]) - date.fromisoformat(r["stage_due"])).days)
        for cid, m in M.items():
            if delays.get(cid):
                m["avg_delay"] = sum(delays[cid]) / len(delays[cid])
    safe(orders)

    def deals():
        q = db.query(Lead.customer_id, func.count(Lead.id), func.coalesce(func.sum(Lead.est_value), 0)).filter(
            Lead.is_deleted == False, Lead.customer_id.isnot(None), is_opp_expr(), Lead.status == "Opportunity Created")
        for cid, n, v in flt(Lead.customer_id, q).group_by(Lead.customer_id).all():
            M[cid]["open_deals"] += int(n); M[cid]["open_pipe"] += f(v)
    safe(deals)

    def bids():
        q = db.query(Tender.customer_id, Tender.result, Tender.tender_status, func.count(Tender.id), func.coalesce(func.sum(Tender.est_value), 0)).filter(
            Tender.is_deleted == False, Tender.customer_id.isnot(None))
        for cid, result, st, n, v in flt(Tender.customer_id, q).group_by(Tender.customer_id, Tender.result, Tender.tender_status).all():
            if result == "Won":
                M[cid]["won"] += int(n)
            elif result == "Lost":
                M[cid]["lost"] += int(n)
            elif result in (None, "Pending") and st != "Closed":
                M[cid]["live_bids"] += int(n); M[cid]["open_pipe"] += f(v)
    safe(bids)

    def quotes():
        q = db.query(Quotation.customer_id, Quotation.status, func.count(Quotation.id)).filter(Quotation.customer_id.isnot(None))
        for cid, st, n in flt(Quotation.customer_id, q).group_by(Quotation.customer_id, Quotation.status).all():
            if st == "Accepted":
                M[cid]["won"] += int(n)
            elif st == "Rejected":
                M[cid]["lost"] += int(n)
    safe(quotes)

    def guarantees():
        q = db.query(EMDBG.customer_id, func.coalesce(func.sum(EMDBG.amount), 0)).filter(EMDBG.status == "Active", EMDBG.customer_id.isnot(None))
        for cid, v in flt(EMDBG.customer_id, q).group_by(EMDBG.customer_id).all():
            M[cid]["guarantees"] += f(v)
    safe(guarantees)

    def activities():
        y = today - timedelta(days=365)
        q = db.query(KAMActivity.customer_id, func.max(KAMActivity.activity_date),
                     func.sum(case((KAMActivity.activity_date >= y, 1), else_=0))).filter(
            KAMActivity.customer_id.isnot(None), KAMActivity.activity_date <= today, KAMActivity.status != "Cancelled")
        for cid, last, n in flt(KAMActivity.customer_id, q).group_by(KAMActivity.customer_id).all():
            M[cid]["last_touch"] = as_date(last); M[cid]["acts_12m"] = int(n or 0)
    safe(activities)

    def contacts():
        q = db.query(CustomerContact.customer_id, func.count(CustomerContact.id)).filter(CustomerContact.is_active == True)
        for cid, n in flt(CustomerContact.customer_id, q).group_by(CustomerContact.customer_id).all():
            M[cid]["contacts"] = int(n)
    safe(contacts)

    for cid, m in M.items():
        closed = m["won"] + m["lost"]
        m["win_rate"] = round(m["won"] / closed * 100) if closed else 0
        m["health"] = round(sum(v for _, v, _ in health_drivers(m)) / 5)
    return M


def metrics_for(M: dict[int, dict[str, Any]], cid: int) -> dict[str, Any]:
    if cid not in M:
        m = _empty_metrics()
        m["health"] = round(sum(v for _, v, _ in health_drivers(m)) / 5)
        return m
    return M[cid]


def value_bands(customers: list[Customer], M: dict[int, dict[str, Any]]) -> dict[int, str]:
    """Strategic = top 25 % by lifetime revenue, Growth = next 35 %, Maintain = rest (no revenue → Maintain)."""
    ranked = sorted(customers, key=lambda c: -metrics_for(M, c.id)["lifetime"])
    n = max(len(ranked), 1)
    out = {}
    for i, c in enumerate(ranked):
        rev = metrics_for(M, c.id)["lifetime"]
        out[c.id] = "Maintain" if rev <= 0 else ("Strategic" if i / n < .25 else "Growth" if i / n < .6 else "Maintain")
    return out


# ─── hierarchy ────────────────────────────────────────────────────────────────

def profiles(db: Session, ids: Optional[Iterable[int]] = None) -> dict[int, CustomerProfile]:
    q = db.query(CustomerProfile)
    if ids is not None:
        q = q.filter(CustomerProfile.customer_id.in_(list(ids) or [-1]))
    return {p.customer_id: p for p in q.all()}


def level_of(c: Customer, P: dict[int, CustomerProfile]) -> str:
    p = P.get(c.id)
    if p and p.hierarchy_level in HIERARCHY_LEVELS:
        return p.hierarchy_level
    return "Branch / Site" if c.parent_account_id else "Head Office"


class Family:
    """Parent/child structure of the customers table (parent_account_id)."""

    def __init__(self, db: Session):
        rows = db.query(Customer.id, Customer.customer_name, Customer.parent_account_id, Customer.assigned_to,
                        Customer.billing_city).filter(Customer.is_deleted == False).all()
        self.by_id = {r.id: r for r in rows}
        self.kids: dict[int, list[int]] = defaultdict(list)
        for r in rows:
            if r.parent_account_id and r.parent_account_id in self.by_id and r.parent_account_id != r.id:
                self.kids[r.parent_account_id].append(r.id)

    def parent(self, cid: int) -> Optional[int]:
        r = self.by_id.get(cid)
        p = r.parent_account_id if r else None
        return p if p in self.by_id and p != cid else None

    def path(self, cid: int) -> list[int]:
        out, n, seen = [cid], cid, {cid}
        while (p := self.parent(n)) and p not in seen and len(out) < 12:
            out.insert(0, p); seen.add(p); n = p
        return out

    def root(self, cid: int) -> int:
        return self.path(cid)[0]

    def desc(self, cid: int) -> list[int]:
        out, stack, seen = [], list(self.kids.get(cid, [])), {cid}
        while stack:
            k = stack.pop(0)
            if k in seen:
                continue
            seen.add(k); out.append(k); stack[0:0] = self.kids.get(k, [])
        return out

    def kam(self, cid: int, P: dict[int, CustomerProfile]) -> tuple[Optional[int], bool, Optional[int]]:
        """(kam user id, own?, inherited-from customer id) – 'Inherit from parent' takes the nearest parent's KAM."""
        n, g = cid, 0
        while n and g < 12:
            r = self.by_id.get(n)
            prof = P.get(n)
            inherit = prof is not None and prof.kam_mode == "Inherit from parent" and self.parent(n)
            if r and r.assigned_to and not inherit:
                return r.assigned_to, n == cid, (None if n == cid else n)
            n = self.parent(n); g += 1
        return None, True, None


# ─── contacts ─────────────────────────────────────────────────────────────────

def contact_engagement(db: Session, customer_id: int, contact_ids: list[int]) -> dict[int, int]:
    """Share of the customer's activities (last 12 months) in which each contact took part, as 0-100."""
    since = today_ist() - timedelta(days=365)
    rows = db.query(KAMActivity.contacts_met).filter(KAMActivity.customer_id == customer_id, KAMActivity.activity_date >= since,
                                                     KAMActivity.status != "Cancelled").all()
    total = len(rows)
    hits: Counter = Counter()
    for (raw,) in rows:
        try:
            met = json.loads(raw) if isinstance(raw, str) else (raw or [])
        except ValueError:
            met = []
        for x in met if isinstance(met, list) else []:
            try:
                hits[int(x if not isinstance(x, dict) else x.get("id"))] += 1
            except (TypeError, ValueError):
                continue
    return {cid: (round(hits[cid] / total * 100) if total else 0) for cid in contact_ids}


def contact_list(db: Session, customer_id: int) -> list[dict[str, Any]]:
    rows = (db.query(CustomerContact).filter(CustomerContact.customer_id == customer_id, CustomerContact.is_active == True)
            .order_by(CustomerContact.is_primary.desc(), CustomerContact.id.asc()).all())
    roles = {r.contact_id: r.buying_role for r in db.query(CustomerContactRole).filter(CustomerContactRole.customer_id == customer_id).all()}
    eng = contact_engagement(db, customer_id, [r.id for r in rows])
    return [{
        "id": r.id, "name": r.contact_name, "designation": r.designation or "", "department": r.department or "",
        "buying_role": roles.get(r.id), "engagement": eng.get(r.id, 0), "phone": r.mobile or r.office_phone or "",
        "email": r.office_email or r.personal_email or "", "is_primary": bool(r.is_primary),
    } for r in rows]


__all__ = ["account_metrics", "ensure_schema", "ensure_schema_all_tenants", "health_drivers", "order_rows", "value_bands", "Family",
           "BUYING_ROLES", "HIERARCHY_LEVELS", "TIER_OF", "POTENTIAL_OF", "STATUSES", "VALUE_BANDS", "LEVEL_BADGE", "OPEN_QUOTE",
           "ApprovalRequest"]
