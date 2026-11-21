"""Support Desk (Governance): tenant support tickets and broadcast announcements.

Tickets live in the platform database; each one belongs to the tenant it was raised from (the tenant is taken from the
signed-in request, never from the request body). A ticket has a reply thread (platform staff and the tenant); the first
staff reply is its first response and resolving closes it, which drives its SLA clock and CSAT request (platform_sla).
The requester is e-mailed staff replies and the resolution (with a rating link) through the tenant's own SMTP. Announcements are delivered with the existing in-app announcement
service (a notification per recipient in each tenant's own database) and recorded centrally with what they reached.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app.database import master_engine
from app.models.platform_support import PlatformAnnouncement, PlatformAnnouncementRead, PlatformAnnouncementTenant, PlatformSupportTicket
from app.models.tenant import Tenant
from app.services import tenant_hierarchy

logger = logging.getLogger(__name__)

PRIORITIES = ("Critical", "High", "Medium", "Low")   # Critical = P1, High = P2, Medium / Low = P3 (platform_sla)
AUDIENCES = {"all": "All tenants", "admins": "Tenant admins only", "groups": "Parent groups"}
ADMIN_ROLES = ["admin"]
_ready: dict[str, bool] = {}


def ensure_schema() -> None:
    if not _ready.get("schema"):
        for model in (PlatformSupportTicket, PlatformAnnouncement, PlatformAnnouncementTenant, PlatformAnnouncementRead):
            model.__table__.create(bind=master_engine, checkfirst=True)
        # Announcements & maintenance columns on an existing platform_announcements table.
        columns = {c["name"] for c in inspect(master_engine).get_columns("platform_announcements")}
        wanted = [
            ("kind", "ADD COLUMN kind VARCHAR(15) NULL"),
            ("expires_on", "ADD COLUMN expires_on DATE NULL"),
            ("published_by_id", "ADD COLUMN published_by_id INT NULL"),
            ("change_id", "ADD COLUMN change_id INT NULL"),
        ]
        missing = [sql for name, sql in wanted if name not in columns]
        if missing:
            indexes = {i["name"] for i in inspect(master_engine).get_indexes("platform_announcements")}
            if "ix_platform_announcements_kind_expiry" not in indexes:
                missing.append("ADD INDEX ix_platform_announcements_kind_expiry (kind, expires_on)")
            with master_engine.begin() as conn:
                conn.execute(text("ALTER TABLE platform_announcements " + ", ".join(missing)))
            logger.info("Announcements: added %d column(s) to platform_announcements", len(missing))
        from app.services import platform_sla   # SLA clocks, replies and ratings reference the tickets table
        platform_sla.ensure_schema()
        _ready["schema"] = True


class SupportError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def _utc(value: Optional[datetime]) -> Optional[str]:
    return f"{value.replace(microsecond=0).isoformat()}Z" if value else None


# ─── Tickets ─────────────────────────────────────────────────────────────────

def raise_ticket(db: Session, tenant: Tenant, user, subject: str, description: str, priority: str) -> PlatformSupportTicket:
    ensure_schema()
    subject, description = (subject or "").strip(), (description or "").strip()
    if not subject:
        raise SupportError("Enter a subject", 422)
    if priority not in PRIORITIES:
        raise SupportError("Priority must be Critical, High, Medium or Low", 422)
    ticket = PlatformSupportTicket(ref=f"TMP-{datetime.utcnow().timestamp()}", tenant_id=tenant.id, user_id=getattr(user, "id", None),
                                   requester_name=getattr(user, "full_name", None), requester_email=getattr(user, "email", None),
                                   subject=subject[:300], description=description[:10000] or None, priority=priority, status="open",
                                   created_at=datetime.utcnow())
    db.add(ticket)
    db.flush()
    ticket.ref = f"SUP-{ticket.id:04d}"
    from app.services import platform_sla
    platform_sla.start(db, ticket, tenant)
    return ticket


def ticket_dict(t: PlatformSupportTicket, tenant_name: Optional[str] = None) -> dict:
    return {"id": t.id, "ref": t.ref, "tenant_id": t.tenant_id, "tenant": tenant_name, "subject": t.subject, "priority": t.priority,
            "status": t.status, "requester": t.requester_name, "created_at": _utc(t.created_at), "closed_at": _utc(t.closed_at)}


def open_tickets(db: Session, allowed: Optional[list[int]], offset: int, limit: int) -> dict:
    """Open tickets, oldest first (the longest waiting at the top), with the tenant name joined in one query."""
    ensure_schema()
    q = db.query(PlatformSupportTicket, Tenant.name).join(Tenant, Tenant.id == PlatformSupportTicket.tenant_id) \
        .filter(PlatformSupportTicket.status == "open")
    if allowed is not None:
        q = q.filter(PlatformSupportTicket.tenant_id.in_(allowed or [0]))
    total = q.order_by(None).count()
    rows = q.order_by(PlatformSupportTicket.created_at, PlatformSupportTicket.id).offset(offset).limit(limit).all()
    from app.services import platform_sla
    slas = platform_sla.ticket_slas(db, [t.id for t, _ in rows])
    return {"items": [{**ticket_dict(t, name), "sla": slas.get(t.id)} for t, name in rows], "total": total, "offset": offset, "limit": limit}


def tenant_tickets(db: Session, tenant_id: int, user_id: Optional[int], limit: int = 50) -> list[dict]:
    ensure_schema()
    q = db.query(PlatformSupportTicket).filter(PlatformSupportTicket.tenant_id == tenant_id)
    if user_id is not None:
        q = q.filter(PlatformSupportTicket.user_id == user_id)
    return [ticket_dict(t) for t in q.order_by(PlatformSupportTicket.created_at.desc()).limit(limit).all()]


def get_ticket(db: Session, ticket_id: int, allowed: Optional[list[int]] = None) -> PlatformSupportTicket:
    ensure_schema()
    t = db.get(PlatformSupportTicket, ticket_id)
    if t is None or (allowed is not None and t.tenant_id not in allowed):
        raise SupportError("Ticket not found", 404)
    return t


def ticket_detail(db: Session, t: PlatformSupportTicket) -> dict:
    from app.models.platform_sla import PlatformTicketCsat, PlatformTicketReply
    from app.services import platform_sla
    tenant = db.get(Tenant, t.tenant_id)
    replies = db.query(PlatformTicketReply).filter(PlatformTicketReply.ticket_id == t.id).order_by(PlatformTicketReply.created_at, PlatformTicketReply.id).all()
    csat = db.query(PlatformTicketCsat).filter(PlatformTicketCsat.ticket_id == t.id).first()
    return {**ticket_dict(t, tenant.name if tenant else None), "description": t.description, "requester_email": t.requester_email,
            "replies": [{"id": r.id, "kind": r.author_kind, "author": r.author_name, "body": r.body, "at": _utc(r.created_at)} for r in replies],
            "sla": platform_sla.ticket_sla(db, t.id), "csat": platform_sla.csat_dict(csat)}


def _notify(db: Session, t: PlatformSupportTicket, subject: str, text_body: str) -> str:
    """E-mail the requester through the tenant's SMTP: "sent", "no e-mail" or the reason it failed."""
    if not t.requester_email:
        return "no e-mail"
    from app.services.tenant_email_service import send_tenant_email
    tenant = db.get(Tenant, t.tenant_id)
    try:
        send_tenant_email(tenant, t.requester_email, subject, text_body)
        return "sent"
    except Exception as exc:  # noqa: BLE001 – the reply is saved either way; the caller reports the e-mail outcome
        logger.warning("Support e-mail for %s not sent: %s", t.ref, exc)
        return str(exc)[:200] or type(exc).__name__


