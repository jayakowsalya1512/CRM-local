from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Index, Integer, Numeric, String

from app.database import Base


class PlatformSubscriptionEvent(Base):
    """Subscription ledger: one row each time a tenant's recurring state (plan, status, billing status, price) changes.

    ``mrr`` is the tenant's monthly recurring revenue after the change (0 when not paying). The first row of every tenant
    present when the ledger started is a ``baseline``; history before the earliest baseline is not known. No foreign key
    on ``tenant_id`` – the ledger outlives deleted tenants.
    """
    __tablename__ = "platform_subscription_events"
    __table_args__ = (
        Index("ix_pse_tenant_at", "tenant_id", "occurred_at"),
        Index("ix_pse_at", "occurred_at"),
    )
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, nullable=False)
    tenant_name = Column(String(200), nullable=True)
    occurred_at = Column(DateTime, nullable=False, default=datetime.utcnow)     # UTC
    kind = Column(String(14), nullable=False)        # baseline | new | reactivation | expansion | contraction | churn | change | deleted
    plan_id = Column(Integer, nullable=True)
    status = Column(String(20), nullable=True)
    billing_status = Column(String(20), nullable=True)
    paying = Column(Boolean, nullable=False)
    mrr = Column(Numeric(14, 2), nullable=False)
    mrr_delta = Column(Numeric(14, 2), nullable=False)
    source = Column(String(10), nullable=False)      # baseline | live (recorded on commit) | reconcile (found by the periodic check)
