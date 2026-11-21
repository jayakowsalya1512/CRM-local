"""Invoices & dunning (Business → Invoices & dunning).

Invoices are raised by the billing run in platform_billing (one per tenant and period, unique). This module adds what
happens after an invoice is issued:

- Payments: one platform_payments row per payment (unique gateway + reference, so a webhook delivered twice or a
  payment typed in twice is counted once). The invoice keeps amount_paid / amount_credited; its balance is
  total − paid − credited. Status: Paid / Due / Overdue / Failed (last gateway attempt failed) / Credited.
- Credit notes against one issued invoice, never more than it still has to credit; the invoice itself is not edited.
- Reminders by platform e-mail (SMTP), each attempt recorded with its delivery result.
- Dunning: a scheduled, idempotent job. Each step runs at most once per invoice (unique invoice + step); when the job
  was not running for a while only the latest due step runs and the missed ones are marked superseded, so a tenant
  never gets a burst of reminders. Payment retries need a saved payment authorization (card token, UPI or e-mandate);
  none is stored by the platform, so retries are recorded as skipped – nothing is ever charged without one.
  Read-only mode does not exist in the tenant application, so that step is recorded as unavailable. Suspension is
  never automatic: the step files a "Suspend tenant" request in the approval queue for a person to decide; tenant
  data and databases are never deleted. Tenants with an approved payment plan are paused when the policy says so.
- GST: rate, platform GSTIN, SAC and place of supply from this module's settings; intra-state supplies are split
  into CGST + SGST, inter-state ones are IGST. Invoicing is refused when tax is on and the GSTIN is missing or invalid,
  or when a tenant's state (needed for place of supply) is not recorded.
"""

from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Optional

from sqlalchemy import case, func, or_, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import master_engine
from app.models.platform_invoicing import (PlatformBillingSetting, PlatformCreditNote, PlatformDunningEvent, PlatformGatewayEvent, PlatformInvoiceReminder,
                                           PlatformPayment, PlatformPaymentPlan)
from app.models.tenant import Tenant
from app.services.platform_billing import PlatformInvoice, money

logger = logging.getLogger(__name__)


class InvoicingError(Exception):
    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.status = status


# ─── Schema ──────────────────────────────────────────────────────────────────

_ready = {"schema": False}
_INVOICE_COLUMNS = {
    "amount_paid": "DECIMAL(14,2) NOT NULL DEFAULT 0",
    "amount_credited": "DECIMAL(14,2) NOT NULL DEFAULT 0",
    "last_failure_at": "DATETIME NULL",
    "last_failure_reason": "VARCHAR(300) NULL",
    "gateway": "VARCHAR(20) NULL",
    "payment_link": "VARCHAR(300) NULL",
    "tax_detail": "JSON NULL",
    "late_fee_invoice_id": "INT NULL",
}
_INVOICE_INDEXES = {
    "ix_platform_invoices_status_due": "(status, due_on)",
    "ix_platform_invoices_issued": "(issued_on)",
}


def ensure_schema() -> None:
    if _ready["schema"]:
        return
    from app.services import platform_billing
    platform_billing.ensure_schema()
    for model in (PlatformPayment, PlatformCreditNote, PlatformInvoiceReminder, PlatformDunningEvent, PlatformGatewayEvent, PlatformPaymentPlan, PlatformBillingSetting):
        model.__table__.create(bind=master_engine, checkfirst=True)
    with master_engine.begin() as conn:
        cols = {r[0] for r in conn.execute(text("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_invoices'"))}
        for name, ddl in _INVOICE_COLUMNS.items():
            if name not in cols:
                conn.execute(text(f"ALTER TABLE platform_invoices ADD COLUMN {name} {ddl}"))
        idx = {r[0] for r in conn.execute(text("SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_invoices'"))}
        for name, ddl in _INVOICE_INDEXES.items():
            if name not in idx:
                conn.execute(text(f"CREATE INDEX {name} ON platform_invoices {ddl}"))
        # The unique (tenant_id, period_start) index already starts with tenant_id, so the single-column one is redundant.
        if "ix_platform_invoices_tenant_id" in idx and "uq_platform_invoice_period" in idx:
            conn.execute(text("DROP INDEX ix_platform_invoices_tenant_id ON platform_invoices"))
    _ready["schema"] = True


# ─── Settings ────────────────────────────────────────────────────────────────

