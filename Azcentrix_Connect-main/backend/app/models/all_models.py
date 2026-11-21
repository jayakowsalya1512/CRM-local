"""All tenant SQLAlchemy ORM models."""
from sqlalchemy import (Column, Integer, String, Text, Boolean, DateTime, Date,
                        Time, Numeric, JSON, Enum, ForeignKey, Float, UniqueConstraint, SmallInteger, Index)
from sqlalchemy.sql import func
from app.database import TenantBase
from app.core.timezone import now_ist
from sqlalchemy.orm import relationship, declarative_base, synonym, foreign
from datetime import datetime
from app.models.user_location import UserLocationLog
DECIMAL = Numeric


class Role(TenantBase):
    __tablename__ = "roles"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(50), nullable=False, unique=True)
    display_name = Column(String(100), nullable=False)
    level = Column(Integer, default=10)
    description = Column(Text); is_system = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())


class Permission(TenantBase):
    __tablename__ = "permissions"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String(200), nullable=False, unique=True)
    module = Column(String(100), nullable=False); action = Column(String(100), nullable=False)
    description = Column(String(300))


class RolePermission(TenantBase):
    __tablename__ = "role_permissions"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    role_id = Column(Integer, ForeignKey("roles.id", ondelete="CASCADE"), nullable=False)
    permission_id = Column(Integer, ForeignKey("permissions.id", ondelete="CASCADE"), nullable=False)
    data_scope = Column(String(20), nullable=True)

class Module(TenantBase):
    __tablename__ = "modules"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String(100), nullable=False, unique=True, index=True)
    label = Column(String(200), nullable=False)
    icon = Column(String(100), nullable=False)
    route = Column(String(200), nullable=False)
    section = Column(String(50), nullable=False, default="main")
    sort_order = Column(Integer, nullable=False, default=100)
    parent_key = Column(String(100), nullable=True)
    permission_key = Column(String(200), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    is_system = Column(Boolean, default=False, nullable=False)
    display_name = Column(String(100), nullable=True)
    display_name_singular = Column(String(100), nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())

class User(TenantBase):
    __tablename__ = "users"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(50), nullable=False, unique=True)
    email = Column(String(100), nullable=False, unique=True)
    full_name = Column(String(100), nullable=False)
    hashed_password = Column(String(255), nullable=False)
    # Keep this as String instead of a Python-side Enum so older tenant rows
    # with legacy role values do not crash simple read/list queries.
    role = Column(String(50), nullable=False, default='sales')
    department = Column(String(100)); designation = Column(String(100))
    phone = Column(String(20)); region = Column(String(100)); branch = Column(String(100))
    employee_code = Column(String(50))
    reporting_manager_id = Column(Integer, ForeignKey("users.id",    ondelete="SET NULL"))
    is_active = Column(Boolean, default=True); avatar_url = Column(String(500))
    last_login = Column(DateTime)
    last_password_changed_at = Column(DateTime, nullable=True)
    reset_window_start = Column(DateTime, nullable=True)
    reset_count = Column(Integer, default=0, nullable=False)
    last_self_service_reset_at = Column(DateTime, nullable=True)
    must_change_password = Column(Boolean, default=False, nullable=False)
    force_logout_after = Column(DateTime, nullable=True)
    sidebar_order = Column(JSON); dashboard_layout = Column(JSON); theme_overrides = Column(JSON)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())

    region_id = Column(String(255), nullable=True)
    state_id  = Column(String(255), nullable=True)
    group_id              = Column(String(255), nullable=True)
    reporting_manager_ids = Column(JSON, nullable=True)   # list of IDs; used for VP / Sales Head multi-select
    target                = Column(Numeric(15, 2), nullable=True)
    custom_data           = Column(JSON, nullable=True)

class StickyNote(TenantBase):
    __tablename__ = "sticky_notes"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    title = Column(String(160), nullable=False, default="Untitled note")
    content = Column(Text, nullable=False, default="")
    color = Column(String(20), nullable=False, default="yellow")
    pinned = Column(Boolean, nullable=False, default=False)
    reminder_at = Column(DateTime, nullable=True, index=True)
    reminder_sent = Column(Boolean, nullable=False, default=False)
    # Notes & Pinboard: optional CRM record the note is about (added by migrate_notes_pinboard.sql / notes_router)
    link_module = Column(String(30), nullable=True)
    link_record_id = Column(Integer, nullable=True)
    link_label = Column(String(300), nullable=True)
    version = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime, nullable=False, default=now_ist)
    updated_at = Column(DateTime, nullable=False, default=now_ist)


class UserReportingHierarchy(TenantBase):
    __tablename__ = "user_reporting_hierarchy"
    __table_args__ = (
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    reporting_user_id = Column(Integer, nullable=True)
    group_id = Column(Integer, nullable=True)
    parent_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    # manager / vp / ceo
    reporting_role = Column(String(50), nullable=False)

    level = Column(Integer, nullable=False, default=1)
    is_active = Column(Boolean, default=True, nullable=False)
    is_group_lead = Column(Integer, nullable=False, default=0)

    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())
    
class UserSession(TenantBase):
    __tablename__ = "user_sessions"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    refresh_token_hash = Column(String(255), nullable=False, unique=True)
    session_jti = Column(String(64), nullable=True, unique=True)
    device = Column(String(300)); browser = Column(String(100)); os = Column(String(100))
    ip_address = Column(String(45)); location = Column(String(200))
    login_time = Column(DateTime, server_default=func.now())
    last_active = Column(DateTime, server_default=func.now(), onupdate=func.now())
    logout_time = Column(DateTime)
    revoked_at = Column(DateTime, nullable=True)
    revoked_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    revoke_reason = Column(String(255), nullable=True)
    revoke_scope = Column(String(20), nullable=True)
    is_active = Column(Boolean, default=True)


class UserPushToken(TenantBase):
    __tablename__ = "user_push_tokens"
    __table_args__ = (
        UniqueConstraint("token", name="uq_user_push_tokens_token"),
        Index("idx_user_push_tokens_user_active", "user_id", "is_active"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    token = Column(String(512), nullable=False)
    platform = Column(String(40), nullable=True)
    device_id = Column(String(120), nullable=True)
    device_name = Column(String(200), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    failed_count = Column(Integer, default=0, nullable=False)
    last_error = Column(Text, nullable=True)
    last_seen_at = Column(DateTime, nullable=True, default=now_ist)
    created_at = Column(DateTime, nullable=False, default=now_ist, server_default=func.now())
    updated_at = Column(DateTime, nullable=True, default=now_ist, onupdate=now_ist)



class LoginLog(TenantBase):
    __tablename__ = "login_logs"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    username = Column(String(100), nullable=False)
    ip_address = Column(String(45)); user_agent = Column(String(500))
    success = Column(Boolean, default=False); failure_reason = Column(String(200))
    created_at = Column(DateTime, server_default=func.now())


class LoginOTPChallenge(TenantBase):
    __tablename__ = "login_otp_challenges"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    challenge_id = Column(String(80), nullable=False, unique=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    username = Column(String(100), nullable=False)
    otp_hash = Column(String(255), nullable=False)
    remember_me = Column(Boolean, default=True, nullable=False)
    ip_address = Column(String(45), nullable=True)
    user_agent = Column(String(500), nullable=True)
    fcm_token = Column(String(512), nullable=True)
    failed_attempts = Column(Integer, default=0, nullable=False)
    resend_count = Column(Integer, default=0, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    sent_at = Column(DateTime, nullable=False, default=now_ist, server_default=func.now())
    consumed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=now_ist, server_default=func.now())


class TrustedDevice(TenantBase):
    __tablename__ = "trusted_devices"; __table_args__ = {"extend_existing": True}
    id            = Column(Integer, primary_key=True, autoincrement=True)
    user_id       = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    device_uuid   = Column(String(100), nullable=False)
    device_label  = Column(String(200), nullable=True)
    ip_address    = Column(String(50), nullable=True)
    trusted_at    = Column(DateTime, server_default=func.now(), nullable=False)
    last_used_at  = Column(DateTime, nullable=True)
    expires_at    = Column(DateTime, nullable=True)
    is_active     = Column(Boolean, default=True, nullable=False)


class QuickPinCredential(TenantBase):
    __tablename__ = "quick_pin_credentials"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    device_uuid_hash = Column(String(100), nullable=False)
    pin_hash = Column(String(255), nullable=False)
    failed_attempts = Column(Integer, default=0, nullable=False)
    locked_until = Column(DateTime, nullable=True)
    last_used_at = Column(DateTime, nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())


class AuditLog(TenantBase):
    __tablename__ = "audit_logs"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    module = Column(String(100), nullable=False); action = Column(String(100), nullable=False)
    record_id = Column(Integer); record_name = Column(String(255)); old_data = Column(JSON); new_data = Column(JSON)
    description = Column(Text); ip_address = Column(String(45))
    created_at = Column(DateTime, server_default=func.now())


class ActivityLog(TenantBase):
    __tablename__ = "activity_logs"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    module = Column(String(100)); record_id = Column(Integer)
    action = Column(String(100), nullable=False); description = Column(Text, nullable=False)
    icon = Column(String(10), default='📌'); color = Column(String(20), default='#EFF6FF')
    created_at = Column(DateTime, server_default=func.now())


class ApiLog(TenantBase):
    __tablename__ = "api_logs"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    method = Column(String(10)); path = Column(String(500))
    status_code = Column(Integer); response_ms = Column(Integer); ip_address = Column(String(45))
    created_at = Column(DateTime, server_default=func.now())


class ErrorLog(TenantBase):
    __tablename__ = "error_logs"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    module = Column(String(100)); error_type = Column(String(200))
    message = Column(Text); stack_trace = Column(Text); request_data = Column(JSON)
    created_at = Column(DateTime, server_default=func.now())


class ApprovalRule(TenantBase):
    """
    Configures who approves what.
    If no rule exists for a (module, action), approval_service falls back
    to the requester's reporting_manager_id.
    """
    __tablename__  = "approval_rules"
    __table_args__ = {"extend_existing": True}

    id           = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id    = Column(Integer, nullable=True, index=True)
    module_key   = Column("module", String(100), nullable=False)   # 'lead', 'tender', …
    action_key   = Column("action", String(100), nullable=False)   # 'convert', 'payment', …
    name         = Column(String(200), nullable=True)
    approval_type = Column(
        Enum('hierarchy', 'sequential'),
        nullable=False,
        default='hierarchy',
    )

    requester_type = Column(
        Enum('role', 'specific_user', 'group'),
        nullable=True,
    )
    requester_role = Column(String(50), nullable=True)
    requester_user_id = Column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    requester_group_id = Column(Integer, nullable=True)  # references org_tree_nodes.id (L2 group node)

    # -- Who approves ----------------------------------------------------------
    approver_type = Column(
        Enum('reporting_manager', 'role', 'specific_user', 'hierarchy_level'),
        default='reporting_manager',
    )
    approver_role    = Column(String(50))   # used when approver_type = 'role'
    approver_user_id = Column(             # used when approver_type = 'specific_user'
        Integer, ForeignKey("users.id", ondelete="SET NULL")
    )

    # -- Config ----------------------------------------------------------------
    notify_roles      = Column(JSON)              # extra roles to notify (list of strings)
    escalation_hours  = Column(Integer, default=48)
    is_active         = Column(Boolean, default=True)
    created_at        = Column(DateTime, nullable=False, default=now_ist, server_default=func.now())
    updated_at        = Column(DateTime, nullable=True, default=now_ist, onupdate=now_ist)

    module = synonym("module_key")
    action = synonym("action_key")

    steps = relationship(
        "ApprovalRuleStep",
        back_populates="rule",
        order_by="ApprovalRuleStep.step_no",
        cascade="all, delete-orphan",
    )
    requests = relationship(
        "ApprovalRequest",
        back_populates="rule",
        primaryjoin=lambda: ApprovalRule.id == foreign(ApprovalRequest.approval_rule_id),
        foreign_keys=lambda: [ApprovalRequest.approval_rule_id],
    )
    requester_user = relationship("User", foreign_keys=[requester_user_id])


class ApprovalRuleStep(TenantBase):
    __tablename__ = "approval_rule_steps"
    __table_args__ = (
        UniqueConstraint("approval_rule_id", "step_no", name="uq_approval_rule_step_order"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    approval_rule_id = Column(Integer, ForeignKey("approval_rules.id", ondelete="CASCADE"), nullable=False)
    step_no = Column(Integer, nullable=False)
    approver_type = Column(
        Enum('reporting_manager', 'role', 'specific_user', 'hierarchy_level'),
        nullable=False,
        default='reporting_manager',
    )
    approver_role = Column(String(50), nullable=True)
    approver_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    approver_level = Column(Integer, nullable=True)
    is_required = Column(Boolean, nullable=False, default=True)
    stop_on_reject = Column(Boolean, nullable=False, default=True)
    escalation_minutes = Column(Integer, nullable=True)
    created_at = Column(DateTime, nullable=False, default=now_ist, server_default=func.now())
    updated_at = Column(DateTime, nullable=True, default=now_ist, onupdate=now_ist)

    rule = relationship("ApprovalRule", back_populates="steps")
    approver_user = relationship("User", foreign_keys=[approver_user_id])


class ApprovalEscalationSetting(TenantBase):
    __tablename__ = "approval_escalation_settings"; __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(Integer, nullable=True, index=True)
    is_enabled = Column(Boolean, nullable=False, default=False)
    default_escalation_minutes = Column(Integer, nullable=True)
    created_at = Column(DateTime, nullable=False, default=now_ist, server_default=func.now())
    updated_at = Column(DateTime, nullable=True, default=now_ist, onupdate=now_ist)


class ApprovalEscalationRule(TenantBase):
    __tablename__ = "approval_escalation_rules"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id",
            "module",
            "action",
            "approver_role",
            name="uq_approval_escalation_rule_scope",
        ),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(Integer, nullable=True, index=True)
    module_key = Column("module", String(100), nullable=False)
    action_key = Column("action", String(100), nullable=False)
    approver_role = Column(String(50), nullable=False)
    escalation_minutes = Column(Integer, nullable=False)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, nullable=False, default=now_ist, server_default=func.now())
    updated_at = Column(DateTime, nullable=True, default=now_ist, onupdate=now_ist)

    module = synonym("module_key")
    action = synonym("action_key")


class ApprovalAutoApproveSetting(TenantBase):
    __tablename__ = "approval_auto_approve_settings"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id",
            "module",
            "action",
            name="uq_approval_auto_approve_setting_scope",
        ),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(Integer, nullable=True, index=True)
    module_key = Column("module", String(100), nullable=False)
    action_key = Column("action", String(100), nullable=False)
    is_enabled = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, nullable=False, default=now_ist, server_default=func.now())
    updated_at = Column(DateTime, nullable=True, default=now_ist, onupdate=now_ist)

    module = synonym("module_key")
    action = synonym("action_key")

class LeadSource(TenantBase):
    __tablename__ = "lead_sources"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False, unique=True)
    description = Column(Text); is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())


class Competitor(TenantBase):
    __tablename__ = "competitors"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(200), nullable=False, unique=True)
    registration_type = Column(String(100))
    registration_year = Column(String(10))
    country = Column(String(100), default="India")
    state = Column(String(100))
    district = Column(String(100))
    city = Column(String(100))
    address = Column(Text)
    pincode = Column(String(20))
    mobile_no = Column(String(30))
    gst_no = Column(String(30))
    pan_no = Column(String(30))
    email = Column(String(200))
    company_type = Column(String(200))
    directors = Column(Text)
    manpower_strength = Column(String(100))
    website = Column(String(200))
    strengths = Column(Text)
    weaknesses = Column(Text)
    threat_level = Column(String(50))
    market_reputation = Column(Text)
    oem_partnerships = Column(Text)
    strong_regions = Column(Text)
    strong_departments = Column(Text)
    annual_turnover = Column(String(100))
    support_quality = Column(String(100))
    internal_notes = Column(Text)
    is_active = Column(Boolean, default=True); created_at = Column(DateTime, server_default=func.now())
    custom_data = Column(JSON, nullable=True)


class ProductMaster(TenantBase):
    __tablename__ = "products_master"
    __table_args__ = {"extend_existing": True}

    id          = Column(Integer, primary_key=True, autoincrement=True)
    category    = Column(String(100), nullable=True)
    name        = Column(String(300), nullable=False)
    description = Column(Text,        nullable=True)
    is_active   = Column(Boolean,     default=True, nullable=False)
    created_at  = Column(DateTime,    server_default=func.now())


