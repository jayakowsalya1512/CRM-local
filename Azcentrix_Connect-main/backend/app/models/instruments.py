"""Guarantees & Deposits (prototype v17 · Finance & Field → Guarantees & Deposits) – side tables only.

An instrument is still the ``emdbg`` row (Customer 360, dashboards, reports and the legacy /emdbg API read it):
ID = reference_num (EMDBG-YYYYMM-####), Reference = instrument_number (bank BG / receipt number), Valid until =
expiry_date, Issued = issued_date, Submitted with tender = submitted_date, Released = release_date.

instrument_types    – the tenant's instrument types (stable key → stored emdbg.instrument_type value): EMD, BG, PBG,
                      Security Deposit, FDR (+ legacy DD / Advance BG … when in use). FDR follows Settings → Track FDR.
instrument_profiles – per instrument: type key, "Requested from bank" date, release workflow (pending approval →
                      Release Requested → Released) with its approval request, extension waiting for approval, bank
                      margin / lien and FDR details, expiry-reminder and escalation history keys and an ``auto_key`` that
                      makes "auto-create instrument when a bid needs EMD" idempotent.
instrument_notes    – Notes tab of the instrument drawer.
Validity extensions are recorded in the existing emdbg_renewal_history table (old → new expiry).

Prototype v18 adds the request lifecycle columns on instrument_profiles (mode, beneficiary, payable at, required by,
head approval, Finance payment / issue, refund request, receipt, Finance acknowledgement, forfeiture) and
tender_deposits (per-tender EMD / tender fee / bid-security requirement that drives the bid-work lock).
"""
from sqlalchemy import Boolean, Column, Date, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, func

from app.models.all_models import TenantBase


class InstrumentType(TenantBase):
    __tablename__ = "instrument_types"
    __table_args__ = {"extend_existing": True}

    key = Column(String(40), primary_key=True)                 # EMD | BG | PBG | SD | FDR | DD …
    label = Column(String(60), nullable=False)                 # badge text
    stored_value = Column(String(40), nullable=False)          # emdbg.instrument_type enum value
    category = Column(String(20), nullable=False, default="guarantee")   # guarantee | deposit
    sort_order = Column(Integer, nullable=False, default=0)
    is_active = Column(Boolean, nullable=False, default=True)


class InstrumentProfile(TenantBase):
    __tablename__ = "instrument_profiles"
    __table_args__ = {"extend_existing": True}

    emdbg_id = Column(Integer, ForeignKey("emdbg.id", ondelete="CASCADE"), primary_key=True)
    type_key = Column(String(40), nullable=True)
    requested_on = Column(Date, nullable=True)                 # lifecycle: Requested from bank
    release_state = Column(String(20), nullable=False, default="none")   # none | pending_approval | requested | released | rejected
    release_requested_at = Column(DateTime, nullable=True)
    release_requested_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    release_reason = Column(Text, nullable=True)
    release_approval_id = Column(Integer, nullable=True, index=True)
    release_confirmed_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    ext_new_date = Column(Date, nullable=True)                 # extension waiting for approval
    ext_bank_ref = Column(String(100), nullable=True)
    ext_approval_id = Column(Integer, nullable=True, index=True)
    margin_pct = Column(Numeric(5, 2), nullable=True)
    margin_amount = Column(Numeric(15, 2), nullable=True)
    lien_amount = Column(Numeric(15, 2), nullable=True)
    lien_reference = Column(String(100), nullable=True)
    fdr_number = Column(String(100), nullable=True)
    fdr_amount = Column(Numeric(15, 2), nullable=True)
    fdr_rate = Column(Numeric(5, 2), nullable=True)
    fdr_maturity = Column(Date, nullable=True)
    reminded_for = Column(Date, nullable=True)                 # expiry reminder sent for this validity date
    escalated_at = Column(DateTime, nullable=True)
    escalation_count = Column(Integer, nullable=False, default=0)
    auto_key = Column(String(80), nullable=True, unique=True)  # tender:<id>:emd
    # ── prototype v18 request → approval → Finance → refund → receipt → acknowledgement ──
    mode = Column(String(60), nullable=True)                   # Online – portal payment … / Bank guarantee / Exempted – MSE / Startup
    beneficiary = Column(String(200), nullable=True)
    payable_at = Column(String(200), nullable=True)
    required_by = Column(Date, nullable=True)
    priority = Column(String(10), nullable=True)
    req_approval_id = Column(Integer, nullable=True, index=True)   # approval_requests.id of the head approval
    approved_on = Column(DateTime, nullable=True)              # = sent to Finance
    approved_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    withdrawn = Column(Boolean, nullable=False, default=False)
    utr = Column(String(100), nullable=True)
    txn_ref = Column(String(100), nullable=True)
    pay_date = Column(Date, nullable=True)
    fin_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    debit_account = Column(String(150), nullable=True)
    charges = Column(Numeric(15, 2), nullable=True)
    pay_remarks = Column(Text, nullable=True)
    ret_on = Column(Date, nullable=True)                       # refund / release requested on
    ret_letter = Column(String(100), nullable=True)
    recv_on = Column(Date, nullable=True)
    recv_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    recv_amount = Column(Numeric(15, 2), nullable=True)
    recv_mode = Column(String(60), nullable=True)
    recv_ref = Column(String(150), nullable=True)
    recv_remarks = Column(Text, nullable=True)
    ack_on = Column(Date, nullable=True)
    ack_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    ack_ref = Column(String(100), nullable=True)
    ack_amount = Column(Numeric(15, 2), nullable=True)
    ack_account = Column(String(150), nullable=True)
    ack_shortfall = Column(Numeric(15, 2), nullable=True)
    ack_remarks = Column(Text, nullable=True)
    forfeit_on = Column(Date, nullable=True)
    forfeit_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    forfeit_reason = Column(Text, nullable=True)
    exempt_cert = Column(String(150), nullable=True)
    reminded_days = Column(Integer, nullable=True)             # last expiry-reminder threshold sent for reminded_for
    expired_alert_at = Column(DateTime, nullable=True)
    fin_alert_on = Column(Date, nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class TenderDeposit(TenantBase):
    """Per-tender deposit requirement (prototype tdDep): EMD · Tender fee · Bid security BG – Required / Not required /
    Exempted with amount, mode, beneficiary, payable at, required-by date and exemption certificate."""
    __tablename__ = "tender_deposits"
    __table_args__ = (UniqueConstraint("tender_id", "kind", name="uq_tender_deposits_kind"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    tender_id = Column(Integer, ForeignKey("tenders.id", ondelete="CASCADE"), nullable=False, index=True)
    kind = Column(String(10), nullable=False)                  # emd | fee | bg
    req = Column(String(20), nullable=False, default="Required")   # Required | Not required | Exempted
    amount = Column(Numeric(15, 2), nullable=True)
    mode = Column(String(60), nullable=True)
    beneficiary = Column(String(200), nullable=True)
    payable_at = Column(String(200), nullable=True)
    required_by = Column(Date, nullable=True)
    cert = Column(String(150), nullable=True)
    remarks = Column(Text, nullable=True)
    updated_by = Column(Integer, nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class InstrumentNote(TenantBase):
    __tablename__ = "instrument_notes"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    emdbg_id = Column(Integer, ForeignKey("emdbg.id", ondelete="CASCADE"), nullable=False, index=True)
    body = Column(Text, nullable=False)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, nullable=True, onupdate=func.now())


INSTRUMENT_TABLES = [InstrumentType.__table__, InstrumentProfile.__table__, InstrumentNote.__table__, TenderDeposit.__table__]
