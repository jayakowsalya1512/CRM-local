"""Business KPIs: Cost & margin, Discounts & coupons, Invoices & dunning, Add-ons & usage pricing, Revenue analytics, Resellers & partners."""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal

from sqlalchemy.orm import Session

from app.services.platform_kpi import Col, Kpi, register
from app.services.platform_kpi_specs.common import TENANT_LINK, count_where
from app.services.platform_kpi_specs.core import INVOICE_COLS, INVOICES, INVOICES_SQL, MRR_COLS, _recurring

ZERO = Decimal("0")


def _pct(part, whole):
    return round(float(part) / float(whole) * 100, 1) if whole else None


# ── Cost & margin ────────────────────────────────────────────────────────────

def _finops(db: Session, ctx: dict) -> list[dict]:
    from app.services import platform_finops as fo

    def band(m):
        return "No revenue" if m is None else "Below 40%" if m < 40 else "40–65%" if m < 65 else "65% and above"
    return [{"tenant_id": r["id"], "tenant": r["name"], "slug": r["slug"], "status": r["status"], "billing_status": r["billing_status"],
             **{c: r[c] for c in fo.CATS}, "total": r["total"], "mrr": r["mrr"], "discount": r["discount"], "net_mrr": r["net_mrr"], "profit": r["profit"],
             "margin": r["margin"], "margin_band": band(r["margin"]), "paying": r["paying"], "cycle": r["cycle"]}
            for r in fo.scoped(fo.cached(), ctx["scope"])]


def _sum(key):
    return lambda rows: sum(float(r.get(key) or 0) for r in rows)


def _margin(rows):
    net, cost = _sum("net_mrr")(rows), _sum("total")(rows)
    return round((net - cost) / net * 100, 1) if net > 0 else None


def _budget_used(rows):
    from app.services import platform_finops as fo
    budget = float(fo.cached()["rates"]["budget"] or 0)
    return round(_sum("total")(rows) / budget * 100, 1) if budget > 0 else None


def _budget(rows):
    from app.services import platform_finops as fo
    return float(fo.cached()["rates"]["budget"] or 0) or None


FINOPS_COLS = [Col("tenant", "Tenant"), Col("status", "Status", "pill"), Col("compute", "Compute", "inr"), Col("database", "Database", "inr"),
               Col("storage", "Storage", "inr"), Col("ai", "AI", "inr"), Col("egress", "Egress", "inr"), Col("support", "Support", "inr", hidden=True),
               Col("total", "Total cost", "inr"), Col("mrr", "MRR", "inr"), Col("discount", "Discount", "inr"), Col("net_mrr", "Net MRR", "inr"),
               Col("profit", "Gross profit", "inr"), Col("margin", "Margin", "pct"), Col("margin_band", "Margin band", hidden=True),
               Col("billing_status", "Billing", "pill", hidden=True), Col("cycle", "Cycle", hidden=True), Col("paying", "Paying", "bool", hidden=True),
               Col("slug", "Slug", "code", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True)]
FINOPS = dict(rows=_finops, columns=FINOPS_COLS, search=("tenant", "slug"), status="status", link=TENANT_LINK,
              description="This month's allocated server, storage, AI, egress and support cost against net MRR (after discounts, excl. GST)")
COST_SUM = [("Cost", _sum("total"), "inr"), ("Net MRR", _sum("net_mrr"), "inr"), ("Gross profit", _sum("profit"), "inr"), ("Gross margin", _margin, "pct")]

register(
    Kpi("cost.cost", "Infra + support cost / month", "billing", sort="total", group="status", amount="total", summary=COST_SUM, **FINOPS),
    Kpi("cost.revenue", "Revenue (MRR)", "billing", sort="net_mrr", group="status", amount="net_mrr", **FINOPS,
        summary=[("MRR before discounts", _sum("mrr"), "inr"), ("Discounts", _sum("discount"), "inr"), ("Net MRR", _sum("net_mrr"), "inr")]),
    Kpi("cost.margin", "Gross margin", "billing", sort="margin", desc=False, group="margin_band", amount="profit", summary=COST_SUM, **FINOPS),
    Kpi("cost.avg_cost", "Avg cost / tenant", "billing", sort="total", group="status", amount="total", **FINOPS,
        summary=[("Tenants", len, "num"), ("Cost", _sum("total"), "inr"), ("Avg cost / tenant", lambda rows: round(_sum("total")(rows) / len(rows), 2) if rows else None, "inr")]),
    Kpi("cost.budget", "Budget used", "billing", sort="total", group="status", amount="total", **{**FINOPS, "note": None},
        summary=[("Cost", _sum("total"), "inr"), ("Monthly budget", _budget, "inr"), ("Budget used", _budget_used, "pct")]),
)


