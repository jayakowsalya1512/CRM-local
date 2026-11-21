"""
Active / Inactive status for Module Management catalog items (platform only).

Every module and sub-module in the catalog has a stable `key` (e.g. "customers",
"dashboard.leads", "settings.theme"), including items that are not linked to a
Feature row ("Not linked"). Status is stored per key so each item can be toggled
independently.

This status only controls what the platform offers in Tenant Onboarding. It never
writes to plan_features / tenant_features, so existing tenant permissions and
configurations are unchanged.
"""
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, Column, DateTime, String
from sqlalchemy.orm import Session

from app.database import Base


class PlatformModuleStatus(Base):
    __tablename__ = "platform_module_status"
    catalog_key = Column(String(150), primary_key=True)
    is_active = Column(Boolean, nullable=False, default=True)
    updated_at = Column(DateTime, nullable=True)


_table_ready = False


def ensure_table(db: Session) -> None:
    global _table_ready
    if not _table_ready:
        PlatformModuleStatus.__table__.create(bind=db.get_bind(), checkfirst=True)
        _table_ready = True


def load_statuses(db: Session) -> dict[str, bool]:
    ensure_table(db)
    return {row.catalog_key: bool(row.is_active) for row in db.query(PlatformModuleStatus).all()}


def set_status(db: Session, catalog_key: str, is_active: bool) -> None:
    ensure_table(db)
    row = db.get(PlatformModuleStatus, catalog_key)
    if row is None:
        row = PlatformModuleStatus(catalog_key=catalog_key)
        db.add(row)
    row.is_active = bool(is_active)
    row.updated_at = datetime.utcnow()


def resolve(key_statuses: dict[str, bool], catalog_key: str, legacy: Optional[bool]) -> bool:
    """Key status wins; otherwise fall back to the legacy per-feature status; default active."""
    if catalog_key in key_statuses:
        return key_statuses[catalog_key]
    return True if legacy is None else bool(legacy)
