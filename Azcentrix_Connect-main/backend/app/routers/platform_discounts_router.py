"""Discounts & coupons (platform_discounts).

Under ``/api/v1/platform/discounts`` – Billing permission (view to read, manage to change). Coupons, tiers and pricing
rules are platform-wide (all-tenant scope); tenant-scoped staff see and request negotiated discounts for their tenants.
Every change and every approval decision is written to the platform audit trail.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.platform_discount import (PlatformCoupon, PlatformCouponRedemption, PlatformResellerTierRule, PlatformTenantDiscount,
                                          PlatformVolumeTier)
from app.models.tenant import Plan, Tenant
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_billing as billing
from app.services import platform_controls as controls
from app.services import platform_discounts as disc
from app.services.platform_access import enforce_platform_access, require_tenant_in_scope, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/discounts", dependencies=[Depends(enforce_platform_access)])
PAGE = 50
SETTINGS = ("dcAnnual", "dcMulti2", "dcMulti3", "couponMax", "dcStackVol", "dcNegReplace", "dcShowInv", "dcApproval",
            "refPct", "refCredit", "npoPct", "npoVerify")


def _schema(db: Session) -> None:
    if not disc._ready["schema"]:
        disc.ensure_schema()
        billing.ensure_schema()
        db.rollback()  # end the access check's snapshot so new tables are visible


def _fail(exc: disc.DiscountError):
    raise HTTPException(status_code=exc.status_code, detail=str(exc))


def _all_scope(request: Request) -> None:
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail="Coupons, tiers and pricing rules apply to every tenant – this needs all-tenant scope.")


def _actor(request: Request) -> str:
    a = _get_platform_admin(request)
    return (a.full_name or a.username) if a else "platform admin"


def _audit(db, request, action, entity_type, entity_id, name, description, old=None, new=None):
    _write_platform_audit(db, _get_platform_admin(request), action, entity_type, entity_id, name, description, get_request_ip(request),
                          old_data=old, new_data=new)


def _f(v) -> Optional[float]:
    return None if v is None else float(v)


def _utc(v: Optional[datetime]) -> Optional[str]:
    return f"{v.replace(microsecond=0).isoformat()}Z" if v else None


# ─── Overview ────────────────────────────────────────────────────────────────

def _coupon_dict(c: PlatformCoupon, plans: dict[int, str]) -> dict:
    return {"id": c.id, "code": c.code, "kind": c.kind, "value": _f(c.value), "duration": c.duration, "duration_label": disc.DURATIONS[c.duration],
            "plan_ids": c.plan_ids, "applies_to": "All plans" if c.plan_ids is None else ", ".join(plans.get(p, f"Plan {p}") for p in c.plan_ids),
            "limit": c.redemption_limit, "redeemed": c.redeemed_count, "valid_until": c.valid_until.isoformat(),
            "status": disc.coupon_status(c), "paused": c.status == "paused", "note": c.note}


def _discount_dict(d: PlatformTenantDiscount, names: dict[int, str]) -> dict:
    status = {"pending": "Pending approval", "active": "Active", "rejected": "Rejected", "ended": "Ended"}[d.status]
    if d.status == "active" and d.valid_until and d.valid_until < date.today():
        status = "Expired"
    return {"id": d.id, "tenant_id": d.tenant_id, "tenant": names.get(d.tenant_id, "—"), "pct": _f(d.pct), "term": f"{d.term_months} months",
            "valid_until": d.valid_until.isoformat() if d.valid_until else None, "reason": d.reason, "requested_by": d.requested_by,
            "requested_by_id": d.requested_by_id, "requested_at": _utc(d.requested_at), "status": status, "status_key": d.status,
            "decided_by": d.decided_by, "decided_at": _utc(d.decided_at), "history": d.history or []}


@router.get("")
def overview(request: Request, offset: int = Query(0, ge=0), limit: int = Query(PAGE, ge=1, le=200), q: str = Query("", max_length=60), db: Session = Depends(get_master_db_dep)):
    _schema(db)
    allowed = scoped_tenant_ids(request)
    tq = db.query(Tenant)
    if allowed is not None:
        tq = tq.filter(Tenant.id.in_(allowed or {0}))
    tenants = tq.all()
    names = {t.id: t.name for t in tenants}
    plans = {p.id: p.name for p in db.query(Plan.id, Plan.name).all()}
    today = date.today()

    coupons_q = db.query(PlatformCoupon).filter(PlatformCoupon.deleted_at.is_(None))
    list_q = coupons_q
    if q.strip():  # search the listing by code or note; KPIs still count every coupon
        term = q.strip().replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")
        like = f"%{term}%"
        list_q = list_q.filter(or_(PlatformCoupon.code.like(like), PlatformCoupon.note.like(like)))
    coupon_total = list_q.order_by(None).count()
    coupons = list_q.order_by(PlatformCoupon.created_at.desc(), PlatformCoupon.id.desc()).offset(offset).limit(limit).all()
    all_coupons = coupons_q.all() if q.strip() or coupon_total > limit else coupons
    active = sum(1 for c in all_coupons if disc.coupon_status(c, today) == "Active")

    # Redemptions – by code (kept after a coupon is deleted) and per month for the sparkline; grouped queries only.
    red_q = db.query(PlatformCouponRedemption)
    if allowed is not None:
        red_q = red_q.filter(PlatformCouponRedemption.tenant_id.in_(allowed or {0}))
    by_code = [(code, n) for _cid, code, n in red_q.with_entities(PlatformCouponRedemption.coupon_id, PlatformCouponRedemption.code, func.count(PlatformCouponRedemption.id))
               .group_by(PlatformCouponRedemption.coupon_id, PlatformCouponRedemption.code).all()]  # coupon_id leads the unique key
    since = date(today.year, today.month, 1)
    months = [disc._add_months(since, -k) for k in range(6, -1, -1)]
    per_month = dict(red_q.with_entities(func.date_format(PlatformCouponRedemption.redeemed_at, "%Y-%m"), func.count(PlatformCouponRedemption.id))
                     .filter(PlatformCouponRedemption.redeemed_at >= months[0]).group_by(func.date_format(PlatformCouponRedemption.redeemed_at, "%Y-%m")).all())

    # Discount money – the Billing & Metering MRR rule, list price vs effective price after recurring discounts.
    rec = billing.recurring(db, tenants)
    plan_of = {t.id: t.plan_id for t in tenants}
    by_plan: dict[str, Decimal] = {}
    pcts = []
    for r in rec["by_tenant"]:
        given = r["list_mrr"] - r["mrr"]
        if given > 0:
            by_plan[plans.get(plan_of.get(r["tenant_id"]), "No plan")] = by_plan.get(plans.get(plan_of.get(r["tenant_id"]), "No plan"), Decimal(0)) + given
            pcts.append(given / r["list_mrr"] * 100)

    nq = db.query(PlatformTenantDiscount)
    if allowed is not None:
        nq = nq.filter(PlatformTenantDiscount.tenant_id.in_(allowed or {0}))
    negotiated = nq.order_by(PlatformTenantDiscount.id.desc()).limit(200).all()
    pending = [d for d in negotiated if d.status == "pending"]
    paying = [t for t in tenants if billing.is_paying(t)]
    arr_by_tenant = {r["tenant_id"]: r["mrr"] * 12 for r in rec["by_tenant"]}
    tiers = db.query(PlatformVolumeTier).order_by(PlatformVolumeTier.from_seats).all()
    admin = _get_platform_admin(request)
    return {
        "kpis": {"active_coupons": active, "redemptions": sum(n for _, n in by_code), "redemptions_trend": [per_month.get(m.strftime("%Y-%m"), 0) for m in months],
                 "mrr_discount": _f(rec["discount_mrr"]), "avg_discount": round(float(sum(pcts) / len(pcts)), 1) if pcts else None,
                 "awaiting_approval": len(pending), "paying_tenants": len(paying)},
        "coupons": {"items": [_coupon_dict(c, plans) for c in coupons], "total": coupon_total, "offset": offset, "limit": limit},
        "redemptions_by_coupon": sorted([{"code": code, "count": n} for code, n in by_code], key=lambda x: -x["count"]),
        "discount_by_plan": [{"plan": k, "amount": _f(v)} for k, v in sorted(by_plan.items(), key=lambda kv: -kv[1])],
        "volume_tiers": [{"id": t.id, "from": t.from_seats, "to": t.to_seats, "pct": _f(t.pct)} for t in tiers],
        "settings": {k: controls.value(db, k, None) for k in SETTINGS + ("coupons", "couponStack", "volume")},
        "setting_notes": {k: controls.control(k).get("note") for k in SETTINGS},
        "negotiated": [_discount_dict(d, names) for d in negotiated],
        "approvals": [_discount_dict(d, names) for d in pending],
        "reseller_tiers": [{"tier": r["tier"], "min_arr": _f(r["min_arr"]), "margin": _f(r["margin"]), "resellers": [{"name": x["name"], "arr": _f(x["arr"])} for x in r["resellers"]]}
                           for r in disc.reseller_tiers(db, arr_by_tenant)],
        "plans": [{"id": p.id, "name": p.name} for p in db.query(Plan).filter(Plan.is_active == True).order_by(Plan.price_monthly, Plan.name).all()],  # noqa: E712
        "tenants": [{"id": t.id, "name": t.name} for t in sorted(tenants, key=lambda x: x.name) if t.status in ("active", "trial")],
        "me": admin.id if admin else None, "all_scope": allowed is None,
    }


# ─── Coupons ─────────────────────────────────────────────────────────────────

class CouponBody(BaseModel):
    code: str = Field(..., max_length=40)
    kind: str
    value: Decimal
    duration: str
    plan_ids: Optional[list[int]] = None
    limit: int = 0
    valid_until: date
    note: str = Field("", max_length=300)


@router.post("/coupons", status_code=201)
def create_coupon(body: CouponBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    _all_scope(request)
    try:
        c = disc.create_coupon(db, _actor(request), body.code, body.kind, body.value, body.duration, body.plan_ids, body.limit, body.valid_until, body.note)
    except disc.DiscountError as exc:
        db.rollback()
        _fail(exc)
    _audit(db, request, "coupon_created", "coupon", c.id, c.code,
           f"Coupon {c.code} created: {('%g%%' % c.value) if c.kind == 'percent' else '₹%s' % c.value} off, {disc.DURATIONS[c.duration]}, valid until {c.valid_until:%d %b %Y}",
           new={"kind": c.kind, "value": str(c.value), "duration": c.duration, "plan_ids": c.plan_ids, "limit": c.redemption_limit, "valid_until": c.valid_until.isoformat()})
    db.commit()
    return {"id": c.id, "code": c.code}


def _coupon(db: Session, coupon_id: int) -> PlatformCoupon:
    c = db.query(PlatformCoupon).filter(PlatformCoupon.id == coupon_id, PlatformCoupon.deleted_at.is_(None)).with_for_update().first()
    if c is None:
        raise HTTPException(status_code=404, detail="Coupon not found")
    return c


@router.post("/coupons/{coupon_id}/toggle")
def toggle_coupon(coupon_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    _all_scope(request)
    c = _coupon(db, coupon_id)
    c.status, c.updated_at = ("paused" if c.status == "active" else "active"), datetime.utcnow()
    _audit(db, request, "coupon_paused" if c.status == "paused" else "coupon_activated", "coupon", c.id, c.code,
           f"Coupon {c.code} {'paused – no new redemptions' if c.status == 'paused' else 'activated'}")
    db.commit()
    return {"status": disc.coupon_status(c)}


@router.post("/coupons/{coupon_id}/extend")
def extend_coupon(coupon_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    _all_scope(request)
    c = _coupon(db, coupon_id)
    old = c.valid_until
    c.valid_until, c.updated_at = max(c.valid_until, date.today()) + timedelta(days=30), datetime.utcnow()
    _audit(db, request, "coupon_extended", "coupon", c.id, c.code, f"Coupon {c.code} extended from {old:%d %b %Y} to {c.valid_until:%d %b %Y}",
           old={"valid_until": old.isoformat()}, new={"valid_until": c.valid_until.isoformat()})
    db.commit()
    return {"valid_until": c.valid_until.isoformat(), "status": disc.coupon_status(c)}


@router.delete("/coupons/{coupon_id}")
def delete_coupon(coupon_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    _all_scope(request)
    c = _coupon(db, coupon_id)
    c.deleted_at = datetime.utcnow()  # kept: redemptions reference it and keep their discount
    _audit(db, request, "coupon_deleted", "coupon", c.id, c.code,
           f"Coupon {c.code} deleted – {c.redeemed_count} existing redemption(s) keep their discount; the code can't be reused")
    db.commit()
    return {"deleted": c.id}


class RedeemBody(BaseModel):
    code: str = Field(..., max_length=40)
    tenant_id: int


@router.post("/coupons/redeem", status_code=201)
def redeem_coupon(body: RedeemBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    require_tenant_in_scope(request, body.tenant_id)
    tenant = db.get(Tenant, body.tenant_id)
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    try:
        r = disc.redeem(db, body.code, tenant, _actor(request))
    except disc.DiscountError as exc:
        db.rollback()
        _fail(exc)
    _audit(db, request, "coupon_redeemed", "tenant", tenant.id, tenant.name, f"Coupon {r.code} applied to {tenant.name} ({disc.DURATIONS[r.duration]})",
           new={"code": r.code, "kind": r.kind, "value": str(r.value), "duration": r.duration})
    db.commit()
    return {"id": r.id, "code": r.code}


# ─── Volume tiers & settings ─────────────────────────────────────────────────

class TierBody(BaseModel):
    pct: Decimal


@router.put("/volume-tiers/{tier_id}")
def update_tier(tier_id: int, body: TierBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    _all_scope(request)
    t = db.query(PlatformVolumeTier).filter(PlatformVolumeTier.id == tier_id).with_for_update().first()
    if t is None:
        raise HTTPException(status_code=404, detail="Tier not found")
    if body.pct < 0 or body.pct > 40:
        raise HTTPException(status_code=422, detail="A volume discount must be between 0 and 40%")
    old = t.pct
    t.pct, t.updated_by, t.updated_at = body.pct.quantize(Decimal("0.01")), _actor(request), datetime.utcnow()
    _audit(db, request, "volume_tier_updated", "volume_tier", t.id, f"{t.from_seats}–{t.to_seats or '∞'} seats",
           f"Volume discount for {t.from_seats}–{t.to_seats or '∞'} seats changed from {old:g}% to {t.pct:g}% (new invoices only)",
           old={"pct": str(old)}, new={"pct": str(t.pct)})
    db.commit()
    return {"id": t.id, "pct": float(t.pct)}


class SettingBody(BaseModel):
    key: str
    value: Any


@router.put("/settings")
def update_setting(body: SettingBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    _all_scope(request)
    if body.key not in SETTINGS:
        raise HTTPException(status_code=422, detail="Unknown setting")
    try:
        new = controls.coerce(db, body.key, body.value, None)
    except controls.ControlError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    old, new = controls.store(db, body.key, new, 0, _actor(request))
    _audit(db, request, "discount_setting_updated", "platform_control", None, body.key,
           f"Discounts & coupons: {controls.control(body.key)['label']} changed from {old} to {new}", old={body.key: old}, new={body.key: new})
    db.commit()
    return {"key": body.key, "value": new}


# ─── Negotiated discounts ────────────────────────────────────────────────────

class NegotiatedBody(BaseModel):
    tenant_id: int
    pct: Decimal
    term: int
    reason: str = Field(..., max_length=300)


@router.post("/tenant-discounts", status_code=201)
def create_negotiated(body: NegotiatedBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    require_tenant_in_scope(request, body.tenant_id)
    tenant = db.get(Tenant, body.tenant_id)
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    try:
        d = disc.request_discount(db, _get_platform_admin(request), tenant, body.pct, body.term, body.reason)
    except disc.DiscountError as exc:
        db.rollback()
        _fail(exc)
    _audit(db, request, "negotiated_discount_requested" if d.status == "pending" else "negotiated_discount_applied", "tenant_discount", d.id, tenant.name,
           f"{tenant.name}: negotiated discount {d.pct:g}% for {d.term_months} months – "
           + ("sent for second approval" if d.status == "pending" else f"active until {d.valid_until:%d %b %Y}") + f". Reason: {d.reason}",
           new={"pct": str(d.pct), "term_months": d.term_months, "status": d.status})
    db.commit()
    return {"id": d.id, "status": d.status}


class DecisionBody(BaseModel):
    note: Optional[str] = Field(None, max_length=300)


def _negotiated(db: Session, request: Request, discount_id: int) -> PlatformTenantDiscount:
    d = db.query(PlatformTenantDiscount).filter(PlatformTenantDiscount.id == discount_id).with_for_update().first()
    if d is None:
        raise HTTPException(status_code=404, detail="Discount not found")
    require_tenant_in_scope(request, d.tenant_id)
    return d


def _decide(discount_id: int, approve: bool, body: Optional[DecisionBody], request: Request, db: Session):
    _schema(db)
    d = _negotiated(db, request, discount_id)
    try:
        disc.decide(db, _get_platform_admin(request), d, approve, body.note if body else None)
    except disc.DiscountError as exc:
        db.rollback()
        _fail(exc)
    name = db.query(Tenant.name).filter(Tenant.id == d.tenant_id).scalar()
    _audit(db, request, "negotiated_discount_approved" if approve else "negotiated_discount_rejected", "tenant_discount", d.id, name,
           f"{name}: negotiated discount {d.pct:g}% {'approved – active until ' + format(d.valid_until, '%d %b %Y') if approve else 'rejected'} "
           f"(requested by {d.requested_by})", new={"status": d.status, "decided_by": d.decided_by, "note": d.decision_note})
    db.commit()
    return {"id": d.id, "status": d.status}


@router.post("/tenant-discounts/{discount_id}/approve")
def approve_negotiated(discount_id: int, request: Request, body: Optional[DecisionBody] = None, db: Session = Depends(get_master_db_dep)):
    return _decide(discount_id, True, body, request, db)


@router.post("/tenant-discounts/{discount_id}/reject")
def reject_negotiated(discount_id: int, request: Request, body: Optional[DecisionBody] = None, db: Session = Depends(get_master_db_dep)):
    return _decide(discount_id, False, body, request, db)


@router.post("/tenant-discounts/{discount_id}/end")
def end_negotiated(discount_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    d = _negotiated(db, request, discount_id)
    try:
        disc.end(db, _get_platform_admin(request), d)
    except disc.DiscountError as exc:
        _fail(exc)
    name = db.query(Tenant.name).filter(Tenant.id == d.tenant_id).scalar()
    _audit(db, request, "negotiated_discount_ended", "tenant_discount", d.id, name, f"{name}: negotiated discount {d.pct:g}% ended (new invoices only)")
    db.commit()
    return {"id": d.id, "status": d.status}


# ─── Reseller tiers ──────────────────────────────────────────────────────────

class ResellerTierBody(BaseModel):
    margin: Optional[Decimal] = None
    min_arr: Optional[Decimal] = None


@router.put("/reseller-tiers/{tier}")
def update_reseller_tier(tier: str, body: ResellerTierBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    _all_scope(request)
    r = db.query(PlatformResellerTierRule).filter(PlatformResellerTierRule.tier == tier).with_for_update().first()
    if r is None:
        raise HTTPException(status_code=404, detail="Tier not found")
    old = {"margin": str(r.margin_pct), "min_arr": str(r.min_arr)}
    if body.margin is not None:
        if body.margin < 0 or body.margin > 60:
            raise HTTPException(status_code=422, detail="A partner margin must be between 0 and 60%")
        r.margin_pct = body.margin.quantize(Decimal("0.01"))
    if body.min_arr is not None:
        if body.min_arr < 0:
            raise HTTPException(status_code=422, detail="The ARR threshold can't be negative")
        others = {x.tier: x.min_arr for x in db.query(PlatformResellerTierRule).filter(PlatformResellerTierRule.tier != tier).all()}
        order = ["Silver", "Gold", "Platinum"]
        i = order.index(tier) if tier in order else -1
        if i > 0 and order[i - 1] in others and body.min_arr <= others[order[i - 1]]:
            raise HTTPException(status_code=422, detail=f"{tier} must be reached at a higher ARR than {order[i - 1]}")
        if 0 <= i < len(order) - 1 and order[i + 1] in others and body.min_arr >= others[order[i + 1]]:
            raise HTTPException(status_code=422, detail=f"{tier} must be reached at a lower ARR than {order[i + 1]}")
        r.min_arr = body.min_arr.quantize(Decimal("0.01"))
    r.updated_by, r.updated_at = _actor(request), datetime.utcnow()
    _audit(db, request, "reseller_tier_updated", "reseller_tier", r.id, r.tier, f"Reseller tier {r.tier}: margin {r.margin_pct:g}%, reached at ₹{r.min_arr:,.0f} ARR",
           old=old, new={"margin": str(r.margin_pct), "min_arr": str(r.min_arr)})
    db.commit()
    return {"tier": r.tier, "margin": float(r.margin_pct), "min_arr": float(r.min_arr)}


# ─── One tenant (tenant page: Contract & discounts) ──────────────────────────

@router.get("/tenants/{tenant_id}")
def tenant_discounts(tenant_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    require_tenant_in_scope(request, tenant_id)
    t = db.get(Tenant, tenant_id)
    if t is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    prices = billing.tenant_prices(db, [t])[t.id]
    ctx = disc.context(db, [t.id])
    cycle = controls.value(db, "invCycle", t.id) or "Annual"
    effective = disc.effective_monthly(ctx, t, prices["monthly"], cycle, cycle == "Annual" and prices["yearly"] > 0) if prices["monthly"] > 0 else Decimal(0)
    tier = disc.tier_for(ctx.tiers, t.max_users)
    reds = db.query(PlatformCouponRedemption).filter(PlatformCouponRedemption.tenant_id == t.id).order_by(PlatformCouponRedemption.id.desc()).all()
    negs = db.query(PlatformTenantDiscount).filter(PlatformTenantDiscount.tenant_id == t.id).order_by(PlatformTenantDiscount.id.desc()).limit(20).all()
    coupons = db.query(PlatformCoupon).filter(PlatformCoupon.deleted_at.is_(None)).order_by(PlatformCoupon.code).all()
    eligible = [c.code for c in coupons if disc.coupon_status(c) == "Active" and (c.plan_ids is None or t.plan_id in c.plan_ids)]
    return {
        "plan": prices["plan"].name if prices["plan"] else None, "cycle": cycle, "seats": t.max_users,
        "list_mrr": float(prices["monthly"]), "effective_mrr": float(effective), "paying": billing.is_paying(t),
        "volume_tier": {"from": tier.from_seats, "to": tier.to_seats, "pct": float(tier.pct)} if tier and ctx.rules.get("volume") else None,
        "negotiated": [_discount_dict(d, {t.id: t.name}) for d in negs],
        "redemptions": [{"code": r.code, "kind": r.kind, "value": float(r.value), "duration": disc.DURATIONS[r.duration], "status": r.status,
                         "redeemed_at": _utc(r.redeemed_at), "redeemed_by": r.redeemed_by} for r in reds],
        "eligible_coupons": eligible,
    }