# ── Discounts & coupons ─────────────────────────────────────────────────────

COUPONS_SQL = """
SELECT * FROM (SELECT c.id, c.code, c.kind, c.value, CASE WHEN c.kind = 'percent' THEN CONCAT(c.value, '%') ELSE CONCAT('₹', c.value) END AS discount,
       c.duration, IF(c.plan_ids IS NULL, 'All plans', 'Selected plans') AS applies_to, c.redemption_limit, c.redeemed_count, c.valid_until,
       CASE WHEN c.status = 'paused' THEN 'Paused' WHEN c.valid_until < CURDATE() THEN 'Expired'
            WHEN c.redemption_limit > 0 AND c.redeemed_count >= c.redemption_limit THEN 'Exhausted' ELSE 'Active' END AS status,
       c.note, c.created_by, c.created_at
FROM platform_coupons c WHERE c.deleted_at IS NULL) cc WHERE cc.status = 'Active'
"""
REDEMPTIONS_SQL = """
SELECT r.id, r.code, r.tenant_id, t.name AS tenant, p.name AS plan, r.kind, r.value, r.duration, r.redeemed_at, r.redeemed_by, r.status, r.first_invoice_id
FROM platform_coupon_redemptions r JOIN tenants t ON t.id = r.tenant_id LEFT JOIN plans p ON p.id = r.plan_id
"""
PENDING_SQL = """
SELECT d.id, d.tenant_id, t.name AS tenant, d.pct, d.term_months, d.reason, d.requested_by, d.requested_at, d.status
FROM platform_tenant_discounts d JOIN tenants t ON t.id = d.tenant_id WHERE d.status = 'pending'
"""


def _discounted(db: Session, ctx: dict) -> list[dict]:
    return [{**r, "discount_pct": _pct(r["discount"], r["list_mrr"])} for r in _recurring(db, ctx) if r["discount"] > 0]


DISCOUNTED = dict(rows=_discounted, columns=[*MRR_COLS[:6], Col("discount_pct", "Discount %", "pct"), *MRR_COLS[6:]], search=("tenant", "slug", "plan"),
                  status="billing_status", group="plan", amount="discount", link=TENANT_LINK,
                  description="Paying tenants whose effective MRR is below list MRR (coupons, volume, negotiated, partner and annual discounts)")

