"""Invoices & dunning (Business): invoices, payments, credit notes, reminders, dunning, GST / e-invoicing and gateways.

Under ``/invoicing`` (Plans & billing permission: view to read, manage to act). Staff with assigned tenant scope see and
act on their tenants' invoices only; settings, gateways and payment plans need all-tenant scope. The billing run itself
is ``POST /billing/run`` (platform_billing_router), the same job Billing & metering uses. Gateway webhooks arrive at
``/api/v1/payment-webhooks/{gateway}`` (``webhook_router`` – signature-checked, no platform session).
"""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.platform_invoicing import (PlatformCreditNote, PlatformDunningEvent, PlatformInvoiceReminder, PlatformPayment, PlatformPaymentPlan)
from app.models.tenant import Tenant
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_invoicing as inv
from app.services import platform_payment_gateways as gw
from app.services.platform_access import enforce_platform_access, require_tenant_in_scope, scoped_tenant_ids
from app.services.platform_billing import PlatformInvoice, PlatformInvoiceLine, money

router = APIRouter(prefix="/api/v1/platform/invoicing", dependencies=[Depends(enforce_platform_access)])
webhook_router = APIRouter(prefix="/api/v1/payment-webhooks")
PAGE = 25
_SCHEMA = {"ready": False}


def _schema(db: Session) -> None:
    if not _SCHEMA["ready"]:
        db.rollback()  # a transaction opened before the tables existed can't read them (MariaDB 1412)
        inv.ensure_schema()
        _SCHEMA["ready"] = True


def _actor(request: Request) -> str:
    admin = _get_platform_admin(request)
    return getattr(admin, "email", None) or getattr(admin, "username", None) or "platform admin"


def _audit(db: Session, request: Request, action: str, tenant_id: Optional[int], tenant_name: Optional[str], text: str, old=None, new=None) -> None:
    _write_platform_audit(db, _get_platform_admin(request), action, "tenant" if tenant_id else "billing", tenant_id, tenant_name or "Invoices & dunning",
                          text, get_request_ip(request), old_data=old, new_data=new)


def _fail(exc: inv.InvoicingError):
    raise HTTPException(status_code=exc.status, detail=str(exc))


def _all_scope(request: Request) -> None:
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail="This setting applies to every tenant – it needs all-tenant scope.")


def _period(i: PlatformInvoice) -> str:
    if i.period_start.year == i.period_end.year and i.period_start.month == i.period_end.month:
        return f"{i.period_start:%b %Y}"
    return f"{i.period_start:%b %y}–{i.period_end:%b %y}"


def _row(i: PlatformInvoice, tenant: str, today: date) -> dict:
    return {"id": i.id, "number": i.number, "tenant_id": i.tenant_id, "tenant": tenant, "period": _period(i), "period_start": i.period_start,
            "period_end": i.period_end, "issued_on": i.issued_on, "total": float(i.total), "tax": float(i.tax_amount), "due_on": i.due_on,
            "gateway": inv.GATEWAY_LABELS.get(i.gateway or "", None), "status": inv.display_status(i, today), "balance": float(inv.balance(i)),
            "paid": float(money(i.amount_paid)), "credited": float(money(i.amount_credited)), "creditable": float(inv.creditable(i)),
            "failure": i.last_failure_reason}


# ─── Overview ────────────────────────────────────────────────────────────────

