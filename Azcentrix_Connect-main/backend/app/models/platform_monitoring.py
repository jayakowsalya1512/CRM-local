from datetime import datetime

from sqlalchemy import JSON, Boolean, Column, DateTime, Float, Integer, String, Text, UniqueConstraint

from app.database import Base


class PlatformMetricMinute(Base):
    """Request (or database statement) counts and a latency histogram for one service, minute and API worker."""
    __tablename__ = "platform_metric_minutes"
    __table_args__ = (UniqueConstraint("minute", "service", "worker", name="uq_platform_metric_minute"),)
    id = Column(Integer, primary_key=True)
    minute = Column(Integer, nullable=False, index=True)  # unix time // 60
    service = Column(String(30), nullable=False)
    worker = Column(String(80), nullable=False)
    requests = Column(Integer, nullable=False, default=0)
    errors = Column(Integer, nullable=False, default=0)
    hist = Column(JSON, nullable=False)  # {bucket index: count}, see platform_monitoring.bucket()


class PlatformResourceSample(Base):
    """Per-minute CPU / memory / disk of one server, taken by the uptime probe."""
    __tablename__ = "platform_resource_samples"
    __table_args__ = (UniqueConstraint("minute", "server", name="uq_platform_resource_sample"),)
    id = Column(Integer, primary_key=True)
    minute = Column(Integer, nullable=False, index=True)
    server = Column(String(120), nullable=False)
    roles = Column(String(60), nullable=False, default="")
    cpu = Column(Float, nullable=True)
    memory = Column(Float, nullable=True)
    disk = Column(Float, nullable=True)


class PlatformTenantUsageHour(Base):
    """Hourly usage meter per tenant: counters (api, ai, email, auth_failed) and gauges (storage_mb)."""
    __tablename__ = "platform_tenant_usage_hours"
    __table_args__ = (UniqueConstraint("hour", "tenant_slug", "meter", name="uq_platform_tenant_usage_hour"),)
    id = Column(Integer, primary_key=True)
    hour = Column(Integer, nullable=False, index=True)  # unix time // 3600
    tenant_slug = Column(String(100), nullable=False, index=True)
    meter = Column(String(20), nullable=False)
    value = Column(Float, nullable=False, default=0)


class PlatformAlertRule(Base):
    __tablename__ = "platform_alert_rules"
    id = Column(Integer, primary_key=True)
    metric = Column(String(40), nullable=False)
    threshold = Column(Float, nullable=False)
    duration_minutes = Column(Integer, nullable=False, default=5)
    action = Column(String(30), nullable=False)
    target = Column(String(500), nullable=True)  # Slack webhook URL or e-mail addresses
    severity = Column(String(10), nullable=False, default="SEV3")
    enabled = Column(Boolean, nullable=False, default=True)
    state = Column(String(20), nullable=False, default="pending")  # pending | ok | firing | no_data | unavailable
    last_value = Column(Float, nullable=True)
    last_detail = Column(JSON, nullable=True)
    last_evaluated_at = Column(DateTime, nullable=True)
    last_fired_at = Column(DateTime, nullable=True)
    created_by = Column(String(200), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformIncident(Base):
    __tablename__ = "platform_incidents"
    id = Column(Integer, primary_key=True)
    title = Column(String(300), nullable=False)
    severity = Column(String(10), nullable=False)
    status = Column(String(20), nullable=False, default="Open")  # Open | Resolved
    source = Column(String(80), nullable=False, index=True)  # rule:<id>[:tenant] | server:<name>
    detail = Column(Text, nullable=True)
    started_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    resolved_at = Column(DateTime, nullable=True)