DEFAULTS = {
    "dunning_steps": {"d0": True, "d3": True, "d7": True, "d14": True, "readonly": True, "suspend": True},
    "dunning_policy": {"grace_days": 14, "max_retries": 4, "suspend_after": 30, "late_fee_pct": "1.5", "pause_on_plan": True},
    "gst": {"gstin": "", "sac": "998314", "rate": 18, "supply": "tenant_state"},
    "einvoice": {"irn": True, "cancel_irn": True, "gstn_24h": True, "tds_reminder": False},
    "gateways": {"razorpay": True, "stripe": True, "bank": True, "upi": False, "manual": True, "wallet": False},
    "gateway_checks": {},
}
GST_RATES = (0, 5, 12, 18, 28)
SUPPLY = {"tenant_state": "Based on tenant state", "tamil_nadu": "Always Tamil Nadu"}


def setting(db: Session, key: str) -> dict:
    row = db.get(PlatformBillingSetting, key)
    return {**DEFAULTS[key], **(row.value if row and isinstance(row.value, dict) else {})}


def settings_map(db: Session) -> dict[str, dict]:
    rows = {r.key: r.value for r in db.query(PlatformBillingSetting).filter(PlatformBillingSetting.key.in_(list(DEFAULTS))).all()}
    return {k: {**v, **(rows.get(k) or {})} for k, v in DEFAULTS.items()}


def _store(db: Session, key: str, value: dict, actor: Optional[str]) -> dict:
    row = db.query(PlatformBillingSetting).filter(PlatformBillingSetting.key == key).with_for_update().first()
    if row is None:
        row = PlatformBillingSetting(key=key, value=value)
        db.add(row)
    row.value, row.updated_by, row.updated_at = value, actor, datetime.utcnow()
    return value


def _int(value, lo: int, hi: int, label: str) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise InvoicingError(f"{label} must be a whole number", 422)
    if str(value).strip() not in (str(n), f"{n}.0") or not lo <= n <= hi:
        raise InvoicingError(f"{label} must be between {lo} and {hi}", 422)
    return n


def update_setting(db: Session, key: str, patch: dict, actor: Optional[str]) -> tuple[dict, dict]:
    """Validate and store part of a setting. Returns (old, new)."""
    if key not in ("dunning_steps", "dunning_policy", "gst", "einvoice", "gateways"):
        raise InvoicingError("Unknown setting", 422)
    old = setting(db, key)
    unknown = set(patch) - set(DEFAULTS[key])
    if unknown:
        raise InvoicingError(f"Unknown field: {', '.join(sorted(unknown))}", 422)
    new = {**old}
    for field, value in patch.items():
        if isinstance(DEFAULTS[key][field], bool):
            if not isinstance(value, bool):
                raise InvoicingError("Expected on or off", 422)
            new[field] = value
    if key == "dunning_policy":
        if "grace_days" in patch:
            new["grace_days"] = _int(patch["grace_days"], 0, 60, "Grace period")
        if "max_retries" in patch:
            new["max_retries"] = _int(patch["max_retries"], 0, 10, "Max retries")
        if "suspend_after" in patch:
            new["suspend_after"] = _int(patch["suspend_after"], 22, 180, "Suspend after")
        if "late_fee_pct" in patch:
            try:
                fee = Decimal(str(patch["late_fee_pct"]))
            except InvalidOperation:
                raise InvoicingError("Late fee must be a number", 422)
            if not Decimal(0) <= fee <= Decimal(5) or fee != fee.quantize(Decimal("0.01")):
                raise InvoicingError("Late fee must be between 0 and 5 % (two decimals at most)", 422)
            new["late_fee_pct"] = str(fee.normalize()) if fee else "0"
        if new["suspend_after"] < new["grace_days"]:
            raise InvoicingError("Suspension can't come before the grace period ends", 422)
    elif key == "gst":
        if "gstin" in patch:
            gstin = str(patch["gstin"] or "").strip().upper()
            if gstin and not gstin_valid(gstin):
                raise InvoicingError("That GSTIN is not valid (15 characters, state code and checksum)", 422)
            new["gstin"] = gstin
        if "sac" in patch:
            sac = str(patch["sac"] or "").strip()
            if not re.fullmatch(r"99\d{4}", sac):
                raise InvoicingError("SAC codes for services are 6 digits starting with 99", 422)
            new["sac"] = sac
        if "rate" in patch:
            rate = _int(patch["rate"], 0, 28, "GST rate")
            if rate not in GST_RATES:
                raise InvoicingError(f"GST rate must be one of {', '.join(map(str, GST_RATES))} %", 422)
            new["rate"] = rate
        if "supply" in patch:
            if patch["supply"] not in SUPPLY:
                raise InvoicingError("Unknown place-of-supply rule", 422)
            new["supply"] = patch["supply"]
    elif key == "einvoice":
        if any(patch.values()) and not einvoice_status()["configured"]:
            raise InvoicingError(einvoice_status()["detail"], 409)
    elif key == "gateways":
        from app.services import platform_payment_gateways as gw
        for name, on in patch.items():
            if on and not gw.configured(name):
                raise InvoicingError(f"{gw.NAMES[name]} is not configured on the server – it can't be switched on", 409)
    _store(db, key, new, actor)
    return old, new