@router.get("")
def overview(request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    allowed = scoped_tenant_ids(request)
    conf = inv.settings_map(db)
    days = inv.step_days(conf["dunning_policy"])
    from app.services import platform_controls as controls
    plans_q = db.query(PlatformPaymentPlan, Tenant.name).join(Tenant, Tenant.id == PlatformPaymentPlan.tenant_id).filter(PlatformPaymentPlan.status == "approved")
    if allowed is not None:
        plans_q = plans_q.filter(PlatformPaymentPlan.tenant_id.in_(allowed or [0]))
    return {
        "kpis": inv.kpis(db, allowed),
        "dunning": {"steps": [{"key": k, "day": days[k], "text": t, "on": bool(conf["dunning_steps"].get(k))} for k, _, t in inv.STEPS],
                    "policy": conf["dunning_policy"], "notes": {"retry": inv.NO_AUTHORIZATION,
                                                               "readonly": "Read-only mode isn't available in the tenant application – this step is recorded only",
                                                               "suspend": "Files a Suspend tenant request in the approval queue; a person decides. Data is never deleted."}},
        "gst": {**conf["gst"], "rates": list(inv.GST_RATES), "supply_options": inv.SUPPLY, "tax_on": bool(controls.value(db, "invTax")),
                "problem": inv.tax_problem(db, bool(controls.value(db, "invTax")))},
        "einvoice": {**conf["einvoice"], **inv.einvoice_status()},
        "gateways": gw.cards(db),
        "credit_notes_enabled": bool(controls.value(db, "invCredit")),
        "payment_plans": [{"id": p.id, "tenant_id": p.tenant_id, "tenant": name, "until": p.until, "note": p.note, "approved_by": p.approved_by} for p, name in plans_q.all()],
        "all_scope": allowed is None,
    }


# ─── Invoices ────────────────────────────────────────────────────────────────

def _columns(today: date) -> dict[str, Any]:
    return {"number": PlatformInvoice.number, "tenant": Tenant.name, "period": func.date_format(PlatformInvoice.period_start, "%b %Y"),
            "total": PlatformInvoice.total, "tax": PlatformInvoice.tax_amount, "due": PlatformInvoice.due_on, "gateway": PlatformInvoice.gateway,
            "status": inv.status_expr(today)}


def _cond(col, op: str, value: str, numeric: bool, is_date: bool):
    v = (value or "").strip()
    if op == "empty":
        return or_(col.is_(None), col == "") if not (numeric or is_date) else col.is_(None)
    if op == "nempty":
        return col.isnot(None)
    if numeric or is_date:
        try:
            val: Any = Decimal(v) if numeric else date.fromisoformat(v)
        except (InvalidOperation, ValueError):
            return None
        return {"eq": col == val, "ne": col != val, "gt": col > val, "lt": col < val, "gte": col >= val, "lte": col <= val,
                "before": col < val, "after": col > val}.get(op)
    like = v.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")
    return {"contains": col.like(f"%{like}%"), "ncontains": ~col.like(f"%{like}%"), "eq": col == v, "ne": col != v, "starts": col.like(f"{like}%")}.get(op)


@router.get("/invoices")
def list_invoices(request: Request, offset: int = Query(0, ge=0), limit: int = Query(PAGE, ge=1, le=200), q: str = Query("", max_length=100),
                  quick: str = Query("{}", max_length=2000), conds: str = Query("[]", max_length=4000), logic: str = Query("AND", pattern="^(AND|OR)$"),
                  sort: str = Query("[]", max_length=500), db: Session = Depends(get_master_db_dep)):
    _schema(db)
    today = date.today()
    cols = _columns(today)
    numeric, dates = {"total", "tax"}, {"due"}
    query = db.query(PlatformInvoice, Tenant.name).join(Tenant, Tenant.id == PlatformInvoice.tenant_id)
    allowed = scoped_tenant_ids(request)
    if allowed is not None:
        query = query.filter(PlatformInvoice.tenant_id.in_(allowed or [0]))
    if q.strip():
        like = "%" + q.strip().replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_") + "%"
        query = query.filter(or_(PlatformInvoice.number.like(like), Tenant.name.like(like)))
    try:
        quick_f, cond_l, sorts = json.loads(quick or "{}"), json.loads(conds or "[]"), json.loads(sort or "[]")
    except ValueError:
        raise HTTPException(status_code=422, detail="Malformed filter")
    for k, v in (quick_f.items() if isinstance(quick_f, dict) else []):
        if k in cols and str(v).strip():
            query = query.filter(_cond(cols[k], "contains", str(v), False, False))
    parts = [c for c in (_cond(cols[x["k"]], x.get("op", "contains"), str(x.get("v", "")), x["k"] in numeric, x["k"] in dates)
                         for x in (cond_l if isinstance(cond_l, list) else []) if isinstance(x, dict) and x.get("k") in cols) if c is not None]
    if parts:
        query = query.filter(or_(*parts) if logic == "OR" else and_(*parts))
    total = query.order_by(None).count()
    order = []
    for item in sorts if isinstance(sorts, list) else []:
        if isinstance(item, list) and len(item) == 2 and item[0] in cols:
            order.append(cols[item[0]].desc() if item[1] == -1 else cols[item[0]].asc())
    rows = query.order_by(*order, PlatformInvoice.issued_on.desc(), PlatformInvoice.id.desc()).offset(offset).limit(limit).all()
    return {"items": [_row(i, name, today) for i, name in rows], "total": total, "offset": offset, "limit": limit}


@router.get("/invoices/{invoice_id}")
def invoice_detail(invoice_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    i = db.get(PlatformInvoice, invoice_id)
    if i is None:
        raise HTTPException(status_code=404, detail="Invoice not found")
    require_tenant_in_scope(request, i.tenant_id)
    tenant = db.get(Tenant, i.tenant_id)
    lines = db.query(PlatformInvoiceLine).filter(PlatformInvoiceLine.invoice_id == i.id).order_by(PlatformInvoiceLine.id).all()
    pays = db.query(PlatformPayment).filter(PlatformPayment.invoice_id == i.id).order_by(PlatformPayment.id).all()
    notes = db.query(PlatformCreditNote).filter(PlatformCreditNote.invoice_id == i.id).order_by(PlatformCreditNote.id).all()
    rems = db.query(PlatformInvoiceReminder).filter(PlatformInvoiceReminder.invoice_id == i.id).order_by(PlatformInvoiceReminder.id.desc()).limit(20).all()
    steps = db.query(PlatformDunningEvent).filter(PlatformDunningEvent.invoice_id == i.id).order_by(PlatformDunningEvent.day).all()
    return {**_row(i, tenant.name if tenant else "—", date.today()), "subtotal": float(i.subtotal), "tax_rate": float(i.tax_rate), "tax_detail": i.tax_detail,
            "billing_email": (tenant.billing_email or tenant.admin_email) if tenant else None, "payment_link": i.payment_link,
            "lines": [{"kind": x.kind, "description": x.description, "quantity": float(x.quantity), "unit_price": float(x.unit_price), "amount": float(x.amount), "note": x.note} for x in lines],
            "payments": [{"gateway": inv.GATEWAY_LABELS.get(p.gateway, p.gateway), "reference": p.reference, "amount": float(p.amount), "paid_on": p.paid_on,
                          "evidence": p.evidence, "source": p.source, "recorded_by": p.recorded_by} for p in pays],
            "credit_notes": [{"number": n.number, "amount": float(n.amount), "reason": n.reason, "issued_at": n.issued_at, "issued_by": n.issued_by} for n in notes],
            "reminders": [{"kind": r.kind, "recipient": r.recipient, "status": r.status, "detail": r.detail, "at": r.created_at} for r in rems],
            "dunning": [{"step": s.step, "day": s.day, "status": s.status, "actions": s.actions, "at": s.created_at} for s in steps]}


@router.post("/invoices/{invoice_id}/remind")
def remind(invoice_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    i = db.get(PlatformInvoice, invoice_id)
    if i is None:
        raise HTTPException(status_code=404, detail="Invoice not found")
    require_tenant_in_scope(request, i.tenant_id)
    try:
        rem = inv.manual_reminder(db, invoice_id, _actor(request))
    except inv.InvoicingError as exc:
        _fail(exc)
    tenant = db.get(Tenant, i.tenant_id)
    _audit(db, request, "invoice_reminder_" + rem.status, i.tenant_id, tenant.name if tenant else None, f"Payment reminder for {i.number}: {rem.detail}",
           new={"invoice": i.number, "recipient": rem.recipient, "status": rem.status})
    db.commit()
    if rem.status != "sent":
        raise HTTPException(status_code=409, detail=f"Reminder not sent – {rem.detail}")
    return {"status": rem.status, "recipient": rem.recipient, "detail": rem.detail}


class PaymentBody(BaseModel):
    amount: Decimal = Field(..., gt=0, max_digits=14, decimal_places=2)
    gateway: str = Field(..., pattern="^(bank|manual|razorpay|stripe)$")
    reference: str = Field(..., min_length=3, max_length=120)
    paid_on: date
    evidence: str = Field(..., min_length=5, max_length=500)
    confirm: bool


@router.post("/invoices/{invoice_id}/payments")
def mark_paid(invoice_id: int, body: PaymentBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    i = db.get(PlatformInvoice, invoice_id)
    if i is None:
        raise HTTPException(status_code=404, detail="Invoice not found")
    require_tenant_in_scope(request, i.tenant_id)
    if not body.confirm:
        raise HTTPException(status_code=422, detail="Confirm that the money has been received")
    if not inv.setting(db, "gateways").get(body.gateway) or not gw.configured(body.gateway):
        raise HTTPException(status_code=409, detail=f"{gw.NAMES[body.gateway]} is not switched on")
    try:
        payment, i, created = inv.record_payment(db, invoice_id, body.amount, body.gateway, body.reference, body.paid_on, body.evidence, "manual", _actor(request))
    except inv.InvoicingError as exc:
        _fail(exc)
    if not created:
        raise HTTPException(status_code=409, detail=f"A {gw.NAMES[body.gateway]} payment with reference {body.reference} is already recorded (invoice #{payment.invoice_id})")
    tenant = db.get(Tenant, i.tenant_id)
    _audit(db, request, "invoice_payment_recorded", i.tenant_id, tenant.name if tenant else None,
           f"₹{payment.amount:,.2f} received for {i.number} by {gw.NAMES[body.gateway]} (ref {payment.reference}) – {inv.display_status(i)}",
           new={"invoice": i.number, "amount": str(payment.amount), "gateway": body.gateway, "reference": payment.reference, "paid_on": str(body.paid_on),
                "evidence": payment.evidence, "balance": str(inv.balance(i))})
    db.commit()
    return {"status": inv.display_status(i), "balance": float(inv.balance(i))}


# ─── Credit notes ────────────────────────────────────────────────────────────

@router.get("/credit-notes")
def credit_notes(request: Request, offset: int = Query(0, ge=0), limit: int = Query(PAGE, ge=1, le=200), db: Session = Depends(get_master_db_dep)):
    _schema(db)
    query = (db.query(PlatformCreditNote, Tenant.name, PlatformInvoice.number).join(Tenant, Tenant.id == PlatformCreditNote.tenant_id)
             .join(PlatformInvoice, PlatformInvoice.id == PlatformCreditNote.invoice_id))
    allowed = scoped_tenant_ids(request)
    if allowed is not None:
        query = query.filter(PlatformCreditNote.tenant_id.in_(allowed or [0]))
    total = query.order_by(None).count()
    rows = query.order_by(PlatformCreditNote.issued_at.desc(), PlatformCreditNote.id.desc()).offset(offset).limit(limit).all()
    return {"items": [{"id": n.id, "number": n.number, "tenant_id": n.tenant_id, "tenant": name, "invoice": number, "amount": float(n.amount),
                       "tax": float(n.tax_amount), "reason": n.reason, "status": n.status, "issued_at": n.issued_at, "issued_by": n.issued_by}
                      for n, name, number in rows], "total": total, "offset": offset, "limit": limit}


@router.get("/credit-notes/invoices")
def creditable_invoices(request: Request, q: str = Query("", max_length=60), db: Session = Depends(get_master_db_dep)):
    """Invoices that can still be credited, for the Issue credit note picker."""
    _schema(db)
    query = (db.query(PlatformInvoice, Tenant.name).join(Tenant, Tenant.id == PlatformInvoice.tenant_id)
             .filter(PlatformInvoice.total - PlatformInvoice.amount_credited > 0))
    allowed = scoped_tenant_ids(request)
    if allowed is not None:
        query = query.filter(PlatformInvoice.tenant_id.in_(allowed or [0]))
    if q.strip():
        like = "%" + q.strip().replace("%", r"\%").replace("_", r"\_") + "%"
        query = query.filter(or_(PlatformInvoice.number.like(like), Tenant.name.like(like)))
    rows = query.order_by(PlatformInvoice.issued_on.desc(), PlatformInvoice.id.desc()).limit(30).all()
    today = date.today()
    return [{"id": i.id, "number": i.number, "tenant": name, "total": float(i.total), "creditable": float(inv.creditable(i)), "status": inv.display_status(i, today)}
            for i, name in rows]


class CreditBody(BaseModel):
    invoice_id: int
    amount: Decimal = Field(..., gt=0, max_digits=14, decimal_places=2)
    reason: str = Field(..., min_length=5, max_length=300)


@router.post("/credit-notes", status_code=201)
def issue_credit(body: CreditBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    i = db.get(PlatformInvoice, body.invoice_id)
    if i is None:
        raise HTTPException(status_code=404, detail="Invoice not found")
    require_tenant_in_scope(request, i.tenant_id)
    try:
        note, i, refund = inv.issue_credit_note(db, body.invoice_id, body.amount, body.reason, _actor(request))
    except inv.InvoicingError as exc:
        _fail(exc)
    tenant = db.get(Tenant, i.tenant_id)
    _audit(db, request, "credit_note_issued", i.tenant_id, tenant.name if tenant else None,
           f"Credit note {note.number} for ₹{note.amount:,.2f} against {i.number}: {note.reason}",
           new={"credit_note": note.number, "invoice": i.number, "amount": str(note.amount), "tax": str(note.tax_amount), "balance": str(inv.balance(i)),
                "refund_due": str(refund)})
    db.commit()
    return {"number": note.number, "invoice_status": inv.display_status(i), "balance": float(inv.balance(i)), "refund_due": float(refund)}


# ─── Settings, gateways, payment plans ───────────────────────────────────────

class SettingBody(BaseModel):
    values: dict[str, Any]


@router.put("/settings/{key}")
def update_setting(key: str, body: SettingBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    _all_scope(request)
    try:
        old, new = inv.update_setting(db, key, body.values, _actor(request))
    except inv.InvoicingError as exc:
        _fail(exc)
    changed = {k: new[k] for k in body.values if old.get(k) != new.get(k)}
    if changed:
        _audit(db, request, "invoicing_setting_updated", None, None, f"Invoices & dunning – {key.replace('_', ' ')}: " + ", ".join(f"{k} → {v}" for k, v in changed.items()),
               old={k: old.get(k) for k in changed}, new=changed)
    db.commit()
    return new


@router.post("/gateways/{key}/verify")
def verify_gateway(key: str, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    _all_scope(request)
    try:
        result = gw.verify(db, key, _actor(request))
    except inv.InvoicingError as exc:
        _fail(exc)
    _audit(db, request, "gateway_verified" if result["ok"] else "gateway_verification_failed", None, None, f"{gw.NAMES[key]}: {result['detail']}")
    db.commit()
    return next(c for c in gw.cards(db) if c["key"] == key)


class PlanBody(BaseModel):
    tenant_id: int
    until: date
    note: str = Field(..., min_length=5, max_length=300)


@router.post("/payment-plans", status_code=201)
def create_plan(body: PlanBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    require_tenant_in_scope(request, body.tenant_id)
    tenant = db.get(Tenant, body.tenant_id)
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    try:
        plan = inv.create_payment_plan(db, tenant, body.until, body.note, _actor(request))
    except inv.InvoicingError as exc:
        _fail(exc)
    _audit(db, request, "payment_plan_approved", tenant.id, tenant.name, f"Payment plan until {body.until:%d %b %Y}: {plan.note}")
    db.commit()
    return {"id": plan.id}


@router.post("/payment-plans/{plan_id}/end")
def end_plan(plan_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    row = db.get(PlatformPaymentPlan, plan_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Payment plan not found")
    require_tenant_in_scope(request, row.tenant_id)
    try:
        plan = inv.end_payment_plan(db, plan_id, _actor(request))
    except inv.InvoicingError as exc:
        _fail(exc)
    tenant = db.get(Tenant, plan.tenant_id)
    _audit(db, request, "payment_plan_ended", plan.tenant_id, tenant.name if tenant else None, "Payment plan ended – dunning resumes")
    db.commit()
    return {"id": plan.id, "status": plan.status}


# ─── Gateway webhooks (no platform session; signature-checked) ───────────────

@webhook_router.post("/{gateway}")
async def payment_webhook(gateway: str, request: Request, db: Session = Depends(get_master_db_dep)):
    body = await request.body()
    try:
        return gw.handle_webhook(db, gateway, body, {k.lower(): v for k, v in request.headers.items()})
    except gw.WebhookRejected as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
