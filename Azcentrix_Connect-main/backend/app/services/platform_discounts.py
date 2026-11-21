"""Discounts & coupons (Business → Discounts & coupons) and the discount part of billing.

Sources of discount on a subscription, evaluated month by month over an invoice period:
    Volume tier        seat bands (platform_volume_tiers) on the tenant's licensed seats (max_users), while Control
                       Center "Volume-based pricing" is on
    Negotiated         an approved platform_tenant_discounts row, only for months inside starts_on … valid_until
    Coupon             a redemption (terms copied at redemption): once = the first invoice after redemption; repeating
                       3 / 12 months from the redemption month; forever; annual prepay = annual invoices only
    Annual prepay      "Discount when paying yearly" on annual invoices of plans without their own yearly price
Rules (Control Center → Pricing, coupons & tax): a negotiated discount replaces the volume discount (dcNegReplace);
a coupon replaces it unless dcStackVol; the combined percentage is capped at couponMax; fixed-amount coupons come
after percentages and never take the subscription below zero. Money is Decimal throughout; GST is added by billing
on the discounted subtotal. Only new invoices are affected – issued invoices are never recalculated.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Optional

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import master_engine
from app.models.platform_discount import (PlatformCoupon, PlatformCouponRedemption, PlatformResellerTierRule, PlatformTenantDiscount,
                                          PlatformVolumeTier)
from app.models.tenant import Plan, Tenant
from app.services import platform_controls as controls

ZERO = Decimal("0")
HUNDRED = Decimal("100")
APPROVAL_THRESHOLD = Decimal("20")
DURATIONS = {"once": "Once", "repeat_3": "Repeating · 3 months", "repeat_12": "Repeating · 12 months", "forever": "Forever", "annual": "Annual prepay"}
REPEAT_MONTHS = {"repeat_3": 3, "repeat_12": 12}
TERMS = (12, 24, 36)
DEFAULT_TIERS = ((1, 25, 0), (26, 75, 5), (76, 150, 10), (151, None, 15))                  # prototype bands
DEFAULT_RESELLER_TIERS = (("Silver", 0, 15), ("Gold", 2_500_000, 20), ("Platinum", 10_000_000, 25))
_ready = {"schema": False}


class DiscountError(Exception):
    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


def ensure_schema() -> None:
    if _ready["schema"]:
        return
    for model in (PlatformCoupon, PlatformCouponRedemption, PlatformVolumeTier, PlatformTenantDiscount, PlatformResellerTierRule):
        model.__table__.create(bind=master_engine, checkfirst=True)
    with master_engine.begin() as conn:  # seed the prototype bands once; staff edit them afterwards
        if not conn.execute(PlatformVolumeTier.__table__.select().limit(1)).first():
            conn.execute(PlatformVolumeTier.__table__.insert(), [{"from_seats": f, "to_seats": t, "pct": p} for f, t, p in DEFAULT_TIERS])
        if not conn.execute(PlatformResellerTierRule.__table__.select().limit(1)).first():
            conn.execute(PlatformResellerTierRule.__table__.insert(), [{"tier": n, "min_arr": a, "margin_pct": m} for n, a, m in DEFAULT_RESELLER_TIERS])
    _ready["schema"] = True


def money(v) -> Decimal:
    return Decimal(str(v or 0)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _pct(v) -> Decimal:
    return Decimal(str(v or 0))


def _add_months(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    y, m = d.year + y, m + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def _month_starts(start: date, end: date) -> list[date]:
    out, m = [], date(start.year, start.month, 1)
    while m <= end:
        out.append(m)
        m = _add_months(m, 1)
    return out


# ─── Coupons ─────────────────────────────────────────────────────────────────

def coupon_status(c: PlatformCoupon, today: Optional[date] = None) -> str:
    today = today or date.today()
    if c.status == "paused":
        return "Paused"
    if c.valid_until < today:
        return "Expired"
    if c.redemption_limit and c.redeemed_count >= c.redemption_limit:
        return "Exhausted"
    return "Active"


def create_coupon(db: Session, actor: str, code: str, kind: str, value, duration: str, plan_ids: Optional[list[int]], limit, valid_until: date,
                  note: str) -> PlatformCoupon:
    ensure_schema()
    code = (code or "").strip().upper()
    if not code:
        raise DiscountError("Enter a code")
    if not all(ch.isalnum() or ch in "-_" for ch in code) or len(code) > 40:
        raise DiscountError("Codes use letters, digits, - and _ only (up to 40 characters)")
    if kind not in ("percent", "amount"):
        raise DiscountError("Choose Percentage off or Fixed amount off")
    try:
        val = money(value)
    except Exception:
        raise DiscountError("Enter a number for the value")
    if val <= 0:
        raise DiscountError("The value must be above zero")
    if kind == "percent" and val > HUNDRED:
        raise DiscountError("A percentage can't be above 100")
    cap = _pct(controls.value(db, "couponMax", None) or 100)
    if kind == "percent" and val > cap:
        raise DiscountError(f"The maximum discount is {cap:g}% (Control Center → Pricing, coupons & tax)")
    if duration not in DURATIONS:
        raise DiscountError("Choose a duration")
    known = {pid for (pid,) in db.query(Plan.id).filter(Plan.is_active == True).all()}  # noqa: E712
    if plan_ids is not None:
        plan_ids = sorted({int(p) for p in plan_ids})
        if not plan_ids:
            raise DiscountError("Choose at least one plan")
        unknown = [p for p in plan_ids if p not in known]
        if unknown:
            raise DiscountError("Choose active plans only")
        if set(plan_ids) == known:
            plan_ids = None  # every active plan = all plans, including plans added later
    try:
        limit_n = int(limit)
    except (TypeError, ValueError):
        raise DiscountError("The redemption limit must be a whole number")
    if limit_n < 0 or limit_n > 1_000_000:
        raise DiscountError("The redemption limit must be 0 (unlimited) or more")
    if valid_until < date.today():
        raise DiscountError("“Valid until” can't be in the past")
    if valid_until > date.today() + timedelta(days=3 * 365):
        raise DiscountError("“Valid until” must be within 3 years")
    if db.query(PlatformCoupon.id).filter(PlatformCoupon.code == code).first():
        raise DiscountError(f"Code {code} already exists (codes are never reused, even after deletion)", 409)
    row = PlatformCoupon(code=code, kind=kind, value=val, duration=duration, plan_ids=plan_ids, redemption_limit=limit_n, valid_until=valid_until,
                         status="active", note=(note or "").strip()[:300] or None, created_by=actor)
    db.add(row)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise DiscountError(f"Code {code} already exists", 409)
    return row


def redeem(db: Session, coupon_code: str, tenant: Tenant, actor: str) -> PlatformCouponRedemption:
    """Apply a coupon to a tenant. The coupon row is locked so its redemption limit can't be overrun by parallel requests."""
    ensure_schema()
    if not controls.value(db, "coupons", None):
        raise DiscountError("Coupons are turned off (Control Center → Pricing, coupons & tax)", 403)
    if tenant.status in ("suspended", "cancelled") or tenant.deletion_scheduled_at:
        raise DiscountError(f"{tenant.name} is not active", 409)
    c = (db.query(PlatformCoupon).filter(PlatformCoupon.code == (coupon_code or "").strip().upper(), PlatformCoupon.deleted_at.is_(None))
         .with_for_update().first())
    if c is None:
        raise DiscountError("Coupon not found", 404)
    status = coupon_status(c)
    if status != "Active":
        raise DiscountError(f"{c.code} is {status.lower()} – it can't be redeemed", 409)
    if c.plan_ids is not None and tenant.plan_id not in c.plan_ids:
        raise DiscountError(f"{c.code} doesn't apply to {tenant.name}'s plan", 409)
    if not controls.value(db, "couponStack", None):
        open_ = db.query(PlatformCouponRedemption.code).filter(PlatformCouponRedemption.tenant_id == tenant.id, PlatformCouponRedemption.status == "active").first()
        if open_:
            raise DiscountError(f"{tenant.name} already has coupon {open_[0]} – stacking coupons is off (Control Center)", 409)
    r = PlatformCouponRedemption(coupon_id=c.id, tenant_id=tenant.id, code=c.code, kind=c.kind, value=c.value, duration=c.duration, plan_id=tenant.plan_id,
                                 redeemed_at=datetime.utcnow(), redeemed_by=actor, status="active")
    db.add(r)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise DiscountError(f"{tenant.name} has already used {c.code}", 409)
    c.redeemed_count += 1
    c.updated_at = datetime.utcnow()
    db.flush()
    return r


