from datetime import datetime

from sqlalchemy import JSON, Boolean, Column, Date, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint

from app.database import Base


class PlatformApiKey(Base):
    """A tenant API key. Only an HMAC-SHA256 of the key is stored; the key itself is shown once, at creation."""
    __tablename__ = "platform_api_keys"
    __table_args__ = (Index("ix_platform_api_keys_state", "revoked_at", "expires_at", "created_at"),)   # active / older-than-90-days counts
    id = Column(Integer, primary_key=True)
    prefix = Column(String(16), nullable=False, unique=True)                # first characters, for lookup and display
    key_hash = Column(String(64), nullable=False)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, nullable=False)                               # tenant user the key signs in as
    name = Column(String(120), nullable=False)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    last_used_at = Column(DateTime, nullable=True)
    revoked_at = Column(DateTime, nullable=True)
    # Added by platform_api_keys.ensure_schema (Rate limits & API keys)
    scopes = Column(String(40), nullable=False, default="read,write")      # read | read,write
    last4 = Column(String(4), nullable=True)                                # last characters, for the masked display
    expires_at = Column(DateTime, nullable=True)                            # end of the rotation overlap of a replaced key
    replaced_by_id = Column(Integer, nullable=True)
    revoked_by = Column(String(255), nullable=True)


class PlatformPlanRateLimit(Base):
    """API-key rate limit of a plan: sustained requests per minute, burst (token-bucket capacity) and daily cap."""
    __tablename__ = "platform_plan_rate_limits"
    plan_id = Column(Integer, ForeignKey("plans.id", ondelete="CASCADE"), primary_key=True)
    per_minute = Column(Integer, nullable=False)
    burst = Column(Integer, nullable=False)
    daily_cap = Column(Integer, nullable=False, default=0)                  # requests per IST day; 0 = no cap
    updated_by = Column(String(255), nullable=True)
    updated_at = Column(DateTime, nullable=True)


class PlatformApiVersion(Base):
    """Lifecycle of a public API version the backend serves (``/api/<version>/…``). Deprecation never disables it."""
    __tablename__ = "platform_api_versions"
    version = Column(String(10), primary_key=True)                          # v1
    status = Column(String(12), nullable=False, default="Current")          # Current | Deprecated | Beta
    sunset = Column(Date, nullable=True)
    updated_by = Column(String(255), nullable=True)
    updated_at = Column(DateTime, nullable=True)


class PlatformWebhookEndpoint(Base):
    """A tenant's webhook destination. The signing secret is stored encrypted and returned only at creation."""
    __tablename__ = "platform_webhook_endpoints"
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    url = Column(String(500), nullable=False)
    secret_enc = Column(Text, nullable=False)
    events = Column(JSON, nullable=False)                                   # event types it receives
    is_active = Column(Boolean, nullable=False, default=True)
    created_by_user = Column(Integer, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformWebhookEvent(Base):
    """An event to deliver; event_id is unique so an event is never recorded (or delivered) twice."""
    __tablename__ = "platform_webhook_events"
    id = Column(Integer, primary_key=True)
    event_id = Column(String(40), nullable=False, unique=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    event_type = Column(String(60), nullable=False)
    payload = Column(JSON, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformWebhookDelivery(Base):
    """One event to one endpoint, with every attempt's outcome summarised (no secrets, no payload)."""
    __tablename__ = "platform_webhook_deliveries"
    __table_args__ = (
        UniqueConstraint("event_ref", "endpoint_id", name="uq_platform_webhook_delivery"),          # idempotent fan-out
        Index("ix_platform_webhook_deliveries_created", "created_at"),                             # recent deliveries, 24h KPIs
        Index("ix_platform_webhook_deliveries_due", "status", "next_attempt_at"),                  # retry worker
        Index("ix_platform_webhook_deliveries_tenant", "tenant_id", "created_at"),                 # tenant-scoped staff
    )
    id = Column(Integer, primary_key=True)
    event_ref = Column(Integer, ForeignKey("platform_webhook_events.id", ondelete="CASCADE"), nullable=False)
    endpoint_id = Column(Integer, ForeignKey("platform_webhook_endpoints.id", ondelete="CASCADE"), nullable=False)
    tenant_id = Column(Integer, nullable=False)
    event_type = Column(String(60), nullable=False)
    status = Column(String(12), nullable=False, default="pending")          # pending | sending | retrying | delivered | failed
    attempts = Column(Integer, nullable=False, default=0)
    response_code = Column(Integer, nullable=True)
    latency_ms = Column(Integer, nullable=True)
    last_error = Column(String(300), nullable=True)
    next_attempt_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    finished_at = Column(DateTime, nullable=True)
