"""Orders & Projects (prototype v17 · Sales → Orders & Projects) – side tables only.

An order is still the ``work_orders`` row (customers, quotes, tenders, reports and the legacy /workorders API keep
reading it). Its lifecycle stage lives in the shared tenant workflow tables (workflow_definitions / workflow_stages /
workflow_record_stages) under the workflow key of its order lifecycle.

order_lifecycles – the tenant's order lifecycles (Process Designer): the default "Project / Supply" lifecycle (workflow
                   key ``wo``) plus follow-on lifecycles such as AMC / service contracts, warranty or rental. Each has a
                   trigger: manual ("Create follow-on" on an order), closure (when a project order closes) or won (when a
                   deal is won).
order_profiles   – per-order values the work_orders table has no column for: lifecycle, start date, when the current
                   stage was entered, a stage move waiting for approval, confirmed checklist items, the parent order of a
                   follow-on contract, the deal that created it and an ``auto_key`` that makes automatic / follow-on
                   creation idempotent (unique: one follow-on per parent + lifecycle, one order per won deal + lifecycle).
order_notes      – Notes tab of the order drawer.
Milestones and invoices stay in wo_milestones / wo_invoices; wo_milestones gets an ``invoice_id`` link (additive).
"""
from sqlalchemy import JSON, Boolean, Column, Date, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, func

from app.models.all_models import TenantBase


class OrderLifecycle(TenantBase):
    __tablename__ = "order_lifecycles"
    __table_args__ = (UniqueConstraint("type_name", name="uq_order_lifecycles_type"), {"extend_existing": True})

    workflow = Column(String(40), primary_key=True)              # workflow_definitions.workflow: wo | wo_x<n>
    type_name = Column(String(80), nullable=False)               # "Project / Supply", "AMC / service contract" …
    label = Column(String(120), nullable=False)
    trigger = Column(String(20), nullable=False, default="manual")   # manual | closure | won
    template = Column(String(60), nullable=True)                 # the template it was started from
    sort_order = Column(Integer, nullable=False, default=0)
    is_active = Column(Boolean, nullable=False, default=True)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now())


class OrderProfile(TenantBase):
    __tablename__ = "order_profiles"
    __table_args__ = {"extend_existing": True}

    wo_id = Column(Integer, ForeignKey("work_orders.id", ondelete="CASCADE"), primary_key=True)
    lifecycle = Column(String(40), nullable=False, default="wo", index=True)
    start_date = Column(Date, nullable=True)
    stage_entered_at = Column(DateTime, nullable=True)
    pending_stage_id = Column(Integer, nullable=True)
    approval_request_id = Column(Integer, nullable=True, index=True)
    checklist = Column(JSON, nullable=True)                      # {stage name: [confirmed items]}
    parent_wo_id = Column(Integer, nullable=True, index=True)    # follow-on contract → its project order
    deal_id = Column(Integer, nullable=True, index=True)         # leads.id of the deal that created / owns it
    auto_key = Column(String(80), nullable=True, unique=True)    # fo:<parent>:<lifecycle> | won:<deal>:<lifecycle>
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class OrderNote(TenantBase):
    __tablename__ = "order_notes"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    wo_id = Column(Integer, ForeignKey("work_orders.id", ondelete="CASCADE"), nullable=False, index=True)
    body = Column(Text, nullable=False)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, nullable=True, onupdate=func.now())


class OrderPaymentPlan(TenantBase):
    """v18 · payment plan of an order: Single payment or Stage-wise (the stages are order_payment_stages)."""
    __tablename__ = "order_payment_plans"
    __table_args__ = {"extend_existing": True}

    wo_id = Column(Integer, ForeignKey("work_orders.id", ondelete="CASCADE"), primary_key=True)
    plan = Column(String(20), nullable=False, default="Single")            # Single | Stage-wise
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class OrderPaymentStage(TenantBase):
    """v18 · one stage of an order's payment schedule. The amount is never stored: it is pct × order value (the last
    stage takes the rounding difference), so a changed order value re-prices the schedule immediately."""
    __tablename__ = "order_payment_stages"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    wo_id = Column(Integer, ForeignKey("work_orders.id", ondelete="CASCADE"), nullable=False, index=True)
    position = Column(Integer, nullable=False, default=0)
    name = Column(String(200), nullable=False)
    pct = Column(Numeric(6, 2), nullable=False)
    due_date = Column(Date, nullable=True)
    invoice_ref = Column(String(120), nullable=True)                       # invoice / reference raised for the stage
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class OrderReceiptHistory(TenantBase):
    """v18 · every change to a customer receipt (recorded, corrected, re-linked by a plan change, acknowledged, not
    credited) with the values before and after. Rows are never updated or deleted by the application."""
    __tablename__ = "order_receipt_history"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    receipt_id = Column(Integer, ForeignKey("order_payment_receipts.id", ondelete="CASCADE"), nullable=False, index=True)
    wo_id = Column(Integer, nullable=False, index=True)
    action = Column(String(30), nullable=False)          # recorded | corrected | relinked | acknowledged | not_credited
    actor_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    at = Column(DateTime, nullable=False)
    old = Column(JSON, nullable=True)
    new = Column(JSON, nullable=True)
    note = Column(String(500), nullable=True)


ORDER_TABLES = [OrderLifecycle.__table__, OrderProfile.__table__, OrderNote.__table__]
PAYMENT_TABLES = [OrderPaymentPlan.__table__, OrderPaymentStage.__table__, OrderReceiptHistory.__table__]
