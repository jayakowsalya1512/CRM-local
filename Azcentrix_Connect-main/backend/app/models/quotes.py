"""Quotes (prototype v17 · Sales → Quotes) – side table only.

A quote is the set of ``quotations`` rows that share one ``quotation_number``: every row is one revision
(``revision_number`` 1, 2, 3 …; shown as Rev 0, Rev 1 … like the prototype). The row with the highest revision is the
latest – the only one that can be edited; older rows are locked snapshots. Line items stay in ``quotation_line_items``.

quote_profiles – per-quote values the quotations table has no column for, keyed by the quote's first revision row
                 (``quote_id`` = MIN(quotations.id) of the number): enquiry reference, when the current stage was
                 entered, a stage move waiting for approval, lost reason, checklist confirmations, quote-specific
                 commercial terms (NULL = the tenant default from Settings), the work order created from it and the
                 Form Builder values. The current stage itself is a row in workflow_record_stages (workflow "quote").
"""
from sqlalchemy import JSON, Column, DateTime, Integer, String, Text, func

from app.models.all_models import TenantBase


class QuoteProfile(TenantBase):
    __tablename__ = "quote_profiles"
    __table_args__ = {"extend_existing": True}

    quote_id = Column(Integer, primary_key=True)                     # MIN(quotations.id) of the quotation_number
    quotation_number = Column(String(50), nullable=False, index=True)
    enquiry_ref = Column(String(120), nullable=True)
    stage_entered_at = Column(DateTime, nullable=True)
    pending_stage_id = Column(Integer, nullable=True)                # workflow_stages.id waiting for approval
    approval_request_id = Column(Integer, nullable=True)             # approval_requests.id (module "quotation", action "stage")
    lost_reason = Column(String(120), nullable=True)
    lost_note = Column(Text, nullable=True)
    checklist = Column(JSON, nullable=True)                          # {stage name: [confirmed items]}
    payment_terms = Column(Text, nullable=True)
    delivery_terms = Column(Text, nullable=True)
    warranty_terms = Column(Text, nullable=True)
    work_order_id = Column(Integer, nullable=True)
    custom_data = Column(JSON, nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


QUOTE_TABLES = [QuoteProfile.__table__]