def add_reply(db: Session, t: PlatformSupportTicket, kind: str, author: str, email: Optional[str], body: str) -> dict:
    from app.models.platform_sla import PlatformTicketReply
    from app.services import platform_sla
    body = (body or "").strip()
    if not body:
        raise SupportError("Write a reply", 422)
    now = datetime.utcnow()
    reply = PlatformTicketReply(ticket_id=t.id, author_kind=kind, author_name=(author or "")[:200] or None, author_email=(email or "")[:200] or None,
                                body=body[:10000], created_at=now)
    db.add(reply)
    reopened = False
    if kind == "staff":
        platform_sla.first_response(db, t, now)
    elif t.status == "closed":      # the tenant answering a resolved ticket reopens it
        reopen(db, t)
        reopened = True
    db.flush()
    mail = _notify(db, t, f"[{t.ref}] New reply: {t.subject[:120]}", f"{author or 'The support team'} replied to your ticket {t.ref}:\n\n{body}") \
        if kind == "staff" else None
    return {"id": reply.id, "email": mail, "reopened": reopened}


def resolve(db: Session, t: PlatformSupportTicket, actor: str) -> dict:
    from app.services import platform_sla
    from app.core.config import settings
    if t.status == "closed":
        raise SupportError(f"{t.ref} is already resolved", 409)
    now = datetime.utcnow()
    t.status, t.closed_at = "closed", now
    token = platform_sla.resolved(db, t, now)
    db.flush()
    link = f"{(settings.FRONTEND_BASE_URL or '').rstrip('/')}/csat/{token}" if token and settings.FRONTEND_BASE_URL else None
    text_body = f"Your ticket {t.ref} – {t.subject} – has been resolved by {actor}."
    if link:
        text_body += f"\n\nHow did we do? Rate the support you received (1–5): {link}\nThe link works once and expires in {platform_sla.CSAT_LINK_DAYS} days."
    text_body += "\n\nIf the problem isn't fixed, reply to the ticket in the app to reopen it."
    return {"email": _notify(db, t, f"[{t.ref}] Resolved: {t.subject[:120]}", text_body), "rating_link": bool(link)}