def einvoice_status() -> dict:
    """No IRP / GSP integration is installed, so nothing is ever sent to the Invoice Registration Portal."""
    return {"configured": False, "detail": "E-invoicing is not configured – no authorised IRP / GSP integration is installed, so no IRN, QR code or GSTN report is generated."}


# ─── GST ─────────────────────────────────────────────────────────────────────

_GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
STATE_CODES = {
    "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi",
    "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
    "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh",
    "23": "Madhya Pradesh", "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
    "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands", "36": "Telangana",
    "37": "Andhra Pradesh", "38": "Ladakh",
}
_ALIASES = {"orissa": "21", "pondicherry": "34", "newdelhi": "07", "nctofdelhi": "07", "jammuandkashmir": "01", "jk": "01",
            "damananddiu": "26", "dadraandnagarhaveli": "26", "andamanandnicobar": "35", "uttaranchal": "05"}


def gstin_valid(gstin: str) -> bool:
    if not re.fullmatch(r"\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]", gstin or "") or gstin[:2] not in STATE_CODES:
        return False
    total = 0
    for i, ch in enumerate(gstin[:14]):
        product = _GSTIN_CHARS.index(ch) * (2 if i % 2 else 1)
        total += product // 36 + product % 36
    return _GSTIN_CHARS[(36 - total % 36) % 36] == gstin[14]


def _norm(name: str) -> str:
    return re.sub(r"[^a-z]", "", (name or "").lower().replace("&", "and"))


_BY_NAME = {_norm(v): k for k, v in STATE_CODES.items()} | _ALIASES


def state_code(state: Optional[str]) -> Optional[str]:
    value = (state or "").strip()
    if re.fullmatch(r"\d{2}", value) and value in STATE_CODES:
        return value
    return _BY_NAME.get(_norm(value))


def tax_problem(db: Session, tax_on: bool) -> Optional[str]:
    if not tax_on:
        return None
    gst = setting(db, "gst")
    if not gst["gstin"]:
        return "GST is on but the platform GSTIN is not set (Invoices & dunning → Tax & e-invoice)"
    if not gstin_valid(gst["gstin"]):
        return "The platform GSTIN is not valid"
    return None


def tax_for(gst: dict, tenant: Tenant, subtotal: Decimal, tax_on: bool) -> tuple[Optional[dict], Optional[str]]:
    """GST on a subtotal for one tenant: ({rate, amount, detail}, None) or (None, why it can't be invoiced)."""
    if not tax_on:
        return {"rate": Decimal(0), "amount": Decimal("0.00"), "detail": {"type": "none"}}, None
    if (tenant.country or "India").strip().lower() not in ("india", "in"):
        return None, f"GST for tenants outside India ({tenant.country}, export of services) is not set up"
    if gst["supply"] == "tamil_nadu":
        place = "33"
    else:
        place = state_code(tenant.state)
        if not place:
            return None, "Tenant state is not recorded – GST place of supply can't be worked out (set it on the tenant)"
    rate = Decimal(gst["rate"])
    amount = money(subtotal * rate / 100)
    detail = {"gstin": gst["gstin"], "sac": gst["sac"], "place_of_supply": f"{place} – {STATE_CODES[place]}", "rate": str(rate)}
    if place == gst["gstin"][:2]:
        cgst = money(amount / 2)
        detail.update(type="CGST+SGST", cgst=str(cgst), sgst=str(amount - cgst))
    else:
        detail.update(type="IGST", igst=str(amount))
    return {"rate": rate, "amount": amount, "detail": detail}, None


# ─── Status ──────────────────────────────────────────────────────────────────

def balance(inv: PlatformInvoice) -> Decimal:
    return max(Decimal(0), money(inv.total) - money(inv.amount_paid) - money(inv.amount_credited))


def display_status(inv: PlatformInvoice, today: Optional[date] = None) -> str:
    today = today or date.today()
    if inv.status in ("Paid", "Credited"):
        return inv.status
    if inv.last_failure_at is not None:
        return "Failed"
    return "Overdue" if inv.due_on < today else "Due"


def status_expr(today: date):
    """SQL version of display_status, for filters, sorting and KPIs."""
    I = PlatformInvoice
    return case((I.status == "Paid", "Paid"), (I.status == "Credited", "Credited"), (I.last_failure_at.isnot(None), "Failed"),
                (I.due_on < today, "Overdue"), else_="Due")


