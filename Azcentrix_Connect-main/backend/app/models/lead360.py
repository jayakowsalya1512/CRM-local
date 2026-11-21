"""Leads (prototype v17) side tables – no master data is duplicated here.

lead_contact_links  – the customer contact (customer_contacts.id) chosen as "Contact person" on a lead.
                      The lead row keeps its denormalised contact_person / mobile / email as before.
lead_notes          – the drawer's Notes tab (one row per note, @mentions notify the mentioned users).
"""
from sqlalchemy import Column, DateTime, ForeignKey, Integer, Text, func

from app.models.all_models import TenantBase


class LeadContactLink(TenantBase):
    __tablename__ = "lead_contact_links"
    __table_args__ = {"extend_existing": True}

    lead_id = Column(Integer, ForeignKey("leads.id", ondelete="CASCADE"), primary_key=True)
    contact_id = Column(Integer, ForeignKey("customer_contacts.id", ondelete="SET NULL"), nullable=True, index=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class LeadNote(TenantBase):
    __tablename__ = "lead_notes"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    lead_id = Column(Integer, ForeignKey("leads.id", ondelete="CASCADE"), nullable=False, index=True)
    body = Column(Text, nullable=False)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now())


LEAD360_TABLES = [LeadContactLink.__table__, LeadNote.__table__]
