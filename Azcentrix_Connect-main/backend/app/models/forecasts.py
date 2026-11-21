"""Forecasts (prototype v17 · Sales → Forecasts) – tenant tables.

forecast_adjustments        – the manager adjustment per (forecast period, sales rep), edited inline in "Forecast by rep".
                              One live value per period + rep; every change is written to audit_logs (old → new, editor, time).
forecast_submissions        – one row per "Submit forecast": the period, the submitter, a version number (previous versions are
                              never overwritten), the approval request raised for it and the KPI totals frozen at submit time.
forecast_submission_lines   – the per-rep snapshot of a submission (quota, closed, commit, best case, pipeline, adjustment,
                              attainment). Rep names are copied so a submitted forecast stays historically consistent even
                              when deals, quotas or users change later.

Periods are keys generated from the tenant fiscal calendar (Settings ``fiscal_year_start``):
``FY2026`` (fiscal year starting in 2026), ``FY2026-Q3`` (its third quarter), ``FY2026-M08`` (its eighth month).
"""
from sqlalchemy import JSON, Column, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint, func

from app.models.all_models import TenantBase


class ForecastAdjustment(TenantBase):
    __tablename__ = "forecast_adjustments"
    __table_args__ = (UniqueConstraint("period_key", "rep_user_id", name="uq_forecast_adjustments_period_rep"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    period_key = Column(String(20), nullable=False)
    rep_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    amount = Column(Numeric(18, 2), nullable=False, default=0)
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class ForecastSubmission(TenantBase):
    __tablename__ = "forecast_submissions"
    __table_args__ = (UniqueConstraint("period_key", "submitted_by", "version", name="uq_forecast_submissions_version"),
                      Index("ix_forecast_submissions_period", "period_key", "status"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    period_key = Column(String(20), nullable=False)
    period_label = Column(String(40), nullable=False)
    period_start = Column(DateTime, nullable=True)
    period_end = Column(DateTime, nullable=True)
    version = Column(Integer, nullable=False, default=1)
    status = Column(String(20), nullable=False, default="pending")      # pending | approved | rejected
    submitted_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    submitted_by_name = Column(String(150), nullable=True)
    submitted_at = Column(DateTime, nullable=False)
    approval_request_id = Column(Integer, nullable=True, index=True)
    approver_name = Column(String(150), nullable=True)
    decided_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    decided_at = Column(DateTime, nullable=True)
    remarks = Column(Text, nullable=True)
    totals = Column(JSON, nullable=True)          # quota / closed / commit / best / pipeline / adjustment / gap / center %
    settings = Column(JSON, nullable=True)        # thresholds used for the snapshot (commit ≥ x %, best case ≥ y %)


class ForecastSubmissionLine(TenantBase):
    __tablename__ = "forecast_submission_lines"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    submission_id = Column(Integer, ForeignKey("forecast_submissions.id", ondelete="CASCADE"), nullable=False, index=True)
    rep_user_id = Column(Integer, nullable=True)
    rep_name = Column(String(150), nullable=False)
    quota = Column(Numeric(18, 2), nullable=False, default=0)
    closed = Column(Numeric(18, 2), nullable=False, default=0)
    commit_amount = Column(Numeric(18, 2), nullable=False, default=0)
    best_case = Column(Numeric(18, 2), nullable=False, default=0)
    pipeline = Column(Numeric(18, 2), nullable=False, default=0)
    adjustment = Column(Numeric(18, 2), nullable=False, default=0)
    attainment = Column(Numeric(9, 2), nullable=True)                    # NULL when the rep has no quota


FORECAST_TABLES = [ForecastAdjustment.__table__, ForecastSubmission.__table__, ForecastSubmissionLine.__table__]
