from datetime import datetime

from sqlalchemy import JSON, Column, Date, DateTime, ForeignKey, Index, Integer, PrimaryKeyConstraint, String, Text, UniqueConstraint

from app.database import Base


class PlatformSupportTicket(Base):
    """A support request raised by a tenant user to the platform team (Governance → Support Desk)."""
    __tablename__ = "platform_support_tickets"
    __table_args__ = (
        Index("ix_platform_support_tickets_status_created", "status", "created_at"),           # open tickets, oldest / newest
        Index("ix_platform_support_tickets_tenant", "tenant_id", "status", "created_at"),       # tenant-scoped staff, tenant's own list
    )
    id = Column(Integer, primary_key=True)
    ref = Column(String(20), nullable=False, unique=True)                  # SUP-0001
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, nullable=True)                               # id in the tenant's own users table
    requester_name = Column(String(200), nullable=True)
    requester_email = Column(String(200), nullable=True)
    subject = Column(String(300), nullable=False)
    description = Column(Text, nullable=True)
    priority = Column(String(10), nullable=False, default="Medium")       # Low | Medium | High
    status = Column(String(10), nullable=False, default="open")           # open | closed
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    closed_at = Column(DateTime, nullable=True)


class PlatformAnnouncement(Base):
    """A broadcast announcement and what it reached.

    Support Desk broadcasts are delivered as in-app notifications in each tenant database (``kind`` is NULL).
    Announcements & maintenance posts (``kind`` Info | Important | Maintenance) are shown from here in the tenant
    footer and dashboard banner until ``expires_on``; their audience and reads are in the two tables below.
    """
    __tablename__ = "platform_announcements"
    __table_args__ = (
        Index("ix_platform_announcements_sent", "sent_at"),
        Index("ix_platform_announcements_kind_expiry", "kind", "expires_on"),   # live feed posts: kind set, not expired
    )
    id = Column(Integer, primary_key=True)
    title = Column(String(200), nullable=False)
    message = Column(Text, nullable=False)
    audience = Column(String(20), nullable=False)                         # all | admins | groups | tenant
    audience_label = Column(String(250), nullable=False)
    tenant_ids = Column(JSON, nullable=False)                              # tenants it was sent to
    recipients = Column(Integer, nullable=False, default=0)
    failed = Column(JSON, nullable=True)                                   # [{tenant, error}]
    sent_by = Column(String(255), nullable=True)
    sent_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    kind = Column(String(15), nullable=True)                               # Info | Important | Maintenance (feed posts)
    expires_on = Column(Date, nullable=True)                               # shown up to and including this day
    published_by_id = Column(Integer, nullable=True)                      # super_admins.id
    change_id = Column(Integer, nullable=True)                            # platform_changes.id of a maintenance notice


class PlatformAnnouncementTenant(Base):
    """Audience of a feed announcement: one row per tenant it was published to, with its active users at that time."""
    __tablename__ = "platform_announcement_tenants"
    __table_args__ = (
        PrimaryKeyConstraint("announcement_id", "tenant_id"),             # per-announcement reach (grouped sums)
        Index("ix_platform_announcement_tenants_tenant", "tenant_id"),      # a tenant's feed
    )
    announcement_id = Column(Integer, ForeignKey("platform_announcements.id", ondelete="CASCADE"), nullable=False)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    recipients = Column(Integer, nullable=False, default=0)


class PlatformAnnouncementRead(Base):
    """A tenant user has read (opened or dismissed) a feed announcement; one row per user and announcement."""
    __tablename__ = "platform_announcement_reads"
    __table_args__ = (
        # One read per user; also serves the grouped read counts and the feed's per-user read flag (all three columns).
        UniqueConstraint("announcement_id", "tenant_id", "user_id", name="uq_platform_announcement_read"),
    )
    id = Column(Integer, primary_key=True)
    announcement_id = Column(Integer, ForeignKey("platform_announcements.id", ondelete="CASCADE"), nullable=False)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, nullable=False)                              # id in the tenant's own users table
    read_at = Column(DateTime, nullable=False, default=datetime.utcnow)
