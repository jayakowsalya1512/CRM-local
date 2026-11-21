"""
Tender Router — 5-Step Workflow
================================
FIXES APPLIED (this session):
  A. _save_upload: uses settings.MEDIA_ROOT (now defined in config.py)
  B. Step 3 submit: 3-way role split identical to Step 2:
       - CEO/admin → auto-approve → step3_active + tender_status='Submitted'
       - Manager/VP → skip manager approval, go direct to CEO
       - Sales → manager first, then CEO
  C. Step 3 submit: `if approval: t.step3_approval_id = approval.id`
     so NoneType crash is impossible
  D. Step 3 early-return guard now includes 'step3_active' so saving
     after CEO approval never re-triggers a new approval request

Previous fixes (from prior sessions):
  1. create_approval_request() uses `requester=`
  2. step2/3_approved_at guarded with hasattr
  3. bid_tracking guarded with hasattr
  4. tech_bid_eligible DB↔bool conversion
  5. loss_reason in LossAnalysisIn + _upsert_loss_analysis
  6. bid_amount field name aligned
  7/10. Approval imported at module level
  8. step3_active removed from step2 resubmit guard
"""

import logging
import os
import uuid
from datetime import datetime
from app.core.timezone import now_ist, today_ist
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.orm import Session
from sqlalchemy import text as sa_text, func
from pydantic import BaseModel

from app.dependencies import get_tenant_db, get_current_user
from app.models.all_models import (
    Tender, TenderProduct, TenderProductOEM, TenderDocument,
    TenderTechBidBidder, TenderTechBidItem, TenderLossAnalysis,
    User, ActivityLog, Notification, Approval,
)
from app.services.approval_service import create_approval_request, process_approval_decision
from app.core.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()

PRIVILEGED_ROLES = ('admin', 'ceo')
MANAGER_ROLES    = ('admin', 'ceo', 'manager', 'vp')

# ─── One-time DB enum sanitiser ───────────────────────────────────────────────
# SQLAlchemy's enum processor crashes at the C extension level when it reads
# a legacy '0' or '1' value from the tenders table.  This runs a fast raw-SQL
# UPDATE that fixes every bad row before SQLAlchemy ever touches them.

_sanitized_dbs: set = set()   # track which DB sessions have been cleaned
_schema_ready_dbs: set = set()  # track which DB sessions have tender columns in place




def _ensure_tender_schema(db: Session) -> None:
    """Add newer tender columns when the tenant DB is behind the current model."""
    db_id = id(db.get_bind())
    if db_id in _schema_ready_dbs:
        return
    try:
        db.execute(sa_text("""
            ALTER TABLE tenders
              ADD COLUMN IF NOT EXISTS `po_doc`             VARCHAR(500) NULL,
              ADD COLUMN IF NOT EXISTS `no_of_consignee`    INT NULL COMMENT 'Number of consignees for PO',
              ADD COLUMN IF NOT EXISTS `bid_tracking`       VARCHAR(200) NULL COMMENT 'Bid tracking reference',
              ADD COLUMN IF NOT EXISTS `wrk_order_id`       VARCHAR(50) NULL,
              ADD COLUMN IF NOT EXISTS `wo_value`           DECIMAL(10,0) NULL,
              ADD COLUMN IF NOT EXISTS `dlvry_date`         DATE NULL,
              ADD COLUMN IF NOT EXISTS `instln_date`        DATE NULL,
              ADD COLUMN IF NOT EXISTS `site_loc`           VARCHAR(30) NULL,
              ADD COLUMN IF NOT EXISTS `site_eng`           VARCHAR(30) NULL,
              ADD COLUMN IF NOT EXISTS `eng_phone`          VARCHAR(20) NULL,
              ADD COLUMN IF NOT EXISTS `advance`            VARCHAR(10) NULL,
              ADD COLUMN IF NOT EXISTS `retention`          VARCHAR(10) NULL,
              ADD COLUMN IF NOT EXISTS `pmnt_terms`         TEXT NULL,
              ADD COLUMN IF NOT EXISTS `sow`                TEXT NULL,
              ADD COLUMN IF NOT EXISTS `step2_approved_at`  DATETIME NULL,
              ADD COLUMN IF NOT EXISTS `step3_approved_at`  DATETIME NULL,
              ADD COLUMN IF NOT EXISTS `listed_in_accounts` TINYINT(1) NOT NULL DEFAULT 0
        """))
        db.execute(sa_text("ALTER TABLE tenders MODIFY COLUMN `po_doc` VARCHAR(500) NULL"))
        db.commit()
        _schema_ready_dbs.add(db_id)
    except Exception as e:
        db.rollback()
        logger.warning(f"tender schema ensure (non-fatal): {e}")
        # Don't raise — columns likely already exist, proceed normally
        _schema_ready_dbs.add(db_id)  # mark as done to avoid repeated attempts
def _sanitize_tech_bid_enum(db: Session) -> None:
    """Fix corrupt tech_bid_eligible values ('0','1') in the DB once per process."""
    db_id = id(db.get_bind())
    if db_id in _sanitized_dbs:
        return
    try:
        db.execute(sa_text(
            "UPDATE tenders "
            "SET tech_bid_eligible = CASE "
            "  WHEN tech_bid_eligible = '1' THEN 'Eligible' "
            "  WHEN tech_bid_eligible IN ('0', '') THEN 'Not Eligible' "
            "  ELSE 'Not Evaluated' END "
            "WHERE tech_bid_eligible IS NOT NULL "
            "  AND tech_bid_eligible NOT IN ('Eligible', 'Not Eligible', 'Not Evaluated')"
        ))
        db.commit()
        _sanitized_dbs.add(db_id)
    except Exception:
        db.rollback()  # never crash the request over cleanup



