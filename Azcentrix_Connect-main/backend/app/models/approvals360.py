"""Approvals (prototype v18 · Automation & Control → Approvals) – side tables over the existing approval stores.

approval_request_meta – one row per approval request (key ``r<approval_requests.id>`` or ``a<approvals.id>``): the
                        Process Designer policy that created it (name, response SLA, threshold), the stage move it
                        holds (from → to), proposed field changes, the escalation state and an open request for
                        information. The approval decisions themselves stay in approval_requests / approval_request_steps
                        and approvals – nothing is duplicated.
approval_user_prefs   – My approval preferences, one row per user (open on, sort, default purpose, after I decide,
                        purposes I want to see, away + delegate + until, my quick remarks).
"""
from sqlalchemy import JSON, Boolean, Column, DateTime, ForeignKey, Integer, Numeric, String, Text, func

from app.models.all_models import TenantBase


class ApprovalRequestMeta(TenantBase):
    __tablename__ = "approval_request_meta"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    request_key = Column(String(20), nullable=False, unique=True)        # r<id> | a<id>
    policy = Column(String(200), nullable=True)
    sla_hours = Column(Integer, nullable=True)
    threshold = Column(Numeric(15, 2), nullable=True)
    value = Column(Numeric(15, 2), nullable=True)
    from_stage = Column(String(150), nullable=True)
    to_stage = Column(String(150), nullable=True)
    changes = Column(JSON, nullable=True)                                # {field: [current, proposed]}
    escalation_status = Column(String(20), nullable=True)                # escalated
    escalated_to = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    escalated_at = Column(DateTime, nullable=True)
    escalation_reason = Column(Text, nullable=True)
    info_open = Column(Boolean, nullable=False, default=False)
    info_question = Column(Text, nullable=True)
    info_asked_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    info_asked_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class ApprovalUserPref(TenantBase):
    __tablename__ = "approval_user_prefs"
    __table_args__ = {"extend_existing": True}

    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    data = Column(JSON, nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


APPROVALS360_TABLES = [ApprovalRequestMeta.__table__, ApprovalUserPref.__table__]
