from datetime import datetime

from sqlalchemy import JSON, Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint

from app.database import Base


class PlatformMobileSetting(Base):
    """Platform-wide mobile settings: minimum versions, soft-update prompt, blocked versions, security policy."""
    __tablename__ = "platform_mobile_settings"
    key = Column(String(40), primary_key=True)
    value = Column(JSON, nullable=False)
    updated_by = Column(String(255), nullable=True)
    updated_at = Column(DateTime, nullable=True)


class PlatformMobileRelease(Base):
    """A mobile app version and its platform-side rollout (what the version check offers)."""
    __tablename__ = "platform_mobile_releases"
    __table_args__ = (UniqueConstraint("version", "platform", name="uq_platform_mobile_release"),)
    id = Column(Integer, primary_key=True)
    version = Column(String(20), nullable=False)
    platform = Column(String(10), nullable=False)                      # iOS | Android
    channel = Column(String(12), nullable=False)                       # Beta | Production
    rollout = Column(Integer, nullable=False, default=0)               # % of devices offered this version
    status = Column(String(12), nullable=False, default="Rolling out")  # Rolling out | Paused | Live | Deprecated | Blocked
    min_supported = Column(String(20), nullable=True)
    notes = Column(String(500), nullable=True)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=True)


class PlatformMobileTenant(Base):
    """Per-tenant mobile access, role rules, device rules and branding (defaults: everything allowed, as today)."""
    __tablename__ = "platform_mobile_tenants"
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), primary_key=True)
    enabled = Column(Boolean, nullable=False, default=True)
    roles = Column(JSON, nullable=False)                               # {"admin": true, "ceo": true, "manager": true, "kam": true}
    offline = Column(Boolean, nullable=False, default=True)
    gps = Column(Boolean, nullable=False, default=True)
    voice = Column(Boolean, nullable=False, default=True)
    biometric = Column(Boolean, nullable=False, default=True)
    screenshots_blocked = Column(Boolean, nullable=False, default=False)
    device_approval = Column(Boolean, nullable=False, default=False)
    max_devices = Column(Integer, nullable=False, default=3)
    app_name = Column(String(120), nullable=True)
    distribution = Column(String(20), nullable=False, default="Shared app")   # Shared app | Branded app
    updated_by = Column(String(255), nullable=True)
    updated_at = Column(DateTime, nullable=True)


class PlatformMobileDevice(Base):
    """A registered app installation: from the app's push-token registration, or the device registration API."""
    __tablename__ = "platform_mobile_devices"
    __table_args__ = (
        UniqueConstraint("tenant_id", "source", "source_ref", name="uq_platform_mobile_device"),
        Index("ix_platform_mobile_devices_user", "tenant_id", "user_id", "status"),   # sign-in block check, per-user lists
        Index("ix_platform_mobile_devices_seen", "last_seen"),                       # active · 7 days, grid order
    )
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, nullable=False)
    source = Column(String(12), nullable=False)                        # push_token | app
    source_ref = Column(String(128), nullable=False)                   # push-token row id, or hashed device id
    user_name = Column(String(200), nullable=True)
    model = Column(String(120), nullable=True)
    os = Column(String(60), nullable=True)
    platform = Column(String(10), nullable=True)                       # iOS | Android | None (not reported)
    app_version = Column(String(20), nullable=True)
    integrity = Column(String(12), nullable=True)                      # verified | compromised | None (not reported)
    last_seen = Column(DateTime, nullable=True)
    status = Column(String(14), nullable=False, default="Active")      # Active | Locked | Blocked | Wipe pending | Wiped
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformMobileCommand(Base):
    """A remote command for one device; done only when the app acknowledges it."""
    __tablename__ = "platform_mobile_commands"
    __table_args__ = (Index("ix_platform_mobile_commands_device", "device_id", "status"),)
    id = Column(Integer, primary_key=True)
    device_id = Column(Integer, ForeignKey("platform_mobile_devices.id", ondelete="CASCADE"), nullable=False)
    command = Column(String(10), nullable=False)                       # lock | wipe
    status = Column(String(12), nullable=False, default="pending")    # pending | acknowledged | cancelled
    requested_by = Column(String(255), nullable=True)
    requested_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    acknowledged_at = Column(DateTime, nullable=True)


class PlatformMobilePush(Base):
    """A push notification broadcast and what FCM accepted."""
    __tablename__ = "platform_mobile_pushes"
    __table_args__ = (Index("ix_platform_mobile_pushes_created", "created_at"), Index("ix_platform_mobile_pushes_due", "status", "scheduled_for"))
    id = Column(Integer, primary_key=True)
    title = Column(String(200), nullable=False)
    message = Column(Text, nullable=False)
    audience = Column(String(40), nullable=False)
    audience_label = Column(String(250), nullable=False)
    when = Column("send_when", String(30), nullable=False)
    scheduled_for = Column(DateTime, nullable=True)
    status = Column(String(12), nullable=False, default="scheduled")  # scheduled | sending | sent | failed
    targeted = Column(Integer, nullable=False, default=0)             # push tokens addressed
    accepted = Column(Integer, nullable=False, default=0)             # accepted by FCM
    failed = Column(Integer, nullable=False, default=0)
    error = Column(String(300), nullable=True)
    sent_by = Column(String(255), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    sent_at = Column(DateTime, nullable=True)
