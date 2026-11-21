"""Add-ons & usage pricing (Business → Add-ons & usage pricing).

Add-ons: a catalogue of monthly add-ons (platform_addons) and tenants' subscriptions to them (platform_tenant_addons).
Subscribing bills the add-on on the tenant's invoices from the next billing run (price × quantity × months of the
billing period, in advance, like the plan); it does not provision anything or change the tenant's limits. A new
add-on starts as Draft and can't be subscribed until it is named and switched to Active or Beta; Paused stops new
subscriptions while existing ones keep billing. Add-on MRR is part of recurring revenue (platform_billing.recurring).

Usage pricing: per plan and metric an included quota and an overage price, dated (platform_usage_rates). A job closes
each finished calendar month: it sums the tenant's metered usage from Usage Monitoring (platform_tenant_usage_hours –
API calls, AI queries, e-mails sent; storage = the month's peak GB), applies the rate in force on the month's last day
and stores one charge per tenant, metric and month (unique – never charged twice). Pending charges are billed on the
tenant's next invoice. WhatsApp / SMS is not metered (the platform sends neither): it has rates but never charges.
Overage is billed only while Control Center "Over-limit behaviour" is "Soft – allow and bill". Hourly usage is kept
100 days, so only months inside that window can be closed.

Trials: trial length is the Control Center "Trial length (days)" that onboarding uses; one extension per tenant up to
"Extension allowed". Card capture and automatic paid conversion need a stored payment authorization, which the platform
does not have – both are reported as unavailable and nothing is converted.

Price books: ₹ per unit of USD / EUR / AED, dated; seat prices are the plans' monthly price ÷ included users.
"""

from __future__ import annotations

import calendar
import re
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Optional

from sqlalchemy import func, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import master_engine
from app.models.platform_addons import (PlatformAddon, PlatformFxRate, PlatformTenantAddon, PlatformTrialExtension, PlatformUsageCharge,
                                        PlatformUsageRate)
from app.models.tenant import Plan, Tenant


class AddonError(Exception):
    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.status = status