class OEM(TenantBase):
    __tablename__ = "oems"
    __table_args__ = {"extend_existing": True}
 
    id                  = Column(Integer, primary_key=True, autoincrement=True)
    product_id          = Column(Integer, ForeignKey("products_master.id", ondelete="SET NULL"), nullable=True)
    name                = Column(String(200), nullable=False)
 
    # -- Type ----------------------------------------------------------------
    type                = Column(String(50),  nullable=False, default="OEM")   # "OEM" | "Distributor"
 
    # -- Contact -------------------------------------------------------------
    contact_name        = Column(String(100), nullable=True)
    contact_email       = Column(String(100), nullable=True)
    contact_phone       = Column(String(20),  nullable=True)
    contact_designation = Column(String(200), nullable=True)
 
    # -- OEM / Auth details --------------------------------------------------
    account_manager     = Column(String(100), nullable=True)
    auth_number         = Column(String(100), nullable=True)
    auth_date           = Column(Date,        nullable=True)
    support_sla         = Column(String(50),  nullable=True)
    credit_limit        = Column(String(50),  nullable=True)
    payment_terms       = Column(String(100), nullable=True)
 
    # -- Distributor-only ----------------------------------------------------
    brands_handled      = Column(Text,        nullable=True)   # comma-separated brands
 
    # -- Misc ----------------------------------------------------------------
    notes               = Column(Text,        nullable=True)
 
    # -- Flags & audit -------------------------------------------------------
    is_active           = Column(Boolean,     default=True,  nullable=False)
    is_deleted          = Column(Boolean,     default=False,  nullable=False)   # soft delete
    created_by          = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at          = Column(DateTime, server_default=func.now())
    # website column removed — not in DB table
    custom_data         = Column(JSON, nullable=True)
    # -- Partners & OEM (prototype v17) – added by directory_service.ensure_schema ----
    auth_valid_till     = Column(Date,          nullable=True)   # authorisation (MAF) valid till
    discount_pct        = Column(DECIMAL(5, 2), nullable=True)   # typical discount %
    rating              = Column(Integer,       nullable=True)   # 1–5
    status              = Column(String(20),    nullable=True)   # Active | On hold | Inactive

class AlertRule(TenantBase):
    __tablename__ = "alert_rules"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(200), nullable=False); module = Column(String(100), nullable=False)
    condition_type = Column(Enum('days_before','days_after','status_change','threshold','overdue'), nullable=False)
    condition_value = Column(Integer); field_name = Column(String(100))
    severity = Column(Enum('info','warning','error','critical'), default='warning')
    notify_roles = Column(JSON); message_template = Column(Text)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())


class Setting(TenantBase):
    __tablename__ = "settings"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String(100), nullable=False, unique=True)
    value = Column(Text)
    type = Column(Enum('string','number','boolean','json','color'), default='string')
    category = Column(String(100), default='general')
    label = Column(String(200)); description = Column(Text)
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    updated_at = Column(DateTime, onupdate=func.now())


class DashboardPreference(TenantBase):
    __tablename__ = "dashboard_preferences"
    __table_args__ = {"extend_existing": True}

    id               = Column(Integer, primary_key=True, autoincrement=True)
    user_id          = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False)
    overall_layout   = Column(JSON)
    lead_layout      = Column(JSON)
    tender_layout    = Column(JSON)
    activity_layout  = Column(JSON)
    customer_layout  = Column(JSON)
    widgets          = Column(JSON, nullable=True)
    updated_at       = Column(DateTime, onupdate=func.now())


class TenantAddress(TenantBase):
    __tablename__ = "tenant_addresses"
    __table_args__ = (
        Index("ix_tenant_addresses_primary", "is_primary"),
        Index("ix_tenant_addresses_active", "is_active"),
        Index("ix_tenant_addresses_sort", "sort_order"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    label = Column(String(150), nullable=False)
    street_address = Column(Text, nullable=True)
    pincode = Column(String(20), nullable=True)
    area_locality = Column(String(255), nullable=True)
    city_district = Column(String(255), nullable=True)
    state = Column(String(255), nullable=True)
    country = Column(String(100), default="India", nullable=False)
    is_primary = Column(Boolean, default=False, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    sort_order = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, onupdate=func.now(), nullable=True)


class Customer(TenantBase):
    __tablename__ = "customers"
    __table_args__ = {"extend_existing": True}

    # -- Identity --------------------------------------------------------------
    id              = Column(Integer, primary_key=True, autoincrement=True)
    customer_name   = Column(String(300), nullable=False, unique=True)

    # -- Classification --------------------------------------------------------
    customer_vertical = Column(String(100))
    sub_segment_id    = Column(Integer, ForeignKey("vertical_sub_sectors.id", ondelete="SET NULL"), nullable=True, index=True)
    division          = Column(String(100))
    group_name        = Column(String(100))
    industry          = Column(String(100))
    tags              = Column(JSON)

    # -- Hierarchy -------------------------------------------------------------
    parent_account_id = Column(Integer, ForeignKey("customers.id", ondelete="SET NULL"), nullable=True)

    # -- Billing address -------------------------------------------------------
    billing_address = Column(Text)
    billing_pincode = Column(String(10))          # was String(6) — too short for non-IN
    billing_country = Column(String(100), default="India")
    billing_state   = Column(String(100))
    billing_city    = Column(String(100))
    billing_area    = Column(String(200))

    # -- Shipping address ------------------------------------------------------
    shipping_same_as_billing = Column(Boolean, default=False)
    shipping_address         = Column(Text)
    shipping_pincode         = Column(String(10))
    shipping_country         = Column(String(100), default="India")
    shipping_state           = Column(String(100))
    shipping_city            = Column(String(100))
    shipping_area            = Column(String(200))

    # -- Financials & identity -------------------------------------------------
    gst_number     = Column(String(20))
    pan_number     = Column(String(20))
    annual_revenue = Column(Numeric(15, 2))
    employee_count = Column(Integer)
    website        = Column(String(200))

    # -- CRM status ------------------------------------------------------------
    account_status    = Column(
        Enum("Active", "Inactive", "Prospect", "Churned", name="account_status_enum"),
        default="Prospect"
    )
    account_potential = Column(
        Enum("High", "Medium", "Low", name="account_potential_enum"),
        default="Medium"
    )
    potential_value = Column(Numeric(15, 2), nullable=True)

    # -- Assignment & notes ----------------------------------------------------
    assigned_to = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    remarks     = Column(Text)

    # -- Approval workflow -----------------------------------------------------
    is_active       = Column(Boolean, default=False, nullable=False)
    approval_status = Column(String(20), nullable=True)   # pending / approved / rejected

    # -- Dynamic form custom fields -------------------------------------------
    custom_data = Column(JSON, nullable=True)

    # -- Soft delete -----------------------------------------------------------
    is_deleted  = Column(Boolean, default=False, nullable=False)

    # -- Audit -----------------------------------------------------------------
    created_by  = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by  = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)  # NEW
    created_at  = Column(DateTime, server_default=func.now())
    updated_at  = Column(DateTime, onupdate=func.now())


class CustomerContact(TenantBase):
    __tablename__ = "customer_contacts"
    __table_args__ = {"extend_existing": True}

    # -- Identity --------------------------------------------------------------
    id          = Column(Integer, primary_key=True, autoincrement=True)
    customer_id = Column(Integer, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False)

    # -- Personal details ------------------------------------------------------
    contact_name   = Column(String(100), nullable=False)
    designation    = Column(String(100))
    department     = Column(String(100))
    dob            = Column(Date)

    # -- Contact details -------------------------------------------------------
    office_phone   = Column(String(20))
    mobile         = Column(String(20))           # was String(10) — too short
    office_email   = Column(String(100))
    personal_email = Column(String(100))
    website        = Column(String(200))
    linkedin       = Column(String(200))

    # -- Flags -----------------------------------------------------------------
    is_primary  = Column(Boolean, default=False)
    is_active   = Column(Boolean, default=True)   # used as soft-delete for contacts

    # -- Notes -----------------------------------------------------------------
    notes       = Column(Text)

    # -- Audit -----------------------------------------------------------------
    created_by  = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)  # NEW
    created_at  = Column(DateTime, server_default=func.now())
    updated_at  = Column(DateTime, onupdate=func.now())                                        # NEW


class Lead(TenantBase):
    __tablename__  = "leads"
    __table_args__ = {"extend_existing": True}
 
    id          = Column(Integer, primary_key=True, autoincrement=True)
 
    # -- Identifiers ------------------------------------------------------------
    lead_ref_id        = Column(String(50), unique=True)
    opportunity_ref_id = Column(String(50))
 
    # -- Customer ---------------------------------------------------------------
    customer_id   = Column(Integer, ForeignKey("customers.id", ondelete="SET NULL"), nullable=True)
    customer_name = Column(String(300))   # denormalised for speed
 
    # -- Basic info -------------------------------------------------------------
    lead_title        = Column(String(500), nullable=False)
    source_id         = Column(Integer, nullable=True,
                              comment="FK to sources/masters table — no FK constraint to avoid missing table errors")
    business_vertical_id = Column(
        Integer,
        nullable=True,
        comment="Selected business vertical id"
    )
    assigned_to       = Column(Integer, ForeignKey("users.id",    ondelete="SET NULL"), nullable=True)
    created_by        = Column(Integer, ForeignKey("users.id",    ondelete="SET NULL"), nullable=True)
    est_value         = Column(DECIMAL(15, 2))
    priority          = Column(Enum('Low', 'Medium', 'High'), default='Medium')
    region            = Column(String(100))
    branch            = Column(String(100))
    # -- Extra contact & deal fields (stored on lead row) ------------------------
    customer_address     = Column(String(500), nullable=True,
                                  comment="Billing address / site address")
    department           = Column(String(200), nullable=True)
    contact_person       = Column(String(200), nullable=True)
    designation          = Column(String(100), nullable=True)
    mobile               = Column(String(20),  nullable=True)
    email                = Column(String(200), nullable=True)
    tender_id_ref        = Column(String(100), nullable=True,
                                  comment="External tender reference ID")
    timeline             = Column(String(200), nullable=True,
                                  comment="Expected project timeline")
    follow_up            = Column(Date,        nullable=True,
                                  comment="Next follow-up date")
    product_description  = Column(Text,        nullable=True,
                                  comment="Brief description of required products")
    lead_created_at      = Column(DateTime,    nullable=True,
                                  comment="Explicit lead creation timestamp (mirrors created_at)")
    notes             = Column(Text)
 
    # -- Status — default = 'Assigned' (shown as "New" on the v17 board) --------
    # Contacted / Proposal Pending / Nurturing are the prototype v17 open stages;
    # existing tenant DBs get them from lead360_service.ensure_schema.
    status = Column(
        Enum(
            'Assigned',
            'Contacted',
            'Qualified',
            'Proposal Pending',
            'Nurturing',
            'Opportunity Created',
            'Converted',
            'Lost',
        ),
        nullable=False, default='Assigned',
    )
 
    # -- Step-2 (Opportunity Created) -------------------------------------------
    opportunity_created_at = Column(DateTime, nullable=True,
                                    comment="Timestamp when status first moved to Opportunity Created")
 
    # -- Step-3 (Conversion request) -------------------------------------------
    approval_id               = Column(Integer, ForeignKey("approvals.id", ondelete="SET NULL"), nullable=True)
    approval_status           = Column(
        Enum('pending', 'approved', 'rejected'), nullable=True,
        comment="Latest conversion approval status",
    )
    conversion_requested_at   = Column(DateTime, nullable=True,
                                        comment="When sales last requested conversion")
    rejection_reason          = Column(Text, nullable=True)
 
    # -- Post-conversion --------------------------------------------------------
    converted_at         = Column(DateTime, nullable=True)
    converted_tender_id  = Column(Integer, ForeignKey("tenders.id", ondelete="SET NULL"), nullable=True,
                                   comment="Tender auto-created on lead conversion")
    conversion_target    = Column(String(30), nullable=True,
                                   comment="Chosen conversion path: 'tender' or 'quotation'")
    lost_at              = Column(DateTime, nullable=True)
 
    # -- Direct opportunity flag ------------------------------------------------
    lead_type        = Column(String(30), nullable=False, default='lead',
                              comment="'lead' = normal flow; 'direct_opportunity' = created directly")

    # -- Channel (API integration source) ---------------------------------------
    channel          = Column(
        Enum('manual', 'whatsapp', 'email', 'telephone'),
        default='manual', nullable=True,
        comment="Source channel for API-generated leads",
    )
    channel_id       = Column(String(200), nullable=True,
                              comment="External message/call ID from the channel provider")
    channel_metadata = Column(JSON, nullable=True,
                              comment="Raw webhook payload for debugging")

    # -- Dynamic form custom fields -------------------------------------------
    custom_data = Column(JSON, nullable=True)

    # -- Timestamps -------------------------------------------------------------
    is_deleted = Column(Boolean, default=False)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())

    # -- Relationships ----------------------------------------------------------
    products      = relationship("LeadProduct",  back_populates="lead",
                                  cascade="all, delete-orphan")
    customer      = relationship("Customer",     foreign_keys=[customer_id])
    assignee      = relationship("User",         foreign_keys=[assigned_to])
    creator       = relationship("User",         foreign_keys=[created_by])
 
 
class LeadProduct(TenantBase):
    __tablename__  = "lead_products"
    __table_args__ = {"extend_existing": True}
 
    id           = Column(Integer, primary_key=True, autoincrement=True)
    lead_id      = Column(Integer, ForeignKey("leads.id", ondelete="CASCADE"), nullable=False)
    product_id   = Column(Integer, ForeignKey("products_master.id", ondelete="SET NULL"), nullable=True)
    product_name = Column(String(300), nullable=False)
    quantity     = Column(DECIMAL(10, 2), default=1)
    unit_price   = Column(DECIMAL(15, 2), default=0)
    gst_percent  = Column(DECIMAL(5, 2), default=0)
    description  = Column(Text,    nullable=True,
                           comment="Product-level description (legacy field alias for notes)")
    notes        = Column(Text)
    sort_order   = Column(Integer, default=0)
 
    lead = relationship("Lead", back_populates="products")
    oems = relationship("LeadProductOEM", back_populates="product",
                        cascade="all, delete-orphan")
 
 
class LeadProductOEM(TenantBase):
    __tablename__  = "lead_product_oems"
    __table_args__ = {"extend_existing": True}
 
    id                = Column(Integer, primary_key=True, autoincrement=True)
    lead_product_id   = Column(Integer, ForeignKey("lead_products.id", ondelete="CASCADE"), nullable=False)
    oem_id            = Column(Integer, ForeignKey("oems.id", ondelete="SET NULL"), nullable=True)
    oem_name          = Column(String(200))
    authorization_num = Column(String(200))
    is_preferred      = Column(Boolean, default=False)
 
    product = relationship("LeadProduct", back_populates="oems")


class LeadChannelLog(TenantBase):
    """Audit log for every inbound webhook from WhatsApp / Email / Telephone."""
    __tablename__  = "lead_channel_logs"
    __table_args__ = {"extend_existing": True}

    id             = Column(Integer, primary_key=True, autoincrement=True)
    channel        = Column(Enum('whatsapp', 'email', 'telephone'), nullable=False)
    channel_ref_id = Column(String(200), nullable=True,  comment="External message/call ID")
    raw_payload    = Column(JSON,        nullable=True,  comment="Full webhook payload")
    status         = Column(
        Enum('processed', 'duplicate', 'failed'),
        default='processed', nullable=False,
    )
    lead_id        = Column(Integer, nullable=True, comment="Lead created from this event")
    error_message  = Column(Text, nullable=True)
    created_at     = Column(DateTime, server_default=func.now())


# =============================================================================
# SAVED REPORT VIEWS
# =============================================================================

class SavedReportView(TenantBase):
    __tablename__  = "saved_report_views"
    __table_args__ = {"extend_existing": True}

    id          = Column(Integer, primary_key=True, autoincrement=True)
    report_type = Column(String(50), nullable=False, comment="leads, tenders, customers, …")
    name        = Column(String(200), nullable=False)
    filters     = Column(JSON, nullable=True, comment="Serialized filter state")
    columns     = Column(JSON, nullable=True, comment="Visible column keys in order")
    is_shared   = Column(Boolean, default=False)
    created_by  = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at  = Column(DateTime, server_default=func.now())
    updated_at  = Column(DateTime, onupdate=func.now())

    creator = relationship("User", foreign_keys=[created_by])


# =============================================================================
# REPORT ENGINE  — Phases 1-4: metadata + saved reports + permissions
# =============================================================================

class ReportFolder(TenantBase):
    """Folder hierarchy for organising saved reports (Standard/My/Team/Shared)."""
    __tablename__  = "report_folders"
    __table_args__ = {"extend_existing": True}

    id          = Column(Integer, primary_key=True, autoincrement=True)
    name        = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)
    parent_id   = Column(Integer, ForeignKey("report_folders.id", ondelete="SET NULL"), nullable=True)
    is_system   = Column(Boolean, default=False, comment="System folders cannot be deleted")
    visibility  = Column(Enum("private", "team", "org"), default="org")
    created_by  = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at  = Column(DateTime, server_default=func.now())
    updated_at  = Column(DateTime, server_default=func.now(), onupdate=func.now())

    creator      = relationship("User", foreign_keys=[created_by])
    children     = relationship("ReportFolder", foreign_keys=[parent_id])
    saved_reports = relationship("SavedReport", back_populates="folder")


