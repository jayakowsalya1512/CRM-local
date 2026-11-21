from datetime import datetime

from sqlalchemy import JSON, Boolean, Column, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint

from app.database import Base


class PlatformMarketPublisher(Base):
    """An app publisher. Its API key is stored only as an HMAC; the key is shown once when the publisher is created."""
    __tablename__ = "platform_market_publishers"
    id = Column(Integer, primary_key=True)
    name = Column(String(200), nullable=False, unique=True)
    contact_email = Column(String(200), nullable=True)
    key_prefix = Column(String(16), nullable=False, unique=True)
    key_hash = Column(String(64), nullable=False)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformMarketApp(Base):
    """A marketplace app: its requested scopes, the platform's scope review, the external code-scan result, and status."""
    __tablename__ = "platform_market_apps"
    __table_args__ = (
        UniqueConstraint("publisher_id", "name", name="uq_platform_market_app"),
        Index("ix_platform_market_apps_status", "status", "created_at"),
    )
    id = Column(Integer, primary_key=True)
    publisher_id = Column(Integer, ForeignKey("platform_market_publishers.id", ondelete="RESTRICT"), nullable=False, index=True)
    name = Column(String(150), nullable=False)
    category = Column(String(60), nullable=False)
    scopes = Column(JSON, nullable=False)
    price_monthly = Column(Integer, nullable=False, default=0)              # whole rupees; 0 = free
    private_tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True)   # tenant-only app
    scope_review = Column(String(12), nullable=False)                      # clean | findings | critical (platform's scope review)
    scope_findings = Column(JSON, nullable=True)
    scan_result = Column(String(12), nullable=True)                        # clean | findings | critical | None (no code scan yet)
    scan_findings = Column(Integer, nullable=True)
    scanned_at = Column(DateTime, nullable=True)
    status = Column(String(12), nullable=False, default="In review")       # In review | Live | Rejected | Suspended
    status_reason = Column(String(300), nullable=True)
    status_by = Column(String(255), nullable=True)
    status_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformMarketInstall(Base):
    """An app installed in a tenant (one row per app and tenant; uninstalling keeps the row inactive)."""
    __tablename__ = "platform_market_installs"
    __table_args__ = (
        UniqueConstraint("app_id", "tenant_id", name="uq_platform_market_install"),
        Index("ix_platform_market_installs_tenant", "tenant_id", "active"),
    )
    id = Column(Integer, primary_key=True)
    app_id = Column(Integer, ForeignKey("platform_market_apps.id", ondelete="CASCADE"), nullable=False)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    active = Column(Boolean, nullable=False, default=True)
    scopes_granted = Column(JSON, nullable=False)
    installed_by_user = Column(Integer, nullable=True)
    installed_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    uninstalled_at = Column(DateTime, nullable=True)


class PlatformMarketPlanAccess(Base):
    """Marketplace access of a plan: browse | limited (install up to max_installs) | unlimited (+ private apps)."""
    __tablename__ = "platform_market_plan_access"
    plan_id = Column(Integer, ForeignKey("plans.id", ondelete="CASCADE"), primary_key=True)
    access = Column(String(10), nullable=False)
    max_installs = Column(Integer, nullable=True)
    updated_by = Column(String(255), nullable=True)


class PlatformMarketSetting(Base):
    """Marketplace policy switches."""
    __tablename__ = "platform_market_settings"
    key = Column(String(40), primary_key=True)
    enabled = Column(Boolean, nullable=False)
    updated_by = Column(String(255), nullable=True)
    updated_at = Column(DateTime, nullable=True)