register(
    Kpi("discounts.active_coupons", "Active coupons", "billing", sql=COUPONS_SQL, tenant=None, tenant_name=None, search=("code", "note"), date="valid_until",
        sort="created_at", group="kind",
        columns=[Col("code", "Code", "code"), Col("discount", "Discount"), Col("duration", "Duration"), Col("applies_to", "Applies to"),
                 Col("redeemed_count", "Redeemed", "num"), Col("redemption_limit", "Limit (0 = unlimited)", "num"), Col("valid_until", "Valid until", "date"),
                 Col("status", "Status", "pill"), Col("kind", "Kind", hidden=True), Col("value", "Value", "num", hidden=True), Col("note", "Note", hidden=True),
                 Col("created_by", "Created by", hidden=True), Col("created_at", "Created", "datetime", hidden=True), Col("id", "Coupon ID", "num", hidden=True)],
        summary=[("Redemptions", "COALESCE(SUM(q.redeemed_count), 0)", "num"), ("Expiring ≤ 30 days", count_where("q.valid_until <= CURDATE() + INTERVAL 30 DAY"), "num")]),
    Kpi("discounts.redemptions", "Redemptions", "billing", sql=REDEMPTIONS_SQL, search=("code", "tenant", "plan", "redeemed_by"), status="status", date="redeemed_at",
        sort="redeemed_at", group="code", link=TENANT_LINK,
        columns=[Col("code", "Coupon", "code"), Col("tenant", "Tenant"), Col("plan", "Plan"), Col("kind", "Kind"), Col("value", "Value", "num"),
                 Col("duration", "Duration"), Col("redeemed_at", "Redeemed", "datetime"), Col("status", "Status", "pill"), Col("redeemed_by", "Redeemed by", hidden=True),
                 Col("first_invoice_id", "First invoice ID", "num", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True), Col("id", "Redemption ID", "num", hidden=True)],
        summary=[("Active", count_where("q.status = 'active'"), "num"), ("Last 30 days", count_where("q.redeemed_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY"), "num")]),
    Kpi("discounts.mrr_discount", "MRR given as discount", "billing", sort="discount", **DISCOUNTED,
        summary=[("Tenants", len, "num"), ("List MRR", _sum("list_mrr"), "inr"), ("Discount / month", _sum("discount"), "inr")]),
    Kpi("discounts.avg_discount", "Avg discount", "billing", sort="discount_pct", **DISCOUNTED,
        summary=[("Tenants", len, "num"), ("Avg discount", lambda rows: round(sum(r["discount_pct"] for r in rows) / len(rows), 1) if rows else None, "pct")]),
    Kpi("discounts.awaiting_approval", "Awaiting approval", "billing", sql=PENDING_SQL, search=("tenant", "reason", "requested_by"), date="requested_at",
        sort="requested_at", desc=False, group="requested_by", link=TENANT_LINK,
        columns=[Col("tenant", "Tenant"), Col("pct", "Discount", "pct"), Col("term_months", "Term (months)", "num"), Col("reason", "Reason"),
                 Col("requested_by", "Requested by"), Col("requested_at", "Requested", "datetime"), Col("status", "Status", "pill", hidden=True),
                 Col("tenant_id", "Tenant ID", "num", hidden=True), Col("id", "Discount ID", "num", hidden=True)],
        description="Negotiated discounts above the approval threshold waiting for a second approver"),
)


# ── Invoices & dunning ──────────────────────────────────────────────────────

def _invoices(where: str) -> str:
    return f"SELECT * FROM ({INVOICES_SQL}) ii WHERE {where}"


OPEN_BAL = [("Invoices", "COUNT(*)", "num"), ("Unpaid balance", "COALESCE(SUM(GREATEST(q.balance, 0)), 0)", "inr")]
PAYMENTS_SQL = """
SELECT p.id, p.invoice_id, i.number, p.tenant_id, t.name AS tenant, p.gateway, p.reference, p.amount, p.currency, p.paid_on, p.source, p.recorded_by, p.evidence, p.created_at
FROM platform_payments p JOIN tenants t ON t.id = p.tenant_id LEFT JOIN platform_invoices i ON i.id = p.invoice_id
WHERE p.paid_on >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
"""
AT_RISK_SQL = f"""
SELECT ii.tenant_id, ii.tenant, tn.billing_status, tn.status AS tenant_status, COUNT(*) AS invoices, SUM(GREATEST(ii.balance, 0)) AS balance,
       MIN(ii.due_on) AS oldest_due, MAX(ii.days_overdue) AS days_overdue, SUM(ii.status = 'Failed') AS failed
FROM ({INVOICES_SQL}) ii JOIN tenants tn ON tn.id = ii.tenant_id WHERE ii.status IN ('Overdue', 'Failed')
GROUP BY ii.tenant_id, ii.tenant, tn.billing_status, tn.status
"""