def balance_expr():
    I = PlatformInvoice
    return func.greatest(I.total - I.amount_paid - I.amount_credited, 0)


def _settle(db: Session, inv: PlatformInvoice, actor: Optional[str]) -> None:
    """After a payment or credit: close the invoice when nothing is left, and lift dunning when the tenant is clear."""
    if balance(inv) > 0:
        return
    inv.status = "Paid" if money(inv.amount_paid) > 0 else "Credited"
    inv.last_failure_at, inv.last_failure_reason = None, None
    if inv.status == "Paid" and inv.paid_on is None:
        inv.paid_on = date.today()
    db.flush()
    others = db.query(func.count(PlatformInvoice.id)).filter(PlatformInvoice.tenant_id == inv.tenant_id, PlatformInvoice.status == "Pending",
                                                             or_(PlatformInvoice.due_on < date.today(), PlatformInvoice.last_failure_at.isnot(None))).scalar()
    if others:
        return
    tenant = db.get(Tenant, inv.tenant_id)
    if tenant is not None and tenant.billing_status == "past_due":
        tenant.billing_status = "active"
    from app.models.tenant import PlatformApprovalRequest
    for req in db.query(PlatformApprovalRequest).filter(PlatformApprovalRequest.action == "suspend_tenant", PlatformApprovalRequest.entity_id == inv.tenant_id,
                                                        PlatformApprovalRequest.status == "pending").all():
        if (req.payload or {}).get("source") == "dunning":  # only the requests dunning filed; a person's own request stays
            req.status, req.decided_at, req.result = "cancelled", datetime.utcnow(), f"Withdrawn by dunning: overdue invoices settled ({actor or 'system'})"


# ─── Payments ────────────────────────────────────────────────────────────────

GATEWAY_LABELS = {"razorpay": "Razorpay", "stripe": "Stripe", "bank": "Bank transfer", "upi": "UPI AutoPay", "manual": "Cheque / manual", "wallet": "Wallet credits"}


def _lock_invoice(db: Session, invoice_id: int) -> PlatformInvoice:
    inv = db.query(PlatformInvoice).filter(PlatformInvoice.id == invoice_id).with_for_update().first()
    if inv is None:
        raise InvoicingError("Invoice not found", 404)
    return inv


def record_payment(db: Session, invoice_id: int, amount, gateway: str, reference: str, paid_on: date, evidence: Optional[str], source: str,
                   actor: Optional[str], currency: str = "INR") -> tuple[PlatformPayment, PlatformInvoice, bool]:
    """Apply a payment (in the caller's transaction). Returns (payment, invoice, created); a repeated (gateway, reference)
    returns the earlier payment with created False and changes nothing."""
    reference = (reference or "").strip()
    if not reference:
        raise InvoicingError("A payment reference is required", 422)
    existing = db.query(PlatformPayment).filter(PlatformPayment.gateway == gateway, PlatformPayment.reference == reference).first()
    if existing:
        return existing, db.get(PlatformInvoice, existing.invoice_id), False
    inv = _lock_invoice(db, invoice_id)
    amount = money(amount)
    if currency != (inv.currency or "INR"):
        raise InvoicingError(f"Payment currency {currency} does not match the invoice ({inv.currency})", 422)
    if amount <= 0:
        raise InvoicingError("The amount must be above zero", 422)
    if inv.status in ("Paid", "Credited"):
        raise InvoicingError(f"Invoice {inv.number} is already settled", 409)
    due = balance(inv)
    if source == "manual" and amount > due:
        raise InvoicingError(f"₹{amount:,.2f} is more than the ₹{due:,.2f} still due on {inv.number}", 422)
    if paid_on > date.today() or paid_on < inv.issued_on:
        raise InvoicingError("The payment date must be between the invoice date and today", 422)
    payment = PlatformPayment(invoice_id=inv.id, tenant_id=inv.tenant_id, gateway=gateway, reference=reference[:120], amount=amount, currency=currency,
                              paid_on=paid_on, evidence=(evidence or "").strip()[:500] or None, source=source, recorded_by=actor)
    try:
        with db.begin_nested():
            db.add(payment)
            db.flush()
    except IntegrityError:  # recorded by a concurrent request a moment ago
        existing = db.query(PlatformPayment).filter(PlatformPayment.gateway == gateway, PlatformPayment.reference == reference).one()
        return existing, inv, False
    inv.amount_paid = money(inv.amount_paid) + amount
    inv.gateway = gateway
    inv.payment_ref = reference[:120]
    inv.last_failure_at, inv.last_failure_reason = None, None
    if balance(inv) <= 0:
        inv.paid_on = paid_on
    _settle(db, inv, actor)
    return payment, inv, True


