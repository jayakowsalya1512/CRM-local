"""Reports (prototype v17 · Intelligence → Reports) – per-user favourites, schedules and the execution / delivery history.

Ready-made report definitions live in code (reports_v17_service.REPORTS); custom reports are the report engine's
``saved_reports`` rows (no copy of business records is kept anywhere). Report keys: ready-made slug, or ``c:<saved_reports.id>``.

report_favourites – the star in the catalogue / report header, per user.
report_schedules  – frequency (Daily · 08:00 / Weekly · Mon 08:00 / Monthly · 1st / Quarterly), format (PDF / Excel / CSV),
                    recipients, next run and the last result. Runs as the schedule owner with the owner's permissions and
                    data scope at execution time.
report_runs       – every export, e-mail and scheduled delivery: who, when, format, rows, file, recipients, status / error.
"""
from sqlalchemy import JSON, Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func

from app.models.all_models import TenantBase

FREQUENCIES = ("Daily · 08:00", "Weekly · Mon 08:00", "Monthly · 1st", "Quarterly")
FORMATS = ("PDF", "Excel", "CSV")
PERIODS = ("FY", "QTR", "MTD")       # This FY · Last 90 days · Last 30 days (prototype option values)


class ReportFavourite(TenantBase):
    __tablename__ = "report_favourites"
    __table_args__ = (UniqueConstraint("user_id", "report_key", name="uq_report_fav_user_key"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    report_key = Column(String(80), nullable=False)
    created_at = Column(DateTime, server_default=func.now())


class ReportSchedule(TenantBase):
    __tablename__ = "report_schedules"
    __table_args__ = (UniqueConstraint("user_id", "report_key", name="uq_report_sched_user_key"),
                      Index("ix_report_sched_due", "is_active", "next_run_at"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)   # owner – runs with these rights
    report_key = Column(String(80), nullable=False)
    report_name = Column(String(200), nullable=False)
    frequency = Column(String(40), nullable=False)
    fmt = Column(String(10), nullable=False, default="PDF")
    period = Column(String(10), nullable=False, default="FY")
    recipients = Column(JSON, nullable=False)
    is_active = Column(Boolean, nullable=False, default=True)
    next_run_at = Column(DateTime, nullable=True)
    last_run_at = Column(DateTime, nullable=True)
    last_status = Column(String(20), nullable=True)        # sent | failed
    last_error = Column(String(500), nullable=True)
    failures = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class ReportRun(TenantBase):
    __tablename__ = "report_runs"
    __table_args__ = (Index("ix_report_runs_key", "report_key", "created_at"), Index("ix_report_runs_user", "user_id", "created_at"),
                      {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    report_key = Column(String(80), nullable=False)
    report_name = Column(String(200), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    schedule_id = Column(Integer, ForeignKey("report_schedules.id", ondelete="SET NULL"), nullable=True)
    trigger = Column(String(20), nullable=False)           # export | email | schedule
    fmt = Column(String(10), nullable=True)
    period = Column(String(10), nullable=True)
    rows = Column(Integer, nullable=True)
    file_name = Column(String(255), nullable=True)
    file_url = Column(String(500), nullable=True)
    file_size_kb = Column(Integer, nullable=True)
    document_id = Column(Integer, nullable=True)           # document_management_files.id when stored in Document Hub
    recipients = Column(Text, nullable=True)
    status = Column(String(20), nullable=False)            # ok | sent | failed
    error = Column(String(500), nullable=True)
    created_at = Column(DateTime, server_default=func.now())


REPORTS360_TABLES = [ReportFavourite.__table__, ReportSchedule.__table__, ReportRun.__table__]
