from datetime import datetime

from sqlalchemy import JSON, Boolean, Column, Date, DateTime, ForeignKey, Index, Integer, Numeric, SmallInteger, String, Text, UniqueConstraint

from app.database import Base


class PlatformSlaPolicy(Base):
    """Current SLA policy of a plan (Governance → SLA & CSAT). Every change also writes a PlatformSlaPolicyVersion."""
    __tablename__ = "platform_sla_policies"
    plan_id = Column(Integer, ForeignKey("plans.id", ondelete="CASCADE"), primary_key=True)
    first_response_h = Column(Numeric(6, 2), nullable=False)
    resolution_h = Column(Numeric(6, 2), nullable=False)
    coverage = Column(String(10), nullable=False, default="business")      # business | 24x7_p1 | 24x7
    channels = Column(JSON, nullable=False)                                 # ["email", "chat", "phone", "manager"]
    version_id = Column(Integer, nullable=False)                            # the PlatformSlaPolicyVersion in force
    updated_by = Column(String(200), nullable=True)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformSlaPolicyVersion(Base):
    """Immutable copy of a plan's policy as it was; tickets point at the version they were opened under."""
    __tablename__ = "platform_sla_policy_versions"
    __table_args__ = (UniqueConstraint("plan_id", "version", name="uq_platform_sla_policy_version"),)
    id = Column(Integer, primary_key=True)
    plan_id = Column(Integer, nullable=False)                               # leading column of the unique key
    version = Column(Integer, nullable=False)
    first_response_h = Column(Numeric(6, 2), nullable=False)
    resolution_h = Column(Numeric(6, 2), nullable=False)
    coverage = Column(String(10), nullable=False)
    channels = Column(JSON, nullable=False)
    created_by = Column(String(200), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformSlaCalendar(Base):
    """The platform team's working time for business-hours SLAs (one row, id 1). Times are Indian Standard Time."""
    __tablename__ = "platform_sla_calendar"
    id = Column(Integer, primary_key=True)
    days = Column(JSON, nullable=False)                                     # ISO weekdays 1 = Mon … 7 = Sun
    day_start = Column(String(5), nullable=False, default="09:30")
    day_end = Column(String(5), nullable=False, default="18:00")
    holidays = Column(JSON, nullable=False)                                 # [{"date": "2026-01-26", "name": "Republic Day"}]
    updated_by = Column(String(200), nullable=True)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformTicketSla(Base):
    """SLA clock of one Support Desk ticket: the policy it was opened under, its deadlines and when they were met."""
    __tablename__ = "platform_ticket_slas"
    __table_args__ = (
        Index("ix_platform_ticket_slas_created", "created_at", "priority_code"),          # 30-day KPIs, breaches by priority
        Index("ix_platform_ticket_slas_tenant", "tenant_id", "created_at"),               # tenant-scoped staff
        Index("ix_platform_ticket_slas_first_due", "first_response_at", "first_response_due"),  # unanswered past due
        Index("ix_platform_ticket_slas_resolution_due", "resolved_at", "resolution_due"),       # unresolved past due
    )
    ticket_id = Column(Integer, ForeignKey("platform_support_tickets.id", ondelete="CASCADE"), primary_key=True)
    tenant_id = Column(Integer, nullable=False)
    plan_id = Column(Integer, nullable=True)
    policy_version_id = Column(Integer, ForeignKey("platform_sla_policy_versions.id"), nullable=False, index=True)
    priority_code = Column(String(2), nullable=False)                      # P1 | P2 | P3
    coverage = Column(String(10), nullable=False)                           # as applied to this ticket: business | 24x7
    created_at = Column(DateTime, nullable=False)                           # = ticket created_at (UTC)
    first_response_due = Column(DateTime, nullable=False)
    resolution_due = Column(DateTime, nullable=False)
    first_response_at = Column(DateTime, nullable=True)
    first_response_secs = Column(Integer, nullable=True)                    # elapsed (wall clock) to the first staff reply
    first_breached = Column(Boolean, nullable=True)                         # set when the first reply is sent
    resolved_at = Column(DateTime, nullable=True)
    resolution_secs = Column(Integer, nullable=True)
    resolution_breached = Column(Boolean, nullable=True)                    # set when resolved
    csat_token_hash = Column(String(64), nullable=True, unique=True)       # e-mailed rating link (sha256 of the token)
    csat_token_expires = Column(DateTime, nullable=True)


class PlatformTicketReply(Base):
    """One message in a Support Desk ticket thread (platform staff or the tenant)."""
    __tablename__ = "platform_ticket_replies"
    __table_args__ = (Index("ix_platform_ticket_replies_ticket", "ticket_id", "created_at"),)
    id = Column(Integer, primary_key=True)
    ticket_id = Column(Integer, ForeignKey("platform_support_tickets.id", ondelete="CASCADE"), nullable=False)
    author_kind = Column(String(6), nullable=False)                         # staff | tenant
    author_name = Column(String(200), nullable=True)
    author_email = Column(String(200), nullable=True)
    body = Column(Text, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformTicketCsat(Base):
    """Customer satisfaction rating of a resolved ticket (one per ticket)."""
    __tablename__ = "platform_ticket_csat"
    __table_args__ = (Index("ix_platform_ticket_csat_month", "month", "tenant_id"),)
    id = Column(Integer, primary_key=True)
    ticket_id = Column(Integer, ForeignKey("platform_support_tickets.id", ondelete="CASCADE"), nullable=False, unique=True)
    tenant_id = Column(Integer, nullable=False)
    rating = Column(SmallInteger, nullable=False)                           # 1 … 5
    feedback = Column(Text, nullable=True)
    submitted_by = Column(String(200), nullable=True)
    channel = Column(String(10), nullable=False)                            # app | email
    submitted_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    month = Column(Date, nullable=False)                                    # first day of the IST month, for the trend


class PlatformCannedResponse(Base):
    """Reply template offered in the Support Desk reply editor."""
    __tablename__ = "platform_canned_responses"
    id = Column(Integer, primary_key=True)
    key = Column(String(40), nullable=False, unique=True)
    title = Column(String(120), nullable=False)
    body = Column(Text, nullable=False)
    sort = Column(Integer, nullable=False, default=0)
    updated_by = Column(String(200), nullable=True)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)
