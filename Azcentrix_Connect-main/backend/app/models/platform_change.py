from datetime import datetime

from sqlalchemy import JSON, Boolean, Column, Date, DateTime, Integer, String

from app.database import Base


class PlatformChange(Base):
    """One entry of the change calendar (Data & infrastructure → Change & maintenance)."""
    __tablename__ = "platform_changes"
    id = Column(Integer, primary_key=True)                          # change ID = CHG-<id>
    type = Column(String(20), nullable=False)                       # Release | Maintenance | Migration | Security | Freeze
    description = Column(String(500), nullable=False)
    scope = Column(String(120), nullable=False, default="Prod")
    window_start = Column(Date, nullable=False, index=True)
    window_end = Column(Date, nullable=False)                       # = window_start except for a freeze period
    starts_at = Column(DateTime, nullable=True)                     # UTC; precise maintenance window (Announcements & maintenance)
    ends_at = Column(DateTime, nullable=True)
    risk = Column(String(10), nullable=False)                       # Low | Medium | High | — (freeze)
    owner = Column(String(200), nullable=True)
    requested_by = Column(Integer, nullable=True)                   # super_admins.id
    # pending | approved | rejected | cancelled | failed – follows the linked request in the approval queue
    status = Column(String(20), nullable=False, default="pending", index=True)
    in_freeze = Column(Boolean, nullable=False, default=False)
    approvals_required = Column(Integer, nullable=False, default=1)  # 2 inside a change freeze
    approvals = Column(JSON, nullable=True)                         # [{"by": id, "name", "at", "note"}]
    approval_request_id = Column(Integer, nullable=True)            # platform_approval_requests.id waiting / last decided
    decided_by = Column(String(200), nullable=True)
    decided_at = Column(DateTime, nullable=True)
    decision_note = Column(String(500), nullable=True)
    freeze_key = Column(String(30), nullable=True, unique=True)     # "2026-12-10..2027-01-05" for freeze rows
    executed_at = Column(DateTime, nullable=True)                   # a backend service ran the change
    execution_ref = Column(String(200), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=True)