def _sanitize_tender_enums(db: Session, tender_id: Optional[int] = None) -> None:
    """Normalize legacy enum values before ORM row loading."""
    try:
        if tender_id is not None:
            params = {"tid": tender_id}
            db.execute(sa_text("""
                UPDATE tenders
                SET source_portal = CASE
                    WHEN source_portal IS NULL OR TRIM(CAST(source_portal AS CHAR)) = '' THEN 'Other'
                    WHEN LOWER(TRIM(CAST(source_portal AS CHAR))) = 'gem' THEN 'GeM'
                    WHEN TRIM(CAST(source_portal AS CHAR)) IN ('IREPS', 'GeM', 'CPP', 'CPPP', 'NIC', 'Direct', 'Other') THEN TRIM(CAST(source_portal AS CHAR))
                    ELSE 'Other'
                END
                WHERE id = :tid
            """), params)
            db.execute(sa_text("""
                UPDATE tenders
                SET tender_status = CASE
                    WHEN tender_status IS NULL OR TRIM(CAST(tender_status AS CHAR)) = '' THEN 'Aligned'
                    WHEN TRIM(CAST(tender_status AS CHAR)) IN ('Aligned', 'Evaluation', 'Submitted', 'Pre-Bid', 'Reverse Auction', 'Closed')
                        THEN TRIM(CAST(tender_status AS CHAR))
                    ELSE 'Aligned'
                END
                WHERE id = :tid
            """), params)
            db.execute(sa_text("""
                UPDATE tenders
                SET result = CASE
                    WHEN result IS NULL OR TRIM(CAST(result AS CHAR)) = '' THEN 'Pending'
                    WHEN TRIM(CAST(result AS CHAR)) IN ('Pending', 'Won', 'Lost', 'Cancelled')
                        THEN TRIM(CAST(result AS CHAR))
                    ELSE 'Pending'
                END
                WHERE id = :tid
            """), params)
            db.execute(sa_text("""
                UPDATE tenders
                SET tech_bid_eligible = CASE
                    WHEN CAST(tech_bid_eligible AS CHAR) IN ('1', 'true', 'TRUE', 'Eligible') THEN 'Eligible'
                    WHEN CAST(tech_bid_eligible AS CHAR) IN ('0', 'false', 'FALSE', 'Not Eligible', '') THEN 'Not Eligible'
                    ELSE 'Not Evaluated'
                END
                WHERE id = :tid
            """), params)
        else:
            db.execute(sa_text("""
                UPDATE tenders
                SET source_portal = CASE
                    WHEN source_portal IS NULL OR TRIM(CAST(source_portal AS CHAR)) = '' THEN 'Other'
                    WHEN LOWER(TRIM(CAST(source_portal AS CHAR))) = 'gem' THEN 'GeM'
                    WHEN TRIM(CAST(source_portal AS CHAR)) IN ('IREPS', 'GeM', 'CPP', 'CPPP', 'NIC', 'Direct', 'Other')
                        THEN TRIM(CAST(source_portal AS CHAR))
                    ELSE 'Other'
                END
                WHERE source_portal IS NULL
                   OR TRIM(CAST(source_portal AS CHAR)) = ''
                   OR LOWER(TRIM(CAST(source_portal AS CHAR))) = 'gem'
                   OR TRIM(CAST(source_portal AS CHAR)) NOT IN ('IREPS', 'GeM', 'CPP', 'CPPP', 'NIC', 'Direct', 'Other')
            """))
            db.execute(sa_text("""
                UPDATE tenders
                SET tender_status = CASE
                    WHEN tender_status IS NULL OR TRIM(CAST(tender_status AS CHAR)) = '' THEN 'Aligned'
                    WHEN TRIM(CAST(tender_status AS CHAR)) IN ('Aligned', 'Evaluation', 'Submitted', 'Pre-Bid', 'Reverse Auction', 'Closed')
                        THEN TRIM(CAST(tender_status AS CHAR))
                    ELSE 'Aligned'
                END
                WHERE tender_status IS NULL
                   OR TRIM(CAST(tender_status AS CHAR)) = ''
                   OR TRIM(CAST(tender_status AS CHAR)) NOT IN ('Aligned', 'Evaluation', 'Submitted', 'Pre-Bid', 'Reverse Auction', 'Closed')
            """))
            db.execute(sa_text("""
                UPDATE tenders
                SET result = CASE
                    WHEN result IS NULL OR TRIM(CAST(result AS CHAR)) = '' THEN 'Pending'
                    WHEN TRIM(CAST(result AS CHAR)) IN ('Pending', 'Won', 'Lost', 'Cancelled')
                        THEN TRIM(CAST(result AS CHAR))
                    ELSE 'Pending'
                END
                WHERE result IS NULL
                   OR TRIM(CAST(result AS CHAR)) = ''
                   OR TRIM(CAST(result AS CHAR)) NOT IN ('Pending', 'Won', 'Lost', 'Cancelled')
            """))
            db.execute(sa_text("""
                UPDATE tenders
                SET tech_bid_eligible = CASE
                    WHEN CAST(tech_bid_eligible AS CHAR) IN ('1', 'true', 'TRUE', 'Eligible') THEN 'Eligible'
                    WHEN CAST(tech_bid_eligible AS CHAR) IN ('0', 'false', 'FALSE', 'Not Eligible', '') THEN 'Not Eligible'
                    ELSE 'Not Evaluated'
                END
                WHERE tech_bid_eligible IS NULL
                   OR CAST(tech_bid_eligible AS CHAR) NOT IN ('Eligible', 'Not Eligible', 'Not Evaluated')
            """))

        db.commit()
    except Exception as e:
        logger.warning(f"tender enum sanitize failed: {e}")
        db.rollback()

ALL_ROLES        = PRIVILEGED_ROLES + ('manager', 'vp', 'sales')

DOC_TYPES   = ('Tender Document', 'BOQ', 'Workings', 'Corrigendum', 'OEM Document', 'Other')
WORK_TYPES  = ('Digging', 'Trenching', 'Cable Laying', 'Pipe Laying', 'Erection',
               'Testing & Commissioning', 'Civil Work', 'Signalling', 'OHE Work',
               'Track Work', 'Dismantling', 'Other')
WORK_UNITS  = ('RMT', 'SQM', 'CUM', 'NOS', 'LOT', 'SET', 'KG', 'MT', 'KM')
PORTAL_LIST = ('IREPS', 'GeM', 'CPP', 'CPPP', 'NIC', 'Direct', 'Other')
TENDER_STATUSES = ('Aligned', 'Evaluation', 'Submitted', 'Pre-Bid', 'Reverse Auction', 'Closed')


# ─── Notification & Log helpers ────────────────────────────────────────────────

def _notify(db, user_id, title, message, module, record_id, action):
    """Upsert a notification — if one already exists for this
    (user_id, module, record_id, action) key just reset is_read=0
    so the approver gets re-alerted without hitting the unique constraint."""
    try:
        existing = db.query(Notification).filter_by(
            user_id=user_id, module=module, record_id=record_id, action=action
        ).first()
        if existing:
            existing.is_read  = False
            existing.title    = title
            existing.message  = message
        else:
            db.add(Notification(
                user_id=user_id, title=title, message=message,
                module=module, record_id=record_id, action=action,
            ))
    except Exception as e:
        logger.warning(f"_notify failed: {e}")


def _log(db, user_id, record_id, action, description, icon='📋', color='#EFF6FF'):
    try:
        db.add(ActivityLog(
            user_id=user_id, module='tenders', record_id=record_id,
            action=action, description=description, icon=icon, color=color,
        ))
    except Exception as e:
        logger.warning(f"_log failed: {e}")


# ─── Upload helper ──────────────────────────────────────────────────────────────
# FIX A: uses settings.MEDIA_ROOT (now defined in config.py)

def _save_upload(file: UploadFile, subfolder: str = "tenders", contents: bytes | None = None) -> str:
    """
    Save an uploaded file to disk.
    Pass `contents` if you've already awaited file.read() in the async route —
    this avoids the sync/async mismatch where file.file.read() returns empty bytes.
    """
    upload_dir = os.path.join(os.path.abspath(settings.MEDIA_ROOT), subfolder)
    os.makedirs(upload_dir, exist_ok=True)
    ext      = os.path.splitext(file.filename)[1] if file.filename else ""
    filename = f"{uuid.uuid4().hex}{ext}"
    path     = os.path.join(upload_dir, filename)
    data     = contents if contents is not None else file.file.read()

    logger.info(f"_save_upload: MEDIA_ROOT={settings.MEDIA_ROOT!r}")
    logger.info(f"_save_upload: upload_dir={upload_dir!r}  exists={os.path.exists(upload_dir)}")
    logger.info(f"_save_upload: filename={filename!r}  data_len={len(data) if data else 0}")

    if not data:
        raise HTTPException(400, f"Uploaded file is empty or could not be read: {file.filename}")
    with open(path, "wb") as f:
        f.write(data)

    logger.info(f"_save_upload: written to {path!r}  file_exists={os.path.exists(path)}")
    return f"/media/{subfolder}/{filename}"


# ─── Pydantic schemas ──────────────────────────────────────────────────────────

class OEMIn(BaseModel):
    oem_id: Optional[int]   = None
    oem_name: str           = ""
    authorization_num: str  = ""
    is_preferred: bool      = False

class ProductIn(BaseModel):
    product_id: Optional[int]  = None
    product_name: str          = ""
    quantity: float            = 1
    unit_price: float          = 0
    gst_percent: float         = 0
    oem_authorization: str     = ""
    is_works_item: bool        = False
    work_type: str             = ""
    work_description: str      = ""
    work_unit: str             = "RMT"
    work_unit_rate: float      = 0
    is_final_boq: bool         = False
    oems: List[OEMIn]          = []
    oem_id: Optional[int]      = None
    oem_name: str              = ""
    authorization_num: str     = ""
    total_price: float         = 0

class FinalBOQIn(BaseModel):
    product_id: Optional[int] = None
    product_name: str         = ""
    oem_id: Optional[int]     = None
    oem_name: str             = ""
    authorization_num: str    = ""
    quantity: float           = 1
    unit_price: float         = 0
    gst_percent: float        = 0
    total_price: float        = 0
    is_works_item: bool       = False
    work_type: str            = ""
    work_description: str     = ""
    work_unit: str            = "RMT"
    work_unit_rate: float     = 0

