"""Billing & metering (Business → Billing & Metering).

Prices come from the Plans module (plans.price_monthly / price_yearly, whole rupees), with a tenant's negotiated price
(the latest tenant_plan_snapshots row for its current plan, written at onboarding) taking precedence. Invoices and
their lines are stored in platform_invoices / platform_invoice_lines; one invoice per tenant and billing period.

Run invoicing bills every eligible tenant (status active, billing not trial / free / cancelled, price above zero) for
the current period of its billing cycle (Control Center "Default billing cycle", overridable per tenant), in advance.
Usage-based lines: extra user seats (active seats over the plan / tenant allowance, Control Center seat price) and the
per-plan metered overage of each closed month (API calls, AI queries, storage, e-mails – Add-ons & usage pricing,
platform_addons); both are charged only while "Over-limit behaviour" is "Soft – allow and bill". Active add-ons are
billed for the period in advance and count towards MRR. Tax: GST when "Calculate tax automatically" is on, at the
rate, GSTIN, SAC and place-of-supply rule set in Invoices & dunning (platform_invoicing.tax_for); late fees on invoices
overdue past the dunning grace period are billed once, on the tenant's next invoice.
Discounts (volume tier, negotiated, coupons, annual prepay – see platform_discounts) are taken off the subscription
before tax, as discount lines or as a net subscription price ("Show discount on invoices"). MRR / ARR are the
effective monthly amounts after recurring discounts.
"""

from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Optional

from sqlalchemy import JSON, Column, Date, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, func, text
from sqlalchemy.orm import Session

from app.database import Base, master_engine
from app.models.tenant import Plan, Tenant, TenantPlanSnapshot

GST_RATE = Decimal("18")  # default GST rate; the rate in use is the Invoices & dunning setting (platform_invoicing)
NOT_BILLED = ("trial", "free", "cancelled")
CYCLE_MONTHS = {"Monthly": 1, "Quarterly": 3, "Annual": 12}
SOFT = "Soft – allow and bill"


