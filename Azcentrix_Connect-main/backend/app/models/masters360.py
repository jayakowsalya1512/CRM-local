"""Masters (prototype v17 R.masters) – custom masters.

Standard masters keep their own tables (lead_sources, lead_categories / lead_sub_categories, vertical_sectors / vertical_sub_sectors,
business_categories / business_units, products_master …).  Custom masters created from the page live here:

master_defs     one row per custom master: name, kind, optional parent master (a standard key or another custom master's key)
master_values   its values with code / description, optional parent value (id in the parent master's own table), position, active flag
"""
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func

from app.models.all_models import TenantBase


class MasterDef(TenantBase):
    __tablename__ = "master_defs"
    __table_args__ = (
        UniqueConstraint("key", name="uq_master_defs_key"),
        UniqueConstraint("name", name="uq_master_defs_name"),
        Index("ix_master_defs_parent", "parent_key"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String(80), nullable=False)                 # cm_<slug>
    name = Column(String(100), nullable=False)
    description = Column(String(300), nullable=True)
    kind = Column(String(40), nullable=False, default="Simple list")   # Simple list | List with code & description | Hierarchy (parent › child)
    parent_key = Column(String(80), nullable=True)           # key of the parent master (standard or custom) for hierarchy masters
    is_active = Column(Boolean, nullable=False, default=True)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


class MasterValue(TenantBase):
    __tablename__ = "master_values"
    __table_args__ = (
        UniqueConstraint("master_id", "value", name="uq_master_values_value"),
        Index("ix_master_values_order", "master_id", "position"),
        Index("ix_master_values_parent", "master_id", "parent_ref"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    master_id = Column(Integer, ForeignKey("master_defs.id", ondelete="CASCADE"), nullable=False)
    value = Column(String(200), nullable=False)
    code = Column(String(60), nullable=True)
    description = Column(String(300), nullable=True)
    parent_ref = Column(Integer, nullable=True)              # id of the parent value in the parent master's table (no FK: table varies)
    position = Column(Integer, nullable=False, default=0)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


MASTERS360_TABLES = [MasterDef.__table__, MasterValue.__table__]
