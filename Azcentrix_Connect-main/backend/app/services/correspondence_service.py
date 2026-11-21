"""Correspondence (prototype v17 R.letters): Register · Templates · Compose · Campaigns · Sequences · Mailbox setup.
Mail itself is the Inbox module (reused by the page).  Letters / templates keep the existing /letters endpoints; this
service adds the prototype register (one paginated SELECT with the creator and template joined), the merge data for the
live preview, campaigns, sequences with enrolments, and the mailbox-setup flags.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, aliased

from app.core.timezone import now_ist
from app.models.all_models import Customer, Lead, LeadSource, Letter, LetterTemplate, Setting, Tender, User, VerticalSector
from app.models.correspondence import CORRESPONDENCE_TABLES, MailCampaign, MailSequence, MailSequenceEnrolment

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()

MERGE_FIELDS = ["customer", "tender_no", "title", "value", "emd", "date", "ref_no", "signatory"]
MBX_KEYS = ("google", "ms", "imap", "spf", "dkim", "dmarc")
DEFAULT_SEQUENCES = [
    ("New bid enquiry cadence", [{"day": 0, "kind": "Email", "text": "acknowledgement"}, {"day": 2, "kind": "Task", "text": "call buyer"}, {"day": 5, "kind": "Email", "text": "share references"}, {"day": 9, "kind": "Task", "text": "pre-bid review"}]),
    ("Quotation follow-up", [{"day": 3, "kind": "Email", "text": "gentle nudge"}, {"day": 6, "kind": "Task", "text": "call"}, {"day": 10, "kind": "Email", "text": "revised offer"}]),
    ("Post-order care", [{"day": 7, "kind": "Email", "text": "kick-off"}, {"day": 30, "kind": "Task", "text": "review"}, {"day": 90, "kind": "Email", "text": "AMC offer"}]),
]


def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        bind = db.get_bind()
        for t in CORRESPONDENCE_TABLES:
            t.create(bind=bind, checkfirst=True)
        db.commit()
        if not db.query(MailSequence.id).first():
            for n, steps in DEFAULT_SEQUENCES:
                db.add(MailSequence(name=n, steps=steps, is_active=True))
            db.commit()
        _READY.add(slug)


def ensure_schema_all_tenants() -> None:
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant
    master = MasterSessionLocal()
    try:
        slugs = [t.slug for t in master.query(Tenant.slug).all()]
    except Exception as exc:  # pragma: no cover
        logger.warning("Correspondence schema sync: unable to list tenants: %s", exc)
        return
    finally:
        master.close()
    for slug in slugs:
        try:
            db = get_tenant_session(slug)
            try:
                db.info["tenant_slug"] = slug
                ensure_schema(db)
            finally:
                db.close()
        except Exception as exc:
            logger.warning("Correspondence schema sync failed for %s: %s", slug, exc)


def _like(s: str) -> str:
    return "%" + s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _d(v) -> Optional[str]:
    return v.isoformat() if v else None


def _inr(v) -> str:
    v = float(v or 0)
    if v >= 1e7:
        return f"₹{v / 1e7:.2f} Cr"
    if v >= 1e5:
        return f"₹{v / 1e5:.2f} L"
    return f"₹{v:,.0f}"


# ─── register ─────────────────────────────────────────────────────────────────

def register(db: Session, *, q: str, status: str, offset: int, limit: int) -> dict:
    By = aliased(User)
    base = db.query(Letter, By.full_name, LetterTemplate.name).outerjoin(By, By.id == Letter.created_by).outerjoin(LetterTemplate, LetterTemplate.id == Letter.letter_template_id) \
        .filter(Letter.is_deleted.is_(False))
    if status == "Draft":
        base = base.filter(Letter.status == "Draft")
    elif status == "Dispatched":
        base = base.filter(Letter.status != "Draft")
    if q:
        base = base.filter(or_(Letter.letter_no.ilike(_like(q)), Letter.title.ilike(_like(q)), Letter.recipient_name.ilike(_like(q)), Letter.linked_record_label.ilike(_like(q))))
    total = base.with_entities(func.count(Letter.id)).order_by(None).scalar() or 0
    counts = dict(db.query(func.if_(Letter.status == "Draft", "Draft", "Dispatched"), func.count(Letter.id)).filter(Letter.is_deleted.is_(False)).group_by(func.if_(Letter.status == "Draft", "Draft", "Dispatched")).all())
    rows = base.order_by(Letter.created_at.desc(), Letter.id.desc()).offset(offset).limit(limit).all()
    items = [{"id": l.id, "ref": l.letter_no or f"LTR-{l.id}", "tpl": tpl or l.title, "title": l.title, "to": l.recipient_name or "—", "against": l.linked_record_label or "—",
              "link_source": l.linked_source, "link_id": l.linked_record_id, "date": _d(l.issue_date) or _d(l.created_at), "by": by or "—",
              "status": "Draft" if l.status == "Draft" else "Dispatched", "raw_status": l.status} for l, by, tpl in rows]
    return {"items": items, "total": int(total), "counts": {"Draft": int(counts.get("Draft", 0)), "Dispatched": int(counts.get("Dispatched", 0))}}


# ─── compose helpers ──────────────────────────────────────────────────────────

def tenders(db: Session, q: str) -> list[dict]:
    base = db.query(Tender.id, Tender.tender_title, Tender.customer_name, Tender.tender_num, Tender.portal_ref_number)
    if q:
        base = base.filter(or_(Tender.tender_title.ilike(_like(q)), Tender.customer_name.ilike(_like(q)), Tender.tender_num.ilike(_like(q))))
    return [{"id": i, "title": t or f"Tender #{i}", "customer": c or "", "no": n or p or ""} for i, t, c, n, p in base.order_by(Tender.id.desc()).limit(50).all()]


def merge_data(db: Session, cu: User, tender_id: Optional[int]) -> dict:
    next_no = (db.query(func.max(Letter.id)).scalar() or 0) + 1
    out = {"customer": "", "tender_no": "", "title": "", "value": "", "emd": "", "date": now_ist().strftime("%d %b %Y"), "ref_no": f"LTR-{datetime.now().year}-{next_no:05d}",
           "signatory": f"{cu.full_name}, {cu.designation or cu.role or ''}".rstrip(", "), "fields": MERGE_FIELDS}
    if tender_id:
        t = db.get(Tender, tender_id)
        if t:
            out.update({"customer": t.customer_name or "", "tender_no": t.tender_num or t.portal_ref_number or "", "title": t.tender_title or "", "value": _inr(t.est_value), "emd": _inr(t.emd_amount),
                        "customer_id": t.customer_id, "label": f"{t.tender_num or t.portal_ref_number or ('Tender #' + str(t.id))} – {t.customer_name or ''}"})
    return out


# ─── campaigns ────────────────────────────────────────────────────────────────

def audiences(db: Session) -> list[dict]:
    out = [{"k": "customers:all", "l": "Customers · all active"}]
    for (n,) in db.query(VerticalSector.name).filter(VerticalSector.is_active.is_(True)).order_by(VerticalSector.display_order, VerticalSector.name).limit(20).all():
        out.append({"k": f"customers:vertical:{n}", "l": f"Customers · {n} vertical"})
    out.append({"k": "leads:open", "l": "Leads · open"})
    for (i, n) in db.query(LeadSource.id, LeadSource.name).filter(LeadSource.is_active.is_(True)).order_by(LeadSource.name).limit(20).all():
        out.append({"k": f"leads:source:{i}", "l": f"Leads · {n} source"})
    out.append({"k": "leads:stale", "l": "Leads · open, not touched in 14 days"})
    return out


def _audience_count(db: Session, key: str) -> int:
    parts = key.split(":")
    if parts[0] == "customers":
        q = db.query(func.count(Customer.id)).filter(Customer.is_deleted.is_(False), Customer.is_active.is_(True))
        if len(parts) == 3 and parts[1] == "vertical":
            q = q.filter(Customer.customer_vertical == parts[2])
        return int(q.scalar() or 0)
    q = db.query(func.count(Lead.id)).filter(Lead.is_deleted.is_(False), Lead.email.isnot(None), Lead.email != "")
    if len(parts) == 3 and parts[1] == "source" and parts[2].isdigit():
        q = q.filter(Lead.source_id == int(parts[2]))
    if parts[-1] == "open" or parts[-1] == "stale":
        q = q.filter(Lead.status.in_(("Assigned", "Contacted", "Qualified", "Proposal Pending", "Nurturing")))
    return int(q.scalar() or 0)


def campaigns(db: Session) -> list[dict]:
    rows = db.query(MailCampaign, User.full_name).outerjoin(User, User.id == MailCampaign.created_by).order_by(MailCampaign.created_at.desc()).limit(200).all()
    return [{"id": c.id, "n": c.name, "aud": c.audience_label, "tpl": c.template_name or (c.subject_a or "—"), "st": c.status, "sent": c.sent, "open": round(c.opened / c.sent * 100) if c.sent else 0,
             "click": round(c.clicked / c.sent * 100) if c.sent else 0, "reply": round(c.replies / c.sent * 100) if c.sent else 0, "leads": c.leads,
             "at": _d(c.sent_at or c.send_at or c.created_at), "by": n or "—", "recipients": c.recipients} for c, n in rows]


def create_campaign(db: Session, cu: User, d: dict) -> int:
    name = str(d.get("name") or "").strip()[:200]
    if not name:
        raise HTTPException(422, "Name the campaign")
    aud = str(d.get("audience") or "")
    labels = {a["k"]: a["l"] for a in audiences(db)}
    if aud not in labels:
        raise HTTPException(422, "Choose an audience")
    tpl_id = d.get("template_id")
    tpl = db.get(LetterTemplate, int(tpl_id)) if tpl_id else None
    when = str(d.get("send") or "now")
    send_at = now_ist()
    if when == "tomorrow":
        send_at = send_at.replace(hour=9, minute=0, second=0, microsecond=0) + __import__("datetime").timedelta(days=1)
    elif when == "monday":
        send_at = send_at.replace(hour=9, minute=0, second=0, microsecond=0) + __import__("datetime").timedelta(days=(7 - send_at.weekday()) % 7 or 7)
    c = MailCampaign(name=name, audience=aud, audience_label=labels[aud], template_id=tpl.id if tpl else None, template_name=tpl.name if tpl else None,
                     subject_a=str(d.get("subject_a") or "")[:300] or None, subject_b=str(d.get("subject_b") or "")[:300] or None, status="Scheduled", send_at=send_at,
                     recipients=_audience_count(db, aud), create_lead_on_reply=bool(d.get("create_lead", True)), created_by=cu.id)
    db.add(c)
    db.commit()
    if when == "now":
        send_campaign(db, cu, c.id)
    return c.id


def send_campaign(db: Session, cu: User, cid: int) -> dict:
    c = db.get(MailCampaign, cid)
    if c is None:
        raise HTTPException(404, "Campaign not found")
    if c.status == "Sent":
        raise HTTPException(409, "Already sent")
    c.recipients = _audience_count(db, c.audience)
    c.sent, c.status, c.sent_at = c.recipients, "Sent", now_ist()
    db.commit()
    return {"sent": c.sent}


# ─── sequences ────────────────────────────────────────────────────────────────

def sequences(db: Session) -> list[dict]:
    counts = dict(db.query(MailSequenceEnrolment.sequence_id, func.count(MailSequenceEnrolment.id)).group_by(MailSequenceEnrolment.sequence_id).all())
    return [{"id": s.id, "n": s.name, "steps": s.steps or [], "enrolled": int(counts.get(s.id, 0))} for s in db.query(MailSequence).filter(MailSequence.is_active.is_(True)).order_by(MailSequence.id).all()]


def create_sequence(db: Session, cu: User, name: str, steps: list[dict]) -> int:
    name = (name or "").strip()[:200]
    if not name:
        raise HTTPException(422, "Name the sequence")
    clean = []
    for s in steps[:30]:
        try:
            day = max(0, int(s.get("day") or 0))
        except (TypeError, ValueError):
            raise HTTPException(422, "Step days must be numbers")
        kind = "Task" if str(s.get("kind") or "").lower().startswith("t") else "Email"
        txt = str(s.get("text") or "").strip()[:200]
        if txt:
            clean.append({"day": day, "kind": kind, "text": txt})
    if not clean:
        raise HTTPException(422, "Add at least one step")
    if db.query(MailSequence.id).filter(func.lower(MailSequence.name) == name.lower()).first():
        raise HTTPException(409, "A sequence with this name exists")
    s = MailSequence(name=name, steps=clean, is_active=True, created_by=cu.id)
    db.add(s)
    db.commit()
    return s.id


def enrol(db: Session, cu: User, sid: int, module: str, scope: str) -> int:
    s = db.get(MailSequence, sid)
    if s is None or not s.is_active:
        raise HTTPException(404, "Sequence not found")
    if module == "leads":
        q = db.query(Lead.id).filter(Lead.is_deleted.is_(False))
        if scope == "open":
            q = q.filter(Lead.status.in_(("Assigned", "Contacted", "Qualified", "Proposal Pending", "Nurturing")))
    elif module == "customers":
        q = db.query(Customer.id).filter(Customer.is_deleted.is_(False), Customer.is_active.is_(True))
    else:
        raise HTTPException(422, "Enrol leads or customers")
    ids = [i for (i,) in q.limit(5000).all()]
    have = {r for (r,) in db.query(MailSequenceEnrolment.record_id).filter(MailSequenceEnrolment.sequence_id == sid, MailSequenceEnrolment.module == module).all()}
    new = [MailSequenceEnrolment(sequence_id=sid, module=module, record_id=i, enrolled_by=cu.id) for i in ids if i not in have]
    db.add_all(new)
    db.commit()
    return len(new)


# ─── mailbox setup ────────────────────────────────────────────────────────────

def mailbox_flags(db: Session) -> dict[str, bool]:
    rows = db.query(Setting.key, Setting.value).filter(Setting.key.in_([f"mail.{k}" for k in MBX_KEYS])).all()
    got = {k.split(".", 1)[1]: str(v or "").lower() == "true" for k, v in rows}
    return {k: got.get(k, False) for k in MBX_KEYS}


def _dns_txt(name: str) -> list[str]:
    try:
        import dns.resolver  # type: ignore
        return ["".join(s.decode() if isinstance(s, bytes) else str(s) for s in r.strings) for r in dns.resolver.resolve(name, "TXT")]
    except Exception:
        return []


def set_mailbox_flag(db: Session, cu: User, key: str, value: bool, domain: str) -> dict:
    if key not in MBX_KEYS:
        raise HTTPException(422, "Unknown setting")
    note = ""
    if key in ("spf", "dkim", "dmarc") and value:
        name = {"spf": domain, "dkim": f"bidwise._domainkey.{domain}", "dmarc": f"_dmarc.{domain}"}[key]
        txt = _dns_txt(name) if domain else []
        ok = any(("v=spf1" in t) if key == "spf" else ("v=DKIM1" in t) if key == "dkim" else ("v=DMARC1" in t) for t in txt)
        if not ok:
            raise HTTPException(409, f"No {key.upper()} record found at {name}. Add the DNS TXT record and verify again.")
        note = "Verified from DNS"
    row = db.query(Setting).filter(Setting.key == f"mail.{key}").first()
    if row is None:
        db.add(Setting(key=f"mail.{key}", value="true" if value else "false", type="boolean", category="mail", updated_by=cu.id))
    else:
        row.value, row.updated_by = ("true" if value else "false"), cu.id
    db.commit()
    return {"key": key, "value": value, "note": note}
