"""Correspondence (prototype v17 R.letters) – campaigns and sequences.  Letters, templates and mail reuse their existing tables."""
from sqlalchemy import JSON, Boolean, Column, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint, func

from app.models.all_models import TenantBase


class MailCampaign(TenantBase):
    __tablename__ = "mail_campaigns"
    __table_args__ = (Index("ix_mail_campaigns_status_at", "status", "send_at"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(200), nullable=False)
    audience = Column(String(120), nullable=False)             # audience key (see correspondence_service.AUDIENCES)
    audience_label = Column(String(200), nullable=False)
    template_id = Column(Integer, nullable=True)                # letter_templates.id (nullable: free subject)
    template_name = Column(String(200), nullable=True)
    subject_a = Column(String(300), nullable=True)
    subject_b = Column(String(300), nullable=True)
    status = Column(String(20), nullable=False, default="Scheduled")   # Scheduled | Sent | Cancelled
    send_at = Column(DateTime, nullable=True)
    sent_at = Column(DateTime, nullable=True)
    recipients = Column(Integer, nullable=False, default=0)
    sent = Column(Integer, nullable=False, default=0)
    opened = Column(Integer, nullable=False, default=0)
    clicked = Column(Integer, nullable=False, default=0)
    replies = Column(Integer, nullable=False, default=0)
    leads = Column(Integer, nullable=False, default=0)
    create_lead_on_reply = Column(Boolean, nullable=False, default=True)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)


class MailSequence(TenantBase):
    __tablename__ = "mail_sequences"
    __table_args__ = (UniqueConstraint("name", name="uq_mail_sequences_name"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(200), nullable=False)
    steps = Column(JSON, nullable=False)                        # [{"day": 0, "kind": "Email|Task", "text": "…"}]
    is_active = Column(Boolean, nullable=False, default=True)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)


class MailSequenceEnrolment(TenantBase):
    __tablename__ = "mail_sequence_enrolments"
    __table_args__ = (
        UniqueConstraint("sequence_id", "module", "record_id", name="uq_mail_sequence_enrolment"),
        Index("ix_mail_sequence_enrolments_seq", "sequence_id"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    sequence_id = Column(Integer, ForeignKey("mail_sequences.id", ondelete="CASCADE"), nullable=False)
    module = Column(String(20), nullable=False)                 # leads | customers
    record_id = Column(Integer, nullable=False)
    enrolled_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    enrolled_at = Column(DateTime, server_default=func.now(), nullable=False)


CORRESPONDENCE_TABLES = [MailCampaign.__table__, MailSequence.__table__, MailSequenceEnrolment.__table__]
