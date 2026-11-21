"""Calendar & Tasks (prototype v17 → Application → Calendar & Tasks).

crm_tasks                 – tasks shown on the calendar, the task board and the task list
calendar_connections      – a user's authorised Google Calendar (OAuth tokens stored AES-GCM encrypted)
calendar_sync_items       – CRM event ↔ Google event mapping, so a re-sync updates instead of duplicating
"""
from __future__ import annotations

from sqlalchemy import Column, Date, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func

from app.models.all_models import TenantBase

TASK_STATUSES = ("To do", "In progress", "Done")
TASK_PRIORITIES = ("High", "Medium", "Low")


class CrmTask(TenantBase):
    __tablename__ = "crm_tasks"
    __table_args__ = (
        Index("idx_crm_tasks_assignee_status", "assignee_id", "status"),
        Index("idx_crm_tasks_creator", "created_by"),
        Index("idx_crm_tasks_due", "due_date"),
        Index("idx_crm_tasks_related", "related_module", "related_id"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    title = Column(String(300), nullable=False)
    related_module = Column(String(30), nullable=True)      # tenders | opportunities | leads | customers | quotations | emdbg | travel | workorders
    related_id = Column(Integer, nullable=True)
    related_label = Column(String(300), nullable=True)      # e.g. "Bid: TND-104 – Indian Railways"
    assignee_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    priority = Column(String(10), nullable=False, default="Medium")
    due_date = Column(Date, nullable=False)
    status = Column(String(20), nullable=False, default="To do")
    source = Column(String(30), nullable=True)               # manual | inbox | …
    completed_at = Column(DateTime, nullable=True)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class CalendarConnection(TenantBase):
    __tablename__ = "calendar_connections"
    __table_args__ = (UniqueConstraint("user_id", "provider", name="uq_calendar_connection_user_provider"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    provider = Column(String(20), nullable=False, default="google")
    account_email = Column(String(255), nullable=True)
    calendar_id = Column(String(255), nullable=False, default="primary")
    token_blob = Column(Text, nullable=True)                 # encrypted {"access_token", "refresh_token", "expires_at"}
    status = Column(String(20), nullable=False, default="connected")   # connected | auth_failed | error
    last_sync_at = Column(DateTime, nullable=True)
    last_status = Column(String(20), nullable=True)         # ok | partial | failed | auth_failed
    last_message = Column(String(500), nullable=True)
    last_counts = Column(String(120), nullable=True)        # "created:3,updated:1,deleted:0,unchanged:12"
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class CalendarSyncItem(TenantBase):
    __tablename__ = "calendar_sync_items"
    __table_args__ = (UniqueConstraint("connection_id", "event_key", name="uq_calendar_sync_item_key"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    connection_id = Column(Integer, ForeignKey("calendar_connections.id", ondelete="CASCADE"), nullable=False)
    event_key = Column(String(80), nullable=False)          # e.g. "bid:104", "task:12"
    external_id = Column(String(255), nullable=False)
    fingerprint = Column(String(64), nullable=False)
    event_date = Column(Date, nullable=True)
    synced_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


CALENDAR_TABLES = [CrmTask.__table__, CalendarConnection.__table__, CalendarSyncItem.__table__]