class ReportType(TenantBase):
    """Catalog entry for each reportable dataset (leads, customers, tenders …)."""
    __tablename__  = "report_types"
    __table_args__ = {"extend_existing": True}

    id                    = Column(Integer, primary_key=True, autoincrement=True)
    key                   = Column(String(50), nullable=False, unique=True)
    name                  = Column(String(200), nullable=False)
    description           = Column(Text, nullable=True)
    base_table            = Column(String(100), nullable=False)
    module_permission_key = Column(String(100), nullable=True)
    default_date_field    = Column(String(100), default="created_at")
    supports_charts       = Column(Boolean, default=True)
    supports_grouping     = Column(Boolean, default=True)
    is_active             = Column(Boolean, default=True)
    sort_order            = Column(Integer, default=0)

    fields        = relationship("ReportTypeField", back_populates="report_type",
                                 order_by="ReportTypeField.display_order",
                                 cascade="all, delete-orphan")
    saved_reports = relationship("SavedReport", back_populates="report_type")


class ReportTypeField(TenantBase):
    """One available field/column for a report type — drives the UI builder and SQL runner."""
    __tablename__  = "report_type_fields"
    __table_args__ = (
        UniqueConstraint("report_type_id", "field_key", name="uq_rtf_type_field"),
        {"extend_existing": True},
    )

    id               = Column(Integer, primary_key=True, autoincrement=True)
    report_type_id   = Column(Integer, ForeignKey("report_types.id", ondelete="CASCADE"),
                              nullable=False, index=True)
    field_key        = Column(String(100), nullable=False)
    label            = Column(String(200), nullable=False)
    data_type        = Column(Enum("text", "number", "currency", "date", "datetime",
                                   "boolean", "enum"), default="text")
    is_default_column   = Column(Boolean, default=False)
    is_filterable       = Column(Boolean, default=True)
    is_groupable        = Column(Boolean, default=False)
    is_sortable         = Column(Boolean, default=True)
    is_aggregatable     = Column(Boolean, default=False)
    allowed_operators   = Column(JSON, nullable=True,
                                 comment="['eq','neq','contains','gt','lt','between','in','is_null']")
    enum_values         = Column(JSON, nullable=True, comment="[{value, label}] for enum fields")
    format              = Column(String(50), nullable=True)
    display_order       = Column(Integer, default=0)

    # Source mapping — used by the SQL runner to build SELECT and WHERE clauses.
    # source_table / source_column are informational; expression is what the runner uses.
    source_table        = Column(String(100), nullable=True,
                                 comment="Base table alias, e.g. 'l' for leads")
    source_column       = Column(String(100), nullable=True,
                                 comment="Raw column name, e.g. 'full_name'")
    expression          = Column(Text, nullable=True,
                                 comment="Full SQL expression for SELECT, e.g. 'assigned_user.full_name'")
    join_key            = Column(String(200), nullable=True,
                                 comment="Comma-separated JOIN aliases required, e.g. 'assigned_user'")
    filter_expression   = Column(String(200), nullable=True,
                                 comment="SQL expression for WHERE clause, e.g. 'l.assigned_to' (may differ from SELECT expression)")

    # Drilldown metadata — optional, field-level. NULL on all 4 = no drilldown (default, unchanged behavior).
    drilldown_kind          = Column(String(20), nullable=True,
                                     comment="NULL, 'detail', or 'report'")
    drilldown_target        = Column(String(100), nullable=True,
                                     comment="Entity key for 'detail' (e.g. 'customer') or target report_type_key for 'report'")
    drilldown_id_field      = Column(String(100), nullable=True,
                                     comment="field_key on this same report row holding the ID/filter value")
    drilldown_filter_field  = Column(String(100), nullable=True,
                                     comment="Target report's filter field_key — required only when drilldown_kind='report'")

    report_type = relationship("ReportType", back_populates="fields")


class SavedReport(TenantBase):
    """Full saved report definition — replaces/extends saved_report_views for engine reports."""
    __tablename__  = "saved_reports"
    __table_args__ = {"extend_existing": True}

    id                  = Column(Integer, primary_key=True, autoincrement=True)
    name                = Column(String(200), nullable=False)
    description         = Column(Text, nullable=True)
    report_type_id      = Column(Integer, ForeignKey("report_types.id", ondelete="SET NULL"),
                                 nullable=True, index=True)
    folder_id           = Column(Integer, ForeignKey("report_folders.id", ondelete="SET NULL"),
                                 nullable=True, index=True)
    is_system           = Column(Boolean, default=False,
                                 comment="Standard system reports seeded by platform")
    is_clone_of         = Column(Integer, ForeignKey("saved_reports.id", ondelete="SET NULL"),
                                 nullable=True)
    config_json         = Column(JSON, nullable=True,
                                 comment="fields, filters, sort, group_by, aggregations, date_range")
    chart_config_json   = Column(JSON, nullable=True)
    schedule_config_json = Column(JSON, nullable=True)
    is_active           = Column(Boolean, default=True)
    # visibility: private = creator only | org = all users with any reports.*.view permission
    visibility          = Column(Enum("private", "org"), default="private", nullable=False)
    created_by          = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by          = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at          = Column(DateTime, server_default=func.now())
    updated_at          = Column(DateTime, server_default=func.now(), onupdate=func.now())
    # Audit / usage tracking — drives the report listing page (last run, access frequency)
    last_run_at         = Column(DateTime, nullable=True)
    last_accessed_at    = Column(DateTime, nullable=True)
    run_count           = Column(Integer, default=0, nullable=False)

    report_type = relationship("ReportType", back_populates="saved_reports")
    folder      = relationship("ReportFolder", back_populates="saved_reports")
    creator     = relationship("User", foreign_keys=[created_by])


class ReportSavedFilter(TenantBase):
    """A saved quick+advanced filter preset for a report type — separate from SavedReport
    (which saves the whole report definition). Locked/drilldown filters are never stored here."""
    __tablename__  = "report_saved_filters"
    __table_args__ = {"extend_existing": True}

    id              = Column(Integer, primary_key=True, autoincrement=True)
    report_type_key = Column(String(100), nullable=False, index=True)
    filter_name     = Column(String(150), nullable=False)
    filter_type     = Column(Enum("quick", "advanced", "mixed"), default="mixed", nullable=False)
    config_json     = Column(JSON, nullable=False,
                             comment="{quick_filters: {...}, advanced_filters: [FilterItem, ...]}")
    # visibility: private = creator only | org = all users with access to this report type
    visibility      = Column(Enum("private", "org"), default="private", nullable=False)
    created_by      = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at      = Column(DateTime, server_default=func.now())
    updated_at      = Column(DateTime, server_default=func.now(), onupdate=func.now())

    creator = relationship("User", foreign_keys=[created_by])


# =============================================================================
# QUOTATION  (direct opportunity → quotation → PO → work order flow)
# =============================================================================

class Quotation(TenantBase):
    __tablename__  = "quotations"
    __table_args__ = {"extend_existing": True}

    id                = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id         = Column(Integer, nullable=True)
    lead_id           = Column(Integer, ForeignKey("leads.id",    ondelete="SET NULL"), nullable=True)
    tender_id         = Column(Integer, ForeignKey("tenders.id",  ondelete="SET NULL"), nullable=True)
    customer_id       = Column(Integer, ForeignKey("customers.id", ondelete="SET NULL"), nullable=True)
    letter_id         = Column(Integer, nullable=True, index=True)
    quotation_number  = Column(String(50), nullable=False)
    revision_number   = Column(Integer, default=1, nullable=False,
                               comment="1=Q1, 2=Q2, 3=Q3 etc.")
    subject           = Column(String(500), nullable=True)
    amount            = Column(DECIMAL(15, 2), default=0)
    tax_amount        = Column(DECIMAL(15, 2), default=0)
    total_amount      = Column(DECIMAL(15, 2), default=0)
    valid_until       = Column(Date, nullable=True)
    status            = Column(
        Enum('Draft', 'Sent', 'Approved', 'Accepted', 'Rejected'),
        default='Draft', nullable=False,
    )
    notes                = Column(Text, nullable=True)
    terms_conditions     = Column(Text, nullable=True)
    # Letter-pad fields
    ref_number              = Column(String(100), nullable=True)
    customer_to_name        = Column(String(300), nullable=True)
    customer_address_text   = Column(Text, nullable=True)
    greeting_text           = Column(Text, nullable=True)
    signatory_user_id       = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    company_name_override   = Column(String(300), nullable=True)
    company_address_override= Column(Text, nullable=True)
    # Approval
    approval_status      = Column(String(20), nullable=True, default='none')
    approval_id          = Column(Integer, nullable=True)
    created_by           = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at           = Column(DateTime, server_default=func.now())
    updated_at           = Column(DateTime, onupdate=func.now())
    company_address_id = Column(Integer, nullable=True)
    company_address_text = Column(Text, nullable=True)

    lead      = relationship("Lead",     foreign_keys=[lead_id])
    tender    = relationship("Tender",   foreign_keys=[tender_id])
    customer  = relationship("Customer", foreign_keys=[customer_id])
    creator   = relationship("User",     foreign_keys=[created_by])
    signatory = relationship("User",     foreign_keys=[signatory_user_id])
    line_items = relationship("QuotationLineItem", back_populates="quotation",
                              cascade="all, delete-orphan")


class QuotationLineItem(TenantBase):
    __tablename__  = "quotation_line_items"
    __table_args__ = {"extend_existing": True}

    id           = Column(Integer, primary_key=True, autoincrement=True)
    quotation_id = Column(Integer, ForeignKey("quotations.id", ondelete="CASCADE"), nullable=False)
    description  = Column(String(500), nullable=False)
    quantity     = Column(DECIMAL(10, 2), default=1)
    unit_price   = Column(DECIMAL(15, 2), default=0)
    tax_percent  = Column(DECIMAL(5, 2), default=0)
    net_price    = Column(DECIMAL(15, 2), default=0)   # qty × unit_price
    gst_value    = Column(DECIMAL(15, 2), default=0)   # net_price × tax_percent/100
    line_total   = Column(DECIMAL(15, 2), default=0)   # net_price + gst_value
    sort_order   = Column(Integer, default=0)
    # Quotes (prototype v17): line discount and catalogue product – added by quote_service.ensure_schema / migrate_quotes_v17.sql
    discount_percent = Column(DECIMAL(5, 2), nullable=False, default=0, server_default="0")
    product_id       = Column(Integer, nullable=True)

    quotation = relationship("Quotation", back_populates="line_items")


# =============================================================================
# TENDER
# =============================================================================
 
class Tender(TenantBase):
    __tablename__  = "tenders"
    __table_args__ = {"extend_existing": True}
 
    id          = Column(Integer, primary_key=True, autoincrement=True)
    tender_num = Column(String(100), nullable=True, unique=True)

    tender_fee_dd_in_favour_of = Column(String(200))
    tender_fee_dd_payable_at = Column(String(200))
    tender_fee_customer_name = Column(String(200))
    tender_fee_account_no = Column(String(100))
    tender_fee_ifsc_code = Column(String(50))
    tender_fee_gateway_name = Column(String(200))
    tender_fee_bg_validity_days = Column(Integer)
    tender_fee_bg_validity_date = Column(Date)
    tender_fee_bg_bank_type = Column(String(100))

    emd_dd_in_favour_of = Column(String(200))
    emd_dd_payable_at = Column(String(200))
    emd_customer_name = Column(String(200))
    emd_account_no = Column(String(100))
    emd_ifsc_code = Column(String(50))
    emd_gateway_name = Column(String(200))
    emd_bg_validity_days = Column(Integer)
    emd_bg_validity_date = Column(Date)
    emd_bg_bank_type = Column(String(100))

    pbg_payment_method = Column(String(50))
    pbg_dd_in_favour_of = Column(String(200))
    pbg_dd_payable_at = Column(String(200))
    pbg_customer_name = Column(String(200))
    pbg_account_no = Column(String(100))
    pbg_ifsc_code = Column(String(50))
    pbg_gateway_name = Column(String(200))
    pbg_bg_validity_days = Column(Integer)
    pbg_bg_validity_date = Column(Date)
    pbg_bg_bank_type = Column(String(100))
    # -- WORK ORDER / PO DETAILS ---------------------------------------------
    
    
    po_num        = Column(String(50), nullable=True)
    wrk_order_id  = Column(String(50), nullable=True)
    po_doc     = Column(String(500), nullable=True)
    po_date    = Column(Date, nullable=True)
    po_value   = Column(DECIMAL(10, 0), nullable=True)
    no_of_consignee = Column(Integer, nullable=True, comment="Number of consignees for PO")

    wo_value   = Column(DECIMAL(10, 0), nullable=True)

    wrnty_mth  = Column(Integer, nullable=True, comment="Warranty Months")

    dlvry_date = Column(Date, nullable=True)
    instln_date = Column(Date, nullable=True)

    site_loc   = Column(String(30), nullable=True)
    site_eng   = Column(String(30), nullable=True)
    eng_phone  = Column(String(20), nullable=True)

    advance    = Column(String(10), nullable=True)
    retention  = Column(String(10), nullable=True)

    pmnt_terms = Column(Text, nullable=True)
    sow        = Column(Text, nullable=True)

    # -- PO Completion & Penalty -----------------------------------------------
    completion_days    = Column(Integer, nullable=True, comment="Days to completion from PO date")
    completion_date    = Column(Date, nullable=True, comment="Auto-calculated completion date")
    penalty            = Column(Boolean, default=False, nullable=True, comment="Penalty applicable")
    ld_type            = Column(String(10), nullable=True, comment="LD Type: MIN or MAX")
    ld_percent         = Column(DECIMAL(5, 2), nullable=True, comment="LD Percentage")
    po_workflow_status = Column(String(30), nullable=False, server_default='draft',
                                comment="PO approval: draft, pending_approval, approved")
    consignee_submitted = Column(Boolean, nullable=False, server_default='0',
                                 comment="Consignees submitted (step 7 final)")

    # -- STEP 1 — Basic Info ----------------------------------------------------
    lead_id            = Column(Integer, ForeignKey("leads.id", ondelete="SET NULL"), nullable=True,
                                comment="Source lead that was converted into this tender")
    customer_id        = Column(Integer, ForeignKey("customers.id", ondelete="SET NULL"), nullable=True)
    customer_name      = Column(String(300))
    tender_title       = Column(String(500),   comment="Human-readable tender name")
    portal_ref_number  = Column(String(200))
    est_value          = Column(DECIMAL(15, 2), comment="Estimated tender value")
    source_id          = Column(Integer, nullable=True,
                               comment="FK to sources/masters table — no FK constraint")
    business_vertical_id = Column(
        Integer,
        nullable=True,
        comment="Selected business vertical (unit) id — no FK constraint, mirrors Lead.business_vertical_id",
    )
    source_portal      = Column(
        Enum('IREPS', 'GeM', 'CPP', 'CPPP', 'NIC', 'Direct', 'Other'),
        default='Other',
    )
    tender_status = Column(
        Enum('Aligned', 'Evaluation', 'Submitted', 'Pre-Bid', 'Reverse Auction', 'Closed'),
        nullable=False, default='Aligned',
        comment="Tender lifecycle status (ordered workflow)",
    )
    published_date   = Column(Date, nullable=True)
    pre_bid_date     = Column(Date, nullable=True)
    submission_date  = Column(Date, nullable=True)
    assigned_to      = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by       = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    notes            = Column(Text)
    rfp_document     = Column(String(500), comment="Step 1: RFP/Tender document file path")
 
    # -- STEP 2 — Tender Details ------------------------------------------------
    tender_fee_required        = Column(Boolean, default=False)
    tender_fee_amount          = Column(DECIMAL(15, 2))
    tender_fee_method          = Column(String(50))    # DD, BG, Online, NEFT
    tender_fee_bg_days         = Column(Integer)
    tender_fee_payment_details = Column(Text)
 
    emd_required       = Column(Boolean, default=False)
    emd_amount         = Column(DECIMAL(15, 2))
    emd_payment_method = Column(String(50))            # DD, BG, Online
    emd_bank_name      = Column(String(200))
    emd_bg_days           = Column(Integer)
    emd_reference         = Column(String(200))
    emd_bank_branch       = Column(String(200))
    emd_instrument_number = Column(String(200))
    emd_purpose           = Column(Text)

    tender_fee_bank_name        = Column(String(200))
    tender_fee_bank_branch      = Column(String(200))
    tender_fee_instrument_number = Column(String(200))

    pbg_required   = Column(Boolean, default=False)
    pbg_amount     = Column(DECIMAL(15, 2))
    pbg_bg_days    = Column(Integer)
    pbg_reference  = Column(String(200))
    pbg_bank_name        = Column(String(200))
    pbg_bank_branch      = Column(String(200))
    pbg_instrument_number = Column(String(200))
    pbg_purpose          = Column(Text)

    # -- EMDBG record links (set when Step 2 creates records in emdbg table) -----
    tender_fee_emdbg_id  = Column(Integer, nullable=True)
    emd_emdbg_id         = Column(Integer, nullable=True)
    pbg_emdbg_id         = Column(Integer, nullable=True)

    split_order    = Column(Boolean, default=False,
                            comment="Step 2: Split Order allowed (Yes/No)")
    reverse_auction = Column(Boolean, default=False,
                             comment="Step 2: Reverse Auction applicable (Yes/No)")
    bid_tracking   = Column(String(200), nullable=True,
                             comment="Step 2: Bid tracking reference / portal link")
 
    # -- STEP 3 — Workings ------------------------------------------------------
    workings_document    = Column(String(500), comment="Step 3: Workings Excel file path")
    corrigendum_document = Column(String(500), comment="Step 3: Corrigendum document file path")
 
    # -- STEP 4 — Tech Bid ------------------------------------------------------
    tech_bid_eligible = Column(
        Enum('Eligible', 'Not Eligible', 'Not Evaluated'),
        nullable=True,
        comment="Step 4: Technical bid eligibility outcome",
    )
 
    # -- STEP 5 — Financial -----------------------------------------------------
    bid_amount                = Column(DECIMAL(15, 2))
    result                    = Column(
        Enum('Pending', 'Won', 'Lost', 'Cancelled'), default='Pending',
    )
    result_date               = Column(Date, nullable=True)
    reverse_auction_final_bid = Column(DECIMAL(15, 2),
                                        comment="Step 5: Final bid amount after reverse auction")
 
    # -- WORKFLOW ---------------------------------------------------------------
    current_step     = Column(SmallInteger, default=1,
                              comment="Furthest step reached by this tender (1–5)")
    workflow_status  = Column(
        String(40), default='draft',
        comment="draft | step2_pending | active | "
                "rejected | step3_pending | step3_active",
    )
 
    # Step-2 approval chain
    step2_approval_id  = Column(Integer, ForeignKey("approvals.id", ondelete="SET NULL"), nullable=True)
    step2_approved_at  = Column(DateTime, nullable=True,
                                 comment="Timestamp when Step 2 hierarchy approval completed")
 
    # Step-3 approval chain
    step3_approval_id  = Column(Integer, ForeignKey("approvals.id", ondelete="SET NULL"), nullable=True)
    step3_approved_at  = Column(DateTime, nullable=True,
                                 comment="Timestamp when Step 3 hierarchy approval completed")
 
    # Accounts visibility
    listed_in_accounts = Column(Boolean, default=False,
                                 comment="True once CEO approves Step 2; accounts dashboard can see")

    # -- Dynamic form custom fields -------------------------------------------
    custom_data = Column(JSON, nullable=True)

    # -- META -------------------------------------------------------------------
    is_deleted = Column(Boolean, default=False)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())
 
    # -- Relationships ----------------------------------------------------------
    products      = relationship("TenderProduct",      back_populates="tender",
                                  cascade="all, delete-orphan")
    documents     = relationship("TenderDocument",     back_populates="tender",
                                  cascade="all, delete-orphan")
    bidders       = relationship("TenderTechBidBidder", back_populates="tender",
                                  cascade="all, delete-orphan",
                                  order_by="TenderTechBidBidder.sort_order")
    loss_analysis = relationship("TenderLossAnalysis", back_populates="tender",
                                  uselist=False, cascade="all, delete-orphan")
    assignee      = relationship("User", foreign_keys=[assigned_to])
    creator       = relationship("User", foreign_keys=[created_by])



 
