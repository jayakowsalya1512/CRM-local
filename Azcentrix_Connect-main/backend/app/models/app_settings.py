"""Application settings (prototype v17 "p25" Settings page) – per-tenant tables.

app_settings         – one row per *customised* setting (category, key) → JSON value. Defaults never hit the
                       table (prototype SETX semantics): a category reset is a single DELETE, and the whole
                       settings page is loaded with ONE query (the table stays small: only overrides live here).
app_setting_changes  – change history ("Change history" page): who changed which setting, from → to.
                       changed_by_name is denormalised so the history list needs no join and survives user removal.
"""
from sqlalchemy import JSON, Column, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func

from app.models.all_models import TenantBase


class AppSetting(TenantBase):
    __tablename__ = "app_settings"
    __table_args__ = (
        UniqueConstraint("category", "key", name="uq_app_settings_category_key"),
        Index("ix_app_settings_category", "category"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    category = Column(String(40), nullable=False)
    key = Column(String(60), nullable=False)
    value = Column(JSON, nullable=True)
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


class AppSettingChange(TenantBase):
    __tablename__ = "app_setting_changes"
    __table_args__ = (
        Index("ix_app_setting_changes_created", "created_at"),
        Index("ix_app_setting_changes_category_created", "category", "created_at"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    category = Column(String(40), nullable=False)
    section = Column(String(80), nullable=False)          # category display name at the time of the change
    setting_key = Column(String(80), nullable=False)
    label = Column(String(160), nullable=False)           # setting label ("Session timeout (minutes)")
    old_value = Column(Text, nullable=True)
    new_value = Column(Text, nullable=True)
    changed_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    changed_by_name = Column(String(120), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)


APP_SETTINGS_TABLES = [AppSetting.__table__, AppSettingChange.__table__]
