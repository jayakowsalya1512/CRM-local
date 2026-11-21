"""Bids & Tenders (prototype v17 · Sales → Bids & Tenders) – side tables only; a bid is still the ``tenders`` row.

Reused as they are: tenders (record, key dates, values, PO, scope of work, payment terms), tender_products (the
Workings BoQ = final BoQ lines, is_final_boq = 1), tender_consignees (+ qty_share), work_orders (Create work order),
emdbg (EMD / BG instruments), document_management_files / tender_documents (Document Hub), competitors, oems,
lead_sources (portal master), lead_categories (category master), location_masters (locations).

The tender's workflow stage is a row in workflow_record_stages (workflow = "tender"), the same table the platform's
workflow templates write; the stages themselves are workflow_stages rows of workflow "tender".

bid_profiles          – per-bid fields the tenders table has no column for (category, location, principal OEM, bid
                        validity, selection method, JV/consortium, GST applicable, price build-up %, synced quoted
                        price, tech cut-off, PBG %, PO delivery / LD / acknowledged, price-bid approval, stage clock,
                        stage move waiting for approval, lost reason)
bid_corrigenda        – corrigenda published on the portal
bid_checklist_items   – eligibility criteria and mandatory documents per bid (seeded from the tenant's configured lists)
bid_fee_items         – fee / EMD / PBG & document checklist rows (amount, payment mode, stakeholder, cut-off date,
                        attachment, status) – bookkeeping only, does not touch Guarantees & Deposits (EMDBG)
bid_tech_scores       – technical evaluation matrix (criterion, max marks, awarded, evaluator remark)
bid_competitor_prices – opened price bids of competitors (Competitors master)
bid_negotiation_rounds– negotiation rounds logged on the Financial tab
bid_penalty_clauses   – Specific Tender Details → Penalty Clause rows
bid_payment_milestones– Specific Tender Details → Payment Milestone rows
"""
from sqlalchemy import JSON, Boolean, Column, Date, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, func

from app.models.all_models import TenantBase


class BidFlow(TenantBase):
    """Tender & bid flows (prototype Process Designer → "Tender & bid flows"): a company can bid several ways at once
    (Tech → Commercial → RA → Award, Two-cover QCBS, Single-cover GeM …). Stages live in workflow_stages under the
    flow's workflow key; the default flow keeps the key "tender" (the one the platform's template push writes)."""
    __tablename__ = "bid_flows"
    __table_args__ = {"extend_existing": True}

    workflow = Column(String(40), primary_key=True)
    name = Column(String(100), nullable=False)
    is_default = Column(Boolean, nullable=False, default=False)
    sort_order = Column(Integer, nullable=False, default=0)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, server_default=func.now())


class BidProfile(TenantBase):
    __tablename__ = "bid_profiles"
    __table_args__ = {"extend_existing": True}

    tender_id = Column(Integer, ForeignKey("tenders.id", ondelete="CASCADE"), primary_key=True)
    flow = Column(String(40), nullable=True)                 # bid_flows.workflow this tender follows
    category_id = Column(Integer, nullable=True)             # lead_categories.id
    location_id = Column(Integer, nullable=True)             # location_masters.id
    oem_id = Column(Integer, nullable=True)                  # oems.id – principal OEM
    bid_validity_days = Column(Integer, nullable=True)
    selection_method = Column(String(40), nullable=True)     # L1 | QCBS | Single bid
    jv_allowed = Column(Boolean, nullable=True)               # JV / Consortium allowed
    jv_member_count = Column(Integer, nullable=True)
    gst_applicable = Column(Boolean, nullable=True)
    overhead_pct = Column(Numeric(6, 2), nullable=True)
    contingency_pct = Column(Numeric(6, 2), nullable=True)
    margin_pct = Column(Numeric(6, 2), nullable=True)
    quoted_price = Column(Numeric(18, 2), nullable=True)     # last "Sync to financial bid"
    synced_at = Column(DateTime, nullable=True)
    synced_by = Column(Integer, nullable=True)
    tech_cutoff_pct = Column(Numeric(6, 2), nullable=True)
    pbg_pct = Column(Numeric(6, 2), nullable=True)
    delivery_period = Column(String(200), nullable=True)
    ld_terms = Column(String(300), nullable=True)
    po_ack = Column(Boolean, nullable=False, default=False)
    price_status = Column(String(20), nullable=True)         # None | pending | approved | rejected
    price_request_id = Column(Integer, nullable=True)        # approval_requests.id (module tender, action price_bid)
    stage_entered_at = Column(DateTime, nullable=True)
    pending_stage_id = Column(Integer, nullable=True)        # workflow_stages.id waiting for approval
    approval_request_id = Column(Integer, nullable=True)     # approval_requests.id (module tender, action stage)
    checklist = Column(JSON, nullable=True)                  # {stage name: [confirmed items]}
    lost_reason = Column(String(120), nullable=True)
    lost_note = Column(Text, nullable=True)
    reminders = Column(JSON, nullable=True)                  # {"submit": "2026-11-12", …} – last reminder sent per kind
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class BidCorrigendum(TenantBase):
    __tablename__ = "bid_corrigenda"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    tender_id = Column(Integer, ForeignKey("tenders.id", ondelete="CASCADE"), nullable=False, index=True)
    number = Column(String(80), nullable=False)
    description = Column(Text, nullable=False)
    corr_date = Column(Date, nullable=False)
    created_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, server_default=func.now())


