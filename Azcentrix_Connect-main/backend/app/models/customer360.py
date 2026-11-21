"""Customers & Contacts – Customer 360 (prototype v17) side tables.

customer_profiles        – one row per customer: hierarchy level, KAM coverage (own / inherited),
                           and the Account plan (goals, strategy, risks, white space).
customer_contact_roles   – buying-centre role per contact (Decision maker / Influencer / User / Gatekeeper).

Kept beside the existing customers / customer_contacts tables so those schemas are unchanged.
"""
from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, func

from app.models.all_models import TenantBase

HIERARCHY_LEVELS = ("Head Office", "LHO / Regional Office", "Zone", "Divisional Office", "Branch / Site")
KAM_MODES = ("Own KAM", "Inherit from parent")
BUYING_ROLES = ("Decision maker", "Influencer", "User", "Gatekeeper")


class CustomerProfile(TenantBase):
    __tablename__ = "customer_profiles"
    __table_args__ = {"extend_existing": True}

    customer_id = Column(Integer, ForeignKey("customers.id", ondelete="CASCADE"), primary_key=True)
    hierarchy_level = Column(String(40), nullable=True)
    kam_mode = Column(String(30), nullable=True)
    plan_goal = Column(Text, nullable=True)
    plan_strategy = Column(Text, nullable=True)
    plan_risks = Column(Text, nullable=True)
    plan_white_space = Column(Text, nullable=True)
    plan_updated_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    plan_updated_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class CustomerContactRole(TenantBase):
    __tablename__ = "customer_contact_roles"
    __table_args__ = {"extend_existing": True}

    contact_id = Column(Integer, ForeignKey("customer_contacts.id", ondelete="CASCADE"), primary_key=True)
    customer_id = Column(Integer, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, index=True)
    buying_role = Column(String(30), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


CUSTOMER360_TABLES = [CustomerProfile.__table__, CustomerContactRole.__table__]