# -- Index hints ----------------------------------------------------------------
Index("idx_tenders_workflow_status",    Tender.workflow_status)
Index("idx_tenders_current_step",       Tender.current_step)
Index("idx_tenders_listed_in_accounts", Tender.listed_in_accounts)
Index("idx_tenders_assigned_to",        Tender.assigned_to)
 
 
# =============================================================================
# TENDER PRODUCT  (Step-1 BOQ  +  Step-3 Final BOQ)
# =============================================================================
 
class TenderProduct(TenantBase):
    __tablename__  = "tender_products"
    __table_args__ = (
        Index("idx_tp_tender_is_final", "tender_id", "is_final_boq"),
        {"extend_existing": True},
    )
 
    id           = Column(Integer, primary_key=True, autoincrement=True)
    tender_id    = Column(Integer, ForeignKey("tenders.id", ondelete="CASCADE"), nullable=False)
 
    # -- Product identity -------------------------------------------------------
    product_id   = Column(Integer, ForeignKey("products_master.id", ondelete="SET NULL"), nullable=True)
    product_name = Column(String(300), nullable=False)
 
    # -- Supply item fields -----------------------------------------------------
    quantity          = Column(DECIMAL(10, 2), default=1)
    unit_price        = Column(DECIMAL(15, 2), default=0)
    gst_percent       = Column(DECIMAL(5, 2),  default=0)
    oem_authorization = Column(String(200))
 
    # -- Works item fields (IREPS source) ---------------------------------------
    is_works_item    = Column(Boolean, default=False,
                              comment="True for civil/works line items")
    work_type        = Column(String(100),
                              comment="e.g. Digging, Cable Laying, OHE Work …")
    work_description = Column(String(500))
    work_unit        = Column(String(20),
                              comment="RMT, SQM, CUM, NOS, LOT, SET, KG, MT, KM")
    work_unit_rate   = Column(DECIMAL(15, 2), default=0)
 
    # -- Final BOQ flag & single-OEM fields ------------------------------------
    is_final_boq      = Column(Boolean, default=False,
                                comment="False = Step-1 initial BOQ; True = Step-3 Final BOQ")
    oem_id            = Column(Integer, ForeignKey("oems.id", ondelete="SET NULL"), nullable=True,
                                comment="Final BOQ: OEM id (one OEM per row)")
    oem_name          = Column(String(200),
                                comment="Final BOQ: OEM display name")
    authorization_num = Column(String(200),
                                comment="Final BOQ: OEM authorization / certificate number")
    total_price       = Column(DECIMAL(15, 2),
                                comment="Final BOQ: qty × unit_price × (1 + gst/100)")
 
    sort_order = Column(Integer, default=0)
 
    # -- Relationships ----------------------------------------------------------
    tender = relationship("Tender", back_populates="products")
    oems   = relationship("TenderProductOEM", back_populates="product",
                           cascade="all, delete-orphan")
 
 
# =============================================================================
# TENDER PRODUCT OEM  (Step-1 BOQ — multiple OEMs per product)
# =============================================================================
 
class TenderProductOEM(TenantBase):
    __tablename__  = "tender_product_oems"
    __table_args__ = {"extend_existing": True}

    id                = Column(Integer, primary_key=True, autoincrement=True)
    tender_product_id = Column(Integer, ForeignKey("tender_products.id", ondelete="CASCADE"), nullable=False)
    oem_id            = Column(Integer, ForeignKey("oems.id", ondelete="SET NULL"), nullable=True)
    oem_name          = Column(String(200))
    authorization_num = Column(String(200))
    is_authorized     = Column(Boolean, default=False)
    is_preferred      = Column(Boolean, default=False)

    product = relationship("TenderProduct", back_populates="oems")
 
 
# =============================================================================
# TENDER DOCUMENT
# =============================================================================
 
class TenderDocument(TenantBase):
    __tablename__  = "tender_documents"
    __table_args__ = {"extend_existing": True}
 
    id          = Column(Integer, primary_key=True, autoincrement=True)
    tender_id   = Column(Integer, ForeignKey("tenders.id", ondelete="CASCADE"), nullable=False)
    doc_type    = Column(
        Enum('Tender Document', 'BOQ', 'Workings', 'Corrigendum', 'OEM Document', 'PO Document', 'Other'),
        nullable=False, default='Other',
    )
    file_name   = Column(String(300))
    file_url    = Column(String(500), nullable=False,
                          comment="Relative path: /media/<tenant_slug>/tenders/<uuid>.<ext>")
    uploaded_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at  = Column(DateTime, server_default=func.now())
 
    tender      = relationship("Tender", back_populates="documents")


# =============================================================================
# DOCUMENT MANAGEMENT — standalone uploads, shares, stars
# =============================================================================

class DocumentFolder(TenantBase):
    __tablename__  = "document_folders"
    __table_args__ = {"extend_existing": True}

    id         = Column(Integer, primary_key=True, autoincrement=True)
    name       = Column(String(200), nullable=False)
    parent_id  = Column(Integer, ForeignKey("document_folders.id", ondelete="SET NULL"), nullable=True, index=True)
    owner_id   = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime, server_default=func.now())
    # Document Hub (prototype v17) – added by dochub_service.ensure_schema
    is_shared  = Column(Boolean, nullable=False, default=False)   # shared (company-wide) vs personal folder


class DocumentManagementFile(TenantBase):
    __tablename__  = "document_management_files"
    __table_args__ = {"extend_existing": True}

    id           = Column(Integer, primary_key=True, autoincrement=True)
    name         = Column(String(300), nullable=False)
    description  = Column(String(500), nullable=True)
    file_url     = Column(String(500), nullable=False)
    file_size_kb = Column(Integer, nullable=True)
    uploaded_by  = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    linked_source = Column(String(40), nullable=True, index=True)
    linked_record_id = Column(Integer, nullable=True, index=True)
    linked_record_label = Column(String(300), nullable=True)
    doc_type     = Column(String(120), nullable=True)
    folder_id    = Column(Integer, ForeignKey("document_folders.id", ondelete="SET NULL"), nullable=True, index=True)
    deleted_at   = Column(DateTime, nullable=True)
    deleted_by   = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at   = Column(DateTime, server_default=func.now())

    # Document Hub (prototype v17) – tags + version chain, added by dochub_service.ensure_schema
    tags       = Column(JSON, nullable=True)
    version    = Column(Integer, nullable=False, default=1)
    version_of = Column(Integer, ForeignKey("document_management_files.id", ondelete="CASCADE"), nullable=True, index=True)

    # Approval workflow — reuses the existing Status column for display (Uploaded /
    # Pending Approval / Approved / Rejected); only applies to standalone uploads.
    approval_status      = Column(String(30), nullable=True)
    submitted_by         = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    submitted_at         = Column(DateTime, nullable=True)
    approval_decided_by  = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    approval_decided_at  = Column(DateTime, nullable=True)
    approval_comment     = Column(String(1000), nullable=True)


class DocumentShare(TenantBase):
    __tablename__  = "document_shares"
    __table_args__ = (
        UniqueConstraint("document_id", "shared_with", name="uq_document_share_target"),
        {"extend_existing": True},
    )

    id          = Column(Integer, primary_key=True, autoincrement=True)
    document_id = Column(String(160), nullable=False, index=True)
    shared_by   = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    shared_with = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at  = Column(DateTime, server_default=func.now())


class DocumentTrash(TenantBase):
    __tablename__  = "document_trash"
    __table_args__ = (
        UniqueConstraint("document_id", name="uq_document_trash_document"),
        {"extend_existing": True},
    )

    id          = Column(Integer, primary_key=True, autoincrement=True)
    document_id = Column(String(160), nullable=False, index=True)
    trashed_by  = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    trashed_at  = Column(DateTime, server_default=func.now())
    deleted_by  = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    deleted_at  = Column(DateTime, nullable=True)


class DocumentStar(TenantBase):
    __tablename__  = "document_stars"
    __table_args__ = (
        UniqueConstraint("document_id", "user_id", name="uq_document_star_user"),
        {"extend_existing": True},
    )

    id          = Column(Integer, primary_key=True, autoincrement=True)
    document_id = Column(String(160), nullable=False, index=True)
    user_id     = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at  = Column(DateTime, server_default=func.now())


# =============================================================================
# TENDER TECH BID — Bidders & Items  (Step 4)
# =============================================================================
 
# =============================================================================
# LETTER MANAGEMENT
# =============================================================================

class LetterType(TenantBase):
    __tablename__ = "letter_types"
    __table_args__ = (
        UniqueConstraint("key", name="uq_letter_types_key"),
        {"extend_existing": True},
    )

    id          = Column(Integer, primary_key=True, autoincrement=True)
    key         = Column(String(100), nullable=False)
    name        = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)
    is_active   = Column(Boolean, default=True, nullable=False)
    sort_order  = Column(Integer, default=0, nullable=False)
    created_by  = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by  = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at  = Column(DateTime, server_default=func.now())
    updated_at  = Column(DateTime, onupdate=func.now())


class LetterTemplate(TenantBase):
    __tablename__ = "letter_templates"
    __table_args__ = (
        UniqueConstraint("letter_type_id", "name", "version", name="uq_letter_templates_type_name_version"),
        Index("ix_letter_templates_type_active", "letter_type_id", "is_active"),
        {"extend_existing": True},
    )

    id             = Column(Integer, primary_key=True, autoincrement=True)
    letter_type_id = Column(Integer, ForeignKey("letter_types.id", ondelete="SET NULL"), nullable=True)
    name           = Column(String(200), nullable=False)
    folder         = Column(String(200), nullable=True)
    description    = Column(Text, nullable=True)
    subject        = Column(String(300), nullable=True)
    template_body  = Column(Text, nullable=False)
    variables      = Column(JSON, nullable=True)
    version        = Column(Integer, default=1, nullable=False)
    is_default     = Column(Boolean, default=False, nullable=False)
    is_active      = Column(Boolean, default=True, nullable=False)
    is_deleted     = Column(Boolean, default=False, nullable=False)
    deleted_at     = Column(DateTime, nullable=True)
    deleted_by     = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by     = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by     = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at     = Column(DateTime, server_default=func.now())
    updated_at     = Column(DateTime, onupdate=func.now())


class Letter(TenantBase):
    __tablename__ = "letters"
    __table_args__ = (
        UniqueConstraint("letter_no", name="uq_letters_letter_no"),
        Index("ix_letters_linked_record", "linked_source", "linked_record_id"),
        Index("ix_letters_type_status", "letter_type_id", "status"),
        {"extend_existing": True},
    )

    id                  = Column(Integer, primary_key=True, autoincrement=True)
    letter_no           = Column(String(80), nullable=True)
    letter_type_id      = Column(Integer, ForeignKey("letter_types.id", ondelete="SET NULL"), nullable=True)
    letter_template_id  = Column(Integer, ForeignKey("letter_templates.id", ondelete="SET NULL"), nullable=True)
    title               = Column(String(300), nullable=False)
    subject             = Column(String(300), nullable=True)
    body                = Column(Text, nullable=True)
    status              = Column(String(30), default="Draft", nullable=False)
    linked_source       = Column(String(40), nullable=True)
    linked_record_id    = Column(Integer, nullable=True)
    linked_record_label = Column(String(300), nullable=True)
    recipient_name      = Column(String(200), nullable=True)
    recipient_email     = Column(String(200), nullable=True)
    recipient_address   = Column(Text, nullable=True)
    issue_date          = Column(Date, nullable=True)
    issued_at           = Column(DateTime, nullable=True)
    issued_by           = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    is_deleted          = Column(Boolean, default=False, nullable=False)
    deleted_at          = Column(DateTime, nullable=True)
    deleted_by          = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by          = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by          = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at          = Column(DateTime, server_default=func.now())
    updated_at          = Column(DateTime, onupdate=func.now())


class LetterDocument(TenantBase):
    __tablename__ = "letter_documents"
    __table_args__ = (
        Index("ix_letter_documents_letter_id", "letter_id"),
        {"extend_existing": True},
    )

    id           = Column(Integer, primary_key=True, autoincrement=True)
    letter_id    = Column(Integer, ForeignKey("letters.id", ondelete="CASCADE"), nullable=False)
    doc_type     = Column(String(120), nullable=True)
    file_name    = Column(String(300), nullable=False)
    file_url     = Column(String(500), nullable=False)
    file_size_kb = Column(Integer, nullable=True)
    mime_type    = Column(String(150), nullable=True)
    uploaded_by  = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at   = Column(DateTime, server_default=func.now())


class LetterHistory(TenantBase):
    __tablename__ = "letter_history"
    __table_args__ = (
        Index("ix_letter_history_letter_time", "letter_id", "created_at"),
        {"extend_existing": True},
    )

    id           = Column(Integer, primary_key=True, autoincrement=True)
    letter_id    = Column(Integer, ForeignKey("letters.id", ondelete="CASCADE"), nullable=False)
    action       = Column(String(80), nullable=False)
    from_status  = Column(String(30), nullable=True)
    to_status    = Column(String(30), nullable=True)
    remarks      = Column(Text, nullable=True)
    old_data     = Column(JSON, nullable=True)
    new_data     = Column(JSON, nullable=True)
    performed_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at   = Column(DateTime, server_default=func.now())


class TenderTechBidBidder(TenantBase):
    __tablename__  = "tender_tech_bid_bidders"
    __table_args__ = {"extend_existing": True}
 
    id          = Column(Integer, primary_key=True, autoincrement=True)
    tender_id   = Column(Integer, ForeignKey("tenders.id", ondelete="CASCADE"), nullable=False)
    bidder_name = Column(String(300), nullable=False)
    bidder_type = Column(String(100),
                          comment="e.g. Manufacturer, Trader, Authorized Dealer")
    sort_order  = Column(Integer, default=0)
    created_at  = Column(DateTime, server_default=func.now())
 
    tender = relationship("Tender",           back_populates="bidders")
    items  = relationship("TenderTechBidItem", back_populates="bidder",
                           cascade="all, delete-orphan",
                           order_by="TenderTechBidItem.sort_order")
 
 
class TenderTechBidItem(TenantBase):
    __tablename__  = "tender_tech_bid_items"
    __table_args__ = {"extend_existing": True}
 
    id                = Column(Integer, primary_key=True, autoincrement=True)
    bidder_id         = Column(Integer, ForeignKey("tender_tech_bid_bidders.id", ondelete="CASCADE"), nullable=False)
    tender_id         = Column(Integer, ForeignKey("tenders.id",                ondelete="CASCADE"), nullable=False)
    product_id        = Column(Integer, ForeignKey("products_master.id", ondelete="SET NULL"), nullable=True)
    product_name      = Column(String(300))
    oem_id            = Column(Integer, ForeignKey("oems.id", ondelete="SET NULL"), nullable=True)
    oem_name          = Column(String(200))
    authorization_ref = Column(String(200),
                                comment="OEM authorization reference for this bidder item")
    sort_order        = Column(Integer, default=0)
 
    bidder = relationship("TenderTechBidBidder", back_populates="items")
 
 