def reopen(db: Session, t: PlatformSupportTicket) -> None:
    from app.services import platform_sla
    if t.status != "closed":
        raise SupportError(f"{t.ref} is open", 409)
    t.status, t.closed_at = "open", None
    platform_sla.reopened(db, t)


# ─── Announcements ───────────────────────────────────────────────────────────

def _targets(db: Session, audience: str, allowed: Optional[list[int]]) -> tuple[list[Tenant], str, Optional[list[str]]]:
    q = db.query(Tenant).filter(Tenant.status != "cancelled")
    if allowed is not None:
        q = q.filter(Tenant.id.in_(allowed or [0]))
    if audience in ("all", "admins"):
        return q.order_by(Tenant.name).all(), AUDIENCES[audience], (ADMIN_ROLES if audience == "admins" else None)
    if audience == "groups":
        return q.filter(Tenant.parent_group_id.isnot(None)).order_by(Tenant.name).all(), AUDIENCES[audience], None
    if audience.startswith("tenant:"):
        try:
            tenant_id = int(audience.split(":", 1)[1])
        except ValueError:
            raise SupportError("Unknown audience", 422)
        tenant = q.filter(Tenant.id == tenant_id).first()
        if tenant is None:
            raise SupportError("Tenant not found", 404)
        return [tenant], tenant.name, None
    raise SupportError("Unknown audience", 422)


def broadcast(db: Session, audience: str, title: str, message: str, allowed: Optional[list[int]], actor: str) -> PlatformAnnouncement:
    """Deliver to every target tenant (one tenant database each); unreachable tenants are reported, not hidden."""
    ensure_schema()
    title, message = (title or "").strip(), (message or "").strip()
    if not title or not message:
        raise SupportError("Enter a title and a message", 422)
    tenants, label, roles = _targets(db, audience, allowed)
    if not tenants:
        raise SupportError(f"No tenants match “{label}”", 409)
    recipients, reached, failed = 0, [], []
    for tenant in tenants:
        try:
            recipients += tenant_hierarchy.send_announcement(tenant, title[:200], message, roles)
            reached.append(tenant.id)
        except Exception as exc:  # noqa: BLE001 - one unreachable tenant database must not stop the others
            logger.warning("Announcement to %s failed: %s", tenant.slug, exc)
            failed.append({"tenant_id": tenant.id, "tenant": tenant.name, "error": str(exc)[:200]})
    if not reached:
        raise SupportError(f"Not delivered – no tenant database could be reached ({', '.join(f['tenant'] for f in failed)})", 502)
    row = PlatformAnnouncement(title=title[:200], message=message, audience=audience.split(":")[0], audience_label=label[:250],
                               tenant_ids=reached, recipients=recipients, failed=failed or None, sent_by=actor, sent_at=datetime.utcnow())
    db.add(row)
    db.flush()
    return row


def announcement_dict(a: PlatformAnnouncement) -> dict:
    return {"id": a.id, "title": a.title, "audience": a.audience, "audience_label": a.audience_label, "recipients": a.recipients,
            "tenants": len(a.tenant_ids or []), "failed": a.failed or [], "sent_by": a.sent_by, "sent_at": _utc(a.sent_at)}


def announcements(db: Session, allowed: Optional[list[int]], limit: int = 20) -> list[dict]:
    """Latest announcements; tenant-scoped staff see only those sent entirely within their tenants."""
    ensure_schema()
    rows = db.query(PlatformAnnouncement).order_by(PlatformAnnouncement.sent_at.desc(), PlatformAnnouncement.id.desc()).limit(limit * 5 if allowed is not None else limit).all()
    if allowed is not None:
        scope = set(allowed)
        rows = [a for a in rows if set(a.tenant_ids or []) <= scope][:limit]
    return [announcement_dict(a) for a in rows]