# ─── Negotiated discounts ────────────────────────────────────────────────────

def _log(row: PlatformTenantDiscount, action: str, by: str, note: Optional[str] = None) -> None:
    row.history = (row.history or []) + [{"at": datetime.utcnow().isoformat(timespec="seconds") + "Z", "by": by, "action": action, "note": note}]


def request_discount(db: Session, admin, tenant: Tenant, pct, term: int, reason: str) -> PlatformTenantDiscount:
    ensure_schema()
    try:
        p = _pct(pct).quantize(Decimal("0.01"))
    except Exception:
        raise DiscountError("Enter the discount as a number")
    if p <= 0 or p > 60:
        raise DiscountError("The discount must be between 1 and 60%")
    cap = _pct(controls.value(db, "couponMax", None) or 100)
    if p > cap:
        raise DiscountError(f"The maximum discount is {cap:g}% (Control Center → Pricing, coupons & tax)")
    if int(term) not in TERMS:
        raise DiscountError("Choose a 12, 24 or 36 month term")
    reason = " ".join((reason or "").split())
    if len(reason) < 5:
        raise DiscountError("Give the reason (at least 5 characters)")
    if tenant.status in ("suspended", "cancelled") or tenant.deletion_scheduled_at:
        raise DiscountError(f"{tenant.name} is not active", 409)
    if db.query(PlatformTenantDiscount.id).filter(PlatformTenantDiscount.tenant_id == tenant.id,
                                                  PlatformTenantDiscount.status.in_(("pending", "active"))).with_for_update().first():
        raise DiscountError(f"{tenant.name} already has an active or pending negotiated discount – end or reject it first", 409)
    name = (admin.full_name or admin.username) if admin else "platform admin"
    row = PlatformTenantDiscount(tenant_id=tenant.id, pct=p, term_months=int(term), reason=reason[:300], requested_by_id=admin.id if admin else None,
                                 requested_by=name, requested_at=datetime.utcnow())
    needs = bool(controls.value(db, "dcApproval", None)) and p > APPROVAL_THRESHOLD
    if needs:
        row.status = "pending"
        _log(row, "requested", name, f"{p:g}% for {term} months – needs a second approver")
    else:
        _activate(row, name, "Applied (no second approval needed)")
    db.add(row)
    db.flush()
    return row