class BidChecklistItem(TenantBase):
    __tablename__ = "bid_checklist_items"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    tender_id = Column(Integer, ForeignKey("tenders.id", ondelete="CASCADE"), nullable=False, index=True)
    kind = Column(String(20), nullable=False)                # eligibility | document
    label = Column(String(300), nullable=False)
    position = Column(Integer, nullable=False, default=0)
    ok = Column(Boolean, nullable=False, default=False)
    document_id = Column(String(40), nullable=True)          # Document Hub id (e.g. "dm-12" / "tender-5")
    document_name = Column(String(300), nullable=True)
    updated_by = Column(Integer, nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class BidFeeItem(TenantBase):
    """Fee & document checklist (Tender Details tab) – tender fee / EMD / performance BG etc. as rows with their own
    amount, payment mode, stakeholder, cut-off date, an optional Document Hub attachment and a payment status. Each
    row is informational bookkeeping on the tender itself; it does not create or touch a Guarantees & Deposits
    (EMDBG) instrument – that stays a separate, post-award concern, untouched by this table."""
    __tablename__ = "bid_fee_items"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    tender_id = Column(Integer, ForeignKey("tenders.id", ondelete="CASCADE"), nullable=False, index=True)
    label = Column(String(200), nullable=False)               # e.g. "Tender fee", "EMD", "Performance BG"
    amount = Column(Numeric(15, 2), nullable=True)
    payment_mode = Column(String(20), nullable=True)          # DD | BG | Online | NEFT
    stakeholder = Column(String(200), nullable=True)
    cutoff_date = Column(Date, nullable=True)
    document_id = Column(String(40), nullable=True)           # Document Hub id, same convention as BidChecklistItem
    document_name = Column(String(300), nullable=True)
    status = Column(String(20), nullable=False, default="pending")   # pending | paid | not_due
    position = Column(Integer, nullable=False, default=0)
    updated_by = Column(Integer, nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class BidTechScore(TenantBase):
    __tablename__ = "bid_tech_scores"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    tender_id = Column(Integer, ForeignKey("tenders.id", ondelete="CASCADE"), nullable=False, index=True)
    criterion = Column(String(300), nullable=False)
    max_marks = Column(Numeric(8, 2), nullable=False)
    awarded = Column(Numeric(8, 2), nullable=True)
    remark = Column(String(500), nullable=True)
    position = Column(Integer, nullable=False, default=0)
    updated_by = Column(Integer, nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class BidCompetitorPrice(TenantBase):
    __tablename__ = "bid_competitor_prices"
    __table_args__ = (UniqueConstraint("tender_id", "competitor_id", name="uq_bid_competitor"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    tender_id = Column(Integer, ForeignKey("tenders.id", ondelete="CASCADE"), nullable=False, index=True)
    competitor_id = Column(Integer, nullable=False)          # competitors.id
    amount = Column(Numeric(18, 2), nullable=False)
    created_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class BidNegotiationRound(TenantBase):
    __tablename__ = "bid_negotiation_rounds"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    tender_id = Column(Integer, ForeignKey("tenders.id", ondelete="CASCADE"), nullable=False, index=True)
    round_no = Column(Integer, nullable=False)
    our_price = Column(Numeric(18, 2), nullable=False)
    note = Column(Text, nullable=True)
    created_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, server_default=func.now())


class BidPenaltyClause(TenantBase):
    """Specific Tender Details → Penalty Clause table: free-form rows, unlike bid_fee_items this has no amount
    semantics beyond a penalty figure/percentage kept as text (clauses are worded as "0.5% per week, max 10%")."""
    __tablename__ = "bid_penalty_clauses"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    tender_id = Column(Integer, ForeignKey("tenders.id", ondelete="CASCADE"), nullable=False, index=True)
    description = Column(Text, nullable=False)
    penalty_amount = Column(String(200), nullable=True)      # kept as text – often a rate/clause, not a fixed sum
    remarks = Column(String(500), nullable=True)
    position = Column(Integer, nullable=False, default=0)
    updated_by = Column(Integer, nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class BidPaymentMilestone(TenantBase):
    """Specific Tender Details → Payment Milestone table."""
    __tablename__ = "bid_payment_milestones"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    tender_id = Column(Integer, ForeignKey("tenders.id", ondelete="CASCADE"), nullable=False, index=True)
    milestone = Column(String(300), nullable=False)
    description = Column(Text, nullable=True)
    remarks = Column(String(500), nullable=True)
    position = Column(Integer, nullable=False, default=0)
    updated_by = Column(Integer, nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


BID_TABLES = [BidFlow.__table__, BidProfile.__table__, BidCorrigendum.__table__, BidChecklistItem.__table__, BidFeeItem.__table__, BidTechScore.__table__,
              BidCompetitorPrice.__table__, BidNegotiationRound.__table__, BidPenaltyClause.__table__, BidPaymentMilestone.__table__]