# =============================================================================
# TENDER LOSS ANALYSIS  (Step 5 — Result = Lost)
# =============================================================================
 
class TenderLossAnalysis(TenantBase):
    __tablename__  = "tender_loss_analysis"
    __table_args__ = {"extend_existing": True}
 
    id               = Column(Integer, primary_key=True, autoincrement=True)
    tender_id        = Column(Integer, ForeignKey("tenders.id", ondelete="CASCADE"), nullable=False, unique=True)
 
    our_position     = Column(String(50),
                               comment="Our rank: L1 / L2 / L3 — used when Split Order = Yes")
 
    # Split Order = No  ?  just L1/L2/L3 company + amount
    # Split Order = Yes ?  our_position + L2/L3 competitor details if we are L1, etc.
    competitor_name   = Column(String(300))
    competitor_amount = Column(DECIMAL(15, 2), default=0)
    our_bid_amount    = Column(DECIMAL(15, 2), default=0)
 
    l1_company = Column(String(300))
    l1_amount  = Column(DECIMAL(15, 2), default=0)
    l2_company = Column(String(300))
    l2_amount  = Column(DECIMAL(15, 2), default=0)
    l3_company = Column(String(300))
    l3_amount  = Column(DECIMAL(15, 2), default=0)

    loss_reason = Column(Text, nullable=True, comment="Reason for losing the tender")

    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())

    tender = relationship("Tender", back_populates="loss_analysis")


# =============================================================================
# TENDER CONSIGNEE  (Result = Won — delivery / dispatch destination)
# =============================================================================

class TenderConsignee(TenantBase):
    __tablename__  = "tender_consignees"
    __table_args__ = {"extend_existing": True}

    id             = Column(Integer, primary_key=True, autoincrement=True)
    tender_id      = Column(Integer, ForeignKey("tenders.id", ondelete="CASCADE"), nullable=True)
    lead_id        = Column(Integer, ForeignKey("leads.id", ondelete="CASCADE"), nullable=True,
                            comment="FK to leads.id for direct opportunity flow (no tender)")

    consignee_name = Column(String(255), nullable=False, comment="Consignee / receiving party name")
    address        = Column(Text,        nullable=True)
    city           = Column(String(100), nullable=True)
    state          = Column(String(100), nullable=True)
    pincode        = Column(String(20),  nullable=True)
    contact_person = Column(String(255), nullable=True)
    contact_phone  = Column(String(30),  nullable=True)
    delivery_date  = Column(Date,        nullable=True)
    notes          = Column(Text,        nullable=True)
    created_by     = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at     = Column(DateTime, server_default=func.now())
    updated_at     = Column(DateTime, onupdate=func.now())

    tender = relationship("Tender", foreign_keys=[tender_id])


# =============================================================================
# APPROVAL
# =============================================================================
 
class Approval(TenantBase):
    __tablename__  = "approvals"
    __table_args__ = (
        Index("idx_approvals_module_record",       "module", "record_id", "status"),
        Index("idx_approvals_requested_to_status", "requested_to", "status"),
        {"extend_existing": True},
    )
 
    id = Column(Integer, primary_key=True, autoincrement=True)
 
    # -- What is being approved -------------------------------------------------
    module     = Column(String(100), nullable=False,
                         comment="'lead', 'tender', 'travel', 'tada', 'emdbg'")
    action     = Column(String(100), nullable=False,
                         comment="'convert_lead_manager', 'tender_step2_manager', "
                                 "'tender_step2_ceo', 'tender_step3_manager', 'tender_step3_ceo'")
    record_id  = Column(Integer, nullable=False,
                         comment="PK of the related record")
    record_ref = Column(String(200),
                         comment="Human-readable label e.g. 'Tender: Delhi Metro CCTV'")
 
    # -- Participants -----------------------------------------------------------
    requested_by = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    requested_to = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
 
    # -- Status -----------------------------------------------------------------
    status = Column(
        Enum('pending', 'approved', 'rejected'),
        default='pending', nullable=False,
    )
 
    # -- Notes ------------------------------------------------------------------
    request_notes    = Column(Text, comment="Set by requester at creation")
    decision_notes   = Column(Text, comment="Set by approver at decision")
    rejection_reason = Column(Text, comment="Set by approver when rejecting")
 
    # -- Flags ------------------------------------------------------------------
    email_sent = Column(Boolean, default=False,
                         comment="True once email notification sent")
    notif_sent = Column(Boolean, default=False,
                         comment="True once in-app notification sent")
 
    # -- Timestamps -------------------------------------------------------------
    decided_at = Column(DateTime, nullable=True,
                         comment="Set when approved or rejected")
    created_at = Column(DateTime, server_default=func.now())
 
    # -- Relationships ----------------------------------------------------------
    requester = relationship("User", foreign_keys=[requested_by])
    approver  = relationship("User", foreign_keys=[requested_to])
 

# -- In-app Notification model (add if not already present) -------------------

class Notification(TenantBase):
    __tablename__  = "notifications"
    __table_args__ = {"extend_existing": True}

    id      = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    # -- Content ---------------------------------------------------------------
    title   = Column(String(200), nullable=False)
    message = Column(Text,        nullable=False)

    # -- Routing / deduplication -----------------------------------------------
    # The combination (user_id, module, record_id, action) is used by _notify()
    # to upsert instead of inserting duplicates.
    # A partial UNIQUE index on these 4 columns is created in migration.sql.
    module    = Column(String(50))    # 'leads', 'tenders', 'travel', 'tada', 'emdbg'
    record_id = Column(Integer)       # PK of the related record (lead.id, tender.id …)
    action    = Column(String(50))    # 'conversion_request', 'conversion_approved',
                                      # 'conversion_rejected'

    # -- State -----------------------------------------------------------------
    is_read    = Column(Boolean,  default=False)
    created_at = Column(DateTime, server_default=func.now())


class TenantAnnouncement(TenantBase):
    """Announcement posted by a user inside this tenant, visible to their own colleagues
    (separate from platform-broadcast announcements, which live in the master DB —
    see app.services.platform_announcements). Supports scheduling: a row with scheduled_at
    in the future is not yet shown in the feed (checked at read time, no background job)."""
    __tablename__  = "tenant_announcements"
    __table_args__ = (
        Index("ix_tenant_announcements_scheduled", "scheduled_at"),   # feed: due rows, oldest job first
        Index("ix_tenant_announcements_created", "created_at"),       # feed: newest first
        {"extend_existing": True},
    )

    id      = Column(Integer, primary_key=True, autoincrement=True)
    title   = Column(String(200), nullable=False)
    message = Column(Text,        nullable=False)
    kind    = Column(Enum("Info", "Important", "Maintenance"), nullable=False, default="Info")

    created_by      = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by_name = Column(String(150))   # denormalised for speed
    created_at      = Column(DateTime, server_default=func.now())

    # NULL = publish immediately. A future value hides the post from the feed until that time.
    scheduled_at = Column(DateTime, nullable=True)
    # Last day the post should still show (inclusive). NULL = no expiry.
    expires_on   = Column(Date, nullable=True)
    # Role names (Role.name) this post is restricted to. NULL/empty = visible to every role.
    target_roles = Column(JSON, nullable=True)


class TenantAnnouncementRead(TenantBase):
    __tablename__  = "tenant_announcement_reads"
    __table_args__ = (
        UniqueConstraint("announcement_id", "user_id", name="uq_tenant_announcement_reads_announcement_user"),
        {"extend_existing": True},
    )

    id              = Column(Integer, primary_key=True, autoincrement=True)
    announcement_id = Column(Integer, ForeignKey("tenant_announcements.id", ondelete="CASCADE"), nullable=False)
    user_id         = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    read_at         = Column(DateTime, server_default=func.now())


