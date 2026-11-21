"""Lead capture forms (prototype v17 · Sales → Capture Forms).

capture_forms        – one row per web-to-lead form: selected fields (ordered), required fields, routing
                       (assign mode, lead source master id), thank-you text, spam protection, publish state and
                       the random public key used in the hosted URL / embed script.
capture_submissions  – every submission received (public or test): the submitted values, spam result, routing
                       result (assigned user, rule used, errors) and the lead created or matched.
No master data is copied: sources, products, states and users are referenced by id.
"""
from sqlalchemy import JSON, Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text, func

from app.models.all_models import TenantBase


class CaptureForm(TenantBase):
    __tablename__ = "capture_forms"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    public_key = Column(String(24), nullable=False, unique=True)
    name = Column(String(200), nullable=False)
    is_published = Column(Boolean, nullable=False, default=False)
    fields = Column(JSON, nullable=False)              # ordered field keys, e.g. ["name", "contact", "email"]
    required = Column(JSON, nullable=False)            # subset of fields
    assign_mode = Column(String(40), nullable=False)   # "team:<org node id>" | "state" | "user:<user id>"
    source_id = Column(Integer, ForeignKey("lead_sources.id", ondelete="SET NULL"), nullable=True)
    thanks = Column(Text, nullable=True)
    spam = Column(String(30), nullable=False, default="Honeypot")
    rr_cursor = Column(Integer, nullable=False, default=0)   # round-robin position
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class CaptureSubmission(TenantBase):
    __tablename__ = "capture_submissions"
    __table_args__ = (
        Index("ix_capture_submissions_form_received", "form_id", "received_at"),
        Index("ix_capture_submissions_ip_received", "ip", "received_at"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    ref = Column(String(24), nullable=True, unique=True)
    form_id = Column(Integer, ForeignKey("capture_forms.id", ondelete="CASCADE"), nullable=False, index=True)
    received_at = Column(DateTime, server_default=func.now(), nullable=False)
    is_test = Column(Boolean, nullable=False, default=False)
    status = Column(String(20), nullable=False)        # lead_created | duplicate | spam | invalid | error
    spam_reason = Column(String(120), nullable=True)
    data = Column(JSON, nullable=True)                 # submitted values (field key → value)
    company = Column(String(300), nullable=True)
    contact = Column(String(200), nullable=True)
    email = Column(String(200), nullable=True)
    phone = Column(String(40), nullable=True)
    interest = Column(String(300), nullable=True)
    lead_id = Column(Integer, ForeignKey("leads.id", ondelete="SET NULL"), nullable=True, index=True)
    customer_id = Column(Integer, ForeignKey("customers.id", ondelete="SET NULL"), nullable=True)
    contact_id = Column(Integer, ForeignKey("customer_contacts.id", ondelete="SET NULL"), nullable=True)
    assigned_to = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    routing = Column(JSON, nullable=True)              # {"mode", "rule", "assigned", "notes": [...]}
    error = Column(Text, nullable=True)
    ip = Column(String(64), nullable=True)
    user_agent = Column(String(300), nullable=True)
    page_url = Column(String(500), nullable=True)
    submitted_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)   # test submissions


CAPTURE_TABLES = [CaptureForm.__table__, CaptureSubmission.__table__]