def _activate(row: PlatformTenantDiscount, by: str, note: str) -> None:
    today = date.today()
    row.status, row.starts_on, row.valid_until = "active", today, _add_months(today, row.term_months) - timedelta(days=1)
    _log(row, "activated", by, note)


def decide(db: Session, admin, row: PlatformTenantDiscount, approve: bool, note: Optional[str]) -> None:
    if row.status != "pending":
        raise DiscountError(f"This discount is {row.status} – only pending discounts can be approved or rejected", 409)
    if admin is None:
        raise DiscountError("A signed-in platform staff member must decide", 403)
    if row.requested_by_id == admin.id:
        raise DiscountError("A discount above 20% needs a second approver – you requested this one", 403)
    name = admin.full_name or admin.username
    row.decided_by_id, row.decided_by, row.decided_at, row.decision_note = admin.id, name, datetime.utcnow(), (note or "").strip()[:300] or None
    if approve:
        _activate(row, name, f"Approved{': ' + note if note else ''}")
    else:
        row.status = "rejected"
        _log(row, "rejected", name, note)


def end(db: Session, admin, row: PlatformTenantDiscount) -> None:
    if row.status != "active":
        raise DiscountError(f"This discount is {row.status}", 409)
    name = (admin.full_name or admin.username) if admin else "platform admin"
    row.status, row.ended_at, row.ended_by = "ended", datetime.utcnow(), name
    row.valid_until = min(row.valid_until or date.today(), date.today())
    _log(row, "ended", name)


# ─── Pricing engine ──────────────────────────────────────────────────────────

@dataclass
class Context:
    """Everything needed to price many tenants, loaded in a fixed number of queries."""
    tiers: list[PlatformVolumeTier]
    negotiated: dict[int, PlatformTenantDiscount]
    redemptions: dict[int, list[PlatformCouponRedemption]]
    rules: dict = field(default_factory=dict)


