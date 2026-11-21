"""Resellers & partners (Command): reseller accounts, the tenants sold through them, and commission earned.

* A tenant belongs to at most one reseller (unique tenant_id); assigning records the relationship only – the tenant's
  owner, database, users and permissions are not touched.
* Commission payable = for every reseller, its commission % of the pre-tax subtotal of its tenants' invoices that were
  paid on or after the day the tenant was assigned (Billing & Metering invoices). There are no commission payouts yet,
  so payable = earned. The current commission % is applied (no rate history is kept).
* The white-label domain follows the prototype's convention (``crm.<first 10 letters of the name>.com``); it is a
  proposed host name only – no DNS record or certificate is created.
"""

from __future__ import annotations

import re
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import master_engine
from app.models.platform_reseller import PlatformReseller, PlatformResellerTenant
from app.models.tenant import Tenant
from app.services.platform_billing import PlatformInvoice

TIERS = ("Bronze", "Silver", "Gold", "Platinum")
DEFAULT_COMMISSION = Decimal("20")
_ready: dict[str, bool] = {}


def ensure_schema() -> None:
    if not _ready.get("schema"):
        for model in (PlatformReseller, PlatformResellerTenant):
            model.__table__.create(bind=master_engine, checkfirst=True)
        _ready["schema"] = True


class ResellerError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def parse_commission(value) -> Decimal:
    try:
        pct = Decimal(str(value)).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        raise ResellerError("Commission must be a number", 422)
    if not Decimal("0") <= pct <= Decimal("100"):
        raise ResellerError("Commission must be between 0 and 100 %", 422)
    return pct


def _domain(db: Session, name: str) -> str:
    base = re.sub(r"[^a-z]", "", name.lower())[:10] or "partner"
    taken = {d for (d,) in db.query(PlatformReseller.domain).filter(PlatformReseller.domain.like(f"crm.{base}%.com")).all()}
    candidate, n = f"crm.{base}.com", 2
    while candidate in taken:
        candidate, n = f"crm.{base}{n}.com", n + 1
    return candidate


def create(db: Session, name: str, region: str, commission, actor: str) -> PlatformReseller:
    ensure_schema()
    name, region = (name or "").strip(), (region or "").strip()
    if not name:
        raise ResellerError("Enter the company name", 422)
    if len(name) > 200 or len(region) > 120:
        raise ResellerError("Company or region is too long", 422)
    pct = parse_commission(DEFAULT_COMMISSION if commission in (None, "") else commission)
    if db.query(PlatformReseller.id).filter(func.lower(PlatformReseller.name) == name.lower()).first():
        raise ResellerError(f"A reseller named “{name}” already exists", 409)
    row = PlatformReseller(name=name, region=region or None, tier="Bronze", commission_pct=pct, domain=_domain(db, name),
                           created_by=actor, created_at=datetime.utcnow())
    db.add(row)
    db.flush()
    return row


def set_commission(db: Session, reseller: PlatformReseller, value) -> tuple[Decimal, Decimal]:
    old, new = Decimal(reseller.commission_pct), parse_commission(value)
    reseller.commission_pct, reseller.updated_at = new, datetime.utcnow()
    return old, new


def assign(db: Session, reseller: PlatformReseller, tenant: Tenant, actor: str) -> PlatformResellerTenant:
    """Link a tenant to a reseller. Refused when the tenant already belongs to this or another reseller."""
    ensure_schema()
    existing = db.query(PlatformResellerTenant, PlatformReseller.name).join(PlatformReseller, PlatformReseller.id == PlatformResellerTenant.reseller_id) \
        .filter(PlatformResellerTenant.tenant_id == tenant.id).first()
    if existing:
        link, owner = existing
        if link.reseller_id == reseller.id:
            raise ResellerError(f"{tenant.name} is already assigned to {reseller.name}", 409)
        raise ResellerError(f"{tenant.name} is already assigned to {owner} – a tenant can belong to one reseller", 409)
    row = PlatformResellerTenant(reseller_id=reseller.id, tenant_id=tenant.id, assigned_by=actor, assigned_at=datetime.utcnow())
    db.add(row)
    db.flush()
    return row


def _earned(db: Session) -> dict[int, Decimal]:
    """Commission earned per reseller from paid invoices since assignment – one grouped query."""
    rows = db.query(PlatformReseller.id, PlatformReseller.commission_pct, func.coalesce(func.sum(PlatformInvoice.subtotal), 0)) \
        .join(PlatformResellerTenant, PlatformResellerTenant.reseller_id == PlatformReseller.id) \
        .join(PlatformInvoice, (PlatformInvoice.tenant_id == PlatformResellerTenant.tenant_id) & (PlatformInvoice.status == "Paid")
              & (PlatformInvoice.paid_on >= func.date(PlatformResellerTenant.assigned_at))) \
        .group_by(PlatformReseller.id, PlatformReseller.commission_pct).all()
    return {rid: (Decimal(base) * Decimal(pct) / 100).quantize(Decimal("0.01")) for rid, pct, base in rows}


def overview(db: Session) -> dict:
    """Reseller rows with tenant counts (one grouped join), the KPIs, and tenants for the assign dialog."""
    ensure_schema()
    rows = db.query(PlatformReseller, func.count(PlatformResellerTenant.id)) \
        .outerjoin(PlatformResellerTenant, PlatformResellerTenant.reseller_id == PlatformReseller.id) \
        .group_by(PlatformReseller.id).order_by(PlatformReseller.name).all()
    earned = _earned(db)
    items = [{"id": r.id, "name": r.name, "region": r.region, "tier": r.tier, "commission": float(r.commission_pct), "tenants": int(n),
              "domain": r.domain, "earned": float(earned.get(r.id, 0)), "created_at": r.created_at} for r, n in rows]
    assigned = {tid: name for tid, name in db.query(PlatformResellerTenant.tenant_id, PlatformReseller.name)
                .join(PlatformReseller, PlatformReseller.id == PlatformResellerTenant.reseller_id).all()}
    tenants = db.query(Tenant.id, Tenant.name).filter(Tenant.status != "cancelled").order_by(Tenant.name).all()
    pcts = [i["commission"] for i in items]
    return {
        "kpis": {"resellers": len(items), "tenants_via_resellers": sum(i["tenants"] for i in items),
                 "commission_payable": float(sum(earned.values(), Decimal(0))), "avg_commission": round(sum(pcts) / len(pcts), 1) if pcts else None},
        "resellers": items,
        "tenants": [{"id": t.id, "name": t.name, "reseller": assigned.get(t.id)} for t in tenants],
        "tiers": list(TIERS),
    }
