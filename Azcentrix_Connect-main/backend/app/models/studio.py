"""Customization Studio (prototype v17 R.forms wrapper) – side tables.

Layouts & fields reuse the existing form_fields table (one row per overridden system field or custom field); the
studio adds help_text / master_key / show_when columns to it at startup (studio_service.ensure_schema).

custom_objects / custom_object_fields / custom_records – "Custom objects": model anything beyond the standard
modules.  Records keep their values in JSON; `title` (first field) is denormalised for search and sort.
validation_rules – "Validation rules": stored only for now; evaluation hooks are connected later.
"""
from sqlalchemy import JSON, Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func

from app.models.all_models import TenantBase


class CustomObject(TenantBase):
    __tablename__ = "custom_objects"
    __table_args__ = (
        UniqueConstraint("slug", name="uq_custom_objects_slug"),
        Index("ix_custom_objects_active", "is_active"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    slug = Column(String(60), nullable=False)
    name = Column(String(100), nullable=False)        # singular ("Site survey")
    plural = Column(String(100), nullable=False)      # plural ("Site surveys")
    icon = Column(String(40), nullable=False, default="table")
    is_active = Column(Boolean, nullable=False, default=True)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


class CustomObjectField(TenantBase):
    __tablename__ = "custom_object_fields"
    __table_args__ = (
        UniqueConstraint("object_id", "key", name="uq_custom_object_fields_key"),
        Index("ix_custom_object_fields_object", "object_id", "sort_order"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    object_id = Column(Integer, ForeignKey("custom_objects.id", ondelete="CASCADE"), nullable=False)
    key = Column(String(60), nullable=False)
    label = Column(String(120), nullable=False)
    field_type = Column(String(30), nullable=False, default="text")
    options = Column(JSON, nullable=True)
    is_required = Column(Boolean, nullable=False, default=False)
    sort_order = Column(Integer, nullable=False, default=0)


class CustomRecord(TenantBase):
    __tablename__ = "custom_records"
    __table_args__ = (
        Index("ix_custom_records_object_created", "object_id", "created_at"),
        Index("ix_custom_records_object_title", "object_id", "title"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    object_id = Column(Integer, ForeignKey("custom_objects.id", ondelete="CASCADE"), nullable=False)
    title = Column(String(300), nullable=True)
    data = Column(JSON, nullable=False)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


class ValidationRule(TenantBase):
    __tablename__ = "validation_rules"
    __table_args__ = (
        Index("ix_validation_rules_object", "object", "is_active"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(160), nullable=False)
    object = Column(String(40), nullable=False)       # Deals | Bids | Quotes | Accounts | Leads | …
    formula = Column(String(300), nullable=False)
    message = Column(String(300), nullable=False)
    is_active = Column(Boolean, nullable=False, default=True)
    sort_order = Column(Integer, nullable=False, default=0)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


STUDIO_TABLES = [CustomObject.__table__, CustomObjectField.__table__, CustomRecord.__table__, ValidationRule.__table__]
