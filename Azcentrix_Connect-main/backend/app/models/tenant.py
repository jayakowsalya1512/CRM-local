"""
Tenant model — platform-level (master DB)
"""
from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text, Enum, ForeignKey, Index, JSON, Float, UniqueConstraint
from sqlalchemy.sql import func
from app.core.auth_defaults import (
    DEFAULT_NORMAL_LOGIN_EXPIRY_MINUTES,
    DEFAULT_REMEMBER_ME_EXPIRY_MINUTES,
)
from app.database import Base


class Tenant(Base):
    __tablename__ = "tenants"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(200), nullable=False)
    slug = Column(String(100), unique=True, nullable=False)  # Used as DB name suffix
    subdomain = Column(String(100), unique=True, nullable=False)
    plan_id = Column(Integer, ForeignKey("plans.id"), nullable=True)
    status = Column(Enum("active", "suspended", "trial", "cancelled"), default="trial", nullable=False)
    maintenance_mode = Column(Boolean, default=False, nullable=False)
    admin_email = Column(String(200), nullable=False)
    admin_name = Column(String(200), nullable=False)
    db_name = Column(String(200), nullable=False)  # digitcrm_<slug>
    max_users = Column(Integer, default=5, nullable=False)
    normal_login_expiry_minutes = Column(
        Integer,
        default=DEFAULT_NORMAL_LOGIN_EXPIRY_MINUTES,
        nullable=False,
    )
    remember_me_expiry_minutes = Column(
        Integer,
        default=DEFAULT_REMEMBER_ME_EXPIRY_MINUTES,
        nullable=False,
    )
    inactivity_timeout_minutes = Column(Integer, default=30, nullable=False)
    session_warning_minutes = Column(Integer, default=5, nullable=False)
    logo_url = Column(String(500), nullable=True)
    primary_color = Column(String(20), default="#0B1F3A", nullable=True)
    smtp_host = Column(String(255), nullable=True)
    smtp_port = Column(Integer, nullable=True)
    smtp_user = Column(String(255), nullable=True)
    smtp_password = Column(String(255), nullable=True)
    smtp_use_tls = Column(Boolean, default=True, nullable=False)
    smtp_use_ssl = Column(Boolean, default=False, nullable=False)
    from_email = Column(String(255), nullable=True)
    company_mail = Column(String(255), nullable=True)
    address = Column(Text, nullable=True)
    street_address = Column(Text, nullable=True)
    pincode = Column(String(20), nullable=True)
    country = Column(String(100), default="India", nullable=False)
    state = Column(String(255), nullable=True)
    city_district = Column(String(255), nullable=True)
    area_locality = Column(String(255), nullable=True)
    forgot_password_enabled = Column(Boolean, default=True, nullable=False)
    force_password_change_on_first_login = Column(Boolean, default=False, nullable=False)
    new_device_login_alert_enabled = Column(Boolean, default=False, nullable=False)
    otp_mode      = Column(String(20), default='never', nullable=False)
    captcha_mode  = Column(String(20), default='never', nullable=False)
    force_logout_after = Column(DateTime, nullable=True)
    self_service_reset_limit_count = Column(Integer, default=1, nullable=False)
    self_service_reset_limit_days = Column(Integer, default=30, nullable=False)
    forgot_password_send_max_attempts = Column(Integer, default=5, nullable=False)
    forgot_password_send_window_minutes = Column(Integer, default=15, nullable=False)
    forgot_password_ip_max_attempts = Column(Integer, default=10, nullable=False)
    forgot_password_ip_window_minutes = Column(Integer, default=15, nullable=False)
    password_expiry_enabled = Column(Boolean, default=False, nullable=False)
    password_expiry_days = Column(Integer, default=30, nullable=False)
    notes = Column(Text, nullable=True)
    trial_ends_at = Column(DateTime, nullable=True)
    # Storage limits
    storage_limit_mb = Column(Integer, default=1024, nullable=False)  # 1 GB default
    used_storage = Column(Float, default=0, nullable=False)
    # Billing
    billing_email = Column(String(200), nullable=True)
    billing_status = Column(
        Enum("trial", "active", "past_due", "cancelled", "free"),
        default="trial",
        nullable=False,
    )
    
    subscription_end_date = Column(DateTime, nullable=True)
    billing_notes = Column(Text, nullable=True)
    # Tenants & Hierarchy (columns added to existing installs by services.tenant_hierarchy.ensure_schema)
    parent_group_id = Column(Integer, nullable=True, index=True)
    parent_visibility = Column(String(20), default="full", nullable=False)
    shared_masters = Column(Boolean, default=True, nullable=False)
    inherit_parent_policies = Column(Boolean, default=True, nullable=False)
    industry = Column(String(150), nullable=True)
    deletion_scheduled_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, onupdate=func.now(), nullable=True)