class TechBidItemIn(BaseModel):
    product_id: Optional[int] = None
    product_name: str         = ""
    oem_id: Optional[int]     = None
    oem_name: str             = ""
    authorization_ref: str    = ""
    sort_order: int           = 0

class TechBidderIn(BaseModel):
    id: Optional[int]    = None
    bidder_name: str     = ""
    bidder_type: str     = ""
    sort_order: int      = 0
    items: List[TechBidItemIn] = []

class LossAnalysisIn(BaseModel):
    our_position: str             = ""
    competitor_name: str          = ""
    competitor_amount: float      = 0
    our_bid_amount: float         = 0
    l1_company: str               = ""
    l1_amount: float              = 0
    l2_company: str               = ""
    l2_amount: float              = 0
    l3_company: str               = ""
    l3_amount: float              = 0
    loss_reason: str              = ""

class TenderUpsertIn(BaseModel):
    # Step 1
    customer_id: Optional[int]    = None
    customer_name: str            = ""
    tender_title: str             = ""
    portal_ref_number: str        = ""
    est_value: Optional[float]    = None
    source_id: Optional[int]      = None
    source_portal: str            = ""
    tender_status: str            = "Aligned"
    published_date: Optional[str] = None
    pre_bid_date: Optional[str]   = None
    submission_date: Optional[str]= None
    assigned_to: Optional[int]    = None
    notes: str                    = ""
    products: List[ProductIn]     = []
    # Step 2
    tender_fee_required: bool          = False
    tender_fee_amount: Optional[float] = None
    tender_fee_method: str             = ""
    tender_fee_bg_days: Optional[int]  = None
    tender_fee_payment_details: str    = ""
    emd_required: bool                 = False
    emd_amount: Optional[float]        = None
    emd_payment_method: str            = ""
    emd_bank_name: str                 = ""
    emd_bg_days: Optional[int]         = None
    emd_reference: str                 = ""
    pbg_required: bool                 = False
    pbg_amount: Optional[float]        = None
    pbg_bg_days: Optional[int]         = None
    pbg_reference: str                 = ""
    split_order: bool                  = False
    reverse_auction: bool              = False
    bid_tracking: str                  = ""
    # Step 4
    tech_bid_eligible: Optional[bool]  = None
    tech_bid_bidders: List[TechBidderIn] = []
    # Step 5
    bid_amount: Optional[float]                = None
    result: str                                = "Pending"
    result_date: Optional[str]                 = None
    reverse_auction_final_bid: Optional[float] = None
    loss_analysis: Optional[LossAnalysisIn]    = None
    # Step 7 — PO Details
    po_num:          Optional[str]   = None
    po_date:         Optional[str]   = None
    po_value:        Optional[float] = None
    wrnty_mth:       Optional[int]   = None
    no_of_consignee: Optional[int]   = None
    wrk_order_id:    Optional[str]   = None
    wo_value:        Optional[float] = None
    dlvry_date:      Optional[str]   = None
    instln_date:     Optional[str]   = None
    site_loc:        Optional[str]   = None
    site_eng:        Optional[str]   = None
    eng_phone:       Optional[str]   = None
    advance:         Optional[str]   = None
    retention:       Optional[str]   = None
    pmnt_terms:      Optional[str]   = None
    sow:             Optional[str]   = None
    # Workflow
    submit_step: int = 0


# ─── Helper: get approver for role level ───────────────────────────────────────

def _find_approver(db: Session, assignee_id: int, level: str) -> Optional[int]:
    if level == 'manager':
        user = db.query(User).filter(User.id == assignee_id).first()
        if user and user.reporting_manager_id:
            return user.reporting_manager_id
        mgr = db.query(User).filter(
            User.role.in_(['manager', 'vp', 'admin', 'ceo']),
            User.is_active == True,
        ).first()
        return mgr.id if mgr else None
    else:  # ceo — priority order
        for role in ('ceo', 'admin'):
            u = db.query(User).filter(User.role == role, User.is_active == True).first()
            if u:
                return u.id
        return None


def _cancel_pending_approvals(db: Session, tender_id: int, action: str):
    db.query(Approval).filter(
        Approval.module == 'tender',
        Approval.record_id == tender_id,
        Approval.action == action,
        Approval.status == 'pending',
    ).update({'status': 'rejected', 'decision_notes': 'Superseded by resubmission'})


# ─── Tech-bid DB↔Python conversion ────────────────────────────────────────────

def _normalize_tech_bid(val) -> Optional[str]:
    # Accept bool True/False, int 1/0, string "true"/"false"/"1"/"0"
    if val is None:
        return 'Not Evaluated'
    if isinstance(val, bool):
        return 'Eligible' if val else 'Not Eligible'
    if isinstance(val, int):
        return 'Eligible' if val else 'Not Eligible'
    if isinstance(val, str):
        if val.lower() in ('true', '1', 'eligible'):
            return 'Eligible'
        if val.lower() in ('false', '0', 'not eligible'):
            return 'Not Eligible'
    return 'Not Evaluated'


def _denormalize_tech_bid(db_val: Optional[str]):
    if db_val == 'Eligible':
        return True
    if db_val == 'Not Eligible':
        return False
    # Handle corrupt legacy values ('0', '1', integers stored as string)
    if db_val in ('1', 1):
        return True
    if db_val in ('0', 0):
        return False
    return None


# ─── Serialize tender ──────────────────────────────────────────────────────────

