"""Process Designer (prototype v17 R.workflow) – side tables.

Stages of Deals and Bids & Tenders live in the existing workflow engine (workflow_definitions / workflow_stages /
workflow_record_stages) and are edited through deal_service / bid_service, so the boards follow at once.  The designer
adds what the prototype has on top:

process_config         key → JSON: conversion rules (lead / pipeline / tender), published version, pipeline follow-ons.
process_stage_extras   per stage (engine stage id, or stage name for the fixed Lead / Quote / Order flows): exit criteria,
                       "on entering" automation, forecast category, approval policy {chain, min, sla, auto}, and – for the
                       fixed flows only – SLA / gate / owner / checklist (the engine stores those for Deals and Bids).
process_lifecycles     extra order lifecycles (AMC, warranty, rental …) with their stages as JSON.
"""
from sqlalchemy import JSON, Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func

from app.models.all_models import TenantBase


class ProcessConfig(TenantBase):
    __tablename__ = "process_config"
    __table_args__ = {"extend_existing": True}

    key = Column(String(60), primary_key=True)
    value = Column(JSON, nullable=True)
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


class ProcessStageExtra(TenantBase):
    __tablename__ = "process_stage_extras"
    __table_args__ = (
        UniqueConstraint("workflow", "stage_ref", name="uq_process_stage_extras_stage"),
        Index("ix_process_stage_extras_workflow", "workflow"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    workflow = Column(String(40), nullable=False)          # deal_tender | tender | lead | quote | wo | lc_<key>
    stage_ref = Column(String(160), nullable=False)        # workflow_stages.id as text, or the fixed stage name
    sla_days = Column(Integer, nullable=True)              # fixed flows only
    gate = Column(String(20), nullable=True)               # fixed flows only: None | Approval | Checklist
    owner_role = Column(String(100), nullable=True)        # fixed flows only
    checklist = Column(JSON, nullable=True)                # fixed flows only
    exit_criteria = Column(String(300), nullable=True)
    automation = Column(String(300), nullable=True)
    forecast = Column(String(20), nullable=True)           # Pipeline | Best case | Commit | Closed | Omitted
    approval = Column(JSON, nullable=True)                 # {"chain": [role names], "min": rupees, "sla": hours, "auto": bool}
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


class ProcessLifecycle(TenantBase):
    __tablename__ = "process_lifecycles"
    __table_args__ = (
        UniqueConstraint("key", name="uq_process_lifecycles_key"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String(40), nullable=False)               # lc_<slug>
    name = Column(String(100), nullable=False)
    trigger = Column(String(20), nullable=False, default="manual")   # manual | closure
    stages = Column(JSON, nullable=False)                  # [{name, kind, sla, gate, owner_role, checklist, exit, automation}]
    is_active = Column(Boolean, nullable=False, default=True)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


PROCESS_TABLES = [ProcessConfig.__table__, ProcessStageExtra.__table__, ProcessLifecycle.__table__]