def mark_failed(db: Session, invoice_id: int, gateway: str, reason: str) -> Optional[PlatformInvoice]:
    inv = _lock_invoice(db, invoice_id)
    if inv.status != "Pending":
        return None
    inv.last_failure_at, inv.last_failure_reason, inv.gateway = datetime.utcnow(), reason[:300], gateway
    return inv


# ─── Credit notes ────────────────────────────────────────────────────────────

def creditable(inv: PlatformInvoice) -> Decimal:
    """What can still be credited on an invoice: its total less earlier credit notes."""
    return max(Decimal(0), money(inv.total) - money(inv.amount_credited))


def _next_credit_number(db: Session, issued: date) -> str:
    stem = f"CN-{issued:%y%m}-"
    last = db.execute(text("SELECT MAX(CAST(SUBSTRING(number, :o) AS UNSIGNED)) FROM platform_credit_notes WHERE number LIKE :p"),
                      {"o": len(stem) + 1, "p": stem + "%"}).scalar()
    return f"{stem}{(last or 0) + 1:04d}"


def issue_credit_note(db: Session, invoice_id: int, amount, reason: str, actor: Optional[str]) -> tuple[PlatformCreditNote, PlatformInvoice, Decimal]:
    """Issue a credit note (caller commits). Returns (note, invoice, refund_due) – refund_due is the part of the credit
    above what was still unpaid, i.e. money the tenant has already paid and is owed back."""
    from app.services import platform_controls as controls
    if not controls.value(db, "invCredit"):
        raise InvoicingError("Credit notes are switched off (Control Center → Allow credit notes)", 409)
    reason = (reason or "").strip()
    if len(reason) < 5:
        raise InvoicingError("Give a reason (at least 5 characters)", 422)
    inv = _lock_invoice(db, invoice_id)
    try:
        amount = money(amount)
    except InvalidOperation:
        raise InvoicingError("The amount must be a number", 422)
    if amount <= 0:
        raise InvoicingError("The amount must be above zero", 422)
    limit = creditable(inv)
    if amount > limit:
        raise InvoicingError(f"₹{amount:,.2f} is more than the ₹{limit:,.2f} that can still be credited on {inv.number}", 422)
    unpaid_before = balance(inv)
    rate = Decimal(inv.tax_rate or 0)
    tax = money(amount * rate / (100 + rate)) if rate else Decimal("0.00")
    note = None
    for _ in range(3):  # the number is unique; retry if a concurrent note took it
        try:
            with db.begin_nested():
                note = PlatformCreditNote(number=_next_credit_number(db, date.today()), invoice_id=inv.id, tenant_id=inv.tenant_id, amount=amount,
                                          tax_amount=tax, reason=reason[:300], status="Issued", issued_by=actor)
                db.add(note)
                db.flush()
            break
        except IntegrityError:
            note = None
    if note is None:
        raise InvoicingError("Could not number the credit note – try again", 409)
    inv.amount_credited = money(inv.amount_credited) + amount
    _settle(db, inv, actor)
    return note, inv, max(Decimal(0), amount - unpaid_before)


# ─── Reminders ───────────────────────────────────────────────────────────────

def _send(to: Optional[str], subject: str, body: str) -> tuple[bool, str]:
    from app.services.platform_trust_safety import send_mail  # the platform's SMTP sender
    return send_mail(to, subject, body)


def _reminder_text(inv: PlatformInvoice, tenant: Tenant, lead: str, extra: str = "") -> tuple[str, str]:
    due = balance(inv)
    subject = f"Payment reminder: invoice {inv.number} – ₹{due:,.2f} due"
    body = (f"Hello {tenant.name},\n\n{lead}\n\nInvoice: {inv.number}\nPeriod: {inv.period_start:%d %b %Y} – {inv.period_end:%d %b %Y}\n"
            f"Amount due: ₹{due:,.2f} (incl. GST)\nDue date: {inv.due_on:%d %b %Y}\n")
    if inv.payment_link:
        body += f"Pay online: {inv.payment_link}\n"
    if extra:
        body += f"\n{extra}\n"
    return subject, body + "\nIf you have already paid, please reply with the payment reference.\n"


def send_reminder(db: Session, inv: PlatformInvoice, tenant: Tenant, kind: str, actor: Optional[str], to: Optional[str] = None, lead: Optional[str] = None,
                  extra: str = "", step_day: Optional[int] = None, dedupe: Optional[str] = None) -> PlatformInvoiceReminder:
    recipient = to or tenant.billing_email or tenant.admin_email
    subject, body = _reminder_text(inv, tenant, lead or f"This is a reminder that invoice {inv.number} is unpaid.", extra)
    sent, detail = _send(recipient, subject, body)
    row = PlatformInvoiceReminder(invoice_id=inv.id, tenant_id=inv.tenant_id, kind=kind, step_day=step_day, channel="email", recipient=recipient,
                                  status="sent" if sent else "failed", detail=detail[:300], dedupe_key=dedupe, created_by=actor)
    db.add(row)
    db.flush()
    return row


