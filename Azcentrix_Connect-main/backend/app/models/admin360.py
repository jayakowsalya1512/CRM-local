"""Users & Teams / Roles & Security (prototype v17) – side tables.  Existing users / groups / roles /
permissions / login_logs are reused; only what the prototype adds is new:

territories    – "Teams & territories" right panel: name, states / rule, owner.  Account counts are computed.
sharing_rules  – "Roles & Security → Sharing rules".
field_security – "Roles & Security → Field-level security": (module, field, role) → Edit | Read | Hidden.
                 Only cells that differ from the default (Edit) are stored.
"""
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func

from app.models.all_models import TenantBase


class Territory(TenantBase):
    __tablename__ = "territories"
    __table_args__ = (
        UniqueConstraint("name", name="uq_territories_name"),
        Index("ix_territories_owner", "owner_id"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False)
    states = Column(Text, nullable=True)                 # comma-separated state names ("Tamil Nadu, Kerala")
    rule = Column(String(200), nullable=True)            # free-text rule when not state based ("Account tier A (any state)")
    owner_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


class SharingRule(TenantBase):
    __tablename__ = "sharing_rules"
    __table_args__ = (
        Index("ix_sharing_rules_object", "object", "is_active"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    object = Column(String(40), nullable=False)          # Accounts | Leads | Deals | Bids | Quotes | Guarantees | …
    rule = Column(String(300), nullable=False)           # plain-language rule
    shared_with_type = Column(String(20), nullable=False, default="role")   # team | role | hierarchy | everyone
    shared_with_ref = Column(String(120), nullable=True)                    # role name / team name
    access = Column(String(20), nullable=False, default="Read")             # Read | Read / Write
    is_active = Column(Boolean, nullable=False, default=True)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


class FieldSecurity(TenantBase):
    __tablename__ = "field_security"
    __table_args__ = (
        UniqueConstraint("module", "field_key", "role_id", name="uq_field_security_cell"),
        Index("ix_field_security_module", "module"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    module = Column(String(50), nullable=False)
    field_key = Column(String(100), nullable=False)
    role_id = Column(Integer, ForeignKey("roles.id", ondelete="CASCADE"), nullable=False)
    access = Column(String(10), nullable=False, default="Edit")  # Edit | Read | Hidden
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


ADMIN360_TABLES = [Territory.__table__, SharingRule.__table__, FieldSecurity.__table__]
