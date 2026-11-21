"""Payment gateways for platform invoices (Invoices & dunning → Gateways).

Credentials live only in the server environment (settings: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET,
STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET, BANK_ACCOUNT_NAME / BANK_ACCOUNT_NUMBER / BANK_IFSC); nothing secret is
stored in the database or sent to the browser. A gateway shows Connected only after "Verify" reached its API with
those credentials (the check is invalidated when the credentials change). UPI AutoPay mandates and wallet credits are
not implemented, so those two are always Not configured.

Webhooks (POST /api/v1/payment-webhooks/{razorpay|stripe}) are accepted only with a valid signature; each event id
is processed once, and payments are matched to invoices by the invoice number the payment carries
(Razorpay notes.invoice_number / Stripe metadata.invoice_number).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import time
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

import requests
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.platform_invoicing import PlatformGatewayEvent
from app.models.tenant import Tenant
from app.services.platform_billing import PlatformInvoice

logger = logging.getLogger(__name__)

ORDER = ["razorpay", "stripe", "bank", "upi", "manual", "wallet"]
NAMES = {"razorpay": "Razorpay", "stripe": "Stripe", "bank": "Bank transfer / NEFT", "upi": "UPI AutoPay", "manual": "Cheque / manual", "wallet": "Wallet credits"}
DESCRIPTIONS = {"razorpay": "Cards, UPI, netbanking · 2.0%", "stripe": "International cards · 2.9% + ₹ 2", "bank": "Virtual accounts · free",
                "upi": "Recurring mandate · 0.3%", "manual": "Record manually", "wallet": "Prepaid balance"}
API = {"razorpay": "https://api.razorpay.com/v1", "stripe": "https://api.stripe.com/v1"}


def _env(name: str) -> str:
    return str(getattr(settings, name, "") or "").strip()


def configured(key: str) -> bool:
    if key == "razorpay":
        return bool(_env("RAZORPAY_KEY_ID") and _env("RAZORPAY_KEY_SECRET"))
    if key == "stripe":
        return bool(_env("STRIPE_SECRET_KEY"))
    if key == "bank":
        return bool(_env("BANK_ACCOUNT_NUMBER") and _env("BANK_IFSC"))
    return key == "manual"  # UPI AutoPay and wallet credits are not implemented


def _missing(key: str) -> str:
    return {"razorpay": "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not set on the server", "stripe": "STRIPE_SECRET_KEY is not set on the server",
            "bank": "BANK_ACCOUNT_NUMBER and BANK_IFSC are not set on the server", "upi": "UPI AutoPay mandates are not implemented",
            "wallet": "There is no prepaid wallet balance in the platform"}.get(key, "")


def _fingerprint(key: str) -> str:
    raw = {"razorpay": _env("RAZORPAY_KEY_ID") + _env("RAZORPAY_KEY_SECRET"), "stripe": _env("STRIPE_SECRET_KEY"),
           "bank": _env("BANK_ACCOUNT_NUMBER") + _env("BANK_IFSC"), "manual": "manual"}.get(key, "")
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _webhook_secret(key: str) -> str:
    return _env("RAZORPAY_WEBHOOK_SECRET") if key == "razorpay" else _env("STRIPE_WEBHOOK_SECRET") if key == "stripe" else ""


def cards(db: Session) -> list[dict]:
    from app.services import platform_invoicing as inv
    conf = inv.settings_map(db)
    enabled, checks = conf["gateways"], conf["gateway_checks"]
    out = []
    for key in ORDER:
        check = checks.get(key) or {}
        verified = bool(check.get("ok")) and check.get("fingerprint") == _fingerprint(key)
        if not configured(key):
            status, detail = "Not configured", _missing(key)
        elif not enabled.get(key):
            status, detail = "Off", "Switched off – not offered for payment"
        elif check and check.get("fingerprint") == _fingerprint(key) and not check.get("ok"):
            status, detail = "Verification failed", check.get("detail")
        elif not verified:
            status, detail = "Not verified", "Configured – run Verify to check the credentials"
        else:
            status = "Connected" if key in API else "Available"
            detail = check.get("detail")
            if key in API and not _webhook_secret(key):
                detail = f"{detail} · webhook secret not set – payments are not reconciled automatically"
        out.append({"key": key, "name": NAMES[key], "description": DESCRIPTIONS[key], "enabled": bool(enabled.get(key)) and configured(key),
                    "configured": configured(key), "status": status, "detail": detail, "verified_at": check.get("at") if verified else None,
                    "webhook": f"/api/v1/payment-webhooks/{key}" if key in API else None, "can_verify": configured(key)})
    return out


def connected(db: Session, key: str) -> bool:
    return next((c["status"] in ("Connected", "Available") for c in cards(db) if c["key"] == key), False)


def verify(db: Session, key: str, actor: Optional[str]) -> dict:
    """Check the configured credentials against the gateway (or the bank details' format) and remember the result."""
    from app.services import platform_invoicing as inv
    if key not in NAMES:
        raise inv.InvoicingError("Unknown gateway", 404)
    if not configured(key):
        raise inv.InvoicingError(_missing(key), 409)
    ok, detail = False, ""
    try:
        if key == "razorpay":
            r = requests.get(f"{API['razorpay']}/payments", params={"count": 1}, auth=(_env("RAZORPAY_KEY_ID"), _env("RAZORPAY_KEY_SECRET")), timeout=15)
            ok = r.status_code == 200
            detail = f"API reached · {'live' if _env('RAZORPAY_KEY_ID').startswith('rzp_live') else 'test'} key" if ok else f"Razorpay refused the keys (HTTP {r.status_code})"
        elif key == "stripe":
            r = requests.get(f"{API['stripe']}/balance", auth=(_env("STRIPE_SECRET_KEY"), ""), timeout=15)
            ok = r.status_code == 200
            detail = f"API reached · {'live' if _env('STRIPE_SECRET_KEY').startswith('sk_live') else 'test'} key" if ok else f"Stripe refused the key (HTTP {r.status_code})"
        elif key == "bank":
            ok = bool(re.fullmatch(r"[A-Z]{4}0[A-Z0-9]{6}", _env("BANK_IFSC").upper())) and bool(re.fullmatch(r"\d{9,18}", _env("BANK_ACCOUNT_NUMBER")))
            detail = f"Account ••••{_env('BANK_ACCOUNT_NUMBER')[-4:]} · IFSC {_env('BANK_IFSC').upper()}" if ok else "The account number or IFSC is not in a valid format"
        else:
            ok, detail = True, "Payments are recorded by staff with a reference and evidence"
    except requests.RequestException as exc:
        ok, detail = False, f"Could not reach {NAMES[key]}: {type(exc).__name__}"
    checks = inv.setting(db, "gateway_checks")
    checks[key] = {"ok": ok, "detail": detail[:200], "at": datetime.utcnow().isoformat(timespec="seconds") + "Z", "fingerprint": _fingerprint(key), "by": actor}
    inv._store(db, "gateway_checks", checks, actor)
    return checks[key]


def ensure_payment_link(db: Session, invoice: PlatformInvoice, tenant: Tenant) -> dict:
    """A Razorpay payment link for the invoice balance (reused while the balance is unchanged)."""
    from app.services import platform_invoicing as inv
    if not connected(db, "razorpay"):
        return {"url": None, "detail": "No online gateway connected – no payment link"}
    due = inv.balance(invoice)
    if invoice.payment_link and (invoice.tax_detail or {}).get("link_amount") == str(due):
        return {"url": invoice.payment_link, "detail": "Existing payment link reused"}
    body = {"amount": int(due * 100), "currency": invoice.currency or "INR", "accept_partial": False, "reference_id": f"{invoice.number}-{int(time.time())}"[:40],
            "description": f"Invoice {invoice.number}", "customer": {"name": tenant.name[:50], "email": tenant.billing_email or tenant.admin_email},
            "notify": {"email": False, "sms": False}, "notes": {"invoice_number": invoice.number}}
    try:
        r = requests.post(f"{API['razorpay']}/payment_links", json=body, auth=(_env("RAZORPAY_KEY_ID"), _env("RAZORPAY_KEY_SECRET")), timeout=20)
    except requests.RequestException as exc:
        return {"url": None, "detail": f"Razorpay unreachable: {type(exc).__name__}"}
    if r.status_code != 200:
        return {"url": None, "detail": f"Razorpay refused the payment link (HTTP {r.status_code})"}
    invoice.payment_link = (r.json().get("short_url") or "")[:300] or None
    invoice.tax_detail = {**(invoice.tax_detail or {}), "link_amount": str(due)}
    return {"url": invoice.payment_link, "detail": "Payment link created" if invoice.payment_link else "Razorpay returned no link"}


# ─── Webhooks ────────────────────────────────────────────────────────────────

class WebhookRejected(Exception):
    pass


def _verify_razorpay(body: bytes, headers) -> dict:
    secret = _webhook_secret("razorpay")
    if not secret:
        raise WebhookRejected("Razorpay webhook secret is not configured")
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, headers.get("x-razorpay-signature", "")):
        raise WebhookRejected("Invalid Razorpay signature")
    event = json.loads(body)
    event_id = headers.get("x-razorpay-event-id") or hashlib.sha256(body).hexdigest()
    entity = ((event.get("payload") or {}).get("payment") or {}).get("entity") or {}
    kind = {"payment.captured": "paid", "payment.failed": "failed"}.get(event.get("event"))
    return {"id": event_id, "type": event.get("event"), "kind": kind, "invoice": (entity.get("notes") or {}).get("invoice_number"),
            "reference": entity.get("id"), "amount": Decimal(entity.get("amount") or 0) / 100, "currency": (entity.get("currency") or "INR").upper(),
            "reason": (entity.get("error_description") or entity.get("error_reason") or "Payment failed"), "at": entity.get("created_at")}


