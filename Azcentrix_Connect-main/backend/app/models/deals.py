"""Deals (prototype v17 · Sales → Deals) – side tables only; a deal is still the ``leads`` row (opportunity).

deal_pipelines  – the tenant's deal pipelines (Pipelines & Stages): workflow key, workflow type name shown in the
                  table / form ("Tender", "Quotation"), the board label ("Tender", "Quote"), the conversion destination
                  and order. Stages live in the shared tenant workflow tables (workflow_definitions / workflow_stages,
                  the same tables the platform's workflow templates write) and each deal's current stage is a row in
                  workflow_record_stages (workflow = pipeline key, record_id = leads.id).
deal_profiles   – per-deal fields the leads table has no column for: pipeline, expected close date, EMD required,
                  when the current stage was entered (SLA), lost reason, a stage move waiting for approval and the
                  checklist items confirmed when entering checklist-gated stages.
"""
from sqlalchemy import JSON, Boolean, Column, Date, DateTime, ForeignKey, Integer, String, Text, func

from app.models.all_models import TenantBase


class DealPipeline(TenantBase):
    __tablename__ = "deal_pipelines"
    __table_args__ = {"extend_existing": True}

    workflow = Column(String(40), primary_key=True)          # workflow_definitions.workflow, e.g. deal_tender
    name = Column(String(60), nullable=False)                # workflow type: Tender | Quotation | …
    label = Column(String(60), nullable=False)               # board selector label: Tender | Quote | …
    destination = Column(String(20), nullable=False)         # conversion target: tender | quotation
    sort_order = Column(Integer, nullable=False, default=0)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class DealProfile(TenantBase):
    __tablename__ = "deal_profiles"
    __table_args__ = {"extend_existing": True}

    lead_id = Column(Integer, ForeignKey("leads.id", ondelete="CASCADE"), primary_key=True)
    pipeline = Column(String(40), nullable=False)
    close_date = Column(Date, nullable=True)
    emd_required = Column(Boolean, nullable=False, default=False)
    stage_entered_at = Column(DateTime, nullable=True)
    lost_reason = Column(String(120), nullable=True)
    lost_note = Column(Text, nullable=True)
    pending_stage_id = Column(Integer, nullable=True)        # workflow_stages.id waiting for approval
    approval_request_id = Column(Integer, nullable=True)     # approval_requests.id (module "deal", action "stage")
    checklist = Column(JSON, nullable=True)                  # {stage name: [confirmed items]}
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


DEAL_TABLES = [DealPipeline.__table__, DealProfile.__table__]