def money(v) -> Decimal:
    return Decimal(str(v or 0)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


# The catalogue the prototype ships with (name, ₹ per month, status).
CATALOGUE = [("Extra storage – 100 GB", 2500, "Active"), ("AI credits – 5,000 queries", 4000, "Active"), ("Additional users – pack of 10", 7990, "Active"),
             ("Branded mobile app", 29999, "Active"), ("Sandbox environment", 6000, "Active"), ("Premium support (24×7)", 15000, "Active"),
             ("Dedicated database shard", 45000, "Beta")]
METRICS = [  # key, label (prototype), unit, metered from
    ("api", "API calls", "calls", "Usage Monitoring – every API request"),
    ("ai", "AI queries", "queries", "Usage Monitoring – AI Smart Search questions"),
    ("storage", "Storage", "GB", "Usage Monitoring – hourly document-storage snapshots (monthly peak)"),
    ("email", "E-mails sent", "mails", "Usage Monitoring – e-mails sent with tenant SMTP"),
    ("messaging", "WhatsApp / SMS", "messages", None),
]
METRIC_KEYS = [m[0] for m in METRICS]
_HOURLY = {"api": "api", "ai": "ai", "email": "email", "storage": "storage_mb"}
_UNITS = {m[0]: m[2] for m in METRICS}
_LABELS = {m[0]: m[1] for m in METRICS}
CURRENCIES = [("INR", "₹"), ("USD", "$"), ("EUR", "€"), ("AED", "AED ")]
_ready = {"schema": False}


def ensure_schema() -> None:
    if _ready["schema"]:
        return
    from app.services import platform_invoicing
    platform_invoicing.ensure_schema()
    for model in (PlatformAddon, PlatformTenantAddon, PlatformUsageRate, PlatformUsageCharge, PlatformFxRate, PlatformTrialExtension):
        model.__table__.create(bind=master_engine, checkfirst=True)
    with master_engine.begin() as conn:
        if not conn.execute(text("SELECT COUNT(*) FROM platform_addons")).scalar():
            for name, price, status in CATALOGUE:
                conn.execute(text("INSERT INTO platform_addons (name, price, unit, status, created_by, created_at) VALUES (:n, :p, 'per month', :s, 'catalogue', NOW())"),
                             {"n": name, "p": price, "s": status})
    _ready["schema"] = True


# ─── Catalogue ───────────────────────────────────────────────────────────────

def _lock(db: Session, addon_id: int) -> PlatformAddon:
    a = db.query(PlatformAddon).filter(PlatformAddon.id == addon_id).with_for_update().first()
    if a is None:
        raise AddonError("Add-on not found", 404)
    return a


def _default_name(n: int) -> str:
    return "New add-on" if n == 1 else f"New add-on {n}"


def create_addon(db: Session, actor: Optional[str]) -> PlatformAddon:
    """A Draft row to configure in place (the prototype's New add-on); not offered until it is activated."""
    names = {n for (n,) in db.query(PlatformAddon.name).filter(PlatformAddon.name.like("New add-on%")).all()}
    name = next(_default_name(i) for i in range(1, 1000) if _default_name(i) not in names)
    a = PlatformAddon(name=name, price=Decimal("5000.00"), unit="per month", status="Draft", created_by=actor)
    db.add(a)
    db.flush()
    return a


def _price(value) -> Decimal:
    try:
        p = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise AddonError("The price must be a number", 422)
    if p <= 0 or p > Decimal("10000000") or p != p.quantize(Decimal("0.01")):
        raise AddonError("The price must be above ₹0 and at most ₹1,00,00,000 (paise at most)", 422)
    return p


def update_addon(db: Session, addon_id: int, name: Optional[str], price, actor: Optional[str]) -> tuple[PlatformAddon, dict]:
    a = _lock(db, addon_id)
    old = {"name": a.name, "price": str(a.price)}
    if name is not None:
        name = re.sub(r"\s+", " ", name).strip()
        if not 3 <= len(name) <= 120:
            raise AddonError("The name must be 3–120 characters", 422)
        if db.query(PlatformAddon.id).filter(func.lower(PlatformAddon.name) == name.lower(), PlatformAddon.id != a.id).first():
            raise AddonError(f"An add-on called “{name}” already exists", 409)
        a.name = name
    if price is not None:
        a.price = _price(price)
    a.updated_at = datetime.utcnow()
    return a, old


def set_status(db: Session, addon_id: int, status: str) -> tuple[PlatformAddon, str]:
    if status not in ("Active", "Beta", "Paused"):
        raise AddonError("Status must be Active, Beta or Paused", 422)
    a = _lock(db, addon_id)
    old = a.status
    if status in ("Active", "Beta") and re.fullmatch(r"New add-on( \d+)?", a.name):
        raise AddonError("Name the add-on before offering it", 422)
    if status == "Paused" and old == "Draft":
        raise AddonError("A draft isn't offered yet – there is nothing to pause", 409)
    a.status, a.updated_at = status, datetime.utcnow()
    return a, old


def catalogue(db: Session, tenant_ids: Optional[list[int]]) -> list[dict]:
    """Every add-on with its subscribed tenants and MRR (paying tenants only), in one grouped query."""
    from app.services.platform_billing import NOT_BILLED
    paying = (Tenant.status == "active") & Tenant.billing_status.notin_(NOT_BILLED)
    q = (db.query(PlatformTenantAddon.addon_id, func.count(func.distinct(PlatformTenantAddon.tenant_id)),
                  func.coalesce(func.sum(func.IF(paying, PlatformTenantAddon.quantity, 0)), 0))
         .join(Tenant, Tenant.id == PlatformTenantAddon.tenant_id).filter(PlatformTenantAddon.status == "active"))
    if tenant_ids is not None:
        q = q.filter(PlatformTenantAddon.tenant_id.in_(tenant_ids or [0]))
    counts = {aid: (int(n), int(units)) for aid, n, units in q.group_by(PlatformTenantAddon.addon_id).all()}
    rows = []
    for a in db.query(PlatformAddon).order_by(PlatformAddon.id).all():
        n, units = counts.get(a.id, (0, 0))
        rows.append({"id": a.id, "name": a.name, "price": float(a.price), "unit": a.unit, "status": a.status, "tenants": n, "mrr": float(money(a.price * units))})
    return rows


# ─── Tenant subscriptions ────────────────────────────────────────────────────

def tenant_addons(db: Session, tenant_id: int) -> list[dict]:
    subs = {s.addon_id: s for s in db.query(PlatformTenantAddon).filter(PlatformTenantAddon.tenant_id == tenant_id).all()}
    out = []
    for a in db.query(PlatformAddon).filter(PlatformAddon.status != "Draft").order_by(PlatformAddon.id).all():
        s = subs.get(a.id)
        on = bool(s and s.status == "active")
        if a.status == "Paused" and not on:
            continue  # paused: not offered to new subscribers
        out.append({"addon_id": a.id, "name": a.name, "price": float(a.price), "unit": a.unit, "status": a.status, "active": on,
                    "quantity": s.quantity if s else 1, "since": s.started_on if on else None})
    return out


def subscribe(db: Session, tenant: Tenant, addon_id: int, active: bool, quantity: int, actor: Optional[str]) -> tuple[Optional[PlatformTenantAddon], PlatformAddon, bool]:
    """Turn a tenant's add-on on or off. Returns (subscription, add-on, changed)."""
    a = db.get(PlatformAddon, addon_id)
    if a is None:
        raise AddonError("Add-on not found", 404)
    if not 1 <= quantity <= 1000:
        raise AddonError("Quantity must be 1–1000", 422)
    s = db.query(PlatformTenantAddon).filter(PlatformTenantAddon.tenant_id == tenant.id, PlatformTenantAddon.addon_id == a.id).with_for_update().first()
    if active:
        if a.status not in ("Active", "Beta") and not (s and s.status == "active"):
            raise AddonError(f"{a.name} is {a.status.lower()} – it can't be added", 409)
        if s is None:
            s = PlatformTenantAddon(tenant_id=tenant.id, addon_id=a.id, quantity=quantity, status="active", started_on=date.today(), updated_by=actor)
            try:
                with db.begin_nested():
                    db.add(s)
                    db.flush()
            except IntegrityError:
                raise AddonError("Changed by someone else a moment ago – reload", 409)
            return s, a, True
        changed = s.status != "active" or s.quantity != quantity
        if s.status != "active":
            s.started_on, s.ended_on = date.today(), None
        s.status, s.quantity = "active", quantity
    else:
        if s is None or s.status != "active":
            return s, a, False
        changed = True
        s.status, s.ended_on = "cancelled", date.today()
    s.updated_by, s.updated_at = actor, datetime.utcnow()
    return s, a, changed


def addon_mrr_by_tenant(db: Session, tenant_ids: list[int]) -> dict[int, Decimal]:
    rows = (db.query(PlatformTenantAddon.tenant_id, func.sum(PlatformAddon.price * PlatformTenantAddon.quantity))
            .join(PlatformAddon, PlatformAddon.id == PlatformTenantAddon.addon_id)
            .filter(PlatformTenantAddon.status == "active", PlatformTenantAddon.tenant_id.in_(tenant_ids or [0])).group_by(PlatformTenantAddon.tenant_id).all())
    return {tid: money(v) for tid, v in rows}


def addon_lines(db: Session, tenant_ids: list[int], months: dict[int, int]) -> dict[int, list[dict]]:
    """Invoice lines for active add-ons (billed in advance for the period's months)."""
    rows = (db.query(PlatformTenantAddon, PlatformAddon).join(PlatformAddon, PlatformAddon.id == PlatformTenantAddon.addon_id)
            .filter(PlatformTenantAddon.status == "active", PlatformTenantAddon.tenant_id.in_(tenant_ids or [0])).order_by(PlatformAddon.id).all())
    out: dict[int, list[dict]] = {}
    for s, a in rows:
        n = months.get(s.tenant_id, 1)
        qty = Decimal(s.quantity * n)
        out.setdefault(s.tenant_id, []).append({"kind": "addon", "description": f"Add-on: {a.name}" + (f" × {s.quantity}" if s.quantity > 1 else "") + (f" × {n} months" if n > 1 else ""),
                                                "quantity": qty, "unit_price": money(a.price), "amount": money(a.price * qty), "meter": {"addon_id": a.id}})
    return out


# ─── Usage rates ─────────────────────────────────────────────────────────────

def rates_in_force(db: Session, on: date) -> dict[tuple[int, str], PlatformUsageRate]:
    """Latest rate per (plan, metric) effective on a date – one query."""
    latest = (db.query(PlatformUsageRate.plan_id, PlatformUsageRate.metric, func.max(PlatformUsageRate.effective_from).label("d"))
              .filter(PlatformUsageRate.effective_from <= on).group_by(PlatformUsageRate.plan_id, PlatformUsageRate.metric).subquery())
    rows = db.query(PlatformUsageRate).join(latest, (PlatformUsageRate.plan_id == latest.c.plan_id) & (PlatformUsageRate.metric == latest.c.metric)
                                             & (PlatformUsageRate.effective_from == latest.c.d)).all()
    return {(r.plan_id, r.metric): r for r in rows}


def set_rate(db: Session, plan_id: int, metric: str, included, price, actor: Optional[str]) -> tuple[PlatformUsageRate, dict]:
    if metric not in METRIC_KEYS:
        raise AddonError("Unknown metric", 422)
    if db.get(Plan, plan_id) is None:
        raise AddonError("Plan not found", 404)
    current = rates_in_force(db, date.today()).get((plan_id, metric))
    old = {"included": str(current.included) if current and current.included is not None else None, "price": str(current.price) if current and current.price is not None else None}
    new_inc = current.included if current else None
    new_price = current.price if current else None
    if included is not None:
        try:
            new_inc = Decimal(str(included))
        except (InvalidOperation, ValueError):
            raise AddonError("The quota must be a number", 422)
        whole = metric != "storage"
        if new_inc < 0 or new_inc > Decimal("1000000000000") or (whole and new_inc != new_inc.to_integral_value()) or new_inc != new_inc.quantize(Decimal("0.01")):
            raise AddonError("The quota must be zero or more" + (", in whole units" if whole else " (2 decimals at most)"), 422)
    if price is not None:
        try:
            new_price = Decimal(str(price))
        except (InvalidOperation, ValueError):
            raise AddonError("The overage price must be a number", 422)
        if new_price < 0 or new_price > Decimal("100000") or new_price != new_price.quantize(Decimal("0.0001")):
            raise AddonError("The overage price must be ₹0–₹1,00,000 per unit (4 decimals at most)", 422)
    row = db.query(PlatformUsageRate).filter(PlatformUsageRate.plan_id == plan_id, PlatformUsageRate.metric == metric,
                                             PlatformUsageRate.effective_from == date.today()).with_for_update().first()
    if row is None:  # a new dated row; months already charged keep the rate they were charged at
        row = PlatformUsageRate(plan_id=plan_id, metric=metric, effective_from=date.today())
        db.add(row)
    row.included, row.price, row.updated_by, row.updated_at = new_inc, new_price, actor, datetime.utcnow()
    db.flush()
    return row, old


# ─── Monthly usage close ─────────────────────────────────────────────────────

def _month_bounds(month: date) -> tuple[date, date]:
    return month, month.replace(day=calendar.monthrange(month.year, month.month)[1])


def _prev_month(d: date) -> date:
    return (d.replace(day=1) - timedelta(days=1)).replace(day=1)


def _hour(d: date) -> int:
    return int(datetime.combine(d, datetime.min.time()).timestamp() // 3600)


def close_months(db: Session, today: Optional[date] = None) -> dict:
    """Charge every finished month inside Usage Monitoring's retention that has not been charged. Idempotent."""
    from app.services import platform_controls as controls
    from app.services import platform_usage
    from app.services.platform_billing import is_paying
    ensure_schema()
    today = today or date.today()
    since = platform_usage.collecting_since()
    if since is None:
        return {"closed": 0, "note": "Usage Monitoring has not collected anything yet"}
    since_day = datetime.fromtimestamp(since).date()
    oldest = _hour(today) - platform_usage.RETENTION_HOURS + 24
    with master_engine.connect() as lock:
        if lock.execute(text("SELECT GET_LOCK('platform_usage_close', 0)")).scalar() != 1:
            return {"skipped": "another worker is closing usage"}
        try:
            summary = {"months": [], "charges": 0, "billable": "0.00"}
            months, month = [], _prev_month(today)
            while _hour(month) >= oldest and _month_bounds(month)[1] >= since_day:
                months.append(month)
                month = _prev_month(month)
            tenants = db.query(Tenant).all()
            soft = controls.value(db, "planOver") == "Soft – allow and bill"
            billable = Decimal(0)
            for month in reversed(months):
                start, end = _month_bounds(month)
                done = set(db.query(PlatformUsageCharge.tenant_id, PlatformUsageCharge.metric).filter(PlatformUsageCharge.month == start).all())
                if all((t.id, m) in done for t in tenants for m in _HOURLY):
                    continue
                with master_engine.connect() as conn:
                    sums = {(slug, meter): (Decimal(str(total or 0)), Decimal(str(peak or 0))) for slug, meter, total, peak in conn.execute(text(
                        "SELECT tenant_slug, meter, SUM(value), MAX(value) FROM platform_tenant_usage_hours WHERE hour BETWEEN :a AND :b "
                        "AND meter IN ('api', 'ai', 'email', 'storage_mb') GROUP BY tenant_slug, meter"), {"a": _hour(start), "b": _hour(end + timedelta(days=1)) - 1})}
                rates = rates_in_force(db, end)
                partial = f"Measured from {since_day:%d %b %Y}" if since_day > start else None
                for t in tenants:
                    for metric, meter in _HOURLY.items():
                        if (t.id, metric) in done:
                            continue
                        total, peak = sums.get((t.slug, meter), (Decimal(0), Decimal(0)))
                        used = (peak / 1024).quantize(Decimal("0.001")) if metric == "storage" else total
                        rate = rates.get((t.plan_id, metric))
                        inc, price = (rate.included, rate.price) if rate else (None, None)
                        over = max(Decimal(0), used - inc) if inc is not None else Decimal(0)
                        amount = money(over * price) if inc is not None and price is not None else Decimal("0.00")
                        note = partial
                        if inc is None or price is None:
                            status, note = "none", "No quota / overage price set for this plan"
                        elif amount <= 0:
                            status = "none"
                        elif not is_paying(t):
                            status, note = "not_billed", f"Tenant not billed ({t.status}, billing {t.billing_status})"
                        elif not soft:
                            status, note = "not_billed", "Over-limit behaviour is not “Soft – allow and bill”"
                        else:
                            status = "pending"
                        try:
                            with db.begin_nested():
                                db.add(PlatformUsageCharge(tenant_id=t.id, metric=metric, month=start, plan_id=t.plan_id, used=used, included=inc, price=price,
                                                           rate_id=rate.id if rate else None, overage=over, amount=amount, status=status, note=note))
                                db.flush()
                        except IntegrityError:
                            continue  # charged by another run
                        summary["charges"] += 1
                        if status == "pending":
                            billable += amount
                db.commit()
                summary["months"].append(f"{start:%b %Y}")
            summary["billable"] = str(billable)
            return summary
        finally:
            lock.execute(text("SELECT RELEASE_LOCK('platform_usage_close')"))


def usage_lines(db: Session, tenant_ids: list[int]) -> dict[int, list[dict]]:
    """Pending (not yet invoiced) usage charges as invoice lines."""
    rows = (db.query(PlatformUsageCharge).filter(PlatformUsageCharge.status == "pending", PlatformUsageCharge.invoice_id.is_(None),
                                                 PlatformUsageCharge.tenant_id.in_(tenant_ids or [0])).order_by(PlatformUsageCharge.month, PlatformUsageCharge.metric).all())
    out: dict[int, list[dict]] = {}
    for c in rows:
        dp = 3 if c.metric == "storage" else 0
        out.setdefault(c.tenant_id, []).append({
            "kind": "usage", "description": f"{_LABELS[c.metric]} above quota – {c.month:%b %Y}: {c.used:,.{dp}f} {_UNITS[c.metric]} used, {c.included:,.{min(dp, 2)}f} included",
            "quantity": c.overage, "unit_price": c.price, "amount": c.amount,
            "meter": {"usage_charge_id": c.id, "metric": c.metric, "month": str(c.month), "used": str(c.used), "included": str(c.included), "price": str(c.price)}})
    return out


# ─── KPIs and overview pieces ────────────────────────────────────────────────

def kpis(db: Session, tenant_ids: Optional[list[int]], cat: list[dict], today: Optional[date] = None) -> dict:
    today = today or date.today()
    month = _prev_month(today)
    tq = db.query(func.count(func.distinct(PlatformTenantAddon.tenant_id))).filter(PlatformTenantAddon.status == "active")
    oq = db.query(func.coalesce(func.sum(PlatformUsageCharge.amount), 0)).filter(PlatformUsageCharge.month == month, PlatformUsageCharge.status.in_(("pending", "invoiced")))
    if tenant_ids is not None:
        tq = tq.filter(PlatformTenantAddon.tenant_id.in_(tenant_ids or [0]))
        oq = oq.filter(PlatformUsageCharge.tenant_id.in_(tenant_ids or [0]))
    closed = db.query(PlatformUsageCharge.id).filter(PlatformUsageCharge.month == month).first() is not None
    return {"addons": len(cat), "addon_mrr": float(money(sum(Decimal(str(a["mrr"])) for a in cat))), "tenants_with_addons": int(tq.scalar()),
            "overage_month": float(money(oq.scalar())), "overage_month_label": f"{month:%b %Y}", "overage_month_closed": closed}


def usage_tables(db: Session) -> list[dict]:
    from app.services import platform_usage
    since = platform_usage.collecting_since()
    plans = db.query(Plan).filter(Plan.is_active == True).order_by(Plan.price_monthly, Plan.name).all()  # noqa: E712
    rates = rates_in_force(db, date.today())
    out = []
    for key, label, unit, source in METRICS:
        rows = []
        for p in plans:
            r = rates.get((p.id, key))
            inc, price = (r.included, r.price) if r else (None, None)
            example = money(inc * Decimal("0.5") * price) if inc is not None and price is not None else None
            rows.append({"plan_id": p.id, "plan": p.name, "included": float(inc) if inc is not None else None, "price": float(price) if price is not None else None,
                         "example": float(example) if example is not None else None, "effective_from": r.effective_from if r else None})
        out.append({"metric": key, "label": label, "unit": unit, "metered": source is not None and since is not None,
                    "source": source or "Not metered – the platform sends no WhatsApp or SMS messages, so nothing is charged",
                    "since": datetime.fromtimestamp(since).date() if since and source else None, "rows": rows})
    return out


# ─── Trials ──────────────────────────────────────────────────────────────────

TRIAL_DEFAULTS = {"extension_days": 7, "auto_convert": True, "convert_plan_id": None}
NO_AUTHORIZATION = "the platform can't store a payment authorization (card or e-mandate)"


def trial_settings(db: Session) -> dict:
    from app.models.platform_invoicing import PlatformBillingSetting
    from app.services import platform_controls as controls
    row = db.get(PlatformBillingSetting, "trials")
    value = {**TRIAL_DEFAULTS, **(row.value if row and isinstance(row.value, dict) else {})}
    plan = db.get(Plan, value["convert_plan_id"]) if value["convert_plan_id"] else db.query(Plan).filter(func.lower(Plan.name) == "growth").first()
    return {"trial_days": int(controls.value(db, "trialDays") or 30), "extension_days": value["extension_days"], "auto_convert": bool(value["auto_convert"]),
            "convert_plan_id": plan.id if plan else None, "convert_plan": plan.name if plan else None, "require_card": False, "seed_sample": False,
            "status": {"require_card": f"Unavailable – {NO_AUTHORIZATION}, so a card can't be required",
                       "auto_convert": f"Not available – {NO_AUTHORIZATION}; trials are never converted automatically. Convert a tenant on Tenants → Billing.",
                       "seed_sample": "Unavailable – onboarding has no sample-data seeder; new workspaces start from the industry template (Control Center “Seed new tenants with”)"}}


def update_trials(db: Session, patch: dict, actor: Optional[str]) -> tuple[dict, dict]:
    from app.models.platform_invoicing import PlatformBillingSetting
    from app.services import platform_controls as controls
    unknown = set(patch) - {"trial_days", "extension_days", "auto_convert", "convert_plan_id", "require_card", "seed_sample"}
    if unknown:
        raise AddonError(f"Unknown field: {', '.join(sorted(unknown))}", 422)
    old = trial_settings(db)
    for key in ("require_card", "seed_sample"):
        if patch.get(key):
            raise AddonError(old["status"][key], 409)
    row = db.query(PlatformBillingSetting).filter(PlatformBillingSetting.key == "trials").with_for_update().first()
    value = {**TRIAL_DEFAULTS, **(row.value if row else {})}

    def days(key: str, lo: int, hi: int, label: str) -> int:
        v = patch[key]
        if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi:
            raise AddonError(f"{label} must be {lo}–{hi} days", 422)
        return v
    if "trial_days" in patch:
        controls.store(db, "trialDays", days("trial_days", 1, 90, "Trial length"), 0, actor)  # the value onboarding reads
    if "extension_days" in patch:
        value["extension_days"] = days("extension_days", 0, 60, "Extension")
    if "auto_convert" in patch:
        if not isinstance(patch["auto_convert"], bool):
            raise AddonError("Expected on or off", 422)
        value["auto_convert"] = patch["auto_convert"]
    if "convert_plan_id" in patch:
        plan = db.get(Plan, patch["convert_plan_id"]) if patch["convert_plan_id"] else None
        if patch["convert_plan_id"] and (plan is None or not plan.is_active or not plan.price_monthly):
            raise AddonError("Choose an active paid plan", 422)
        value["convert_plan_id"] = plan.id if plan else None
    if row is None:
        row = PlatformBillingSetting(key="trials", value=value)
        db.add(row)
    row.value, row.updated_by, row.updated_at = value, actor, datetime.utcnow()
    db.flush()
    return old, trial_settings(db)


def extend_trial(db: Session, tenant: Tenant, days: int, actor: Optional[str]) -> PlatformTrialExtension:
    allowed = trial_settings(db)["extension_days"]
    if tenant.status != "trial" or not tenant.trial_ends_at:
        raise AddonError(f"{tenant.name} is not on a trial", 409)
    if not allowed:
        raise AddonError("Trial extensions are switched off (Extension allowed = 0 days)", 409)
    if not isinstance(days, int) or isinstance(days, bool) or not 1 <= days <= allowed:
        raise AddonError(f"Extend by 1–{allowed} days", 422)
    if db.query(PlatformTrialExtension.id).filter(PlatformTrialExtension.tenant_id == tenant.id).first():
        raise AddonError(f"{tenant.name}'s trial has already been extended once", 409)
    ext = PlatformTrialExtension(tenant_id=tenant.id, days=days, old_end=tenant.trial_ends_at, new_end=tenant.trial_ends_at + timedelta(days=days), granted_by=actor)
    try:
        with db.begin_nested():
            db.add(ext)
            db.flush()
    except IntegrityError:
        raise AddonError(f"{tenant.name}'s trial has already been extended once", 409)
    tenant.trial_ends_at = ext.new_end
    return ext


# ─── Price books ─────────────────────────────────────────────────────────────

def _book_plans(db: Session) -> list[Plan]:
    """The two plans in the seat-price columns: Growth and Enterprise when they exist, else the closest paid plans."""
    plans = [p for p in db.query(Plan).filter(Plan.is_active == True, Plan.price_monthly > 0).order_by(Plan.price_monthly).all() if p.slug != "test"]  # noqa: E712
    by_name = {p.name.lower(): p for p in plans}
    ent = by_name.get("enterprise") or (plans[-1] if plans else None)
    growth = by_name.get("growth") or next((p for p in reversed(plans) if ent and p.price_monthly < ent.price_monthly), None)
    return [p for p in (growth, ent) if p]


def fx_in_force(db: Session, on: date) -> dict[str, PlatformFxRate]:
    latest = db.query(PlatformFxRate.currency, func.max(PlatformFxRate.effective_from).label("d")).filter(PlatformFxRate.effective_from <= on).group_by(PlatformFxRate.currency).subquery()
    return {r.currency: r for r in db.query(PlatformFxRate).join(latest, (PlatformFxRate.currency == latest.c.currency) & (PlatformFxRate.effective_from == latest.c.d)).all()}


def price_books(db: Session) -> dict:
    from app.services import platform_controls as controls
    from app.services import platform_invoicing as inv
    plans = _book_plans(db)
    rates = fx_in_force(db, date.today())
    upcoming = {r.currency: r for r in db.query(PlatformFxRate).filter(PlatformFxRate.effective_from > date.today()).order_by(PlatformFxRate.effective_from.desc()).all()}
    gst = inv.setting(db, "gst")
    tax_on = bool(controls.value(db, "invTax"))
    seat = [money(Decimal(p.price_monthly) / Decimal(p.max_users or 1)) for p in plans]
    rows = []
    for code, sym in CURRENCIES:
        r = Decimal(1) if code == "INR" else (rates[code].rate if code in rates else None)
        rows.append({"currency": code, "symbol": sym, "rate": float(r) if r is not None else None,
                     "effective_from": rates[code].effective_from if code in rates else None,
                     "upcoming": {"rate": float(upcoming[code].rate), "effective_from": upcoming[code].effective_from} if code in upcoming else None,
                     "seats": [float((s / r).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)) if r else None for s in seat],
                     "tax": (f"GST {gst['rate']}%" if tax_on else "None (tax off)") if code == "INR" else "Not set up – invoices are raised in ₹ only"})
    return {"plans": [{"id": p.id, "name": p.name, "per_seat_inr": float(s), "max_users": p.max_users} for p, s in zip(plans, seat)], "rows": rows}


def set_fx(db: Session, currency: str, rate, effective_from: date, actor: Optional[str]) -> tuple[PlatformFxRate, Optional[str]]:
    if currency not in ("USD", "EUR", "AED"):
        raise AddonError("Rates can be set for USD, EUR and AED (₹ is the base currency)", 422)
    try:
        r = Decimal(str(rate))
    except (InvalidOperation, ValueError):
        raise AddonError("The rate must be a number", 422)
    if not Decimal("0.01") <= r <= Decimal("10000") or r != r.quantize(Decimal("0.0001")):
        raise AddonError("The rate must be ₹0.01–₹10,000 per unit (4 decimals at most)", 422)
    if not date.today() - timedelta(days=31) <= effective_from <= date.today() + timedelta(days=90):
        raise AddonError("The effective date must be within the last 31 days or the next 90", 422)
    prev = fx_in_force(db, effective_from)
    old = str(prev[currency].rate) if currency in prev else None
    row = db.query(PlatformFxRate).filter(PlatformFxRate.currency == currency, PlatformFxRate.effective_from == effective_from).with_for_update().first()
    if row is None:
        row = PlatformFxRate(currency=currency, effective_from=effective_from)
        db.add(row)
    row.rate, row.updated_by, row.updated_at = r, actor, datetime.utcnow()
    db.flush()
    return row, old
