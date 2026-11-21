"""Add-ons & usage pricing (Business): add-on catalogue and tenant subscriptions, per-plan usage quotas and overage
prices, trial settings and currency price books (platform_addons).

Under ``/addons`` (Plans & billing permission: view to read, manage to change). The catalogue, rates, trial settings
and price books apply to every tenant, so changing them needs all-tenant scope; a tenant's own add-ons need that
tenant in scope.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.tenant import Plan, Tenant
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_addons as ao
from app.services.platform_access import enforce_platform_access, require_tenant_in_scope, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/addons", dependencies=[Depends(enforce_platform_access)])
_SCHEMA = {"ready": False}


def _schema(db: Session) -> None:
    if not _SCHEMA["ready"]:
        db.rollback()  # a transaction opened before the tables existed can't read them (MariaDB 1412)
        ao.ensure_schema()
        _SCHEMA["ready"] = True


def _actor(request: Request) -> str:
    admin = _get_platform_admin(request)
    return getattr(admin, "email", None) or getattr(admin, "username", None) or "platform admin"


def _audit(db: Session, request: Request, action: str, text: str, tenant: Optional[Tenant] = None, old=None, new=None) -> None:
    _write_platform_audit(db, _get_platform_admin(request), action, "tenant" if tenant else "billing", tenant.id if tenant else None,
                          tenant.name if tenant else "Add-ons & usage pricing", text, get_request_ip(request), old_data=old, new_data=new)


def _all_scope(request: Request) -> None:
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail="This applies to every tenant – it needs all-tenant scope.")


def _fail(exc: ao.AddonError):
    raise HTTPException(status_code=exc.status, detail=str(exc))


@router.get("")
def overview(request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    allowed = scoped_tenant_ids(request)
    ids = sorted(allowed) if allowed is not None else None
    cat = ao.catalogue(db, ids)
    return {"kpis": ao.kpis(db, ids, cat), "addons": cat, "usage": ao.usage_tables(db), "trials": ao.trial_settings(db), "price_books": ao.price_books(db),
            "plans": [{"id": p.id, "name": p.name} for p in db.query(Plan).filter(Plan.is_active == True, Plan.price_monthly > 0).order_by(Plan.price_monthly).all()],  # noqa: E712
            "all_scope": allowed is None}


# ─── Catalogue ───────────────────────────────────────────────────────────────

@router.post("", status_code=201)
def create(request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    _all_scope(request)
    a = ao.create_addon(db, _actor(request))
    _audit(db, request, "addon_created", f"Add-on draft “{a.name}” created (₹{a.price:,.2f} per month, not offered until activated)")
    db.commit()
    return {"id": a.id, "name": a.name, "status": a.status}


class AddonBody(BaseModel):
    name: Optional[str] = Field(None, max_length=200)
    price: Optional[Decimal] = None


@router.patch("/{addon_id}")
def update(addon_id: int, body: AddonBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    _all_scope(request)
    try:
        a, old = ao.update_addon(db, addon_id, body.name, body.price, _actor(request))
    except ao.AddonError as exc:
        _fail(exc)
    new = {"name": a.name, "price": str(a.price)}
    changed = {k: v for k, v in new.items() if old[k] != v}
    if changed:
        _audit(db, request, "addon_updated", f"Add-on “{a.name}”: " + ", ".join(f"{k} {old[k]} → {v}" for k, v in changed.items()),
               old={k: old[k] for k in changed}, new=changed)
    db.commit()
    return {"id": a.id, "name": a.name, "price": float(a.price), "status": a.status}


class StatusBody(BaseModel):
    status: str


@router.post("/{addon_id}/status")
def status(addon_id: int, body: StatusBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    _all_scope(request)
    try:
        a, old = ao.set_status(db, addon_id, body.status)
    except ao.AddonError as exc:
        _fail(exc)
    if old != a.status:
        _audit(db, request, "addon_status_changed", f"Add-on “{a.name}”: {old} → {a.status}", old={"status": old}, new={"status": a.status})
    db.commit()
    return {"id": a.id, "status": a.status}


# ─── Tenant subscriptions ────────────────────────────────────────────────────

def _tenant(db: Session, request: Request, tenant_id: int) -> Tenant:
    require_tenant_in_scope(request, tenant_id)
    t = db.get(Tenant, tenant_id)
    if t is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return t


@router.get("/tenants/{tenant_id}")
def tenant_addons(tenant_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    _tenant(db, request, tenant_id)
    return ao.tenant_addons(db, tenant_id)


class SubscribeBody(BaseModel):
    active: bool
    quantity: int = Field(1, ge=1, le=1000)


@router.put("/tenants/{tenant_id}/{addon_id}")
def subscribe(tenant_id: int, addon_id: int, body: SubscribeBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    t = _tenant(db, request, tenant_id)
    try:
        s, a, changed = ao.subscribe(db, t, addon_id, body.active, body.quantity, _actor(request))
    except ao.AddonError as exc:
        _fail(exc)
    if changed:
        _audit(db, request, "tenant_addon_" + ("added" if body.active else "removed"),
               f"Add-on “{a.name}”{f' × {body.quantity}' if body.active and body.quantity > 1 else ''} {'added – billed from the next invoice' if body.active else 'removed'}",
               t, new={"addon": a.name, "active": body.active, "quantity": body.quantity, "price": str(a.price)})
    db.commit()
    return ao.tenant_addons(db, tenant_id)


# ─── Usage pricing ───────────────────────────────────────────────────────────

class RateBody(BaseModel):
    plan_id: int
    metric: str
    included: Optional[Decimal] = None
    price: Optional[Decimal] = None


@router.put("/usage-rates")
def set_rate(body: RateBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    _all_scope(request)
    if body.included is None and body.price is None:
        raise HTTPException(status_code=422, detail="Give a quota or an overage price")
    try:
        row, old = ao.set_rate(db, body.plan_id, body.metric, body.included, body.price, _actor(request))
    except ao.AddonError as exc:
        _fail(exc)
    plan = db.get(Plan, body.plan_id)
    new = {"included": str(row.included) if row.included is not None else None, "price": str(row.price) if row.price is not None else None}
    _audit(db, request, "usage_rate_updated", f"{dict((k, l) for k, l, _, _ in ao.METRICS)[body.metric]} on {plan.name}: quota {old['included']} → {new['included']}, "
           f"overage ₹{old['price']} → ₹{new['price']} per unit (from {row.effective_from:%d %b %Y})", old=old, new={**new, "effective_from": str(row.effective_from)})
    db.commit()
    return {**new, "effective_from": row.effective_from}


# ─── Trials ──────────────────────────────────────────────────────────────────

class TrialBody(BaseModel):
    values: dict


@router.put("/trials")
def update_trials(body: TrialBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    _all_scope(request)
    try:
        old, new = ao.update_trials(db, body.values, _actor(request))
    except ao.AddonError as exc:
        _fail(exc)
    changed = {k: new[k] for k in body.values if old.get(k) != new.get(k)}
    if changed:
        _audit(db, request, "trial_settings_updated", "Free trial: " + ", ".join(f"{k} {old.get(k)} → {v}" for k, v in changed.items()),
               old={k: old.get(k) for k in changed}, new=changed)
    db.commit()
    return new


class ExtendBody(BaseModel):
    days: int


@router.post("/trials/{tenant_id}/extend")
def extend_trial(tenant_id: int, body: ExtendBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    t = _tenant(db, request, tenant_id)
    try:
        ext = ao.extend_trial(db, t, body.days, _actor(request))
    except ao.AddonError as exc:
        _fail(exc)
    _audit(db, request, "trial_extended", f"Trial extended by {ext.days} days to {ext.new_end:%d %b %Y}", t,
           old={"trial_ends_at": str(ext.old_end)}, new={"trial_ends_at": str(ext.new_end)})
    db.commit()
    return {"trial_ends_at": ext.new_end}


# ─── Price books ─────────────────────────────────────────────────────────────

class FxBody(BaseModel):
    rate: Decimal
    effective_from: date


@router.put("/price-books/{currency}")
def set_fx(currency: str, body: FxBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    _all_scope(request)
    try:
        row, old = ao.set_fx(db, currency.upper(), body.rate, body.effective_from, _actor(request))
    except ao.AddonError as exc:
        _fail(exc)
    _audit(db, request, "fx_rate_updated", f"Price book {row.currency}: ₹{old or '—'} → ₹{row.rate} per unit from {row.effective_from:%d %b %Y}",
           old={"rate": old}, new={"rate": str(row.rate), "effective_from": str(row.effective_from)})
    db.commit()
    return ao.price_books(db)
