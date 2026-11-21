"""Field Sales 360 (prototype v17 · Finance & Field → Field Sales 360) – side tables.

Activities stay in ``kam_activities`` (with their execution cycles and the append-only ``kam_log``); these tables only
hold what the activity schema has no column for, so the existing KAM module keeps working unchanged.

field_visits                   – one row per activity logged / checked in from Field Sales 360: structured outcome
                                 (Positive / Neutral / Negative / Follow-up), planned flag, GPS check-in / check-out
                                 (coordinates are purged after the retention period; the verification result stays),
                                 recorded travel distance and the follow-up task created with it.
field_sales_targets            – annual (fiscal-year) sales target per KAM, edited on the Targets tab.
field_sales_target_history     – who changed a target, when, from what to what.
"""
from sqlalchemy import (DECIMAL, Boolean, Column, Date, DateTime, ForeignKey, Index, Integer, Numeric, SmallInteger,
                        String, UniqueConstraint, func)

from app.models.all_models import TenantBase

OUTCOMES = ("Positive", "Neutral", "Negative", "Follow-up")
GPS_STATES = ("verified", "manual", "denied")


class FieldVisit(TenantBase):
    __tablename__ = "field_visits"
    __table_args__ = (Index("ix_field_visits_checkin", "check_in_at"), {"extend_existing": True})

    activity_id = Column(Integer, ForeignKey("kam_activities.id", ondelete="CASCADE"), primary_key=True)
    planned = Column(Boolean, nullable=True)                 # True: visit was planned before it happened
    outcome_rating = Column(String(20), nullable=True)       # OUTCOMES
    sentiment = Column(SmallInteger, nullable=True)          # 1 Cold … 5 Hot
    check_in_at = Column(DateTime, nullable=True)
    check_in_lat = Column(DECIMAL(10, 7), nullable=True)
    check_in_lng = Column(DECIMAL(10, 7), nullable=True)
    check_in_accuracy = Column(DECIMAL(10, 2), nullable=True)
    gps_status = Column(String(20), nullable=True)           # GPS_STATES – kept after coordinates are purged
    check_out_at = Column(DateTime, nullable=True)
    check_out_lat = Column(DECIMAL(10, 7), nullable=True)
    check_out_lng = Column(DECIMAL(10, 7), nullable=True)
    check_out_accuracy = Column(DECIMAL(10, 2), nullable=True)
    distance_km = Column(DECIMAL(10, 2), nullable=True)      # travel distance recorded at check-out
    location_purged_at = Column(DateTime, nullable=True)
    followup_task_id = Column(Integer, nullable=True)        # crm_tasks.id
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class FieldSalesTarget(TenantBase):
    __tablename__ = "field_sales_targets"
    __table_args__ = (UniqueConstraint("user_id", "fy_start", name="uq_field_sales_target_user_fy"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    fy_start = Column(Date, nullable=False)                  # first day of the fiscal year
    annual_target = Column(Numeric(15, 2), nullable=False, default=0)   # rupees
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class FieldSalesTargetHistory(TenantBase):
    __tablename__ = "field_sales_target_history"
    __table_args__ = (Index("ix_fs_target_hist_user", "user_id", "fy_start"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    fy_start = Column(Date, nullable=False)
    old_value = Column(Numeric(15, 2), nullable=True)
    new_value = Column(Numeric(15, 2), nullable=False)
    changed_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    changed_at = Column(DateTime, server_default=func.now())
    ip_address = Column(String(45), nullable=True)


FIELD_SALES_TABLES = [FieldVisit.__table__, FieldSalesTarget.__table__, FieldSalesTargetHistory.__table__]