def manual_reminder(db: Session, invoice_id: int, actor: Optional[str]) -> PlatformInvoiceReminder:
    inv = _lock_invoice(db, invoice_id)
    if inv.status != "Pending":
        raise InvoicingError(f"Invoice {inv.number} is already settled – nothing to remind about", 409)
    recent = (db.query(PlatformInvoiceReminder).filter(PlatformInvoiceReminder.invoice_id == inv.id, PlatformInvoiceReminder.status == "sent",
                                                        PlatformInvoiceReminder.created_at >= datetime.utcnow() - timedelta(hours=24))
              .order_by(PlatformInvoiceReminder.id.desc()).first())
    if recent:
        raise InvoicingError(f"A reminder was already sent to {recent.recipient} at {recent.created_at:%d %b %H:%M} UTC – wait 24 hours before sending another", 409)
    tenant = db.get(Tenant, inv.tenant_id)
    return send_reminder(db, inv, tenant, "manual", actor)


# ─── Payment plans ───────────────────────────────────────────────────────────

def active_plans(db: Session, tenant_ids: list[int], today: Optional[date] = None) -> dict[int, PlatformPaymentPlan]:
    today = today or date.today()
    rows = db.query(PlatformPaymentPlan).filter(PlatformPaymentPlan.tenant_id.in_(tenant_ids or [0]), PlatformPaymentPlan.status == "approved",
                                                PlatformPaymentPlan.until >= today).all()
    return {r.tenant_id: r for r in rows}


def create_payment_plan(db: Session, tenant: Tenant, until: date, note: str, actor: Optional[str]) -> PlatformPaymentPlan:
    note = (note or "").strip()
    if len(note) < 5:
        raise InvoicingError("Describe the arrangement (at least 5 characters)", 422)
    if until <= date.today() or until > date.today() + timedelta(days=366):
        raise InvoicingError("The plan must end between tomorrow and a year from now", 422)
    if active_plans(db, [tenant.id]):
        raise InvoicingError(f"{tenant.name} already has an approved payment plan", 409)
    plan = PlatformPaymentPlan(tenant_id=tenant.id, until=until, note=note[:300], status="approved", approved_by=actor)
    db.add(plan)
    db.flush()
    return plan


def end_payment_plan(db: Session, plan_id: int, actor: Optional[str]) -> PlatformPaymentPlan:
    plan = db.query(PlatformPaymentPlan).filter(PlatformPaymentPlan.id == plan_id).with_for_update().first()
    if plan is None:
        raise InvoicingError("Payment plan not found", 404)
    if plan.status != "approved":
        raise InvoicingError("This payment plan has already ended", 409)
    plan.status, plan.ended_by, plan.ended_at = "ended", actor, datetime.utcnow()
    return plan


# ─── Dunning ─────────────────────────────────────────────────────────────────

STEPS = [  # key, day (None = policy "Suspend after"), schedule text (prototype wording)
    ("d0", 0, "Payment fails → retry + e-mail the billing contact"),
    ("d3", 3, "Retry · reminder with payment link"),
    ("d7", 7, "Retry · reminder to tenant admin"),
    ("d14", 14, "Final notice · mention suspension date"),
    ("readonly", 21, "Read-only mode"),
    ("suspend", None, "Suspend tenant · data kept 90 days"),
]
_RETRY_STEPS = {"d0", "d3", "d7"}
NO_AUTHORIZATION = "No saved payment authorization (card token, UPI AutoPay or e-mandate) on file – nothing was charged"


def step_days(policy: dict) -> dict[str, int]:
    return {key: (day if day is not None else int(policy["suspend_after"])) for key, day, _ in STEPS}


def dunning_start(inv: PlatformInvoice) -> date:
    start = inv.due_on + timedelta(days=1)
    if inv.last_failure_at is not None:
        start = min(start, inv.last_failure_at.date())
    return start


def run_dunning(db: Session, today: Optional[date] = None) -> dict:
    """Run the due dunning step of every unpaid overdue / failed invoice. Safe to run any number of times."""
    ensure_schema()
    with master_engine.connect() as lock:
        if lock.execute(text("SELECT GET_LOCK('platform_dunning', 0)")).scalar() != 1:
            return {"skipped": "another worker is running dunning"}
        try:
            return _run_dunning(db, today or date.today())
        finally:
            lock.execute(text("SELECT RELEASE_LOCK('platform_dunning')"))


