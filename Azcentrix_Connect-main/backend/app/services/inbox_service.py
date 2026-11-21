"""Inbox & Notifications service: schema, CRM record linking, delivery, scheduling, preferences.

Reuses the existing tenant SMTP sender (tenant_email_service), in-app notifications
(notification_service.upsert_notification), data-scope rules (utils.data_scope) and
role permissions (dependencies.user_has_permission).
"""
from __future__ import annotations

import html
import logging
import mimetypes
import re
import secrets
import threading
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Iterable, Optional

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.timezone import now_ist
from app.models.all_models import Customer, CustomerContact, Lead, Quotation, Tender, User
from app.models.inbox import (
    INBOX_TABLES, MailAttachment, MailMessage, MailRecipient, MailTemplate, MailThread,
    NotificationDeliveryPreference,
)

logger = logging.getLogger(__name__)

EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
_SCHEMA_READY: set[str] = set()
_SCHEMA_LOCK = threading.Lock()

# ─── Schema ───────────────────────────────────────────────────────────────────

# Prototype v17 MTP templates – starter rows, editable per tenant.
STARTER_TEMPLATES = [
    ("Bid submission acknowledgement", "Bid submission acknowledgement",
     "Dear {{contact}},\n\nWe acknowledge the tender {{tender_no}} – {{title}}. Our submission will reach you before the deadline.\n\nRegards,\n{{sender}}"),
    ("Quotation follow-up", "Quotation follow-up",
     "Dear {{contact}},\n\nFollowing up on our quotation {{ref}} for {{title}} (value {{value}}). Happy to clarify anything.\n\nRegards,\n{{sender}}"),
    ("Meeting request", "Meeting request",
     "Dear {{contact}},\n\nCould we meet this week to discuss {{title}}? I can come to your office.\n\nRegards,\n{{sender}}"),
    ("Thank you after visit", "Thank you after visit",
     "Dear {{contact}},\n\nThank you for your time today. As discussed, I will share the technical proposal for {{title}} shortly.\n\nRegards,\n{{sender}}"),
]


def ensure_inbox_schema(db: Session) -> None:
    """Create the inbox tables (idempotent) and seed starter templates once per tenant DB per process."""
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _SCHEMA_READY:
        return
    with _SCHEMA_LOCK:
        if slug in _SCHEMA_READY:
            return
        bind = db.get_bind()
        for table in INBOX_TABLES:
            table.create(bind=bind, checkfirst=True)
        # Columns added after the first release of these tables.
        from sqlalchemy import text as _text
        with bind.begin() as conn:
            conn.execute(_text("ALTER TABLE notification_delivery_preferences ADD COLUMN IF NOT EXISTS last_sent_on DATE NULL"))
        # End the session's current transaction: MariaDB refuses to read a table created after
        # the transaction's snapshot began ("Table definition has changed").
        db.commit()
        if not db.query(MailTemplate.id).first():
            for i, (name, subject, body) in enumerate(STARTER_TEMPLATES):
                db.add(MailTemplate(name=name, subject=subject, body=body, is_system=True, sort_order=i))
            db.commit()
        _SCHEMA_READY.add(slug)


def ensure_inbox_schema_all_tenants() -> None:
    """Startup hook: create the inbox tables for every tenant."""
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant

    master = MasterSessionLocal()
    try:
        slugs = [t.slug for t in master.query(Tenant).all()]
    except Exception as exc:  # pragma: no cover - startup safety
        logger.warning("Inbox schema sync: unable to list tenants: %s", exc)
        return
    finally:
        master.close()
    for slug in slugs:
        try:
            db = get_tenant_session(slug)
            try:
                db.info["tenant_slug"] = slug
                ensure_inbox_schema(db)
            finally:
                db.close()
        except Exception as exc:
            logger.warning("Inbox schema sync failed for %s: %s", slug, exc)


# ─── Formatting helpers ───────────────────────────────────────────────────────

def iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value else None


def inr(value: Any) -> str:
    """Prototype inr(): ₹ 1.2 Cr / ₹ 6.2 L / ₹ 45,000."""
    try:
        v = float(value or 0)
    except (TypeError, ValueError):
        return "—"
    if not v:
        return "—"
    if v >= 1e7:
        return f"₹ {v / 1e7:.1f} Cr".replace(".0 Cr", " Cr")
    if v >= 1e5:
        return f"₹ {v / 1e5:.1f} L".replace(".0 L", " L")
    return f"₹ {v:,.0f}"