class PlatformSetting(Base):
    __tablename__ = "platform_settings"

    key = Column(String(100), primary_key=True)
    value_bool = Column(Boolean, default=False, nullable=False)


class PlatformSessionPolicy(Base):
    __tablename__ = "platform_session_policy"
    id = Column(Integer, primary_key=True)
    timeout_minutes = Column(Integer, nullable=False, default=30)


class PlatformBranding(Base):
    __tablename__ = "platform_branding"
    id = Column(Integer, primary_key=True)
    product_name = Column(String(150), nullable=False, default="")
    support_email = Column(String(255), nullable=False, default="")
    logo_path = Column(String(500), nullable=False, default="")
    allow_tenant_branding = Column(Boolean, nullable=False, default=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class PlatformDataCompliance(Base):
    __tablename__ = "platform_data_compliance"
    id = Column(Integer, primary_key=True)
    default_region = Column(String(50), nullable=False, default="ap-south-1")
    retention_years = Column(Integer, nullable=False, default=7)
    encrypt_documents_at_rest = Column(Boolean, nullable=False, default=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class PlatformSession(Base):
    __tablename__ = "platform_sessions"
    id = Column(String(64), primary_key=True)
    admin_id = Column(Integer, ForeignKey("super_admins.id", ondelete="CASCADE"), nullable=False, index=True)
    last_active = Column(DateTime, nullable=False)
    is_active = Column(Boolean, nullable=False, default=True)


class Plan(Base):
    __tablename__ = "plans"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False)  # Core, Standard, Premium, Enterprise
    slug = Column(String(50), unique=True, nullable=False)
    description = Column(Text, nullable=True)
    price_monthly = Column(Integer, default=0, nullable=False)  # in paise / cents
    price_yearly = Column(Integer, default=0, nullable=False)
    max_users = Column(Integer, default=5, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)


class Feature(Base):
    __tablename__ = "features"

    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String(100), unique=True, nullable=False)  # e.g. lead_management
    name = Column(String(200), nullable=False)
    module = Column(String(100), nullable=True)
    description = Column(Text, nullable=True)


class ServiceHierarchy(Base):
    __tablename__ = "service_hierarchy"

    feature_id = Column(Integer, ForeignKey("features.id", ondelete="CASCADE"), primary_key=True)
    parent_id = Column(Integer, ForeignKey("features.id", ondelete="CASCADE"), nullable=False, index=True)


class ServiceCatalogEntry(Base):
    __tablename__ = "service_catalog_entries"

    feature_id = Column(Integer, ForeignKey("features.id", ondelete="CASCADE"), primary_key=True)


class ServiceDependency(Base):
    __tablename__ = "service_dependencies"

    service_key = Column(String(150), primary_key=True)
    dependency_key = Column(String(150), primary_key=True)


class ServiceConfiguration(Base):
    __tablename__ = "service_configurations"

    catalog_key = Column(String(150), primary_key=True)
    status = Column(String(30), nullable=False, default="ready")
    notes = Column(Text, nullable=True)
    updated_at = Column(DateTime, onupdate=func.now())


class ServiceStatus(Base):
    __tablename__ = "service_status"

    feature_id = Column(Integer, ForeignKey("features.id", ondelete="CASCADE"), primary_key=True)
    is_active = Column(Boolean, nullable=False, default=True)


class PlanFeature(Base):
    __tablename__ = "plan_features"

    id = Column(Integer, primary_key=True, autoincrement=True)
    plan_id = Column(Integer, ForeignKey("plans.id", ondelete="CASCADE"), nullable=False)
    feature_id = Column(Integer, ForeignKey("features.id", ondelete="CASCADE"), nullable=False)
    enabled = Column(Boolean, default=True, nullable=False)

    __table_args__ = (
        UniqueConstraint("plan_id", "feature_id", name="uq_plan_feature"),
    )

class SuperAdmin(Base):
    __tablename__ = "super_admins"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(100), unique=True, nullable=False)
    email = Column(String(200), unique=True, nullable=False)
    full_name = Column(String(200), nullable=False)
    hashed_password = Column(String(255), nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)