def context(db: Session, tenant_ids: list[int]) -> Context:
    ensure_schema()
    tiers = db.query(PlatformVolumeTier).order_by(PlatformVolumeTier.from_seats).all()
    neg = {d.tenant_id: d for d in db.query(PlatformTenantDiscount).filter(PlatformTenantDiscount.tenant_id.in_(tenant_ids or [0]),
                                                                             PlatformTenantDiscount.status == "active").all()}
    reds: dict[int, list] = {}
    for r in db.query(PlatformCouponRedemption).filter(PlatformCouponRedemption.tenant_id.in_(tenant_ids or [0]),
                                                       PlatformCouponRedemption.status == "active").order_by(PlatformCouponRedemption.id).all():
        reds.setdefault(r.tenant_id, []).append(r)
    rules = {k: controls.value(db, k, None) for k in ("volume", "couponMax", "dcAnnual", "dcStackVol", "dcNegReplace", "dcShowInv")}
    return Context(tiers=tiers, negotiated=neg, redemptions=reds, rules=rules)


def tier_for(tiers: list[PlatformVolumeTier], seats: Optional[int]) -> Optional[PlatformVolumeTier]:
    if not seats:
        return None
    return next((t for t in tiers if seats >= t.from_seats and (t.to_seats is None or seats <= t.to_seats)), None)


def _coupon_months(r: PlatformCouponRedemption, months: list[date], cycle: str) -> list[date]:
    start = date(r.redeemed_at.year, r.redeemed_at.month, 1)
    if r.duration == "once":
        return months if r.first_invoice_id is None else []
    if r.duration == "annual":
        return months if cycle == "Annual" else []
    if r.duration == "forever":
        return [m for m in months if m >= start]
    end = _add_months(start, REPEAT_MONTHS[r.duration])
    return [m for m in months if start <= m < end]


def price(ctx: Context, tenant: Tenant, cycle: str, start: date, end: date, amount: Decimal, has_yearly_price: bool,
          recurring_only: bool = False) -> dict:
    """Discounts on a subscription ``amount`` covering start…end. Returns {lines, total, pct_months, notes, once}."""
    months = _month_starts(start, end)
    if not months or amount <= 0:
        return {"lines": [], "total": ZERO, "notes": [], "once": []}
    per_month = amount / len(months)
    cap = _pct(ctx.rules.get("couponMax") or 100)
    tier = tier_for(ctx.tiers, tenant.max_users) if ctx.rules.get("volume") else None
    neg = ctx.negotiated.get(tenant.id)
    reds = [r for r in ctx.redemptions.get(tenant.id, []) if not (recurring_only and r.duration == "once")]
    annual = _pct(ctx.rules.get("dcAnnual")) if cycle == "Annual" and not has_yearly_price else ZERO
    amounts: dict[str, Decimal] = {}
    labels: dict[str, str] = {}
    notes: list[str] = []
    coupon_months = {r.id: set(_coupon_months(r, months, cycle)) for r in reds}
    for m in months:
        parts: dict[str, Decimal] = {}
        neg_on = False
        if neg is not None and neg.starts_on and neg.valid_until:
            first = date(neg.starts_on.year, neg.starts_on.month, 1)   # exactly term_months months, fewer if ended early
            neg_on = first <= m < _add_months(first, neg.term_months) and m <= neg.valid_until
        pct_coupons = [r for r in reds if r.kind == "percent" and m in coupon_months[r.id]]
        if neg_on:
            parts[f"neg:{neg.id}"] = _pct(neg.pct)
            labels[f"neg:{neg.id}"] = f"Negotiated discount {_pct(neg.pct):g}% (until {neg.valid_until:%d %b %Y})"
        vol_ok = tier is not None and _pct(tier.pct) > 0 and not (neg_on and ctx.rules.get("dcNegReplace")) and not (pct_coupons and not ctx.rules.get("dcStackVol"))
        if vol_ok:
            parts["volume"] = _pct(tier.pct)
            labels["volume"] = f"Volume discount {_pct(tier.pct):g}% ({tier.from_seats}–{tier.to_seats or '∞'} seats; {tenant.max_users} licensed)"
        for r in pct_coupons:
            parts[f"cp:{r.id}"] = _pct(r.value)
            labels[f"cp:{r.id}"] = f"Coupon {r.code} {_pct(r.value):g}% ({DURATIONS[r.duration].lower()})"
        if annual > 0:
            parts["annual"] = annual
            labels["annual"] = f"Annual prepay {annual:g}%"
        total = sum(parts.values(), ZERO)
        scale = (cap / total) if total > cap and total > 0 else Decimal(1)
        if scale < 1 and f"cap" not in labels:
            notes.append(f"Percentage discounts capped at {cap:g}% (Maximum stackable discount)")
            labels["cap"] = ""
        for k, p in parts.items():
            amounts[k] = amounts.get(k, ZERO) + per_month * p * scale / HUNDRED
    lines = [{"key": k, "label": labels[k], "amount": money(v)} for k, v in amounts.items() if money(v) > 0]
    pct_total = sum((l["amount"] for l in lines), ZERO)
    remaining = amount - pct_total
    once = []
    for r in reds:
        if r.kind != "amount":
            continue
        cm = coupon_months[r.id]
        if not cm:
            continue
        value = money(r.value) if r.duration in ("once", "annual") else money(r.value) * len(cm)
        value = min(value, max(remaining, ZERO))
        if value > 0:
            lines.append({"key": f"cp:{r.id}", "label": f"Coupon {r.code} ₹{money(r.value):,.2f} off ({DURATIONS[r.duration].lower()})", "amount": money(value)})
            remaining -= value
        if r.duration == "once":
            once.append(r.id)
    once += [r.id for r in reds if r.kind == "percent" and r.duration == "once" and coupon_months[r.id]]
    return {"lines": lines, "total": money(sum((l["amount"] for l in lines), ZERO)), "notes": sorted(set(notes)), "once": once}