def split_addresses(raw: Optional[str]) -> list[str]:
    return [a.strip() for a in re.split(r"[,;]", raw or "") if a.strip()]


def extract_email(entry: str) -> str:
    """'Name <a@b.c>' → 'a@b.c'."""
    m = re.search(r"<([^>]+)>", entry)
    return (m.group(1) if m else entry).strip()


# ─── CRM record linking ───────────────────────────────────────────────────────
# Prototype MODL labels: Bid, Deal, Customer, Quote (+ Lead for the app's lead module).
RECORD_LABEL = {"tenders": "Bid", "opportunities": "Deal", "customers": "Customer", "quotations": "Quote", "leads": "Lead"}
RECORD_ORDER = ["tenders", "opportunities", "customers", "quotations", "leads"]


def record_route(module: str, record_id: int) -> str:
    return {
        "leads": f"/leads/{record_id}",
        "opportunities": f"/opportunities/{record_id}",
        "tenders": f"/tenders/{record_id}/edit",
        "customers": f"/customers/{record_id}/edit",
        "quotations": "/quotations",
    }.get(module, "/dashboard")


def _can(db: Session, user: User, key: str) -> bool:
    from app.dependencies import user_has_permission
    return user_has_permission(db, user, key)


def _scoped(db: Session, user: User, query, module: str, owner_col, assigned_col=None):
    from app.utils.data_scope import apply_data_scope
    return apply_data_scope(db, query, user, module, owner_col, assigned_col)


def _primary_contact(db: Session, customer_id: Optional[int]) -> tuple[Optional[str], Optional[str]]:
    if not customer_id:
        return None, None
    c = (db.query(CustomerContact)
         .filter(CustomerContact.customer_id == customer_id, CustomerContact.is_active == True)
         .order_by(CustomerContact.is_primary.desc(), CustomerContact.id.asc()).first())
    return (c.contact_name, c.office_email) if c else (None, None)


def _record_dict(db: Session, module: str, row: Any) -> dict[str, Any]:
    if module == "customers":
        contact, email = _primary_contact(db, row.id)
        ref, title, customer, value = f"CUS-{row.id:04d}", row.customer_name, row.customer_name, None
        tender_no = None
    elif module in ("leads", "opportunities"):
        contact, email = row.contact_person, row.email
        ref = (row.opportunity_ref_id if module == "opportunities" else None) or row.lead_ref_id or f"LD-{row.id}"
        title, customer, value, tender_no = row.lead_title, row.customer_name, row.est_value, row.tender_id_ref
    elif module == "tenders":
        contact, email = _primary_contact(db, row.customer_id)
        ref = row.tender_num or f"TND-{row.id}"
        title, customer, value, tender_no = row.tender_title, row.customer_name, getattr(row, "tender_value", None) or getattr(row, "estimated_value", None), row.tender_num
    else:  # quotations
        contact, email = _primary_contact(db, row.customer_id)
        cust = db.query(Customer.customer_name).filter(Customer.id == row.customer_id).scalar() if row.customer_id else None
        ref = f"{row.quotation_number}-Q{row.revision_number or 1}" if row.quotation_number else f"QT-{row.id}"
        title, customer, value, tender_no = row.subject, cust, row.total_amount, None
    if isinstance(value, Decimal):
        value = float(value)
    return {
        "module": module, "id": row.id, "ref": ref, "type": RECORD_LABEL[module],
        "title": title or ref, "customer": customer, "contact": contact, "email": email,
        "value": value, "value_label": inr(value) if value else "—", "tender_no": tender_no,
        "route": record_route(module, row.id),
        "label": f"{RECORD_LABEL[module]}: {ref} – {(customer if module in ('tenders', 'quotations') else title) or ''}".rstrip(" –"),
    }


def _record_query(db: Session, user: User, module: str):
    """Permission + data-scope filtered query for one linkable module, or None."""
    if not _can(db, user, f"{module}.view"):
        return None
    if module == "customers":
        q = db.query(Customer).filter(Customer.is_deleted == False)
        return _scoped(db, user, q, "customers", Customer.created_by, Customer.assigned_to)
    if module in ("leads", "opportunities"):
        q = db.query(Lead).filter(Lead.is_deleted == False)
        is_opp = or_(Lead.lead_type == "direct_opportunity", Lead.status.in_(("Opportunity Created", "Converted")))
        q = q.filter(is_opp) if module == "opportunities" else q.filter(~is_opp)
        return _scoped(db, user, q, module, Lead.created_by, Lead.assigned_to)
    if module == "tenders":
        q = db.query(Tender).filter(Tender.is_deleted == False)
        return _scoped(db, user, q, "tenders", Tender.created_by, Tender.assigned_to)
    if module == "quotations":
        q = db.query(Quotation)
        return _scoped(db, user, q, "quotations", Quotation.created_by, Quotation.signatory_user_id)
    return None


