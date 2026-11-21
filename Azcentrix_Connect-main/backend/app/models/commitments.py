"""Commitments (prototype v18 · Field Sales 360 → Commitments, Dashboard → Commitments) – one shared dataset.

commitments                 – one commitment per owner, scope (self / team), period type and period start. The owner's
                              team name is snapshotted at submission (history keeps its team); the period target is the
                              owner's annual target × period days / 365 (a Sales Head's team commitment: the sum of the
                              team members' targets). Status Submitted → Acknowledged; a period that has ended reads Closed.
commitment_entries          – the entries of a commitment, one row per entry: type (lead / deal / quote / bid / order /
                              pay), count, value, and the record it names (customer, tender or an old tender that is not
                              in the system, order, deal), expected date, lead source / segment and a note.
commitment_teams            – reporting teams (Settings → Teams) and who leads them.
commitment_team_members     – the team each person currently reports in. Changing it moves future reporting only.
commitment_settings         – company-level rules (key → JSON): types switched off, periods allowed, roles that commit,
                              weekly cut-off, payments must name a tender, remind people who have not committed.
order_payment_receipts      – customer payments received against an order (recorded by sales) and their Finance
                              acknowledgement. Only Acknowledged receipts count as collected; Pending finance is shown
                              separately. Commitments read this table; nothing here is estimated.
"""
from sqlalchemy import (JSON, Column, Date, DateTime, ForeignKey, Index, Integer, Numeric, SmallInteger, String, Text,
                        UniqueConstraint, func)

from app.models.all_models import TenantBase

TYPES = ("lead", "deal", "quote", "bid", "order", "pay")
PERIODS = ("Week", "Month", "Quarter", "Half-year", "Year")
STATUSES = ("Submitted", "Acknowledged")
RECEIPT_STATUSES = ("Pending finance", "Acknowledged", "Not credited")


class Commitment(TenantBase):
    __tablename__ = "commitments"
    __table_args__ = (
        UniqueConstraint("owner_id", "scope", "period_type", "period_from", name="uq_commitment_owner_period"),
        Index("ix_commitments_period", "period_from", "period_to"),
        Index("ix_commitments_status", "status"),
        Index("ix_commitments_team", "team_id"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    code = Column(String(20), nullable=True, unique=True)                 # CMT-0001
    owner_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    owner_role = Column(String(30), nullable=True)                        # KAM | Sales Head | Bid Manager
    scope = Column(String(10), nullable=False, default="self")            # self | team
    team_id = Column(Integer, nullable=True)                              # team at submission
    team_name = Column(String(120), nullable=True)
    period_type = Column(String(12), nullable=False)                      # PERIODS
    period_from = Column(Date, nullable=False)
    period_to = Column(Date, nullable=False)
    label = Column(String(80), nullable=False)
    target = Column(Numeric(15, 2), nullable=False, default=0)            # rupees, for the period
    note = Column(Text, nullable=True)                                    # note to manager
    status = Column(String(15), nullable=False, default="Submitted")      # STATUSES
    submitted_at = Column(DateTime, nullable=True)
    submitted_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    acknowledged_at = Column(DateTime, nullable=True)
    acknowledged_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    edited_at = Column(DateTime, nullable=True)
    edited_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class CommitmentEntry(TenantBase):
    __tablename__ = "commitment_entries"
    __table_args__ = (
        Index("ix_cm_entries_type", "commitment_id", "type"),
        Index("ix_cm_entries_customer", "customer_id"),
        Index("ix_cm_entries_tender", "tender_id"),
        Index("ix_cm_entries_order", "work_order_id"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    commitment_id = Column(Integer, ForeignKey("commitments.id", ondelete="CASCADE"), nullable=False)
    type = Column(String(10), nullable=False)                             # TYPES
    sort = Column(SmallInteger, nullable=False, default=0)
    n = Column(Numeric(12, 2), nullable=False, default=0)                 # how many (a payment entry counts 1)
    value = Column(Numeric(15, 2), nullable=False, default=0)             # rupees
    customer_id = Column(Integer, ForeignKey("customers.id", ondelete="SET NULL"), nullable=True)
    customer_name = Column(String(300), nullable=True)
    tender_id = Column(Integer, ForeignKey("tenders.id", ondelete="SET NULL"), nullable=True)
    old_tender = Column(String(300), nullable=True)                       # an earlier tender not in the system
    work_order_id = Column(Integer, ForeignKey("work_orders.id", ondelete="SET NULL"), nullable=True)
    deal_id = Column(Integer, ForeignKey("leads.id", ondelete="SET NULL"), nullable=True)
    source = Column(String(120), nullable=True)                           # lead source / segment
    expected_on = Column(Date, nullable=True)
    note = Column(String(500), nullable=True)


class CommitmentTeam(TenantBase):
    __tablename__ = "commitment_teams"
    __table_args__ = (UniqueConstraint("name", name="uq_commitment_team_name"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(120), nullable=False)
    lead_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now())


class CommitmentTeamMember(TenantBase):
    __tablename__ = "commitment_team_members"
    __table_args__ = (Index("ix_cm_team_members_team", "team_id"), {"extend_existing": True})

    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    team_id = Column(Integer, ForeignKey("commitment_teams.id", ondelete="CASCADE"), nullable=False)
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class CommitmentSetting(TenantBase):
    __tablename__ = "commitment_settings"
    __table_args__ = {"extend_existing": True}

    key = Column(String(40), primary_key=True)
    value = Column(JSON, nullable=True)
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class OrderPaymentReceipt(TenantBase):
    __tablename__ = "order_payment_receipts"
    __table_args__ = (
        Index("ix_opr_order", "wo_id"),
        Index("ix_opr_status_date", "status", "received_on"),
        Index("ix_opr_by", "recorded_by"),
        {"extend_existing": True},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    wo_id = Column(Integer, ForeignKey("work_orders.id", ondelete="CASCADE"), nullable=False)
    milestone_id = Column(Integer, ForeignKey("wo_milestones.id", ondelete="SET NULL"), nullable=True)   # payment stage
    amount = Column(Numeric(15, 2), nullable=False)
    received_on = Column(Date, nullable=False)
    mode = Column(String(40), nullable=True)
    reference = Column(String(120), nullable=True)                         # UTR / cheque
    remarks = Column(String(500), nullable=True)
    recorded_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)   # collected by
    recorded_at = Column(DateTime, server_default=func.now())
    status = Column(String(20), nullable=False, default="Pending finance")  # RECEIPT_STATUSES
    acknowledged_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    acknowledged_at = Column(DateTime, nullable=True)
    bank_date = Column(Date, nullable=True)
    credited_amount = Column(Numeric(15, 2), nullable=True)
    # Orders & Projects v18 · payment collection (added by order_payment_service.ensure_receipt_schema – additive ALTERs)
    stage_id = Column(Integer, nullable=True, index=True)                  # order_payment_stages.id
    entered_by = Column(Integer, nullable=True)                            # who keyed the receipt in (maker)
    bank_ref = Column(String(120), nullable=True)                          # bank reference confirmed by Finance
    credited_to = Column(String(120), nullable=True)                       # account the money was credited to
    ack_remarks = Column(String(500), nullable=True)
    original_amount = Column(Numeric(15, 2), nullable=True)               # amount as recorded, when Finance credited a different amount
    updated_at = Column(DateTime, nullable=True)


COMMITMENT_TABLES = [CommitmentTeam.__table__, CommitmentTeamMember.__table__, CommitmentSetting.__table__, Commitment.__table__,
                     CommitmentEntry.__table__, OrderPaymentReceipt.__table__]
