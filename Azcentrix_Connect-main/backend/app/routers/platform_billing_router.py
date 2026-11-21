"""Billing & metering: recurring revenue, plans, revenue by tenant, invoices and the invoicing run (platform_billing).

Under ``/billing`` (Plans & billing permission: view to read, manage to act). Staff with assigned tenant scope only see
their tenants' revenue and invoices; running invoicing bills every tenant, so it needs all-tenant scope.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.tenant import Feature, Plan, PlanFeature, Tenant
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_billing as billing
from app.services import platform_controls as controls
from app.services.platform_access import enforce_platform_access, require_tenant_in_scope, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/billing", dependencies=[Depends(enforce_platform_access)])


def _tenants(db: Session, request: Request) -> list[Tenant]:
    query = db.query(Tenant)
    allowed = scoped_tenant_ids(request)
    if allowed is not None:
        query = query.filter(Tenant.id.in_(allowed or [0]))
    return query.order_by(Tenant.name).all()


def _num(v) -> float:
    return float(v) if isinstance(v, Decimal) else v


def _invoice_row(inv: billing.PlatformInvoice, names: dict[int, str]) -> dict:
    return {"id": inv.id, "number": inv.number, "tenant_id": inv.tenant_id, "tenant": names.get(inv.tenant_id, "—"), "plan": inv.plan_name,
            "cycle": inv.cycle, "period_start": inv.period_start, "period_end": inv.period_end, "issued_on": inv.issued_on, "due_on": inv.due_on,
            "subtotal": _num(inv.subtotal), "tax_amount": _num(inv.tax_amount), "total": _num(inv.total), "status": inv.status,
            "overdue": inv.status == "Pending" and inv.due_on < date.today(), "paid_on": inv.paid_on, "payment_ref": inv.payment_ref,
            "balance": _num(max(Decimal(0), Decimal(inv.total) - Decimal(inv.amount_paid or 0) - Decimal(inv.amount_credited or 0)))}


def _config(db: Session) -> dict:
    return {"cycle": controls.value(db, "invCycle"), "prefix": controls.value(db, "invPrefix"), "due_days": controls.value(db, "invDue"),
            "tax": f"GST {billing.GST_RATE:g}%" if controls.value(db, "invTax") else "No tax", "over_limit": controls.value(db, "planOver"),
            "overage_prices": {"seat": controls.value(db, "ovSeat"), "storage_gb": controls.value(db, "ovStorage"), "ai_query": controls.value(db, "ovAI")}}


@router.get("")
def overview(request: Request, db: Session = Depends(get_master_db_dep)):
    billing.ensure_schema()
    tenants = _tenants(db, request)
    ids = [t.id for t in tenants]
    names = {t.id: t.name for t in tenants}
    rec = billing.recurring(db, tenants)
    modules = dict(db.query(PlanFeature.plan_id, func.count(func.distinct(Feature.module))).join(Feature, Feature.id == PlanFeature.feature_id)
                   .filter(PlanFeature.enabled == True).group_by(PlanFeature.plan_id).all())  # noqa: E712
    plans = []
    for p in db.query(Plan).order_by(Plan.price_monthly, Plan.name).all():
        on_plan = [t for t in tenants if t.plan_id == p.id]
        storage = sorted({round((t.storage_limit_mb or 0) / 1024, 2) for t in on_plan})
        plans.append({"id": p.id, "name": p.name, "slug": p.slug, "is_active": p.is_active, "price_monthly": p.price_monthly, "price_yearly": p.price_yearly,
                      "max_users": p.max_users, "storage_gb": storage, "modules": modules.get(p.id, 0), "tenants": len(on_plan)})
    invoices = (db.query(billing.PlatformInvoice).filter(billing.PlatformInvoice.tenant_id.in_(ids or [0]))
                .order_by(billing.PlatformInvoice.issued_on.desc(), billing.PlatformInvoice.id.desc()).limit(25).all())
    return {
        "kpis": {"mrr": _num(rec["mrr"]), "arr": _num(rec["arr"]), "outstanding": _num(billing.outstanding(db, ids)), "trials": rec["trials"],
                 "paying_tenants": len(rec["by_tenant"]), "pending_invoices": db.query(billing.PlatformInvoice).filter(
                     billing.PlatformInvoice.status == "Pending", billing.PlatformInvoice.tenant_id.in_(ids or [0])).count()},
        "plans": plans,
        "revenue_by_tenant": [{**r, "mrr": _num(r["mrr"])} for r in rec["by_tenant"]],
        "invoices": [_invoice_row(i, names) for i in invoices],
        "config": _config(db),
        "all_scope": scoped_tenant_ids(request) is None,
    }


def _serialise_plan(items: list[dict]) -> list[dict]:
    return [{**{k: v for k, v in i.items() if k != "lines"}, **({"lines": [{k: _num(v) for k, v in line.items()} for line in i["lines"]]} if "lines" in i else {}),
             **{k: _num(i[k]) for k in ("subtotal", "tax_rate", "tax_amount", "total") if k in i}} for i in items]


def _require_all_scope(request: Request) -> None:
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail="Invoicing bills every tenant – it needs all-tenant scope.")


@router.get("/run/preview")
def run_preview(request: Request, db: Session = Depends(get_master_db_dep)):
    _require_all_scope(request)
    return {"items": _serialise_plan(billing.plan_run(db, _tenants(db, request))), "config": _config(db), "date": date.today()}


@router.post("/run")
def run(request: Request, db: Session = Depends(get_master_db_dep)):
    _require_all_scope(request)
    admin = _get_platform_admin(request)
    actor = getattr(admin, "email", None) or "platform admin"
    created = billing.run_invoicing(db, _tenants(db, request), actor)
    ip = get_request_ip(request)
    for c in created:
        inv, item = c["invoice"], c["item"]
        _write_platform_audit(db, admin, "invoice_generated", "tenant", inv.tenant_id, item["tenant"],
                              f"Invoice {inv.number} for {item['period_start']:%d %b %Y}–{item['period_end']:%d %b %Y}: ₹{inv.total:,.2f}", ip,
                              new_data={"invoice": inv.number, "lines": [{k: str(v) for k, v in line.items() if k != 'meter'} for line in item["lines"]],
                                        "notes": item["notes"]})
    _write_platform_audit(db, admin, "invoicing_run", "billing", None, "Invoicing",
                          f"Invoicing run: {len(created)} invoice(s) created, ₹{sum((c['invoice'].total for c in created), Decimal(0)):,.2f} billed", ip)
    db.commit()
    return {"created": len(created), "invoices": [c["invoice"].number for c in created]}


@router.get("/invoices/{invoice_id}")
def invoice_detail(invoice_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    inv = db.get(billing.PlatformInvoice, invoice_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    require_tenant_in_scope(request, inv.tenant_id)
    tenant = db.get(Tenant, inv.tenant_id)
    lines = db.query(billing.PlatformInvoiceLine).filter(billing.PlatformInvoiceLine.invoice_id == inv.id).order_by(billing.PlatformInvoiceLine.id).all()
    return {**_invoice_row(inv, {inv.tenant_id: tenant.name if tenant else "—"}), "tax_rate": _num(inv.tax_rate), "created_by": inv.created_by,
            "billing_email": (tenant.billing_email or tenant.admin_email) if tenant else None,
            "lines": [{"kind": l.kind, "description": l.description, "quantity": _num(l.quantity), "unit_price": _num(l.unit_price), "amount": _num(l.amount),
                       "meter": l.meter, "note": l.note} for l in lines]}


class PaymentBody(BaseModel):
    paid_on: date
    reference: str = Field(..., min_length=2, max_length=120)
    evidence: str = Field(..., min_length=5, max_length=500)
    gateway: str = Field("bank", pattern="^(bank|manual)$")


@router.post("/invoices/{invoice_id}/payment")
def record_payment(invoice_id: int, body: PaymentBody, request: Request, db: Session = Depends(get_master_db_dep)):
    """Full payment of the balance; the same payment path as Invoices & dunning → Mark paid (platform_invoicing.record_payment)."""
    from app.services import platform_invoicing as invoicing
    from app.services import platform_payment_gateways as gateways
    invoicing.ensure_schema()
    inv = db.get(billing.PlatformInvoice, invoice_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    require_tenant_in_scope(request, inv.tenant_id)
    if not invoicing.setting(db, "gateways").get(body.gateway):
        raise HTTPException(status_code=409, detail=f"{gateways.NAMES[body.gateway]} is switched off in Invoices & dunning → Gateways")
    admin = _get_platform_admin(request)
    try:
        payment, inv, created = invoicing.record_payment(db, inv.id, invoicing.balance(inv), body.gateway, body.reference, body.paid_on, body.evidence, "manual",
                                                         getattr(admin, "email", None) or "platform admin")
    except invoicing.InvoicingError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc))
    if not created:
        raise HTTPException(status_code=409, detail=f"A payment with reference {body.reference} is already recorded")
    tenant = db.get(Tenant, inv.tenant_id)
    _write_platform_audit(db, admin, "invoice_payment_recorded", "tenant", inv.tenant_id, tenant.name if tenant else None,
                          f"Invoice {inv.number} marked paid on {body.paid_on:%d %b %Y} (ref {payment.reference})", get_request_ip(request),
                          new_data={"invoice": inv.number, "amount": str(payment.amount), "gateway": body.gateway, "reference": payment.reference, "evidence": payment.evidence})
    db.commit()
    return {"ok": True}
