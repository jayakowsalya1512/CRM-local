"""Add-ons & usage pricing (Business → Add-ons & usage pricing): add-on catalogue and tenant subscriptions, per-plan
usage quotas and overage prices (dated), monthly usage charges, trial extensions and currency price books."""

from datetime import datetime

from sqlalchemy import Column, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, UniqueConstraint

from app.database import Base


class PlatformAddon(Base):
    """A catalogue add-on billed per month on top of the plan. Draft = being configured (can't be subscribed);
    Active / Beta = offered; Paused = no new subscriptions (existing ones keep billing)."""
    __tablename__ = "platform_addons"
    id = Column(Integer, primary_key=True)
    name = Column(String(120), nullable=False, unique=True)
    price = Column(Numeric(12, 2), nullable=False)                    # ₹ per unit per month
    unit = Column(String(40), nullable=False, default="per month")
    status = Column(String(10), nullable=False, default="Draft")      # Draft | Active | Beta | Paused
    created_by = Column(String(200), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=True)


class PlatformTenantAddon(Base):
    """A tenant's subscription to an add-on (one row per tenant and add-on; cancelling keeps the row)."""
    __tablename__ = "platform_tenant_addons"
    __table_args__ = (
        UniqueConstraint("tenant_id", "addon_id", name="uq_platform_tenant_addon"),
        Index("ix_platform_tenant_addons_addon", "addon_id", "status"),
    )
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    addon_id = Column(Integer, ForeignKey("platform_addons.id", ondelete="RESTRICT"), nullable=False)
    quantity = Column(Integer, nullable=False, default=1)
    status = Column(String(10), nullable=False, default="active")     # active | cancelled
    started_on = Column(Date, nullable=False)
    ended_on = Column(Date, nullable=True)
    updated_by = Column(String(200), nullable=True)
    updated_at = Column(DateTime, nullable=True)


class PlatformUsageRate(Base):
    """Included quota and overage price of one metric on one plan, from a date. A change adds a row dated today, so
    months already charged keep the rate they were charged at."""
    __tablename__ = "platform_usage_rates"
    __table_args__ = (UniqueConstraint("plan_id", "metric", "effective_from", name="uq_platform_usage_rate"),)
    id = Column(Integer, primary_key=True)
    plan_id = Column(Integer, ForeignKey("plans.id", ondelete="CASCADE"), nullable=False)
    metric = Column(String(12), nullable=False)                       # api | ai | storage | email | messaging
    included = Column(Numeric(14, 2), nullable=True)                  # None = not set (no overage billed)
    price = Column(Numeric(10, 4), nullable=True)                     # ₹ per unit above the quota
    effective_from = Column(Date, nullable=False)
    updated_by = Column(String(200), nullable=True)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformUsageCharge(Base):
    """One tenant's measured usage of one metric in one calendar month and what it costs. Unique per tenant, metric and
    month, so a month is never charged twice; the invoice that billed it is recorded."""
    __tablename__ = "platform_usage_charges"
    __table_args__ = (
        UniqueConstraint("tenant_id", "metric", "month", name="uq_platform_usage_charge"),
        Index("ix_platform_usage_charges_month", "month", "status"),
        Index("ix_platform_usage_charges_pending", "status", "tenant_id"),
    )
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    metric = Column(String(12), nullable=False)
    month = Column(Date, nullable=False)                              # first day of the month measured
    plan_id = Column(Integer, nullable=True)
    used = Column(Numeric(16, 3), nullable=False)
    included = Column(Numeric(14, 2), nullable=True)
    price = Column(Numeric(10, 4), nullable=True)
    rate_id = Column(Integer, nullable=True)
    overage = Column(Numeric(16, 3), nullable=False, default=0)
    amount = Column(Numeric(14, 2), nullable=False, default=0)
    status = Column(String(12), nullable=False)                       # pending | invoiced | none | not_billed
    note = Column(String(300), nullable=True)
    invoice_id = Column(Integer, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformFxRate(Base):
    """₹ per one unit of a currency, from a date (price books)."""
    __tablename__ = "platform_fx_rates"
    __table_args__ = (UniqueConstraint("currency", "effective_from", name="uq_platform_fx_rate"),)
    id = Column(Integer, primary_key=True)
    currency = Column(String(3), nullable=False)
    rate = Column(Numeric(12, 4), nullable=False)
    effective_from = Column(Date, nullable=False)
    updated_by = Column(String(200), nullable=True)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformTrialExtension(Base):
    """A trial extension granted to a tenant (one per tenant)."""
    __tablename__ = "platform_trial_extensions"
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, unique=True)
    days = Column(Integer, nullable=False)
    old_end = Column(DateTime, nullable=True)
    new_end = Column(DateTime, nullable=False)
    granted_by = Column(String(200), nullable=True)
    granted_at = Column(DateTime, nullable=False, default=datetime.utcnow)
