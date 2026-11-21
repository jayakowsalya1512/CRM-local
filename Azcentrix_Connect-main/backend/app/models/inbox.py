"""Inbox & Notifications (prototype v17 → Application → Inbox & Notifications).

Mailbox model: every message row is one user's copy of a message ("owner").  Sending
an internal mail writes the sender's copy into Sent and one Inbox copy per colleague,
so folders, read/star state and deletes stay per user.  All copies of a conversation
share one mail_threads row.
"""
from sqlalchemy import (
    Boolean, Column, Date, DateTime, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint,
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import TenantBase

MAIL_FOLDERS = ("Inbox", "Sent", "Drafts", "Scheduled", "Archive", "Trash")


class MailThread(TenantBase):
    __tablename__ = "mail_threads"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    subject = Column(String(500), nullable=False, default="")
    message_count = Column(Integer, nullable=False, default=0)
    last_message_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, server_default=func.now())


class MailMessage(TenantBase):
    __tablename__ = "mail_messages"
    __table_args__ = (
        Index("idx_mail_messages_owner_folder", "owner_user_id", "folder", "deleted_at"),
        Index("idx_mail_messages_thread", "thread_id"),
        Index("idx_mail_messages_scheduled", "folder", "scheduled_at"),
        Index("idx_mail_messages_link", "link_module", "link_record_id"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    thread_id = Column(Integer, ForeignKey("mail_threads.id", ondelete="SET NULL"), nullable=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    folder = Column(String(20), nullable=False, default="Inbox")
    prev_folder = Column(String(20), nullable=True)          # restored to on "Restore" from Trash

    sender_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    from_email = Column(String(255), nullable=False, default="")
    from_name = Column(String(255), nullable=True)
    from_mailbox = Column(String(255), nullable=True)        # the "From" mailbox picked in Compose
    to_emails = Column(Text, nullable=True)                  # comma separated, as typed
    cc_emails = Column(Text, nullable=True)
    bcc_emails = Column(Text, nullable=True)
    subject = Column(String(500), nullable=False, default="")
    body = Column(Text, nullable=True)
    account_name = Column(String(300), nullable=True)        # customer / company the mail is about

    is_read = Column(Boolean, nullable=False, default=False)
    is_starred = Column(Boolean, nullable=False, default=False)
    is_internal = Column(Boolean, nullable=False, default=False)

    link_module = Column(String(30), nullable=True)          # customers / leads / opportunities / tenders / quotations
    link_record_id = Column(Integer, nullable=True)
    link_label = Column(String(300), nullable=True)

    in_reply_to_id = Column(Integer, nullable=True)
    track_opens = Column(Boolean, nullable=False, default=True)
    open_count = Column(Integer, nullable=False, default=0)
    click_count = Column(Integer, nullable=False, default=0)
    tracking_token = Column(String(64), nullable=True, unique=True)

    scheduled_at = Column(DateTime, nullable=True)
    sent_at = Column(DateTime, nullable=True)
    # draft | scheduled | internal | sent | failed | not_configured | received
    delivery_status = Column(String(20), nullable=True)
    delivery_error = Column(String(500), nullable=True)
    assigned_to_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    deleted_at = Column(DateTime, nullable=True)             # permanently deleted from Trash

    attachments = relationship("MailAttachment", cascade="all, delete-orphan", lazy="selectin",
                               order_by="MailAttachment.id")
    recipients = relationship("MailRecipient", cascade="all, delete-orphan", lazy="selectin",
                              order_by="MailRecipient.id")


class MailRecipient(TenantBase):
    __tablename__ = "mail_recipients"
    __table_args__ = (Index("idx_mail_recipients_message", "message_id"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    message_id = Column(Integer, ForeignKey("mail_messages.id", ondelete="CASCADE"), nullable=False)
    kind = Column(String(5), nullable=False, default="to")   # to | cc | bcc
    email = Column(String(255), nullable=False)
    name = Column(String(255), nullable=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class MailAttachment(TenantBase):
    __tablename__ = "mail_attachments"
    __table_args__ = (Index("idx_mail_attachments_message", "message_id"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    message_id = Column(Integer, ForeignKey("mail_messages.id", ondelete="CASCADE"), nullable=False)
    document_key = Column(String(120), nullable=True)        # Document Hub document id
    file_name = Column(String(300), nullable=False)
    file_url = Column(String(500), nullable=True)
    size_kb = Column(Integer, nullable=True)


class MailTemplate(TenantBase):
    __tablename__ = "mail_templates"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(200), nullable=False)
    subject = Column(String(500), nullable=True)
    body = Column(Text, nullable=False)
    is_system = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)
    sort_order = Column(Integer, nullable=False, default=0)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now())


class NotificationDeliveryPreference(TenantBase):
    __tablename__ = "notification_delivery_preferences"
    __table_args__ = (
        UniqueConstraint("user_id", "pref_key", name="uq_notification_delivery_pref_user_key"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    pref_key = Column(String(40), nullable=False)            # bid_deadlines | approvals | mentions | daily_digest
    enabled = Column(Boolean, nullable=False, default=True)
    channels = Column(JSON, nullable=True)                    # ["app", "email", "whatsapp"]
    digest_time = Column(String(5), nullable=True)            # "08:00" (daily digest)
    last_sent_on = Column(Date, nullable=True)                # daily digest: last day it was sent
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


INBOX_TABLES = [
    MailThread.__table__,
    MailMessage.__table__,
    MailRecipient.__table__,
    MailAttachment.__table__,
    MailTemplate.__table__,
    NotificationDeliveryPreference.__table__,
]