register(
    Kpi("invoices.invoiced_month", "Invoiced · month", "billing", sql=_invoices("ii.issued_on >= DATE_FORMAT(CURDATE(), '%Y-%m-01')"),
        **{**INVOICES, "amount": "total", "summary": [("Invoices", "COUNT(*)", "num"), ("Invoiced", "SUM(q.total)", "inr"), ("Collected", "SUM(q.amount_paid)", "inr")]}),
    Kpi("invoices.collected", "Collected", "billing", sql=PAYMENTS_SQL, search=("number", "tenant", "reference", "gateway"), date="paid_on", sort="paid_on",
        group="gateway", amount="amount", link=TENANT_LINK,
        columns=[Col("paid_on", "Paid on", "date"), Col("tenant", "Tenant"), Col("number", "Invoice", "code"), Col("gateway", "Gateway", "pill"),
                 Col("reference", "Reference", "code"), Col("amount", "Amount", "inr"), Col("source", "Source"), Col("currency", "Currency", hidden=True),
                 Col("recorded_by", "Recorded by", hidden=True), Col("evidence", "Evidence", hidden=True), Col("created_at", "Recorded", "datetime", hidden=True),
                 Col("invoice_id", "Invoice ID", "num", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True), Col("id", "Payment ID", "num", hidden=True)],
        summary=[("Payments", "COUNT(*)", "num"), ("Collected", "COALESCE(SUM(q.amount), 0)", "inr")],
        description="Payments received against invoices this month"),
    Kpi("invoices.due", "Due", "billing", sql=_invoices("ii.status = 'Due'"), **{**INVOICES, "sort": "due_on", "desc": False, "summary": OPEN_BAL}),
    Kpi("invoices.overdue", "Overdue / failed", "billing", sql=_invoices("ii.status IN ('Overdue', 'Failed')"),
        **{**INVOICES, "sort": "days_overdue", "summary": OPEN_BAL + [("Failed payments", count_where("q.status = 'Failed'"), "num")]}),
    Kpi("invoices.at_risk", "At-risk tenants", "billing", sql=AT_RISK_SQL, search=("tenant",), status="billing_status", date="oldest_due", sort="balance",
        group="tenant_status", amount="balance", link=TENANT_LINK,
        columns=[Col("tenant", "Tenant"), Col("invoices", "Overdue / failed invoices", "num"), Col("balance", "Unpaid balance", "inr"),
                 Col("oldest_due", "Oldest due", "date"), Col("days_overdue", "Days past due", "num"), Col("failed", "Failed payments", "num"),
                 Col("billing_status", "Billing", "pill"), Col("tenant_status", "Tenant status", "pill"), Col("tenant_id", "Tenant ID", "num", hidden=True)],
        summary=[("Unpaid balance", "COALESCE(SUM(q.balance), 0)", "inr")]),
)


# ── Add-ons & usage pricing ─────────────────────────────────────────────────

def _catalogue(db: Session, ctx: dict) -> list[dict]:
    from app.services import platform_addons as ao

    ao.ensure_schema()
    return ao.catalogue(db, sorted(ctx["scope"]) if ctx["scope"] is not None else None)


PAYING = "t.status = 'active' AND t.billing_status NOT IN ('trial', 'free', 'cancelled')"  # platform_addons.catalogue (SQL NULL semantics)
SUBS_SQL = f"""
SELECT s.id, s.tenant_id, t.name AS tenant, a.name AS addon, a.status AS addon_status, a.price, s.quantity, s.started_on, t.status, t.billing_status,
       IF({PAYING}, 'Paying', 'Not billed') AS billed, IF({PAYING}, a.price * s.quantity, 0) AS mrr
FROM platform_tenant_addons s JOIN platform_addons a ON a.id = s.addon_id JOIN tenants t ON t.id = s.tenant_id WHERE s.status = 'active'
"""
SUBS_COLS = [Col("tenant", "Tenant"), Col("addon", "Add-on"), Col("price", "Price", "inr"), Col("quantity", "Qty", "num"), Col("mrr", "MRR", "inr"),
             Col("billed", "Billed", "pill"), Col("started_on", "Since", "date"), Col("addon_status", "Add-on status", "pill", hidden=True),
             Col("status", "Tenant status", "pill", hidden=True), Col("billing_status", "Billing", "pill", hidden=True),
             Col("tenant_id", "Tenant ID", "num", hidden=True), Col("id", "Subscription ID", "num", hidden=True)]
TENANT_ADDONS_SQL = f"""
SELECT s.tenant_id, t.name AS tenant, t.status, t.billing_status, COUNT(*) AS addons, SUM(s.quantity) AS units,
       GROUP_CONCAT(a.name ORDER BY a.name SEPARATOR ', ') AS addon_names, SUM(IF({PAYING}, a.price * s.quantity, 0)) AS mrr, MIN(s.started_on) AS first_since
FROM platform_tenant_addons s JOIN platform_addons a ON a.id = s.addon_id JOIN tenants t ON t.id = s.tenant_id WHERE s.status = 'active'
GROUP BY s.tenant_id, t.name, t.status, t.billing_status
"""
OVERAGE_SQL = """
SELECT c.id, c.tenant_id, t.name AS tenant, c.metric, c.month, p.name AS plan, c.used, c.included, c.overage, c.price, c.amount, c.status, c.note, c.invoice_id,
       IF(c.status IN ('pending', 'invoiced'), c.amount, 0) AS charged
FROM platform_usage_charges c JOIN tenants t ON t.id = c.tenant_id LEFT JOIN plans p ON p.id = c.plan_id
WHERE c.month = DATE_FORMAT(CURDATE(), '%Y-%m-01') - INTERVAL 1 MONTH
"""

