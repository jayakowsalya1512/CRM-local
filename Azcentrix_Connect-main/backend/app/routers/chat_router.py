"""Team Chat REST + WebSocket endpoints.

Text messaging, documents, image attachments, emojis and collaboration
features only — no audio/video/call functionality, per the brief.
"""
from __future__ import annotations

import base64
import io
import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import (
    APIRouter, Depends, File, HTTPException, Query, Request, UploadFile,
    WebSocket, WebSocketDisconnect, status,
)
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.chat_encryption import ChatEncryptionError, decrypt_bytes, encrypt_bytes
from app.core.config import settings
from app.core.security import verify_token
from app.database import MasterSessionLocal, get_tenant_session
from app.dependencies import (
    ensure_token_session_is_active, get_current_user, get_tenant_db, require_permission,
)
from app.models.all_models import User
from app.models.chat_models import ChatAttachment, ChatAuditLog, ChatMessage, ChatPoll
from app.models.tenant import Tenant
from app.services import chat_realtime, chat_service
from app.services.chat_schema import ensure_chat_schema
from app.services.platform_storage import is_executable
from app.utils.file_storage import (
    iter_file_chunks, media_slug_from_request, open_stored_file, save_upload_optimized,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["team-chat"])

MEDIA_ROOT = settings.MEDIA_ROOT


def _ensure_schema(db: Session) -> None:
    ensure_chat_schema(db)


def _can(db: Session, user: User, key: str) -> bool:
    from app.dependencies import user_has_permission
    return user_has_permission(db, user, key)


# ─── request/response models ───────────────────────────────────────────────

class CreateDMRequest(BaseModel):
    user_id: int


class CreateGroupRequest(BaseModel):
    name: str
    member_ids: list[int] = Field(default_factory=list)
    description: str = ""
    is_private: bool = True


class UpdateGroupRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    avatar_url: Optional[str] = None
    is_private: Optional[bool] = None
    announcement_mode: Optional[bool] = None


class MembersRequest(BaseModel):
    user_ids: list[int]


class MemberRoleRequest(BaseModel):
    role: str


class ConversationFlagsRequest(BaseModel):
    is_pinned: Optional[bool] = None
    is_archived: Optional[bool] = None
    muted_until: Optional[datetime] = None
    unmute: bool = False


class SendMessageRequest(BaseModel):
    content: str = ""
    message_type: str = "text"
    reply_to_message_id: Optional[int] = None
    mentions: list[int] = Field(default_factory=list)
    client_token: Optional[str] = None


class EditMessageRequest(BaseModel):
    content: str


class ForwardMessageRequest(BaseModel):
    target_conversation_ids: list[int]


class ReactionRequest(BaseModel):
    emoji: str


class MarkReadRequest(BaseModel):
    up_to_message_id: int


class PollCreateRequest(BaseModel):
    question: str
    options: list[str]
    is_multi_choice: bool = False
    is_anonymous: bool = False
    closes_at: Optional[datetime] = None


class PollVoteRequest(BaseModel):
    option_ids: list[int]


class ScheduleMessageRequest(BaseModel):
    content: str
    scheduled_for: datetime
    message_type: str = "text"


class ReminderRequest(BaseModel):
    remind_at: datetime
    note: Optional[str] = None


class DraftRequest(BaseModel):
    content: str
    reply_to_message_id: Optional[int] = None


class NotificationPrefsRequest(BaseModel):
    in_app_enabled: Optional[bool] = None
    desktop_enabled: Optional[bool] = None
    sound_enabled: Optional[bool] = None
    mentions_only: Optional[bool] = None


class CrmShareRequest(BaseModel):
    module: str
    record_id: int
    label: str
    ref_number: Optional[str] = None


class RetentionRequest(BaseModel):
    retention_days: Optional[int] = None


def _tenant_slug(request: Request) -> str:
    slug = getattr(request.state, "tenant", None)
    if slug is not None:
        return slug.slug
    return getattr(request.state, "tenant_slug", "") or ""


