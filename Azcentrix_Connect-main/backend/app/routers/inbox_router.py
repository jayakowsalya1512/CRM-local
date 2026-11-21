"""Inbox (prototype v17 → Application → Inbox & Notifications → Inbox).

Mounted at /api/v1/inbox.  Every query is scoped to the signed-in user's own mailbox copies
(owner_user_id) inside the tenant database; access to the module follows notifications.view.
"""
from __future__ import annotations

import base64
import logging
from datetime import timedelta
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session

from app.core.logging import log_audit_db
from app.core.timezone import now_ist
from app.dependencies import get_current_user, get_request_ip, get_tenant_db, user_has_permission
from app.models.all_models import Customer, CustomerContact, KAMActivity, StickyNote, User
from app.models.inbox import MailAttachment, MailMessage, MailRecipient, MailTemplate, MailThread
from app.services import inbox_service as svc
from app.services.cache_service import invalidate_badges_cache, invalidate_notifications_cache

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Inbox"])

FOLDERS = ["Inbox", "Starred", "Sent", "Drafts", "Scheduled", "Archive", "Trash"]
MOVABLE = {"Inbox", "Archive", "Trash"}
_GIF = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")


# ─── Dependencies & helpers ───────────────────────────────────────────────────

def inbox_user(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if not user_has_permission(db, cu, "notifications.view"):
        raise HTTPException(403, "You don't have access to Inbox & Notifications")
    svc.ensure_inbox_schema(db)
    try:
        svc.dispatch_due_scheduled(db)       # scheduled mail also goes out lazily on activity
    except Exception as exc:  # never block the mailbox on a delivery problem
        db.rollback()
        logger.warning("Lazy scheduled dispatch failed: %s", exc)
    return cu


def _own(db: Session, cu: User, message_id: int) -> MailMessage:
    m = db.query(MailMessage).filter(MailMessage.id == message_id, MailMessage.owner_user_id == cu.id,
                                     MailMessage.deleted_at.is_(None)).first()
    if not m:
        raise HTTPException(404, "Message not found")
    return m


def _audit(db: Session, request: Request, cu: User, action: str, m: Optional[MailMessage], description: str) -> None:
    log_audit_db(db, cu.id, "inbox", action, m.id if m else None, get_request_ip(request), description,
                 record_name=(m.subject[:200] if m and m.subject else None))


def _when(m: MailMessage):
    return m.scheduled_at if m.folder == "Scheduled" else (m.sent_at or m.created_at)


def _link(m: MailMessage) -> Optional[dict[str, Any]]:
    if not m.link_module or not m.link_record_id:
        return None
    return {"module": m.link_module, "id": m.link_record_id, "ref": m.link_label or f"#{m.link_record_id}",
            "type": svc.RECORD_LABEL.get(m.link_module, m.link_module), "route": svc.record_route(m.link_module, m.link_record_id)}


def _item(m: MailMessage) -> dict[str, Any]:
    return {
        "id": m.id, "folder": m.folder, "from_name": m.from_name or m.from_email, "from_email": m.from_email,
        "to": m.to_emails or "", "cc": m.cc_emails or "", "subject": m.subject or "(no subject)",
        "preview": " ".join((m.body or "").split())[:120], "is_read": bool(m.is_read), "is_starred": bool(m.is_starred),
        "is_internal": bool(m.is_internal), "attachments": len(m.attachments), "link": _link(m),
        "account": m.account_name, "time": svc.iso(_when(m)), "scheduled_at": svc.iso(m.scheduled_at),
        "delivery_status": m.delivery_status, "thread_id": m.thread_id,
    }


def _is_customer(db: Session, name: Optional[str]) -> bool:
    return bool(name) and db.query(Customer.id).filter(func.lower(Customer.customer_name) == name.lower()).first() is not None


def _detail(db: Session, cu: User, m: MailMessage) -> dict[str, Any]:
    d = _item(m)
    thread = []
    if m.thread_id:
        rows = (db.query(MailMessage).filter(MailMessage.thread_id == m.thread_id, MailMessage.owner_user_id == cu.id,
                                             MailMessage.deleted_at.is_(None), MailMessage.id != m.id,
                                             MailMessage.folder != "Drafts")
                .order_by(func.coalesce(MailMessage.sent_at, MailMessage.created_at).asc()).all())
        thread = [{"id": t.id, "from_name": t.from_name or t.from_email, "time": svc.iso(_when(t)),
                   "preview": " ".join((t.body or "").split())[:160], "folder": t.folder} for t in rows]
    record = svc.resolve_record(db, cu, m.link_module, m.link_record_id) if m.link_module else None
    assignee = db.query(User.full_name).filter(User.id == m.assigned_to_user_id).scalar() if m.assigned_to_user_id else None
    d.update({
        "body": m.body or "", "bcc": m.bcc_emails or "" if m.sender_user_id == cu.id else "",
        "from_mailbox": m.from_mailbox, "is_mine": m.sender_user_id == cu.id,
        "attachment_list": [{"id": a.id, "name": a.file_name, "size_kb": a.size_kb, "url": a.file_url, "document_key": a.document_key} for a in m.attachments],
        "recipients": [{"kind": r.kind, "email": r.email, "name": r.name} for r in m.recipients if r.kind != "bcc" or m.sender_user_id == cu.id],
        "thread": thread, "record": record, "open_count": m.open_count, "click_count": m.click_count,
        "track_opens": bool(m.track_opens), "delivery_error": m.delivery_error, "assigned_to": assignee,
        "can_create_lead": (not m.is_internal) and m.sender_user_id != cu.id and not _is_customer(db, m.account_name),
        "in_reply_to_id": m.in_reply_to_id,
    })
    return d


# ─── Mailbox, folders, list, detail ───────────────────────────────────────────

@router.get("/mailbox")
def mailbox(db: Session = Depends(get_tenant_db), cu: User = Depends(inbox_user)):
    return svc.tenant_mail_info(db, cu)


def _folder_counts(db: Session, cu: User) -> dict[str, dict[str, int]]:
    base = db.query(MailMessage).filter(MailMessage.owner_user_id == cu.id, MailMessage.deleted_at.is_(None))
    rows = (base.with_entities(MailMessage.folder, func.count(MailMessage.id),
                               func.sum(case((MailMessage.is_read == False, 1), else_=0)))
            .group_by(MailMessage.folder).all())
    out = {f: {"total": 0, "unread": 0} for f in FOLDERS}
    for folder, total, unread in rows:
        if folder in out:
            out[folder] = {"total": int(total or 0), "unread": int(unread or 0)}
    out["Starred"] = {"total": base.filter(MailMessage.is_starred == True, MailMessage.folder != "Trash").count(), "unread": 0}
    return out


@router.get("/folders")
def folders(db: Session = Depends(get_tenant_db), cu: User = Depends(inbox_user)):
    return {"folders": [{"name": f, **c} for f, c in _folder_counts(db, cu).items()]}


@router.get("/unread-count")
def unread_count(db: Session = Depends(get_tenant_db), cu: User = Depends(inbox_user)):
    n = db.query(func.count(MailMessage.id)).filter(MailMessage.owner_user_id == cu.id, MailMessage.folder == "Inbox",
                                                    MailMessage.is_read == False, MailMessage.deleted_at.is_(None)).scalar()
    return {"unread_count": int(n or 0)}


@router.get("/messages")
def list_messages(
    folder: str = Query("Inbox"),
    label: str = Query(""),
    q: str = Query("", max_length=200),
    limit: int = Query(200, ge=1, le=500),
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(inbox_user),
):
    if folder not in FOLDERS:
        raise HTTPException(400, "Unknown folder")
    query = db.query(MailMessage).filter(MailMessage.owner_user_id == cu.id, MailMessage.deleted_at.is_(None))
    query = query.filter(MailMessage.is_starred == True, MailMessage.folder != "Trash") if folder == "Starred" else query.filter(MailMessage.folder == folder)
    if label == "Internal":
        query = query.filter(MailMessage.is_internal == True)
    elif label == "External":
        query = query.filter(MailMessage.is_internal == False)
    elif label == "Linked":
        query = query.filter(MailMessage.link_module.isnot(None))
    term = q.strip()
    if term:
        like = f"%{term}%"
        query = query.filter(or_(MailMessage.subject.ilike(like), MailMessage.body.ilike(like), MailMessage.from_name.ilike(like),
                                 MailMessage.from_email.ilike(like), MailMessage.account_name.ilike(like), MailMessage.to_emails.ilike(like)))
    order = MailMessage.scheduled_at.asc() if folder == "Scheduled" else func.coalesce(MailMessage.sent_at, MailMessage.created_at).desc()
    rows = query.order_by(order, MailMessage.id.desc()).limit(limit).all()
    return {"items": [_item(m) for m in rows], "folders": [{"name": f, **c} for f, c in _folder_counts(db, cu).items()]}


@router.get("/messages/{message_id}")
def get_message(message_id: int, mark_read: bool = Query(True), db: Session = Depends(get_tenant_db), cu: User = Depends(inbox_user)):
    m = _own(db, cu, message_id)
    if mark_read and not m.is_read:
        m.is_read = True
        db.commit()
    return _detail(db, cu, m)


# ─── Folder actions ───────────────────────────────────────────────────────────

class MessagePatch(BaseModel):
    is_read: Optional[bool] = None
    is_starred: Optional[bool] = None
    folder: Optional[str] = None


@router.patch("/messages/{message_id}")
def patch_message(message_id: int, body: MessagePatch, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(inbox_user)):
    m = _own(db, cu, message_id)
    if body.is_read is not None:
        m.is_read = body.is_read
    if body.is_starred is not None:
        m.is_starred = body.is_starred
    if body.folder is not None:
        if body.folder not in MOVABLE:
            raise HTTPException(400, f"Messages can only be moved to {', '.join(sorted(MOVABLE))}")
        if m.folder in ("Drafts", "Scheduled") and body.folder != "Trash":
            raise HTTPException(400, "Drafts and scheduled messages can only be moved to Trash")
        if body.folder != m.folder:
            m.prev_folder = m.folder if body.folder == "Trash" else None
            m.folder = body.folder
            _audit(db, request, cu, "move", m, f"Moved mail to {body.folder}")
    db.commit()
    return _item(m)


@router.post("/messages/{message_id}/restore")
def restore_message(message_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(inbox_user)):
    m = _own(db, cu, message_id)
    if m.folder != "Trash":
        raise HTTPException(400, "Only messages in Trash can be restored")
    m.folder = m.prev_folder if m.prev_folder in ("Inbox", "Sent", "Drafts", "Archive") else ("Sent" if m.sender_user_id == cu.id else "Inbox")
    m.prev_folder = None
    _audit(db, request, cu, "restore", m, f"Restored mail to {m.folder}")
    db.commit()
    return _item(m)


@router.delete("/messages/{message_id}")
def delete_message(message_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(inbox_user)):
    """Move to Trash; a message already in Trash is deleted permanently."""
    m = _own(db, cu, message_id)
    if m.folder == "Trash":
        m.deleted_at = now_ist()
        _audit(db, request, cu, "delete", m, "Deleted mail permanently")
        db.commit()
        return {"ok": True, "deleted": True}
    m.prev_folder, m.folder = m.folder, "Trash"
    if m.prev_folder == "Scheduled":
        m.scheduled_at = None
        m.prev_folder = "Drafts"
    _audit(db, request, cu, "trash", m, "Moved mail to Trash")
    db.commit()
    return {"ok": True, "deleted": False, "item": _item(m)}


@router.post("/messages/{message_id}/cancel-schedule")
def cancel_schedule(message_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(inbox_user)):
    m = _own(db, cu, message_id)
    if m.folder != "Scheduled":
        raise HTTPException(400, "This message is not scheduled")
    m.folder, m.scheduled_at, m.delivery_status = "Drafts", None, "draft"
    _audit(db, request, cu, "unschedule", m, "Cancelled scheduled mail – moved to Drafts")
    db.commit()
    return _item(m)


# ─── Compose: send / draft / schedule / reply / forward ───────────────────────

class AttachmentRef(BaseModel):
    key: str = Field(..., max_length=160)      # "doc:<document hub id>" or "att:<mail attachment id>"


class ComposeIn(BaseModel):
    action: str = Field("send", pattern="^(send|draft)$")
    draft_id: Optional[int] = None
    from_mailbox: Optional[str] = Field(None, max_length=255)
    to: str = Field("", max_length=4000)
    cc: str = Field("", max_length=4000)
    bcc: str = Field("", max_length=4000)
    subject: str = Field("", max_length=500)
    body: str = Field("", max_length=100_000)
    link_module: Optional[str] = Field(None, max_length=30)
    link_record_id: Optional[int] = None
    attachments: list[AttachmentRef] = Field(default_factory=list, max_length=25)
    track: bool = True
    schedule: Optional[str] = Field(None, max_length=40)       # "Send now" | "Tomorrow 09:00" | "Monday 09:00" | ISO
    reply_to_id: Optional[int] = None


def _validate_addresses(raw: str, field: str) -> list[str]:
    addrs = svc.split_addresses(raw)
    bad = [a for a in addrs if not svc.EMAIL_RE.match(svc.extract_email(a))]
    if bad:
        raise HTTPException(400, f"{field}: “{bad[0]}” is not a valid e-mail address")
    return addrs


def _accessible_documents(db: Session, cu: User) -> list[dict[str, Any]]:
    if not user_has_permission(db, cu, "document_management.view"):
        return []
    from app.routers import document_management_router as dm
    docs, _ = dm._collect_documents(db, cu, source_filter="", limit=200, trash=False)
    docs = dm._filter_documents_by_trash_state(db, docs, trash_view=False)
    cleaned, _ = dm._prepare_document_payload(db, cu, docs, 200)
    return cleaned


def _resolve_attachments(db: Session, cu: User, refs: list[AttachmentRef]) -> list[MailAttachment]:
    out: list[MailAttachment] = []
    doc_keys = [r.key[4:] for r in refs if r.key.startswith("doc:")]
    docs = {str(d["id"]): d for d in _accessible_documents(db, cu)} if doc_keys else {}
    for r in refs:
        if r.key.startswith("doc:"):
            d = docs.get(r.key[4:])
            if not d:
                raise HTTPException(400, "One of the selected Document Hub files is no longer available to you")
            out.append(MailAttachment(document_key=str(d["id"]), file_name=str(d.get("name") or "Document")[:300],
                                      file_url=d.get("url"), size_kb=d.get("size_kb")))
        elif r.key.startswith("att:") and r.key[4:].isdigit():
            a = (db.query(MailAttachment).join(MailMessage, MailMessage.id == MailAttachment.message_id)
                 .filter(MailAttachment.id == int(r.key[4:]), MailMessage.owner_user_id == cu.id).first())
            if not a:
                raise HTTPException(400, "An attachment of the original message is no longer available")
            out.append(MailAttachment(document_key=a.document_key, file_name=a.file_name, file_url=a.file_url, size_kb=a.size_kb))
        else:
            raise HTTPException(400, "Unsupported attachment reference")
    return out


@router.post("/messages")
def compose(body: ComposeIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(inbox_user)):
    sending = body.action == "send"
    to = _validate_addresses(body.to, "To")
    cc = _validate_addresses(body.cc, "Cc")
    bcc = _validate_addresses(body.bcc, "Bcc")
    if sending and not to:
        raise HTTPException(400, "Add a recipient")

    info = svc.tenant_mail_info(db, cu)
    allowed = {mb["address"].lower() for mb in info["mailboxes"]}
    from_mailbox = (body.from_mailbox or cu.email).strip()
    if from_mailbox.lower() not in allowed:
        raise HTTPException(400, "You can't send from that mailbox")

    record = None
    if body.link_module and body.link_record_id:
        record = svc.resolve_record(db, cu, body.link_module, body.link_record_id)
        if not record:
            raise HTTPException(400, "The linked record was not found or you don't have access to it")

    scheduled_at = svc.resolve_schedule(body.schedule) if sending else None
    if sending and body.schedule and body.schedule.strip().lower() not in ("send now", "now") and not scheduled_at:
        raise HTTPException(400, "Choose a valid send time")
    if scheduled_at and scheduled_at <= now_ist():
        raise HTTPException(400, "The scheduled time must be in the future")

    reply_to = _own(db, cu, body.reply_to_id) if body.reply_to_id else None
    attachments = _resolve_attachments(db, cu, body.attachments)

    m = None
    if body.draft_id:
        m = _own(db, cu, body.draft_id)
        if m.folder not in ("Drafts", "Scheduled"):
            raise HTTPException(400, "Only drafts can be edited")
    if m is None:
        m = MailMessage(owner_user_id=cu.id, sender_user_id=cu.id, is_read=True)
        db.add(m)

    everyone = [svc.extract_email(a) for a in to + cc + bcc]
    colleagues = svc.users_by_email(db, everyone)
    thread = svc.thread_for(db, body.subject, reply_to) if (sending or not m.thread_id) else None
    m.thread_id = thread.id if thread else m.thread_id
    m.from_email, m.from_name, m.from_mailbox = cu.email, cu.full_name, from_mailbox
    m.to_emails, m.cc_emails, m.bcc_emails = ", ".join(to), ", ".join(cc), ", ".join(bcc)
    m.subject, m.body = (body.subject or "").strip()[:500], body.body
    m.is_internal = bool(everyone) and all(e.lower() in colleagues for e in everyone)
    m.link_module, m.link_record_id = (record["module"], record["id"]) if record else (None, None)
    m.link_label = record["ref"] if record else None
    m.account_name = (record.get("customer") if record else None) or (reply_to.account_name if reply_to else None)
    m.in_reply_to_id = reply_to.id if reply_to else m.in_reply_to_id
    m.track_opens = bool(body.track)
    m.attachments = attachments
    m.recipients = [MailRecipient(kind=k, email=svc.extract_email(a)[:255], name=(colleagues.get(svc.extract_email(a).lower()).full_name if colleagues.get(svc.extract_email(a).lower()) else None),
                                  user_id=(colleagues.get(svc.extract_email(a).lower()).id if colleagues.get(svc.extract_email(a).lower()) else None))
                    for k, lst in (("to", to), ("cc", cc), ("bcc", bcc)) for a in lst]

    result: dict[str, Any] = {"status": "draft"}
    if not sending:
        m.folder, m.delivery_status, m.scheduled_at = "Drafts", "draft", None
        if not m.subject and not m.body and not everyone:
            raise HTTPException(400, "Nothing to save – the draft is empty")
        _audit(db, request, cu, "draft", m, "Saved mail draft")
    else:
        m.tracking_token = m.tracking_token or (svc.new_tracking_token() if body.track and not m.is_internal else None)
        if thread:
            thread.message_count = (thread.message_count or 0) + 1
            thread.last_message_at = scheduled_at or now_ist()
        if scheduled_at:
            m.folder, m.scheduled_at, m.delivery_status = "Scheduled", scheduled_at, "scheduled"
            result = {"status": "scheduled", "scheduled_at": svc.iso(scheduled_at)}
            _audit(db, request, cu, "schedule", m, f"Scheduled mail for {scheduled_at:%d %b %Y %H:%M}")
        else:
            m.folder, m.sent_at, m.scheduled_at = "Sent", now_ist(), None
            db.flush()
            result = svc.deliver(db, m, cu)
            _audit(db, request, cu, "send", m, f"Sent mail to {m.to_emails} ({result['status']})")
    db.commit()
    for u in colleagues.values():
        if sending and not scheduled_at:
            invalidate_notifications_cache(db, u.id)
            invalidate_badges_cache(db, u.id)
    return {"message": _item(m), **result}


# ─── CRM integration actions ──────────────────────────────────────────────────

class LinkIn(BaseModel):
    module: str = Field(..., max_length=30)
    record_id: int


@router.post("/messages/{message_id}/link")
def link_message(message_id: int, body: LinkIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(inbox_user)):
    m = _own(db, cu, message_id)
    record = svc.resolve_record(db, cu, body.module, body.record_id)
    if not record:
        raise HTTPException(404, "Record not found or you don't have access to it")
    m.link_module, m.link_record_id, m.link_label = record["module"], record["id"], record["ref"]
    m.account_name = m.account_name or record.get("customer")
    _audit(db, request, cu, "link", m, f"Linked mail to {record['type']} {record['ref']}")
    db.commit()
    return _detail(db, cu, m)


@router.delete("/messages/{message_id}/link")
def unlink_message(message_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(inbox_user)):
    m = _own(db, cu, message_id)
    m.link_module = m.link_record_id = m.link_label = None
    _audit(db, request, cu, "unlink", m, "Removed record link from mail")
    db.commit()
    return _detail(db, cu, m)


class TaskIn(BaseModel):
    due_in_days: int = Field(2, ge=0, le=365)


@router.post("/messages/{message_id}/task")
def create_task(message_id: int, request: Request, body: TaskIn = TaskIn(), db: Session = Depends(get_tenant_db), cu: User = Depends(inbox_user)):
    """Prototype mailTask(): 'Follow up: <subject>', due in 2 days. Filed as a planned follow-up activity
    (Field Sales calendar) when the user may create activities, otherwise as a reminder note."""
    m = _own(db, cu, message_id)
    due = (now_ist() + timedelta(days=body.due_in_days))
    title = f"Follow up: {m.subject or '(no subject)'}"[:300]
    if user_has_permission(db, cu, "calendar.create"):
        # Calendar & Tasks (prototype mailTask → addRec('tasks')): a real task, linked to the mail's CRM record.
        from app.models.calendar_tasks import CrmTask
        from app.services.calendar_service import ensure_calendar_schema, resolve_related
        ensure_calendar_schema(db)
        rec = resolve_related(db, cu, m.link_module, m.link_record_id) if m.link_module and m.link_record_id else None
        task = CrmTask(title=title, due_date=due.date(), priority="Medium", status="To do", assignee_id=cu.id, created_by=cu.id,
                       source="inbox", related_module=rec["module"] if rec else None, related_id=rec["id"] if rec else None,
                       related_label=rec["label"][:300] if rec else None)
        db.add(task)
        db.flush()
        kind, ref, route = "task", task.id, f"/calendar?task={task.id}"
    elif user_has_permission(db, cu, "kam.create"):
        from app.models.all_models import Lead, Quotation, Tender
        customer_id = lead_id = tender_id = None
        if m.link_module == "customers":
            customer_id = m.link_record_id
        elif m.link_module in ("leads", "opportunities"):
            lead_id = m.link_record_id
            customer_id = db.query(Lead.customer_id).filter(Lead.id == lead_id).scalar()
        elif m.link_module == "tenders":
            tender_id = m.link_record_id
            customer_id = db.query(Tender.customer_id).filter(Tender.id == tender_id).scalar()
        elif m.link_module == "quotations":
            customer_id = db.query(Quotation.customer_id).filter(Quotation.id == m.link_record_id).scalar()
        cols = {c.name for c in KAMActivity.__table__.columns}
        act = KAMActivity(**{k: v for k, v in dict(
            user_id=cu.id, user_role=cu.role, customer_id=customer_id, lead_id=lead_id, tender_id=tender_id,
            activity_type="Follow Up", mode="Email", subject=title, activity_date=due.date(), status="Planned",
            description=f"Created from e-mail “{m.subject}” from {m.from_name or m.from_email}.\n\n{(m.body or '')[:1500]}",
            created_by=cu.id,
        ).items() if k in cols})
        db.add(act)
        db.flush()
        kind, ref, route = "activity", act.id, "/kam"
    else:
        note = StickyNote(user_id=cu.id, title=title[:160], content=f"From {m.from_name or m.from_email}\n{(m.body or '')[:1500]}",
                          color="yellow", pinned=True, reminder_at=due.replace(hour=9, minute=0, second=0, microsecond=0))
        from app.routers.notes_router import ensure_notes_schema
        from app.services.calendar_service import resolve_related
        ensure_notes_schema(db)
        rec = resolve_related(db, cu, m.link_module, m.link_record_id) if m.link_module and m.link_record_id else None
        if rec:   # Notes & Pinboard shows "Linked: …" for this note
            note.link_module, note.link_record_id, note.link_label = rec["module"], rec["id"], rec["label"][:300]
        db.add(note)
        db.flush()
        kind, ref, route = "note", note.id, "/notes"
    _audit(db, request, cu, "create_task", m, f"Created follow-up {kind} from mail")
    db.commit()
    return {"ok": True, "kind": kind, "id": ref, "route": route, "due": due.date().isoformat(), "title": title}


@router.post("/messages/{message_id}/lead")
def create_lead_from_mail(message_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(inbox_user)):
    """Prototype mailLead(): a lead named after the sender's company, source e-mail. Uses the Leads module's own
    create_lead (permissions, reference numbers, notifications)."""
    from app.routers.lead_router import LeadCreate, create_lead
    m = _own(db, cu, message_id)
    if m.is_internal:
        raise HTTPException(400, "Leads can only be created from external e-mail")
    name = m.from_name or m.from_email
    company = m.account_name if m.account_name and m.account_name != "—" else None
    if not company and "(" in name and name.endswith(")"):
        company = name[name.rfind("(") + 1:-1]
    contact = name.split(" (")[0]
    lead = create_lead(LeadCreate(
        lead_title=(m.subject or f"Enquiry from {contact}")[:500], customer_name=company or contact, contact_person=contact[:200],
        email=m.from_email[:200], notes=f"Created from e-mail received {svc.iso(m.sent_at or m.created_at) or ''}\n\n{(m.body or '')[:4000]}",
        product_description=(m.subject or "")[:1000],
    ), request, db, cu)
    try:
        lead.channel = "email"
        m.link_module, m.link_record_id, m.link_label = "leads", lead.id, lead.lead_ref_id
        _audit(db, request, cu, "create_lead", m, f"Created lead {lead.lead_ref_id} from mail")
        db.commit()
    except Exception:
        db.rollback()
    return {"ok": True, "id": lead.id, "ref": lead.lead_ref_id, "route": f"/leads/{lead.id}"}


class AssignIn(BaseModel):
    user_id: int
    add_note: bool = True


@router.post("/messages/{message_id}/assign")
def assign_message(message_id: int, body: AssignIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(inbox_user)):
    """Prototype mailAssignOk(): sends an internal 'Assigned: …' mail (with the original) to the colleague."""
    m = _own(db, cu, message_id)
    target = db.query(User).filter(User.id == body.user_id, User.is_active == True).first()
    if not target or target.id == cu.id:
        raise HTTPException(400, "Choose an active colleague")
    note = f"Please take this one – customer is waiting. {cu.full_name}\n\n" if body.add_note else ""
    original = f"— Original message from {m.from_name or m.from_email} —\nSubject: {m.subject}\n\n{m.body or ''}"
    thread = svc.thread_for(db, m.subject, m)
    out = MailMessage(
        thread_id=thread.id, owner_user_id=cu.id, sender_user_id=cu.id, folder="Sent", from_email=cu.email, from_name=cu.full_name,
        from_mailbox=cu.email, to_emails=target.email, subject=f"Assigned: {m.subject or '(no subject)'}"[:500], body=note + original,
        account_name=m.account_name, is_read=True, is_internal=True, link_module=m.link_module, link_record_id=m.link_record_id,
        link_label=m.link_label, in_reply_to_id=m.id, track_opens=False, sent_at=now_ist(), assigned_to_user_id=target.id,
    )
    out.attachments = [MailAttachment(document_key=a.document_key, file_name=a.file_name, file_url=a.file_url, size_kb=a.size_kb) for a in m.attachments]
    out.recipients = [MailRecipient(kind="to", email=target.email, name=target.full_name, user_id=target.id)]
    db.add(out)
    db.flush()
    thread.message_count = (thread.message_count or 0) + 1
    thread.last_message_at = now_ist()
    svc.deliver(db, out, cu)
    m.assigned_to_user_id = target.id
    _audit(db, request, cu, "assign", m, f"Assigned mail to {target.full_name}")
    db.commit()
    invalidate_notifications_cache(db, target.id)
    return {"ok": True, "assigned_to": target.full_name}


# ─── Pickers: records, people, templates, documents, AI ───────────────────────

@router.get("/records")
def records(q: str = Query("", max_length=120), db: Session = Depends(get_tenant_db), cu: User = Depends(inbox_user)):
    return {"items": svc.search_records(db, cu, q)}


@router.get("/people")
def people(db: Session = Depends(get_tenant_db), cu: User = Depends(inbox_user)):
    users = db.query(User).filter(User.is_active == True).order_by(User.full_name.asc()).all()
    contacts: list[dict[str, str]] = []
    if user_has_permission(db, cu, "customers.view"):
        cq = svc._record_query(db, cu, "customers")
        if cq is not None:
            ids = [c.id for c in cq.with_entities(Customer.id).limit(500).all()]
            if ids:
                rows = (db.query(CustomerContact.contact_name, CustomerContact.office_email, Customer.customer_name)
                        .join(Customer, Customer.id == CustomerContact.customer_id)
                        .filter(CustomerContact.customer_id.in_(ids), CustomerContact.is_active == True,
                                CustomerContact.office_email.isnot(None), CustomerContact.office_email != "").limit(500).all())
                contacts = [{"name": n, "email": e, "account": a} for n, e, a in rows]
    return {
        "colleagues": [{"id": u.id, "name": u.full_name, "email": u.email, "role": u.role, "designation": u.designation} for u in users],
        "contacts": contacts,
    }


@router.get("/templates")
def templates(db: Session = Depends(get_tenant_db), cu: User = Depends(inbox_user)):
    rows = db.query(MailTemplate).filter(MailTemplate.is_active == True).order_by(MailTemplate.sort_order, MailTemplate.id).all()
    return {"items": [{"id": t.id, "name": t.name, "subject": t.subject, "body": t.body, "is_system": t.is_system} for t in rows]}


class RenderIn(BaseModel):
    link_module: Optional[str] = None
    link_record_id: Optional[int] = None


@router.post("/templates/{template_id}/render")
def render_template(template_id: int, body: RenderIn, db: Session = Depends(get_tenant_db), cu: User = Depends(inbox_user)):
    t = db.query(MailTemplate).filter(MailTemplate.id == template_id, MailTemplate.is_active == True).first()
    if not t:
        raise HTTPException(404, "Template not found")
    record = svc.resolve_record(db, cu, body.link_module, body.link_record_id)
    return {"subject": svc.merge_template(t.subject or t.name, record, cu), "body": svc.merge_template(t.body, record, cu)}


class AiDraftIn(BaseModel):
    link_module: Optional[str] = None
    link_record_id: Optional[int] = None
    subject: str = Field("", max_length=500)
    reply_to_id: Optional[int] = None


@router.post("/ai-draft")
async def ai_draft(body: AiDraftIn, db: Session = Depends(get_tenant_db), cu: User = Depends(inbox_user)):
    record = svc.resolve_record(db, cu, body.link_module, body.link_record_id)
    context = ""
    if body.reply_to_id:
        context = (_own(db, cu, body.reply_to_id).body or "")
    text, source = await svc.ai_draft(record, body.subject, cu, context)
    return {"body": text, "source": source}


@router.get("/documents")
def documents(db: Session = Depends(get_tenant_db), cu: User = Depends(inbox_user)):
    if not user_has_permission(db, cu, "document_management.view"):
        return {"items": [], "allowed": False}
    try:
        docs = _accessible_documents(db, cu)
    except Exception as exc:
        logger.warning("Inbox document list failed: %s", exc)
        db.rollback()
        docs = []
    return {"allowed": True, "items": [{"key": f"doc:{d['id']}", "name": d.get("name"), "size_kb": d.get("size_kb"),
                                        "source": d.get("source"), "record_label": d.get("record_label")} for d in docs[:60]]}


# ─── Receiving external mail & tracking ───────────────────────────────────────

class InboundIn(BaseModel):
    to_email: str = Field(..., max_length=255)
    from_email: str = Field(..., max_length=255)
    from_name: Optional[str] = Field(None, max_length=255)
    subject: str = Field("", max_length=500)
    body: str = Field("", max_length=100_000)
    cc: str = Field("", max_length=4000)


@router.post("/inbound", status_code=201)
def inbound(body: InboundIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    """File an external e-mail into a user's Inbox (mail relay / BCC-dropbox integrations). Admin or API key only."""
    if cu.role not in ("admin", "ceo"):
        raise HTTPException(403, "Only administrators or integrations can deliver inbound mail")
    svc.ensure_inbox_schema(db)
    owner = db.query(User).filter(func.lower(User.email) == body.to_email.strip().lower(), User.is_active == True).first()
    if not owner:
        raise HTTPException(404, "No active user has that address")
    sender = svc.extract_email(body.from_email)
    if not svc.EMAIL_RE.match(sender):
        raise HTTPException(400, "from_email is not a valid address")
    contact = (db.query(CustomerContact.contact_name, Customer.customer_name, Customer.id)
               .join(Customer, Customer.id == CustomerContact.customer_id)
               .filter(func.lower(CustomerContact.office_email) == sender.lower()).first())
    reply = (db.query(MailMessage).filter(MailMessage.owner_user_id == owner.id, MailMessage.folder == "Sent",
                                          MailMessage.subject == svc.re.sub(r"^((re|fwd?):\s*)+", "", body.subject, flags=svc.re.I))
             .order_by(MailMessage.id.desc()).first())
    thread = svc.thread_for(db, body.subject, reply)
    m = MailMessage(
        thread_id=thread.id, owner_user_id=owner.id, folder="Inbox", from_email=sender,
        from_name=body.from_name or (f"{contact[0]} ({contact[1]})" if contact else sender), to_emails=owner.email, cc_emails=body.cc,
        subject=body.subject, body=body.body, account_name=contact[1] if contact else None, is_read=False, is_internal=False,
        link_module="customers" if contact else (reply.link_module if reply else None),
        link_record_id=contact[2] if contact else (reply.link_record_id if reply else None),
        link_label=f"CUS-{contact[2]:04d}" if contact else (reply.link_label if reply else None),
        in_reply_to_id=reply.id if reply else None, sent_at=now_ist(), delivery_status="received", track_opens=False,
    )
    m.recipients = [MailRecipient(kind="to", email=owner.email, name=owner.full_name, user_id=owner.id)]
    db.add(m)
    thread.message_count = (thread.message_count or 0) + 1
    thread.last_message_at = now_ist()
    db.flush()
    from app.services.notification_service import upsert_notification
    upsert_notification(db, owner.id, f"New mail from {m.from_name}", m.subject or "(no subject)", module="inbox",
                        record_id=m.id, action="mail_received", send_email=False)
    _audit(db, request, cu, "receive", m, f"Inbound mail filed for {owner.email}")
    db.commit()
    invalidate_notifications_cache(db, owner.id)
    return _item(m)


@router.get("/track/open/{token}.gif", include_in_schema=False)
def track_open(token: str, db: Session = Depends(get_tenant_db)):
    try:
        svc.ensure_inbox_schema(db)
        m = db.query(MailMessage).filter(MailMessage.tracking_token == token[:64]).first()
        if m and m.track_opens:
            m.open_count = (m.open_count or 0) + 1
            db.commit()
    except Exception:
        db.rollback()
    return Response(content=_GIF, media_type="image/gif", headers={"Cache-Control": "no-store"})


@router.get("/track/click/{token}", include_in_schema=False)
def track_click(token: str, u: str = Query(..., max_length=2000), db: Session = Depends(get_tenant_db)):
    svc.ensure_inbox_schema(db)
    m = db.query(MailMessage).filter(MailMessage.tracking_token == token[:64]).first()
    # Only links that are part of the tracked message may be redirected to (no open redirect).
    if not m or not u.startswith(("http://", "https://")) or u not in (m.body or ""):
        raise HTTPException(404, "Link not found")
    if m.track_opens:
        m.click_count = (m.click_count or 0) + 1
        db.commit()
    return RedirectResponse(u, status_code=302)
