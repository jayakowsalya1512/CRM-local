from datetime import datetime

from sqlalchemy import JSON, Boolean, Column, Date, DateTime, Index, Integer, String, Text, UniqueConstraint

from app.database import Base


class PlatformCsPlaybook(Base):
    """Customer-success playbook switches (one row per rule once changed; missing rows use the default, on)."""
    __tablename__ = "platform_cs_playbooks"
    key = Column(String(30), primary_key=True)
    enabled = Column(Boolean, nullable=False)
    updated_by = Column(String(255), nullable=True)
    updated_at = Column(DateTime, nullable=True)


class PlatformCsCondition(Base):
    """A playbook condition currently true for a tenant. ``since`` identifies the episode: actions run once per episode,
    and the row is removed when a run finds the condition no longer true (the next match is a new episode)."""
    __tablename__ = "platform_cs_conditions"
    rule = Column(String(30), primary_key=True)
    tenant_id = Column(Integer, primary_key=True)
    episode = Column(String(40), nullable=False)
    since = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformCsAction(Base):
    """One playbook action for a tenant and episode. A ``done`` row blocks the same action from running again."""
    __tablename__ = "platform_cs_actions"
    __table_args__ = (
        UniqueConstraint("rule", "tenant_id", "episode", "action", name="uq_platform_cs_action"),
        Index("ix_platform_cs_actions_run", "run_id"),
        Index("ix_platform_cs_actions_tenant", "tenant_id", "created_at"),
    )
    id = Column(Integer, primary_key=True)
    run_id = Column(Integer, nullable=False)
    rule = Column(String(30), nullable=False)
    tenant_id = Column(Integer, nullable=False)
    episode = Column(String(40), nullable=False)
    action = Column(String(20), nullable=False)        # task | in_app | email
    status = Column(String(12), nullable=False)        # done | failed | not_sent
    detail = Column(String(300), nullable=True)
    attempts = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=True)


class PlatformCsTask(Base):
    """Customer-success task created by a playbook (call, onboarding session, renewal), assigned to a platform user."""
    __tablename__ = "platform_cs_tasks"
    __table_args__ = (
        Index("ix_platform_cs_tasks_assignee", "assignee_admin_id", "status"),
        Index("ix_platform_cs_tasks_tenant", "tenant_id", "status"),
    )
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, nullable=False)
    rule = Column(String(30), nullable=False)
    episode = Column(String(40), nullable=False)
    title = Column(String(200), nullable=False)
    detail = Column(Text, nullable=True)
    assignee_admin_id = Column(Integer, nullable=True)
    due_on = Column(Date, nullable=True)
    status = Column(String(10), nullable=False, default="open")   # open | done
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    closed_at = Column(DateTime, nullable=True)


class PlatformCsRun(Base):
    """A Run playbook execution and its outcome."""
    __tablename__ = "platform_cs_runs"
    __table_args__ = (Index("ix_platform_cs_runs_started", "started_at"),)
    id = Column(Integer, primary_key=True)
    started_by = Column(String(255), nullable=True)
    started_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    finished_at = Column(DateTime, nullable=True)
    outcome = Column(String(12), nullable=True)        # success | partial | failed | no_matches
    summary = Column(JSON, nullable=True)
