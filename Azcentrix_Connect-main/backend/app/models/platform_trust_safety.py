from datetime import datetime

from sqlalchemy import JSON, Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.dialects.mysql import LONGTEXT

from app.database import Base


class PlatformAbuseCase(Base):
    """A Trust & Safety case (Governance → Trust & Safety → Abuse cases)."""
    __tablename__ = "platform_abuse_cases"
    __table_args__ = (
        Index("ix_platform_abuse_cases_status_severity", "status", "severity"),   # open / critical counts
        Index("ix_platform_abuse_cases_opened", "opened_at"),                     # list order
    )
    id = Column(Integer, primary_key=True)
    ref = Column(String(20), nullable=False, unique=True)                         # TS-001
    title = Column(String(300), nullable=False)
    category = Column(String(60), nullable=False)
    severity = Column(String(20), nullable=False)                                 # Low | Medium | High | Critical
    status = Column(String(20), nullable=False, default="Under review")           # Under review | Investigating | Escalated | Closed
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True, index=True)
    tenant_name = Column(String(200), nullable=True)                              # kept if the tenant record is ever removed
    source = Column(String(120), nullable=False)
    assigned_to = Column(String(255), nullable=True)
    legal_hold = Column(Boolean, nullable=False, default=True)
    opened_by = Column(String(255), nullable=True)
    opened_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    closed_at = Column(DateTime, nullable=True)


class PlatformCaseEvent(Base):
    """Case timeline. Rows are only ever added (chain of custody)."""
    __tablename__ = "platform_case_events"
    __table_args__ = (Index("ix_platform_case_events_case_at", "case_id", "created_at"),)
    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("platform_abuse_cases.id", ondelete="RESTRICT"), nullable=False)
    event = Column(String(300), nullable=False)
    actor = Column(String(255), nullable=False)
    detail = Column(JSON, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformCaseEvidence(Base):
    """Preserved evidence: a content snapshot locked by its SHA-256, or a reference to a legal-hold export package."""
    __tablename__ = "platform_case_evidence"
    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("platform_abuse_cases.id", ondelete="RESTRICT"), nullable=True, index=True)
    enforcement_id = Column(Integer, nullable=True, index=True)
    tenant_id = Column(Integer, nullable=True, index=True)
    kind = Column(String(40), nullable=False)                                     # report_note | user_snapshot | tenant_export
    description = Column(String(500), nullable=False)
    content = Column(Text().with_variant(LONGTEXT(), "mysql"), nullable=True)    # canonical JSON the hash covers
    sha256 = Column(String(64), nullable=True)
    export_job_id = Column(Integer, nullable=True)                                # tenant_export: the TenantExportJob
    legal_hold = Column(Boolean, nullable=False, default=True)
    created_by = Column(String(255), nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformAupPolicy(Base):
    """Acceptable-use enforcement switch (policy keys are declared in the service)."""
    __tablename__ = "platform_aup_policies"
    key = Column(String(40), primary_key=True)
    enabled = Column(Boolean, nullable=False, default=True)
    updated_by = Column(String(255), nullable=True)
    updated_at = Column(DateTime, nullable=True)


class PlatformEnforcementAction(Base):
    """User / tenant enforcement history (Recent enforcement actions)."""
    __tablename__ = "platform_enforcement_actions"
    __table_args__ = (
        Index("ix_platform_enforcement_at", "created_at"),
        Index("ix_platform_enforcement_action_at", "action", "created_at"),     # "Users terminated · 90d"
        Index("ix_platform_enforcement_target", "tenant_id", "user_id"),
    )
    id = Column(Integer, primary_key=True)
    action = Column(String(40), nullable=False)               # User suspended | User reinstated | User terminated | User restored | Tenant suspended | Tenant terminated
    tenant_id = Column(Integer, nullable=True)
    user_id = Column(Integer, nullable=True)                  # id in the tenant's own users table
    target = Column(String(400), nullable=False)
    reason = Column(String(200), nullable=True)
    case_id = Column(Integer, ForeignKey("platform_abuse_cases.id", ondelete="SET NULL"), nullable=True)
    notes = Column(Text, nullable=True)
    outcome = Column(JSON, nullable=True)                     # what actually happened (sessions revoked, email sent, …)
    actor = Column(String(255), nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformAccessBlock(Base):
    """Checked by tenant sign-in: a terminated user, a blocked email domain or a blocked device, within one tenant."""
    __tablename__ = "platform_access_blocks"
    __table_args__ = (Index("ix_platform_access_blocks_lookup", "tenant_id", "active", "kind", "value"),)
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    kind = Column(String(10), nullable=False)                 # user | domain | device
    value = Column(String(255), nullable=False)               # lower-case email / domain / hashed device UUID
    enforcement_id = Column(Integer, nullable=True)
    active = Column(Boolean, nullable=False, default=True)
    created_by = Column(String(255), nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    lifted_at = Column(DateTime, nullable=True)
