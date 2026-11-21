"""
Dashboard analytics for the CRM application dashboards (Bidwise prototype v9).

Every board metric and every drill-down list is built from the same "source" definitions below, so a KPI value and
the records behind it always use one filter and one business definition. All queries are grouped aggregations or a
single scoped SELECT per source (no per-row lookups); record scope comes from the role's Dashboard data visibility.

Business definitions (documented here because several are derived, not stored):
  Deal            – a lead that became an opportunity: lead_type 'direct_opportunity', an opportunity date, or the
                    'Opportunity Created' / 'Converted' status.
  Deal stage      – Opportunity / Request Conversion (approval pending) / Rejected (approval rejected) / Converted,
                    the stages the Opportunities module shows.
  Deal outcome    – Won when the converted tender's result is Won, a quotation for it is Accepted / Won, or a work
                    order exists for it. Lost when lost_at is set, the converted tender is Lost, or its quotations
                    were only Rejected / Lost. Otherwise open.
  Days in stage   – today minus the last stage change recorded in audit_logs (status_change / convert / qualify),
                    falling back to the date the opportunity was created.
  Booked revenue  – won tenders, valued at the bid amount (estimated value when no bid amount), dated by result
                    date (submission date, then creation date, when the result date is empty).
  Active order    – a work order whose status is not Completed / Closed / Cancelled / Lost.
  Billed          – wo_invoices.total_amount. Collected / awaiting / outstanding – Orders & Projects payment ledger
                    (order_payment_service.ledger): acknowledged receipts, pending receipts, unpaid stage balance due to date.
  Win probability – not configured anywhere in the CRM, so weighted pipeline and forecast categories are reported
                    as unavailable instead of being estimated.
"""
from __future__ import annotations

import logging
import threading
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from typing import Any, Callable, Iterable, Optional

from sqlalchemy import and_, func, or_, text
from sqlalchemy.orm import Session

from app.models.all_models import (
    Approval, ApprovalRequest, ApprovalRequestStep, Customer, EMDBG, KAMActivity, KAMTarget, KAMTaskAssignment, Lead,
    LeadSource, LoginLog, Quotation, SalesCustomerAssignment, Tender, TenderProduct, User, UserSession, WOInvoice,
    WorkOrder,
)

logger = logging.getLogger(__name__)

PERIODS = ("FY", "QTR", "MTD")
CLOSED_WO = ("Completed", "Closed", "Cancelled", "Lost")
FOLLOW_ON_EXCLUDE = ("supply", "project", "project / supply", "project/supply", "")
DEAL_STAGES = ("Opportunity", "Request Conversion", "Rejected", "Converted")
DONE_TASK = ("completed", "closed", "cancelled", "done")
INACTIVE_DAYS = 14
STALLED_DAYS = 21
DEFAULT_APPROVAL_SLA_HOURS = 72


def period_range(period: str, today: date) -> tuple[date, date]:
    if period == "QTR":
        return today - timedelta(days=90), today
    if period == "MTD":
        return today - timedelta(days=30), today
    start = date(today.year if today.month >= 4 else today.year - 1, 4, 1)
    return start, today


def month_keys(today: date, n: int = 6) -> list[str]:
    out, y, m = [], today.year, today.month
    for _ in range(n):
        out.append(f"{y:04d}-{m:02d}")
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return out[::-1]


def month_labels(keys: list[str]) -> list[str]:
    return [date(int(k[:4]), int(k[5:7]), 15).strftime("%b") for k in keys]


def _d(v) -> Optional[date]:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return datetime.fromisoformat(str(v)[:19]).date()
    except ValueError:
        return None


def _iso(v) -> Optional[str]:
    return v.isoformat() if isinstance(v, (date, datetime)) else (str(v) if v else None)