class PlatformAuditLog(Base):
    __tablename__ = "platform_audit_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    super_admin_id = Column(Integer, ForeignKey("super_admins.id", ondelete="SET NULL"), nullable=True)
    action = Column(String(100), nullable=False)
    entity_type = Column(String(50), nullable=False)
    entity_id = Column(Integer, nullable=True)
    entity_name = Column(String(200), nullable=True)
    old_data = Column(JSON, nullable=True)
    new_data = Column(JSON, nullable=True)
    description = Column(Text, nullable=True)
    ip_address = Column(String(45), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)


class PlatformRole(Base):
    __tablename__ = "platform_roles"

    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String(60), unique=True, nullable=False)
    name = Column(String(80), unique=True, nullable=False)
    is_system = Column(Boolean, nullable=False, default=False)
    permissions = Column(JSON, nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class PlatformStaffAccess(Base):
    """Role and tenant scope for a platform staff account. No row means Super admin."""
    __tablename__ = "platform_staff_access"

    admin_id = Column(Integer, ForeignKey("super_admins.id", ondelete="CASCADE"), primary_key=True)
    role_id = Column(Integer, ForeignKey("platform_roles.id", ondelete="RESTRICT"), nullable=False)
    scope = Column(String(20), nullable=False, default="all")
    tenant_ids = Column(JSON, nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class PlatformApprovalRequest(Base):
    __tablename__ = "platform_approval_requests"

    id = Column(Integer, primary_key=True, autoincrement=True)
    action = Column(String(60), nullable=False)
    module = Column(String(40), nullable=False)
    entity_type = Column(String(50), nullable=False)
    entity_id = Column(Integer, nullable=True)
    entity_name = Column(String(200), nullable=True)
    summary = Column(String(500), nullable=False)
    payload = Column(JSON, nullable=True)
    status = Column(String(20), nullable=False, default="pending", index=True)
    requested_by = Column(Integer, ForeignKey("super_admins.id", ondelete="SET NULL"), nullable=True)
    requested_at = Column(DateTime, server_default=func.now(), nullable=False)
    decided_by = Column(Integer, ForeignKey("super_admins.id", ondelete="SET NULL"), nullable=True)
    decided_at = Column(DateTime, nullable=True)
    decision_note = Column(String(500), nullable=True)
    result = Column(String(500), nullable=True)


class TenantPlanHistory(Base):
    __tablename__ = "tenant_plan_histories"

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    old_plan_id = Column(Integer, ForeignKey("plans.id", ondelete="SET NULL"), nullable=True)
    new_plan_id = Column(Integer, ForeignKey("plans.id", ondelete="SET NULL"), nullable=True)
    changed_by_admin_id = Column(Integer, ForeignKey("super_admins.id", ondelete="SET NULL"), nullable=True)
    note = Column(Text, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)


class ForgotPasswordSendAttempt(Base):
    __tablename__ = "forgot_password_send_attempts"
    __table_args__ = (
        Index("ix_fp_send_attempt_tenant_email_created", "tenant_id", "normalized_email", "created_at"),
        Index("ix_fp_send_attempt_tenant_ip_created", "tenant_id", "ip_address", "created_at"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True)
    normalized_email = Column(String(255), nullable=False)
    ip_address = Column(String(45), nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

class TenantFeature(Base):
    __tablename__ = "tenant_features"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    feature_id = Column(Integer, ForeignKey("features.id", ondelete="CASCADE"), nullable=False)
    enabled = Column(Boolean, default=True, nullable=False)
    source = Column(String(50), default="custom_override")

    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("tenant_id", "feature_id", name="uq_tenant_feature"),
    )


class TenantPlanSnapshot(Base):
    __tablename__ = "tenant_plan_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    plan_id = Column(Integer, ForeignKey("plans.id", ondelete="SET NULL"), nullable=True)

    plan_name = Column(String(100), nullable=True)
    plan_slug = Column(String(100), nullable=True)

    price_monthly = Column(Integer, default=0)
    price_yearly = Column(Integer, default=0)
    max_users = Column(Integer, default=5)
    storage_limit_mb = Column(Integer, default=1024)
    trial_days = Column(Integer, default=30)

    billing_status = Column(String(50), default="trial")
    subscription_end_date = Column(DateTime, nullable=True)

    snapshot_json = Column(JSON, nullable=True)

    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
