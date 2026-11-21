"""Parent groups for the platform Tenants & Hierarchy module (master DB).

A parent group owns no database of its own; it consolidates the companies
(tenants) that point at it through ``tenants.parent_group_id``.
"""
from sqlalchemy import JSON, BigInteger, Column, DateTime, Enum, Integer, String, Text, UniqueConstraint
from sqlalchemy.sql import func

from app.database import Base

VISIBILITY_LEVELS = ("full", "reports", "none")


class TenantGroup(Base):
    __tablename__ = "tenant_groups"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(200), nullable=False)
    slug = Column(String(100), unique=True, nullable=False)
    industry = Column(String(150), nullable=True)
    color = Column(String(20), nullable=True)
    plan_id = Column(Integer, nullable=True)
    status = Column(Enum("active", "suspended"), default="active", nullable=False)
    default_visibility = Column(String(20), default="full", nullable=False)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, onupdate=func.now(), nullable=True)


class TenantOnboardingStep(Base):
    """Completion record for one provisioning-blueprint step of a tenant (Onboarding & Provisioning)."""
    __tablename__ = "tenant_onboarding_steps"
    __table_args__ = (UniqueConstraint("tenant_id", "step_key", name="uq_tenant_onboarding_step"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(Integer, nullable=False, index=True)
    step_key = Column(String(40), nullable=False)
    completed_at = Column(DateTime, server_default=func.now(), nullable=False)
    completed_by = Column(String(200), nullable=False, default="system")
    note = Column(Text, nullable=True)


class TenantExportJob(Base):
    """A tenant data export package (Data & migration → Export this tenant's complete data)."""
    __tablename__ = "tenant_export_jobs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(Integer, nullable=False, index=True)
    components = Column(JSON, nullable=False)
    format = Column(String(60), nullable=False)
    pii = Column(String(20), nullable=False)
    encryption = Column(String(60), nullable=False)
    delivery = Column(String(60), nullable=False)
    link_days = Column(Integer, nullable=False, default=7)
    status = Column(String(20), nullable=False, default="queued")
    progress = Column(Integer, nullable=False, default=0)
    size_bytes = Column(BigInteger, nullable=True)
    file_name = Column(String(200), nullable=True)
    sha256 = Column(String(64), nullable=True)
    manifest = Column(JSON, nullable=True)
    base_url = Column(String(300), nullable=True)
    requested_by = Column(String(200), nullable=True)
    error = Column(Text, nullable=True)
    options = Column(JSON, nullable=True)  # PGP recipient key, delivered-file checksum, attempts
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    completed_at = Column(DateTime, nullable=True)


class TenantMigration(Base):
    """A data migration into a tenant from CSV/Excel files or a SQL dump."""
    __tablename__ = "tenant_migrations"

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(Integer, nullable=False, index=True)
    source = Column(String(60), nullable=False)
    files = Column(JSON, nullable=True)
    datasets = Column(JSON, nullable=True)
    staging_db = Column(String(100), nullable=True)
    mapping = Column(JSON, nullable=True)
    rules = Column(JSON, nullable=True)
    dry_run = Column(JSON, nullable=True)
    result = Column(JSON, nullable=True)
    status = Column(String(30), nullable=False, default="Draft")
    progress = Column(Integer, nullable=False, default=0)
    records = Column(Integer, nullable=True)
    created_by = Column(String(200), nullable=True)
    error = Column(Text, nullable=True)
    scheduled_at = Column(DateTime, nullable=True)  # cut-over scheduled for this time
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    completed_at = Column(DateTime, nullable=True)


class PlatformMigrationConnector(Base):
    """Saved connection to a source CRM (Data Export & Migration → Source connectors). Credentials are encrypted."""
    __tablename__ = "platform_migration_connectors"

    source = Column(String(60), primary_key=True)
    config = Column(Text, nullable=True)  # AES-GCM encrypted JSON
    status = Column(String(20), nullable=False, default="not_configured")  # connected | failed | not_configured
    account = Column(String(255), nullable=True)
    detail = Column(Text, nullable=True)
    objects = Column(JSON, nullable=True)  # [{"name", "count"}] seen at the last validation
    validated_at = Column(DateTime, nullable=True)
    updated_by = Column(String(200), nullable=True)


class PlatformControlValue(Base):
    """A Control Center value that differs from the schema default.

    ``tenant_id`` 0 holds the platform default every tenant inherits; any other value is a tenant override.
    """
    __tablename__ = "platform_control_values"
    __table_args__ = (UniqueConstraint("tenant_id", "control_key", name="uq_platform_control_value"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(Integer, nullable=False, default=0, index=True)
    control_key = Column(String(60), nullable=False)
    value = Column(JSON, nullable=True)
    updated_by = Column(String(200), nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