def _f(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def pct(a: float, b: float) -> int:
    return int(round(a / b * 100)) if b else 0


class Ctx:
    """Request context: tenant session, user, dashboard scope (None = all users) and the selected period."""

    def __init__(self, db: Session, cu: User, scope: Optional[list[int]], period: str, today: date, perms: set[str]):
        self.db, self.cu, self.scope, self.today, self.perms = db, cu, scope, today, perms
        self.period = period if period in PERIODS else "FY"
        self.d_from, self.d_to = period_range(self.period, today)
        self._memo: dict[str, Any] = {}

    def can(self, key: str) -> bool:
        return key in self.perms

    def memo(self, key: str, fn: Callable[[], Any]):
        if key not in self._memo:
            self._memo[key] = fn()
        return self._memo[key]

    def owned(self, *cols):
        """Filter clause limiting rows to the dashboard scope through any of the given owner columns."""
        if self.scope is None:
            return True
        return or_(*[c.in_(self.scope) for c in cols])

    def in_period(self, d) -> bool:
        x = _d(d)
        return bool(x and self.d_from <= x <= self.d_to)


def user_names(db: Session, ids: Iterable[Optional[int]]) -> dict[int, str]:
    ids = {int(i) for i in ids if i}
    if not ids:
        return {}
    return {int(u.id): (u.full_name or u.username or f"User {u.id}") for u in db.query(User.id, User.full_name, User.username).filter(User.id.in_(ids)).all()}


# ─── Sources ─────────────────────────────────────────────────────────────────

def leads(ctx: Ctx) -> list[dict]:
    """All leads (not direct opportunities) in scope, with source name and owner."""
    def build():
        rows = (ctx.db.query(Lead.id, Lead.lead_ref_id, Lead.lead_title, Lead.customer_name, Lead.status, Lead.est_value,
                             Lead.assigned_to, Lead.created_by, Lead.lead_created_at, Lead.created_at, Lead.opportunity_created_at,
                             Lead.lost_at, LeadSource.name)
                .outerjoin(LeadSource, LeadSource.id == Lead.source_id)
                .filter(Lead.is_deleted == False, or_(Lead.lead_type.is_(None), Lead.lead_type != "direct_opportunity"),
                        ctx.owned(Lead.assigned_to, Lead.created_by))
                .all())
        names = user_names(ctx.db, (r.assigned_to for r in rows))
        out = []
        for r in rows:
            status = r.status or "New"
            converted = bool(r.opportunity_created_at) or status in ("Opportunity Created", "Converted")
            out.append({
                "id": r.id, "ref": r.lead_ref_id or f"L-{r.id}", "title": r.lead_title or "", "customer": r.customer_name or "",
                "status": status, "value": _f(r.est_value), "source": r.name or "Unspecified",
                "owner": names.get(int(r.assigned_to)) if r.assigned_to else None, "owner_id": r.assigned_to,
                "created": _iso(_d(r.lead_created_at) or _d(r.created_at)), "converted": converted,
                "open": not converted and not r.lost_at and status not in ("Lost", "Disqualified", "Closed"),
                "qualified_plus": converted or status in ("Qualified", "Proposal", "Nurturing"),
            })
        return out
    return ctx.memo("leads", build)


# ─── v17 module data ────────────────────────────────────────────────────────────
# Deals, bids, quotes and orders come from the same services as their v17 modules (Deals, Bids & Tenders, Quotes, Orders &
# Projects): stages and outcomes follow the tenant's Process Designer pipelines, and each module's own Data Visibility applies.
# The dashboard's Data Visibility is applied on top (owner / creator in scope), so a dashboard never shows more than the module.

def _v17(ctx: Ctx):
    def build():
        from app.services import analytics_v17_service as A
        return A.ctx(ctx.db, ctx.cu, None)
    return ctx.memo("v17ctx", build)


def _keep(ctx: Ctx, rows: list[dict], model, owner_keys: tuple[str, ...]) -> list[dict]:
    """Dashboard Data Visibility: rows owned (any owner key) or created by a user in scope."""
    if ctx.scope is None:
        return rows
    sc = set(ctx.scope)
    created = dict(ctx.db.query(model.id, model.created_by).filter(model.id.in_([r["id"] for r in rows] or [-1])).all()) \
        if hasattr(model, "created_by") else {}
    return [r for r in rows if any(r.get(k) in sc for k in owner_keys) or created.get(r["id"]) in sc]


def _outcome(kind) -> str:
    return "Won" if kind == "won" else "Lost" if kind == "lost" else "Open"


def _has(ctx: Ctx, key: str) -> bool:
    from app.dependencies import user_has_permission
    return user_has_permission(ctx.db, ctx.cu, key)


def deal_pipelines(ctx: Ctx) -> list[dict]:
    deals(ctx)
    return _v17(ctx).cache.get("pipes", []) or []


def deal_open_stages(ctx: Ctx) -> list[str]:
    """Open deal stages in pipeline order (Process Designer), then any other open stage a deal sits in."""
    out: list[str] = []
    for p in deal_pipelines(ctx):
        for st in p.get("stages", []):
            if st.get("kind") == "open" and st.get("name") not in out:
                out.append(st["name"])
    for d in deals(ctx):
        if d["outcome"] == "Open" and d["stage"] not in out:
            out.append(d["stage"])
    return out


def deals(ctx: Ctx) -> list[dict]:
    """Deals in scope (Deals module rows), with outcome from the stage kind and days in the current stage."""
    def build():
        from app.services import reports_v17_data as RD
        rows = _keep(ctx, RD.deals(_v17(ctx)), Lead, ("owner_id",))
        out = []
        for r in rows:
            since = _d(r.get("stage_since"))
            out.append({
                "id": r["id"], "ref": r.get("ref") or "", "name": r.get("name") or r.get("ref") or f"Deal {r['id']}", "customer": r.get("customer") or "",
                "value": _f(r.get("value")), "stage": r.get("stage") or "—", "outcome": _outcome(r.get("stage_kind")),
                "type": "Tender" if "tender" in str(r.get("flow") or "").lower() else "Quotation", "prob": r.get("prob"),
                "owner": r.get("owner") or None, "owner_id": r.get("owner_id"), "customer_id": r.get("customer_id"),
                "created": _iso(_d(r.get("created"))), "close": _iso(_d(r.get("closed"))),
                "stage_since": _iso(since), "days_in_stage": (ctx.today - since).days if since else None,
                "journey": r.get("jid") or r.get("ref") or "", "vertical": r.get("vertical") or "", "model": r.get("model") or "",
            })
        return out
    return ctx.memo("deals", build)


def tenders(ctx: Ctx) -> list[dict]:
    """Bids in scope (Bids & Tenders module rows); result from the stage kind, booked value = bid amount when recorded."""
    def build():
        from app.services import reports_v17_data as RD
        rows = _keep(ctx, RD.bids(_v17(ctx)), Tender, ("owner_id",))
        q = ctx.db.query(Tender.id, Tender.bid_amount, Tender.created_at).filter(Tender.id.in_([r["id"] for r in rows] or [-1])).all()
        bid = {i: _f(a) for i, a, _ in q}
        made = {i: c for i, _, c in q}
        out = []
        for r in rows:
            sub = _d(r.get("submit"))
            result = {"won": "Won", "lost": "Lost"}.get(r.get("stage_kind"), "Pending")
            out.append({
                "id": r["id"], "num": r.get("ref") or f"T-{r['id']}", "title": r.get("title") or "", "customer": r.get("customer") or "",
                "customer_id": r.get("customer_id"), "stage": r.get("stage") or "—", "result": result, "portal": r.get("portal") or "Unspecified",
                "value": _f(r.get("value")), "bid": bid.get(r["id"], 0.0), "deadline": _iso(sub),
                "days_left": (sub - ctx.today).days if sub else None, "published": _iso(_d(r.get("published"))),
                "decided": _iso(_d(r.get("decided"))) if result in ("Won", "Lost") else None,
                "manager": r.get("owner") or None, "manager_id": r.get("owner_id"), "live": r.get("stage_kind") == "open",
                "journey": r.get("jid") or "", "vertical": r.get("vertical") or "", "created_at": made.get(r["id"]),
            })
        return out
    return ctx.memo("tenders", build)


def quotes(ctx: Ctx) -> list[dict]:
    """Quotes in scope (Quotes module rows: latest revision, stage from the quote flow)."""
    def build():
        if not _has(ctx, "quotations.view"):
            return []
        from app.models.all_models import Quotation as Q
        from app.services import quote_service as QS
        try:
            rows, _ = QS.list_rows(ctx.db, ctx.cu)
        except Exception as exc:
            ctx.db.rollback()
            logger.info("quotes unavailable for the dashboard: %s", exc)
            return []
        return [{**r, "outcome": _outcome(r.get("stage_kind"))} for r in _keep(ctx, rows, Q, ("owner_id",))]
    return ctx.memo("quotes", build)


def booked_value(t: dict) -> float:
    return t["bid"] or t["value"]


def guarantees(ctx: Ctx) -> list[dict]:
    def build():
        from app.routers.dashboard_router import _scope_emdbg
        q = _scope_emdbg(ctx.db.query(EMDBG.id, EMDBG.reference_num, EMDBG.instrument_type, EMDBG.client_name, EMDBG.tender_num,
                                      EMDBG.amount, EMDBG.bank_name, EMDBG.expiry_date, EMDBG.status), ctx.db, ctx.cu)
        out = []
        for r in q.all():
            exp = _d(r.expiry_date)
            out.append({"id": r.id, "ref": r.reference_num or f"G-{r.id}", "type": r.instrument_type or "Other", "customer": r.client_name or "",
                        "bid": r.tender_num or "", "amount": _f(r.amount), "bank": r.bank_name or "", "valid_until": _iso(exp),
                        "days_left": (exp - ctx.today).days if exp else None, "status": r.status or "Active"})
        return out
    return ctx.memo("guarantees", build)


def orders(ctx: Ctx) -> list[dict]:
    """Orders in scope (Orders & Projects module rows) with invoiced / paid totals (one grouped invoice query)."""
    def build():
        from app.services import reports_v17_data as RD
        db = ctx.db
        rows = _keep(ctx, RD.orders(_v17(ctx)), WorkOrder, ("pm_id",))
        ids = [r["id"] for r in rows]
        inv = {}
        if ids:
            for wo_id, tot, paid in db.query(WOInvoice.wo_id, func.sum(WOInvoice.total_amount), func.sum(WOInvoice.paid_amount)).filter(WOInvoice.wo_id.in_(ids)).group_by(WOInvoice.wo_id).all():
                inv[wo_id] = (_f(tot), _f(paid))
        led = ledger(ctx)["orders"]
        out = []
        for r in rows:
            value = _f(r.get("value"))
            invoiced, paid = inv.get(r["id"], (0.0, 0.0))
            lg = led.get(r["id"], {})
            active = r.get("stage_kind") == "open"
            progress = int(r.get("progress") or 0)
            billed_pct = min(100, pct(invoiced, value)) if value else 0
            otype = r.get("type") or "Unspecified"
            out.append({
                "id": r["id"], "number": r.get("ref") or f"WO-{r['id']}", "title": r.get("title") or r.get("ref") or f"Order {r['id']}",
                "customer": r.get("customer") or "", "customer_id": r.get("customer_id"), "type": otype, "stage": r.get("stage") or "—",
                "progress": progress, "value": value, "invoiced": invoiced, "paid": paid, "billed_pct": billed_pct,
                "received": lg.get("received", 0.0), "awaiting": lg.get("awaiting", 0.0), "receivable": lg.get("receivable", 0.0),
                "gap": max(0, progress - billed_pct), "due": _iso(_d(r.get("due"))), "pm": r.get("pm") or None,
                "active": active, "delayed": active and bool(r.get("delayed")),
                "follow_on": otype.strip().lower() not in FOLLOW_ON_EXCLUDE,
            })
        return out
    return ctx.memo("orders", build)


def ledger(ctx: Ctx) -> dict:
    """Orders & Projects payment ledger for the orders in scope – the same stages / receipts as Collections & finance."""
    def build():
        from app.services import reports_v17_data as RD
        from app.services.order_payment_service import ledger as _ledger
        ids = [r["id"] for r in _keep(ctx, RD.orders(_v17(ctx)), WorkOrder, ("pm_id",))]
        return _ledger(ctx.db, ids)
    return ctx.memo("pay_ledger", build)


def payments(ctx: Ctx) -> list[dict]:
    """Payment stages of the orders in scope (receivables: balance due to date, aged by days past the stage due date)."""
    return ledger(ctx)["stages"]


def receipts(ctx: Ctx) -> list[dict]:
    """Customer receipts of the orders in scope; collected = status Acknowledged, dated by the bank credit date."""
    return ledger(ctx)["receipts"]


def invoices(ctx: Ctx) -> list[dict]:
    def build():
        order_by_id = {o["id"]: o for o in orders(ctx)}
        if not order_by_id:
            return []
        rows = ctx.db.query(WOInvoice).filter(WOInvoice.wo_id.in_(list(order_by_id))).all()
        out = []
        for r in rows:
            o = order_by_id.get(r.wo_id, {})
            total, paid = _f(getattr(r, "total_amount", 0)) or _f(r.amount), _f(getattr(r, "paid_amount", 0))
            inv_date = _d(getattr(r, "invoice_date", None))
            status = getattr(r, "payment_status", None) or ("Paid" if paid >= total and total else "Unpaid")
            outstanding = 0.0 if str(status).lower() == "paid" else max(0.0, total - paid)
            out.append({"id": r.id, "number": r.invoice_number or f"INV-{r.id}", "order": o.get("number"), "customer": o.get("customer", ""),
                        "invoice_date": _iso(inv_date), "due_date": _iso(_d(getattr(r, "due_date", None))), "total": total, "paid": paid,
                        "paid_date": _iso(_d(getattr(r, "paid_date", None))), "status": status, "outstanding": outstanding,
                        "age": (ctx.today - inv_date).days if inv_date else None})
        return out
    return ctx.memo("invoices", build)


def approvals_pending(ctx: Ctx) -> list[dict]:
    """Pending approvals from the approval engine and the legacy approvals table, visible to this user."""
    def build():
        db, me = ctx.db, int(ctx.cu.id)
        items = []
        reqs = db.query(ApprovalRequest).filter(ApprovalRequest.status == "pending").all()
        step_rows = db.query(ApprovalRequestStep.approval_request_id, ApprovalRequestStep.approver_user_id, ApprovalRequestStep.status,
                             ApprovalRequestStep.assigned_at, ApprovalRequestStep.escalated_at).filter(
            ApprovalRequestStep.approval_request_id.in_([r.id for r in reqs] or [0])).all()
        steps = defaultdict(list)
        for s in step_rows:
            steps[s.approval_request_id].append(s)
        for r in reqs:
            approvers = {int(x) for x in (r.approver_user_ids or []) if str(x).isdigit()} if isinstance(r.approver_user_ids, list) else set()
            approvers |= {int(s.approver_user_id) for s in steps[r.id] if s.approver_user_id}
            mine_to_act = any(int(s.approver_user_id or 0) == me and s.status == "pending" for s in steps[r.id]) or (not steps[r.id] and me in approvers)
            if ctx.scope is not None and int(r.requested_by or 0) not in ctx.scope and me not in approvers:
                continue
            pend = [s for s in steps[r.id] if s.status == "pending"]
            items.append({"key": f"r{r.id}", "module": r.module_key or "", "record_id": r.record_id, "by_id": r.requested_by,
                          "requested_at": r.requested_at, "escalated": any(s.escalated_at for s in pend), "mine": mine_to_act,
                          "rule_id": r.approval_rule_id})
        legacy_q = db.query(Approval).filter(Approval.status == "pending")
        for a in legacy_q.all():
            if ctx.scope is not None and int(a.requested_by or 0) not in ctx.scope and int(a.requested_to or 0) != me:
                continue
            items.append({"key": f"a{a.id}", "module": a.module or "", "record_id": a.record_id, "by_id": a.requested_by,
                          "requested_at": a.created_at, "escalated": False, "mine": int(a.requested_to or 0) == me, "rule_id": None,
                          "ref": a.record_ref})
        # Values and titles per module, one grouped query each.
        by_mod = defaultdict(set)
        for it in items:
            by_mod[it["module"].lower()].add(it["record_id"])
        info: dict[tuple[str, int], tuple[str, float]] = {}
        def grab(mods, model, title_col, value_col):
            ids = set().union(*[by_mod.get(m, set()) for m in mods])
            if not ids:
                return
            for rid, title, value in db.query(model.id, title_col, value_col).filter(model.id.in_(ids)).all():
                for m in mods:
                    info[(m, rid)] = (title or "", _f(value))
        grab(("leads", "lead", "opportunities", "opportunity"), Lead, Lead.lead_title, Lead.est_value)
        grab(("tenders", "tender"), Tender, Tender.tender_num, Tender.est_value)
        grab(("quotations", "quotation"), Quotation, Quotation.quotation_number, Quotation.total_amount)
        grab(("emdbg", "emd", "emd_bg"), EMDBG, EMDBG.reference_num, EMDBG.amount)
        grab(("workorders", "work_orders", "workorder"), WorkOrder, WorkOrder.wo_number, func.coalesce(WorkOrder.wo_value, WorkOrder.po_value))
        sla = {}
        rule_ids = {it["rule_id"] for it in items if it["rule_id"]}
        if rule_ids:
            for rid, hrs in db.execute(text(f"SELECT id, escalation_hours FROM approval_rules WHERE id IN ({','.join(str(int(i)) for i in rule_ids)})")).fetchall():
                sla[int(rid)] = int(hrs or 0) or DEFAULT_APPROVAL_SLA_HOURS
        names = user_names(db, (it["by_id"] for it in items))
        now = datetime.now()
        out = []
        for it in items:
            mod = it["module"].lower()
            title, value = info.get((mod, it["record_id"]), (it.get("ref") or "", 0.0))
            label = mod.replace("_", " ").title() if mod else "Request"
            req_at = it["requested_at"]
            hours = sla.get(it["rule_id"], DEFAULT_APPROVAL_SLA_HOURS)
            overdue = bool(it["escalated"] or (req_at and (now - req_at).total_seconds() > hours * 3600))
            out.append({"id": it["key"], "title": f"{label} · {title}".strip(" ·") if title else f"{label} #{it['record_id']}", "module": mod,
                        "record_id": it["record_id"], "by": names.get(int(it["by_id"])) if it["by_id"] else None, "value": value,
                        "status": "Overdue" if overdue else "Pending", "requested_at": _iso(req_at), "overdue": overdue, "mine": it["mine"]})
        out.sort(key=lambda x: x["requested_at"] or "", reverse=True)
        return out
    return ctx.memo("approvals", build)


def activities(ctx: Ctx, days: int = 14) -> list[dict]:
    def build():
        since = ctx.today - timedelta(days=days - 1)
        rows = (ctx.db.query(KAMActivity.id, KAMActivity.user_id, KAMActivity.activity_type, KAMActivity.subject, KAMActivity.status,
                             KAMActivity.activity_date, Customer.customer_name)
                .outerjoin(Customer, Customer.id == KAMActivity.customer_id)
                .filter(KAMActivity.activity_date >= since, KAMActivity.activity_date <= ctx.today,
                        KAMActivity.status != "Cancelled", ctx.owned(KAMActivity.user_id))
                .all())
        names = user_names(ctx.db, (r.user_id for r in rows))
        return [{"id": r.id, "kam_id": r.user_id, "kam": names.get(int(r.user_id or 0), "—"), "type": r.activity_type or "Other",
                 "subject": r.subject or "", "status": r.status or "", "date": _iso(_d(r.activity_date)), "customer": r.customer_name or ""} for r in rows]
    return ctx.memo(f"activities{days}", build)


def recent_activity(ctx: Ctx, limit: int = 5) -> list[dict]:
    rows = (ctx.db.query(KAMActivity.id, KAMActivity.user_id, KAMActivity.activity_type, KAMActivity.subject, KAMActivity.activity_date,
                         KAMActivity.created_at, Customer.customer_name)
            .outerjoin(Customer, Customer.id == KAMActivity.customer_id)
            .filter(KAMActivity.status != "Cancelled", KAMActivity.activity_date <= ctx.today, ctx.owned(KAMActivity.user_id))
            .order_by(KAMActivity.activity_date.desc(), KAMActivity.id.desc()).limit(limit).all())
    names = user_names(ctx.db, (r.user_id for r in rows))
    return [{"id": r.id, "type": r.activity_type or "Activity", "customer": r.customer_name or r.subject or "", "kam": names.get(int(r.user_id or 0), "—"),
             "date": _iso(_d(r.activity_date))} for r in rows]


def kams(ctx: Ctx) -> list[dict]:
    """Account managers in scope: anyone with a sales target, recent activity, owned deals or bids."""
    def build():
        db = ctx.db
        year = str(ctx.today.year)
        tq = db.query(KAMTarget.user_id, func.sum(KAMTarget.sales_target)).filter(
            or_(KAMTarget.period == year, KAMTarget.period.like(f"{year}-%")), ctx.owned(KAMTarget.user_id)).group_by(KAMTarget.user_id)
        targets = {int(u): _f(v) for u, v in tq.all() if u}
        acts = activities(ctx)
        D, T = deals(ctx), tenders(ctx)
        ids = set(targets) | {a["kam_id"] for a in acts if a["kam_id"]} | {d["owner_id"] for d in D if d["owner_id"]} | {t["manager_id"] for t in T if t["manager_id"]}
        if ctx.scope is not None:
            ids &= set(ctx.scope)
        if not ids:
            return []
        users = db.query(User.id, User.full_name, User.username, User.role).filter(User.id.in_(ids), User.is_active == True,
                                                                                    ~func.lower(User.role).in_(("admin", "super_admin"))).all()
        cust = defaultdict(set)
        for uid, cid in db.query(SalesCustomerAssignment.user_id, SalesCustomerAssignment.customer_id).filter(
                SalesCustomerAssignment.is_active == True, SalesCustomerAssignment.user_id.in_(ids)).all():
            cust[int(uid)].add(cid)
        for uid, cid in db.query(Customer.assigned_to, Customer.id).filter(Customer.is_deleted == False, Customer.assigned_to.in_(ids)).all():
            cust[int(uid)].add(cid)
        out = []
        for u in users:
            uid = int(u.id)
            mine_t = [t for t in T if t["manager_id"] == uid]
            won = [t for t in mine_t if t["result"] == "Won" and ctx.in_period(t["decided"])]
            dec_w = sum(1 for t in mine_t if t["result"] == "Won")
            dec_l = sum(1 for t in mine_t if t["result"] == "Lost")
            a = [x for x in acts if x["kam_id"] == uid]
            target = targets.get(uid, 0.0)
            achieved = sum(booked_value(t) for t in won)
            out.append({"id": uid, "name": u.full_name or u.username, "role": u.role, "target": target, "achieved": achieved,
                        "achieved_pct": pct(achieved, target) if target else None,
                        "pipeline": sum(d["value"] for d in D if d["owner_id"] == uid and d["outcome"] == "Open"),
                        "activities": len(a), "visits": sum(1 for x in a if "visit" in x["type"].lower()),
                        "win_rate": pct(dec_w, dec_w + dec_l) if dec_w + dec_l else None, "customers": len(cust[uid])})
        out.sort(key=lambda k: (k["achieved_pct"] if k["achieved_pct"] is not None else -1, k["achieved"]), reverse=True)
        return out
    return ctx.memo("kams", build)


# ─── Login & security ───────────────────────────────────────────────────────

def _os_group(device: str) -> str:
    d = (device or "").lower()
    if "dart" in d or "okhttp" in d or "mobile app" in d:
        return "Mobile app"
    if "iphone" in d or "ipad" in d or "ios" in d:
        return "iOS"
    if "android" in d:
        return "Android"
    if "mac" in d:
        return "macOS"
    if "windows" in d:
        return "Windows"
    if "linux" in d or "ubuntu" in d:
        return "Linux"
    return "Other"


def _is_mobile(device: str) -> bool:
    return _os_group(device) in ("Mobile app", "iOS", "Android")


def mask_ip(ip: Optional[str]) -> str:
    if not ip:
        return ""
    parts = ip.split(".")
    return ".".join(parts[:2] + ["x", "x"]) if len(parts) == 4 else ip[: max(4, len(ip) // 2)] + "…"


def login_users(ctx: Ctx) -> dict[int, Any]:
    def build():
        q = ctx.db.query(User.id, User.full_name, User.username, User.role, User.last_login, User.is_active).filter(User.is_active == True)
        if ctx.scope is not None:
            q = q.filter(User.id.in_(ctx.scope))
        return {int(u.id): u for u in q.all()}
    return ctx.memo("login_users", build)


def login_events(ctx: Ctx, days: int = 14) -> dict:
    """Successful sessions, failed attempts and OTP use over the window, from user_sessions / login_logs."""
    def build():
        db = ctx.db
        users = login_users(ctx)
        since = datetime.combine(ctx.today - timedelta(days=days - 1), datetime.min.time())
        uid_filter = (lambda col: col.in_(list(users))) if ctx.scope is not None else (lambda col: True)
        sess = (db.query(UserSession.id, UserSession.user_id, UserSession.device, UserSession.ip_address, UserSession.login_time,
                         UserSession.last_active, UserSession.logout_time, UserSession.revoked_at, UserSession.revoke_reason, UserSession.is_active)
                .filter(UserSession.login_time >= since, uid_filter(UserSession.user_id)).all())
        logs = (db.query(LoginLog.id, LoginLog.user_id, LoginLog.username, LoginLog.ip_address, LoginLog.success, LoginLog.created_at)
                .filter(LoginLog.created_at >= since, uid_filter(LoginLog.user_id) if ctx.scope is not None else True).all())
        otp = defaultdict(list)
        for uid, ts in db.execute(text("SELECT user_id, consumed_at FROM login_otp_challenges WHERE consumed_at >= :s"), {"s": since}).fetchall():
            if uid and ts:
                otp[int(uid)].append(ts)
        return {"sessions": sess, "logs": logs, "otp": otp, "since": since}
    return ctx.memo(f"login{days}", build)


def session_minutes(s) -> Optional[int]:
    end = s.logout_time or s.revoked_at or s.last_active
    if not (s.login_time and end):
        return None
    return max(0, int((end - s.login_time).total_seconds() // 60))


def login_history(ctx: Ctx) -> list[dict]:
    """One row per sign-in: successful sessions plus failed attempts (prototype Login history columns)."""
    def build():
        ev, users = login_events(ctx), login_users(ctx)
        show_ip = ctx.can("users.manage") or ctx.can("audit_logs.view")
        out = []
        for s in ev["sessions"]:
            u = users.get(int(s.user_id or 0))
            method = "Password + OTP" if any(abs((t - s.login_time).total_seconds()) <= 900 for t in ev["otp"].get(int(s.user_id or 0), [])) else "Password"
            result = s.revoke_reason and f"Revoked – {s.revoke_reason}" or ("Active" if s.is_active and s.last_active and (datetime.now() - s.last_active).total_seconds() < 900 else "Success")
            out.append({"id": f"s{s.id}", "user": (u.full_name or u.username) if u else f"User {s.user_id}", "user_id": s.user_id,
                        "role": u.role if u else "", "at": _iso(s.login_time), "date": _iso(_d(s.login_time)), "time": s.login_time.strftime("%H:%M") if s.login_time else "",
                        "device": s.device or "", "os": _os_group(s.device or ""), "ip": (s.ip_address or "") if show_ip else mask_ip(s.ip_address),
                        "location": None, "method": method, "minutes": session_minutes(s), "result": result, "ok": True})
        for l in ev["logs"]:
            if l.success:
                continue
            u = users.get(int(l.user_id or 0))
            out.append({"id": f"f{l.id}", "user": (u.full_name or u.username) if u else (l.username or "Unknown user"), "user_id": l.user_id,
                        "role": u.role if u else "", "at": _iso(l.created_at), "date": _iso(_d(l.created_at)), "time": l.created_at.strftime("%H:%M") if l.created_at else "",
                        "device": "", "os": "", "ip": (l.ip_address or "") if show_ip else mask_ip(l.ip_address), "location": None, "method": "Password",
                        "minutes": None, "result": "Failed – wrong credentials", "ok": False})
        out.sort(key=lambda x: x["at"] or "", reverse=True)
        return out
    return ctx.memo("login_history", build)


def security_signals(ctx: Ctx) -> list[dict]:
    """Repeated failures, off-hours sign-ins, sign-ins from an IP not seen in the previous 30 days, revoked sessions."""
    def build():
        ev, users, db = login_events(ctx), login_users(ctx), ctx.db
        show_ip = ctx.can("users.manage") or ctx.can("audit_logs.view")
        sig = []
        fails = Counter((l.username or str(l.user_id), _d(l.created_at)) for l in ev["logs"] if not l.success)
        for (who, day), n in fails.items():
            if n >= 3:
                sig.append({"kind": "Repeated failed sign-ins", "user": who, "date": _iso(day), "detail": f"{n} failed attempts", "severity": "high", "ip": ""})
        for s in ev["sessions"]:
            u = users.get(int(s.user_id or 0))
            name = (u.full_name or u.username) if u else f"User {s.user_id}"
            if s.login_time and (s.login_time.hour < 6 or s.login_time.hour >= 22):
                sig.append({"kind": "Off-hours sign-in", "user": name, "date": _iso(s.login_time), "detail": s.login_time.strftime("%H:%M"),
                            "severity": "medium", "ip": (s.ip_address or "") if show_ip else mask_ip(s.ip_address)})
            if s.revoke_reason:
                sig.append({"kind": "Session revoked", "user": name, "date": _iso(s.revoked_at or s.login_time), "detail": s.revoke_reason,
                            "severity": "medium", "ip": (s.ip_address or "") if show_ip else mask_ip(s.ip_address)})
        # New IP: first seen in the last 7 days for a user who already signed in from elsewhere in the 30 days before.
        week = datetime.combine(ctx.today - timedelta(days=6), datetime.min.time())
        uids = {int(s.user_id) for s in ev["sessions"] if s.user_id and s.login_time and s.login_time >= week}
        if uids:
            first_seen = db.execute(text(
                f"SELECT user_id, ip_address, MIN(login_time) FROM user_sessions WHERE user_id IN ({','.join(str(i) for i in uids)}) "
                "AND login_time >= :since GROUP BY user_id, ip_address"), {"since": week - timedelta(days=30)}).fetchall()
            by_user = defaultdict(list)
            for uid, ip, ts in first_seen:
                by_user[int(uid)].append((ip, ts))
            for uid, pairs in by_user.items():
                older = [p for p in pairs if p[1] < week]
                if not older:
                    continue
                for ip, ts in pairs:
                    if ts >= week and ip:
                        u = users.get(uid)
                        sig.append({"kind": "New IP address", "user": (u.full_name or u.username) if u else f"User {uid}", "date": _iso(ts),
                                    "detail": "First sign-in from this address in 30 days", "severity": "medium", "ip": ip if show_ip else mask_ip(ip)})
        sig.sort(key=lambda x: x["date"] or "", reverse=True)
        for i, s in enumerate(sig):
            s["id"] = f"sig{i}"
        return sig
    return ctx.memo("signals", build)


def inactive_users(ctx: Ctx) -> list[dict]:
    def build():
        users = login_users(ctx)
        cutoff = datetime.now() - timedelta(days=INACTIVE_DAYS)
        last_ok = dict(ctx.db.query(LoginLog.user_id, func.max(LoginLog.created_at)).filter(
            LoginLog.success == True, LoginLog.user_id.in_(list(users) or [0])).group_by(LoginLog.user_id).all())
        out = []
        for uid, u in users.items():
            seen = max([x for x in (last_ok.get(uid), u.last_login) if x], default=None)
            if not seen or seen < cutoff:
                out.append({"id": uid, "name": u.full_name or u.username, "role": u.role or "", "last_login": _iso(seen)})
        out.sort(key=lambda x: x["last_login"] or "")
        return out
    return ctx.memo("inactive", build)


# ─── Boards ──────────────────────────────────────────────────────────────────

def _bucket_months(rows: Iterable[dict], date_key: str, keys: list[str], value: Callable[[dict], float] = lambda r: 1) -> list[float]:
    idx = {k: i for i, k in enumerate(keys)}
    out = [0.0] * len(keys)
    for r in rows:
        k = str(r.get(date_key) or "")[:7]
        if k in idx:
            out[idx[k]] += value(r)
    return out


def needs_attention(ctx: Ctx) -> list[dict]:
    T, G, A = tenders(ctx), guarantees(ctx), approvals_pending(ctx)
    out = [{"sev": "crit", "text": f"{t['num']} due in {t['days_left']} day{'s' if t['days_left'] != 1 else ''}", "kind": "tender", "id": t["id"]}
           for t in sorted((t for t in T if t["live"] and t["days_left"] is not None and 0 <= t["days_left"] <= 5), key=lambda t: t["days_left"])]
    out += [{"sev": "warn", "text": f"{g['type']} {g['ref']} expires in {g['days_left']} day{'s' if g['days_left'] != 1 else ''}", "kind": "guarantee", "id": g["id"]}
            for g in sorted((g for g in G if g["status"] == "Active" and g["days_left"] is not None and 0 <= g["days_left"] <= 20), key=lambda g: g["days_left"])[:2]]
    out += [{"sev": "crit", "text": f"Approval {a['title']} is overdue", "kind": "approval", "id": a["id"]} for a in A if a["overdue"]][:2]
    return out[:6]


def board_overview(ctx: Ctx) -> dict:
    D, T, O, I, G, A = deals(ctx), tenders(ctx), orders(ctx), invoices(ctx), guarantees(ctx), approvals_pending(ctx)
    L = leads(ctx)
    keys = month_keys(ctx.today)
    won_t = [t for t in T if t["result"] == "Won"]
    booked = sum(booked_value(t) for t in won_t if ctx.in_period(t["decided"]))
    target = ctx.memo("target_total", lambda: _f(ctx.db.query(func.sum(KAMTarget.sales_target)).filter(
        or_(KAMTarget.period == str(ctx.today.year), KAMTarget.period.like(f"{ctx.today.year}-%")), ctx.owned(KAMTarget.user_id)).scalar()))
    won_d = [d for d in D if d["outcome"] == "Won"]
    lost_d = [d for d in D if d["outcome"] == "Lost"]
    open_d = [d for d in D if d["outcome"] == "Open"]
    Qs = quotes(ctx)
    quotes_n, accepted_q = len(Qs), sum(1 for q in Qs if q["outcome"] == "Won")
    cust = defaultdict(float)
    for t in won_t:
        if ctx.in_period(t["decided"]):
            cust[t["customer"] or "Unspecified"] += booked_value(t)
    return {
        "kpis": {
            "booked": booked, "target": target, "booked_spark": [v / 1e5 for v in _bucket_months(won_t, "decided", keys, booked_value)],
            "open_pipeline": sum(d["value"] for d in open_d),
            "win_rate": pct(len(won_d), len(won_d) + len(lost_d)), "won": len(won_d), "lost": len(lost_d),
            "active_orders": sum(1 for o in O if o["active"]),
            "receivables": sum(p["receivable"] for p in payments(ctx)), "invoices": len(I),
            "guarantees_blocked": sum(g["amount"] for g in G if g["status"] == "Active"),
            "approvals_pending": len(A),
        },
        "journey": [
            {"l": "Leads", "v": len(L)}, {"l": "Converted", "v": sum(1 for l in L if l["converted"])}, {"l": "Deals", "v": len(D)},
            {"l": "Bids + quotes", "v": len(T) + int(quotes_n)}, {"l": "Won", "v": len(won_t) + int(accepted_q)},
            {"l": "Orders", "v": sum(1 for o in O if not o["follow_on"])}, {"l": "Follow-on", "v": sum(1 for o in O if o["follow_on"])},
        ],
        "months": month_labels(keys),
        "bookings": [v / 1e5 for v in _bucket_months(won_t, "decided", keys, booked_value)],
        "billing": [v / 1e5 for v in _bucket_months(I, "invoice_date", keys, lambda i: i["total"])],
        "has_invoices": bool(I),
        "pipeline_by_stage": [{"l": s, "v": sum(d["value"] for d in open_d if d["stage"] == s)} for s in deal_open_stages(ctx)],
        "attention": needs_attention(ctx),
        "top_customers": [{"l": k, "v": v} for k, v in sorted(cust.items(), key=lambda x: -x[1])[:6]],
        "winloss": {"won": len(won_d), "lost": len(lost_d), "open": len(open_d)},
        "approvals": A[:5],
        "recent": recent_activity(ctx),
        "quotes_by_stage": [{"l": s, "v": n} for s, n in Counter(q.get("stage") or "Draft" for q in Qs).most_common()],
    }


def board_leads(ctx: Ctx) -> dict:
    L = leads(ctx)
    keys = month_keys(ctx.today)
    sources = sorted({l["source"] for l in L})
    conv = [l for l in L if l["converted"]]
    statuses = [s for s in ("New", "Assigned", "Contacted", "Qualified", "Proposal", "Nurturing") if any(l["status"] == s for l in L)]
    statuses += sorted({l["status"] for l in L if l["open"] and l["status"] not in statuses})
    open_l = [l for l in L if l["open"]]
    def age(l):
        d = _d(l["created"])
        return (ctx.today - d).days if d else 0
    owners = defaultdict(list)
    for l in L:
        if l["owner"]:
            owners[l["owner"]].append(l)
    return {
        "kpis": {"total": len(L), "spark": _bucket_months(L, "created", keys), "new_period": sum(1 for l in L if ctx.in_period(l["created"])),
                 "qualified_pct": pct(sum(1 for l in L if l["qualified_plus"]), len(L)), "converted": len(conv),
                 "converted_pct": pct(len(conv), len(L)), "unassigned": sum(1 for l in L if not l["owner_id"]), "avg_score": None},
        "months": month_labels(keys), "created_6m": _bucket_months(L, "created", keys),
        "sources": [{"l": s, "v": sum(1 for l in L if l["source"] == s)} for s in sources],
        "conversion_by_source": sorted(({"l": s, "v": pct(sum(1 for l in L if l["source"] == s and l["converted"]), sum(1 for l in L if l["source"] == s))} for s in sources), key=lambda x: -x["v"]),
        "funnel": [{"l": s, "v": sum(1 for l in L if l["status"] == s and l["open"])} for s in statuses] + [{"l": "Converted", "v": len(conv)}],
        "scoring_available": False,
        "ageing": [{"l": lab, "v": sum(1 for l in open_l if f(age(l)))} for lab, f in
                   (("0-15 d", lambda a: a <= 15), ("16-30 d", lambda a: 15 < a <= 30), ("31-60 d", lambda a: 30 < a <= 60), ("60 d+", lambda a: a > 60))],
        "open_count": len(open_l),
        "owners": sorted(({"owner": o, "owner_id": a[0]["owner_id"], "leads": len(a), "converted": sum(1 for x in a if x["converted"]),
                           "conversion": pct(sum(1 for x in a if x["converted"]), len(a)), "value": sum(x["value"] for x in a), "hot": None}
                          for o, a in owners.items()), key=lambda x: -x["leads"]),
    }


def board_deals(ctx: Ctx) -> dict:
    D = deals(ctx)
    keys = month_keys(ctx.today)
    op = [d for d in D if d["outcome"] == "Open"]
    won = [d for d in D if d["outcome"] == "Won"]
    lost = [d for d in D if d["outcome"] == "Lost"]
    won_p = [d for d in won if ctx.in_period(d["close"])]
    cycles = [(_d(d["close"]) - _d(d["created"])).days for d in won if _d(d["close"]) and _d(d["created"])]
    def wr(t):
        w, l = sum(1 for d in won if d["type"] == t), sum(1 for d in lost if d["type"] == t)
        return pct(w, w + l) if w + l else None
    return {
        "kpis": {"open_pipeline": sum(d["value"] for d in op),
                 "weighted": sum(d["value"] * (d["prob"] or 0) / 100 for d in op) if any(d["prob"] is not None for d in op) else None, "won_fy": sum(d["value"] for d in won_p), "won_fy_n": len(won_p),
                 "win_rate": pct(len(won), len(won) + len(lost)), "avg_deal": (sum(d["value"] for d in won) / len(won)) if won else 0,
                 "avg_cycle": round(sum(cycles) / len(cycles)) if cycles else None},
        "by_stage": [{"l": s, "v": sum(d["value"] for d in op if d["stage"] == s)} for s in deal_open_stages(ctx)],
        "by_type": [{"l": "Tender-led", "v": sum(1 for d in D if d["type"] == "Tender")}, {"l": "Quote-led", "v": sum(1 for d in D if d["type"] != "Tender")}],
        "total": len(D), "forecast_available": any(d["prob"] is not None for d in op), "forecast": _forecast_split(ctx, op),
        "months": month_labels(keys), "won_6m": _bucket_months(won, "close", keys), "lost_6m": _bucket_months(lost, "close", keys),
        "win_rate_by_type": [{"l": "Tender-led", "v": wr("Tender")}, {"l": "Quote-led", "v": wr("Quotation")}],
        "top_open": sorted(op, key=lambda d: -d["value"])[:7],
        "stalled": sorted((d for d in op if (d["days_in_stage"] or 0) > STALLED_DAYS), key=lambda d: -(d["days_in_stage"] or 0))[:7],
    }


def _forecast_split(ctx: Ctx, op: list[dict]) -> list[dict]:
    """Open deals by forecast category – the Forecasts module's thresholds on the stage win probability (Commit / Best case / Pipeline)."""
    try:
        from app.services import forecast_service as FS
        cfg = FS.config(ctx.db)
        cm, bc = float(cfg["commit_min"]), float(cfg["best_min"])
    except Exception:
        ctx.db.rollback()
        cm, bc = 70.0, 40.0
    cat = lambda d: "Commit" if (d["prob"] or 0) >= cm else "Best case" if (d["prob"] or 0) >= bc else "Pipeline"
    return [{"l": c, "v": sum(d["value"] for d in op if d["prob"] is not None and cat(d) == c), "n": sum(1 for d in op if d["prob"] is not None and cat(d) == c)}
            for c in ("Commit", "Best case", "Pipeline")]


def tender_oem_values(ctx: Ctx) -> list[dict]:
    """Bid value per OEM: each bid's value is attributed once to every OEM quoted on it (grouped join)."""
    T = {t["id"]: t for t in tenders(ctx)}
    if not T:
        return []
    rows = (ctx.db.query(TenderProduct.tender_id, func.coalesce(TenderProduct.oem_name, ""))
            .filter(TenderProduct.tender_id.in_(list(T))).distinct().all())
    try:
        rows += ctx.db.execute(text(
            "SELECT DISTINCT tp.tender_id, COALESCE(o.oem_name,'') FROM tender_product_oems o JOIN tender_products tp ON tp.id = o.tender_product_id "
            f"WHERE tp.tender_id IN ({','.join(str(int(i)) for i in T)})")).fetchall()
    except Exception:
        pass
    per = defaultdict(set)
    for tid, name in rows:
        if name and name.strip():
            per[name.strip()].add(tid)
    return sorted(({"l": n, "v": sum(T[i]["value"] for i in ids), "n": len(ids)} for n, ids in per.items()), key=lambda x: -x["v"])[:7]


def board_bids(ctx: Ctx) -> dict:
    T, G = tenders(ctx), guarantees(ctx)
    keys = month_keys(ctx.today)
    live = [t for t in T if t["live"]]
    won = [t for t in T if t["result"] == "Won"]
    lost = [t for t in T if t["result"] == "Lost"]
    portals = sorted({t["portal"] for t in T})
    stages = Counter(t["stage"] for t in T)
    def hit(p):
        w, l = sum(1 for t in won if t["portal"] == p), sum(1 for t in lost if t["portal"] == p)
        return pct(w, w + l) if w + l else None
    return {
        "kpis": {"live": len(live), "due7": sum(1 for t in live if t["days_left"] is not None and 0 <= t["days_left"] <= 7),
                 "hit_rate": pct(len(won), len(won) + len(lost)), "won": len(won), "lost": len(lost),
                 "emd_blocked": sum(g["amount"] for g in G if g["status"] == "Active" and "emd" in g["type"].lower()),
                 "avg_bid": (sum(t["value"] for t in T) / len(T)) if T else 0, "pipeline": sum(t["value"] for t in live)},
        "by_stage": [{"l": s, "v": n} for s, n in stages.most_common()],
        "portals": [{"l": p, "v": sum(1 for t in T if t["portal"] == p)} for p in portals],
        "hit_by_portal": [{"l": p, "v": hit(p)} for p in portals],
        "oem": tender_oem_values(ctx),
        "months": month_labels(keys), "published_6m": _bucket_months(T, "published", keys),
        "won_6m": _bucket_months(won, "decided", keys), "lost_6m": _bucket_months(lost, "decided", keys),
        "competitors_available": False,
        "deadlines": sorted((t for t in live if t["days_left"] is not None and 0 <= t["days_left"] <= 14), key=lambda t: t["days_left"]),
    }


def board_kam(ctx: Ctx) -> dict:
    K, A = kams(ctx), activities(ctx)
    days = [(ctx.today - timedelta(days=6 - i)) for i in range(7)]
    types = Counter(a["type"] for a in A)
    heat = {(a["kam_id"], a["date"]): 0 for a in A}
    for a in A:
        heat[(a["kam_id"], a["date"])] += 1
    return {
        "kpis": {"target": sum(k["target"] for k in K), "achieved": sum(k["achieved"] for k in K), "pipeline": sum(k["pipeline"] for k in K),
                 "activities": len(A), "visits": sum(1 for a in A if "visit" in a["type"].lower()), "kams": len(K)},
        "kams": K, "activity_mix": [{"l": t, "v": n} for t, n in types.most_common()],
        "days": [d.isoformat() for d in days],
        "heat": [[heat.get((k["id"], d.isoformat()), 0) for d in days] for k in K],
    }


def board_orders(ctx: Ctx) -> dict:
    O = orders(ctx)
    act = [o for o in O if o["active"]]
    total_value = sum(o["value"] for o in O)
    buckets = [(0, 25), (25, 50), (50, 75), (75, 100), (100, 101)]
    return {
        "kpis": {"active": len(act), "value": total_value, "avg_progress": round(sum(o["progress"] for o in act) / len(act)) if act else 0,
                 "billed_pct": pct(sum(o["invoiced"] for o in O), total_value), "delayed": sum(1 for o in act if o["delayed"]),
                 "contracts": sum(1 for o in O if o["follow_on"])},
        "by_type": [{"l": t, "v": n} for t, n in Counter(o["type"] for o in O).most_common()],
        "by_stage": [{"l": s, "v": n} for s, n in Counter(o["stage"] for o in O).most_common()],
        "progress": [{"l": f"{a}–{min(b, 100)}", "v": sum(1 for o in O if a <= o["progress"] < b), "lo": a, "hi": b} for a, b in buckets],
        "gap": sorted((o for o in act if o["gap"] > 0), key=lambda o: -o["gap"])[:6],
        "due_soon": sorted((o for o in act if o["due"] and (_d(o["due"]) - ctx.today).days < 45), key=lambda o: o["due"])[:6],
        "progress_list": sorted(act, key=lambda o: -o["value"])[:6],
    }


def board_finance(ctx: Ctx) -> dict:
    """Billed = invoices raised. Collections come from the Orders & Projects payment ledger (same as Collections &
    finance): collected = Finance-acknowledged receipts by bank credit date, awaiting = receipts not yet acknowledged,
    outstanding = unpaid balance of payment stages due to date, ageing = days past the stage due date."""
    I, G, P, R = invoices(ctx), guarantees(ctx), payments(ctx), receipts(ctx)
    keys = month_keys(ctx.today)
    active_g = [g for g in G if g["status"] == "Active"]
    ageing = [0.0, 0.0, 0.0, 0.0]
    for p in P:
        if p["receivable"] > 0:
            a = p["days_overdue"]
            ageing[3 if a > 150 else 2 if a > 90 else 1 if a > 45 else 0] += p["receivable"]
    by_cust = defaultdict(float)
    for p in P:
        by_cust[p["customer"] or "Unspecified"] += p["receivable"]
    ack = [r for r in R if r["status"] == "Acknowledged"]
    types = defaultdict(float)
    for g in active_g:
        types[g["type"]] += g["amount"]
    billed_p = [i for i in I if ctx.in_period(i["invoice_date"])]
    return {
        "kpis": {"billed": sum(i["total"] for i in billed_p), "collected": sum(r["amount"] for r in ack if ctx.in_period(r["credited_on"])),
                 "collected_n": sum(1 for r in ack if ctx.in_period(r["credited_on"])),
                 "awaiting": sum(r["amount"] for r in R if r["status"] == "Pending finance"), "awaiting_n": sum(1 for r in R if r["status"] == "Pending finance"),
                 "outstanding": sum(p["receivable"] for p in P), "over_90": ageing[2] + ageing[3],
                 "guarantees": sum(g["amount"] for g in active_g),
                 "expiring_30": sum(1 for g in active_g if g["days_left"] is not None and 0 <= g["days_left"] <= 30)},
        "has_invoices": bool(I), "invoice_count": len(I), "has_schedule": bool(P), "receipt_count": len(R),
        "ageing": [{"l": l, "v": v} for l, v in zip(("0-45 d", "46-90 d", "91-150 d", "150 d+"), ageing)],
        "by_customer": [{"l": k, "v": v} for k, v in sorted(by_cust.items(), key=lambda x: -x[1]) if v > 0][:6],
        "guarantee_types": [{"l": k, "v": v} for k, v in sorted(types.items(), key=lambda x: -x[1])],
        "months": month_labels(keys),
        "billed_6m": [v / 1e5 for v in _bucket_months(I, "invoice_date", keys, lambda i: i["total"])],
        "collected_6m": [v / 1e5 for v in _bucket_months(ack, "credited_on", keys, lambda r: r["amount"])],
        "expiring": sorted((g for g in active_g if g["days_left"] is not None and 0 <= g["days_left"] <= 60), key=lambda g: g["days_left"])[:6],
    }


def board_login(ctx: Ctx) -> dict:
    ev, users = login_events(ctx), login_users(ctx)
    H = login_history(ctx)
    today = ctx.today
    days = [today - timedelta(days=13 - i) for i in range(14)]
    week_start = today - timedelta(days=6)
    ok = [h for h in H if h["ok"]]
    ok7 = [h for h in ok if _d(h["date"]) and _d(h["date"]) >= week_start]
    fail7 = [h for h in H if not h["ok"] and _d(h["date"]) and _d(h["date"]) >= week_start]
    now = datetime.now()
    active_now = [s for s in ev["sessions"] if s.is_active and s.last_active and (now - s.last_active).total_seconds() < 900 and not s.logout_time]
    users7 = {h["user_id"] for h in ok7 if h["user_id"]}
    mins = [h["minutes"] for h in ok7 if h["minutes"] is not None]
    roles = defaultdict(lambda: [0, 0])
    for uid, u in users.items():
        roles[u.role or "—"][1] += 1
        if uid in users7:
            roles[u.role or "—"][0] += 1
    grid = [[0] * 10 for _ in range(6)]
    for h in ok:
        t = datetime.fromisoformat(h["at"]) if h["at"] else None
        if t and t.weekday() < 6 and 8 <= t.hour <= 17:
            grid[t.weekday()][t.hour - 8] += 1
    dev = Counter(h["os"] for h in ok7)
    S = security_signals(ctx)
    return {
        "kpis": {"today": sum(1 for h in ok if h["date"] == today.isoformat()), "spark": [sum(1 for h in ok if h["date"] == d.isoformat()) for d in days],
                 "active_now": len(active_now), "unique7": len(users7), "users": len(users), "failed7": len(fail7),
                 "flagged": len(S), "avg_session": round(sum(mins) / len(mins)) if mins else None},
        "days": [d.isoformat() for d in days],
        "per_day": [{"ok": sum(1 for h in ok if h["date"] == d.isoformat()), "fail": sum(1 for h in H if not h["ok"] and h["date"] == d.isoformat())} for d in days],
        "peak": grid,
        "devices": [{"l": k, "v": v} for k, v in dev.most_common()],
        "adoption": sorted(({"l": r, "v": pct(a, n), "n": n} for r, (a, n) in roles.items()), key=lambda x: -x["v"]),
        "web_mobile": {"web": sum(1 for h in ok7 if not _is_mobile(h["device"])), "mobile": sum(1 for h in ok7 if _is_mobile(h["device"]))},
        "signals": S[:8], "inactive": inactive_users(ctx)[:6], "inactive_count": len(inactive_users(ctx)),
        "ip_visible": ctx.can("users.manage") or ctx.can("audit_logs.view"),
    }


def welcome(ctx: Ctx) -> dict:
    """Welcome banner counts: my bids due this week, approvals waiting on me, my tasks due today, new leads."""
    me = int(ctx.cu.id)
    T = tenders(ctx)
    tasks = ctx.db.query(func.count(KAMTaskAssignment.id)).filter(
        KAMTaskAssignment.assigned_to == me, KAMTaskAssignment.due_date <= ctx.today,
        or_(KAMTaskAssignment.status.is_(None), ~func.lower(KAMTaskAssignment.status).in_(DONE_TASK))).scalar() or 0
    since = ctx.today - timedelta(days=1)
    open_tasks = (ctx.db.query(KAMTaskAssignment.id, KAMTaskAssignment.title, KAMTaskAssignment.due_date, KAMTaskAssignment.priority, Customer.customer_name)
                  .outerjoin(Customer, Customer.id == KAMTaskAssignment.customer_id)
                  .filter(KAMTaskAssignment.assigned_to == me, or_(KAMTaskAssignment.status.is_(None), ~func.lower(KAMTaskAssignment.status).in_(DONE_TASK)))
                  .order_by(KAMTaskAssignment.due_date.is_(None), KAMTaskAssignment.due_date).limit(5).all())
    return {
        "tasks": [{"id": t.id, "title": t.title or "Task", "due": _iso(_d(t.due_date)), "priority": t.priority or "", "customer": t.customer_name or ""} for t in open_tasks],
        "bids_due": sum(1 for t in T if t["live"] and t["days_left"] is not None and 0 <= t["days_left"] <= 7),
        "approvals": sum(1 for a in approvals_pending(ctx) if a["mine"]),
        "tasks_today": int(tasks),
        "new_leads": sum(1 for l in leads(ctx) if _d(l["created"]) and _d(l["created"]) >= since),
    }


def board_funnel(ctx: Ctx) -> dict:
    from app.services.dashboard_funnel import board_funnel as build
    return build(ctx)


BOARDS: dict[str, Callable[[Ctx], dict]] = {
    "overview": board_overview, "leads": board_leads, "deals": board_deals, "bids": board_bids,
    "kam": board_kam, "orders": board_orders, "finance": board_finance, "login": board_login, "funnel": board_funnel,
}

# Source name → (row builder, filters). Filters are the same predicates the boards use, keyed by a short name and an
# optional argument ("stage:Proposal"), so each drill-down lists exactly the records behind the number clicked.
def _deal_filters(ctx: Ctx) -> dict:
    return {
        "all": lambda d, a: True, "open": lambda d, a: d["outcome"] == "Open", "won": lambda d, a: d["outcome"] == "Won",
        "lost": lambda d, a: d["outcome"] == "Lost", "decided": lambda d, a: d["outcome"] in ("Won", "Lost"),
        "won_period": lambda d, a: d["outcome"] == "Won" and ctx.in_period(d["close"]),
        "stage": lambda d, a: d["outcome"] == "Open" and d["stage"] == a, "type": lambda d, a: d["type"] == a,
        "type_decided": lambda d, a: d["type"] == a and d["outcome"] in ("Won", "Lost"),
        "stalled": lambda d, a: d["outcome"] == "Open" and (d["days_in_stage"] or 0) > STALLED_DAYS,
        "month_won": lambda d, a: d["outcome"] == "Won" and str(d["close"] or "")[:7] == a,
        "month_lost": lambda d, a: d["outcome"] == "Lost" and str(d["close"] or "")[:7] == a,
        "owner": lambda d, a: str(d["owner_id"]) == a and d["outcome"] == "Open", "id": lambda d, a: str(d["id"]) == a,
    }


def _lead_filters(ctx: Ctx) -> dict:
    def age(l):
        d = _d(l["created"])
        return (ctx.today - d).days if d else 0
    bands = {"0-15 d": (0, 15), "16-30 d": (16, 30), "31-60 d": (31, 60), "60 d+": (61, 10 ** 6)}
    return {
        "all": lambda l, a: True, "new_period": lambda l, a: ctx.in_period(l["created"]), "qualified": lambda l, a: l["qualified_plus"],
        "converted": lambda l, a: l["converted"], "unassigned": lambda l, a: not l["owner_id"], "open": lambda l, a: l["open"],
        "source": lambda l, a: l["source"] == a, "month": lambda l, a: str(l["created"] or "")[:7] == a,
        "status": lambda l, a: l["status"] == a and (l["open"] or a == "Converted"),
        "age": lambda l, a: l["open"] and bands.get(a, (0, -1))[0] <= age(l) <= bands.get(a, (0, -1))[1],
        "owner": lambda l, a: str(l["owner_id"]) == a,
    }


def _tender_filters(ctx: Ctx) -> dict:
    oem_ids = {}
    def oem(t, a):
        if "map" not in oem_ids:
            rows = ctx.db.query(TenderProduct.tender_id, TenderProduct.oem_name).filter(TenderProduct.oem_name == a).all()
            oem_ids["map"] = {r[0] for r in rows}
        return t["id"] in oem_ids["map"]
    return {
        "all": lambda t, a: True, "live": lambda t, a: t["live"], "won": lambda t, a: t["result"] == "Won", "lost": lambda t, a: t["result"] == "Lost",
        "decided": lambda t, a: t["result"] in ("Won", "Lost"), "booked": lambda t, a: t["result"] == "Won" and ctx.in_period(t["decided"]),
        "due": lambda t, a: t["live"] and t["days_left"] is not None and 0 <= t["days_left"] <= int(a or 7),
        "stage": lambda t, a: t["stage"] == a, "portal": lambda t, a: t["portal"] == a,
        "portal_decided": lambda t, a: t["portal"] == a and t["result"] in ("Won", "Lost"),
        "month": lambda t, a: str(t["published"] or "")[:7] == a, "oem": oem,
        "customer_won": lambda t, a: t["result"] == "Won" and ctx.in_period(t["decided"]) and (t["customer"] or "Unspecified") == a,
        "booked_month": lambda t, a: t["result"] == "Won" and str(t["decided"] or "")[:7] == a,
        "manager": lambda t, a: str(t["manager_id"]) == a, "id": lambda t, a: str(t["id"]) == a,
    }


def _order_filters(ctx: Ctx) -> dict:
    return {
        "all": lambda o, a: True, "active": lambda o, a: o["active"], "delayed": lambda o, a: o["delayed"], "follow_on": lambda o, a: o["follow_on"],
        "type": lambda o, a: o["type"] == a, "stage": lambda o, a: o["stage"] == a,
        "progress": lambda o, a: int(a.split("-")[0]) <= o["progress"] < int(a.split("-")[1]),
        "gap": lambda o, a: o["active"] and o["gap"] > 0, "due_soon": lambda o, a: o["active"] and bool(o["due"]) and (_d(o["due"]) - ctx.today).days < 45,
        "id": lambda o, a: str(o["id"]) == a, "billed": lambda o, a: o["invoiced"] > 0,
    }


def _invoice_filters(ctx: Ctx) -> dict:
    band = {"0-45 d": (0, 45), "46-90 d": (46, 90), "91-150 d": (91, 150), "150 d+": (151, 10 ** 6)}
    return {
        "all": lambda i, a: True, "billed_period": lambda i, a: ctx.in_period(i["invoice_date"]),
        "collected_period": lambda i, a: i["paid"] > 0 and ctx.in_period(i["paid_date"] or i["invoice_date"]),
        "outstanding": lambda i, a: i["outstanding"] > 0, "over_90": lambda i, a: i["outstanding"] > 0 and (i["age"] or 0) > 90,
        "age": lambda i, a: i["outstanding"] > 0 and band.get(a, (0, -1))[0] <= (i["age"] or 0) <= band.get(a, (0, -1))[1],
        "customer": lambda i, a: i["outstanding"] > 0 and (i["customer"] or "Unspecified") == a,
        "month": lambda i, a: str(i["invoice_date"] or "")[:7] == a,
    }


def _payment_filters(ctx: Ctx) -> dict:
    band = {"0-45 d": (0, 45), "46-90 d": (46, 90), "91-150 d": (91, 150), "150 d+": (151, 10 ** 6)}
    return {
        "all": lambda p, a: True, "outstanding": lambda p, a: p["receivable"] > 0, "over_90": lambda p, a: p["receivable"] > 0 and p["days_overdue"] > 90,
        "age": lambda p, a: p["receivable"] > 0 and band.get(a, (0, -1))[0] <= p["days_overdue"] <= band.get(a, (0, -1))[1],
        "customer": lambda p, a: p["receivable"] > 0 and (p["customer"] or "Unspecified") == a, "order": lambda p, a: str(p["wo_id"]) == a,
    }


def _receipt_filters(ctx: Ctx) -> dict:
    return {
        "all": lambda r, a: True, "collected_period": lambda r, a: r["status"] == "Acknowledged" and ctx.in_period(r["credited_on"]),
        "awaiting": lambda r, a: r["status"] == "Pending finance", "month": lambda r, a: r["status"] == "Acknowledged" and str(r["credited_on"] or "")[:7] == a,
    }


def _guarantee_filters(ctx: Ctx) -> dict:
    return {
        "all": lambda g, a: True, "active": lambda g, a: g["status"] == "Active",
        "emd": lambda g, a: g["status"] == "Active" and "emd" in g["type"].lower(),
        "expiring": lambda g, a: g["status"] == "Active" and g["days_left"] is not None and 0 <= g["days_left"] <= int(a or 30),
        "type": lambda g, a: g["status"] == "Active" and g["type"] == a, "id": lambda g, a: str(g["id"]) == a,
    }


def _kam_filters(ctx: Ctx) -> dict:
    return {"all": lambda k, a: True, "id": lambda k, a: str(k["id"]) == a}


def _activity_filters(ctx: Ctx) -> dict:
    return {"all": lambda x, a: True, "visits": lambda x, a: "visit" in x["type"].lower(), "type": lambda x, a: x["type"] == a,
            "kam": lambda x, a: str(x["kam_id"]) == a}


def _approval_filters(ctx: Ctx) -> dict:
    return {"all": lambda x, a: True, "overdue": lambda x, a: x["overdue"], "mine": lambda x, a: x["mine"]}


def _login_filters(ctx: Ctx) -> dict:
    week = (ctx.today - timedelta(days=6)).isoformat()
    return {
        "all": lambda h, a: True, "today": lambda h, a: h["ok"] and h["date"] == ctx.today.isoformat(),
        "active": lambda h, a: h["result"] == "Active", "ok7": lambda h, a: h["ok"] and (h["date"] or "") >= week,
        "failed7": lambda h, a: not h["ok"] and (h["date"] or "") >= week, "os": lambda h, a: h["ok"] and (h["date"] or "") >= week and h["os"] == a,
        "role": lambda h, a: h["ok"] and (h["date"] or "") >= week and h["role"] == a,
        "mobile": lambda h, a: h["ok"] and (h["date"] or "") >= week and _is_mobile(h["device"]) == (a == "1"),
        "user": lambda h, a: str(h["user_id"]) == a, "day": lambda h, a: h["date"] == a,
    }


SOURCES: dict[str, tuple[Callable[[Ctx], list[dict]], Callable[[Ctx], dict], tuple[str, ...], str, str]] = {
    # name: (rows, filters, searchable keys, status key, date key)
    "leads": (leads, _lead_filters, ("ref", "title", "customer", "source", "owner"), "status", "created"),
    "deals": (deals, _deal_filters, ("name", "customer", "owner", "journey"), "stage", "close"),
    "tenders": (tenders, _tender_filters, ("num", "title", "customer", "portal", "manager", "journey"), "stage", "deadline"),
    "orders": (orders, _order_filters, ("number", "title", "customer", "pm"), "stage", "due"),
    "invoices": (invoices, _invoice_filters, ("number", "order", "customer"), "status", "invoice_date"),
    "payments": (payments, _payment_filters, ("order", "customer", "stage"), "status", "due"),
    "receipts": (receipts, _receipt_filters, ("order", "customer", "ref", "by", "mode"), "status", "credited_on"),
    "guarantees": (guarantees, _guarantee_filters, ("ref", "type", "customer", "bid", "bank"), "status", "valid_until"),
    "kams": (kams, _kam_filters, ("name", "role"), "role", ""),
    "activities": (activities, _activity_filters, ("kam", "type", "customer", "subject"), "type", "date"),
    "approvals": (approvals_pending, _approval_filters, ("title", "by", "module"), "status", "requested_at"),
    "logins": (login_history, _login_filters, ("user", "role", "device", "ip"), "result", "date"),
    "signals": (security_signals, lambda c: {"all": lambda x, a: True}, ("user", "kind", "detail"), "kind", "date"),
}


def records(ctx: Ctx, source: str, flt: str = "all", q: str = "", status: str = "", date_from: str = "", date_to: str = "",
            sort: str = "", direction: str = "desc", page: int = 1, page_size: int = 25) -> dict:
    rows_fn, filters_fn, search_keys, status_key, date_key = SOURCES[source]
    name, _, arg = (flt or "all").partition(":")
    pred = filters_fn(ctx).get(name)
    if pred is None:
        raise KeyError(flt)
    base = [r for r in rows_fn(ctx) if pred(r, arg)]
    statuses = sorted({str(r.get(status_key) or "") for r in base if r.get(status_key)}) if status_key else []
    rows = base
    if status and status_key:
        rows = [r for r in rows if str(r.get(status_key) or "") == status]
    if date_key and (date_from or date_to):
        rows = [r for r in rows if r.get(date_key) and (not date_from or str(r[date_key])[:10] >= date_from) and (not date_to or str(r[date_key])[:10] <= date_to)]
    if q:
        ql = q.lower()
        rows = [r for r in rows if any(ql in str(r.get(k) or "").lower() for k in search_keys)]
    if sort and rows and sort in rows[0]:
        rows = sorted(rows, key=lambda r: (r.get(sort) is None, r.get(sort) if not isinstance(r.get(sort), str) else r.get(sort).lower()),
                      reverse=direction == "desc")
    total = len(rows)
    page_size = max(1, min(int(page_size or 25), 200))
    page = max(1, int(page or 1))
    return {"rows": rows[(page - 1) * page_size: page * page_size], "total": total, "page": page, "page_size": page_size,
            "statuses": statuses, "date_key": date_key or None}


# ─── Schema: custom dashboards table and the indexes the dashboards rely on ──

_SCHEMA_READY: set[str] = set()

DASHBOARD_INDEXES = (
    ("login_logs", "idx_login_logs_created", "created_at, user_id"),
    ("user_sessions", "idx_user_sessions_login_time", "login_time, user_id"),
    ("kam_activities", "idx_kamact_date_user", "activity_date, user_id"),
    ("audit_logs", "idx_audit_module_record", "module, record_id, created_at"),
    ("approval_requests", "idx_apreq_status", "overall_status"),
    ("approval_request_steps", "idx_apstep_request_status", "approval_request_id, status"),
    ("approvals", "idx_approvals_status", "status, requested_to"),
    ("wo_invoices", "idx_wo_invoices_date", "invoice_date"),
    ("tenders", "idx_tenders_submission", "submission_date, result"),
    ("kam_targets", "idx_kam_targets_user_period", "user_id, period"),
    ("work_orders", "idx_work_orders_lead", "lead_id"),
    ("quotations", "idx_quotations_lead_status", "lead_id, status"),
)


_SCHEMA_LOCKS: dict[str, "threading.Lock"] = {}
_SCHEMA_LOCKS_GUARD = threading.Lock()
# Seconds a dashboard DDL may wait for a table's metadata lock. MariaDB's default (lock_wait_timeout = 1 day) let a
# CREATE INDEX on a busy table hang every dashboard request of a new tenant; the indexes are only an optimisation.
_DDL_LOCK_WAIT_SECONDS = 5


def ensure_schema(db: Session, tenant_key: str) -> None:
    """Create the custom-dashboard table and the dashboard indexes once per tenant per process (idempotent DDL).

    A new tenant's first dashboard view sends several requests at once. Each one has already read ``user_sessions``
    (sign-in check) in its open transaction, and that read holds a metadata lock that ``CREATE INDEX`` on the same
    table must wait for – so concurrent requests used to block each other indefinitely. To avoid that: the request's
    own transaction is committed first, only one request per tenant runs the DDL, only missing indexes are created,
    and each statement gives up after a few seconds (it is retried on a later request).
    """
    if tenant_key in _SCHEMA_READY:
        return
    db.commit()  # release this request's metadata locks before any DDL (DDL commits implicitly anyway)
    with _SCHEMA_LOCKS_GUARD:
        lock = _SCHEMA_LOCKS.setdefault(tenant_key, threading.Lock())
    with lock:
        if tenant_key in _SCHEMA_READY:
            return
        _ensure_schema_locked(db, tenant_key)


def _ensure_schema_locked(db: Session, tenant_key: str) -> None:
    previous_wait = None
    try:
        previous_wait = db.execute(text("SELECT @@SESSION.lock_wait_timeout")).scalar()
        db.execute(text(f"SET SESSION lock_wait_timeout = {_DDL_LOCK_WAIT_SECONDS}"))
    except Exception:
        db.rollback()
    complete = True
    try:
        _create_schema(db)
        existing = {(str(t).lower(), str(n).lower()) for t, n in db.execute(text(
            "SELECT TABLE_NAME, INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()")).fetchall()}
        tables = {str(t).lower() for (t,) in db.execute(text(
            "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()")).fetchall()}
        db.commit()
        for table, name, cols in DASHBOARD_INDEXES:
            if table not in tables or (table, name.lower()) in existing:
                continue
            try:
                db.execute(text(f"CREATE INDEX IF NOT EXISTS {name} ON {table} ({cols})"))
                db.commit()
            except Exception as exc:  # noqa: BLE001 - a busy table must not block the dashboard; retried later
                db.rollback()
                complete = False
                logger.warning("Dashboard index %s on %s.%s skipped: %s", name, tenant_key, table, str(exc)[:200])
    finally:
        if previous_wait is not None:
            try:
                db.execute(text(f"SET SESSION lock_wait_timeout = {int(previous_wait)}"))
            except Exception:
                db.rollback()
    if complete:
        _SCHEMA_READY.add(tenant_key)


def _create_schema(db: Session) -> None:
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS dashboard_layouts (
            id INT AUTO_INCREMENT PRIMARY KEY,
            owner_user_id INT NOT NULL,
            name VARCHAR(80) NOT NULL,
            widgets TEXT NOT NULL,
            share_scope VARCHAR(20) NOT NULL DEFAULT 'private',
            shared_user_ids TEXT NULL,
            shared_roles TEXT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_dashboard_layouts_owner (owner_user_id),
            INDEX idx_dashboard_layouts_share (share_scope)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """))
    db.commit()