def _serialize_tender(t: Tender, db: Session) -> dict:
    products       = db.query(TenderProduct).filter(
        TenderProduct.tender_id == t.id, TenderProduct.is_final_boq == False
    ).all()
    final_products = db.query(TenderProduct).filter(
        TenderProduct.tender_id == t.id, TenderProduct.is_final_boq == True
    ).all()
    docs           = db.query(TenderDocument).filter(TenderDocument.tender_id == t.id).all()
    bidders        = db.query(TenderTechBidBidder).filter(
        TenderTechBidBidder.tender_id == t.id
    ).order_by(TenderTechBidBidder.sort_order).all()
    loss_analysis  = db.query(TenderLossAnalysis).filter(
        TenderLossAnalysis.tender_id == t.id
    ).first()

    def _ser_product(p: TenderProduct):
        oems = db.query(TenderProductOEM).filter(
            TenderProductOEM.tender_product_id == p.id
        ).all()
        return {
            'id': p.id,
            'product_id': p.product_id,
            'product_name': p.product_name,
            'quantity': float(p.quantity or 0),
            'unit_price': float(p.unit_price or 0),
            'gst_percent': float(p.gst_percent or 0),
            'oem_authorization': p.oem_authorization,
            'is_works_item': bool(p.is_works_item),
            'work_type': p.work_type,
            'work_description': p.work_description,
            'work_unit': p.work_unit,
            'work_unit_rate': float(p.work_unit_rate or 0),
            'is_final_boq': bool(p.is_final_boq),
            'oem_id': p.oem_id,
            'oem_name': p.oem_name,
            'authorization_num': p.authorization_num,
            'total_price': float(p.total_price or 0),
            'oems': [
                {
                    'id': o.id,
                    'oem_id': o.oem_id,
                    'oem_name': o.oem_name,
                    'authorization_num': o.authorization_num,
                    'is_preferred': bool(o.is_preferred),
                } for o in oems
            ],
        }

    def _ser_bidder(b: TenderTechBidBidder):
        items = db.query(TenderTechBidItem).filter(
            TenderTechBidItem.bidder_id == b.id
        ).order_by(TenderTechBidItem.sort_order).all()
        return {
            'id': b.id,
            'bidder_name': b.bidder_name,
            'bidder_type': b.bidder_type,
            'sort_order': b.sort_order,
            'items': [{
                'id': i.id,
                'product_id': i.product_id,
                'product_name': i.product_name,
                'oem_id': i.oem_id,
                'oem_name': i.oem_name,
                'authorization_ref': i.authorization_ref,
                'sort_order': i.sort_order,
            } for i in items],
        }

    assigned_user = (
        db.query(User).filter(User.id == t.assigned_to).first() if t.assigned_to else None
    )

    return {
        'id': t.id,
        'tender_num': t.tender_num,
        'customer_id': t.customer_id,
        'customer_name': t.customer_name,
        'tender_title': t.tender_title,
        'portal_ref_number': t.portal_ref_number,
        'est_value': float(t.est_value) if t.est_value else None,
        'source_id': t.source_id,
        'source_portal': t.source_portal,
        'tender_status': t.tender_status,
        'published_date': str(t.published_date) if t.published_date else None,
        'pre_bid_date': str(t.pre_bid_date) if t.pre_bid_date else None,
        'submission_date': str(t.submission_date) if t.submission_date else None,
        'assigned_to': t.assigned_to,
        'assigned_to_name': assigned_user.full_name if assigned_user else '',
        'notes': t.notes,
        'rfp_document': t.rfp_document,
        'products': [_ser_product(p) for p in products] + [_ser_product(p) for p in final_products],
        'tender_fee_required': bool(t.tender_fee_required),
        'tender_fee_amount': float(t.tender_fee_amount) if t.tender_fee_amount else None,
        'tender_fee_method': t.tender_fee_method,
        'tender_fee_bg_days': t.tender_fee_bg_days,
        'tender_fee_payment_details': t.tender_fee_payment_details,
        'emd_required': bool(t.emd_required),
        'emd_amount': float(t.emd_amount) if t.emd_amount else None,
        'emd_payment_method': t.emd_payment_method,
        'emd_bank_name': t.emd_bank_name,
        'emd_bg_days': t.emd_bg_days,
        'emd_reference': t.emd_reference,
        'pbg_required': bool(getattr(t, 'pbg_required', False)),
        'pbg_amount': float(t.pbg_amount) if getattr(t, 'pbg_amount', None) else None,
        'pbg_bg_days': getattr(t, 'pbg_bg_days', None),
        'pbg_reference': getattr(t, 'pbg_reference', '') or '',
        'split_order': bool(t.split_order),
        'reverse_auction': bool(t.reverse_auction),
        'bid_tracking': getattr(t, 'bid_tracking', '') or '',
        'final_products': [_ser_product(p) for p in final_products],
        'workings_document': t.workings_document,
        'corrigendum_document': t.corrigendum_document,
        'tech_bid_eligible': _denormalize_tech_bid(t.tech_bid_eligible),
        'tech_bid_bidders': [_ser_bidder(b) for b in bidders],
        'bid_amount': float(t.bid_amount) if t.bid_amount else None,
        'result': t.result,
        'result_date': str(t.result_date) if t.result_date else None,
        'reverse_auction_final_bid': float(t.reverse_auction_final_bid) if t.reverse_auction_final_bid else None,
        'loss_analysis': {
            'id': loss_analysis.id,
            'our_position': loss_analysis.our_position,
            'competitor_name': loss_analysis.competitor_name,
            'competitor_amount': float(loss_analysis.competitor_amount or 0),
            'our_bid_amount': float(loss_analysis.our_bid_amount or 0),
            'l1_company': loss_analysis.l1_company,
            'l1_amount': float(loss_analysis.l1_amount or 0),
            'l2_company': loss_analysis.l2_company,
            'l2_amount': float(loss_analysis.l2_amount or 0),
            'l3_company': loss_analysis.l3_company,
            'l3_amount': float(loss_analysis.l3_amount or 0),
            'loss_reason': getattr(loss_analysis, 'loss_reason', '') or '',
        } if loss_analysis else None,
        'current_step': t.current_step or 1,
        'workflow_status': t.workflow_status or 'draft',
        'step2_approval_id': t.step2_approval_id,
        'step3_approval_id': t.step3_approval_id,
        'listed_in_accounts': bool(t.listed_in_accounts),
        'documents': [{
            'id': d.id,
            'doc_type': d.doc_type,
            'file_name': d.file_name,
            'file_url': d.file_url,
            'file_size_kb': getattr(d, 'file_size_kb', None),
            'uploaded_by': d.uploaded_by,
            'created_at': str(d.created_at) if d.created_at else None,
        } for d in docs],
        'po_num':           t.po_num,
        'po_date':          str(t.po_date) if t.po_date else None,
        'po_value':         float(t.po_value) if t.po_value else None,
        'wrnty_mth':        t.wrnty_mth,
        'no_of_consignee':  getattr(t, 'no_of_consignee', None),
        'po_doc':           t.po_doc,
        'wrk_order_id':     getattr(t, 'wrk_order_id', None),
        'wo_value':         float(t.wo_value) if getattr(t, 'wo_value', None) else None,
        'dlvry_date':       str(t.dlvry_date) if getattr(t, 'dlvry_date', None) else None,
        'instln_date':      str(t.instln_date) if getattr(t, 'instln_date', None) else None,
        'site_loc':         getattr(t, 'site_loc', None),
        'site_eng':         getattr(t, 'site_eng', None),
        'eng_phone':        getattr(t, 'eng_phone', None),
        'advance':          getattr(t, 'advance', None),
        'retention':        getattr(t, 'retention', None),
        'pmnt_terms':       getattr(t, 'pmnt_terms', None),
        'sow':              getattr(t, 'sow', None),
        'created_at': str(t.created_at) if t.created_at else None,
        'updated_at': str(t.updated_at) if t.updated_at else None,
    }