def _notify(request: Request, target_user_ids: list[int], event_type: str, data: dict) -> None:
    """Fire-and-forget realtime push — never blocks or fails the HTTP response.
    Every endpoint calling this is a plain `def` route (FastAPI runs those in a
    worker thread, not on the event loop), so this goes through
    chat_realtime.schedule_publish() rather than asyncio.create_task() directly —
    the latter silently no-ops with no running loop in that thread."""
    slug = _tenant_slug(request)
    if not slug or not target_user_ids:
        return
    chat_realtime.schedule_publish(slug, target_user_ids, {"type": event_type, "data": data})


# ─── conversations ──────────────────────────────────────────────────────────

@router.get("/conversations")
def api_list_conversations(
    request: Request, kind: Optional[str] = Query(None), unread_only: bool = Query(False),
    search: Optional[str] = Query(None),
    db: Session = Depends(get_tenant_db), current_user: User = Depends(require_permission("team_chat.use")),
):
    _ensure_schema(db)
    return chat_service.list_conversations(db, current_user.id, kind=kind, unread_only=unread_only, search=search)


@router.post("/conversations/dm")
def api_create_dm(
    request: Request, body: CreateDMRequest,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(require_permission("team_chat.use")),
):
    _ensure_schema(db)
    conv = chat_service.get_or_create_dm(db, current_user.id, body.user_id)
    _notify(request, [body.user_id], "conversation_updated", {"conversation_id": conv.id})
    return {"id": conv.id}


@router.post("/conversations/group")
def api_create_group(
    request: Request, body: CreateGroupRequest,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(require_permission("team_chat.create_group")),
):
    _ensure_schema(db)
    conv = chat_service.create_group(db, current_user.id, body.name, body.member_ids,
                                      description=body.description, is_private=body.is_private)
    _notify(request, body.member_ids, "conversation_updated", {"conversation_id": conv.id})
    return {"id": conv.id}