class NotificationEventDefinition(TenantBase):
    __tablename__ = "notification_event_definitions"
    __table_args__ = (
        UniqueConstraint("module_key", "event_key", name="uq_notification_event_definitions_module_event"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    module_key = Column(String(50), nullable=False, index=True)
    event_key = Column(String(100), nullable=False)
    label = Column(String(200), nullable=False)
    category = Column(Enum("approval", "alert", "event"), nullable=False, default="event")
    description = Column(Text, nullable=True)
    default_action = Column(String(100), nullable=True)
    is_system = Column(Boolean, default=True, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())

    rules = relationship(
        "NotificationRule",
        back_populates="event_definition",
        cascade="all, delete-orphan",
        order_by="NotificationRule.sort_order",
    )
    templates = relationship(
        "NotificationTemplate",
        back_populates="event_definition",
        cascade="all, delete-orphan",
    )


class NotificationRule(TenantBase):
    __tablename__ = "notification_rules"
    __table_args__ = (
        Index("idx_notification_rules_event_active", "event_definition_id", "is_active"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    event_definition_id = Column(
        Integer,
        ForeignKey("notification_event_definitions.id", ondelete="CASCADE"),
        nullable=False,
    )
    channel = Column(Enum("in_app", "email", "both"), nullable=False, default="both")
    recipient_type = Column(String(50), nullable=False)
    recipient_role = Column(String(50), nullable=True)
    recipient_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    record_field_name = Column(String(100), nullable=True)
    condition_json = Column(JSON, nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    sort_order = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())

    event_definition = relationship("NotificationEventDefinition", back_populates="rules")


class NotificationTemplate(TenantBase):
    __tablename__ = "notification_templates"
    __table_args__ = (
        UniqueConstraint("event_definition_id", "channel", name="uq_notification_templates_event_channel"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    event_definition_id = Column(
        Integer,
        ForeignKey("notification_event_definitions.id", ondelete="CASCADE"),
        nullable=False,
    )
    channel = Column(Enum("in_app", "email"), nullable=False)
    subject_template = Column(String(255), nullable=True)
    body_template = Column(Text, nullable=True)
    html_template = Column(Text, nullable=True)
    action_url_template = Column(String(500), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())

    event_definition = relationship("NotificationEventDefinition", back_populates="templates")


class NotificationDeliveryLog(TenantBase):
    __tablename__ = "notification_delivery_logs"
    __table_args__ = (
        Index("idx_notification_delivery_logs_event_sent", "event_definition_id", "sent_at"),
        UniqueConstraint("dedupe_key", name="uq_notification_delivery_logs_dedupe_key"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    event_definition_id = Column(
        Integer,
        ForeignKey("notification_event_definitions.id", ondelete="SET NULL"),
        nullable=True,
    )
    module_key = Column(String(50), nullable=False, index=True)
    record_id = Column(Integer, nullable=True)
    recipient_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    recipient_email = Column(String(255), nullable=True)
    resolver_key = Column(String(100), nullable=True)
    recipient_kind = Column(String(20), nullable=True)
    recipient_source = Column(String(50), nullable=True)
    channel = Column(String(20), nullable=False)
    status = Column(String(20), nullable=False, default="pending")
    error_message = Column(Text, nullable=True)
    sent_at = Column(DateTime, server_default=func.now(), nullable=False)
    dedupe_key = Column(String(255), nullable=True)


class WorkOrder(TenantBase):
    __tablename__ = "work_orders"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    wo_number = Column(String(100), nullable=False, unique=True)
    wo_type = Column(Enum('Supply','Supply & Installation','AMC','Service','Turnkey'), default='Supply')
    customer_id = Column(Integer, ForeignKey("customers.id", ondelete="SET NULL"))
    customer_name = Column(String(200), nullable=False)
    tender_id = Column(Integer, ForeignKey("tenders.id", ondelete="SET NULL"))
    lead_id = Column(Integer, nullable=True)
    quotation_id = Column(Integer, nullable=True)
    no_of_consignee = Column(Integer, nullable=True, default=None)
    po_number = Column(String(100)); po_date = Column(Date)
    po_doc = Column(String(500))
    po_value = Column(Numeric(15, 2), default=0); wo_value = Column(Numeric(15, 2), default=0)
    project_title = Column(String(300)); scope_of_work = Column(Text)
    delivery_date = Column(Date); installation_date = Column(Date); completion_date = Column(Date)
    site_location = Column(String(300)); site_engineer = Column(String(100)); site_engineer_phone = Column(String(20))
    project_manager_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    status = Column(Enum('Draft','Confirmed','In Progress','On Hold','Delayed','Completed','Cancelled','Closed','Won','Lost'), default='Draft')
    progress_percent = Column(Integer, default=0)
    advance_percent = Column(Numeric(5, 2), default=0); advance_amount = Column(Numeric(15, 2), default=0)
    advance_received = Column(Boolean, default=False); advance_received_date = Column(Date)
    retention_percent = Column(Numeric(5, 2), default=0); retention_released = Column(Boolean, default=False)
    payment_terms = Column(Text); penalty_clause = Column(Text)
    warranty_months = Column(Integer, default=12); warranty_expiry = Column(Date)
    insurance_required = Column(Boolean, default=False); insurance_amount = Column(Numeric(15, 2))
    po_document_url = Column(String(500)); completion_certificate_url = Column(String(500))
    notes = Column(Text); tags = Column(JSON)
    custom_data = Column(JSON, nullable=True)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    created_at = Column(DateTime, server_default=func.now()); updated_at = Column(DateTime, onupdate=func.now())


class WOLineItem(TenantBase):
    __tablename__ = "wo_line_items"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    wo_id = Column(Integer, ForeignKey("work_orders.id", ondelete="CASCADE"), nullable=False)
    product_id = Column(Integer, ForeignKey("products_master.id", ondelete="SET NULL"))
    product_name = Column(String(300), nullable=False)
    quantity = Column(Integer, default=1); delivered_qty = Column(Integer, default=0)
    unit_price = Column(Numeric(15, 2), default=0); gst_percent = Column(Numeric(5, 2), default=0)
    total_amount = Column(Numeric(15, 2), default=0); serial_numbers = Column(JSON)
    delivery_status = Column(Enum('Pending','Partial','Delivered'), default='Pending')


class WOMilestone(TenantBase):
    __tablename__ = "wo_milestones"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    wo_id = Column(Integer, ForeignKey("work_orders.id", ondelete="CASCADE"), nullable=False)
    title = Column(String(200), nullable=False); description = Column(Text)
    milestone_type = Column(Enum('Delivery','Installation','Testing','Sign-off','Payment','Other'), default='Delivery')
    due_date = Column(Date); completed_date = Column(Date)
    amount = Column(Numeric(15, 2), default=0)
    payment_received = Column(Boolean, default=False); payment_date = Column(Date)
    status = Column(Enum('Pending','In Progress','Completed','Delayed','Skipped'), default='Pending')
    notes = Column(Text); document_url = Column(String(500))


class WOInvoice(TenantBase):
    __tablename__ = "wo_invoices"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    wo_id = Column(Integer, ForeignKey("work_orders.id", ondelete="CASCADE"), nullable=False)
    invoice_number = Column(String(100), nullable=False); invoice_date = Column(Date); due_date = Column(Date)
    amount = Column(Numeric(15, 2), nullable=False); gst_amount = Column(Numeric(15, 2), default=0)
    total_amount = Column(Numeric(15, 2), nullable=False)
    payment_status = Column(Enum('Pending','Partial','Paid','Overdue'), default='Pending')
    paid_amount = Column(Numeric(15, 2), default=0); paid_date = Column(Date)
    payment_mode = Column(String(50)); payment_reference = Column(String(100))
    document_url = Column(String(500)); notes = Column(Text)


class EMDBG(TenantBase):
    __tablename__ = "emdbg"
    __table_args__ = {"extend_existing": True}
 
    id            = Column(Integer, primary_key=True, autoincrement=True)
    reference_num = Column(String(100), nullable=False, unique=True)
 
    # -- Tender / client linkage -----------------------------------------------
    tender_num  = Column(String(100), nullable=True)
    tender_id   = Column(Integer, ForeignKey("tenders.id",    ondelete="SET NULL"), nullable=True)
    client_name = Column(String(200), nullable=False)
    customer_id = Column(Integer, ForeignKey("customers.id",  ondelete="SET NULL"), nullable=True)
 
    # -- Work Order / PO linkage (populated after tender win) -----------------
    work_order_id = Column(Integer, ForeignKey("work_orders.id", ondelete="SET NULL"), nullable=True,
                           comment="Optional FK to work_orders.id — set when WO is raised post-award")
    po_number     = Column(String(100), nullable=True, comment="Purchase Order number from client")
    po_date       = Column(Date,        nullable=True, comment="PO date")
    wo_value      = Column(Numeric(15, 2), nullable=True,
                           comment="Work order / contract value for which this instrument was issued")
 
    # -- Instrument details ----------------------------------------------------
    instrument_type   = Column(
        Enum('EMD', 'Performance BG', 'Security Deposit',
             'Advance BG', 'Retention BG', 'DD', 'Online Payment', 'BG', 'FDR',   # BG / FDR: Guarantees & Deposits v17
             'Tender fee',                                                        # Guarantees & Deposits v18
             'EB'),            # EB: security deposit furnished to the Electricity Board for a site power connection
        nullable=False,
    )
    amount            = Column(Numeric(15, 2), nullable=False)
    bank_name         = Column(String(100),    nullable=True)
    bank_branch       = Column(String(100),    nullable=True)
    instrument_number = Column(String(100),    nullable=True)
    issued_date       = Column(Date,           nullable=True)
    submitted_date    = Column(Date,           nullable=True)
    valid_from        = Column(Date,           nullable=True)
    expiry_date       = Column(Date,           nullable=True)
    currency          = Column(String(10),     nullable=False, default='INR')
 
    # -- Approval --------------------------------------------------------------
    approval_status = Column(
        Enum('none', 'pending', 'approved', 'rejected'), default='none'
    )
    approval_id = Column(Integer, nullable=True)
    last_rejection_reason = Column(Text, nullable=True)
    finance_status = Column(String(30), nullable=False, server_default='unpaid')
    finance_paid_date = Column(Date, nullable=True)
    finance_paid_by = Column(Integer, nullable=True)
    finance_notes = Column(Text, nullable=True)
    return_status = Column(String(30), nullable=False, server_default='none')
    return_document_url = Column(String(500), nullable=True)
    return_file_size_kb = Column(Integer, nullable=True)
    return_uploaded_by = Column(Integer, nullable=True)
    return_uploaded_at = Column(DateTime, nullable=True)
    return_confirmed_by = Column(Integer, nullable=True)
    return_confirmed_at = Column(DateTime, nullable=True)
 
    # -- Lifecycle status ------------------------------------------------------
    status = Column(
        Enum('Active', 'Expired', 'Released', 'Encashed', 'Renewed', 'Cancelled', 'Release Requested',
             # Guarantees & Deposits v18 lifecycle (request → head approval → Finance → refund → receipt → acknowledgement)
             'Pending approval', 'Rejected', 'With Finance', 'Paid', 'Received – ack pending', 'Forfeited', 'Exempted'),
        default='Active',
    )
    renewal_status   = Column(Enum('none', 'pending', 'renewed'), default='none')
    renewal_date     = Column(Date,         nullable=True)
    renewed_reference = Column(String(100), nullable=True)
    release_date      = Column(Date,         nullable=True)
    release_reference = Column(String(100),  nullable=True)
 
    # -- Acknowledgement & Payment Proof --------------------------------------
    instrument_acknowledged_at = Column(DateTime,    nullable=True)
    instrument_acknowledged_by = Column(Integer,     nullable=True)
    payment_proof_url          = Column(String(500), nullable=True)
    payment_proof_size_kb      = Column(Integer,     nullable=True)

    # -- Documents -------------------------------------------------------------
    purpose                  = Column(Text,         nullable=True)
    instrument_document_url  = Column(String(500),  nullable=True,
                                      comment="Uploaded BG / DD scan / instrument document")
    instrument_file_size_kb  = Column(Integer,      nullable=True,
                                      comment="File size KB for instrument_document_url")
    release_document_url     = Column(String(500),  nullable=True,
                                      comment="Uploaded discharge / release letter")
    release_file_size_kb     = Column(Integer,      nullable=True,
                                      comment="File size KB for release_document_url")
    notes = Column(Text, nullable=True)
 
    # -- Audit -----------------------------------------------------------------
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())
 
class EMDBGRenewalHistory(TenantBase):
    __tablename__ = "emdbg_renewal_history"
    __table_args__ = {"extend_existing": True}
 
    id              = Column(Integer, primary_key=True, autoincrement=True)
    emdbg_id        = Column(Integer, ForeignKey("emdbg.id", ondelete="CASCADE"), nullable=False)
    old_expiry_date = Column(Date,         nullable=True)
    new_expiry_date = Column(Date,         nullable=True)
    old_reference   = Column(String(100),  nullable=True)
    new_reference   = Column(String(100),  nullable=True)
    # Renewed instrument document
    renewal_document_url = Column(String(500), nullable=True,
                                  comment="Renewed BG / instrument document file path")
    renewal_file_size_kb = Column(Integer,     nullable=True)
    renewed_by      = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    notes           = Column(Text, nullable=True)
    created_at      = Column(DateTime, server_default=func.now())

class KAMTarget(TenantBase):
    __tablename__ = "kam_targets"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    period = Column(String(20), nullable=False)
    calls_target = Column(Integer, default=0); meetings_target = Column(Integer, default=0)
    leads_target = Column(Integer, default=0); revenue_target = Column(Numeric(15, 2), default=0)
    demos_target       = Column(Integer, default=0)
    site_visits_target = Column(Integer, default=0)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    created_at = Column(DateTime, server_default=func.now())
    sales_target = Column(Numeric(15, 0), nullable=True)


class KAMGroupTarget(TenantBase):
    __tablename__ = "kam_group_targets"
    __table_args__ = (
        UniqueConstraint("group_id", "period", name="uq_kam_group_target_period"),
        {"extend_existing": True},
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    group_id = Column(Integer, ForeignKey("org_tree_nodes.id", ondelete="CASCADE"), nullable=False)
    period = Column(String(20), nullable=False)
    sales_target = Column(Numeric(15, 0), nullable=False, default=0)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())


class KAMActivity(TenantBase):
    __tablename__ = "kam_activities"
    __table_args__ = {"extend_existing": True}
 
    id               = Column(Integer,  primary_key=True, autoincrement=True)
    user_id          = Column(Integer,  ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
 
    activity_type = Column(String(50), nullable=False, default="Phone Call")
 
    customer_id      = Column(Integer,  ForeignKey("customers.id",       ondelete="SET NULL"), nullable=True)
    lead_id          = Column(Integer,  ForeignKey("leads.id",           ondelete="SET NULL"), nullable=True)
    tender_id        = Column(Integer,  ForeignKey("tenders.id",         ondelete="SET NULL"), nullable=True)
    work_order_id    = Column(Integer,  ForeignKey("work_orders.id",     ondelete="SET NULL"), nullable=True)
    emdbg_id         = Column(Integer,  ForeignKey("emdbg.id",           ondelete="SET NULL"), nullable=True)

    subject          = Column(String(300), nullable=False)
    description      = Column(Text,        nullable=True)

    activity_date    = Column(Date,    nullable=False)
    start_time       = Column(Time,    nullable=True)
    end_time         = Column(Time,    nullable=True)
    duration_minutes = Column(Integer, nullable=True)
    location         = Column(String(200), nullable=True)
    latitude         = Column(DECIMAL(10, 7), nullable=True)
    longitude        = Column(DECIMAL(10, 7), nullable=True)
    # mode   = Column(
    #     Enum('In-Person', 'Phone', 'Video Call', 'Email'),
    #     nullable=True,
    # )

    mode = Column(String(50), nullable=False, default="Phone Call")

    status = Column(
        Enum('Planned', 'In Progress', 'Completed', 'Cancelled', 'Postponed', 'Reopened'),
        nullable=True,
    )

    # -- Outcome & follow-up ---------------------------------------------------
    outcome             = Column(Text,         nullable=True)
    next_action         = Column(Text,         nullable=True)
    next_action_date    = Column(Date,         nullable=True)
    contacts_met        = Column(Text,         nullable=True)   # stored as JSON text (longtext in DB)
    followup_category   = Column(String(100),  nullable=True)
    followup_sub_type   = Column(String(100),  nullable=True)
    followup_ref_id     = Column(Integer,      nullable=True)
    cancellation_reason = Column(String(255),  nullable=True)
 
    # -- Travel ----------------------------------------------------------------
    has_travel          = Column(Boolean, nullable=False, default=False)
    travel_mode         = Column(String(100), nullable=True)
    travel_from         = Column(String(255), nullable=True)
    travel_to           = Column(String(255), nullable=True)
    is_outside_district = Column(Boolean, nullable=False, default=False)
    travel_request_id   = Column(Integer, ForeignKey("travel_requests.id", ondelete="SET NULL"), nullable=True)
    travel_approved     = Column(Boolean, nullable=True)
 
    # -- Extra columns present in the actual DB --------------------------------
    on_behalf_of = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    user_role    = Column(String(50), nullable=True)   # denormalised role snapshot
 
    # -- Audit -----------------------------------------------------------------
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())

    # -- Reopen / execution-cycle tracking (see _ensure_kam_activity_reopen_schema) --
    current_cycle_no  = Column(Integer, nullable=False, default=1)
    reopen_count      = Column(Integer, nullable=False, default=0)
    last_reopened_at  = Column(DateTime, nullable=True)
    last_reopened_by  = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class KAMLog(TenantBase):
    """Combined append-only event + GPS log for KAM activities (one row per event)."""
    __tablename__ = "kam_log"
    __table_args__ = (
        UniqueConstraint("activity_id", "idempotency_key", name="uq_kam_log_activity_idem"),
        Index("ix_kam_log_activity_time", "activity_id", "event_at"),
        Index("ix_kam_log_actor_time", "actor_user_id", "event_at"),
        Index("ix_kam_log_event_type", "event_type"),
        Index("ix_kam_log_activity_cycle", "activity_id", "cycle_no"),
        Index("ix_kam_log_activity_location", "activity_id", "latitude", "longitude"),
        {"extend_existing": True},
    )

    id                 = Column(Integer, primary_key=True, autoincrement=True)
    activity_id        = Column(Integer, ForeignKey("kam_activities.id", ondelete="RESTRICT"), nullable=False)
    cycle_no           = Column(Integer, nullable=False, default=1)
    event_type         = Column(String(60), nullable=False)
    previous_status    = Column(String(30), nullable=True)
    new_status         = Column(String(30), nullable=True)
    actor_user_id      = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    actor_role         = Column(String(50), nullable=True)
    reason             = Column(String(500), nullable=True)
    remarks            = Column(Text, nullable=True)
    old_values_json    = Column(JSON, nullable=True)
    new_values_json    = Column(JSON, nullable=True)
    metadata_json      = Column(JSON, nullable=True)
    latitude           = Column(DECIMAL(10, 7), nullable=True)
    longitude          = Column(DECIMAL(10, 7), nullable=True)
    accuracy_meters    = Column(DECIMAL(10, 2), nullable=True)
    address            = Column(String(500), nullable=True)
    locality           = Column(String(150), nullable=True)
    district           = Column(String(150), nullable=True)
    state              = Column(String(150), nullable=True)
    postal_code        = Column(String(20), nullable=True)
    permission_status  = Column(String(30), nullable=True)
    is_mock_location   = Column(Boolean, nullable=False, default=False)
    capture_source     = Column(String(30), nullable=True)
    client_event_at    = Column(DateTime, nullable=True)
    event_at           = Column(DateTime, nullable=False)
    source             = Column(String(30), nullable=True)
    device_id          = Column(String(255), nullable=True)
    ip_address         = Column(String(45), nullable=True)
    request_id         = Column(String(100), nullable=True)
    idempotency_key    = Column(String(100), nullable=True)
    created_at         = Column(DateTime, server_default=func.now())


class KAMActivityExecutionCycle(TenantBase):
    """One row per open/complete/reopen cycle of a KAM activity."""
    __tablename__ = "kam_activity_execution_cycles"
    __table_args__ = (
        UniqueConstraint("activity_id", "cycle_no", name="uq_kam_activity_cycle_no"),
        Index("ix_kam_activity_cycle_status", "activity_id", "status"),
        {"extend_existing": True},
    )

    id                       = Column(Integer, primary_key=True, autoincrement=True)
    activity_id              = Column(Integer, ForeignKey("kam_activities.id", ondelete="RESTRICT"), nullable=False)
    cycle_no                 = Column(Integer, nullable=False)
    status                   = Column(String(30), nullable=False, default="Open")
    opened_at                = Column(DateTime, nullable=False)
    opened_by                = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    open_reason              = Column(Text, nullable=True)
    started_at               = Column(DateTime, nullable=True)
    started_by               = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    completed_at             = Column(DateTime, nullable=True)
    completed_by             = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    completion_notes         = Column(Text, nullable=True)
    completion_outcome       = Column(Text, nullable=True)
    actual_duration_minutes  = Column(Integer, nullable=True)
    reopened_at              = Column(DateTime, nullable=True)
    reopened_by              = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    reopen_reason            = Column(Text, nullable=True)
    created_at               = Column(DateTime, server_default=func.now())
    updated_at               = Column(DateTime, onupdate=func.now())


class KAMTaskAssignment(TenantBase):
    __tablename__ = "kam_task_assignments"
    __table_args__ = {"extend_existing": True}
 
    id            = Column(Integer, primary_key=True, autoincrement=True)
    assigned_to   = Column(Integer, ForeignKey("users.id",     ondelete="CASCADE"),  nullable=False)
    assigned_by   = Column(Integer, ForeignKey("users.id",     ondelete="CASCADE"),  nullable=False)
    customer_id   = Column(Integer, ForeignKey("customers.id", ondelete="CASCADE"),  nullable=False)
 
    title         = Column(String(500), nullable=False)
    description   = Column(Text,        nullable=True)
    notes         = Column(Text,        nullable=True)
 
    # Link to auto-created KAMActivity for KPI tracking
    activity_id   = Column(Integer, ForeignKey("kam_activities.id", ondelete="SET NULL"), nullable=True)
 
    activity_type = Column(String(100), nullable=False, default="Task")
    due_date      = Column(Date,        nullable=False)
    priority      = Column(String(20),  nullable=False, default="Medium")
    status        = Column(String(50),  nullable=False, default="Open")
 
    closure_notes       = Column(Text,        nullable=True)
    cancellation_reason = Column(String(255), nullable=True)
    closed_at           = Column(DateTime,    nullable=True)
 
    created_by    = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at    = Column(DateTime, nullable=False, server_default=func.now())
    updated_at    = Column(DateTime, onupdate=func.now())
 
class TravelRequest(TenantBase):
    __tablename__ = "travel_requests"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    request_number = Column(String(50), nullable=False, unique=True)
    employee_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    purpose = Column(String(500), nullable=False)
    visit_type = Column(String(100), default='Customer Visit')
    customer_id = Column(Integer, ForeignKey("customers.id", ondelete="SET NULL"))
    lead_id = Column(Integer, ForeignKey("leads.id", ondelete="SET NULL"))
    tender_id = Column(Integer, ForeignKey("tenders.id", ondelete="SET NULL"))
    opportunity_id = Column(Integer, nullable=True)
    contact_name = Column(String(200), nullable=True)
    contact_phone = Column(String(50), nullable=True)
    from_city = Column(String(100), nullable=False); to_city = Column(String(100), nullable=False)
    travel_date = Column(Date, nullable=False); return_date = Column(Date, nullable=False)
    total_days = Column(Integer)
    is_outside_district = Column(Boolean, default=False)
    # Transport
    transport_mode = Column(String(50), nullable=True,
                             comment='own_vehicle | company_car | train | bus | flight | taxi_cab | bike | other')
    vehicle_number = Column(String(50), nullable=True)
    estimated_kms = Column(Numeric(10, 2), nullable=True)
    advance_booking_ref = Column(String(200), nullable=True)
    mode_of_travel = Column(Enum('Air','Train','Bus','Car (Company)','Car (Personal)','Two Wheeler','Other'), default='Train')
    class_of_travel = Column(Enum('AC 1st','AC 2nd','AC 3rd','Sleeper','Economy','Business','Other'), default='AC 3rd')
    source          = Column(String(20), nullable=False, default='direct',
                              comment='direct | kam — where this request was initiated from')
    kam_activity_id = Column(Integer, ForeignKey("kam_activities.id", ondelete="SET NULL"),
                              nullable=True,
                              comment='Set when request was auto-created by a KAM activity')
    # Accommodation
    accommodation_required = Column(Boolean, default=False)
    accommodation_type = Column(String(100), nullable=True)
    hotel_name = Column(String(200), nullable=True)
    check_in_date = Column(Date, nullable=True)
    check_out_date = Column(Date, nullable=True)
    accommodation_cost = Column(Numeric(12, 2), nullable=True)
    # Budget
    estimated_fare = Column(Numeric(12, 2), default=0)
    estimated_hotel = Column(Numeric(12, 2), default=0)
    estimated_daily_allowance = Column(Numeric(12, 2), default=0)
    estimated_total = Column(Numeric(12, 2), default=0)
    cost_center = Column(String(100), nullable=True)
    budget_code = Column(String(100), nullable=True)
    advance_required = Column(Boolean, default=False); advance_amount = Column(Numeric(12, 2), default=0)
    companions = Column(Text, nullable=True)
    status = Column(Enum('Draft','Submitted','Approved','Rejected','Completed','Cancelled'), default='Draft')
    approval_id = Column(Integer)
    approved_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL")); approved_at = Column(DateTime)
    rejection_reason = Column(Text); notes = Column(Text)
    created_at = Column(DateTime, server_default=func.now()); updated_at = Column(DateTime, onupdate=func.now())
    custom_data = Column(JSON, nullable=True)


class TADAClaim(TenantBase):
    __tablename__ = "tada_claims"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    claim_number = Column(String(50), nullable=False, unique=True)
    travel_request_id = Column(Integer, ForeignKey("travel_requests.id", ondelete="SET NULL"))
    employee_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    claim_date = Column(Date, nullable=False)
    claim_type = Column(String(50), default='travel')
    travel_date_from = Column(Date); travel_date_to = Column(Date)
    num_days = Column(Integer)
    from_city = Column(String(100)); to_city = Column(String(100))
    purpose = Column(String(500))
    mode_of_travel = Column(String(100))
    da_rate_per_day = Column(Numeric(10, 2))
    da_total = Column(Numeric(12, 2))
    expense_mode = Column(String(50))
    cost_center = Column(String(100)); budget_code = Column(String(100)); department = Column(String(100))
    total_amount = Column(Numeric(12, 2), default=0)
    advance_taken = Column(Numeric(12, 2), default=0); net_payable = Column(Numeric(12, 2), default=0)
    manager_status = Column(Enum('pending','approved','rejected'), default='pending')
    manager_approval_id = Column(Integer)
    manager_approved_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL")); manager_approved_at = Column(DateTime)
    manager_rejection_reason = Column(Text)
    accounts_status = Column(Enum('pending','approved','rejected','paid'), default='pending')
    accounts_approval_id = Column(Integer)
    accounts_approved_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL")); accounts_approved_at = Column(DateTime)
    accounts_rejection_reason = Column(Text)
    payment_date = Column(Date); payment_reference = Column(String(100))
    payment_mode = Column(Enum('Bank Transfer','Cheque','Cash','UPI'))
    overall_status = Column(Enum('Draft', 'Submitted', 'Manager Approved', 'CEO Approved', 'Accounts Approved', 'Paid', 'Rejected'),
    default='Draft', nullable=False,)
    notes = Column(Text)
    created_at = Column(DateTime, server_default=func.now()); updated_at = Column(DateTime, onupdate=func.now())


class TADALineItem(TenantBase):
    __tablename__ = "tada_line_items"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    claim_id = Column(Integer, ForeignKey("tada_claims.id", ondelete="CASCADE"), nullable=False)
    expense_date = Column(Date, nullable=False)
    category = Column(Enum('Transport Fare','Auto/Cab','Fuel','Accommodation','Meals','Daily Allowance','Communication','Toll/Parking','Visa/Passport','Miscellaneous'), nullable=False)
    description = Column(String(500), nullable=False)
    from_place = Column(String(100)); to_place = Column(String(100))
    amount = Column(Numeric(12, 2), nullable=False)
    receipt_url = Column(String(500)); receipt_number = Column(String(100))
    vendor_name = Column(String(200))                   
    is_approved = Column(Boolean, default=True); approved_amount = Column(Numeric(12, 2)); notes = Column(String(300))


class Alert(TenantBase):
    __tablename__ = "alerts"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"))
    category = Column(String(100), nullable=False); subcategory = Column(String(100))
    title = Column(String(300), nullable=False); message = Column(Text, nullable=False)
    severity = Column(Enum('info','warning','error','critical'), default='warning')
    module = Column(String(100)); record_id = Column(Integer); record_ref = Column(String(200))
    action_url = Column(String(300))
    email_sent_at = Column(DateTime, nullable=True)
    is_read = Column(Boolean, default=False); is_dismissed = Column(Boolean, default=False)
    auto_generated = Column(Boolean, default=True); expires_at = Column(DateTime)
    created_at = Column(DateTime, server_default=func.now())


class RFPAnalysis(TenantBase):
    __tablename__ = "rfp_analyses"; __table_args__ = {"extend_existing": True}
    id = Column(Integer, primary_key=True, autoincrement=True)
    tender_id = Column(Integer, ForeignKey("tenders.id", ondelete="SET NULL"))
    document_name = Column(String(300)); document_url = Column(String(500))
    document_pages = Column(Integer)
    status = Column(Enum('Pending','Processing','Completed','Failed'), default='Pending')
    key_points = Column(JSON); raw_summary = Column(Text)
    model_used = Column(String(100)); processing_ms = Column(Integer); error_message = Column(Text)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    created_at = Column(DateTime, server_default=func.now())


class WOIssue(TenantBase):
    """Work Order Issues / Snag List"""
    __tablename__ = "wo_issues"
    id           = Column(Integer, primary_key=True, autoincrement=True)
    wo_id        = Column(Integer, ForeignKey("work_orders.id"), nullable=False)
    title        = Column(String(300), nullable=False)
    description  = Column(Text)
    severity     = Column(String(20), default='Medium')   # Low/Medium/High/Critical
    status       = Column(String(30), default='Open')     # Open/In Progress/Resolved/Closed
    reported_by  = Column(Integer, ForeignKey("users.id"))
    assigned_to  = Column(Integer, ForeignKey("users.id"))
    resolution   = Column(Text)
    resolved_date = Column(Date)
    created_at   = Column(DateTime, server_default=func.now())
    updated_at   = Column(DateTime, server_default=func.now(), onupdate=func.now())

class CustomerBillingConsignee(TenantBase):
    __tablename__  = "customer_billing_consignees"
    __table_args__ = {"extend_existing": True}
    id          = Column(Integer, primary_key=True, autoincrement=True)
    customer_id = Column(Integer, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False)
    name        = Column(String(255), nullable=False)
    address     = Column(Text,        nullable=True)
    pincode     = Column(String(20),  nullable=True)
    country     = Column(String(100), nullable=True, default="India")
    state       = Column(String(100), nullable=True)
    city        = Column(String(100), nullable=True)
    area        = Column(String(100), nullable=True)
    is_active   = Column(Boolean,     nullable=False, default=True)
    sort_order  = Column(Integer,     nullable=False, default=0)
    created_at  = Column(DateTime,    nullable=False, server_default=func.now())
    updated_at  = Column(DateTime,    nullable=True,  onupdate=func.now())


class CustomerBillingZone(TenantBase):
    __tablename__  = "customer_billing_zones"
    __table_args__ = {"extend_existing": True}
    id          = Column(Integer, primary_key=True, autoincrement=True)
    customer_id = Column(Integer, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False)
    name        = Column(String(255), nullable=False)
    address     = Column(Text,        nullable=True)
    pincode     = Column(String(20),  nullable=True)
    country     = Column(String(100), nullable=True, default="India")
    state       = Column(String(100), nullable=True)
    city        = Column(String(100), nullable=True)
    area        = Column(String(100), nullable=True)
    is_active   = Column(Boolean,     nullable=False, default=True)
    sort_order  = Column(Integer,     nullable=False, default=0)
    created_at  = Column(DateTime,    nullable=False, server_default=func.now())
    updated_at  = Column(DateTime,    nullable=True,  onupdate=func.now())


class CustomerShippingConsignee(TenantBase):
    __tablename__  = "customer_shipping_consignees"
    __table_args__ = {"extend_existing": True}
    id          = Column(Integer, primary_key=True, autoincrement=True)
    customer_id = Column(Integer, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False)
    name        = Column(String(255), nullable=False)
    address     = Column(Text,        nullable=True)
    pincode     = Column(String(20),  nullable=True)
    country     = Column(String(100), nullable=True, default="India")
    state       = Column(String(100), nullable=True)
    city        = Column(String(100), nullable=True)
    area        = Column(String(100), nullable=True)
    is_active   = Column(Boolean,     nullable=False, default=True)
    sort_order  = Column(Integer,     nullable=False, default=0)
    created_at  = Column(DateTime,    nullable=False, server_default=func.now())
    updated_at  = Column(DateTime,    nullable=True,  onupdate=func.now())


class CustomerShippingZone(TenantBase):
    __tablename__  = "customer_shipping_zones"
    __table_args__ = {"extend_existing": True}
    id          = Column(Integer, primary_key=True, autoincrement=True)
    customer_id = Column(Integer, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False)
    name        = Column(String(255), nullable=False)
    address     = Column(Text,        nullable=True)
    pincode     = Column(String(20),  nullable=True)
    country     = Column(String(100), nullable=True, default="India")
    state       = Column(String(100), nullable=True)
    city        = Column(String(100), nullable=True)
    area        = Column(String(100), nullable=True)
    is_active   = Column(Boolean,     nullable=False, default=True)
    sort_order  = Column(Integer,     nullable=False, default=0)
    created_at  = Column(DateTime,    nullable=False, server_default=func.now())
    updated_at  = Column(DateTime,    nullable=True,  onupdate=func.now())

# --- Replace Zone ? Region ----------------------------------------------------

class Region(TenantBase):
    __tablename__  = "regions"
    __table_args__ = {"extend_existing": True}

    id          = Column(Integer,     primary_key=True, autoincrement=True)
    name        = Column(String(100), nullable=False, unique=True)
    description = Column(String(255), nullable=True)
    is_active   = Column(Boolean,     nullable=False, default=True)
    created_at  = Column(DateTime,    nullable=False, server_default=func.now())
    updated_at  = Column(DateTime,    nullable=True,  onupdate=func.now())


# --- New: State ---------------------------------------------------------------

class State(TenantBase):
    __tablename__  = "states"
    __table_args__ = {"extend_existing": True}

    id          = Column(Integer,     primary_key=True, autoincrement=True)
    region_id   = Column(Integer,     ForeignKey("regions.id", ondelete="SET NULL"), nullable=True)
    name        = Column(String(100), nullable=False, unique=True)
    description = Column(String(255), nullable=True)
    is_active   = Column(Boolean,     nullable=False, default=True)
    created_at  = Column(DateTime,    nullable=False, server_default=func.now())
    updated_at  = Column(DateTime,    nullable=True,  onupdate=func.now())


class District(TenantBase):
    __tablename__ = "districts"
    __table_args__ = (
        UniqueConstraint("region_id", "state_id", "name", name="uq_districts_region_state_name"),
        Index("ix_districts_region_id", "region_id"),
        Index("ix_districts_state_id", "state_id"),
        {"extend_existing": True, "mysql_engine": "InnoDB"},
    )

    id          = Column(Integer,     primary_key=True, autoincrement=True)
    region_id   = Column(Integer,     nullable=False)
    state_id    = Column(Integer,     nullable=False)
    name        = Column(String(100), nullable=False)
    description = Column(String(255), nullable=True)
    is_active   = Column(Boolean,     nullable=False, default=True)
    created_at  = Column(DateTime,    nullable=False, server_default=func.now())
    updated_at  = Column(DateTime,    nullable=True,  onupdate=func.now())


class VerticalSector(TenantBase):
    __tablename__  = "vertical_sectors"
    __table_args__ = {"extend_existing": True}

    id          = Column(Integer,     primary_key=True, autoincrement=True)
    name        = Column(String(100), nullable=False, unique=True)
    description = Column(String(255), nullable=True)
    display_order = Column(Integer, nullable=False, default=0)
    is_active   = Column(Boolean,     nullable=False, default=True)
    created_at  = Column(DateTime,    nullable=False, server_default=func.now())
    updated_at  = Column(DateTime,    nullable=True,  onupdate=func.now())


class VerticalSubSector(TenantBase):
    __tablename__  = "vertical_sub_sectors"
    __table_args__ = (
        UniqueConstraint("sector_id", "name", name="uq_vertical_sub_sector_name"),
        {"extend_existing": True},
    )

    id         = Column(Integer,     primary_key=True, autoincrement=True)
    sector_id  = Column(Integer,     ForeignKey("vertical_sectors.id", ondelete="CASCADE"), nullable=False)
    name       = Column(String(100), nullable=False)
    is_active  = Column(Boolean,     nullable=False, default=True)
    created_at = Column(DateTime,    nullable=False, server_default=func.now())
    updated_at = Column(DateTime,    nullable=True,  onupdate=func.now())


# --- Updated: Group (zone_id ? region_id, added state) -----------------------

class Group(TenantBase):
    __tablename__  = "groups"
    __table_args__ = {"extend_existing": True}

    id          = Column(Integer,     primary_key=True, autoincrement=True)
    name        = Column(String(100), nullable=False, unique=True)
    role_id   = Column(Integer, nullable=True)
    region_id = Column(String(255), nullable=True)   # stores "2" or "1,2,3"
    state_id  = Column(String(255), nullable=True)   # stores "1" or "1,4,5"
    manager_id  = Column(Integer,     ForeignKey("users.id",   ondelete="SET NULL"), nullable=True)
    description = Column(String(255), nullable=True)
    icon        = Column(String(50),  nullable=False, default="zap")
    color       = Column(String(50),  nullable=False, default="violet")
    is_active   = Column(Boolean,     nullable=False, default=True)
    created_at  = Column(DateTime,    nullable=False, server_default=func.now())
    updated_at  = Column(DateTime,    nullable=True,  onupdate=func.now())

# --- New: LeadCategory --------------------------------------------------------

class LeadCategory(TenantBase):
    __tablename__  = "lead_categories"
    __table_args__ = {"extend_existing": True}

    id          = Column(Integer,     primary_key=True, autoincrement=True)
    name        = Column(String(100), nullable=False, unique=True)
    description = Column(String(255), nullable=True)
    is_active   = Column(Boolean,     nullable=False, default=True)
    created_at  = Column(DateTime,    nullable=False, server_default=func.now())
    updated_at  = Column(DateTime,    nullable=True,  onupdate=func.now())


# --- New: LeadSubCategory -----------------------------------------------------

class LeadSubCategory(TenantBase):
    __tablename__  = "lead_sub_categories"
    __table_args__ = (
        UniqueConstraint("category_id", "name", name="uq_lead_sub_cat_name"),
        {"extend_existing": True},
    )

    id          = Column(Integer,     primary_key=True, autoincrement=True)
    category_id = Column(Integer,     ForeignKey("lead_categories.id", ondelete="CASCADE"), nullable=False)
    name        = Column(String(100), nullable=False)
    description = Column(String(255), nullable=True)
    is_active   = Column(Boolean,     nullable=False, default=True)
    created_at  = Column(DateTime,    nullable=False, server_default=func.now())
    updated_at  = Column(DateTime,    nullable=True,  onupdate=func.now())


# --- New: BusinessCategory / BusinessUnit -------------------------------------

class BusinessCategory(TenantBase):
    __tablename__  = "business_categories"
    __table_args__ = {"extend_existing": True}

    id          = Column(Integer,     primary_key=True, autoincrement=True)
    name        = Column(String(100), nullable=False, unique=True)
    display_order = Column(Integer, nullable=False, default=0)
    is_active   = Column(Boolean,     nullable=False, default=True)
    created_at  = Column(DateTime,    nullable=False, server_default=func.now())
    updated_at  = Column(DateTime,    nullable=True,  onupdate=func.now())


class BusinessUnit(TenantBase):
    __tablename__  = "business_units"
    __table_args__ = (
        UniqueConstraint("category_id", "name", name="uq_business_unit_name"),
        {"extend_existing": True},
    )

    id          = Column(Integer,     primary_key=True, autoincrement=True)
    category_id = Column(Integer,     ForeignKey("business_categories.id", ondelete="CASCADE"), nullable=False)
    name        = Column(String(100), nullable=False)
    is_active   = Column(Boolean,     nullable=False, default=True)
    created_at  = Column(DateTime,    nullable=False, server_default=func.now())
    updated_at  = Column(DateTime,    nullable=True,  onupdate=func.now())


class SalesCustomerAssignment(TenantBase):
    __tablename__  = "sales_customer_assignments"
    __table_args__ = (
        UniqueConstraint("user_id", "customer_id", name="uq_sales_customer"),
        {"extend_existing": True},
    )

    id          = Column(Integer,  primary_key=True, autoincrement=True)
    user_id     = Column(Integer,  ForeignKey("users.id",     ondelete="CASCADE"),  nullable=False, index=True)
    customer_id = Column(Integer,  ForeignKey("customers.id", ondelete="CASCADE"),  nullable=False, index=True)
    assigned_by = Column(Integer,  ForeignKey("users.id",     ondelete="SET NULL"), nullable=True)
    is_active   = Column(Boolean,  nullable=False, default=True)
    created_at  = Column(DateTime, nullable=False, server_default=func.now())
    updated_at  = Column(DateTime, nullable=False, default=now_ist, server_default=func.now(), onupdate=func.now())
    
  # --- KAM 360 Extra Models -----------------------------------------------------

class KAMTravelExpense(TenantBase):
    __tablename__ = "kam_travel_expenses"
    __table_args__ = {"extend_existing": True}
    id                = Column(Integer, primary_key=True, autoincrement=True)
    activity_id       = Column(Integer, ForeignKey("kam_activities.id", ondelete="CASCADE"), nullable=False)
    user_id           = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    customer_id       = Column(Integer, ForeignKey("customers.id", ondelete="SET NULL"), nullable=True)
    expense_type      = Column(String(50), nullable=False)
    amount            = Column(Numeric(12, 2), nullable=False)
    travel_mode       = Column(String(100), nullable=True)
    from_location     = Column(String(255), nullable=True)
    to_location       = Column(String(255), nullable=True)
    distance_km       = Column(Float, nullable=True)
    notes             = Column(Text, nullable=True)
    receipt_url       = Column(String(500), nullable=True)
    travel_date       = Column(Date, nullable=False)
    approval_status   = Column(String(50), nullable=False, default="Auto-Approved")
    approved_by       = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    approved_at       = Column(DateTime, nullable=True)
    approval_remarks  = Column(Text, nullable=True)
    travel_request_id = Column(Integer, ForeignKey("travel_requests.id", ondelete="SET NULL"), nullable=True)
    created_by        = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at        = Column(DateTime, server_default=func.now())


class KAMLeadLink(TenantBase):
    __tablename__ = "kam_lead_links"
    __table_args__ = {"extend_existing": True}
    id           = Column(Integer, primary_key=True, autoincrement=True)
    user_id      = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    customer_id  = Column(Integer, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False)
    activity_id  = Column(Integer, ForeignKey("kam_activities.id", ondelete="SET NULL"), nullable=True)
    lead_ref     = Column(String(100), nullable=True)
    subject      = Column(String(500), nullable=False)
    value        = Column(Numeric(15, 2), nullable=True)
    tender_value = Column(Numeric(15, 2), nullable=True)
    stage        = Column(String(100), nullable=False, default="Prospecting")
    notes        = Column(Text, nullable=True)
    created_by   = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at   = Column(DateTime, server_default=func.now())
    updated_at   = Column(DateTime, onupdate=func.now())


class KAMWorkOrder(TenantBase):
    __tablename__ = "kam_work_orders"
    __table_args__ = {"extend_existing": True}
    id               = Column(Integer, primary_key=True, autoincrement=True)
    user_id          = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    customer_id      = Column(Integer, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False)
    lead_link_id     = Column(Integer, ForeignKey("kam_lead_links.id", ondelete="SET NULL"), nullable=True)
    wo_number        = Column(String(100), nullable=False)
    description      = Column(Text, nullable=True)
    order_value      = Column(Numeric(15, 2), nullable=True)
    payment_received = Column(Numeric(15, 2), nullable=False, default=0)
    order_date       = Column(Date, nullable=True)
    status           = Column(String(50), nullable=False, default="Active")
    created_by       = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at       = Column(DateTime, server_default=func.now())
    updated_at       = Column(DateTime, onupdate=func.now())
    
    
class TADAAttachment(TenantBase):
    """
    File attachments for TA/DA claims.
    Each attachment must be linked to a specific TADALineItem (receipt proof per expense).
    line_item_id = NULL means a legacy claim-level attachment.
    """
    __tablename__  = "tada_attachments"
    __table_args__ = {"extend_existing": True}
 
    id           = Column(Integer,     primary_key=True, autoincrement=True)
    claim_id     = Column(Integer,     ForeignKey("tada_claims.id",     ondelete="CASCADE"),  nullable=False)
    # -- KEY COLUMN — links attachment to a specific expense line item ----------
    line_item_id = Column(Integer,     ForeignKey("tada_line_items.id", ondelete="CASCADE"),  nullable=True,
                          comment="FK to tada_line_items — NULL = claim-level (legacy)")
    file_name    = Column(String(300), nullable=False)
    file_url     = Column(String(500), nullable=False,
                          comment="Relative path: /media/<tenant_slug>/tada_attachments/<uuid>.<ext>")
    file_size_kb = Column(Integer,     nullable=True)
    doc_type     = Column(String(100), nullable=False, default="Receipt",
                          comment="Receipt | Invoice | Ticket | Hotel Bill | Other")
    uploaded_by  = Column(Integer,     ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at   = Column(DateTime,    nullable=False, server_default=func.now())
 
class ApprovalWorkflow(TenantBase):
    __tablename__ = "approval_workflows"; __table_args__ = {"extend_existing": True}

    id                = Column(Integer, primary_key=True, index=True)
    name              = Column(String(200), nullable=False)
    module            = Column(String(100), nullable=False)
    requester_user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    approver_user_ids = Column(JSON, nullable=False, default=list)
    approval_mode     = Column(String(20), default="sequential")   # sequential | parallel
    is_active         = Column(Boolean, default=True)
    created_by        = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at        = Column(DateTime, default=now_ist)
    updated_at        = Column(DateTime, default=now_ist, onupdate=now_ist)

    requester = relationship("User", foreign_keys=[requester_user_id])
    creator   = relationship("User", foreign_keys=[created_by])


class ApprovalRequest(TenantBase):
    __tablename__ = "approval_requests"; __table_args__ = {"extend_existing": True}

    id                = Column(Integer, primary_key=True, index=True)
    tenant_id         = Column(Integer, nullable=True, index=True)
    module_key        = Column("module", String(100), nullable=False)
    action_key        = Column(String(100), nullable=True)
    approval_rule_id  = Column(Integer, ForeignKey("approval_rules.id", ondelete="SET NULL"), nullable=True)
    workflow_id       = Column(Integer, ForeignKey("approval_workflows.id"), nullable=True)
    record_id         = Column(Integer, nullable=False)
    group_id          = Column(Integer, ForeignKey("groups.id", ondelete="SET NULL"), nullable=True)
    requested_by      = Column("requester_user_id", Integer, ForeignKey("users.id"), nullable=False)
    approver_user_ids = Column(JSON, nullable=False)   # snapshot
    approval_mode     = Column(String(20), nullable=False)
    current_step_no   = Column(Integer, nullable=False, default=1)
    status            = Column("overall_status", String(30), default="pending")
    requested_at      = Column("created_at", DateTime, default=now_ist)
    final_decided_at  = Column("completed_at", DateTime, nullable=True)

    module = synonym("module_key")
    requester_user_id = synonym("requested_by")
    overall_status = synonym("status")
    created_at = synonym("requested_at")
    completed_at = synonym("final_decided_at")

    requester  = relationship("User", foreign_keys=[requested_by])
    rule       = relationship(
        "ApprovalRule",
        back_populates="requests",
        primaryjoin=lambda: foreign(ApprovalRequest.approval_rule_id) == ApprovalRule.id,
        foreign_keys=[approval_rule_id],
    )
    steps      = relationship(
        "ApprovalRequestStep",
        back_populates="request",
        order_by="ApprovalRequestStep.step_no",
        cascade="all, delete-orphan",
    )
    responses  = relationship("ApprovalResponse", back_populates="request",
                              order_by="ApprovalResponse.approver_order")


class ApprovalRequestStep(TenantBase):
    __tablename__ = "approval_request_steps"
    __table_args__ = (
        UniqueConstraint("approval_request_id", "step_no", name="uq_approval_request_step_order"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    approval_request_id = Column(Integer, ForeignKey("approval_requests.id", ondelete="CASCADE"), nullable=False)
    step_no = Column(Integer, nullable=False)
    approver_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    approver_role = Column(String(50), nullable=True)
    status = Column(String(30), nullable=False, default="pending")
    remarks = Column(Text, nullable=True)
    acted_at = Column(DateTime, nullable=True)
    assigned_at = Column(DateTime, nullable=True)
    escalated_at = Column(DateTime, nullable=True)
    escalation_count = Column(Integer, nullable=False, default=0)
    resolved_from = Column(String(100), nullable=True)
    request = relationship("ApprovalRequest", back_populates="steps")
    approver = relationship("User", foreign_keys=[approver_user_id])


class ApprovalResponse(TenantBase):
    __tablename__ = "approval_responses"; __table_args__ = {"extend_existing": True}

    id                  = Column(Integer, primary_key=True, index=True)
    approval_request_id = Column(Integer, ForeignKey("approval_requests.id"), nullable=False)
    approver_user_id    = Column(Integer, ForeignKey("users.id"), nullable=False)
    approver_order      = Column(Integer, default=1)
    status              = Column(String(30), default="pending")   # pending | approved | rejected
    is_notified         = Column(Boolean, default=False)
    remarks             = Column(Text, nullable=True)
    responded_at        = Column(DateTime, nullable=True)

    request  = relationship("ApprovalRequest", back_populates="responses")
    approver = relationship("User", foreign_keys=[approver_user_id])


class TenantSetting(TenantBase):
    __tablename__ = "tenant_settings"
    __table_args__ = (
        Index("ix_tenant_settings_key", "key"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String(120), nullable=False)
    value = Column(Text, nullable=True)
    value_type = Column(String(20), nullable=True)
    updated_at = Column(
        DateTime,
        nullable=True,
        default=now_ist,
        onupdate=now_ist,
    )

class OrgTreeNode(TenantBase):
    __tablename__ = "org_tree_nodes"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    parent_id = Column(Integer, ForeignKey("org_tree_nodes.id", ondelete="CASCADE"), nullable=True)
    parent_user_id = Column(Integer, ForeignKey("users.id"), nullable=True)

    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)

    group_name = Column(String(150), nullable=True)
    group_lead_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    description = Column(String(500), nullable=True)

    level = Column(Integer, nullable=False, default=1)
    position = Column(Integer, nullable=False, default=0)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())

    parent = relationship("OrgTreeNode", remote_side=[id], backref="children")
    user = relationship("User", foreign_keys=[user_id])
    group_lead = relationship("User", foreign_keys=[group_lead_id])


# ── FormField ─────────────────────────────────────────────────────────────────
class FormField(TenantBase):
    """Per-tenant form field configuration (overrides + custom additions)."""
    __tablename__  = "form_fields"
    __table_args__ = {"extend_existing": True}

    id           = Column(Integer, primary_key=True, autoincrement=True)
    module       = Column(String(50),  nullable=False, index=True)   # customers, leads, tenders, work_orders
    section      = Column(String(50),  nullable=False)               # account, address, contacts, remarks …
    field_key    = Column(String(100), nullable=False)               # unique within module+section
    field_type   = Column(String(30),  nullable=False, default="text")  # text, number, date, select, checkbox, textarea
    label        = Column(String(200), nullable=False)
    placeholder  = Column(String(200), nullable=True)
    options      = Column(JSON,        nullable=True)  # for select fields: ["A","B"] or [{"value":"a","label":"A"},…]
    col_span     = Column(Integer,     nullable=False, default=1)    # 1 = half-width, 2 = full-width
    is_required  = Column(Boolean,     nullable=False, default=False)
    is_visible   = Column(Boolean,     nullable=False, default=True)
    is_custom    = Column(Boolean,     nullable=False, default=True)  # False = built-in override
    # Customization Studio (prototype v17): help text, master lookup list, conditional display.
    # Existing tenant DBs get these columns from studio_service.ensure_schema at startup.
    help_text    = Column(String(300), nullable=True)
    master_key   = Column(String(100), nullable=True)
    show_when    = Column(String(200), nullable=True)
    sort_order   = Column(Integer,     nullable=False, default=0)
    created_at   = Column(DateTime,    server_default=func.now())
    updated_at   = Column(DateTime,    onupdate=func.now())


# ── Questionnaire module (compact 5-table design) ──────────────────────────────
class Questionnaire(TenantBase):
    __tablename__ = "questionnaires"
    __table_args__ = (
        Index("ix_questionnaires_status_active", "status", "is_active"),
        {"extend_existing": True},
    )

    id                  = Column(Integer, primary_key=True, autoincrement=True)
    questionnaire_code  = Column(String(50), nullable=False)
    questionnaire_name  = Column(String(200), nullable=False)
    description         = Column(Text, nullable=True)
    status              = Column(Enum("draft", "published", "archived", name="questionnaire_status_enum"), nullable=False, default="draft")
    is_active            = Column(Boolean, nullable=False, default=True)
    created_by          = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by          = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at          = Column(DateTime, server_default=func.now())
    updated_at          = Column(DateTime, onupdate=func.now())


class QuestionnaireStructure(TenantBase):
    """Sections and subsections (one table, parent_id null = section, set = subsection)."""
    __tablename__ = "questionnaire_structure"
    __table_args__ = (
        Index("ix_qstructure_lookup", "questionnaire_id", "parent_id", "structure_type", "is_active", "display_order"),
        {"extend_existing": True},
    )

    id               = Column(Integer, primary_key=True, autoincrement=True)
    questionnaire_id = Column(Integer, ForeignKey("questionnaires.id", ondelete="CASCADE"), nullable=False)
    parent_id        = Column(Integer, ForeignKey("questionnaire_structure.id", ondelete="CASCADE"), nullable=True)
    structure_type   = Column(Enum("section", "subsection", name="questionnaire_structure_type_enum"), nullable=False)
    structure_code   = Column(String(50), nullable=False)
    structure_name   = Column(String(200), nullable=False)
    description      = Column(Text, nullable=True)
    display_order    = Column(Integer, nullable=False, default=0)
    is_active        = Column(Boolean, nullable=False, default=True)
    created_by       = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by       = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at       = Column(DateTime, server_default=func.now())
    updated_at       = Column(DateTime, onupdate=func.now())

    parent = relationship("QuestionnaireStructure", remote_side=[id], backref="children")


class QuestionnaireFormElement(TenantBase):
    """Questions and dependent fields (one table, parent_element_id null = question, set = dependent field)."""
    __tablename__ = "questionnaire_form_elements"
    __table_args__ = (
        Index(
            "ix_qelements_lookup", "questionnaire_id", "section_id", "subsection_id",
            "parent_element_id", "element_type", "is_active", "display_order",
        ),
        {"extend_existing": True},
    )

    id                  = Column(Integer, primary_key=True, autoincrement=True)
    questionnaire_id    = Column(Integer, ForeignKey("questionnaires.id", ondelete="CASCADE"), nullable=False)
    section_id         = Column(Integer, ForeignKey("questionnaire_structure.id", ondelete="CASCADE"), nullable=False)
    subsection_id       = Column(Integer, ForeignKey("questionnaire_structure.id", ondelete="CASCADE"), nullable=False)
    parent_element_id   = Column(Integer, ForeignKey("questionnaire_form_elements.id", ondelete="CASCADE"), nullable=True)
    element_type        = Column(Enum("question", "field", name="questionnaire_element_type_enum"), nullable=False)
    element_code         = Column(String(50), nullable=False)
    element_label       = Column(String(500), nullable=False)
    input_type          = Column(String(30), nullable=False)  # yes_no_direct, yes_no_conditional, yes_no (legacy), yes_no_na, text, textarea, number, decimal, percentage, currency, date, email, mobile, single_select, multi_select, file
    is_required         = Column(Boolean, nullable=False, default=False)
    allow_remarks       = Column(Boolean, nullable=False, default=False)
    display_order       = Column(Integer, nullable=False, default=0)
    show_when_operator  = Column(String(20), nullable=True)  # equals, not_equals, contains, greater_than, less_than
    show_when_value     = Column(String(200), nullable=True)
    options_json        = Column(JSON, nullable=True)
    placeholder         = Column(String(200), nullable=True)
    default_value       = Column(String(500), nullable=True)
    validation_json     = Column(JSON, nullable=True)
    is_active           = Column(Boolean, nullable=False, default=True)
    created_by          = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by          = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at          = Column(DateTime, server_default=func.now())
    updated_at          = Column(DateTime, onupdate=func.now())

    parent_element = relationship("QuestionnaireFormElement", remote_side=[id], backref="dependent_fields")


class CustomerQuestionnaire(TenantBase):
    """Questionnaire status/progress against a customer — read directly for list-page performance."""
    __tablename__ = "customer_questionnaires"
    __table_args__ = (
        UniqueConstraint("customer_id", "questionnaire_id", name="uq_customer_questionnaire"),
        Index("ix_cq_customer_lookup", "customer_id", "questionnaire_id", "status"),
        Index("ix_cq_status_saved", "status", "last_saved_at"),
        {"extend_existing": True},
    )

    id                     = Column(Integer, primary_key=True, autoincrement=True)
    customer_id           = Column(Integer, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False)
    questionnaire_id       = Column(Integer, ForeignKey("questionnaires.id", ondelete="CASCADE"), nullable=False)
    status                 = Column(Enum("not_started", "in_progress", "completed", "reopened", name="customer_questionnaire_status_enum"), nullable=False, default="not_started")
    total_questions       = Column(Integer, nullable=False, default=0)
    completed_questions   = Column(Integer, nullable=False, default=0)
    progress_percentage   = Column(Integer, nullable=False, default=0)
    started_at             = Column(DateTime, nullable=True)
    completed_at           = Column(DateTime, nullable=True)
    last_saved_at          = Column(DateTime, nullable=True)
    reopened_at            = Column(DateTime, nullable=True)
    reopened_by            = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    reopen_reason          = Column(Text, nullable=True)
    created_by             = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by             = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at             = Column(DateTime, server_default=func.now())
    updated_at             = Column(DateTime, onupdate=func.now())


class CustomerQuestionnaireAnswer(TenantBase):
    """Main question answers and dependent-field answers (one table)."""
    __tablename__ = "customer_questionnaire_answers"
    __table_args__ = (
        UniqueConstraint("customer_questionnaire_id", "element_id", name="uq_cqa_element"),
        Index("ix_cqa_lookup", "customer_questionnaire_id", "element_id"),
        {"extend_existing": True},
    )

    id                        = Column(Integer, primary_key=True, autoincrement=True)
    customer_questionnaire_id = Column(Integer, ForeignKey("customer_questionnaires.id", ondelete="CASCADE"), nullable=False)
    element_id                = Column(Integer, ForeignKey("questionnaire_form_elements.id", ondelete="CASCADE"), nullable=False)
    answer_value              = Column(Text, nullable=True)
    remarks                   = Column(Text, nullable=True)
    answered_by               = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    answered_at               = Column(DateTime, nullable=True)
    created_at                = Column(DateTime, server_default=func.now())
    updated_at                = Column(DateTime, onupdate=func.now())