class PlatformInvoice(Base):
    __tablename__ = "platform_invoices"
    __table_args__ = (UniqueConstraint("tenant_id", "period_start", name="uq_platform_invoice_period"),)
    id = Column(Integer, primary_key=True, autoincrement=True)
    number = Column(String(40), unique=True, nullable=False)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=False)  # indexed by uq_platform_invoice_period
    plan_id = Column(Integer, nullable=True)
    plan_name = Column(String(100), nullable=True)
    cycle = Column(String(20), nullable=False)
    period_start = Column(Date, nullable=False)
    period_end = Column(Date, nullable=False)
    issued_on = Column(Date, nullable=False)
    due_on = Column(Date, nullable=False)
    currency = Column(String(3), nullable=False, default="INR")
    subtotal = Column(Numeric(14, 2), nullable=False)
    tax_rate = Column(Numeric(5, 2), nullable=False, default=0)
    tax_amount = Column(Numeric(14, 2), nullable=False, default=0)
    total = Column(Numeric(14, 2), nullable=False)
    status = Column(String(10), nullable=False, default="Pending")  # Pending | Paid | Credited (Due / Overdue / Failed are derived)
    paid_on = Column(Date, nullable=True)
    payment_ref = Column(String(120), nullable=True)
    created_by = Column(String(200), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    # Added by platform_invoicing.ensure_schema (Invoices & dunning)
    amount_paid = Column(Numeric(14, 2), nullable=False, default=0)
    amount_credited = Column(Numeric(14, 2), nullable=False, default=0)
    last_failure_at = Column(DateTime, nullable=True)
    last_failure_reason = Column(String(300), nullable=True)
    gateway = Column(String(20), nullable=True)
    payment_link = Column(String(300), nullable=True)
    tax_detail = Column(JSON, nullable=True)
    late_fee_invoice_id = Column(Integer, nullable=True)  # the later invoice that billed this one's late fee


class PlatformInvoiceLine(Base):
    __tablename__ = "platform_invoice_lines"
    id = Column(Integer, primary_key=True, autoincrement=True)
    invoice_id = Column(Integer, ForeignKey("platform_invoices.id", ondelete="CASCADE"), nullable=False, index=True)
    kind = Column(String(20), nullable=False)  # subscription | seats | storage | ai
    description = Column(String(300), nullable=False)
    quantity = Column(Numeric(14, 3), nullable=False)
    unit_price = Column(Numeric(14, 2), nullable=False)
    amount = Column(Numeric(14, 2), nullable=False)
    meter = Column(JSON, nullable=True)  # metering calculation behind a usage line (used, allowance, source)
    note = Column(Text, nullable=True)


_ready = {"schema": False}


def ensure_schema() -> None:
    if not _ready["schema"]:
        PlatformInvoice.__table__.create(bind=master_engine, checkfirst=True)
        PlatformInvoiceLine.__table__.create(bind=master_engine, checkfirst=True)
        _ready["schema"] = True


def money(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


# ─── Prices and recurring revenue ────────────────────────────────────────────

def tenant_prices(db: Session, tenants: list[Tenant]) -> dict[int, dict]:
    """Monthly / yearly price of each tenant's current plan, using its negotiated price when one was recorded."""
    plans = {p.id: p for p in db.query(Plan).all()}
    snaps = {}
    for s in db.query(TenantPlanSnapshot).filter(TenantPlanSnapshot.tenant_id.in_([t.id for t in tenants] or [0])).order_by(TenantPlanSnapshot.id).all():
        snaps[s.tenant_id] = s  # latest wins
    out = {}
    for t in tenants:
        plan = plans.get(t.plan_id)
        snap = snaps.get(t.id)
        override = snap is not None and snap.plan_id == t.plan_id and (snap.price_monthly or 0) > 0
        out[t.id] = {"plan": plan, "monthly": money(snap.price_monthly if override else (plan.price_monthly if plan else 0)),
                     "yearly": money(snap.price_yearly if override and snap.price_yearly else (plan.price_yearly if plan else 0)),
                     "source": "tenant price" if override else "plan" if plan else None}
    return out


def is_paying(t: Tenant) -> bool:
    return t.status == "active" and (t.billing_status or "") not in NOT_BILLED


def is_trial(t: Tenant) -> bool:
    return t.status == "trial" or t.billing_status == "trial"


def recurring(db: Session, tenants: list[Tenant]) -> dict:
    from app.services import platform_discounts as discounts

    prices = tenant_prices(db, tenants)
    paying = [t for t in tenants if is_paying(t) and prices[t.id]["monthly"] > 0]
    from app.services import platform_addons as addons
    effective = discounts.effective_mrr(db, paying, prices)
    addons.ensure_schema()
    extra = addons.addon_mrr_by_tenant(db, [t.id for t in paying])  # add-ons are recurring revenue too (not discounted)
    rows = [{"tenant_id": t.id, "name": t.name, "slug": t.slug, "mrr": effective[t.id] + extra.get(t.id, Decimal(0)),
             "list_mrr": prices[t.id]["monthly"] + extra.get(t.id, Decimal(0)), "addon_mrr": extra.get(t.id, Decimal(0)), "source": prices[t.id]["source"]}
            for t in paying]
    mrr = sum((r["mrr"] for r in rows), Decimal(0))
    list_mrr = sum((r["list_mrr"] for r in rows), Decimal(0))
    return {"mrr": mrr, "arr": mrr * 12, "list_mrr": list_mrr, "discount_mrr": list_mrr - mrr,
            "by_tenant": sorted(rows, key=lambda r: -r["mrr"]), "trials": sum(1 for t in tenants if is_trial(t))}


# ─── Billing periods ─────────────────────────────────────────────────────────

def period_for(day: date, cycle: str) -> tuple[date, date]:
    months = CYCLE_MONTHS.get(cycle, 12)
    start_month = ((day.month - 1) // months) * months + 1
    start = date(day.year, start_month, 1)
    end_month = start_month + months - 1
    end = date(day.year, end_month, calendar.monthrange(day.year, end_month)[1])
    return start, end


def _next_number(db: Session, prefix: str, issued: date) -> str:
    stem = f"{prefix}{issued:%y%m}-"
    last = db.execute(text("SELECT MAX(CAST(SUBSTRING(number, :o) AS UNSIGNED)) FROM platform_invoices WHERE number LIKE :p"),
                      {"o": len(stem) + 1, "p": stem + "%"}).scalar()
    return f"{stem}{(last or 0) + 1:04d}"


# ─── Invoicing ───────────────────────────────────────────────────────────────

def _usage_lines(db: Session, tenant: Tenant, months: int, usage_row: Optional[dict]) -> tuple[list[dict], list[str]]:
    """Overage lines from the Usage Monitoring meters; notes explain what was not charged and why."""
    from app.services import platform_controls as controls

    notes: list[str] = []
    if usage_row is None:
        return [], ["Usage could not be measured – no usage-based charges"]
    over_rule = controls.value(db, "planOver", tenant.id)
    lines = []
    # Storage, AI, API and e-mail overage are priced per plan and charged per closed month (platform_addons.usage_lines).
    meters = [
        ("seats", "users", "ovSeat", "Extra user seats", "seats", lambda used, limit: max(0, int(used) - int(limit)), months, "per seat per month"),
    ]
    for kind, key, price_key, label, unit, excess_of, multiplier, basis in meters:
        limit = usage_row["limits"].get(key) or {}
        used, allowance = limit.get("used"), limit.get("limit")
        if used is None or not allowance:
            continue
        excess = excess_of(used, allowance)
        if excess <= 0:
            continue
        price = money(controls.value(db, price_key, tenant.id) or 0)
        meter = {"used": used, "allowance": allowance, "excess": excess, "unit": unit, "allowance_source": limit.get("source"), "price_basis": basis}
        if over_rule != SOFT:
            notes.append(f"{label}: {excess} {unit} over the allowance – not billed (over-limit behaviour is “{over_rule}”)")
            continue
        if price <= 0:
            notes.append(f"{label}: {excess} {unit} over the allowance – not billed (no overage price configured)")
            continue
        quantity = Decimal(excess) * multiplier
        lines.append({"kind": kind, "description": f"{label} – {excess} {unit} over {allowance}{' × ' + str(multiplier) + ' months' if multiplier > 1 else ''}",
                      "quantity": quantity, "unit_price": price, "amount": money(quantity * price), "meter": meter})
    return lines, notes


def plan_run(db: Session, tenants: list[Tenant], today: Optional[date] = None, with_usage: bool = True) -> list[dict]:
    """What a run would do for each tenant: the invoice to create, or why it is skipped. Nothing is written."""
    from app.services import platform_controls as controls
    from app.services import platform_usage

    ensure_schema()
    today = today or date.today()
    prices = tenant_prices(db, tenants)
    usage = {}
    eligible = [t for t in tenants if is_paying(t) and prices[t.id]["monthly"] > 0]
    if with_usage and eligible:
        try:
            usage = {r["id"]: r for r in platform_usage.overview(db, eligible, "30d")["tenants"]}
        except Exception:
            usage = {}
    tax_on = bool(controls.value(db, "invTax"))
    from app.services import platform_discounts as discounts
    from app.services import platform_invoicing as invoicing
    invoicing.ensure_schema()
    ctx = discounts.context(db, [t.id for t in tenants])   # one batch for every tenant's discounts
    gst = invoicing.setting(db, "gst")
    tax_block = invoicing.tax_problem(db, tax_on)
    fees = invoicing.late_fees(db, [t.id for t in eligible], today)
    from app.services import platform_addons as addons
    addons.ensure_schema()
    addon_months = {t.id: CYCLE_MONTHS.get(controls.value(db, "invCycle", t.id) or "Annual", 12) for t in eligible}
    addon_lines = addons.addon_lines(db, [t.id for t in eligible], addon_months)
    metered = addons.usage_lines(db, [t.id for t in eligible])
    out = []
    for t in tenants:
        price = prices[t.id]
        cycle = controls.value(db, "invCycle", t.id) or "Annual"
        start, end = period_for(today, cycle)
        entry = {"tenant_id": t.id, "tenant": t.name, "cycle": cycle, "period_start": start, "period_end": end, "plan": price["plan"].name if price["plan"] else None}
        if t.status != "active" or (t.billing_status or "") in NOT_BILLED:
            out.append({**entry, "action": "skip", "reason": f"Not billable (status {t.status}, billing {t.billing_status})"})
            continue
        if price["monthly"] <= 0:
            out.append({**entry, "action": "skip", "reason": "No plan price (free or no plan)"})
            continue
        existing = db.execute(text("SELECT number FROM platform_invoices WHERE tenant_id = :t AND period_start = :s"), {"t": t.id, "s": start}).scalar()
        if existing:
            out.append({**entry, "action": "skip", "reason": f"Already invoiced for this period ({existing})"})
            continue
        months = CYCLE_MONTHS.get(cycle, 12)
        if cycle == "Annual" and price["yearly"] > 0:
            sub = {"kind": "subscription", "description": f"{entry['plan']} plan – annual subscription {start:%b %Y}–{end:%b %Y}", "quantity": Decimal(1),
                   "unit_price": price["yearly"], "amount": price["yearly"], "meter": None}
        else:
            sub = {"kind": "subscription", "description": f"{entry['plan']} plan – {cycle.lower()} subscription {start:%b %Y}–{end:%b %Y}",
                   "quantity": Decimal(months), "unit_price": price["monthly"], "amount": money(price["monthly"] * months), "meter": None}
        disc = discounts.price(ctx, t, cycle, start, end, sub["amount"], cycle == "Annual" and price["yearly"] > 0)
        disc_lines = []
        if disc["total"] > 0:
            if ctx.rules.get("dcShowInv"):
                disc_lines = [{"kind": "discount", "description": d["label"][:300], "quantity": Decimal(1), "unit_price": -d["amount"], "amount": -d["amount"],
                               "meter": {"source": d["key"]}} for d in disc["lines"]]
            else:  # discounts folded into a net subscription price
                sub = {**sub, "amount": money(sub["amount"] - disc["total"]), "unit_price": money((sub["amount"] - disc["total"]) / sub["quantity"]),
                       "description": f"{sub['description']} (after discounts)", "meter": {"discounts": [{"source": d["key"], "label": d["label"], "amount": str(d["amount"])} for d in disc["lines"]]}}
        extra, notes = _usage_lines(db, t, months, usage.get(t.id)) if with_usage else ([], [])
        notes = notes + disc["notes"]
        lines = [sub] + disc_lines + addon_lines.get(t.id, []) + extra + metered.get(t.id, []) + fees.get(t.id, [])
        subtotal = money(sum((line["amount"] for line in lines), Decimal(0)))
        if tax_block:
            out.append({**entry, "action": "skip", "reason": tax_block})
            continue
        tax, why = invoicing.tax_for(gst, t, subtotal, tax_on)
        if tax is None:
            out.append({**entry, "action": "skip", "reason": why})
            continue
        out.append({**entry, "action": "invoice", "lines": lines, "notes": notes, "price_source": price["source"], "subtotal": subtotal,
                    "discount": disc["total"], "once_redemptions": disc["once"], "tax_detail": tax["detail"],
                    "tax_rate": tax["rate"], "tax_amount": tax["amount"], "total": money(subtotal + tax["amount"])})
    return out


def run_invoicing(db: Session, tenants: list[Tenant], actor: str, today: Optional[date] = None) -> list[dict]:
    """Create the planned invoices; a concurrent run cannot bill the same period twice (unique tenant + period)."""
    from sqlalchemy.exc import IntegrityError
    from app.services import platform_controls as controls

    today = today or date.today()
    prefix = controls.value(db, "invPrefix") or "INV-"
    due_days = int(controls.value(db, "invDue") or 15)
    created = []
    for item in plan_run(db, tenants, today):
        if item["action"] != "invoice":
            continue
        invoice = PlatformInvoice(number=_next_number(db, prefix, today), tenant_id=item["tenant_id"], plan_id=None, plan_name=item["plan"], cycle=item["cycle"],
                                  period_start=item["period_start"], period_end=item["period_end"], issued_on=today, due_on=today + timedelta(days=due_days),
                                  currency="INR", subtotal=item["subtotal"], tax_rate=item["tax_rate"], tax_amount=item["tax_amount"], total=item["total"],
                                  status="Pending", created_by=actor, amount_paid=0, amount_credited=0, tax_detail=item.get("tax_detail"))
        tenant = next(t for t in tenants if t.id == item["tenant_id"])
        invoice.plan_id = tenant.plan_id
        try:
            with db.begin_nested():
                db.add(invoice)
                db.flush()
                for line in item["lines"]:
                    db.add(PlatformInvoiceLine(invoice_id=invoice.id, kind=line["kind"], description=line["description"][:300], quantity=line["quantity"],
                                               unit_price=line["unit_price"], amount=line["amount"], meter=line["meter"]))
                if item.get("once_redemptions"):  # one-time coupons are used up by this invoice
                    from app.models.platform_discount import PlatformCouponRedemption
                    db.query(PlatformCouponRedemption).filter(PlatformCouponRedemption.id.in_(item["once_redemptions"]),
                                                              PlatformCouponRedemption.first_invoice_id.is_(None)).update(
                        {"first_invoice_id": invoice.id, "status": "used"}, synchronize_session=False)
                usage_ids = [line["meter"]["usage_charge_id"] for line in item["lines"] if line["kind"] == "usage"]
                if usage_ids:  # each month's usage charge is billed once
                    from app.models.platform_addons import PlatformUsageCharge
                    db.query(PlatformUsageCharge).filter(PlatformUsageCharge.id.in_(usage_ids), PlatformUsageCharge.invoice_id.is_(None)).update(
                        {"invoice_id": invoice.id, "status": "invoiced"}, synchronize_session=False)
                fee_ids = [line["meter"]["invoice_id"] for line in item["lines"] if line["kind"] == "late_fee"]
                if fee_ids:  # each overdue invoice's late fee is billed once
                    db.query(PlatformInvoice).filter(PlatformInvoice.id.in_(fee_ids), PlatformInvoice.late_fee_invoice_id.is_(None)).update(
                        {"late_fee_invoice_id": invoice.id}, synchronize_session=False)
                if item["notes"]:
                    db.add(PlatformInvoiceLine(invoice_id=invoice.id, kind="note", description="Metering notes", quantity=0, unit_price=0, amount=0,
                                               note="\n".join(item["notes"])))
        except IntegrityError:
            continue  # another run billed this period a moment ago
        created.append({"invoice": invoice, "item": item})
    return created


def outstanding(db: Session, tenant_ids: list[int]) -> Decimal:
    from app.services import platform_invoicing as invoicing
    invoicing.ensure_schema()
    value = db.query(func.coalesce(func.sum(invoicing.balance_expr()), 0)).filter(PlatformInvoice.status == "Pending",
                                                                                   PlatformInvoice.tenant_id.in_(tenant_ids or [0])).scalar()
    return money(value)
