"""Travel & Expense (prototype v17 · Finance & Field → Travel & Expense) – side tables.

Trips stay in ``travel_requests``, expense entries in ``tada_line_items`` (on the trip's ``tada_claims`` row) and receipts in
``tada_attachments`` – the existing TA/DA approval chain, Approvals inbox and Document Hub keep working on them. These tables
only add what those schemas have no place for:

travel_advance_txns – finance transactions on a trip advance: ``disbursed`` (money actually paid out) and ``refunded``
                      (unspent advance returned by the traveller). A requested advance (travel_requests.advance_amount) is
                      never treated as paid; outstanding = disbursed − refunded − amount adjusted against an approved claim.
travel_trip_notes   – the drawer's Notes tab.
"""
from sqlalchemy import Column, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, func

from app.models.all_models import TenantBase

ADVANCE_KINDS = ("disbursed", "refunded")


class TravelAdvanceTxn(TenantBase):
    __tablename__ = "travel_advance_txns"
    __table_args__ = (Index("ix_travel_adv_trip", "travel_request_id"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    travel_request_id = Column(Integer, ForeignKey("travel_requests.id", ondelete="CASCADE"), nullable=False)
    kind = Column(String(20), nullable=False)                 # ADVANCE_KINDS
    amount = Column(Numeric(12, 2), nullable=False)
    txn_date = Column(Date, nullable=False)
    reference = Column(String(120), nullable=True)            # UTR / cheque / voucher no.
    payment_mode = Column(String(30), nullable=True)
    notes = Column(String(500), nullable=True)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now())


class TravelTripNote(TenantBase):
    __tablename__ = "travel_trip_notes"
    __table_args__ = (Index("ix_travel_note_trip", "travel_request_id"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    travel_request_id = Column(Integer, ForeignKey("travel_requests.id", ondelete="CASCADE"), nullable=False)
    body = Column(Text, nullable=False)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now())


TRAVEL_EXPENSE_TABLES = [TravelAdvanceTxn.__table__, TravelTripNote.__table__]