def effective_monthly(ctx: Context, tenant: Tenant, monthly: Decimal, cycle: str, has_yearly_price: bool, today: Optional[date] = None) -> Decimal:
    """This month's recurring price after recurring discounts (one-off coupons excluded) – used for MRR / ARR."""
    today = today or date.today()
    m = date(today.year, today.month, 1)
    end = date(m.year, m.month, calendar.monthrange(m.year, m.month)[1])
    disc = price(ctx, tenant, cycle, m, end, money(monthly), has_yearly_price, recurring_only=True)["total"]
    return money(monthly - disc)


def effective_mrr(db: Session, tenants: list[Tenant], prices: dict[int, dict]) -> dict[int, Decimal]:
    """Effective monthly price of each tenant after recurring discounts – one batch for many tenants (MRR / ARR)."""
    ctx = context(db, [t.id for t in tenants])
    cycles = controls.tenant_values(db, "invCycle", [t.id for t in tenants])
    out = {}
    for t in tenants:
        monthly = prices[t.id]["monthly"]
        cycle = cycles.get(t.id) or "Annual"
        has_yearly = cycle == "Annual" and prices[t.id]["yearly"] > 0
        out[t.id] = effective_monthly(ctx, t, monthly, cycle, has_yearly) if monthly > 0 else money(0)
    return out


# ─── Reseller tiers ──────────────────────────────────────────────────────────

def reseller_tiers(db: Session, arr_by_tenant: dict[int, Decimal]) -> list[dict]:
    """Tier rules with the existing resellers that qualify for each (ARR of the tenants they manage)."""
    from app.models.platform_reseller import PlatformReseller, PlatformResellerTenant
    ensure_schema()
    rules = db.query(PlatformResellerTierRule).order_by(PlatformResellerTierRule.min_arr).all()
    managed: dict[int, Decimal] = {}
    for rid, tid in db.query(PlatformResellerTenant.reseller_id, PlatformResellerTenant.tenant_id).all():
        managed[rid] = managed.get(rid, ZERO) + arr_by_tenant.get(tid, ZERO)
    resellers = db.query(PlatformReseller.id, PlatformReseller.name).all()
    qualified: dict[str, list] = {r.tier: [] for r in rules}
    for rid, name in resellers:
        arr = managed.get(rid, ZERO)
        tier = None
        for rule in rules:
            if arr >= _pct(rule.min_arr):
                tier = rule.tier
        if tier:
            qualified[tier].append({"id": rid, "name": name, "arr": arr})
    return [{"tier": r.tier, "min_arr": _pct(r.min_arr), "margin": _pct(r.margin_pct), "resellers": qualified.get(r.tier, [])} for r in rules]