def _verify_stripe(body: bytes, headers, tolerance: int = 300) -> dict:
    secret = _webhook_secret("stripe")
    if not secret:
        raise WebhookRejected("Stripe webhook secret is not configured")
    parts = dict(p.split("=", 1) for p in headers.get("stripe-signature", "").split(",") if "=" in p)
    stamp, sigs = parts.get("t", ""), [v for k, v in (p.split("=", 1) for p in headers.get("stripe-signature", "").split(",") if "=" in p) if k == "v1"]
    if not stamp.isdigit() or abs(time.time() - int(stamp)) > tolerance:
        raise WebhookRejected("Stripe signature timestamp missing or too old")
    expected = hmac.new(secret.encode(), f"{stamp}.".encode() + body, hashlib.sha256).hexdigest()
    if not any(hmac.compare_digest(expected, s) for s in sigs):
        raise WebhookRejected("Invalid Stripe signature")
    event = json.loads(body)
    obj = (event.get("data") or {}).get("object") or {}
    kind = {"payment_intent.succeeded": "paid", "payment_intent.payment_failed": "failed"}.get(event.get("type"))
    amount = obj.get("amount_received") if kind == "paid" else obj.get("amount")
    return {"id": event.get("id"), "type": event.get("type"), "kind": kind, "invoice": (obj.get("metadata") or {}).get("invoice_number"),
            "reference": obj.get("id"), "amount": Decimal(amount or 0) / 100, "currency": (obj.get("currency") or "inr").upper(),
            "reason": ((obj.get("last_payment_error") or {}).get("message") or "Payment failed"), "at": obj.get("created")}


