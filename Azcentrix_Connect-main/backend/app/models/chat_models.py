"""Team Chat ORM models (tenant-scoped — created inside each tenant's own database,
like every other TenantBase model; see app/database.py for the per-tenant-DB
isolation model, so none of these tables carry a tenant_id column).

Message/attachment content is stored encrypted (AES-256-GCM, see
app/core/chat_encryption.py) — content_cipher/content_nonce/content_key_version
replace a plain `content` column everywhere a user typed something.

Table list mirrors the brief: chat_conversations, chat_conversation_members,
chat_messages, chat_attachments, chat_message_reactions, chat_read_receipts,
chat_pinned_messages, chat_bookmarks, chat_message_threads, chat_polls,
chat_poll_options, chat_poll_votes, chat_scheduled_messages,
chat_message_reminders, chat_notification_preferences, chat_message_drafts,
chat_audit_logs.
"""
from sqlalchemy import (
    Column, Integer, BigInteger, String, Text, Boolean, DateTime, Numeric,
    JSON, ForeignKey, UniqueConstraint, Index,
)
from sqlalchemy.sql import func
from app.database import TenantBase
from app.core.timezone import now_ist


class ChatConversation(TenantBase):
    __tablename__ = "chat_conversations"
    __table_args__ = (
        Index("ix_chat_conversations_type", "type"),
        Index("ix_chat_conversations_last_message_at", "last_message_at"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    type = Column(String(10), nullable=False, default="dm")  # 'dm' | 'group'
    name = Column(String(150), nullable=True)  # null for DMs — derived from the other member
    description = Column(String(500), nullable=True)
    avatar_url = Column(String(500), nullable=True)
    is_private = Column(Boolean, nullable=False, default=True)  # public/discoverable groups = False
    announcement_mode = Column(Boolean, nullable=False, default=False)  # only admins may post
    retention_days = Column(Integer, nullable=True)  # null = keep forever
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    last_message_at = Column(DateTime, nullable=True)
    last_message_preview = Column(String(180), nullable=True)  # short, non-sensitive label e.g. "Neha: sent a file"
    created_at = Column(DateTime, nullable=False, default=now_ist)
    updated_at = Column(DateTime, nullable=False, default=now_ist, onupdate=now_ist)


class ChatConversationMember(TenantBase):
    __tablename__ = "chat_conversation_members"
    __table_args__ = (
        UniqueConstraint("conversation_id", "user_id", name="uq_chat_member_conv_user"),
        Index("ix_chat_members_user_conv", "user_id", "conversation_id"),
        Index("ix_chat_members_conv", "conversation_id"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    conversation_id = Column(Integer, ForeignKey("chat_conversations.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    member_role = Column(String(10), nullable=False, default="member")  # 'owner' | 'admin' | 'member'
    joined_at = Column(DateTime, nullable=False, default=now_ist)
    left_at = Column(DateTime, nullable=True)
    muted_until = Column(DateTime, nullable=True)  # far-future sentinel = muted indefinitely
    is_pinned = Column(Boolean, nullable=False, default=False)
    is_archived = Column(Boolean, nullable=False, default=False)
    last_read_message_id = Column(BigInteger, nullable=True)  # O(1) unread-count comparison, no per-message scan
    last_read_at = Column(DateTime, nullable=True)
    draft_synced_at = Column(DateTime, nullable=True)


class ChatMessage(TenantBase):
    __tablename__ = "chat_messages"
    __table_args__ = (
        UniqueConstraint("conversation_id", "client_token", name="uq_chat_message_client_token"),
        Index("ix_chat_messages_conv_created", "conversation_id", "created_at", "id"),
        Index("ix_chat_messages_sender_created", "sender_id", "created_at"),
        Index("ix_chat_messages_thread_root", "thread_root_id"),
        {"extend_existing": True},
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    conversation_id = Column(Integer, ForeignKey("chat_conversations.id", ondelete="CASCADE"), nullable=False)
    sender_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    message_type = Column(String(20), nullable=False, default="text")  # text|file|image|system|poll|crm_record
    content_cipher = Column(Text, nullable=True)   # base64 AES-GCM ciphertext
    content_nonce = Column(String(32), nullable=True)
    content_key_version = Column(Integer, nullable=True)
    reply_to_message_id = Column(BigInteger, ForeignKey("chat_messages.id", ondelete="SET NULL"), nullable=True)
    thread_root_id = Column(BigInteger, ForeignKey("chat_messages.id", ondelete="SET NULL"), nullable=True)
    forwarded_from_message_id = Column(BigInteger, nullable=True)
    mentions = Column(JSON, nullable=True)  # list[int] user ids
    extra_data = Column(JSON, nullable=True)  # crm_record share payload, system-message payload, etc.
    client_token = Column(String(64), nullable=True)  # idempotency key from the sender, dedupes after reconnect
    is_edited = Column(Boolean, nullable=False, default=False)
    edited_at = Column(DateTime, nullable=True)
    is_deleted = Column(Boolean, nullable=False, default=False)
    deleted_at = Column(DateTime, nullable=True)
    deleted_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, nullable=False, default=now_ist)
    updated_at = Column(DateTime, nullable=False, default=now_ist, onupdate=now_ist)


class ChatAttachment(TenantBase):
    __tablename__ = "chat_attachments"
    __table_args__ = (Index("ix_chat_attachments_message", "message_id"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    message_id = Column(BigInteger, ForeignKey("chat_messages.id", ondelete="CASCADE"), nullable=False)
    uploader_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    original_name = Column(String(300), nullable=False)
    content_type = Column(String(150), nullable=True)
    size_bytes = Column(BigInteger, nullable=False, default=0)
    storage_path = Column(String(500), nullable=False)  # logical path, as returned by save_upload_optimized
    is_image = Column(Boolean, nullable=False, default=False)
    encryption_nonce = Column(String(32), nullable=True)
    encryption_key_version = Column(Integer, nullable=True)
    created_at = Column(DateTime, nullable=False, default=now_ist)


class ChatMessageReaction(TenantBase):
    __tablename__ = "chat_message_reactions"
    __table_args__ = (
        UniqueConstraint("message_id", "user_id", "emoji", name="uq_chat_reaction"),
        Index("ix_chat_reactions_message", "message_id"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    message_id = Column(BigInteger, ForeignKey("chat_messages.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    emoji = Column(String(16), nullable=False)
    created_at = Column(DateTime, nullable=False, default=now_ist)


class ChatReadReceipt(TenantBase):
    __tablename__ = "chat_read_receipts"
    __table_args__ = (
        UniqueConstraint("message_id", "user_id", name="uq_chat_read_receipt"),
        Index("ix_chat_read_receipts_conv_user", "conversation_id", "user_id"),
        {"extend_existing": True},
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    conversation_id = Column(Integer, ForeignKey("chat_conversations.id", ondelete="CASCADE"), nullable=False)
    message_id = Column(BigInteger, ForeignKey("chat_messages.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    delivered_at = Column(DateTime, nullable=True)
    read_at = Column(DateTime, nullable=True)


class ChatPinnedMessage(TenantBase):
    __tablename__ = "chat_pinned_messages"
    __table_args__ = (
        UniqueConstraint("conversation_id", "message_id", name="uq_chat_pinned_message"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    conversation_id = Column(Integer, ForeignKey("chat_conversations.id", ondelete="CASCADE"), nullable=False)
    message_id = Column(BigInteger, ForeignKey("chat_messages.id", ondelete="CASCADE"), nullable=False)
    pinned_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    pinned_at = Column(DateTime, nullable=False, default=now_ist)


class ChatBookmark(TenantBase):
    __tablename__ = "chat_bookmarks"
    __table_args__ = (
        UniqueConstraint("user_id", "message_id", name="uq_chat_bookmark"),
        Index("ix_chat_bookmarks_user", "user_id"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    message_id = Column(BigInteger, ForeignKey("chat_messages.id", ondelete="CASCADE"), nullable=False)
    note = Column(String(300), nullable=True)
    created_at = Column(DateTime, nullable=False, default=now_ist)


class ChatMessageThread(TenantBase):
    """Materialized summary of a thread (root message + its replies), kept small
    so rendering a thread preview never has to aggregate chat_messages."""
    __tablename__ = "chat_message_threads"
    __table_args__ = (
        UniqueConstraint("root_message_id", name="uq_chat_thread_root"),
        Index("ix_chat_threads_conv", "conversation_id"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    conversation_id = Column(Integer, ForeignKey("chat_conversations.id", ondelete="CASCADE"), nullable=False)
    root_message_id = Column(BigInteger, ForeignKey("chat_messages.id", ondelete="CASCADE"), nullable=False)
    reply_count = Column(Integer, nullable=False, default=0)
    last_reply_at = Column(DateTime, nullable=True)
    last_reply_by = Column(Integer, nullable=True)


class ChatPoll(TenantBase):
    __tablename__ = "chat_polls"
    __table_args__ = (UniqueConstraint("message_id", name="uq_chat_poll_message"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    message_id = Column(BigInteger, ForeignKey("chat_messages.id", ondelete="CASCADE"), nullable=False)
    conversation_id = Column(Integer, ForeignKey("chat_conversations.id", ondelete="CASCADE"), nullable=False)
    question = Column(String(300), nullable=False)
    is_multi_choice = Column(Boolean, nullable=False, default=False)
    is_anonymous = Column(Boolean, nullable=False, default=False)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    closes_at = Column(DateTime, nullable=True)
    closed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=now_ist)


class ChatPollOption(TenantBase):
    __tablename__ = "chat_poll_options"
    __table_args__ = (Index("ix_chat_poll_options_poll", "poll_id"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    poll_id = Column(Integer, ForeignKey("chat_polls.id", ondelete="CASCADE"), nullable=False)
    option_text = Column(String(200), nullable=False)
    sort_order = Column(Integer, nullable=False, default=0)


class ChatPollVote(TenantBase):
    __tablename__ = "chat_poll_votes"
    __table_args__ = (
        UniqueConstraint("option_id", "user_id", name="uq_chat_poll_vote"),
        Index("ix_chat_poll_votes_poll_user", "poll_id", "user_id"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    poll_id = Column(Integer, ForeignKey("chat_polls.id", ondelete="CASCADE"), nullable=False)
    option_id = Column(Integer, ForeignKey("chat_poll_options.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime, nullable=False, default=now_ist)


class ChatScheduledMessage(TenantBase):
    __tablename__ = "chat_scheduled_messages"
    __table_args__ = (
        Index("ix_chat_scheduled_status_time", "status", "scheduled_for"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    conversation_id = Column(Integer, ForeignKey("chat_conversations.id", ondelete="CASCADE"), nullable=False)
    sender_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    message_type = Column(String(20), nullable=False, default="text")
    content_cipher = Column(Text, nullable=True)
    content_nonce = Column(String(32), nullable=True)
    content_key_version = Column(Integer, nullable=True)
    extra_data = Column(JSON, nullable=True)
    scheduled_for = Column(DateTime, nullable=False)
    status = Column(String(15), nullable=False, default="pending")  # pending|sent|cancelled|failed
    sent_message_id = Column(BigInteger, nullable=True)
    created_at = Column(DateTime, nullable=False, default=now_ist)


class ChatMessageReminder(TenantBase):
    __tablename__ = "chat_message_reminders"
    __table_args__ = (
        Index("ix_chat_reminders_status_time", "status", "remind_at"),
        Index("ix_chat_reminders_user", "user_id"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    message_id = Column(BigInteger, ForeignKey("chat_messages.id", ondelete="CASCADE"), nullable=False)
    remind_at = Column(DateTime, nullable=False)
    note = Column(String(300), nullable=True)
    status = Column(String(15), nullable=False, default="pending")  # pending|sent|dismissed
    created_at = Column(DateTime, nullable=False, default=now_ist)


class ChatNotificationPreference(TenantBase):
    """Per-user GLOBAL chat notification settings. Per-conversation mute/pin/archive
    live on ChatConversationMember instead — they're read on every conversation-list
    fetch, so keeping them off a join saves a query there."""
    __tablename__ = "chat_notification_preferences"
    __table_args__ = (UniqueConstraint("user_id", name="uq_chat_notif_pref_user"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    in_app_enabled = Column(Boolean, nullable=False, default=True)
    desktop_enabled = Column(Boolean, nullable=False, default=True)
    sound_enabled = Column(Boolean, nullable=False, default=True)
    mentions_only = Column(Boolean, nullable=False, default=False)
    updated_at = Column(DateTime, nullable=False, default=now_ist, onupdate=now_ist)


class ChatMessageDraft(TenantBase):
    __tablename__ = "chat_message_drafts"
    __table_args__ = (
        UniqueConstraint("conversation_id", "user_id", name="uq_chat_draft_conv_user"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    conversation_id = Column(Integer, ForeignKey("chat_conversations.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    content_cipher = Column(Text, nullable=True)
    content_nonce = Column(String(32), nullable=True)
    content_key_version = Column(Integer, nullable=True)
    reply_to_message_id = Column(BigInteger, nullable=True)
    updated_at = Column(DateTime, nullable=False, default=now_ist, onupdate=now_ist)


class ChatAuditLog(TenantBase):
    __tablename__ = "chat_audit_logs"
    __table_args__ = (
        Index("ix_chat_audit_conv_created", "conversation_id", "created_at"),
        Index("ix_chat_audit_actor_created", "actor_id", "created_at"),
        {"extend_existing": True},
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    conversation_id = Column(Integer, ForeignKey("chat_conversations.id", ondelete="SET NULL"), nullable=True)
    actor_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    action = Column(String(40), nullable=False)
    target_user_id = Column(Integer, nullable=True)
    details = Column(JSON, nullable=True)
    created_at = Column(DateTime, nullable=False, default=now_ist)


CHAT_TABLES = [
    ChatConversation.__table__,
    ChatConversationMember.__table__,
    ChatMessage.__table__,
    ChatAttachment.__table__,
    ChatMessageReaction.__table__,
    ChatReadReceipt.__table__,
    ChatPinnedMessage.__table__,
    ChatBookmark.__table__,
    ChatMessageThread.__table__,
    ChatPoll.__table__,
    ChatPollOption.__table__,
    ChatPollVote.__table__,
    ChatScheduledMessage.__table__,
    ChatMessageReminder.__table__,
    ChatNotificationPreference.__table__,
    ChatMessageDraft.__table__,
    ChatAuditLog.__table__,
]