def _run_dunning(db: Session, today: date) -> dict:
    from app.routers.platform_router import _write_platform_audit
    from app.services import platform_payment_gateways as gw
    from app.services.platform_trust_safety import queue_approval

    conf = settings_map(db)
    steps_on, policy = conf["dunning_steps"], conf["dunning_policy"]
    days = step_days(policy)
    grace = int(policy["grace_days"])
    invoices = (db.query(PlatformInvoice).filter(PlatformInvoice.status == "Pending", or_(PlatformInvoice.due_on < today, PlatformInvoice.last_failure_at.isnot(None)))
                .order_by(PlatformInvoice.due_on, PlatformInvoice.id).all())
    summary = {"invoices": len(invoices), "steps_run": 0, "reminders_sent": 0, "reminders_failed": 0, "paused": 0, "suspensions_queued": 0}
    if not invoices:
        return summary
    ids = [i.id for i in invoices]
    tenant_ids = sorted({i.tenant_id for i in invoices})
    tenants = {t.id: t for t in db.query(Tenant).filter(Tenant.id.in_(tenant_ids)).all()}
    plans = active_plans(db, tenant_ids, today) if policy["pause_on_plan"] else {}
    done: dict[int, set[str]] = {}
    for inv_id, step in db.query(PlatformDunningEvent.invoice_id, PlatformDunningEvent.step).filter(PlatformDunningEvent.invoice_id.in_(ids)).all():
        done.setdefault(inv_id, set()).add(step)
    retries = dict(db.query(PlatformDunningEvent.invoice_id, func.count(PlatformDunningEvent.id)).filter(
        PlatformDunningEvent.invoice_id.in_(ids), PlatformDunningEvent.retry == "attempted").group_by(PlatformDunningEvent.invoice_id).all())
    for inv in invoices:
        tenant = tenants.get(inv.tenant_id)
        if tenant is None or balance(inv) <= 0:
            continue
        if inv.tenant_id in plans:
            summary["paused"] += 1
            continue
        start = dunning_start(inv)
        age = (today - start).days
        due = [key for key, _, _ in STEPS if steps_on.get(key) and key not in done.get(inv.id, set()) and days[key] <= age
               and (key not in ("readonly", "suspend") or age >= grace)]
        if not due:
            continue
        key, missed = due[-1], due[:-1]
        try:
            with db.begin_nested():  # claim the step first: a second worker or run gets the unique-key error and moves on
                for m in missed:
                    db.add(PlatformDunningEvent(invoice_id=inv.id, tenant_id=inv.tenant_id, step=m, day=days[m], status="superseded",
                                                actions=[{"action": "step", "status": "superseded", "detail": f"Not run on day {days[m]}; day {days[key]} step ran instead"}]))
                event = PlatformDunningEvent(invoice_id=inv.id, tenant_id=inv.tenant_id, step=key, day=days[key], status="running", actions=[])
                db.add(event)
                db.flush()
        except IntegrityError:
            continue
        db.commit()
        actions: list[dict] = []
        if key in _RETRY_STEPS:
            if retries.get(inv.id, 0) >= int(policy["max_retries"]):
                actions.append({"action": "retry", "status": "skipped", "detail": f"Max retries ({policy['max_retries']}) reached"})
                event.retry = "skipped"
            else:
                actions.append({"action": "retry", "status": "skipped", "detail": NO_AUTHORIZATION})
                event.retry = "skipped"
        suspend_on = start + timedelta(days=days["suspend"])
        mail = None
        if tenant.billing_status == "active":  # whichever step runs first
            tenant.billing_status = "past_due"
            actions.append({"action": "billing_status", "status": "done", "detail": "Tenant billing status set to past due"})
        if key == "d0":
            mail = dict(lead=f"We couldn't collect payment for invoice {inv.number}." if inv.last_failure_at else f"Invoice {inv.number} is now overdue.")
        elif key == "d3":
            link = gw.ensure_payment_link(db, inv, tenant)
            actions.append({"action": "payment_link", "status": "done" if link["url"] else "skipped", "detail": link["detail"]})
            mail = dict(lead=f"Invoice {inv.number} is still unpaid." + ("" if link["url"] else " Please pay by bank transfer quoting the invoice number."))
        elif key == "d7":
            mail = dict(to=tenant.admin_email, lead=f"Invoice {inv.number} for your organisation is {age} days overdue. Please ask your billing contact to pay it.")
        elif key == "d14":
            extra = f"If it is still unpaid, access to {tenant.name} will be reviewed for suspension from {suspend_on:%d %b %Y}." if steps_on.get("suspend") else ""
            mail = dict(lead=f"Final notice: invoice {inv.number} is {age} days overdue.", extra=extra)
        elif key == "readonly":
            actions.append({"action": "read_only", "status": "unavailable", "detail": "Read-only mode isn't available in the tenant application – access was not changed"})
        elif key == "suspend":
            if tenant.status == "suspended":
                actions.append({"action": "suspend", "status": "skipped", "detail": "Tenant is already suspended"})
            else:
                req, created = queue_approval(db, "suspend_tenant", tenant, f"Suspend tenant '{tenant.name}' – invoice {inv.number} unpaid {age} days (dunning)",
                                              {"tenant_id": tenant.id, "source": "dunning", "invoice": inv.number}, None)
                actions.append({"action": "suspend", "status": "queued", "detail": f"Approval request #{req.id} filed – a person decides; data is kept"
                                + ("" if created else " (already waiting)")})
                summary["suspensions_queued"] += int(created)
        if mail:
            rem = send_reminder(db, inv, tenant, "dunning", None, to=mail.get("to"), lead=mail["lead"], extra=mail.get("extra", ""), step_day=days[key],
                                dedupe=f"dun:{inv.id}:{key}")
            actions.append({"action": "email", "status": rem.status, "detail": rem.detail})
            summary["reminders_sent" if rem.status == "sent" else "reminders_failed"] += 1
        event.actions = actions
        event.status = "done" if any(a["status"] in ("done", "sent", "queued") for a in actions) else "skipped"
        _write_platform_audit(db, None, "dunning_step", "tenant", tenant.id, tenant.name,
                              f"Dunning day {days[key]} for {inv.number}: " + "; ".join(f"{a['action']} {a['status']}" for a in actions), "system",
                              new_data={"invoice": inv.number, "step": key, "actions": actions})
        db.commit()
        summary["steps_run"] += 1
    return summary