register(
    Kpi("addons.count", "Add-ons", "billing", rows=_catalogue, tenant=None, tenant_name=None, search=("name",), status="status", sort="mrr", group="status", amount="mrr",
        link="/platform/addons",
        columns=[Col("name", "Add-on"), Col("price", "Price", "inr"), Col("unit", "Unit"), Col("tenants", "Tenants", "num"), Col("mrr", "MRR", "inr"),
                 Col("status", "Status", "pill"), Col("id", "Add-on ID", "num", hidden=True)],
        summary=[("Active", lambda rows: sum(1 for r in rows if r["status"] == "Active"), "num"), ("Add-on MRR", _sum("mrr"), "inr")]),
    Kpi("addons.mrr", "Add-on MRR", "billing", sql=SUBS_SQL, columns=SUBS_COLS, search=("tenant", "addon"), status="billed", date="started_on", sort="mrr",
        group="addon", amount="mrr", link=TENANT_LINK, summary=[("Subscriptions", "COUNT(*)", "num"), ("Add-on MRR", "COALESCE(SUM(q.mrr), 0)", "inr")],
        description="Active add-on subscriptions; MRR counts paying tenants only (price × quantity)"),
    Kpi("addons.tenants", "Tenants with add-ons", "billing", sql=TENANT_ADDONS_SQL, search=("tenant", "addon_names"), status="status", date="first_since",
        sort="mrr", group="status", amount="mrr", link=TENANT_LINK,
        columns=[Col("tenant", "Tenant"), Col("addons", "Add-ons", "num"), Col("units", "Units", "num"), Col("addon_names", "Add-on names"), Col("mrr", "MRR", "inr"),
                 Col("status", "Status", "pill"), Col("billing_status", "Billing", "pill", hidden=True), Col("first_since", "First add-on since", "date", hidden=True),
                 Col("tenant_id", "Tenant ID", "num", hidden=True)],
        summary=[("Add-on MRR", "COALESCE(SUM(q.mrr), 0)", "inr")]),
    Kpi("addons.overage", "Metered overage · month", "billing", sql=OVERAGE_SQL, search=("tenant", "metric", "plan"), status="status", sort="amount",
        group="metric", amount="charged", link=TENANT_LINK,
        columns=[Col("tenant", "Tenant"), Col("metric", "Metric"), Col("plan", "Plan"), Col("used", "Used", "num"), Col("included", "Included", "num"),
                 Col("overage", "Overage", "num"), Col("price", "Price / unit", "inr"), Col("amount", "Amount", "inr"), Col("status", "Status", "pill"),
                 Col("month", "Month", "date", hidden=True), Col("charged", "Charged", "inr", hidden=True), Col("note", "Note", hidden=True),
                 Col("invoice_id", "Invoice ID", "num", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True), Col("id", "Charge ID", "num", hidden=True)],
        summary=[("Charged (pending + invoiced)", "COALESCE(SUM(q.charged), 0)", "inr"), ("Measured", "COUNT(*)", "num")],
        description="Last month's metered usage per tenant and metric; the card sums pending and invoiced charges"),
)


# ── Revenue analytics ───────────────────────────────────────────────────────

def _ledger(db: Session, scope):
    """Live recurring state and the subscription-ledger timeline, read the way platform_revenue.overview reads them."""
    from app.models.platform_revenue import PlatformSubscriptionEvent as Ev
    from app.models.tenant import Plan
    from app.services import platform_revenue as rev

    rev.ensure_schema()
    rev.record(None, "reconcile")
    db.rollback()
    live = rev._current(db, scope)
    plans = {p.id: p.name for p in db.query(Plan.id, Plan.name).all()}
    q = db.query(Ev.tenant_id, Ev.occurred_at, Ev.mrr, Ev.kind, Ev.tenant_name)
    if scope is not None:
        q = q.filter(Ev.tenant_id.in_(list(scope) or [0]))
    rows = q.order_by(Ev.tenant_id, Ev.occurred_at, Ev.id).all()
    names = {r[0]: r[4] for r in rows}
    start = db.query(Ev.occurred_at).filter(Ev.kind == "baseline").order_by(Ev.occurred_at).limit(1).scalar()
    return rev, live, plans, rev._Timeline([r[:4] for r in rows], start), names