def _search_filter(module: str, term: str):
    like = f"%{term}%"
    if module == "customers":
        return Customer.customer_name.ilike(like)
    if module in ("leads", "opportunities"):
        return or_(Lead.lead_title.ilike(like), Lead.customer_name.ilike(like), Lead.lead_ref_id.ilike(like), Lead.opportunity_ref_id.ilike(like))
    if module == "tenders":
        return or_(Tender.tender_title.ilike(like), Tender.customer_name.ilike(like), Tender.tender_num.ilike(like))
    return or_(Quotation.subject.ilike(like), Quotation.quotation_number.ilike(like))


def search_records(db: Session, user: User, q: str = "", per_module: int = 8, modules: Optional[Iterable[str]] = None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    term = (q or "").strip()
    model_id = {"customers": Customer.id, "leads": Lead.id, "opportunities": Lead.id, "tenders": Tender.id, "quotations": Quotation.id}
    for module in modules or RECORD_ORDER:
        try:
            query = _record_query(db, user, module)
            if query is None:
                continue
            if term:
                query = query.filter(_search_filter(module, term))
            for row in query.order_by(model_id[module].desc()).limit(per_module).all():
                out.append(_record_dict(db, module, row))
        except Exception as exc:  # one module must not break the picker
            logger.warning("Inbox record search failed for %s: %s", module, exc)
            db.rollback()
    return out


def resolve_record(db: Session, user: User, module: Optional[str], record_id: Optional[int], *, check_access: bool = True) -> Optional[dict[str, Any]]:
    if not module or not record_id or module not in RECORD_LABEL:
        return None
    try:
        if check_access:
            query = _record_query(db, user, module)
            if query is None:
                return None
        else:
            query = db.query({"customers": Customer, "leads": Lead, "opportunities": Lead, "tenders": Tender, "quotations": Quotation}[module])
        model = {"customers": Customer, "leads": Lead, "opportunities": Lead, "tenders": Tender, "quotations": Quotation}[module]
        row = query.filter(model.id == int(record_id)).first()
        return _record_dict(db, module, row) if row else None
    except Exception as exc:
        logger.warning("Inbox record resolve failed for %s/%s: %s", module, record_id, exc)
        db.rollback()
        return None


# Notification modules → linkable CRM record (for "related CRM records" on notifications).
NOTIF_MODULE_MAP = {"leads": "leads", "lead": "leads", "opportunities": "opportunities", "tenders": "tenders", "tender": "tenders",
                    "customers": "customers", "customer": "customers", "quotations": "quotations", "quotation": "quotations"}
NOTIF_MODULE_ROUTE = {"emdbg": "/emdbg", "travel": "/travel", "tada": "/tada", "kam": "/kam", "approvals": "/approvals",
                      "workorders": "/workorders", "document_management": "/document-management", "alerts": "/alerts",
                      "letter_management": "/letter-management", "inbox": "/notifications/inbox", "sticky_notes": "/notes",
                      "calendar": "/calendar"}


def notification_record(db: Session, user: User, module: Optional[str], record_id: Optional[int]) -> Optional[dict[str, Any]]:
    key = (module or "").strip().lower()
    if key in NOTIF_MODULE_MAP and record_id:
        mod = NOTIF_MODULE_MAP[key]
        if mod == "leads":
            lead = db.query(Lead.lead_type, Lead.status).filter(Lead.id == int(record_id)).first()
            if lead and (lead.lead_type == "direct_opportunity" or lead.status in ("Opportunity Created", "Converted")):
                mod = "opportunities"
        rec = resolve_record(db, user, mod, record_id, check_access=False)
        if rec:
            return {"type": rec["type"], "ref": rec["ref"], "route": rec["route"]}
    if key in NOTIF_MODULE_ROUTE:
        label = {"emdbg": "Guarantee", "travel": "Travel", "tada": "Expense", "kam": "Activity", "approvals": "Approval",
                 "workorders": "Order", "document_management": "Document", "alerts": "Alert", "letter_management": "Letter",
                 "inbox": "Mail", "sticky_notes": "Note", "calendar": "Task"}[key]
        if key == "calendar":
            return {"type": "Task", "ref": f"#{record_id}" if record_id else "", "route": f"/calendar?task={record_id}" if record_id else "/calendar"}
        if key == "inbox":
            return {"type": "Open mail", "ref": "", "route": NOTIF_MODULE_ROUTE[key]}
        return {"type": label, "ref": f"#{record_id}" if record_id else "", "route": NOTIF_MODULE_ROUTE[key]}
    return None


# ─── Templates & AI draft ─────────────────────────────────────────────────────

def merge_template(body: str, record: Optional[dict[str, Any]], sender: User) -> str:
    r = record or {}
    values = {
        "contact": r.get("contact") or "Sir / Madam",
        "tender_no": r.get("tender_no") or "—",
        "title": r.get("title") or "the project",
        "value": r.get("value_label") or "—",
        "ref": r.get("ref") or "—",
        "sender": sender.full_name,
    }
    return re.sub(r"{{(\w+)}}", lambda m: str(values.get(m.group(1), m.group(0))), body or "")


def fallback_ai_draft(record: Optional[dict[str, Any]], sender: User) -> str:
    """Prototype mailAI() composition – used when the AI model is unavailable."""
    r = record or {}
    title = r.get("title")
    value = r.get("value_label") if r.get("value") else None
    return (f"Dear {r.get('contact') or 'Sir / Madam'},\n\nThank you for the discussion. Based on your priorities, I have summarised "
            f"the technical scope, delivery plan and commercial terms{' for ' + title if title else ''} in the attached proposal"
            f"{' (value ' + value + ')' if value else ''}. I would welcome 20 minutes this week to walk you through it.\n\n"
            f"Best regards,\n{sender.full_name}")


async def ai_draft(record: Optional[dict[str, Any]], subject: str, sender: User, context: str = "") -> tuple[str, str]:
    """Return (body, source) – source is 'ai' when the local model answered, else 'template'."""
    if getattr(settings, "OLLAMA_BASE_URL", None):
        try:
            from app.services.ollama_service import OllamaService
            r = record or {}
            facts = "\n".join(f"{k}: {v}" for k, v in {
                "Record": f"{r.get('type')} {r.get('ref')}" if r else None, "Title": r.get("title"), "Customer": r.get("customer"),
                "Contact": r.get("contact"), "Value": r.get("value_label") if r.get("value") else None, "Subject": subject or None,
            }.items() if v)
            previous = ("Previous message:\n" + context[:1200] + "\n") if context else ""
            prompt = ("Write a short, professional business e-mail body (no subject line) for a B2B sales team.\n"
                      + facts + "\n" + previous + f"Sign off as {sender.full_name}. Plain text only.")
            text = await OllamaService().chat(system_prompt="You draft concise, courteous B2B sales e-mails in Indian business English.",
                                              user_prompt=prompt)
            if text:
                return text.strip(), "ai"
        except Exception as exc:
            logger.info("AI draft fell back to template: %s", exc)
    return fallback_ai_draft(record, sender), "template"


# ─── Scheduling ───────────────────────────────────────────────────────────────

def resolve_schedule(option: Optional[str], custom: Optional[str] = None) -> Optional[datetime]:
    """Prototype options: 'Send now' | 'Tomorrow 09:00' | 'Monday 09:00' (or an ISO datetime)."""
    opt = (option or "").strip().lower()
    now = now_ist()
    if not opt or opt in ("send now", "now"):
        return None
    if opt.startswith("tomorrow"):
        return (now + timedelta(days=1)).replace(hour=9, minute=0, second=0, microsecond=0)
    if opt.startswith("monday"):
        days = (7 - now.weekday()) % 7 or 7
        return (now + timedelta(days=days)).replace(hour=9, minute=0, second=0, microsecond=0)
    try:
        return datetime.fromisoformat(custom or option or "").replace(tzinfo=None)
    except ValueError:
        return None


# ─── Delivery ─────────────────────────────────────────────────────────────────

def users_by_email(db: Session, emails: Iterable[str]) -> dict[str, User]:
    """Active colleague per address (first by id) – for display names and the internal flag."""
    return {k: v[0] for k, v in users_by_email_all(db, emails).items()}


def users_by_email_all(db: Session, emails: Iterable[str]) -> dict[str, list[User]]:
    """Every active user per address – some tenants have several user accounts sharing one e-mail."""
    lowered = {e.lower() for e in emails if e}
    if not lowered:
        return {}
    out: dict[str, list[User]] = {}
    for u in db.query(User).filter(func.lower(User.email).in_(lowered), User.is_active == True).order_by(User.id).all():
        out.setdefault(u.email.lower(), []).append(u)
    return out


def thread_for(db: Session, subject: str, reply_to: Optional[MailMessage]) -> MailThread:
    if reply_to and reply_to.thread_id:
        t = db.query(MailThread).filter(MailThread.id == reply_to.thread_id).first()
        if t:
            return t
    t = MailThread(subject=re.sub(r"^((re|fwd?):\s*)+", "", subject or "", flags=re.I)[:500], message_count=0)
    db.add(t)
    db.flush()
    return t


def _load_tenant(db: Session):
    from app.services.notification_service import _load_tenant_for_session
    return _load_tenant_for_session(db)


def tenant_mail_info(db: Session, user: User) -> dict[str, Any]:
    tenant = _load_tenant(db)
    smtp_ready = False
    domain = (user.email or "").split("@")[-1] if "@" in (user.email or "") else ""
    shared: list[dict[str, str]] = []
    if tenant is not None:
        from app.services.tenant_email_service import get_missing_tenant_smtp_fields
        smtp_ready = not get_missing_tenant_smtp_fields(tenant)
        company_from = (getattr(tenant, "from_email", None) or "").strip()
        if company_from and company_from.lower() != (user.email or "").lower():
            shared.append({"address": company_from, "label": f"{getattr(tenant, 'name', None) or 'Company'} <{company_from}> (shared)"})
    return {
        "address": user.email, "name": user.full_name, "domain": domain, "smtp_configured": smtp_ready,
        "mode": "Connected mailbox" if smtp_ready else "Built-in mail",
        "mailboxes": [{"address": user.email, "label": f"{user.full_name} <{user.email}>"}] + shared,
    }


def _tracking_url(db: Session, token: str, kind: str, target: str = "") -> str:
    from urllib.parse import quote
    base = (getattr(settings, "INBOX_TRACKING_BASE_URL", "") or f"{settings.FRONTEND_BASE_URL.rstrip('/')}/api/v1").rstrip("/")
    slug = quote(str(db.info.get("tenant_slug") or ""))
    if kind == "open":
        return f"{base}/inbox/track/open/{token}.gif?tenant={slug}"
    return f"{base}/inbox/track/click/{token}?tenant={slug}&u={quote(target, safe='')}"


def _html_body(db: Session, msg: MailMessage) -> str:
    text = html.escape(msg.body or "")
    if msg.track_opens and msg.tracking_token:
        text = re.sub(r"(https?://[^\s<]+)", lambda m: f'<a href="{_tracking_url(db, msg.tracking_token, "click", html.unescape(m.group(1)))}">{m.group(1)}</a>', text)
    body = f'<div style="font:14px/1.6 Arial,sans-serif;white-space:pre-wrap">{text}</div>'
    if msg.track_opens and msg.tracking_token:
        body += f'<img src="{_tracking_url(db, msg.tracking_token, "open")}" width="1" height="1" alt="" style="display:none">'
    return body


def _attachment_payloads(msg: MailMessage) -> list[tuple[str, bytes, str]]:
    import os
    from app.utils.file_storage import media_url_to_logical_path, open_stored_file
    out: list[tuple[str, bytes, str]] = []
    root = os.path.abspath(os.environ.get("MEDIA_ROOT", "media"))
    for a in msg.attachments:
        if not a.file_url:
            continue
        try:
            fh, _meta, _path = open_stored_file(media_url_to_logical_path(root_dir=root, file_url=a.file_url))
            with fh:
                data = fh.read()
            out.append((a.file_name, data, mimetypes.guess_type(a.file_name)[0] or "application/octet-stream"))
        except Exception as exc:
            logger.warning("Inbox attachment %s not readable: %s", a.file_url, exc)
    return out


def deliver(db: Session, msg: MailMessage, sender: User) -> dict[str, Any]:
    """Deliver a message whose sender copy is in Sent: internal copies to colleagues' Inbox,
    external recipients through the tenant SMTP server.  Returns a summary."""
    to = split_addresses(msg.to_emails)
    cc = split_addresses(msg.cc_emails)
    bcc = split_addresses(msg.bcc_emails)
    all_addrs = [extract_email(a) for a in to + cc + bcc]
    internal_all = users_by_email_all(db, all_addrs)
    internal = {k: v[0] for k, v in internal_all.items()}
    external_to = [extract_email(a) for a in to if extract_email(a).lower() not in internal]
    external_cc = [extract_email(a) for a in cc if extract_email(a).lower() not in internal]
    external_bcc = [extract_email(a) for a in bcc if extract_email(a).lower() not in internal]

    delivered_internal = 0
    from app.services.notification_service import upsert_notification
    bcc_set = {extract_email(b).lower() for b in bcc}
    delivered_to: set[int] = set()
    targets = [(addr, u) for addr in dict.fromkeys(a.lower() for a in all_addrs) for u in internal_all.get(addr, [])]
    for addr, u in targets:
        if u.id == sender.id or u.id in delivered_to:
            continue
        delivered_to.add(u.id)
        copy = MailMessage(
            thread_id=msg.thread_id, owner_user_id=u.id, folder="Inbox", sender_user_id=sender.id,
            from_email=msg.from_email, from_name=msg.from_name, from_mailbox=msg.from_mailbox,
            to_emails=msg.to_emails, cc_emails=msg.cc_emails,
            bcc_emails=msg.bcc_emails if addr in bcc_set else None,
            subject=msg.subject, body=msg.body, account_name=msg.account_name, is_read=False,
            is_internal=msg.is_internal, link_module=msg.link_module, link_record_id=msg.link_record_id,
            link_label=msg.link_label, in_reply_to_id=msg.in_reply_to_id, track_opens=False,
            sent_at=msg.sent_at, delivery_status="received", assigned_to_user_id=msg.assigned_to_user_id,
        )
        copy.attachments = [MailAttachment(document_key=a.document_key, file_name=a.file_name, file_url=a.file_url, size_kb=a.size_kb) for a in msg.attachments]
        copy.recipients = [MailRecipient(kind=r.kind, email=r.email, name=r.name, user_id=r.user_id) for r in msg.recipients if r.kind != "bcc" or r.email.lower() == addr]
        db.add(copy)
        db.flush()
        delivered_internal += 1
        upsert_notification(db, u.id, f"New mail from {sender.full_name}", msg.subject or "(no subject)",
                            module="inbox", record_id=copy.id, action="mail_received", send_email=False)

    result = {"internal": delivered_internal, "external": 0, "status": "internal", "error": None}
    if external_to or external_cc or external_bcc:
        tenant = _load_tenant(db)
        from app.services.tenant_email_service import (
            TenantEmailConfigurationError, TenantEmailDeliveryError, get_missing_tenant_smtp_fields, send_tenant_email,
        )
        if tenant is None or get_missing_tenant_smtp_fields(tenant):
            result.update(status="not_configured", error="External mail is not configured for your company (SMTP settings are missing).")
        else:
            # Header "To": the external To list; with only Cc/Bcc externals, the sender's own address
            # (colleagues already received their in-app copy above).
            header_to = ", ".join(external_to) if external_to else (msg.from_mailbox or sender.email)
            try:
                send_tenant_email(
                    tenant, header_to, msg.subject or "(no subject)", msg.body or "", _html_body(db, msg),
                    cc=external_cc, bcc=external_bcc,
                    reply_to=msg.from_mailbox or sender.email, attachments=_attachment_payloads(msg),
                )
                result.update(status="sent", external=len(external_to) + len(external_cc) + len(external_bcc))
            except (TenantEmailConfigurationError, TenantEmailDeliveryError) as exc:
                result.update(status="failed", error=str(exc)[:500])
    msg.delivery_status = result["status"]
    msg.delivery_error = result["error"]
    return result


def dispatch_due_scheduled(db: Session) -> int:
    """Send every Scheduled message whose time has come (lazy + background loop)."""
    due = (db.query(MailMessage)
           .filter(MailMessage.folder == "Scheduled", MailMessage.deleted_at.is_(None), MailMessage.scheduled_at <= now_ist())
           .limit(50).all())
    sent = 0
    for msg in due:
        sender = db.query(User).filter(User.id == msg.owner_user_id).first()
        if not sender:
            continue
        msg.folder = "Sent"
        msg.sent_at = now_ist()
        try:
            deliver(db, msg, sender)
            db.commit()
            sent += 1
        except Exception as exc:
            db.rollback()
            logger.warning("Scheduled mail %s failed: %s", msg.id, exc)
    return sent


def dispatch_scheduled_all_tenants() -> int:
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant
    master = MasterSessionLocal()
    try:
        slugs = [t.slug for t in master.query(Tenant).all()]
    finally:
        master.close()
    total = 0
    for slug in slugs:
        try:
            db = get_tenant_session(slug)
            try:
                db.info["tenant_slug"] = slug
                ensure_inbox_schema(db)
                total += dispatch_due_scheduled(db)
            finally:
                db.close()
        except Exception as exc:
            logger.debug("Scheduled mail dispatch skipped for %s: %s", slug, exc)
    return total


def new_tracking_token() -> str:
    return secrets.token_urlsafe(24)


# ─── Delivery preferences ─────────────────────────────────────────────────────
# Prototype v17 Notifications → Delivery preferences.
DELIVERY_PREFS = [
    {"key": "bid_deadlines", "label": "Bid deadlines", "channels": ["app", "email"], "digest_time": None},
    {"key": "approvals", "label": "Approvals", "channels": ["app", "email", "whatsapp"], "digest_time": None},
    {"key": "mentions", "label": "Mentions", "channels": ["app"], "digest_time": None},
    {"key": "daily_digest", "label": "Daily digest", "channels": ["email"], "digest_time": "08:00"},
]
CHANNEL_LABEL = {"app": "App", "email": "Email", "whatsapp": "WhatsApp"}


def pref_summary(channels: list[str], digest_time: Optional[str]) -> str:
    text = ", ".join(CHANNEL_LABEL.get(c, c.title()) for c in channels)
    if digest_time:
        h, m = (int(x) for x in digest_time.split(":"))
        text += f" · {((h % 12) or 12)}:{m:02d} {'AM' if h < 12 else 'PM'}"
    return text


def get_delivery_prefs(db: Session, user_id: int) -> list[dict[str, Any]]:
    rows = {r.pref_key: r for r in db.query(NotificationDeliveryPreference).filter(NotificationDeliveryPreference.user_id == user_id).all()}
    out = []
    for d in DELIVERY_PREFS:
        r = rows.get(d["key"])
        channels = (r.channels if r and r.channels else d["channels"])
        digest = (r.digest_time if r and r.digest_time else d["digest_time"])
        out.append({"key": d["key"], "label": d["label"], "enabled": bool(r.enabled) if r else True,
                    "channels": channels, "digest_time": digest, "summary": pref_summary(channels, digest)})
    return out


def is_pref_enabled(db: Session, user_id: int, pref_key: str) -> bool:
    """For delivery code: whether the user wants *pref_key* notifications (defaults to on)."""
    row = db.query(NotificationDeliveryPreference.enabled).filter(
        NotificationDeliveryPreference.user_id == user_id, NotificationDeliveryPreference.pref_key == pref_key).first()
    return True if row is None else bool(row[0])


# ─── Applying preferences to notifications ────────────────────────────────────

_DEADLINE_WORDS = ("deadline", "due", "submission", "closing", "expir", "bid date", "last date")


def pref_key_for_notification(module: Optional[str], action: Optional[str], title: str, message: str,
                              category: Optional[str] = None) -> Optional[str]:
    """Which Delivery preferences row governs a notification (None = not covered by a switch)."""
    text = f"{action or ''} {title or ''} {message or ''}".lower()
    if "mention" in text:
        return "mentions"
    if category == "approval":
        return "approvals"
    if (module or "").strip().lower() in ("tenders", "tender", "emdbg") and any(w in text for w in _DEADLINE_WORDS):
        return "bid_deadlines"
    return None


def delivery_channels_for(db: Session, user_id: int, *, module: Optional[str], action: Optional[str], title: str, message: str,
                          category: Optional[str] = None) -> tuple[bool, bool]:
    """(in-app, e-mail) delivery for one notification under the user's preferences; (True, True) when not covered."""
    key = pref_key_for_notification(module, action, title, message, category)
    if not key:
        return True, True
    spec = next(d for d in DELIVERY_PREFS if d["key"] == key)
    row = db.query(NotificationDeliveryPreference).filter(
        NotificationDeliveryPreference.user_id == user_id, NotificationDeliveryPreference.pref_key == key).first()
    if row is not None and not row.enabled:
        return False, False
    channels = row.channels if row is not None and row.channels else spec["channels"]
    return "app" in channels, "email" in channels


# ─── Daily digest (Delivery preferences → Daily digest · Email · 8:00 AM) ─────

DIGEST_WINDOW_MINUTES = 120   # sent within two hours of the chosen time – no late catch-up mail after a restart


def _digest_due(now: datetime, digest_time: Optional[str]) -> bool:
    try:
        h, m = (int(x) for x in (digest_time or "08:00").split(":"))
    except ValueError:
        h, m = 8, 0
    start = now.replace(hour=h, minute=m, second=0, microsecond=0)
    return start <= now < start + timedelta(minutes=DIGEST_WINDOW_MINUTES)


def build_digest(db: Session, user: User) -> Optional[tuple[str, str, str]]:
    """(subject, text, html) for one user, or None when nothing is unread."""
    from app.models.all_models import Notification
    unread = Notification.is_read == False  # noqa: E712
    notes = (db.query(Notification).filter(Notification.user_id == user.id, unread)
             .order_by(Notification.created_at.desc()).limit(15).all())
    n_unread = db.query(func.count(Notification.id)).filter(Notification.user_id == user.id, unread).scalar() or 0
    mail_unread = db.query(func.count(MailMessage.id)).filter(
        MailMessage.owner_user_id == user.id, MailMessage.folder == "Inbox", MailMessage.is_read == False,  # noqa: E712
        MailMessage.deleted_at.is_(None)).scalar() or 0
    if not n_unread and not mail_unread:
        return None
    url = f"{settings.FRONTEND_BASE_URL.rstrip('/')}/notifications"
    summary = (f"{n_unread} unread notification{'s' if n_unread != 1 else ''} · "
               f"{mail_unread} unread mail{'s' if mail_unread != 1 else ''}")
    lines = [(n.message or n.title or "").strip() for n in notes]
    text = (f"Good morning {user.full_name},\n\n{summary}\n\n" + "\n".join(f"• {x}" for x in lines)
            + f"\n\nOpen Inbox & Notifications: {url}\n")
    items = "".join(f"<li style='margin:4px 0'>{html.escape(x)}</li>" for x in lines)
    body = (f"<div style='font:14px/1.5 Arial,sans-serif;color:#16212D'><p>Good morning {html.escape(user.full_name)},</p>"
            f"<p><b>{html.escape(summary)}</b></p><ul style='padding-left:18px'>{items}</ul>"
            f"<p><a href='{html.escape(url)}' style='color:#0F6E8C'>Open Inbox &amp; Notifications</a></p></div>")
    return f"Your daily digest – {summary}", text, body


def send_daily_digests(db: Session) -> int:
    """Send today's digest to every active user whose digest is on and due. Returns how many were sent."""
    from app.services.notification_service import is_email_enabled_for_category
    from app.services.tenant_email_service import get_missing_tenant_smtp_fields, send_tenant_email
    tenant = _load_tenant(db)
    if tenant is None or get_missing_tenant_smtp_fields(tenant) or not is_email_enabled_for_category(db, "event"):
        return 0
    now = now_ist()
    today = now.date()
    spec = next(d for d in DELIVERY_PREFS if d["key"] == "daily_digest")
    rows = {r.user_id: r for r in db.query(NotificationDeliveryPreference)
            .filter(NotificationDeliveryPreference.pref_key == "daily_digest").all()}
    sent = 0
    for user in db.query(User).filter(User.is_active == True).all():  # noqa: E712
        row = rows.get(user.id)
        enabled = bool(row.enabled) if row else True
        channels = row.channels if row and row.channels else spec["channels"]
        if not enabled or "email" not in channels or (row and row.last_sent_on == today):
            continue
        if not _digest_due(now, row.digest_time if row and row.digest_time else spec["digest_time"]):
            continue
        if row is None:
            row = NotificationDeliveryPreference(user_id=user.id, pref_key="daily_digest", enabled=True,
                                                 channels=list(spec["channels"]), digest_time=spec["digest_time"])
            db.add(row)
        row.last_sent_on = today            # once a day, even when there is nothing to report
        digest = build_digest(db, user)
        if digest and user.email:
            try:
                send_tenant_email(tenant, user.email, digest[0], digest[1], digest[2])
                sent += 1
            except Exception as exc:
                logger.warning("Daily digest to user %s failed: %s", user.id, exc)
        db.commit()
    return sent


def send_daily_digests_all_tenants() -> int:
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant
    master = MasterSessionLocal()
    try:
        slugs = [t.slug for t in master.query(Tenant).all()]
    finally:
        master.close()
    total = 0
    for slug in slugs:
        try:
            db = get_tenant_session(slug)
            try:
                db.info["tenant_slug"] = slug
                ensure_inbox_schema(db)
                total += send_daily_digests(db)
            finally:
                db.close()
        except Exception as exc:
            logger.debug("Daily digest skipped for %s: %s", slug, exc)
    return total