# ─── GET / ─────────────────────────────────────────────────────────────────────
@router.get("/")
def list_tenders(
    page: int = 1, per_page: int = 20,
    search: Optional[str] = None,
    status: Optional[str] = None,
    assigned_to: Optional[int] = None,
    customer_id: Optional[int] = None,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_tender_schema(db)
    _sanitize_tender_enums(db)

    q = db.query(Tender).filter(Tender.is_deleted == False)

    if current_user.role == 'sales':
        q = q.filter(Tender.assigned_to == current_user.id)
    elif current_user.role in ('manager', 'vp'):
        team_ids = [
            u.id for u in db.query(User).filter(
                User.reporting_manager_id == current_user.id
            ).all()
        ]
        team_ids.append(current_user.id)
        q = q.filter(Tender.assigned_to.in_(team_ids))

    if search:
        q = q.filter(
            Tender.customer_name.ilike(f'%{search}%') |
            Tender.tender_title.ilike(f'%{search}%') |
            Tender.portal_ref_number.ilike(f'%{search}%')
        )
    if status:
        q = q.filter(Tender.tender_status == status)
    if assigned_to is not None:
        q = q.filter(Tender.assigned_to == assigned_to)
    if customer_id is not None:
        q = q.filter(Tender.customer_id == customer_id)

    total = q.count()

    id_rows = (
        q.order_by(Tender.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .with_entities(Tender.id)
        .all()
    )
    tender_ids = [r[0] for r in id_rows]

    items = []
    for tid in tender_ids:
        try:
            t = db.query(Tender).filter(Tender.id == tid).first()
            if t:
                items.append(_serialize_tender(t, db))
        except Exception as e:
            logger.error(f"Failed to serialize tender {tid}: {e}")
            continue

    return {
        'items': items,
        'total': total,
        'page': page,
        'per_page': per_page,
    }


@router.get("/badge")
def get_tender_badge(
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    layout        = dict(cu.dashboard_layout or {})
    last_seen_str = layout.get("tenders_last_seen_at")
    if not last_seen_str:
        layout["tenders_last_seen_at"] = now_ist().isoformat()
        cu.dashboard_layout = layout
        db.commit()
        return {"count": 0}
    try:
        last_seen = datetime.fromisoformat(last_seen_str)
    except ValueError:
        return {"count": 0}
    count = db.query(func.count(Tender.id)).filter(
        Tender.created_at  > last_seen,
        Tender.is_deleted == False,
    ).scalar() or 0
    return {"count": count}


@router.post("/mark-seen")
def mark_tenders_seen(
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    layout = dict(cu.dashboard_layout or {})
    layout["tenders_last_seen_at"] = now_ist().isoformat()
    cu.dashboard_layout = layout
    db.commit()
    return {"ok": True}


@router.get("/dropdown")
def tender_dropdown(
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    """Return a lightweight list of all active tenders for select dropdowns."""
    q = db.query(Tender).filter(Tender.is_deleted == False)
    if cu.role == 'sales':
        q = q.filter(Tender.assigned_to == cu.id)
    elif cu.role in ('manager', 'vp'):
        team_ids = [
            u.id for u in db.query(User).filter(
                User.reporting_manager_id == cu.id
            ).all()
        ]
        team_ids.append(cu.id)
        q = q.filter(Tender.assigned_to.in_(team_ids))
    tenders = q.order_by(Tender.created_at.desc()).all()
    return [
        {
            "id": t.id,
            "tender_num": t.tender_num or "",
            "tender_title": t.tender_title or "",
            "customer_name": t.customer_name or "",
            "tender_status": t.tender_status or "",
        }
        for t in tenders
    ]


@router.get("/{tender_id}")
def get_tender(
    tender_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_tender_schema(db)
    _sanitize_tender_enums(db, tender_id)

    t = db.query(Tender).filter(Tender.id == tender_id, Tender.is_deleted == False).first()
    if not t:
        raise HTTPException(404, "Tender not found")
    return _serialize_tender(t, db)

# ─── POST / (Create) ──────────────────────────────────────────────────────────

@router.post("/")
def create_tender(
    payload: TenderUpsertIn,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_tender_schema(db)
    tender_num = f"TND-{now_ist().strftime('%Y%m')}-{uuid.uuid4().hex[:6].upper()}"
    t = Tender(
        tender_num         = tender_num,
        customer_id        = payload.customer_id,
        customer_name      = payload.customer_name,
        tender_title       = payload.tender_title,
        portal_ref_number  = payload.portal_ref_number,
        est_value          = payload.est_value,
        source_id          = payload.source_id,
        source_portal      = payload.source_portal or 'Other',
        tender_status      = payload.tender_status or 'Aligned',
        published_date     = payload.published_date,
        pre_bid_date       = payload.pre_bid_date,
        submission_date    = payload.submission_date,
        assigned_to        = payload.assigned_to or current_user.id,
        notes              = payload.notes,
        created_by         = current_user.id,
        workflow_status    = 'draft',
        current_step       = 1,
        listed_in_accounts = False,
    )
    db.add(t)
    db.flush()
    initial_products = [p for p in payload.products if not p.is_final_boq]
    _upsert_products(db, t.id, initial_products, is_final=False)
    _log(db, current_user.id, t.id, 'created', f"Tender '{t.tender_title}' created", '🏗️', '#EFF6FF')
    db.commit()
    db.refresh(t)
    return _serialize_tender(t, db)


# ─── PUT /{tender_id} — unified update ────────────────────────────────────────
@router.put("/{tender_id}")
def update_tender(
    tender_id: int,
    payload: TenderUpsertIn,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    import traceback as _tb

    submit_step = payload.submit_step or 0

    # ── DEBUG ENTRY ──────────────────────────────────────────────────────────
    print(f"\n{'='*60}")
    print(f"[TENDER UPDATE] id={tender_id} submit_step={submit_step} role={current_user.role}")
    print(f"  po_num={payload.po_num!r} po_value={payload.po_value!r} wrk_order_id={payload.wrk_order_id!r}")
    print(f"{'='*60}")

    # ── _get_or_404 wraps _ensure_tender_schema — log if it rolls back ───────
    try:
        t = _get_or_404(db, tender_id)
    except Exception as e:
        print(f"  [FAIL] _get_or_404 raised: {e}")
        print(_tb.format_exc())
        raise

    print(f"  [OK] tender loaded: step={t.current_step} workflow={t.workflow_status} result={t.result!r}")

    # ── Step-1 always ────────────────────────────────────────────────────────
    t.customer_id       = payload.customer_id
    t.customer_name     = payload.customer_name
    t.tender_title      = payload.tender_title
    t.portal_ref_number = payload.portal_ref_number
    t.est_value         = payload.est_value
    t.source_id         = payload.source_id
    t.source_portal     = payload.source_portal or t.source_portal
    t.tender_status     = payload.tender_status or t.tender_status
    t.published_date    = payload.published_date
    t.pre_bid_date      = payload.pre_bid_date
    t.submission_date   = payload.submission_date
    t.assigned_to       = payload.assigned_to or t.assigned_to
    t.notes             = payload.notes
    t.updated_at        = now_ist()

    initial_products = [p for p in payload.products if not p.is_final_boq]
    if initial_products:
        _upsert_products(db, t.id, initial_products, is_final=False)

    # ── Step 2 — kept >= 2 so EMD/fee fields persist on higher steps ─────────
    if submit_step >= 2:
        print(f"  [BLOCK >= 2] entered")
        if submit_step == 2:
            try:
                _check_step_access(t, current_user, step=2)
            except Exception as e:
                print(f"  [FAIL] step2 _check_step_access: {e}")
                raise
        t.tender_fee_required        = payload.tender_fee_required
        t.tender_fee_amount          = payload.tender_fee_amount
        t.tender_fee_method          = payload.tender_fee_method
        t.tender_fee_bg_days         = payload.tender_fee_bg_days
        t.tender_fee_payment_details = payload.tender_fee_payment_details
        t.emd_required               = payload.emd_required
        t.emd_amount                 = payload.emd_amount
        t.emd_payment_method         = payload.emd_payment_method
        t.emd_bank_name              = payload.emd_bank_name
        t.emd_bg_days                = payload.emd_bg_days
        t.emd_reference              = payload.emd_reference
        t.pbg_required               = payload.pbg_required
        t.pbg_amount                 = payload.pbg_amount
        t.pbg_bg_days                = payload.pbg_bg_days
        t.pbg_reference              = payload.pbg_reference
        t.split_order                = payload.split_order
        t.reverse_auction            = payload.reverse_auction
        if hasattr(t, 'bid_tracking'):
            t.bid_tracking = payload.bid_tracking
        if t.current_step < 2:
            t.current_step = 2
        print(f"  [BLOCK >= 2] done")

    # ── Step 3 — ONLY when submit_step == 3 ──────────────────────────────────
    if submit_step == 3:
        print(f"  [BLOCK == 3] entered")
        if t.workflow_status not in ('active', 'step3_pending', 'step3_active') \
           and current_user.role not in PRIVILEGED_ROLES + ('manager', 'vp'):
            print(f"  [FAIL] step3 workflow locked: {t.workflow_status!r}")
            raise HTTPException(403, "Step 3 is locked until Step 2 is approved by CEO")
        try:
            _check_step_access(t, current_user, step=3)
        except Exception as e:
            print(f"  [FAIL] step3 _check_step_access: {e}")
            raise

        final_products = [p for p in payload.products if p.is_final_boq]
        if final_products:
            db.query(TenderProduct).filter(
                TenderProduct.tender_id == t.id,
                TenderProduct.is_final_boq == True,
            ).delete()
            for item in final_products:
                base_rate   = (item.work_unit_rate or 0) if item.is_works_item else (item.unit_price or 0)
                total_price = item.total_price or round(
                    (item.quantity or 1) * base_rate * (1 + (item.gst_percent or 0) / 100), 2
                )
                p = TenderProduct(
                    tender_id         = t.id,
                    product_id        = item.product_id,
                    product_name      = item.product_name,
                    quantity          = item.quantity,
                    unit_price        = item.unit_price,
                    gst_percent       = item.gst_percent,
                    total_price       = total_price,
                    is_final_boq      = True,
                    is_works_item     = item.is_works_item,
                    work_type         = item.work_type,
                    work_description  = item.work_description,
                    work_unit         = item.work_unit,
                    work_unit_rate    = item.work_unit_rate,
                    oem_id            = item.oem_id,
                    oem_name          = item.oem_name,
                    authorization_num = item.authorization_num,
                )
                db.add(p)
        if t.current_step < 3:
            t.current_step = 3
        print(f"  [BLOCK == 3] done")

    # ── Step 4 — ONLY when submit_step == 4 ──────────────────────────────────
    if submit_step == 4:
        print(f"  [BLOCK == 4] entered")
        if t.workflow_status not in ('step3_active', 'active') \
           and current_user.role not in PRIVILEGED_ROLES + ('manager', 'vp'):
            print(f"  [FAIL] step4 workflow locked: {t.workflow_status!r}")
            raise HTTPException(403, "Step 4 is locked until Step 3 is approved")
        try:
            _check_step_access(t, current_user, step=4)
        except Exception as e:
            print(f"  [FAIL] step4 _check_step_access: {e}")
            raise
        db.execute(sa_text(
            "UPDATE tenders SET tech_bid_eligible = CASE "
            "  WHEN tech_bid_eligible IN ('0','') THEN 'Not Eligible' "
            "  WHEN tech_bid_eligible = '1' THEN 'Eligible' "
            "  ELSE tech_bid_eligible END "
            "WHERE id = :tid AND tech_bid_eligible NOT IN "
            "('Eligible','Not Eligible','Not Evaluated') OR tech_bid_eligible IS NULL"
        ), {'tid': t.id})
        t.tech_bid_eligible = _normalize_tech_bid(payload.tech_bid_eligible)
        _upsert_bidders(db, t.id, payload.tech_bid_bidders)
        if t.current_step < 4:
            t.current_step = 4
        if payload.tech_bid_eligible is False or _normalize_tech_bid(payload.tech_bid_eligible) == 'Not Eligible':
            t.result        = 'Lost'
            t.tender_status = 'Closed'
            t.updated_at    = now_ist()
            _log(db, current_user.id, t.id, 'tech_bid_not_eligible',
                 'Tech bid Not Eligible — tender marked as Lost/Closed', '🚫', '#FFF5F5')
        print(f"  [BLOCK == 4] done")

    # ── Step 5 — ONLY when submit_step == 5 ──────────────────────────────────
    if submit_step == 5:
        print(f"  [BLOCK == 5] entered")
        try:
            _check_step_access(t, current_user, step=5)
        except Exception as e:
            print(f"  [FAIL] step5 _check_step_access: {e}")
            raise
        t.bid_amount                = payload.bid_amount
        t.result                    = payload.result
        t.result_date               = payload.result_date
        t.reverse_auction_final_bid = payload.reverse_auction_final_bid
        if payload.result == 'Lost' and payload.loss_analysis:
            _upsert_loss_analysis(db, t.id, payload.loss_analysis)
        if t.current_step < 5:
            t.current_step = 5
        print(f"  [BLOCK == 5] done  result={t.result!r}")

    # ── Step 6 — ONLY when submit_step == 6 ──────────────────────────────────
    if submit_step == 6:
        print(f"  [BLOCK == 6] entered — writing PO fields")
        t.po_num          = payload.po_num
        t.po_date         = payload.po_date
        t.po_value        = payload.po_value
        t.wrnty_mth       = payload.wrnty_mth
        t.no_of_consignee = payload.no_of_consignee
        t.wrk_order_id    = payload.wrk_order_id
        t.wo_value        = payload.wo_value
        t.dlvry_date      = payload.dlvry_date
        t.instln_date     = payload.instln_date
        t.site_loc        = payload.site_loc
        t.site_eng        = payload.site_eng
        t.eng_phone       = payload.eng_phone
        t.advance         = payload.advance
        t.retention       = payload.retention
        t.pmnt_terms      = payload.pmnt_terms
        t.sow             = payload.sow
        if t.current_step < 6:
            t.current_step = 6
        print(f"  [BLOCK == 6] po_num={t.po_num!r} po_value={t.po_value!r} wrk_order_id={t.wrk_order_id!r}")
        try:
            db.flush()
            print(f"  [BLOCK == 6] flush OK")
        except Exception as e:
            print(f"  [FAIL] step6 flush: {e}")
            print(_tb.format_exc())
            raise

    # ── Approval trigger for Step 2 ───────────────────────────────────────────
    if submit_step == 2:
        print(f"  [APPROVAL] step 2")
        if t.workflow_status in ('pending_manager', 'pending_ceo'):
            db.commit()
            return _serialize_tender(t, db)

        allowed_for_step2 = ('draft', 'active', 'rejected')
        if t.workflow_status not in allowed_for_step2 and not isManagerOrAbove(current_user):
            raise HTTPException(400, "Cannot re-submit Step 2 in current workflow state")

        _cancel_pending_approvals(db, t.id, 'tender_step2_manager')
        _cancel_pending_approvals(db, t.id, 'tender_step2_ceo')
        db.flush()

        if current_user.role in ('ceo', 'admin'):
            t.workflow_status    = 'active'
            t.listed_in_accounts = True
            _log(db, current_user.id, t.id, 'step2_auto_approved',
                 'Step 2 auto-approved (submitted by CEO/Admin)', '✅', '#D1FAE5')
        elif current_user.role in ('manager', 'vp'):
            ceo_id = _find_approver(db, t.assigned_to or current_user.id, 'ceo')
            if not ceo_id:
                raise HTTPException(400, "No CEO/admin user found for approval")
            approval = Approval(
                module='tender', action='tender_step2_ceo',
                record_id=t.id,
                record_ref=f"Tender: {t.tender_title or t.portal_ref_number}",
                requested_by=current_user.id, requested_to=ceo_id,
                status='pending',
                request_notes="Step 2 submitted by Manager — direct CEO approval",
            )
            db.add(approval)
            db.flush()
            t.step2_approval_id = approval.id
            t.workflow_status = 'pending_ceo'
            _log(db, current_user.id, t.id, 'step2_submitted',
                 'Step 2 submitted directly for CEO approval (Manager)', '🔔', '#FFF7ED')
        else:
            mgr_id = _find_approver(db, t.assigned_to or current_user.id, 'manager')
            if not mgr_id:
                raise HTTPException(400, "No manager found to send approval to")
            approval = create_approval_request(
                db=db, module='tender', action='tender_step2_manager',
                record_id=t.id,
                record_ref=f"Tender: {t.tender_title or t.portal_ref_number}",
                requester=current_user,
                request_notes="Step 2 (Tender Details) submitted for approval",
            )
            if approval:
                t.step2_approval_id = approval.id
            t.workflow_status = 'pending_manager'
            _log(db, current_user.id, t.id, 'step2_submitted',
                 'Step 2 submitted for manager approval', '🔔', '#FFF7ED')

    # ── Approval trigger for Step 3 ───────────────────────────────────────────
    elif submit_step == 3:
        print(f"  [APPROVAL] step 3")
        if t.workflow_status in ('step3_pending', 'step3_active'):
            db.commit()
            return _serialize_tender(t, db)

        _cancel_pending_approvals(db, t.id, 'tender_step3_manager')
        _cancel_pending_approvals(db, t.id, 'tender_step3_ceo')
        db.flush()

        if current_user.role in ('ceo', 'admin'):
            t.workflow_status    = 'step3_active'
            t.tender_status      = 'Submitted'
            t.listed_in_accounts = True
            if hasattr(t, 'step3_approved_at'):
                t.step3_approved_at = now_ist()
            _log(db, current_user.id, t.id, 'step3_auto_approved',
                 'Step 3 auto-approved (submitted by CEO/Admin) — status Submitted', '✅', '#D1FAE5')
        elif current_user.role in ('manager', 'vp'):
            ceo_id = _find_approver(db, t.assigned_to or current_user.id, 'ceo')
            if not ceo_id:
                raise HTTPException(400, "No CEO/admin user found for approval")
            approval = Approval(
                module='tender', action='tender_step3_ceo',
                record_id=t.id,
                record_ref=f"Tender: {t.tender_title or t.portal_ref_number}",
                requested_by=current_user.id, requested_to=ceo_id,
                status='pending',
                request_notes="Step 3 (Workings) submitted by Manager — direct CEO approval",
            )
            db.add(approval)
            db.flush()
            t.step3_approval_id = approval.id
            t.workflow_status = 'step3_pending'
            _log(db, current_user.id, t.id, 'step3_submitted',
                 'Step 3 submitted directly for CEO approval (Manager)', '🔔', '#F3E8FF')
        else:
            mgr_id = _find_approver(db, t.assigned_to or current_user.id, 'manager')
            if not mgr_id:
                raise HTTPException(400, "No manager found to send approval to")
            approval = create_approval_request(
                db=db, module='tender', action='tender_step3_manager',
                record_id=t.id,
                record_ref=f"Tender: {t.tender_title or t.portal_ref_number}",
                requester=current_user,
                request_notes="Step 3 (Workings) submitted for approval",
            )
            if approval:
                t.step3_approval_id = approval.id
            t.workflow_status = 'step3_pending'
            _log(db, current_user.id, t.id, 'step3_submitted',
                 'Step 3 submitted for manager approval', '🔔', '#F3E8FF')

    elif submit_step in (1, 0):
        _log(db, current_user.id, t.id, f'step{submit_step or 1}_saved',
             f'Step {submit_step or 1} saved', '💾', '#EFF6FF')
    elif submit_step in (4, 5, 6, 7):
        _log(db, current_user.id, t.id, f'step{submit_step}_saved',
             f'Step {submit_step} saved', '💾', '#EFF6FF')

    # ── Final commit ──────────────────────────────────────────────────────────
    print(f"  [PRE-COMMIT] po_num={t.po_num!r} po_value={t.po_value!r} current_step={t.current_step}")
    try:
        db.commit()
        print(f"  [COMMIT] success")
    except Exception as e:
        db.rollback()
        print(f"  [COMMIT FAIL] {e}")
        print(_tb.format_exc())
        raise HTTPException(500, f"Database commit failed: {str(e)}")

    _tid = t.id
    db.expunge(t)
    t = db.query(Tender).filter(Tender.id == _tid).first()
    print(f"  [VERIFY] po_num={t.po_num!r} po_value={t.po_value!r}\n{'='*60}\n")
    return _serialize_tender(t, db)

# ─── PUT /{id}/step1/rfp  (RFP document upload) ───────────────────────────────

@router.put("/{tender_id}/step1/rfp")
async def upload_rfp(
    tender_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    t = _get_or_404(db, tender_id)
    contents = await file.read()   # must await in async route before passing to sync helper
    path = _save_upload(file, contents=contents)
    t.rfp_document = path
    t.updated_at   = now_ist()
    db.add(TenderDocument(
        tender_id   = t.id,
        doc_type    = 'Tender Document',
        file_name   = file.filename,
        file_url    = path,
        uploaded_by = current_user.id,
    ))
    _log(db, current_user.id, t.id, 'rfp_uploaded',
         f"RFP document uploaded: {file.filename}", '📎', '#F0FFF4')
    db.commit()
    db.refresh(t)
    return _serialize_tender(t, db)


# ─── POST /{id}/upload-document  (generic document upload) ────────────────────

@router.post("/{tender_id}/upload-document")
async def upload_document(
    tender_id: int,
    doc_type: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    t = _get_or_404(db, tender_id)
    contents = await file.read()   # must await in async route before passing to sync helper
    size_kb  = len(contents) // 1024 if contents else None
    path     = _save_upload(file, contents=contents)

    if doc_type == 'Workings':
        t.workings_document = path
    elif doc_type == 'Corrigendum':
        t.corrigendum_document = path
    elif doc_type == 'Tender Document':
        t.rfp_document = path
    elif doc_type == 'PO Document':
        t.po_doc = path

    doc_kwargs = dict(
        tender_id  = t.id,
        doc_type   = doc_type,
        file_name  = file.filename,
        file_url   = path,
        uploaded_by = current_user.id,
    )
    if hasattr(TenderDocument, 'file_size_kb'):
        doc_kwargs['file_size_kb'] = size_kb
    db.add(TenderDocument(**doc_kwargs))
    _log(db, current_user.id, t.id, 'doc_uploaded',
         f"{doc_type} uploaded: {file.filename}", '📎', '#F0FFF4')
    db.commit()
    db.refresh(t)
    return _serialize_tender(t, db)


# ─── DELETE /{tender_id}/documents/{doc_id} ───────────────────────────────────

@router.delete("/{tender_id}/documents/{doc_id}")
def delete_document(
    tender_id: int,
    doc_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    doc = db.query(TenderDocument).filter(
        TenderDocument.id == doc_id,
        TenderDocument.tender_id == tender_id,
    ).first()
    if not doc:
        raise HTTPException(404, "Document not found")
    db.delete(doc)
    db.commit()
    return {"message": "Document deleted"}


# ─── Approval callbacks ────────────────────────────────────────────────────────

@router.post("/{tender_id}/approve-step2-manager")
def approve_step2_manager(
    tender_id: int,
    decision: str,
    notes: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role not in MANAGER_ROLES:
        raise HTTPException(403, "Not authorized")
    t = _get_or_404(db, tender_id)
    if decision == 'approved':
        ceo_id = _find_approver(db, t.assigned_to or 0, 'ceo')
        if not ceo_id:
            raise HTTPException(400, "No CEO found for escalation")
        approval = Approval(
            module='tender', action='tender_step2_ceo',
            record_id=t.id,
            record_ref=f"Tender: {t.tender_title or t.portal_ref_number}",
            requested_by=current_user.id, requested_to=ceo_id,
            status='pending',
            request_notes=f"Manager approved. {notes or ''}",
        )
        db.add(approval)
        db.flush()
        t.step2_approval_id = approval.id
        t.workflow_status   = 'pending_ceo'
        _notify(db, ceo_id, "Tender Needs CEO Approval",
                f"Manager approved Step-2 of: {t.tender_title}",
                'tender', t.id, 'approval_request')
        _log(db, current_user.id, t.id, 'step2_mgr_approved',
             'Manager approved Step 2; escalated to CEO', '✅', '#F0FFF4')
    else:
        t.workflow_status = 'rejected'
        _notify(db, t.assigned_to or 0, "Tender Step 2 Rejected",
                f"Manager rejected Step-2: {notes or ''}",
                'tender', t.id, 'rejected')
        _log(db, current_user.id, t.id, 'step2_mgr_rejected',
             f'Manager rejected Step 2: {notes}', '❌', '#FFF5F5')
    db.commit()
    db.refresh(t)
    return _serialize_tender(t, db)


@router.post("/{tender_id}/approve-step2-ceo")
def approve_step2_ceo(
    tender_id: int,
    decision: str,
    notes: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role not in PRIVILEGED_ROLES:
        raise HTTPException(403, "Not authorized")
    t = _get_or_404(db, tender_id)
    if decision == 'approved':
        t.workflow_status    = 'active'
        t.listed_in_accounts = True
        if hasattr(t, 'step2_approved_at'):
            t.step2_approved_at = now_ist()
        t.updated_at = now_ist()
        _notify(db, t.assigned_to or 0, "Tender Step 2 Approved — Proceed to Workings",
                f"CEO approved Step-2 of: {t.tender_title}",
                'tender', t.id, 'approved')
        _log(db, current_user.id, t.id, 'step2_ceo_approved',
             'CEO approved Step 2 — tender active, listed in accounts', '🎉', '#F0FFF4')
    else:
        t.workflow_status = 'rejected'
        t.updated_at = now_ist()
        _notify(db, t.assigned_to or 0, "Tender Step 2 Rejected by CEO",
                f"CEO rejected Step-2: {notes or ''}",
                'tender', t.id, 'rejected')
        _log(db, current_user.id, t.id, 'step2_ceo_rejected',
             f'CEO rejected Step 2: {notes}', '❌', '#FFF5F5')
    db.commit()
    db.refresh(t)
    return _serialize_tender(t, db)


@router.post("/{tender_id}/approve-step3-manager")
def approve_step3_manager(
    tender_id: int,
    decision: str,
    notes: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role not in MANAGER_ROLES:
        raise HTTPException(403, "Not authorized")
    t = _get_or_404(db, tender_id)
    if decision == 'approved':
        ceo_id = _find_approver(db, t.assigned_to or 0, 'ceo')
        if not ceo_id:
            raise HTTPException(400, "No CEO found")
        approval = Approval(
            module='tender', action='tender_step3_ceo',
            record_id=t.id,
            record_ref=f"Tender: {t.tender_title or t.portal_ref_number}",
            requested_by=current_user.id, requested_to=ceo_id,
            status='pending',
            request_notes=f"Manager approved Workings. {notes or ''}",
        )
        db.add(approval)
        db.flush()
        t.step3_approval_id = approval.id
        t.workflow_status   = 'step3_pending'
        _notify(db, ceo_id, "Tender Workings Needs CEO Approval",
                f"Manager approved Step-3 of: {t.tender_title}",
                'tender', t.id, 'approval_request')
        _log(db, current_user.id, t.id, 'step3_mgr_approved',
             'Manager approved Step 3; escalated to CEO', '✅', '#F0FFF4')
    else:
        t.workflow_status = 'active'
        t.updated_at = now_ist()
        _notify(db, t.assigned_to or 0, "Tender Workings Rejected",
                f"Manager rejected Step-3: {notes or ''}",
                'tender', t.id, 'rejected')
        _log(db, current_user.id, t.id, 'step3_mgr_rejected',
             f'Manager rejected Step 3: {notes}', '❌', '#FFF5F5')
    db.commit()
    db.refresh(t)
    return _serialize_tender(t, db)


@router.post("/{tender_id}/approve-step3-ceo")
def approve_step3_ceo(
    tender_id: int,
    decision: str,
    notes: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role not in PRIVILEGED_ROLES:
        raise HTTPException(403, "Not authorized")
    t = _get_or_404(db, tender_id)
    if decision == 'approved':
        t.workflow_status    = 'step3_active'
        t.tender_status      = 'Submitted'
        t.listed_in_accounts = True
        if hasattr(t, 'step3_approved_at'):
            t.step3_approved_at = now_ist()
        t.updated_at = now_ist()
        _notify(db, t.assigned_to or 0, "Tender Submitted — Workings Approved",
                f"Tender '{t.tender_title}' is now Submitted",
                'tender', t.id, 'approved')
        _log(db, current_user.id, t.id, 'step3_ceo_approved',
             'CEO approved Step 3 — status = Submitted, listed in accounts', '🏆', '#F0FFF4')
    else:
        t.workflow_status = 'active'
        t.updated_at = now_ist()
        _notify(db, t.assigned_to or 0, "Tender Workings Rejected by CEO",
                f"CEO rejected Step-3: {notes or ''}",
                'tender', t.id, 'rejected')
        _log(db, current_user.id, t.id, 'step3_ceo_rejected',
             f'CEO rejected Step 3: {notes}', '❌', '#FFF5F5')
    db.commit()
    db.refresh(t)
    return _serialize_tender(t, db)


# ─── DELETE /{id} ─────────────────────────────────────────────────────────────

@router.delete("/{tender_id}")
def delete_tender(
    tender_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role not in PRIVILEGED_ROLES + ('manager', 'vp'):
        raise HTTPException(403, "Only managers and above can delete tenders")
    t = _get_or_404(db, tender_id)
    t.is_deleted = True
    t.updated_at = now_ist()
    _log(db, current_user.id, t.id, 'deleted',
         f"Tender '{t.tender_title}' deleted", '🗑️', '#FFF5F5')
    db.commit()
    return {"message": "Tender deleted"}


# ─── Private helpers ───────────────────────────────────────────────────────────

def _get_or_404(db: Session, tender_id: int) -> Tender:
    _ensure_tender_schema(db)
    t = db.query(Tender).filter(Tender.id == tender_id, Tender.is_deleted == False).first()
    if not t:
        raise HTTPException(404, "Tender not found")
    return t


def isManagerOrAbove(user: User) -> bool:
    return user.role in MANAGER_ROLES


def _check_step_access(t: Tender, user: User, step: int):
    if user.role in MANAGER_ROLES:
        return
    current = t.current_step or 1
    if step < current:
        raise HTTPException(403, f"Step {step} is locked. Only managers and above can edit past steps.")
    if step > current + 1:
        raise HTTPException(403, f"Please complete Step {current} before moving to Step {step}.")


def _upsert_products(db: Session, tender_id: int, products: List[ProductIn], is_final: bool):
    db.query(TenderProduct).filter(
        TenderProduct.tender_id == tender_id,
        TenderProduct.is_final_boq == is_final,
    ).delete()
    for p in products:
        base_rate   = (p.work_unit_rate or 0) if p.is_works_item else (p.unit_price or 0)
        total_price = round((p.quantity or 1) * base_rate * (1 + (p.gst_percent or 0) / 100), 2)
        prod = TenderProduct(
            tender_id         = tender_id,
            product_id        = p.product_id,
            product_name      = p.product_name,
            quantity          = p.quantity,
            unit_price        = p.unit_price,
            gst_percent       = p.gst_percent,
            oem_authorization = p.oem_authorization,
            is_works_item     = p.is_works_item,
            work_type         = p.work_type,
            work_description  = p.work_description,
            work_unit         = p.work_unit,
            work_unit_rate    = p.work_unit_rate,
            is_final_boq      = is_final,
            total_price       = total_price,
        )
        db.add(prod)
        db.flush()
        for o in p.oems:
            db.add(TenderProductOEM(
                tender_product_id = prod.id,
                oem_id            = o.oem_id,
                oem_name          = o.oem_name,
                authorization_num = o.authorization_num,
                is_preferred      = o.is_preferred,
            ))


def _upsert_bidders(db: Session, tender_id: int, bidders: List[TechBidderIn]):
    existing      = db.query(TenderTechBidBidder).filter(
        TenderTechBidBidder.tender_id == tender_id
    ).all()
    existing_ids  = {b.id for b in existing}
    submitted_ids = {b.id for b in bidders if b.id}

    for bid in existing:
        if bid.id not in submitted_ids:
            db.query(TenderTechBidItem).filter(TenderTechBidItem.bidder_id == bid.id).delete()
            db.delete(bid)

    for bidder_in in bidders:
        if bidder_in.id and bidder_in.id in existing_ids:
            b = db.query(TenderTechBidBidder).filter(
                TenderTechBidBidder.id == bidder_in.id
            ).first()
            b.bidder_name = bidder_in.bidder_name
            b.bidder_type = bidder_in.bidder_type
            b.sort_order  = bidder_in.sort_order
        else:
            b = TenderTechBidBidder(
                tender_id   = tender_id,
                bidder_name = bidder_in.bidder_name,
                bidder_type = bidder_in.bidder_type,
                sort_order  = bidder_in.sort_order,
            )
            db.add(b)
            db.flush()

        db.query(TenderTechBidItem).filter(TenderTechBidItem.bidder_id == b.id).delete()
        for item_in in bidder_in.items:
            db.add(TenderTechBidItem(
                bidder_id         = b.id,
                tender_id         = tender_id,
                product_id        = item_in.product_id,
                product_name      = item_in.product_name,
                oem_id            = item_in.oem_id,
                oem_name          = item_in.oem_name,
                authorization_ref = item_in.authorization_ref,
                sort_order        = item_in.sort_order,
            ))


def _upsert_loss_analysis(db: Session, tender_id: int, la_data: LossAnalysisIn):
    la = db.query(TenderLossAnalysis).filter(
        TenderLossAnalysis.tender_id == tender_id
    ).first()
    fields = dict(
        our_position      = la_data.our_position,
        competitor_name   = la_data.competitor_name,
        competitor_amount = la_data.competitor_amount,
        our_bid_amount    = la_data.our_bid_amount,
        l1_company        = la_data.l1_company,
        l1_amount         = la_data.l1_amount,
        l2_company        = la_data.l2_company,
        l2_amount         = la_data.l2_amount,
        l3_company        = la_data.l3_company,
        l3_amount         = la_data.l3_amount,
    )
    if hasattr(TenderLossAnalysis, 'loss_reason'):
        fields['loss_reason'] = la_data.loss_reason
    if la:
        for k, v in fields.items():
            setattr(la, k, v)
    else:
        db.add(TenderLossAnalysis(tender_id=tender_id, **fields))