def _move(s, e) -> str:
    return "New" if s == 0 and e > 0 else "Churn" if s > 0 and e == 0 else "Expansion" if e > s else "Contraction" if e < s else "Unchanged"


def _paying(db: Session, ctx: dict) -> list[dict]:
    rev, live, plans, tl, _ = _ledger(db, ctx["scope"])
    ms = rev._window(rev._month_start(datetime.utcnow()), tl.start)[0] if tl.start else None
    start = tl.state(ms) if ms else {}
    return [{"tenant_id": tid, "tenant": s["name"], "plan": plans.get(s["plan_id"], "No plan"), "status": s["status"], "billing_status": s["billing_status"],
             "mrr": s["mrr"], "arr": s["mrr"] * 12, "month_start_mrr": start.get(tid, ZERO) if ms else None,
             "movement": _move(start.get(tid, ZERO), s["mrr"]) if ms else None} for tid, s in live.items() if s["paying"]]


def _movement(db: Session, ctx: dict) -> list[dict]:
    rev, live, plans, tl, names = _ledger(db, ctx["scope"])
    if tl.start is None:
        return []
    ms, _ = rev._window(rev._month_start(datetime.utcnow()), tl.start)
    start, end = tl.state(ms), tl.state(datetime.utcnow())
    out = []
    for tid in set(start) | set(end):
        s, e = start.get(tid, ZERO), end.get(tid, ZERO)
        if s == 0 and e == 0:
            continue
        cur = live.get(tid)
        out.append({"tenant_id": tid, "tenant": cur["name"] if cur else names.get(tid), "plan": plans.get(cur["plan_id"], "No plan") if cur else None,
                    "movement": _move(s, e), "month_start_mrr": s, "mrr": e, "change": e - s, "status": cur["status"] if cur else "deleted"})
    return out


def _window_rows(days: int):
    def rows(db: Session, ctx: dict) -> list[dict]:
        rev, live, plans, tl, names = _ledger(db, ctx["scope"])
        if tl.start is None:
            return []
        now = datetime.utcnow()
        since, cut = rev._window(now - timedelta(days=days), tl.start)
        end = tl.state(now)
        out = []
        for tid, s in tl.state(since).items():
            if s <= 0:
                continue
            e, cur = end.get(tid, ZERO), live.get(tid)
            out.append({"tenant_id": tid, "tenant": cur["name"] if cur else names.get(tid), "plan": plans.get(cur["plan_id"], "No plan") if cur else None,
                        "start_mrr": s, "mrr": e, "change": e - s, "retained": _pct(e, s), "outcome": "Lost" if e == 0 else _move(s, e).replace("Unchanged", "Retained"),
                        "since": since, "truncated": cut})
        return out
    return rows


REV_COLS = [Col("tenant", "Tenant"), Col("plan", "Plan"), Col("mrr", "MRR", "inr"), Col("arr", "ARR", "inr"), Col("month_start_mrr", "MRR at month start", "inr"),
            Col("movement", "This month", "pill"), Col("status", "Status", "pill", hidden=True), Col("billing_status", "Billing", "pill", hidden=True),
            Col("tenant_id", "Tenant ID", "num", hidden=True)]
REV = dict(rows=_paying, columns=REV_COLS, search=("tenant", "plan"), status="movement", group="plan", amount="mrr", link=TENANT_LINK,
           description="Paying accounts at their effective MRR (after recurring discounts, plus add-ons)")
WINDOW_COLS = [Col("tenant", "Tenant"), Col("plan", "Plan"), Col("start_mrr", "MRR at window start", "inr"), Col("mrr", "MRR now", "inr"),
               Col("change", "Change", "inr"), Col("retained", "Retained", "pct"), Col("outcome", "Outcome", "pill"), Col("since", "Window start", "datetime", hidden=True),
               Col("truncated", "Shortened to ledger start", "bool", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True)]
WINDOW = dict(columns=WINDOW_COLS, search=("tenant", "plan"), status="outcome", group="outcome", link=TENANT_LINK)
ACQUIRED_SQL = """
SELECT e.id, e.tenant_id, e.tenant_name AS tenant, p.name AS plan, e.kind, e.occurred_at, e.mrr, e.mrr_delta, e.source
FROM platform_subscription_events e LEFT JOIN plans p ON p.id = e.plan_id WHERE e.kind IN ('new', 'reactivation')
"""

