from datetime import datetime

from sqlalchemy import JSON, Column, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint

from app.database import Base


class PlatformCoupon(Base):
    """A coupon code (Business → Discounts & coupons). Deleted coupons are kept (deleted_at) so redemptions stay intact.

    status is what staff set (active | paused); Expired (valid_until passed) and Exhausted (limit reached) are derived.
    """
    __tablename__ = "platform_coupons"
    __table_args__ = (Index("ix_platform_coupons_listing", "deleted_at", "status", "valid_until"),)
    id = Column(Integer, primary_key=True)
    code = Column(String(40), nullable=False, unique=True)            # never reused, even after deletion
    kind = Column(String(10), nullable=False)                         # percent | amount (₹)
    value = Column(Numeric(12, 2), nullable=False)
    duration = Column(String(12), nullable=False)                     # once | repeat_3 | repeat_12 | forever | annual
    plan_ids = Column(JSON, nullable=True)                            # None = all plans
    redemption_limit = Column(Integer, nullable=False, default=0)     # 0 = unlimited
    redeemed_count = Column(Integer, nullable=False, default=0)       # kept with the redemption rows in one locked transaction
    valid_until = Column(Date, nullable=False)
    status = Column(String(10), nullable=False, default="active")
    note = Column(String(300), nullable=True)
    created_by = Column(String(200), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=True)
    deleted_at = Column(DateTime, nullable=True)


class PlatformCouponRedemption(Base):
    """A tenant's use of a coupon. The coupon's terms are copied at redemption, so later edits or deletion don't change it."""
    __tablename__ = "platform_coupon_redemptions"
    __table_args__ = (
        UniqueConstraint("coupon_id", "tenant_id", name="uq_platform_coupon_redemption"),  # one redemption per tenant and coupon
        Index("ix_platform_coupon_redemptions_tenant", "tenant_id", "status"),
        Index("ix_platform_coupon_redemptions_when", "redeemed_at"),
    )
    id = Column(Integer, primary_key=True)
    coupon_id = Column(Integer, ForeignKey("platform_coupons.id", ondelete="RESTRICT"), nullable=False)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    code = Column(String(40), nullable=False)
    kind = Column(String(10), nullable=False)
    value = Column(Numeric(12, 2), nullable=False)
    duration = Column(String(12), nullable=False)
    plan_id = Column(Integer, nullable=True)                          # tenant plan when redeemed
    redeemed_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    redeemed_by = Column(String(200), nullable=True)
    first_invoice_id = Column(Integer, nullable=True)                 # "once" coupons apply to this invoice only
    status = Column(String(10), nullable=False, default="active")     # active | used | ended


class PlatformVolumeTier(Base):
    """Seat-based volume discount band (seats = the tenant's licensed maximum users)."""
    __tablename__ = "platform_volume_tiers"
    id = Column(Integer, primary_key=True)
    from_seats = Column(Integer, nullable=False, unique=True)
    to_seats = Column(Integer, nullable=True)                         # None = no upper bound
    pct = Column(Numeric(5, 2), nullable=False, default=0)
    updated_by = Column(String(200), nullable=True)
    updated_at = Column(DateTime, nullable=True)


class PlatformTenantDiscount(Base):
    """A negotiated discount for one tenant. Above the approval threshold it waits for a second approver.

    status: pending | active | rejected | ended. Applied only from starts_on to valid_until.
    """
    __tablename__ = "platform_tenant_discounts"
    __table_args__ = (
        Index("ix_platform_tenant_discounts_tenant", "tenant_id", "status"),
        Index("ix_platform_tenant_discounts_status", "status", "id"),
    )
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    pct = Column(Numeric(5, 2), nullable=False)
    term_months = Column(Integer, nullable=False)
    reason = Column(String(300), nullable=False)
    status = Column(String(10), nullable=False, default="pending")
    requested_by_id = Column(Integer, nullable=True)                  # super_admins.id
    requested_by = Column(String(200), nullable=True)
    requested_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    starts_on = Column(Date, nullable=True)
    valid_until = Column(Date, nullable=True)
    decided_by_id = Column(Integer, nullable=True)
    decided_by = Column(String(200), nullable=True)
    decided_at = Column(DateTime, nullable=True)
    decision_note = Column(String(300), nullable=True)
    ended_at = Column(DateTime, nullable=True)
    ended_by = Column(String(200), nullable=True)
    history = Column(JSON, nullable=True)                             # [{at, by, action, note}]


class PlatformResellerTierRule(Base):
    """Reseller tier qualification (ARR under management) and partner margin; resellers stay in platform_resellers."""
    __tablename__ = "platform_reseller_tier_rules"
    id = Column(Integer, primary_key=True)
    tier = Column(String(20), nullable=False, unique=True)            # Silver | Gold | Platinum
    min_arr = Column(Numeric(14, 2), nullable=False, default=0)
    margin_pct = Column(Numeric(5, 2), nullable=False, default=0)
    updated_by = Column(String(200), nullable=True)
    updated_at = Column(DateTime, nullable=True)
