"""Team Chat business logic — conversations, messages, attachments, reactions,
read receipts, pins/bookmarks, polls, scheduled messages, reminders, drafts,
notification preferences, audit log and search.

Query-count discipline (section 3.A of the brief): every list endpoint here
is written as a small, fixed number of queries regardless of how many rows
come back — joins/subqueries instead of per-row lookups, and the N+1-prone
spots are called out inline.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import HTTPException, status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.core.chat_encryption import decrypt_text, encrypt_text
from app.core.timezone import now_ist
from app.models.all_models import User
from app.models.chat_models import (
    ChatAttachment, ChatAuditLog, ChatBookmark, ChatConversation,
    ChatConversationMember, ChatMessage, ChatMessageDraft, ChatMessageReaction,
    ChatMessageReminder, ChatMessageThread, ChatNotificationPreference,
    ChatPinnedMessage, ChatPoll, ChatPollOption, ChatPollVote, ChatReadReceipt,
    ChatScheduledMessage,
)

MAX_MESSAGE_LENGTH = 8000
MAX_PAGE_SIZE = 100
DEFAULT_PAGE_SIZE = 40


# ─── small helpers ──────────────────────────────────────────────────────────

def _encrypt(text_value: str) -> tuple[Optional[str], Optional[str], Optional[int]]:
    if text_value is None:
        return None, None, None
    payload = encrypt_text(text_value)
    return payload.ciphertext_b64, payload.nonce_b64, payload.key_version


def decrypt_message_content(message: ChatMessage) -> str:
    if not message.content_cipher:
        return ""
    return decrypt_text(message.content_cipher, message.content_nonce, message.content_key_version)


def _audit(db: Session, *, conversation_id: Optional[int], actor_id: Optional[int], action: str,
           target_user_id: Optional[int] = None, details: Optional[dict] = None) -> None:
    db.add(ChatAuditLog(
        conversation_id=conversation_id, actor_id=actor_id, action=action,
        target_user_id=target_user_id, details=details,
    ))


def require_member(db: Session, conversation_id: int, user_id: int) -> ChatConversationMember:
    member = db.query(ChatConversationMember).filter(
        ChatConversationMember.conversation_id == conversation_id,
        ChatConversationMember.user_id == user_id,
        ChatConversationMember.left_at.is_(None),
    ).first()
    if not member:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a member of this conversation")
    return member


def get_conversation_or_404(db: Session, conversation_id: int) -> ChatConversation:
    conv = db.get(ChatConversation, conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


def active_member_ids(db: Session, conversation_id: int) -> list[int]:
    rows = db.query(ChatConversationMember.user_id).filter(
        ChatConversationMember.conversation_id == conversation_id,
        ChatConversationMember.left_at.is_(None),
    ).all()
    return [r[0] for r in rows]


def conversation_peer_ids(db: Session, user_id: int) -> list[int]:
    """Every other user who shares at least one active conversation with `user_id` —
    the audience for presence_updated (see chat_router.py), so an online/away/dnd
    change reaches instantly only the people who'd actually show that user's dot,
    not the whole tenant."""
    my_conv_ids = db.query(ChatConversationMember.conversation_id).filter(
        ChatConversationMember.user_id == user_id, ChatConversationMember.left_at.is_(None),
    ).subquery()
    rows = db.query(ChatConversationMember.user_id).filter(
        ChatConversationMember.conversation_id.in_(select(my_conv_ids.c.conversation_id)),
        ChatConversationMember.user_id != user_id,
        ChatConversationMember.left_at.is_(None),
    ).distinct().all()
    return [r[0] for r in rows]


# ─── conversations ──────────────────────────────────────────────────────────

def get_or_create_dm(db: Session, user_id: int, other_user_id: int) -> ChatConversation:
    if user_id == other_user_id:
        raise HTTPException(400, "Cannot start a chat with yourself")
    other = db.get(User, other_user_id)
    if not other or not other.is_active:
        raise HTTPException(404, "User not found")

    # Find an existing DM between exactly these two members in one query:
    # conversations of type 'dm' where both users are active members.
    m1 = db.query(ChatConversationMember.conversation_id).filter(
        ChatConversationMember.user_id == user_id, ChatConversationMember.left_at.is_(None),
    ).subquery()
    m2 = db.query(ChatConversationMember.conversation_id).filter(
        ChatConversationMember.user_id == other_user_id, ChatConversationMember.left_at.is_(None),
    ).subquery()
    existing = db.query(ChatConversation).filter(
        ChatConversation.type == "dm",
        ChatConversation.id.in_(select(m1.c.conversation_id)),
        ChatConversation.id.in_(select(m2.c.conversation_id)),
    ).first()
    if existing:
        return existing

    conv = ChatConversation(type="dm", is_private=True, created_by=user_id)
    db.add(conv)
    db.flush()
    db.add(ChatConversationMember(conversation_id=conv.id, user_id=user_id, member_role="owner"))
    db.add(ChatConversationMember(conversation_id=conv.id, user_id=other_user_id, member_role="member"))
    _audit(db, conversation_id=conv.id, actor_id=user_id, action="dm_created", target_user_id=other_user_id)
    db.commit()
    db.refresh(conv)
    return conv


def create_group(db: Session, creator_id: int, name: str, member_ids: list[int],
                  *, description: str = "", is_private: bool = True) -> ChatConversation:
    name = (name or "").strip()
    if not name:
        raise HTTPException(400, "Group name is required")
    member_ids = sorted({creator_id, *[m for m in member_ids if m]})
    valid_count = db.query(func.count(User.id)).filter(User.id.in_(member_ids), User.is_active == True).scalar()
    if valid_count != len(member_ids):
        raise HTTPException(400, "One or more selected members are invalid")

    conv = ChatConversation(type="group", name=name, description=description or None,
                             is_private=is_private, created_by=creator_id)
    db.add(conv)
    db.flush()
    for uid in member_ids:
        db.add(ChatConversationMember(
            conversation_id=conv.id, user_id=uid,
            member_role="owner" if uid == creator_id else "member",
        ))
    _audit(db, conversation_id=conv.id, actor_id=creator_id, action="group_created",
           details={"name": name, "member_ids": member_ids})
    db.commit()
    db.refresh(conv)
    return conv


def list_conversations(db: Session, user_id: int, *, kind: Optional[str] = None,
                        unread_only: bool = False, search: Optional[str] = None) -> list[dict]:
    """One pass, no per-conversation follow-up queries:
    - base: this user's memberships joined to their conversations
    - other_member subquery: the DM counterpart's name/avatar for every 'dm' row at once
    - unread subquery: COUNT of messages with id > last_read_message_id, grouped by conversation,
      computed for every conversation in one aggregate query instead of one COUNT per row.
    """
    mem = ChatConversationMember
    conv = ChatConversation

    rows = (
        db.query(mem, conv)
        .join(conv, conv.id == mem.conversation_id)
        .filter(mem.user_id == user_id, mem.left_at.is_(None))
    )
    if kind in ("dm", "group"):
        rows = rows.filter(conv.type == kind)
    # `search` is NOT applied here: ChatConversation.name is only ever set for groups —
    # a DM's display name comes from the OTHER member's User.full_name, resolved below.
    # Filtering on conv.name.ilike() at this point would silently drop every DM from
    # search results. It's applied to the resolved display name at the end instead.
    # MariaDB/MySQL sort NULL as the lowest value, so plain DESC already puts NULLs
    # last here — .nullslast() emits "NULLS LAST", which MariaDB's SQL parser rejects.
    rows = rows.order_by(conv.last_message_at.desc(), conv.created_at.desc()).all()

    conv_ids = [c.id for _, c in rows]
    if not conv_ids:
        return []

    # Unread counts for every conversation in ONE aggregated query (not one COUNT per row):
    # each conversation contributes an (id == conv_id AND id > its own watermark) clause,
    # OR'd together, then grouped by conversation_id.
    unread_map: dict[int, int] = {c.id: 0 for _, c in rows}
    watermark_conditions = [
        and_(ChatMessage.conversation_id == c.id, ChatMessage.id > (m.last_read_message_id or 0))
        for m, c in rows
    ]
    if watermark_conditions:
        unread_rows = (
            db.query(ChatMessage.conversation_id, func.count(ChatMessage.id))
            .filter(or_(*watermark_conditions), ChatMessage.is_deleted.is_(False),
                     ChatMessage.sender_id != user_id)
            .group_by(ChatMessage.conversation_id)
            .all()
        )
        for conv_id, count in unread_rows:
            unread_map[conv_id] = count or 0

    # DM counterpart names in one query instead of one per row.
    dm_ids = [c.id for _, c in rows if c.type == "dm"]
    other_names: dict[int, dict] = {}
    if dm_ids:
        others = (
            db.query(mem.conversation_id, User.id, User.full_name, User.avatar_url)
            .join(User, User.id == mem.user_id)
            .filter(mem.conversation_id.in_(dm_ids), mem.user_id != user_id, mem.left_at.is_(None))
            .all()
        )
        for cid, uid, full_name, avatar_url in others:
            other_names[cid] = {"user_id": uid, "name": full_name, "avatar_url": avatar_url}

    needle = search.strip().lower() if search else None
    out = []
    for m, c in rows:
        if unread_only and unread_map.get(c.id, 0) == 0:
            continue
        display_name = c.name if c.type == "group" else (other_names.get(c.id) or {}).get("name")
        if needle and needle not in (display_name or "").lower():
            continue
        out.append({
            "id": c.id, "type": c.type,
            "name": display_name,
            "avatar_url": c.avatar_url if c.type == "group" else (other_names.get(c.id) or {}).get("avatar_url"),
            "dm_user_id": (other_names.get(c.id) or {}).get("user_id") if c.type == "dm" else None,
            "description": c.description,
            "is_private": c.is_private,
            "announcement_mode": c.announcement_mode,
            "last_message_at": c.last_message_at,
            "last_message_preview": c.last_message_preview,
            "member_role": m.member_role,
            "is_pinned": m.is_pinned,
            "is_archived": m.is_archived,
            "muted_until": m.muted_until,
            "unread_count": unread_map.get(c.id, 0),
        })
    # Pinned conversations first, newest activity first within each group.
    out.sort(key=lambda r: (r["is_pinned"], r["last_message_at"] or datetime.min), reverse=True)
    return out


def set_member_flag(db: Session, conversation_id: int, user_id: int, *, pinned=None, archived=None,
                     muted_until: Any = "__unset__") -> ChatConversationMember:
    member = require_member(db, conversation_id, user_id)
    if pinned is not None:
        member.is_pinned = pinned
    if archived is not None:
        member.is_archived = archived
    if muted_until != "__unset__":
        member.muted_until = muted_until
    db.commit()
    return member


def update_group(db: Session, conversation_id: int, actor_id: int, *, name: Optional[str] = None,
                  description: Optional[str] = None, avatar_url: Optional[str] = None,
                  is_private: Optional[bool] = None, announcement_mode: Optional[bool] = None) -> ChatConversation:
    conv = get_conversation_or_404(db, conversation_id)
    if conv.type != "group":
        raise HTTPException(400, "Only group conversations can be edited")
    member = require_member(db, conversation_id, actor_id)
    if member.member_role not in ("owner", "admin"):
        raise HTTPException(403, "Only a group admin can change group settings")

    changes: dict[str, Any] = {}
    if name is not None and name.strip() and name.strip() != conv.name:
        changes["name"] = [conv.name, name.strip()]
        conv.name = name.strip()
    if description is not None and description != conv.description:
        conv.description = description
    if avatar_url is not None and avatar_url != conv.avatar_url:
        conv.avatar_url = avatar_url
    if is_private is not None:
        conv.is_private = is_private
    if announcement_mode is not None and announcement_mode != conv.announcement_mode:
        changes["announcement_mode"] = announcement_mode
        conv.announcement_mode = announcement_mode
    conv.updated_at = now_ist()
    if changes:
        _audit(db, conversation_id=conv.id, actor_id=actor_id, action="group_updated", details=changes)
    db.commit()
    db.refresh(conv)
    return conv


def add_members(db: Session, conversation_id: int, actor_id: int, user_ids: list[int]) -> list[int]:
    conv = get_conversation_or_404(db, conversation_id)
    if conv.type != "group":
        raise HTTPException(400, "Only groups support multiple members")
    actor = require_member(db, conversation_id, actor_id)
    if actor.member_role not in ("owner", "admin"):
        raise HTTPException(403, "Only a group admin can add members")

    existing = set(active_member_ids(db, conversation_id))
    to_add = [uid for uid in set(user_ids) if uid not in existing]
    if not to_add:
        return []
    valid_count = db.query(func.count(User.id)).filter(User.id.in_(to_add), User.is_active == True).scalar()
    if valid_count != len(to_add):
        raise HTTPException(400, "One or more selected members are invalid")
    for uid in to_add:
        rejoining = db.query(ChatConversationMember).filter(
            ChatConversationMember.conversation_id == conversation_id, ChatConversationMember.user_id == uid,
        ).first()
        if rejoining:
            rejoining.left_at = None
            rejoining.member_role = "member"
        else:
            db.add(ChatConversationMember(conversation_id=conversation_id, user_id=uid, member_role="member"))
        _audit(db, conversation_id=conversation_id, actor_id=actor_id, action="member_added", target_user_id=uid)
    db.commit()
    return to_add


def remove_member(db: Session, conversation_id: int, actor_id: int, user_id: int) -> None:
    conv = get_conversation_or_404(db, conversation_id)
    actor = require_member(db, conversation_id, actor_id)
    if user_id != actor_id and actor.member_role not in ("owner", "admin"):
        raise HTTPException(403, "Only a group admin can remove other members")
    target = db.query(ChatConversationMember).filter(
        ChatConversationMember.conversation_id == conversation_id, ChatConversationMember.user_id == user_id,
        ChatConversationMember.left_at.is_(None),
    ).first()
    if not target:
        raise HTTPException(404, "Member not found")
    target.left_at = now_ist()
    _audit(db, conversation_id=conversation_id, actor_id=actor_id,
           action="member_left" if user_id == actor_id else "member_removed", target_user_id=user_id)
    db.commit()


def set_member_role(db: Session, conversation_id: int, actor_id: int, user_id: int, role: str) -> None:
    if role not in ("admin", "member"):
        raise HTTPException(400, "Invalid role")
    actor = require_member(db, conversation_id, actor_id)
    if actor.member_role != "owner":
        raise HTTPException(403, "Only the group owner can change admin roles")
    target = db.query(ChatConversationMember).filter(
        ChatConversationMember.conversation_id == conversation_id, ChatConversationMember.user_id == user_id,
        ChatConversationMember.left_at.is_(None),
    ).first()
    if not target or target.member_role == "owner":
        raise HTTPException(404, "Member not found")
    target.member_role = role
    _audit(db, conversation_id=conversation_id, actor_id=actor_id, action="permission_changed",
           target_user_id=user_id, details={"role": role})
    db.commit()


def delete_group(db: Session, conversation_id: int, actor_id: int) -> None:
    conv = get_conversation_or_404(db, conversation_id)
    if conv.type != "group":
        raise HTTPException(400, "Only groups can be deleted this way")
    actor = require_member(db, conversation_id, actor_id)
    if actor.member_role != "owner":
        raise HTTPException(403, "Only the group owner can delete the group")
    _audit(db, conversation_id=conversation_id, actor_id=actor_id, action="group_deleted")
    db.query(ChatMessage).filter(ChatMessage.conversation_id == conversation_id).update({"is_deleted": True})
    db.delete(conv)
    db.commit()


def list_members(db: Session, conversation_id: int, user_id: int) -> list[dict]:
    require_member(db, conversation_id, user_id)
    rows = (
        db.query(ChatConversationMember, User)
        .join(User, User.id == ChatConversationMember.user_id)
        .filter(ChatConversationMember.conversation_id == conversation_id, ChatConversationMember.left_at.is_(None))
        .all()
    )
    return [{
        "user_id": u.id, "name": u.full_name, "avatar_url": u.avatar_url,
        "role": m.member_role, "joined_at": m.joined_at,
    } for m, u in rows]


# ─── messages ───────────────────────────────────────────────────────────────

def _require_can_post(db: Session, conv: ChatConversation, member: ChatConversationMember) -> None:
    if conv.announcement_mode and member.member_role not in ("owner", "admin"):
        raise HTTPException(403, "This group is announcement-only — only admins can post")


def send_message(db: Session, conversation_id: int, sender_id: int, *, content: str = "",
                  message_type: str = "text", reply_to_message_id: Optional[int] = None,
                  mentions: Optional[list[int]] = None, extra_data: Optional[dict] = None,
                  client_token: Optional[str] = None) -> ChatMessage:
    conv = get_conversation_or_404(db, conversation_id)
    member = require_member(db, conversation_id, sender_id)
    _require_can_post(db, conv, member)
    if content and len(content) > MAX_MESSAGE_LENGTH:
        raise HTTPException(400, f"Message exceeds {MAX_MESSAGE_LENGTH} characters")

    if client_token:
        existing = db.query(ChatMessage).filter(
            ChatMessage.conversation_id == conversation_id, ChatMessage.client_token == client_token,
        ).first()
        if existing:
            return existing  # idempotent resend after a dropped ack / reconnect

    thread_root_id = None
    if reply_to_message_id:
        parent = db.get(ChatMessage, reply_to_message_id)
        if not parent or parent.conversation_id != conversation_id:
            raise HTTPException(400, "Invalid reply target")
        thread_root_id = parent.thread_root_id or parent.id

    cipher, nonce, version = _encrypt(content or "")
    msg = ChatMessage(
        conversation_id=conversation_id, sender_id=sender_id, message_type=message_type,
        content_cipher=cipher, content_nonce=nonce, content_key_version=version,
        reply_to_message_id=reply_to_message_id, thread_root_id=thread_root_id,
        mentions=mentions or None, extra_data=extra_data or None, client_token=client_token,
    )
    db.add(msg)
    db.flush()

    if thread_root_id:
        thread = db.query(ChatMessageThread).filter(ChatMessageThread.root_message_id == thread_root_id).first()
        if not thread:
            thread = ChatMessageThread(conversation_id=conversation_id, root_message_id=thread_root_id, reply_count=0)
            db.add(thread)
        thread.reply_count = (thread.reply_count or 0) + 1
        thread.last_reply_at = msg.created_at
        thread.last_reply_by = sender_id

    preview = _preview_text(message_type, content)
    conv.last_message_at = msg.created_at
    conv.last_message_preview = preview
    db.commit()
    db.refresh(msg)
    return msg


def _preview_text(message_type: str, content: str) -> str:
    if message_type == "file":
        return "📎 Sent an attachment"
    if message_type == "image":
        return "📷 Sent a photo"
    if message_type == "poll":
        return "📊 Created a poll"
    if message_type == "crm_record":
        return "🔗 Shared a CRM record"
    text = (content or "").strip().replace("\n", " ")
    return text[:120]


def edit_message(db: Session, message_id: int, user_id: int, new_content: str) -> ChatMessage:
    msg = db.get(ChatMessage, message_id)
    if not msg or msg.is_deleted:
        raise HTTPException(404, "Message not found")
    require_member(db, msg.conversation_id, user_id)
    if msg.sender_id != user_id:
        raise HTTPException(403, "You can only edit your own messages")
    if msg.message_type != "text":
        raise HTTPException(400, "Only text messages can be edited")
    cipher, nonce, version = _encrypt(new_content or "")
    msg.content_cipher, msg.content_nonce, msg.content_key_version = cipher, nonce, version
    msg.is_edited = True
    msg.edited_at = now_ist()
    db.commit()
    db.refresh(msg)
    return msg


def delete_message(db: Session, message_id: int, user_id: int, *, can_delete_any: bool = False) -> ChatMessage:
    msg = db.get(ChatMessage, message_id)
    if not msg or msg.is_deleted:
        raise HTTPException(404, "Message not found")
    require_member(db, msg.conversation_id, user_id)
    if msg.sender_id != user_id and not can_delete_any:
        raise HTTPException(403, "You can only delete your own messages")
    msg.is_deleted = True
    msg.deleted_at = now_ist()
    msg.deleted_by = user_id
    msg.content_cipher = None
    msg.content_nonce = None
    _audit(db, conversation_id=msg.conversation_id, actor_id=user_id, action="message_deleted",
           details={"message_id": message_id})
    db.commit()
    db.refresh(msg)
    return msg


def forward_message(db: Session, message_id: int, user_id: int, target_conversation_ids: list[int]) -> list[ChatMessage]:
    source = db.get(ChatMessage, message_id)
    if not source or source.is_deleted:
        raise HTTPException(404, "Message not found")
    require_member(db, source.conversation_id, user_id)
    content = decrypt_message_content(source)
    out = []
    for cid in target_conversation_ids:
        out.append(send_message(
            db, cid, user_id, content=content, message_type=source.message_type,
            extra_data={**(source.extra_data or {}), "forwarded": True},
        ))
        fwd = out[-1]
        fwd.forwarded_from_message_id = source.id
    db.commit()
    return out


def list_messages(db: Session, conversation_id: int, user_id: int, *, before_id: Optional[int] = None,
                   limit: int = DEFAULT_PAGE_SIZE) -> list[dict]:
    require_member(db, conversation_id, user_id)
    limit = max(1, min(limit, MAX_PAGE_SIZE))
    q = db.query(ChatMessage).filter(ChatMessage.conversation_id == conversation_id)
    if before_id:
        q = q.filter(ChatMessage.id < before_id)
    rows = q.order_by(ChatMessage.id.desc()).limit(limit).all()
    return hydrate_messages(db, rows, user_id)


def hydrate_messages(db: Session, rows: list[ChatMessage], viewer_id: int) -> list[dict]:
    """Batch-load everything these messages reference (senders, attachments,
    reactions, read-by) in a handful of queries total, not one per message."""
    if not rows:
        return []
    ids = [m.id for m in rows]
    sender_ids = {m.sender_id for m in rows if m.sender_id}

    senders = {u.id: u for u in db.query(User).filter(User.id.in_(sender_ids)).all()} if sender_ids else {}
    attachments = db.query(ChatAttachment).filter(ChatAttachment.message_id.in_(ids)).all()
    attach_by_msg: dict[int, list] = {}
    for a in attachments:
        attach_by_msg.setdefault(a.message_id, []).append(a)

    reactions = db.query(ChatMessageReaction).filter(ChatMessageReaction.message_id.in_(ids)).all()
    react_by_msg: dict[int, list] = {}
    for r in reactions:
        react_by_msg.setdefault(r.message_id, []).append(r)

    pinned_ids = {
        row[0] for row in db.query(ChatPinnedMessage.message_id).filter(ChatPinnedMessage.message_id.in_(ids)).all()
    }
    bookmarked_ids = {
        row[0] for row in db.query(ChatBookmark.message_id).filter(
            ChatBookmark.message_id.in_(ids), ChatBookmark.user_id == viewer_id).all()
    }

    conv_id = rows[0].conversation_id
    member_count = db.query(func.count(ChatConversationMember.id)).filter(
        ChatConversationMember.conversation_id == conv_id, ChatConversationMember.left_at.is_(None)).scalar() or 1
    max_read_per_message = {}
    if member_count:
        read_counts = (
            db.query(ChatConversationMember.last_read_message_id, func.count(ChatConversationMember.id))
            .filter(ChatConversationMember.conversation_id == conv_id, ChatConversationMember.left_at.is_(None))
            .group_by(ChatConversationMember.last_read_message_id)
            .all()
        )
        # read_by_count(message_id) = members whose last_read_message_id >= message_id
        watermarks = sorted([(wm or 0, cnt) for wm, cnt in read_counts], reverse=True)
        for mid in ids:
            max_read_per_message[mid] = sum(cnt for wm, cnt in watermarks if wm >= mid)

    out = []
    for m in rows:
        sender = senders.get(m.sender_id)
        out.append({
            "id": m.id, "conversation_id": m.conversation_id,
            "sender_id": m.sender_id, "sender_name": sender.full_name if sender else None,
            "sender_avatar_url": sender.avatar_url if sender else None,
            "message_type": m.message_type,
            "content": "" if m.is_deleted else decrypt_message_content(m),
            "is_deleted": m.is_deleted, "is_edited": m.is_edited,
            "reply_to_message_id": m.reply_to_message_id, "thread_root_id": m.thread_root_id,
            "forwarded_from_message_id": m.forwarded_from_message_id,
            "mentions": m.mentions, "extra_data": m.extra_data,
            "created_at": m.created_at, "edited_at": m.edited_at,
            "is_pinned": m.id in pinned_ids, "is_bookmarked": m.id in bookmarked_ids,
            "read_by_count": max_read_per_message.get(m.id, 0) - (1 if sender else 0),
            "member_count": member_count,
            "attachments": [{
                "id": a.id, "name": a.original_name, "content_type": a.content_type,
                "size_bytes": a.size_bytes, "is_image": a.is_image,
                "url": f"/api/v1/team-chat/attachments/{a.id}/download",
            } for a in attach_by_msg.get(m.id, [])],
            "reactions": _summarize_reactions(react_by_msg.get(m.id, []), viewer_id),
        })
    return out


def _summarize_reactions(reactions: list[ChatMessageReaction], viewer_id: int) -> list[dict]:
    by_emoji: dict[str, dict] = {}
    for r in reactions:
        entry = by_emoji.setdefault(r.emoji, {"emoji": r.emoji, "count": 0, "reacted_by_me": False})
        entry["count"] += 1
        if r.user_id == viewer_id:
            entry["reacted_by_me"] = True
    return list(by_emoji.values())


def search_messages(db: Session, user_id: int, query: str, *, conversation_id: Optional[int] = None,
                     limit: int = 50) -> list[dict]:
    """Scoped, bounded decryption: only decrypts messages in conversations the
    caller is a member of, and only up to `limit` candidate rows — never the
    whole corpus — so this never needs a separate plaintext search index that
    would undermine encryption-at-rest."""
    query = (query or "").strip()
    if len(query) < 2:
        return []
    my_conv_ids = [r[0] for r in db.query(ChatConversationMember.conversation_id).filter(
        ChatConversationMember.user_id == user_id, ChatConversationMember.left_at.is_(None)).all()]
    if conversation_id:
        if conversation_id not in my_conv_ids:
            raise HTTPException(403, "Not a member of this conversation")
        my_conv_ids = [conversation_id]
    if not my_conv_ids:
        return []

    candidates = (
        db.query(ChatMessage)
        .filter(ChatMessage.conversation_id.in_(my_conv_ids), ChatMessage.is_deleted.is_(False),
                 ChatMessage.message_type == "text")
        .order_by(ChatMessage.id.desc())
        .limit(2000)  # bounded decrypt window, newest-first
        .all()
    )
    needle = query.lower()
    matched = []
    for m in candidates:
        if needle in decrypt_message_content(m).lower():
            matched.append(m)
        if len(matched) >= limit:
            break
    return hydrate_messages(db, matched, user_id)


# ─── read receipts / unread ─────────────────────────────────────────────────

def mark_read(db: Session, conversation_id: int, user_id: int, up_to_message_id: int) -> None:
    member = require_member(db, conversation_id, user_id)
    if member.last_read_message_id and member.last_read_message_id >= up_to_message_id:
        return
    member.last_read_message_id = up_to_message_id
    member.last_read_at = now_ist()
    existing = db.query(ChatReadReceipt).filter(
        ChatReadReceipt.message_id == up_to_message_id, ChatReadReceipt.user_id == user_id,
    ).first()
    if existing:
        existing.read_at = now_ist()
    else:
        db.add(ChatReadReceipt(conversation_id=conversation_id, message_id=up_to_message_id,
                                user_id=user_id, read_at=now_ist(), delivered_at=now_ist()))
    db.commit()


def unread_total(db: Session, user_id: int) -> int:
    memberships = db.query(ChatConversationMember).filter(
        ChatConversationMember.user_id == user_id, ChatConversationMember.left_at.is_(None),
    ).all()
    if not memberships:
        return 0
    total = 0
    for m in memberships:
        watermark = m.last_read_message_id or 0
        total += db.query(func.count(ChatMessage.id)).filter(
            ChatMessage.conversation_id == m.conversation_id, ChatMessage.id > watermark,
            ChatMessage.is_deleted.is_(False), ChatMessage.sender_id != user_id,
        ).scalar() or 0
    return total


# ─── reactions ──────────────────────────────────────────────────────────────

def toggle_reaction(db: Session, message_id: int, user_id: int, emoji: str) -> dict:
    msg = db.get(ChatMessage, message_id)
    if not msg or msg.is_deleted:
        raise HTTPException(404, "Message not found")
    require_member(db, msg.conversation_id, user_id)
    existing = db.query(ChatMessageReaction).filter(
        ChatMessageReaction.message_id == message_id, ChatMessageReaction.user_id == user_id,
        ChatMessageReaction.emoji == emoji,
    ).first()
    if existing:
        db.delete(existing)
        db.commit()
        return {"message_id": message_id, "emoji": emoji, "active": False}
    db.add(ChatMessageReaction(message_id=message_id, user_id=user_id, emoji=emoji))
    db.commit()
    return {"message_id": message_id, "emoji": emoji, "active": True}


# ─── pins / bookmarks ───────────────────────────────────────────────────────

def toggle_pin(db: Session, conversation_id: int, message_id: int, user_id: int) -> bool:
    require_member(db, conversation_id, user_id)
    existing = db.query(ChatPinnedMessage).filter(
        ChatPinnedMessage.conversation_id == conversation_id, ChatPinnedMessage.message_id == message_id,
    ).first()
    if existing:
        db.delete(existing)
        db.commit()
        return False
    db.add(ChatPinnedMessage(conversation_id=conversation_id, message_id=message_id, pinned_by=user_id))
    _audit(db, conversation_id=conversation_id, actor_id=user_id, action="message_pinned",
           details={"message_id": message_id})
    db.commit()
    return True


def list_pinned(db: Session, conversation_id: int, user_id: int) -> list[dict]:
    require_member(db, conversation_id, user_id)
    ids = [r[0] for r in db.query(ChatPinnedMessage.message_id).filter(
        ChatPinnedMessage.conversation_id == conversation_id).order_by(ChatPinnedMessage.pinned_at.desc()).all()]
    rows = db.query(ChatMessage).filter(ChatMessage.id.in_(ids)).all() if ids else []
    rows_by_id = {m.id: m for m in rows}
    ordered = [rows_by_id[i] for i in ids if i in rows_by_id]
    return hydrate_messages(db, ordered, user_id)


def toggle_bookmark(db: Session, message_id: int, user_id: int, note: Optional[str] = None) -> bool:
    msg = db.get(ChatMessage, message_id)
    if not msg:
        raise HTTPException(404, "Message not found")
    require_member(db, msg.conversation_id, user_id)
    existing = db.query(ChatBookmark).filter(
        ChatBookmark.message_id == message_id, ChatBookmark.user_id == user_id).first()
    if existing:
        db.delete(existing)
        db.commit()
        return False
    db.add(ChatBookmark(message_id=message_id, user_id=user_id, note=note))
    db.commit()
    return True


def list_bookmarks(db: Session, user_id: int) -> list[dict]:
    ids = [r[0] for r in db.query(ChatBookmark.message_id).filter(ChatBookmark.user_id == user_id)
           .order_by(ChatBookmark.created_at.desc()).all()]
    rows = db.query(ChatMessage).filter(ChatMessage.id.in_(ids)).all() if ids else []
    rows_by_id = {m.id: m for m in rows}
    ordered = [rows_by_id[i] for i in ids if i in rows_by_id]
    return hydrate_messages(db, ordered, user_id)


# ─── polls ──────────────────────────────────────────────────────────────────

def create_poll(db: Session, conversation_id: int, user_id: int, question: str, options: list[str],
                 *, is_multi_choice: bool = False, is_anonymous: bool = False,
                 closes_at: Optional[datetime] = None) -> dict:
    options = [o.strip() for o in options if o and o.strip()]
    if len(options) < 2:
        raise HTTPException(400, "A poll needs at least two options")
    msg = send_message(db, conversation_id, user_id, message_type="poll",
                        content=f"Poll: {question}", extra_data={"poll": True})
    poll = ChatPoll(message_id=msg.id, conversation_id=conversation_id, question=question.strip(),
                     is_multi_choice=is_multi_choice, is_anonymous=is_anonymous,
                     created_by=user_id, closes_at=closes_at)
    db.add(poll)
    db.flush()
    for i, opt in enumerate(options):
        db.add(ChatPollOption(poll_id=poll.id, option_text=opt, sort_order=i))
    db.commit()
    return get_poll(db, poll.id, user_id)


def get_poll(db: Session, poll_id: int, user_id: int) -> dict:
    poll = db.get(ChatPoll, poll_id)
    if not poll:
        raise HTTPException(404, "Poll not found")
    require_member(db, poll.conversation_id, user_id)
    options = db.query(ChatPollOption).filter(ChatPollOption.poll_id == poll_id).order_by(ChatPollOption.sort_order).all()
    votes = db.query(ChatPollVote).filter(ChatPollVote.poll_id == poll_id).all()
    votes_by_option: dict[int, int] = {}
    my_votes = set()
    for v in votes:
        votes_by_option[v.option_id] = votes_by_option.get(v.option_id, 0) + 1
        if v.user_id == user_id:
            my_votes.add(v.option_id)
    return {
        "id": poll.id, "message_id": poll.message_id, "question": poll.question,
        "is_multi_choice": poll.is_multi_choice, "is_anonymous": poll.is_anonymous,
        "closed": bool(poll.closed_at) or bool(poll.closes_at and poll.closes_at < now_ist()),
        "total_votes": len(votes),
        "options": [{
            "id": o.id, "text": o.option_text, "votes": votes_by_option.get(o.id, 0),
            "voted_by_me": o.id in my_votes,
        } for o in options],
    }


def vote_poll(db: Session, poll_id: int, user_id: int, option_ids: list[int]) -> dict:
    poll = db.get(ChatPoll, poll_id)
    if not poll:
        raise HTTPException(404, "Poll not found")
    require_member(db, poll.conversation_id, user_id)
    if poll.closed_at or (poll.closes_at and poll.closes_at < now_ist()):
        raise HTTPException(400, "This poll is closed")
    valid_ids = {r[0] for r in db.query(ChatPollOption.id).filter(ChatPollOption.poll_id == poll_id).all()}
    option_ids = [o for o in option_ids if o in valid_ids]
    if not option_ids:
        raise HTTPException(400, "Invalid option")
    if not poll.is_multi_choice:
        option_ids = option_ids[:1]
    db.query(ChatPollVote).filter(ChatPollVote.poll_id == poll_id, ChatPollVote.user_id == user_id).delete()
    for oid in option_ids:
        db.add(ChatPollVote(poll_id=poll_id, option_id=oid, user_id=user_id))
    db.commit()
    return get_poll(db, poll_id, user_id)


# ─── scheduled messages ─────────────────────────────────────────────────────

def schedule_message(db: Session, conversation_id: int, user_id: int, content: str,
                      scheduled_for: datetime, *, message_type: str = "text") -> ChatScheduledMessage:
    require_member(db, conversation_id, user_id)
    if scheduled_for <= now_ist():
        raise HTTPException(400, "Scheduled time must be in the future")
    cipher, nonce, version = _encrypt(content or "")
    row = ChatScheduledMessage(
        conversation_id=conversation_id, sender_id=user_id, message_type=message_type,
        content_cipher=cipher, content_nonce=nonce, content_key_version=version,
        scheduled_for=scheduled_for, status="pending",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def list_scheduled(db: Session, conversation_id: int, user_id: int) -> list[dict]:
    require_member(db, conversation_id, user_id)
    rows = db.query(ChatScheduledMessage).filter(
        ChatScheduledMessage.conversation_id == conversation_id, ChatScheduledMessage.sender_id == user_id,
        ChatScheduledMessage.status == "pending",
    ).order_by(ChatScheduledMessage.scheduled_for).all()
    return [{
        "id": r.id, "conversation_id": r.conversation_id, "scheduled_for": r.scheduled_for,
        "content": decrypt_text(r.content_cipher, r.content_nonce, r.content_key_version),
        "status": r.status,
    } for r in rows]


def cancel_scheduled(db: Session, scheduled_id: int, user_id: int) -> None:
    row = db.get(ChatScheduledMessage, scheduled_id)
    if not row or row.sender_id != user_id or row.status != "pending":
        raise HTTPException(404, "Scheduled message not found")
    row.status = "cancelled"
    db.commit()


def dispatch_due_scheduled_messages(db: Session) -> int:
    """Call periodically (e.g. from the same job runner that drives other
    tenant sweeps) to turn due ChatScheduledMessage rows into real messages."""
    due = db.query(ChatScheduledMessage).filter(
        ChatScheduledMessage.status == "pending", ChatScheduledMessage.scheduled_for <= now_ist(),
    ).all()
    sent = 0
    for row in due:
        try:
            content = decrypt_text(row.content_cipher, row.content_nonce, row.content_key_version)
            msg = send_message(db, row.conversation_id, row.sender_id, content=content,
                                message_type=row.message_type, extra_data=row.extra_data)
            row.status = "sent"
            row.sent_message_id = msg.id
            sent += 1
        except Exception:
            row.status = "failed"
    db.commit()
    return sent


# ─── reminders ──────────────────────────────────────────────────────────────

def create_reminder(db: Session, message_id: int, user_id: int, remind_at: datetime,
                     note: Optional[str] = None) -> ChatMessageReminder:
    msg = db.get(ChatMessage, message_id)
    if not msg:
        raise HTTPException(404, "Message not found")
    require_member(db, msg.conversation_id, user_id)
    row = ChatMessageReminder(user_id=user_id, message_id=message_id, remind_at=remind_at, note=note)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def list_due_reminders(db: Session, user_id: int) -> list[dict]:
    rows = db.query(ChatMessageReminder).filter(
        ChatMessageReminder.user_id == user_id, ChatMessageReminder.status == "pending",
        ChatMessageReminder.remind_at <= now_ist(),
    ).all()
    return [{"id": r.id, "message_id": r.message_id, "note": r.note, "remind_at": r.remind_at} for r in rows]


def dismiss_reminder(db: Session, reminder_id: int, user_id: int) -> None:
    row = db.get(ChatMessageReminder, reminder_id)
    if not row or row.user_id != user_id:
        raise HTTPException(404, "Reminder not found")
    row.status = "dismissed"
    db.commit()


# ─── drafts ─────────────────────────────────────────────────────────────────

def save_draft(db: Session, conversation_id: int, user_id: int, content: str,
                reply_to_message_id: Optional[int] = None) -> None:
    require_member(db, conversation_id, user_id)
    row = db.query(ChatMessageDraft).filter(
        ChatMessageDraft.conversation_id == conversation_id, ChatMessageDraft.user_id == user_id,
    ).first()
    if not content:
        if row:
            db.delete(row)
            db.commit()
        return
    cipher, nonce, version = _encrypt(content)
    if row:
        row.content_cipher, row.content_nonce, row.content_key_version = cipher, nonce, version
        row.reply_to_message_id = reply_to_message_id
    else:
        db.add(ChatMessageDraft(conversation_id=conversation_id, user_id=user_id, content_cipher=cipher,
                                 content_nonce=nonce, content_key_version=version,
                                 reply_to_message_id=reply_to_message_id))
    db.commit()


def get_drafts(db: Session, user_id: int) -> dict[int, dict]:
    rows = db.query(ChatMessageDraft).filter(ChatMessageDraft.user_id == user_id).all()
    return {
        r.conversation_id: {
            "content": decrypt_text(r.content_cipher, r.content_nonce, r.content_key_version),
            "reply_to_message_id": r.reply_to_message_id,
        } for r in rows
    }


# ─── notification preferences ──────────────────────────────────────────────

def get_notification_prefs(db: Session, user_id: int) -> ChatNotificationPreference:
    row = db.query(ChatNotificationPreference).filter(ChatNotificationPreference.user_id == user_id).first()
    if not row:
        row = ChatNotificationPreference(user_id=user_id)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def update_notification_prefs(db: Session, user_id: int, **fields) -> ChatNotificationPreference:
    row = get_notification_prefs(db, user_id)
    for key in ("in_app_enabled", "desktop_enabled", "sound_enabled", "mentions_only"):
        if key in fields and fields[key] is not None:
            setattr(row, key, fields[key])
    db.commit()
    db.refresh(row)
    return row


# ─── shared media / attachments listing ────────────────────────────────────

def list_shared_attachments(db: Session, conversation_id: int, user_id: int, *, kind: Optional[str] = None,
                             search: Optional[str] = None) -> list[dict]:
    require_member(db, conversation_id, user_id)
    q = (
        db.query(ChatAttachment, ChatMessage)
        .join(ChatMessage, ChatMessage.id == ChatAttachment.message_id)
        .filter(ChatMessage.conversation_id == conversation_id, ChatMessage.is_deleted.is_(False))
    )
    if kind == "image":
        q = q.filter(ChatAttachment.is_image.is_(True))
    elif kind == "document":
        q = q.filter(ChatAttachment.is_image.is_(False))
    if search:
        q = q.filter(ChatAttachment.original_name.ilike(f"%{search.strip()}%"))
    rows = q.order_by(ChatAttachment.created_at.desc()).limit(200).all()
    return [{
        "id": a.id, "name": a.original_name, "content_type": a.content_type, "size_bytes": a.size_bytes,
        "is_image": a.is_image, "created_at": a.created_at, "message_id": a.message_id,
        "url": f"/api/v1/team-chat/attachments/{a.id}/download",
    } for a, _m in rows]


# ─── CRM record sharing ─────────────────────────────────────────────────────

CRM_SHARE_MODULES = {"leads", "customers", "quotations", "tenders", "workorders"}


def share_crm_record(db: Session, conversation_id: int, user_id: int, module: str, record_id: int,
                      label: str, ref_number: Optional[str] = None) -> ChatMessage:
    """Shares only a label/reference the caller already has — this function
    never re-checks the CRM record's own permissions itself; the router's
    `require_permission("team_chat.share_crm_records")` plus the caller
    already having loaded that record (via its own permission-gated page) is
    what prevents bypassing record-level access. See chat_router for the note."""
    if module not in CRM_SHARE_MODULES:
        raise HTTPException(400, "Unsupported record type")
    return send_message(db, conversation_id, user_id, message_type="crm_record",
                         content=f"Shared {module}: {label}",
                         extra_data={"module": module, "record_id": record_id, "label": label, "ref_number": ref_number})


# ─── export & retention ─────────────────────────────────────────────────────

def export_conversation(db: Session, conversation_id: int, user_id: int) -> list[dict]:
    require_member(db, conversation_id, user_id)
    rows = db.query(ChatMessage).filter(
        ChatMessage.conversation_id == conversation_id,
    ).order_by(ChatMessage.id.asc()).all()
    hydrated = hydrate_messages(db, rows, user_id)
    _audit(db, conversation_id=conversation_id, actor_id=user_id, action="conversation_exported",
           details={"message_count": len(hydrated)})
    db.commit()
    return hydrated


def set_retention(db: Session, conversation_id: int, actor_id: int, retention_days: Optional[int]) -> None:
    conv = get_conversation_or_404(db, conversation_id)
    actor = require_member(db, conversation_id, actor_id)
    if actor.member_role not in ("owner", "admin"):
        raise HTTPException(403, "Only a group admin can change retention")
    conv.retention_days = retention_days
    _audit(db, conversation_id=conversation_id, actor_id=actor_id, action="retention_changed",
           details={"retention_days": retention_days})
    db.commit()


def run_chat_maintenance_for_all_tenants() -> dict:
    """Registered with platform_jobs (see app/main.py) — same per-tenant loop
    pattern as run_sticky_note_reminders: dispatches due scheduled messages
    and purges messages past their conversation's retention window."""
    import logging
    from app.database import MasterSessionLocal, get_tenant_session_by_db_name
    from app.models.tenant import Tenant
    from app.services.chat_schema import ensure_chat_schema

    logger = logging.getLogger(__name__)
    summary: dict[str, dict[str, int]] = {}
    with MasterSessionLocal() as master:
        tenants = master.query(Tenant).filter(Tenant.status.in_(["active", "trial"])).all()
        for tenant in tenants:
            try:
                with get_tenant_session_by_db_name(tenant.db_name) as db:
                    db.info["tenant_slug"] = tenant.slug
                    ensure_chat_schema(db)
                    sent = dispatch_due_scheduled_messages(db)
                    purged = purge_expired_messages(db)
                    if sent or purged:
                        summary[tenant.slug] = {"scheduled_sent": sent, "purged": purged}
            except Exception:
                logger.exception("Team Chat maintenance failed for tenant %s", tenant.slug)
    return summary


def purge_expired_messages(db: Session) -> int:
    """Soft-deletes messages older than their conversation's retention window.
    Intended to run on the same periodic schedule as other tenant maintenance
    sweeps (see app/services/platform_storage.py's job runner for the existing
    pattern) — not wired to a scheduler here since this project has no
    per-tenant Celery beat entry for chat yet; call it from one."""
    conversations = db.query(ChatConversation).filter(ChatConversation.retention_days.isnot(None)).all()
    purged = 0
    for conv in conversations:
        cutoff = now_ist() - timedelta(days=conv.retention_days)
        result = db.query(ChatMessage).filter(
            ChatMessage.conversation_id == conv.id, ChatMessage.created_at < cutoff,
            ChatMessage.is_deleted.is_(False),
        ).update({"is_deleted": True, "deleted_at": now_ist(), "content_cipher": None}, synchronize_session=False)
        purged += result
    db.commit()
    return purged