def handle_webhook(db: Session, gateway: str, body: bytes, headers) -> dict:
    """Verify, de-duplicate and apply a gateway event. Raises WebhookRejected for a bad signature (nothing is stored)."""
    from app.routers.platform_router import _write_platform_audit
    from app.services import platform_invoicing as inv
    inv.ensure_schema()
    if gateway not in API:
        raise WebhookRejected("Unknown gateway")
    if not inv.setting(db, "gateways").get(gateway):
        raise WebhookRejected(f"{NAMES[gateway]} is switched off")
    try:
        ev = _verify_razorpay(body, headers) if gateway == "razorpay" else _verify_stripe(body, headers)
    except (ValueError, KeyError) as exc:
        raise WebhookRejected(f"Malformed event: {type(exc).__name__}")
    if not ev["id"]:
        raise WebhookRejected("Event has no id")
    row = PlatformGatewayEvent(gateway=gateway, event_id=str(ev["id"])[:120], event_type=(ev["type"] or "")[:80], status="processing")
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()
    except IntegrityError:
        db.rollback()
        return {"status": "duplicate", "detail": "Event already processed"}
    invoice = db.query(PlatformInvoice).filter(PlatformInvoice.number == ev["invoice"]).first() if ev["invoice"] else None
    if ev["kind"] is None:
        row.status, row.detail = "ignored", f"Event type {ev['type']} is not used"
    elif invoice is None:
        row.status, row.detail = "ignored", f"No platform invoice {ev['invoice'] or '(none given)'}"
    elif ev["kind"] == "failed":
        changed = inv.mark_failed(db, invoice.id, gateway, ev["reason"])
        row.status, row.invoice_id = "processed", invoice.id
        row.detail = f"{invoice.number} marked failed: {ev['reason']}"[:300] if changed else f"{invoice.number} is already settled – failure ignored"
    else:
        paid_on = date.fromtimestamp(int(ev["at"])) if str(ev["at"] or "").isdigit() else date.today()
        try:
            payment, invoice, created = inv.record_payment(db, invoice.id, ev["amount"], gateway, ev["reference"], max(paid_on, invoice.issued_on), None,
                                                           "webhook", f"{NAMES[gateway]} webhook", ev["currency"])
            row.status, row.invoice_id = "processed", invoice.id
            row.detail = (f"₹{payment.amount:,.2f} applied to {invoice.number}" if created else f"Payment {ev['reference']} was already recorded")[:300]
        except inv.InvoicingError as exc:
            row.status, row.invoice_id, row.detail = "failed", invoice.id, str(exc)[:300]
    if row.invoice_id:
        tenant = db.get(Tenant, invoice.tenant_id)
        _write_platform_audit(db, None, f"payment_webhook_{row.status}", "tenant", invoice.tenant_id, tenant.name if tenant else None,
                              f"{NAMES[gateway]} {ev['type']}: {row.detail}", "gateway", new_data={"event": row.event_id, "reference": ev["reference"]})
    db.commit()
    return {"status": row.status, "detail": row.detail}