register(
    Kpi("revenue.mrr", "MRR", "billing", sort="mrr", **REV,
        summary=[("Paying accounts", len, "num"), ("MRR", _sum("mrr"), "inr"), ("MRR at month start", _sum("month_start_mrr"), "inr")]),
    Kpi("revenue.arr", "ARR", "billing", sort="arr", **REV, summary=[("Paying accounts", len, "num"), ("ARR", _sum("arr"), "inr")]),
    Kpi("revenue.arpa", "ARPA", "billing", sort="mrr", **REV,
        summary=[("Paying accounts", len, "num"), ("MRR", _sum("mrr"), "inr"), ("ARPA", lambda rows: round(_sum("mrr")(rows) / len(rows), 2) if rows else None, "inr")]),
    Kpi("revenue.movement", "MRR movement · this month", "billing", rows=_movement, search=("tenant", "plan"), status="status", sort="change", group="movement",
        amount="change", link=TENANT_LINK,
        columns=[Col("tenant", "Tenant"), Col("plan", "Plan"), Col("movement", "Movement", "pill"), Col("month_start_mrr", "Start", "inr"), Col("mrr", "End", "inr"),
                 Col("change", "Change", "inr"), Col("status", "Status", "pill"), Col("tenant_id", "Tenant ID", "num", hidden=True)],
        summary=[("Start", _sum("month_start_mrr"), "inr"), ("End", _sum("mrr"), "inr"), ("Net change", _sum("change"), "inr")],
        description="Accounts whose MRR changed between the month start (or ledger start) and now, from the subscription ledger"),
    Kpi("revenue.nrr", "Net revenue retention", "billing", rows=_window_rows(365), sort="start_mrr", amount="mrr", **WINDOW,
        summary=[("MRR at start", _sum("start_mrr"), "inr"), ("Same accounts now", _sum("mrr"), "inr"),
                 ("NRR", lambda rows: _pct(_sum("mrr")(rows), _sum("start_mrr")(rows)), "pct")],
        description="Accounts paying 12 months ago (or at the ledger start) and their MRR now; new accounts are excluded"),
    Kpi("revenue.churn", "Logo churn · 90d", "billing", rows=_window_rows(90), sort="change", desc=False, **WINDOW,
        summary=[("Accounts at start", len, "num"), ("Lost", lambda rows: sum(1 for r in rows if r["outcome"] == "Lost"), "num"),
                 ("Logo churn", lambda rows: _pct(sum(1 for r in rows if r["outcome"] == "Lost"), len(rows)), "pct")],
        description="Accounts paying 90 days ago (or at the ledger start); Lost = no longer paying"),
    Kpi("revenue.ltv_cac", "LTV : CAC", "billing", sql=ACQUIRED_SQL, search=("tenant", "plan"), status="kind", date="occurred_at", sort="occurred_at", group="plan",
        amount="mrr", link=TENANT_LINK,
        columns=[Col("tenant", "Tenant"), Col("plan", "Plan"), Col("kind", "Event", "pill"), Col("occurred_at", "When", "datetime"), Col("mrr", "MRR", "inr"),
                 Col("mrr_delta", "MRR change", "inr", hidden=True), Col("source", "Source", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True),
                 Col("id", "Event ID", "num", hidden=True)],
        summary=[("Accounts acquired", "COUNT(*)", "num"), ("MRR acquired", "COALESCE(SUM(q.mrr), 0)", "inr")],
        note="No acquisition-cost (CAC) or margin data is recorded, so LTV : CAC is shown as —. Listed: paying accounts acquired (new or reactivated) per the subscription ledger."),
)


# ── Resellers & partners ────────────────────────────────────────────────────