@router.patch("/conversations/{conversation_id}")
def api_update_group(
    conversation_id: int, request: Request, body: UpdateGroupRequest,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    conv = chat_service.update_group(db, conversation_id, current_user.id, **body.model_dump())
    members = chat_service.active_member_ids(db, conversation_id)
    _notify(request, members, "conversation_updated", {"conversation_id": conversation_id})
    return {"id": conv.id}


@router.delete("/conversations/{conversation_id}")
def api_delete_group(
    conversation_id: int, request: Request,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    members = chat_service.active_member_ids(db, conversation_id)
    chat_service.delete_group(db, conversation_id, current_user.id)
    _notify(request, members, "conversation_deleted", {"conversation_id": conversation_id})
    return {"ok": True}


@router.patch("/conversations/{conversation_id}/flags")
def api_set_flags(
    conversation_id: int, body: ConversationFlagsRequest,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    muted_until = None if body.unmute else body.muted_until
    member = chat_service.set_member_flag(
        db, conversation_id, current_user.id, pinned=body.is_pinned, archived=body.is_archived,
        muted_until=muted_until if (body.unmute or body.muted_until is not None) else "__unset__",
    )
    return {"is_pinned": member.is_pinned, "is_archived": member.is_archived, "muted_until": member.muted_until}


@router.get("/conversations/{conversation_id}/members")
def api_list_members(
    conversation_id: int,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    return chat_service.list_members(db, conversation_id, current_user.id)


@router.post("/conversations/{conversation_id}/members")
def api_add_members(
    conversation_id: int, request: Request, body: MembersRequest,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    added = chat_service.add_members(db, conversation_id, current_user.id, body.user_ids)
    _notify(request, added + chat_service.active_member_ids(db, conversation_id),
            "conversation_updated", {"conversation_id": conversation_id})
    return {"added": added}


@router.delete("/conversations/{conversation_id}/members/{user_id}")
def api_remove_member(
    conversation_id: int, user_id: int, request: Request,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    chat_service.remove_member(db, conversation_id, current_user.id, user_id)
    _notify(request, [user_id] + chat_service.active_member_ids(db, conversation_id),
            "conversation_updated", {"conversation_id": conversation_id})
    return {"ok": True}


@router.patch("/conversations/{conversation_id}/members/{user_id}/role")
def api_set_member_role(
    conversation_id: int, user_id: int, body: MemberRoleRequest,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    chat_service.set_member_role(db, conversation_id, current_user.id, user_id, body.role)
    return {"ok": True}


@router.patch("/conversations/{conversation_id}/retention")
def api_set_retention(
    conversation_id: int, body: RetentionRequest,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    chat_service.set_retention(db, conversation_id, current_user.id, body.retention_days)
    return {"ok": True}


@router.get("/conversations/{conversation_id}/export")
def api_export_conversation(
    conversation_id: int,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(require_permission("team_chat.export")),
):
    _ensure_schema(db)
    return chat_service.export_conversation(db, conversation_id, current_user.id)


# ─── messages ───────────────────────────────────────────────────────────────

@router.get("/conversations/{conversation_id}/messages")
def api_list_messages(
    conversation_id: int, before_id: Optional[int] = Query(None), limit: int = Query(40),
    db: Session = Depends(get_tenant_db), current_user: User = Depends(require_permission("team_chat.use")),
):
    _ensure_schema(db)
    return chat_service.list_messages(db, conversation_id, current_user.id, before_id=before_id, limit=limit)


@router.post("/conversations/{conversation_id}/messages")
def api_send_message(
    conversation_id: int, request: Request, body: SendMessageRequest,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(require_permission("team_chat.use")),
):
    _ensure_schema(db)
    msg = chat_service.send_message(
        db, conversation_id, current_user.id, content=body.content, message_type=body.message_type,
        reply_to_message_id=body.reply_to_message_id, mentions=body.mentions or None,
        client_token=body.client_token,
    )
    hydrated = chat_service.hydrate_messages(db, [msg], current_user.id)[0]
    members = chat_service.active_member_ids(db, conversation_id)
    _notify(request, members, "message_new", hydrated)
    if body.mentions:
        _notify(request, body.mentions, "mentioned", {"conversation_id": conversation_id, "message_id": msg.id})
    return hydrated


@router.patch("/messages/{message_id}")
def api_edit_message(
    message_id: int, request: Request, body: EditMessageRequest,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    msg = chat_service.edit_message(db, message_id, current_user.id, body.content)
    hydrated = chat_service.hydrate_messages(db, [msg], current_user.id)[0]
    members = chat_service.active_member_ids(db, msg.conversation_id)
    _notify(request, members, "message_edited", hydrated)
    return hydrated


@router.delete("/messages/{message_id}")
def api_delete_message(
    message_id: int, request: Request,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    can_delete_any = _can(db, current_user, "team_chat.delete_any_message")
    msg = chat_service.delete_message(db, message_id, current_user.id, can_delete_any=can_delete_any)
    members = chat_service.active_member_ids(db, msg.conversation_id)
    _notify(request, members, "message_deleted", {"id": msg.id, "conversation_id": msg.conversation_id})
    return {"ok": True}


@router.post("/messages/{message_id}/forward")
def api_forward_message(
    message_id: int, request: Request, body: ForwardMessageRequest,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    msgs = chat_service.forward_message(db, message_id, current_user.id, body.target_conversation_ids)
    hydrated = chat_service.hydrate_messages(db, msgs, current_user.id)
    for h in hydrated:
        members = chat_service.active_member_ids(db, h["conversation_id"])
        _notify(request, members, "message_new", h)
    return hydrated


@router.post("/messages/{message_id}/reactions")
def api_toggle_reaction(
    message_id: int, request: Request, body: ReactionRequest,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    result = chat_service.toggle_reaction(db, message_id, current_user.id, body.emoji)
    msg = db.get(ChatMessage, message_id)
    members = chat_service.active_member_ids(db, msg.conversation_id) if msg else []
    _notify(request, members, "reaction_updated", {**result, "user_id": current_user.id})
    return result


@router.post("/conversations/{conversation_id}/read")
def api_mark_read(
    conversation_id: int, request: Request, body: MarkReadRequest,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    chat_service.mark_read(db, conversation_id, current_user.id, body.up_to_message_id)
    members = chat_service.active_member_ids(db, conversation_id)
    _notify(request, members, "read_receipt_updated",
            {"conversation_id": conversation_id, "user_id": current_user.id,
             "up_to_message_id": body.up_to_message_id})
    return {"ok": True}


@router.get("/unread-count")
def api_unread_count(
    db: Session = Depends(get_tenant_db), current_user: User = Depends(require_permission("team_chat.use")),
):
    _ensure_schema(db)
    return {"count": chat_service.unread_total(db, current_user.id)}


@router.get("/search")
def api_search_messages(
    q: str = Query(..., min_length=2), conversation_id: Optional[int] = Query(None),
    db: Session = Depends(get_tenant_db), current_user: User = Depends(require_permission("team_chat.use")),
):
    _ensure_schema(db)
    return chat_service.search_messages(db, current_user.id, q, conversation_id=conversation_id)


# ─── pins / bookmarks ───────────────────────────────────────────────────────

@router.post("/conversations/{conversation_id}/pins/{message_id}")
def api_toggle_pin(
    conversation_id: int, message_id: int, request: Request,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    pinned = chat_service.toggle_pin(db, conversation_id, message_id, current_user.id)
    _notify(request, chat_service.active_member_ids(db, conversation_id), "pin_updated",
            {"conversation_id": conversation_id, "message_id": message_id, "pinned": pinned})
    return {"pinned": pinned}


@router.get("/conversations/{conversation_id}/pins")
def api_list_pins(
    conversation_id: int,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    return chat_service.list_pinned(db, conversation_id, current_user.id)


@router.post("/messages/{message_id}/bookmark")
def api_toggle_bookmark(
    message_id: int, note: Optional[str] = Query(None),
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    return {"bookmarked": chat_service.toggle_bookmark(db, message_id, current_user.id, note)}


@router.get("/bookmarks")
def api_list_bookmarks(
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    return chat_service.list_bookmarks(db, current_user.id)


# ─── shared media ───────────────────────────────────────────────────────────

@router.get("/conversations/{conversation_id}/shared")
def api_shared_attachments(
    conversation_id: int, kind: Optional[str] = Query(None), search: Optional[str] = Query(None),
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    return chat_service.list_shared_attachments(db, conversation_id, current_user.id, kind=kind, search=search)


# ─── attachments upload/download ───────────────────────────────────────────

def _allowed_exts() -> set[str]:
    return {e.strip().lower() for e in settings.CHAT_ALLOWED_ATTACHMENT_EXTS.split(",") if e.strip()}


IMAGE_EXTS = {"jpg", "jpeg", "png", "gif", "webp"}


@router.post("/conversations/{conversation_id}/attachments")
async def api_upload_attachment(
    conversation_id: int, request: Request, file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db), current_user: User = Depends(require_permission("team_chat.use")),
):
    _ensure_schema(db)
    chat_service.require_member(db, conversation_id, current_user.id)

    ext = (os.path.splitext(file.filename or "")[1] or "").lstrip(".").lower()
    if ext not in _allowed_exts():
        raise HTTPException(415, f"File type .{ext} is not permitted in Team Chat")

    contents = await file.read()
    max_bytes = settings.CHAT_MAX_ATTACHMENT_MB * 1024 * 1024
    if len(contents) > max_bytes:
        raise HTTPException(413, f"Attachment exceeds {settings.CHAT_MAX_ATTACHMENT_MB} MB")
    if not contents:
        raise HTTPException(400, "Empty file")
    if is_executable(ext, contents[:8]):
        raise HTTPException(415, "This file looks like an executable and is blocked")

    # Encrypt BEFORE storage — validation above runs on the real plaintext bytes,
    # so malware/extension checks are never fooled by opaque ciphertext.
    encrypted = encrypt_bytes(contents)
    ciphertext_bytes = base64.b64decode(encrypted.ciphertext_b64)

    saved = save_upload_optimized(
        root_dir=os.path.abspath(MEDIA_ROOT),
        subfolder="team_chat/attachments",
        original_filename=file.filename,
        contents=ciphertext_bytes,
        media_slug=media_slug_from_request(request),
        content_type=file.content_type,
        force_compression=False,  # ciphertext does not compress
    )

    msg = chat_service.send_message(
        db, conversation_id, current_user.id,
        message_type="image" if ext in IMAGE_EXTS else "file",
    )
    db.add(ChatAttachment(
        message_id=msg.id, uploader_id=current_user.id, original_name=file.filename or "file",
        content_type=file.content_type, size_bytes=len(contents),
        storage_path=str(saved.logical_path), is_image=ext in IMAGE_EXTS,
        encryption_nonce=encrypted.nonce_b64, encryption_key_version=encrypted.key_version,
    ))
    db.commit()

    hydrated = chat_service.hydrate_messages(db, [msg], current_user.id)[0]
    members = chat_service.active_member_ids(db, conversation_id)
    _notify(request, members, "message_new", hydrated)
    return hydrated


@router.get("/attachments/{attachment_id}/download")
def api_download_attachment(
    attachment_id: int,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    attachment = db.get(ChatAttachment, attachment_id)
    if not attachment:
        raise HTTPException(404, "Attachment not found")
    message = db.get(ChatMessage, attachment.message_id)
    if not message or message.is_deleted:
        raise HTTPException(404, "Attachment not found")
    # Authorization happens here, not via a signed URL: only an active member of
    # the owning conversation can ever reach the decrypted bytes.
    chat_service.require_member(db, message.conversation_id, current_user.id)

    try:
        file_obj, _meta, _physical = open_stored_file(Path(attachment.storage_path))
        ciphertext = file_obj.read()
    except FileNotFoundError:
        raise HTTPException(404, "Stored file is missing")
    try:
        plaintext = decrypt_bytes(
            base64.b64encode(ciphertext).decode("ascii"),
            attachment.encryption_nonce, attachment.encryption_key_version,
        )
    except ChatEncryptionError as exc:
        raise HTTPException(500, str(exc))

    return StreamingResponse(
        iter_file_chunks(io.BytesIO(plaintext)),
        media_type=attachment.content_type or "application/octet-stream",
        headers={"Content-Disposition": f'inline; filename="{attachment.original_name}"'},
    )


# ─── CRM record sharing ─────────────────────────────────────────────────────

@router.post("/conversations/{conversation_id}/share-crm-record")
def api_share_crm_record(
    conversation_id: int, request: Request, body: CrmShareRequest,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("team_chat.share_crm_records")),
):
    """The router only checks `team_chat.share_crm_records` (can the user share
    records into chat at all) — it relies on the browser having already loaded
    `label`/`ref_number` through that record's own permission-gated page
    (customers.view, leads.view, etc.) before this call is made, same as every
    other "paste a reference into another module" flow in this codebase. It
    does not re-fetch or re-authorize the source record itself."""
    _ensure_schema(db)
    msg = chat_service.share_crm_record(db, conversation_id, current_user.id, body.module, body.record_id,
                                         body.label, body.ref_number)
    hydrated = chat_service.hydrate_messages(db, [msg], current_user.id)[0]
    _notify(request, chat_service.active_member_ids(db, conversation_id), "message_new", hydrated)
    return hydrated


# ─── polls ──────────────────────────────────────────────────────────────────

@router.post("/conversations/{conversation_id}/polls")
def api_create_poll(
    conversation_id: int, request: Request, body: PollCreateRequest,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    poll = chat_service.create_poll(db, conversation_id, current_user.id, body.question, body.options,
                                     is_multi_choice=body.is_multi_choice, is_anonymous=body.is_anonymous,
                                     closes_at=body.closes_at)
    _notify(request, chat_service.active_member_ids(db, conversation_id), "poll_updated", poll)
    return poll


@router.get("/polls/{poll_id}")
def api_get_poll(poll_id: int, db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user)):
    _ensure_schema(db)
    return chat_service.get_poll(db, poll_id, current_user.id)


@router.post("/polls/{poll_id}/vote")
def api_vote_poll(
    poll_id: int, request: Request, body: PollVoteRequest,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    poll = chat_service.vote_poll(db, poll_id, current_user.id, body.option_ids)
    conv_row = db.get(ChatPoll, poll_id)
    if conv_row:
        _notify(request, chat_service.active_member_ids(db, conv_row.conversation_id), "poll_updated", poll)
    return poll


# ─── scheduled messages ─────────────────────────────────────────────────────

@router.post("/conversations/{conversation_id}/scheduled")
def api_schedule_message(
    conversation_id: int, body: ScheduleMessageRequest,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    row = chat_service.schedule_message(db, conversation_id, current_user.id, body.content,
                                         body.scheduled_for, message_type=body.message_type)
    return {"id": row.id, "scheduled_for": row.scheduled_for, "status": row.status}


@router.get("/conversations/{conversation_id}/scheduled")
def api_list_scheduled(
    conversation_id: int,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    return chat_service.list_scheduled(db, conversation_id, current_user.id)


@router.delete("/scheduled/{scheduled_id}")
def api_cancel_scheduled(
    scheduled_id: int,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    chat_service.cancel_scheduled(db, scheduled_id, current_user.id)
    return {"ok": True}


# ─── reminders ──────────────────────────────────────────────────────────────

@router.post("/messages/{message_id}/reminders")
def api_create_reminder(
    message_id: int, body: ReminderRequest,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    row = chat_service.create_reminder(db, message_id, current_user.id, body.remind_at, body.note)
    return {"id": row.id, "remind_at": row.remind_at}


@router.get("/reminders/due")
def api_due_reminders(db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user)):
    _ensure_schema(db)
    return chat_service.list_due_reminders(db, current_user.id)


@router.post("/reminders/{reminder_id}/dismiss")
def api_dismiss_reminder(
    reminder_id: int,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    chat_service.dismiss_reminder(db, reminder_id, current_user.id)
    return {"ok": True}


# ─── drafts ─────────────────────────────────────────────────────────────────

@router.put("/conversations/{conversation_id}/draft")
def api_save_draft(
    conversation_id: int, body: DraftRequest,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    chat_service.save_draft(db, conversation_id, current_user.id, body.content, body.reply_to_message_id)
    return {"ok": True}


@router.get("/drafts")
def api_get_drafts(db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user)):
    _ensure_schema(db)
    return chat_service.get_drafts(db, current_user.id)


# ─── notification preferences ──────────────────────────────────────────────

@router.get("/notification-preferences")
def api_get_notification_prefs(db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user)):
    _ensure_schema(db)
    row = chat_service.get_notification_prefs(db, current_user.id)
    return {
        "in_app_enabled": row.in_app_enabled, "desktop_enabled": row.desktop_enabled,
        "sound_enabled": row.sound_enabled, "mentions_only": row.mentions_only,
    }


@router.patch("/notification-preferences")
def api_update_notification_prefs(
    body: NotificationPrefsRequest,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    row = chat_service.update_notification_prefs(db, current_user.id, **body.model_dump())
    return {
        "in_app_enabled": row.in_app_enabled, "desktop_enabled": row.desktop_enabled,
        "sound_enabled": row.sound_enabled, "mentions_only": row.mentions_only,
    }


# ─── presence ───────────────────────────────────────────────────────────────

@router.get("/presence")
async def api_presence(
    request: Request, user_ids: str = Query(...),
    current_user: User = Depends(get_current_user),
):
    ids = [int(x) for x in user_ids.split(",") if x.strip().isdigit()]
    statuses = await chat_realtime.get_statuses(_tenant_slug(request), ids)
    online_ids = [uid for uid, status in statuses.items() if status != "offline"]
    return {"online_user_ids": sorted(online_ids), "statuses": statuses}


class PresenceStatusRequest(BaseModel):
    status: str  # 'online' | 'away' | 'dnd'


@router.patch("/presence/status")
async def api_set_presence_status(
    request: Request, body: PresenceStatusRequest,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    if body.status not in chat_realtime.VALID_STATUSES:
        raise HTTPException(400, "status must be one of: online, away, dnd")
    slug = _tenant_slug(request)
    await chat_realtime.set_status(slug, current_user.id, body.status)
    # Push instantly to everyone who'd show this user's dot — don't make them wait for
    # the next 20s presence poll (TeamChatPage.tsx) to notice an Away/DND change.
    peers = chat_service.conversation_peer_ids(db, current_user.id)
    await chat_realtime.publish_event(slug, peers, {
        "type": "presence_updated", "data": {"user_id": current_user.id, "status": body.status},
    })
    return {"status": body.status}


# ─── audit log (admin/compliance view) ─────────────────────────────────────

@router.get("/conversations/{conversation_id}/audit-log")
def api_audit_log(
    conversation_id: int,
    db: Session = Depends(get_tenant_db), current_user: User = Depends(get_current_user),
):
    _ensure_schema(db)
    member = chat_service.require_member(db, conversation_id, current_user.id)
    if member.member_role not in ("owner", "admin"):
        raise HTTPException(403, "Only a group admin can view the audit log")
    rows = db.query(ChatAuditLog).filter(ChatAuditLog.conversation_id == conversation_id) \
        .order_by(ChatAuditLog.created_at.desc()).limit(200).all()
    return [{
        "id": r.id, "actor_id": r.actor_id, "action": r.action,
        "target_user_id": r.target_user_id, "details": r.details, "created_at": r.created_at,
    } for r in rows]


# ─── WebSocket ──────────────────────────────────────────────────────────────

async def _authenticate_ws(websocket: WebSocket) -> Optional[tuple[User, Session, str]]:
    """Mirrors app.dependencies.get_current_user, adapted for WebSocket:
    browsers cannot set an Authorization header on a WS upgrade, so the access
    token and tenant slug travel as query params instead (still only ever over
    WSS in production, per the deployment notes)."""
    token = websocket.query_params.get("token")
    tenant_slug = websocket.query_params.get("tenant")
    if not token or not tenant_slug:
        await websocket.close(code=4401)
        return None

    master_db = MasterSessionLocal()
    try:
        tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    finally:
        master_db.close()
    if not tenant:
        await websocket.close(code=4404)
        return None

    payload = verify_token(token, "access")
    if not payload:
        await websocket.close(code=4401)
        return None
    try:
        if int(payload["tenant_id"]) != tenant.id:
            await websocket.close(code=4401)
            return None
    except (KeyError, TypeError, ValueError):
        await websocket.close(code=4401)
        return None

    db = get_tenant_session(tenant.slug)
    db.info["tenant_slug"] = tenant.slug
    try:
        user = db.query(User).filter(User.id == int(payload["sub"]), User.is_active == True).first()
        if not user:
            await websocket.close(code=4401)
            db.close()
            return None
        ensure_token_session_is_active(payload, tenant, user, db)
    except HTTPException:
        await websocket.close(code=4401)
        db.close()
        return None
    return user, db, tenant.slug


@router.websocket("/ws")
async def chat_websocket(websocket: WebSocket):
    await websocket.accept()
    auth = await _authenticate_ws(websocket)
    if not auth:
        return
    user, db, tenant_slug = auth
    try:
        ensure_chat_schema(db)
        await chat_realtime.manager.connect(tenant_slug, user.id, websocket)
        await chat_realtime.ensure_subscribed(tenant_slug)
        await chat_realtime.mark_online(tenant_slug, user.id)
        # Tell everyone who shares a conversation with this user right away — don't make
        # them wait for the next presence poll to see the dot turn from grey to colored.
        peers = chat_service.conversation_peer_ids(db, user.id)
        statuses = await chat_realtime.get_statuses(tenant_slug, [user.id])
        await chat_realtime.publish_event(tenant_slug, peers, {
            "type": "presence_updated", "data": {"user_id": user.id, "status": statuses.get(user.id, "online")},
        })

        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            kind = msg.get("type")

            if kind == "ping":
                await chat_realtime.mark_online(tenant_slug, user.id)
                await websocket.send_text(json.dumps({"type": "pong"}))

            elif kind == "typing":
                conversation_id = msg.get("conversation_id")
                if conversation_id:
                    try:
                        chat_service.require_member(db, conversation_id, user.id)
                    except HTTPException:
                        continue
                    members = [m for m in chat_service.active_member_ids(db, conversation_id) if m != user.id]
                    await chat_realtime.publish_event(tenant_slug, members, {
                        "type": "typing", "data": {
                            "conversation_id": conversation_id, "user_id": user.id,
                            "is_typing": bool(msg.get("is_typing")),
                        },
                    })
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # pragma: no cover
        logger.warning("Team Chat websocket error for user %s: %s", user.id, exc)
    finally:
        await chat_realtime.manager.disconnect(tenant_slug, user.id, websocket)
        # Only announce "offline" once this was the user's LAST live connection — a
        # second open tab/device should keep them showing online to everyone else.
        if user.id not in chat_realtime.manager.connected_user_ids(tenant_slug):
            try:
                peers = chat_service.conversation_peer_ids(db, user.id)
                await chat_realtime.publish_event(tenant_slug, peers, {
                    "type": "presence_updated", "data": {"user_id": user.id, "status": "offline"},
                })
            except Exception:  # pragma: no cover - best-effort, never block teardown
                pass
        db.close()
