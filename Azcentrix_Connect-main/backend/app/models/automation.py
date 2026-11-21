"""Automation Studio (prototype v17 · Automation & Control → Automation studio) – side tables.

automation_rules      – "Workflow rules" tab: module + trigger (+ stage) + conditions + actions, same shape the
                         prototype's rule builder edits. Approval policies live in the existing approval matrix
                         (ApprovalRule/ApprovalRuleStep) and are surfaced here, not duplicated.
automation_run_logs   – "Run log" tab: one row per manual "Run now" / test execution of a rule or SLA watcher.
automation_scoring_rules / automation_assignment_rules – "Assignment & scoring" tab: configuration only, same as
                         the prototype (no live lead-scoring engine behind it there either).
automation_sla_rules  – "Scheduled & SLA" tab: on/off + last-run bookkeeping for the fixed set of SLA watchers
                         (the watchers themselves are code, mirroring the prototype's hardcoded SLAR list).
"""
from sqlalchemy import JSON, Boolean, Column, DateTime, Integer, String, Text, func

from app.models.all_models import TenantBase


class AutomationRule(TenantBase):
    __tablename__ = "automation_rules"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(200), nullable=False)
    module = Column(String(40), nullable=False)
    trigger = Column(String(20), nullable=False, default="create")   # create | edit | stage | delete
    stage = Column(String(120), nullable=True)
    conditions = Column(JSON, nullable=False, default=list)          # [{"f": "est_value", "o": ">=", "v": "10000000"}]
    actions = Column(JSON, nullable=False, default=list)             # [{"t": "Create task", "p": "..."}]
    is_active = Column(Boolean, nullable=False, default=True)
    runs = Column(Integer, nullable=False, default=0)
    last_run_at = Column(DateTime, nullable=True)
    created_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


class AutomationRunLog(TenantBase):
    __tablename__ = "automation_run_logs"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    source = Column(String(10), nullable=False)       # rule | sla
    source_key = Column(String(80), nullable=True)     # sla watcher key, when source == "sla"
    rule_id = Column(Integer, nullable=True)
    rule_name = Column(String(200), nullable=False)
    module = Column(String(40), nullable=False)
    matched = Column(Integer, nullable=False, default=0)
    result = Column(String(300), nullable=False)
    status = Column(String(10), nullable=False, default="Done")   # Done | Failed
    run_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)


class AutomationScoringRule(TenantBase):
    __tablename__ = "automation_scoring_rules"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    criterion = Column(String(200), nullable=False)
    points = Column(Integer, nullable=False, default=0)
    sort_order = Column(Integer, nullable=False, default=0)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


class AutomationAssignmentRule(TenantBase):
    __tablename__ = "automation_assignment_rules"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    condition_text = Column(String(300), nullable=False)
    assignee_text = Column(String(200), nullable=False)
    sort_order = Column(Integer, nullable=False, default=0)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


class AutomationSlaRule(TenantBase):
    __tablename__ = "automation_sla_rules"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String(80), nullable=False, unique=True)
    is_active = Column(Boolean, nullable=False, default=True)
    last_run_at = Column(DateTime, nullable=True)
    last_match_count = Column(Integer, nullable=True)


AUTOMATION_TABLES = [
    AutomationRule.__table__,
    AutomationRunLog.__table__,
    AutomationScoringRule.__table__,
    AutomationAssignmentRule.__table__,
    AutomationSlaRule.__table__,
]