RESELLERS_SQL = """
SELECT r.id, r.name, r.region, r.tier, r.commission_pct, r.domain, r.created_by, r.created_at,
       (SELECT COUNT(*) FROM platform_reseller_tenants rt WHERE rt.reseller_id = r.id) AS tenants,
       (SELECT ROUND(COALESCE(SUM(i.subtotal), 0) * r.commission_pct / 100, 2) FROM platform_reseller_tenants rt
          JOIN platform_invoices i ON i.tenant_id = rt.tenant_id AND i.status = 'Paid' AND i.paid_on >= DATE(rt.assigned_at) WHERE rt.reseller_id = r.id) AS earned
FROM platform_resellers r
"""
RESELLER_COLS = [Col("name", "Reseller"), Col("region", "Region"), Col("tier", "Tier", "pill"), Col("commission_pct", "Commission", "pct"),
                 Col("tenants", "Tenants", "num"), Col("earned", "Commission earned", "inr"), Col("domain", "White-label domain", "code"),
                 Col("created_by", "Created by", hidden=True), Col("created_at", "Created", "datetime", hidden=True), Col("id", "Reseller ID", "num", hidden=True)]
RESELLERS = dict(sql=RESELLERS_SQL, columns=RESELLER_COLS, tenant=None, tenant_name=None, search=("name", "region", "domain"), status="tier", date="created_at",
                 group="tier", link="/platform/resellers")
ASSIGNED_SQL = """
SELECT rt.id, rt.tenant_id, t.name AS tenant, p.name AS plan, t.status, t.billing_status, r.name AS reseller, r.tier, r.commission_pct, rt.assigned_by, rt.assigned_at
FROM platform_reseller_tenants rt JOIN platform_resellers r ON r.id = rt.reseller_id JOIN tenants t ON t.id = rt.tenant_id LEFT JOIN plans p ON p.id = t.plan_id
"""
COMMISSION_SQL = """
SELECT i.id, i.number, i.tenant_id, t.name AS tenant, r.name AS reseller, r.commission_pct, i.subtotal, i.total, i.paid_on, rt.assigned_at,
       i.subtotal * r.commission_pct / 100 AS commission
FROM platform_reseller_tenants rt JOIN platform_resellers r ON r.id = rt.reseller_id JOIN tenants t ON t.id = rt.tenant_id
JOIN platform_invoices i ON i.tenant_id = rt.tenant_id AND i.status = 'Paid' AND i.paid_on >= DATE(rt.assigned_at)
"""

register(
    Kpi("resellers.count", "Resellers", "billing", sort="tenants", amount="tenants", **RESELLERS,
        summary=[("Tenants assigned", "COALESCE(SUM(q.tenants), 0)", "num"), ("Commission earned", "COALESCE(SUM(q.earned), 0)", "inr")]),
    Kpi("resellers.avg_commission", "Avg. commission", "billing", sort="commission_pct", **RESELLERS,
        summary=[("Resellers", "COUNT(*)", "num"), ("Avg. commission", "ROUND(AVG(q.commission_pct), 1)", "pct")]),
    Kpi("resellers.tenants", "Tenants via resellers", "billing", sql=ASSIGNED_SQL, search=("tenant", "reseller", "plan"), status="status", date="assigned_at",
        sort="assigned_at", group="reseller", link=TENANT_LINK,
        columns=[Col("tenant", "Tenant"), Col("reseller", "Reseller"), Col("tier", "Tier", "pill"), Col("commission_pct", "Commission", "pct"), Col("plan", "Plan"),
                 Col("status", "Status", "pill"), Col("assigned_at", "Assigned", "datetime"), Col("billing_status", "Billing", "pill", hidden=True),
                 Col("assigned_by", "Assigned by", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True), Col("id", "Assignment ID", "num", hidden=True)]),
    Kpi("resellers.commission", "Commission payable", "billing", sql=COMMISSION_SQL, search=("number", "tenant", "reseller"), date="paid_on", sort="paid_on",
        group="reseller", amount="commission", link=TENANT_LINK,
        columns=[Col("number", "Invoice", "code"), Col("tenant", "Tenant"), Col("reseller", "Reseller"), Col("paid_on", "Paid on", "date"),
                 Col("subtotal", "Invoice (excl. GST)", "inr"), Col("commission_pct", "Rate", "pct"), Col("commission", "Commission", "inr"),
                 Col("total", "Invoice total", "inr", hidden=True), Col("assigned_at", "Assigned", "datetime", hidden=True),
                 Col("tenant_id", "Tenant ID", "num", hidden=True), Col("id", "Invoice ID", "num", hidden=True)],
        summary=[("Paid invoices", "COUNT(*)", "num"), ("Commission", "ROUND(COALESCE(SUM(q.commission), 0), 2)", "inr")],
        note="No payouts are recorded yet, so every commission earned since assignment is payable."),
)