# ─── Late fees (billed on the tenant's next invoice) ─────────────────────────

def late_fees(db: Session, tenant_ids: list[int], today: date) -> dict[int, list[dict]]:
    policy = setting(db, "dunning_policy")
    pct = Decimal(str(policy["late_fee_pct"]))
    if pct <= 0 or not tenant_ids:
        return {}
    cutoff = today - timedelta(days=int(policy["grace_days"]))
    rows = db.query(PlatformInvoice).filter(PlatformInvoice.tenant_id.in_(tenant_ids), PlatformInvoice.status == "Pending", PlatformInvoice.due_on < cutoff,
                                            PlatformInvoice.late_fee_invoice_id.is_(None)).all()
    out: dict[int, list[dict]] = {}
    for inv in rows:
        due = balance(inv)
        fee = money(due * pct / 100)
        if fee > 0:
            out.setdefault(inv.tenant_id, []).append({"kind": "late_fee", "description": f"Late fee – {inv.number} overdue since {inv.due_on:%d %b %Y} ({pct:g}% of ₹{due:,.2f})",
                                                      "quantity": Decimal(1), "unit_price": fee, "amount": fee, "meter": {"invoice_id": inv.id}})
    return out


# ─── KPIs ────────────────────────────────────────────────────────────────────

def kpis(db: Session, tenant_ids: Optional[list[int]], today: Optional[date] = None) -> dict:
    today = today or date.today()
    month_start = today.replace(day=1)
    I = PlatformInvoice
    st = status_expr(today)
    q = db.query(
        func.coalesce(func.sum(case((I.issued_on >= month_start, I.total), else_=0)), 0),
        func.coalesce(func.sum(case((st == "Due", balance_expr()), else_=0)), 0),
        func.coalesce(func.sum(case((st.in_(("Overdue", "Failed")), balance_expr()), else_=0)), 0),
        func.count(func.distinct(case((st.in_(("Overdue", "Failed")), I.tenant_id), else_=None))),
        func.count(case((I.issued_on >= month_start, 1), else_=None)),
    )
    pq = db.query(func.coalesce(func.sum(PlatformPayment.amount), 0)).filter(PlatformPayment.paid_on >= month_start)
    if tenant_ids is not None:
        q = q.filter(I.tenant_id.in_(tenant_ids or [0]))
        pq = pq.filter(PlatformPayment.tenant_id.in_(tenant_ids or [0]))
    invoiced, due, overdue, at_risk, count = q.one()
    return {"invoiced_month": float(money(invoiced)), "invoices_month": int(count), "collected_month": float(money(pq.scalar())), "due": float(money(due)),
            "overdue": float(money(overdue)), "at_risk_tenants": int(at_risk)}
