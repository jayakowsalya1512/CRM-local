"""Marketplace & API (prototype v17 R.integrations · Marketplace tab) – tenant side table.

tenant_integrations   one row per catalogue integration the company has touched: connected flag, sync settings,
                      encrypted credentials (never returned), last sync.  API keys, webhooks and connected (OAuth /
                      marketplace) apps live in the master DB tables the platform already manages.
"""
from sqlalchemy import JSON, Boolean, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func

from app.models.all_models import TenantBase


class TenantIntegration(TenantBase):
    __tablename__ = "tenant_integrations"
    __table_args__ = (
        UniqueConstraint("key", name="uq_tenant_integrations_key"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String(40), nullable=False)                      # catalogue key, e.g. gem_portal
    connected = Column(Boolean, nullable=False, default=False)
    config = Column(JSON, nullable=True)                           # {"sync": "Hourly", "mapping": "…"}
    credentials_enc = Column(Text, nullable=True)                  # AES-GCM sealed JSON {client_id, secret}
    last_sync_at = Column(DateTime, nullable=True)
    connected_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    connected_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


INTEGRATIONS360_TABLES = [TenantIntegration.__table__]
