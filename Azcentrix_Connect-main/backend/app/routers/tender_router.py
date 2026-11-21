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
from datetime import datetime
from app.core.timezone import now_ist, today_ist
from app.core.logging import log_module_action, model_snapshot
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Request
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import text as sa_text, func, inspect as sa_inspect, and_, or_, false
from pydantic import BaseModel

from app.dependencies import get_tenant_db, get_current_user, get_request_ip, require_permission
from app.models.all_models import (
    Tender, TenderProduct, TenderProductOEM, TenderDocument,
    TenderTechBidBidder, TenderTechBidItem, TenderLossAnalysis,
    User, ActivityLog, Approval, ApprovalRequest, EMDBG, WorkOrder, OEM,
    Lead, LeadProduct, LeadProductOEM, LeadSource, CustomerContact,
    UserReportingHierarchy, OrgTreeNode,
)
from app.utils.data_scope import apply_data_scope, get_module_data_scope, get_team_user_ids
from app.services.dynamic_notification_service import emit_notification_event
from app.services.cache_service import invalidate_badges_cache
from app.services.generic_approval_engine import (
    create_generic_approval_request,
    find_latest_request_for_record,
    get_request_progress,
)
from app.services.storage_usage_service import refresh_tenant_storage_usage_for_slug
from app.utils.file_storage import (
    delete_stored_file,
    media_slug_from_request,
    media_url_to_logical_path,
    save_upload_optimized,
    stored_file_accounted_size,
)
from app.core.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()

PRIVILEGED_ROLES = ('admin', 'ceo')
MANAGER_ROLES    = ('admin', 'ceo', 'manager', 'vp')


def _get_tenant_id(request: Request) -> Optional[int]:
    tenant = getattr(request.state, "tenant", None)
    tenant_id = getattr(tenant, "id", None)
    return int(tenant_id) if isinstance(tenant_id, int) else tenant_id


def _find_tender_approval_request(db: Session, tender: Tender):
    for action_key in _tender_approval_action_candidates(tender):
        approval_request = find_latest_request_for_record(
            db,
            module_key='tender',
            action_key=action_key,
            record_id=tender.id,
        )
        if approval_request:
            return approval_request
    return None


def _tender_approval_action_candidates(tender: Tender) -> list[str]:
    action_candidates: list[str] = []
    if getattr(tender, 'po_workflow_status', 'draft') in {'pending_approval', 'approved'} or (tender.current_step or 1) >= 6:
        action_candidates.append('po_details')
    if (tender.workflow_status or '') in {'step3_pending', 'step3_active'} or (tender.current_step or 1) >= 3:
        action_candidates.append('workings')
    if (tender.current_step or 1) >= 2 or (tender.workflow_status or '') in {'step2_pending', 'active', 'rejected'}:
        action_candidates.append('tender_details')
    return action_candidates


_SERIALIZE_UNSET = object()


def _relationship_loaded(obj, attr_name: str) -> bool:
    try:
        return attr_name not in sa_inspect(obj).unloaded
    except Exception:
        return False

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
              ADD COLUMN IF NOT EXISTS `listed_in_accounts` TINYINT(1) NOT NULL DEFAULT 0,
              ADD COLUMN IF NOT EXISTS `emd_bank_branch`       VARCHAR(200) NULL,
              ADD COLUMN IF NOT EXISTS `emd_instrument_number` VARCHAR(200) NULL,
              ADD COLUMN IF NOT EXISTS `emd_issued_date`       DATE NULL,
              ADD COLUMN IF NOT EXISTS `emd_submitted_date`    DATE NULL,
              ADD COLUMN IF NOT EXISTS `emd_valid_from`        DATE NULL,
              ADD COLUMN IF NOT EXISTS `emd_expiry_date`       DATE NULL,
              ADD COLUMN IF NOT EXISTS `emd_purpose`           TEXT NULL,
              ADD COLUMN IF NOT EXISTS `tender_fee_bank_name`         VARCHAR(200) NULL,
              ADD COLUMN IF NOT EXISTS `tender_fee_bank_branch`       VARCHAR(200) NULL,
              ADD COLUMN IF NOT EXISTS `tender_fee_instrument_number` VARCHAR(200) NULL,
              ADD COLUMN IF NOT EXISTS `tender_fee_issued_date`       DATE NULL,
              ADD COLUMN IF NOT EXISTS `tender_fee_submitted_date`    DATE NULL,
              ADD COLUMN IF NOT EXISTS `tender_fee_valid_from`        DATE NULL,
              ADD COLUMN IF NOT EXISTS `tender_fee_expiry_date`       DATE NULL,
              ADD COLUMN IF NOT EXISTS `tender_fee_dd_in_favour_of`   VARCHAR(200) NULL,
              ADD COLUMN IF NOT EXISTS `tender_fee_dd_payable_at`     VARCHAR(200) NULL,
              ADD COLUMN IF NOT EXISTS `tender_fee_customer_name`     VARCHAR(200) NULL,
              ADD COLUMN IF NOT EXISTS `tender_fee_account_no`        VARCHAR(100) NULL,
              ADD COLUMN IF NOT EXISTS `tender_fee_ifsc_code`         VARCHAR(50) NULL,
              ADD COLUMN IF NOT EXISTS `tender_fee_gateway_name`      VARCHAR(200) NULL,
              ADD COLUMN IF NOT EXISTS `tender_fee_bg_validity_days`  INT NULL,
              ADD COLUMN IF NOT EXISTS `tender_fee_bg_validity_date`  DATE NULL,
              ADD COLUMN IF NOT EXISTS `tender_fee_bg_bank_type`      VARCHAR(100) NULL,
              ADD COLUMN IF NOT EXISTS `emd_dd_in_favour_of`          VARCHAR(200) NULL,
              ADD COLUMN IF NOT EXISTS `emd_dd_payable_at`            VARCHAR(200) NULL,
              ADD COLUMN IF NOT EXISTS `emd_customer_name`            VARCHAR(200) NULL,
              ADD COLUMN IF NOT EXISTS `emd_account_no`               VARCHAR(100) NULL,
              ADD COLUMN IF NOT EXISTS `emd_ifsc_code`                VARCHAR(50) NULL,
              ADD COLUMN IF NOT EXISTS `emd_gateway_name`             VARCHAR(200) NULL,
              ADD COLUMN IF NOT EXISTS `emd_bg_validity_days`         INT NULL,
              ADD COLUMN IF NOT EXISTS `emd_bg_validity_date`         DATE NULL,
              ADD COLUMN IF NOT EXISTS `emd_bg_bank_type`             VARCHAR(100) NULL,
              ADD COLUMN IF NOT EXISTS `pbg_bank_name`         VARCHAR(200) NULL,
              ADD COLUMN IF NOT EXISTS `pbg_bank_branch`       VARCHAR(200) NULL,
              ADD COLUMN IF NOT EXISTS `pbg_instrument_number` VARCHAR(200) NULL,
              ADD COLUMN IF NOT EXISTS `pbg_issued_date`       DATE NULL,
              ADD COLUMN IF NOT EXISTS `pbg_submitted_date`    DATE NULL,
              ADD COLUMN IF NOT EXISTS `pbg_valid_from`        DATE NULL,
              ADD COLUMN IF NOT EXISTS `pbg_expiry_date`       DATE NULL,
              ADD COLUMN IF NOT EXISTS `pbg_purpose`           TEXT NULL,
              ADD COLUMN IF NOT EXISTS `pbg_payment_method`    VARCHAR(50) NULL,
              ADD COLUMN IF NOT EXISTS `pbg_dd_in_favour_of`   VARCHAR(200) NULL,
              ADD COLUMN IF NOT EXISTS `pbg_dd_payable_at`     VARCHAR(200) NULL,
              ADD COLUMN IF NOT EXISTS `pbg_customer_name`     VARCHAR(200) NULL,
              ADD COLUMN IF NOT EXISTS `pbg_account_no`        VARCHAR(100) NULL,
              ADD COLUMN IF NOT EXISTS `pbg_ifsc_code`         VARCHAR(50) NULL,
              ADD COLUMN IF NOT EXISTS `pbg_gateway_name`      VARCHAR(200) NULL,
              ADD COLUMN IF NOT EXISTS `pbg_bg_validity_days`  INT NULL,
              ADD COLUMN IF NOT EXISTS `pbg_bg_validity_date`  DATE NULL,
              ADD COLUMN IF NOT EXISTS `pbg_bg_bank_type`      VARCHAR(100) NULL,
              ADD COLUMN IF NOT EXISTS `tender_fee_emdbg_id`   INT NULL,
              ADD COLUMN IF NOT EXISTS `emd_emdbg_id`          INT NULL,
              ADD COLUMN IF NOT EXISTS `pbg_emdbg_id`          INT NULL,
              ADD COLUMN IF NOT EXISTS `lead_id`               INT NULL COMMENT 'FK to leads – source lead for this tender',
              ADD COLUMN IF NOT EXISTS `business_vertical_id`  INT NULL COMMENT 'Selected business vertical unit id — no FK constraint, mirrors leads.business_vertical_id',
              ADD COLUMN IF NOT EXISTS `est_value`             DECIMAL(15,2) NULL COMMENT 'Estimated tender value',
              ADD COLUMN IF NOT EXISTS `completion_days`       INT NULL COMMENT 'Days to completion from PO date',
              ADD COLUMN IF NOT EXISTS `completion_date`       DATE NULL COMMENT 'Auto-calculated completion date',
              ADD COLUMN IF NOT EXISTS `penalty`               TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Penalty applicable (Y/N)',
              ADD COLUMN IF NOT EXISTS `ld_type`               VARCHAR(10) NULL COMMENT 'LD Type: MIN or MAX',
              ADD COLUMN IF NOT EXISTS `ld_percent`            DECIMAL(5,2) NULL COMMENT 'LD Percentage',
              ADD COLUMN IF NOT EXISTS `po_workflow_status`    VARCHAR(30) NOT NULL DEFAULT 'draft' COMMENT 'PO approval: draft, pending_approval, approved',
              ADD COLUMN IF NOT EXISTS `consignee_submitted`   TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Consignees submitted (step 7 final)'
        """))
        db.execute(sa_text("ALTER TABLE tenders MODIFY COLUMN `po_doc` VARCHAR(500) NULL"))
        db.execute(sa_text("""
            ALTER TABLE tender_product_oems
              ADD COLUMN IF NOT EXISTS `is_authorized` TINYINT(1) NOT NULL DEFAULT 0
        """))
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



def _next_tender_num(db: Session) -> str:
    """Generate a sequential tender number: TND-YYYYMM-000001.
    Uses the tender_num column to determine the next sequence so both
    manual creation and lead-conversion get identical formatted numbers.
    """
    prefix = now_ist().strftime("TND-%Y%m-")
    row = db.execute(
        sa_text("SELECT MAX(CAST(SUBSTRING(tender_num, :offset) AS UNSIGNED)) FROM tenders WHERE tender_num LIKE :p"),
        {"p": f"{prefix}%", "offset": len(prefix) + 1}
    ).fetchone()
    n = row[0] if row and row[0] else 0
    return f"{prefix}{(n + 1):06d}"


def _emdbg_ref_num(db: Session) -> str:
    prefix = f"EMDBG-{now_ist().strftime('%Y%m')}-"

    row = db.execute(
        sa_text("""
            SELECT MAX(
                CAST(SUBSTRING(reference_num, :offset) AS UNSIGNED)
            )
            FROM emdbg
            WHERE reference_num LIKE :p
        """),
        {
            "p": f"{prefix}%",
            "offset": len(prefix) + 1
        }
    ).fetchone()

    n = row[0] if row and row[0] else 0
    return f"{prefix}{n + 1:04d}"


def _upsert_emdbg(
    db: Session,
    tender: Tender,
    emdbg_id: Optional[int],
    instrument_type: str,
    amount: float,
    bank_name: str,
    bank_branch: str,
    instrument_number: str,
    issued_date,
    submitted_date,
    valid_from,
    expiry_date,
    purpose: str,
    notes: str,
    created_by: int,
) -> int:
    """Create or update an EMDBG record linked to this tender. Returns the EMDBG id.

    Duplicate-prevention: before creating, always check for an existing record with
    the same (tender_id, instrument_type). Only one EMDBG record is allowed per
    tender + instrument type.
    """
    vcols = {c.name for c in EMDBG.__table__.columns}

    # 1. Try to find by explicit ID passed from the tender
    e = None
    if emdbg_id:
        e = db.query(EMDBG).filter(EMDBG.id == emdbg_id).first()

    # 2. Guard against duplicates: look for an existing record for this
    #    tender + instrument type even when emdbg_id is missing/stale
    if e is None:
        e = db.query(EMDBG).filter(
            EMDBG.tender_id == tender.id,
            EMDBG.instrument_type == instrument_type,
        ).first()

    if e is None:
        # 3. Nothing found — create exactly one new record
        kw = dict(
            reference_num     = _emdbg_ref_num(db),
            tender_num        = tender.tender_num or "",   # store actual tender_num
            tender_id         = tender.id,
            client_name       = tender.customer_name or "",
            customer_id       = tender.customer_id,
            instrument_type   = instrument_type,
            amount            = amount,
            bank_name         = bank_name or None,
            bank_branch       = bank_branch or None,
            instrument_number = instrument_number or None,
            issued_date       = issued_date or None,
            submitted_date    = submitted_date or None,
            valid_from        = valid_from or None,
            expiry_date       = expiry_date,
            purpose           = purpose or None,
            notes             = notes or None,
            status            = "Active",
            approval_status   = "none",
            created_by        = created_by,
        )
        e = EMDBG(**{k: v for k, v in kw.items() if k in vcols})
        db.add(e)
    else:
        # 4. Update the existing record in place
        e.instrument_type   = instrument_type
        e.amount            = amount
        e.bank_name         = bank_name or None
        e.bank_branch       = bank_branch or None
        e.instrument_number = instrument_number or None
        e.issued_date       = issued_date or None
        e.submitted_date    = submitted_date or None
        e.valid_from        = valid_from or None
        e.expiry_date       = expiry_date
        e.purpose           = purpose or None
        e.notes             = notes or None
        e.client_name       = tender.customer_name or e.client_name
        e.customer_id       = tender.customer_id or e.customer_id
        # sync tender_num (may have been generated after the record was first created)
        if tender.tender_num:
            e.tender_num = tender.tender_num

    db.flush()
    return e.id


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

ADMIN_SCOPE_ROLES = {"admin", "ceo", "super_admin"}

def _normalized_role(role: Optional[str]) -> str:
    normalized = (role or "").strip().lower().replace("-", "_").replace(" ", "_")
    return {
        "sales_executive": "sales",
        "salesexecutive": "sales",
        "sales_head": "manager",
        "saleshead": "manager",
    }.get(normalized, normalized)

def _parse_group_ids(value: Optional[str]) -> set[int]:
    if not value:
        return set()

    ids = set()
    for part in str(value).split(","):
        part = part.strip()
        if part.isdigit():
            ids.add(int(part))
    return ids

def _get_org_tree_user_ids(db: Session, user_id: int) -> list[int]:
    """Return all user IDs visible to user_id based on the Group Fixing tree (OrgTreeNode)."""
    return get_team_user_ids(db, int(user_id))


def _scope_user_ids(db: Session, current_user: User) -> Optional[list[int]]:
    # Kept for backward-compat with non-list endpoints that still use this.
    # New list endpoints use apply_data_scope directly.
    # Driven solely by the role's configured Data Visibility for "tenders" -
    # no role-name shortcuts. None means "no restriction".
    scope = get_module_data_scope(db, current_user, "tenders")
    if scope == "all":
        return None
    if scope == "none":
        return []
    current_user_id = int(current_user.id)
    if scope == "own":
        return [current_user_id]
    return _get_org_tree_user_ids(db, current_user_id)


# ─── Notification & Log helpers ────────────────────────────────────────────────

def _emit_tender_event(
    db: Session,
    *,
    tender: Tender,
    event_key: str,
    actor: Optional[User],
    approver_user_id: Optional[int] = None,
    requester_user_id: Optional[int] = None,
    reason: Optional[str] = None,
) -> None:
    try:
        emit_notification_event(
            db,
            module_key="tenders",
            event_key=event_key,
            record_id=tender.id,
            actor_user_id=getattr(actor, "id", None),
            context={
                "tender_num": getattr(tender, "tender_num", "") or "",
                "tender_title": getattr(tender, "tender_title", "") or getattr(tender, "portal_ref_number", "") or "",
                "customer_name": getattr(tender, "customer_name", "") or "",
                "assignee_user_id": getattr(tender, "assigned_to", None),
                "requester_user_id": requester_user_id,
                "approver_user_id": approver_user_id,
                "reason": reason or "",
                "record_ref": getattr(tender, "tender_title", "") or getattr(tender, "portal_ref_number", "") or "",
            },
        )
    except Exception as e:
        logger.warning("tender dynamic notification failed for tender=%s event=%s: %s", tender.id, event_key, e)


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

def _save_upload(
    request: Request,
    file: UploadFile,
    subfolder: str = "tenders",
    contents: bytes | None = None,
    quota_extra_bytes: int | None = None,
    quota_existing_bytes: int | None = None,
) -> str:
    """
    Save an uploaded file to disk.
    Pass `contents` if you've already awaited file.read() in the async route —
    this avoids the sync/async mismatch where file.file.read() returns empty bytes.
    """
    data     = contents if contents is not None else file.file.read()

    logger.info(f"_save_upload: MEDIA_ROOT={settings.MEDIA_ROOT!r}")
    logger.info(f"_save_upload: subfolder={subfolder!r}  data_len={len(data) if data else 0}")

    if not data:
        raise HTTPException(400, f"Uploaded file is empty or could not be read: {file.filename}")
    media_slug = media_slug_from_request(request)

    saved = save_upload_optimized(
        root_dir=os.path.abspath(settings.MEDIA_ROOT),
        subfolder=subfolder,
        original_filename=file.filename,
        contents=data,
        media_slug=media_slug,
        content_type=file.content_type,
        quota_extra_bytes=quota_extra_bytes,
        quota_existing_bytes=quota_existing_bytes,
    )

    logger.info(
        "_save_upload: written to %r compression=%s original=%s stored=%s",
        str(saved.physical_path), saved.compression_type, saved.original_size, saved.stored_size,
    )
    return saved.url


# ─── Pydantic schemas ──────────────────────────────────────────────────────────

class OEMIn(BaseModel):
    oem_id: Optional[int]   = None
    oem_name: str           = ""
    authorization_num: str  = ""
    is_authorized: bool     = False
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
    business_vertical_id: Optional[int] = None
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
    tender_fee_bank_name: str               = ""
    tender_fee_bank_branch: str             = ""
    tender_fee_instrument_number: str       = ""
    tender_fee_issued_date: Optional[str]   = None
    tender_fee_submitted_date: Optional[str] = None
    tender_fee_valid_from: Optional[str]    = None
    tender_fee_expiry_date: Optional[str]   = None
    emd_required: bool                 = False
    emd_amount: Optional[float]        = None
    emd_payment_method: str            = ""
    emd_bank_name: str                 = ""
    emd_bg_days: Optional[int]         = None
    emd_reference: str                 = ""
    emd_bank_branch: str               = ""
    emd_instrument_number: str         = ""
    emd_issued_date: Optional[str]     = None
    emd_submitted_date: Optional[str]  = None
    emd_valid_from: Optional[str]      = None
    emd_expiry_date: Optional[str]     = None
    emd_purpose: str                   = ""
    pbg_required: bool                 = False
    pbg_amount: Optional[float]        = None
    pbg_bg_days: Optional[int]         = None
    pbg_reference: str                 = ""
    pbg_bank_name: str                 = ""
    pbg_bank_branch: str               = ""
    pbg_instrument_number: str         = ""
    pbg_issued_date: Optional[str]     = None
    pbg_submitted_date: Optional[str]  = None
    pbg_valid_from: Optional[str]      = None
    pbg_expiry_date: Optional[str]     = None
    pbg_purpose: str                   = ""
    tender_fee_emdbg_id: Optional[int] = None
    emd_emdbg_id: Optional[int]        = None
    pbg_emdbg_id: Optional[int]        = None
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
    dlvry_date:      Optional[str]   = None
    site_eng:        Optional[str]   = None
    eng_phone:       Optional[str]   = None
    pmnt_terms:      Optional[str]   = None
    sow:             Optional[str]   = None
    # New PO fields
    completion_days:  Optional[int]   = None
    completion_date:  Optional[str]   = None
    penalty:          Optional[bool]  = False
    ld_type:          Optional[str]   = None
    ld_percent:       Optional[float] = None
    # Legacy fields (kept for backward compat, not shown in UI)
    wrk_order_id:    Optional[str]   = None
    wo_value:        Optional[float] = None
    instln_date:     Optional[str]   = None
    site_loc:        Optional[str]   = None
    advance:         Optional[str]   = None
    retention:       Optional[str]   = None
    # Source lead
    lead_id: Optional[int] = None
    # Workflow
    submit_step: int = 0
    tender_fee_dd_in_favour_of: str = ""
    tender_fee_dd_payable_at: str = ""
    tender_fee_customer_name: str = ""
    tender_fee_account_no: str = ""
    tender_fee_ifsc_code: str = ""
    tender_fee_gateway_name: str = ""
    tender_fee_bg_validity_days: Optional[int] = None
    tender_fee_bg_validity_date: Optional[str] = None
    tender_fee_bg_bank_type: str = ""

    emd_dd_in_favour_of: str = ""
    emd_dd_payable_at: str = ""
    emd_customer_name: str = ""
    emd_account_no: str = ""
    emd_ifsc_code: str = ""
    emd_gateway_name: str = ""
    emd_bg_validity_days: Optional[int] = None
    emd_bg_validity_date: Optional[str] = None
    emd_bg_bank_type: str = ""

    pbg_payment_method: str = ""
    pbg_dd_in_favour_of: str = ""
    pbg_dd_payable_at: str = ""
    pbg_customer_name: str = ""
    pbg_account_no: str = ""
    pbg_ifsc_code: str = ""
    pbg_gateway_name: str = ""
    pbg_bg_validity_days: Optional[int] = None
    pbg_bg_validity_date: Optional[str] = None
    pbg_bg_bank_type: str = ""
    custom_data: Optional[dict] = None


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

def _serialize_tender(
    t: Tender,
    db: Session,
    *,
    approval_request=_SERIALIZE_UNSET,
    emdbg_by_id: Optional[dict[int, EMDBG]] = None,
    oem_name_by_id: Optional[dict[int, str]] = None,
    contact_by_customer_id: Optional[dict[int, CustomerContact]] = None,
) -> dict:
    if _relationship_loaded(t, 'products'):
        all_products = sorted(list(t.products or []), key=lambda item: ((item.sort_order or 0), (item.id or 0)))
        products = [p for p in all_products if not bool(p.is_final_boq)]
        final_products = [p for p in all_products if bool(p.is_final_boq)]
    else:
        products = db.query(TenderProduct).filter(
            TenderProduct.tender_id == t.id, TenderProduct.is_final_boq == False
        ).order_by(TenderProduct.sort_order, TenderProduct.id).all()
        final_products = db.query(TenderProduct).filter(
            TenderProduct.tender_id == t.id, TenderProduct.is_final_boq == True
        ).order_by(TenderProduct.sort_order, TenderProduct.id).all()

    docs = list(t.documents or []) if _relationship_loaded(t, 'documents') else (
        db.query(TenderDocument).filter(TenderDocument.tender_id == t.id).all()
    )
    bidders = list(t.bidders or []) if _relationship_loaded(t, 'bidders') else (
        db.query(TenderTechBidBidder)
        .filter(TenderTechBidBidder.tender_id == t.id)
        .order_by(TenderTechBidBidder.sort_order)
        .all()
    )
    loss_analysis = t.loss_analysis if _relationship_loaded(t, 'loss_analysis') else (
        db.query(TenderLossAnalysis).filter(TenderLossAnalysis.tender_id == t.id).first()
    )

    def _ser_product(p: TenderProduct):
        oems = list(p.oems or []) if _relationship_loaded(p, 'oems') else (
            db.query(TenderProductOEM).filter(
                TenderProductOEM.tender_product_id == p.id
            ).all()
        )
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
                    'oem_name': o.oem_name or (oem_name_by_id or {}).get(o.oem_id) or (db.query(OEM.name).filter(OEM.id == o.oem_id).scalar() if o.oem_id and oem_name_by_id is None else '') or '',
                    'authorization_num': o.authorization_num,
                    'is_authorized': bool(getattr(o, 'is_authorized', False)),
                    'is_preferred': bool(o.is_preferred),
                } for o in oems
            ],
        }

    def _ser_bidder(b: TenderTechBidBidder):
        items = list(b.items or []) if _relationship_loaded(b, 'items') else (
            db.query(TenderTechBidItem)
            .filter(TenderTechBidItem.bidder_id == b.id)
            .order_by(TenderTechBidItem.sort_order)
            .all()
        )
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
        t.assignee if _relationship_loaded(t, 'assignee')
        else (db.query(User).filter(User.id == t.assigned_to).first() if t.assigned_to else None)
    )
    source_name = (
        db.query(LeadSource.name).filter(LeadSource.id == t.source_id).scalar()
        if t.source_id else None
    )
    business_vertical_name = None
    business_vertical_category_name = None
    if t.business_vertical_id:
        try:
            bv_row = db.execute(
                sa_text(
                    "SELECT COALESCE(u.business_unit, u.business_vertical) AS vname, "
                    "COALESCE(c.business_vertical, c.business_unit) AS cname "
                    "FROM business_category_units u "
                    "LEFT JOIN business_category_units c ON c.id = u.parent_category_id "
                    " AND c.item_type = 'category' WHERE u.id = :bv_id"
                ),
                {"bv_id": t.business_vertical_id},
            ).mappings().first()
            if bv_row:
                business_vertical_name = (bv_row["vname"] or "").strip() or None
                business_vertical_category_name = (bv_row["cname"] or "").strip() or None
        except Exception:
            pass
    approval_request = _find_tender_approval_request(db, t) if approval_request is _SERIALIZE_UNSET else approval_request
    approval_progress = get_request_progress(approval_request) if approval_request else None
    customer_contact = None
    if t.customer_id:
        if contact_by_customer_id is not None:
            customer_contact = contact_by_customer_id.get(t.customer_id)
        else:
            customer_contact = (
                db.query(CustomerContact)
                .filter(CustomerContact.customer_id == t.customer_id, CustomerContact.is_active == True)
                .order_by(CustomerContact.is_primary.desc(), CustomerContact.id.asc())
                .first()
            )

    # Look up EMDBG records for approval/paid status badges in the list view
    if emdbg_by_id is not None:
        _emd_rec = emdbg_by_id.get(getattr(t, 'emd_emdbg_id', None))
        _pbg_rec = emdbg_by_id.get(getattr(t, 'pbg_emdbg_id', None))
    else:
        _emd_rec = db.query(EMDBG).filter(EMDBG.id == getattr(t, 'emd_emdbg_id', None)).first() \
            if getattr(t, 'emd_emdbg_id', None) else None
        _pbg_rec = db.query(EMDBG).filter(EMDBG.id == getattr(t, 'pbg_emdbg_id', None)).first() \
            if getattr(t, 'pbg_emdbg_id', None) else None

    return {
        'id': t.id,
        'tender_num': t.tender_num,
        'customer_id': t.customer_id,
        'customer_name': t.customer_name,
        'contact_person': customer_contact.contact_name if customer_contact else '',
        'contact_phone': (customer_contact.mobile or customer_contact.office_phone) if customer_contact else '',
        'contact_email': (customer_contact.office_email or customer_contact.personal_email) if customer_contact else '',
        'office_phone': customer_contact.office_phone if customer_contact else '',
        'mobile': customer_contact.mobile if customer_contact else '',
        'office_email': customer_contact.office_email if customer_contact else '',
        'personal_email': customer_contact.personal_email if customer_contact else '',
        'tender_title': t.tender_title,
        'portal_ref_number': t.portal_ref_number,
        'est_value': float(t.est_value) if t.est_value else None,
        'source_id': t.source_id,
        'source_name': source_name or t.source_portal or '',
        'source_portal': t.source_portal,
        'business_vertical_id': t.business_vertical_id,
        'business_vertical_name': business_vertical_name,
        'business_vertical_category_name': business_vertical_category_name,
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
        'tender_fee_bank_name': getattr(t, 'tender_fee_bank_name', '') or '',
        'tender_fee_bank_branch': getattr(t, 'tender_fee_bank_branch', '') or '',
        'tender_fee_instrument_number': getattr(t, 'tender_fee_instrument_number', '') or '',
        'tender_fee_issued_date': str(t.tender_fee_issued_date) if getattr(t, 'tender_fee_issued_date', None) else None,
        'tender_fee_submitted_date': str(t.tender_fee_submitted_date) if getattr(t, 'tender_fee_submitted_date', None) else None,
        'tender_fee_valid_from': str(t.tender_fee_valid_from) if getattr(t, 'tender_fee_valid_from', None) else None,
        'tender_fee_expiry_date': str(t.tender_fee_expiry_date) if getattr(t, 'tender_fee_expiry_date', None) else None,
        'tender_fee_dd_in_favour_of': getattr(t, 'tender_fee_dd_in_favour_of', '') or '',
        'tender_fee_dd_payable_at': getattr(t, 'tender_fee_dd_payable_at', '') or '',
        'tender_fee_customer_name': getattr(t, 'tender_fee_customer_name', '') or '',
        'tender_fee_account_no': getattr(t, 'tender_fee_account_no', '') or '',
        'tender_fee_ifsc_code': getattr(t, 'tender_fee_ifsc_code', '') or '',
        'tender_fee_gateway_name': getattr(t, 'tender_fee_gateway_name', '') or '',
        'tender_fee_bg_validity_days': getattr(t, 'tender_fee_bg_validity_days', None),
        'tender_fee_bg_validity_date': str(t.tender_fee_bg_validity_date) if getattr(t, 'tender_fee_bg_validity_date', None) else None,
        'tender_fee_bg_bank_type': getattr(t, 'tender_fee_bg_bank_type', '') or '',
        'emd_required': bool(t.emd_required),
        'emd_amount': float(t.emd_amount) if t.emd_amount else None,
        'emd_payment_method': t.emd_payment_method,
        'emd_bank_name': t.emd_bank_name,
        'emd_bg_days': t.emd_bg_days,
        'emd_reference': t.emd_reference,
        'emd_bank_branch': getattr(t, 'emd_bank_branch', '') or '',
        'emd_instrument_number': getattr(t, 'emd_instrument_number', '') or '',
        'emd_issued_date': str(t.emd_issued_date) if getattr(t, 'emd_issued_date', None) else None,
        'emd_submitted_date': str(t.emd_submitted_date) if getattr(t, 'emd_submitted_date', None) else None,
        'emd_valid_from': str(t.emd_valid_from) if getattr(t, 'emd_valid_from', None) else None,
        'emd_expiry_date': str(t.emd_expiry_date) if getattr(t, 'emd_expiry_date', None) else None,
        'emd_purpose': getattr(t, 'emd_purpose', '') or '',
        'emd_dd_in_favour_of': getattr(t, 'emd_dd_in_favour_of', '') or '',
        'emd_dd_payable_at': getattr(t, 'emd_dd_payable_at', '') or '',
        'emd_customer_name': getattr(t, 'emd_customer_name', '') or '',
        'emd_account_no': getattr(t, 'emd_account_no', '') or '',
        'emd_ifsc_code': getattr(t, 'emd_ifsc_code', '') or '',
        'emd_gateway_name': getattr(t, 'emd_gateway_name', '') or '',
        'emd_bg_validity_days': getattr(t, 'emd_bg_validity_days', None),
        'emd_bg_validity_date': str(t.emd_bg_validity_date) if getattr(t, 'emd_bg_validity_date', None) else None,
        'emd_bg_bank_type': getattr(t, 'emd_bg_bank_type', '') or '',
        'pbg_required': bool(getattr(t, 'pbg_required', False)),
        'pbg_amount': float(t.pbg_amount) if getattr(t, 'pbg_amount', None) else None,
        'pbg_payment_method': getattr(t, 'pbg_payment_method', '') or '',
        'pbg_bg_days': getattr(t, 'pbg_bg_days', None),
        'pbg_reference': getattr(t, 'pbg_reference', '') or '',
        'pbg_bank_name': getattr(t, 'pbg_bank_name', '') or '',
        'pbg_bank_branch': getattr(t, 'pbg_bank_branch', '') or '',
        'pbg_instrument_number': getattr(t, 'pbg_instrument_number', '') or '',
        'pbg_issued_date': str(t.pbg_issued_date) if getattr(t, 'pbg_issued_date', None) else None,
        'pbg_submitted_date': str(t.pbg_submitted_date) if getattr(t, 'pbg_submitted_date', None) else None,
        'pbg_valid_from': str(t.pbg_valid_from) if getattr(t, 'pbg_valid_from', None) else None,
        'pbg_expiry_date': str(t.pbg_expiry_date) if getattr(t, 'pbg_expiry_date', None) else None,
        'pbg_purpose': getattr(t, 'pbg_purpose', '') or '',
        'pbg_dd_in_favour_of': getattr(t, 'pbg_dd_in_favour_of', '') or '',
        'pbg_dd_payable_at': getattr(t, 'pbg_dd_payable_at', '') or '',
        'pbg_customer_name': getattr(t, 'pbg_customer_name', '') or '',
        'pbg_account_no': getattr(t, 'pbg_account_no', '') or '',
        'pbg_ifsc_code': getattr(t, 'pbg_ifsc_code', '') or '',
        'pbg_gateway_name': getattr(t, 'pbg_gateway_name', '') or '',
        'pbg_bg_validity_days': getattr(t, 'pbg_bg_validity_days', None),
        'pbg_bg_validity_date': str(t.pbg_bg_validity_date) if getattr(t, 'pbg_bg_validity_date', None) else None,
        'pbg_bg_bank_type': getattr(t, 'pbg_bg_bank_type', '') or '',
        'tender_fee_emdbg_id': getattr(t, 'tender_fee_emdbg_id', None),
        'emd_emdbg_id': getattr(t, 'emd_emdbg_id', None),
        'pbg_emdbg_id': getattr(t, 'pbg_emdbg_id', None),
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
        'approval_request_id': approval_request.id if approval_request else None,
        'approval_status': approval_request.status if approval_request else None,
        'approval_action_key': approval_request.action_key if approval_request else None,
        'approval_display': approval_progress['display'] if approval_progress else None,
        'approval_progress_current': approval_progress['current'] if approval_progress else None,
        'approval_progress_total': approval_progress['total'] if approval_progress else None,
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
        'wrk_order_id':      getattr(t, 'wrk_order_id', None),
        'wo_value':          float(t.wo_value) if getattr(t, 'wo_value', None) else None,
        'dlvry_date':        str(t.dlvry_date) if getattr(t, 'dlvry_date', None) else None,
        'instln_date':       str(t.instln_date) if getattr(t, 'instln_date', None) else None,
        'site_loc':          getattr(t, 'site_loc', None),
        'site_eng':          getattr(t, 'site_eng', None),
        'eng_phone':         getattr(t, 'eng_phone', None),
        'advance':           getattr(t, 'advance', None),
        'retention':         getattr(t, 'retention', None),
        'pmnt_terms':        getattr(t, 'pmnt_terms', None),
        'sow':               getattr(t, 'sow', None),
        'completion_days':   getattr(t, 'completion_days', None),
        'completion_date':   str(t.completion_date) if getattr(t, 'completion_date', None) else None,
        'penalty':           bool(t.penalty) if getattr(t, 'penalty', None) is not None else False,
        'ld_type':           getattr(t, 'ld_type', None),
        'ld_percent':        float(t.ld_percent) if getattr(t, 'ld_percent', None) else None,
        'po_workflow_status': getattr(t, 'po_workflow_status', 'draft') or 'draft',
        'consignee_submitted': bool(getattr(t, 'consignee_submitted', False)),
        'emd_approval_status': (_emd_rec.approval_status or 'none') if _emd_rec else None,
        'emd_finance_status':  (getattr(_emd_rec, 'finance_status', None) or 'unpaid') if _emd_rec else None,
        'pbg_approval_status': (_pbg_rec.approval_status or 'none') if _pbg_rec else None,
        'pbg_finance_status':  (getattr(_pbg_rec, 'finance_status', None) or 'unpaid') if _pbg_rec else None,
        'custom_data':        getattr(t, 'custom_data', None) or {},
        'created_at': str(t.created_at) if t.created_at else None,
        'updated_at': str(t.updated_at) if t.updated_at else None,
        'lead_id': getattr(t, 'lead_id', None),
    }


# ─── GET / ─────────────────────────────────────────────────────────────────────
def _latest_tender_approval_requests(db: Session, tenders: list[Tender]) -> dict[int, ApprovalRequest]:
    if not tenders:
        return {}

    action_by_tender_id = {
        tender.id: _tender_approval_action_candidates(tender)
        for tender in tenders
        if tender.id is not None
    }
    action_keys = {action for actions in action_by_tender_id.values() for action in actions}
    if not action_keys:
        return {}

    rows = (
        db.query(ApprovalRequest)
        .options(selectinload(ApprovalRequest.steps))
        .filter(
            ApprovalRequest.module_key == 'tender',
            ApprovalRequest.record_id.in_(list(action_by_tender_id.keys())),
            ApprovalRequest.action_key.in_(list(action_keys)),
        )
        .order_by(
            ApprovalRequest.record_id.asc(),
            ApprovalRequest.action_key.asc(),
            ApprovalRequest.requested_at.desc(),
            ApprovalRequest.id.desc(),
        )
        .all()
    )

    by_record_action: dict[tuple[int, str], list[ApprovalRequest]] = {}
    for row in rows:
        by_record_action.setdefault((row.record_id, row.action_key), []).append(row)

    selected: dict[int, ApprovalRequest] = {}
    for tender in tenders:
        for action_key in action_by_tender_id.get(tender.id, []):
            requests = by_record_action.get((tender.id, action_key), [])
            if not requests:
                continue
            selected[tender.id] = next(
                (request for request in requests if (request.status or '').strip().lower() == 'pending'),
                requests[0],
            )
            break
    return selected


def _emdbg_records_for_tenders(db: Session, tenders: list[Tender]) -> dict[int, EMDBG]:
    emdbg_ids = {
        emdbg_id
        for tender in tenders
        for emdbg_id in (getattr(tender, 'emd_emdbg_id', None), getattr(tender, 'pbg_emdbg_id', None))
        if emdbg_id
    }
    if not emdbg_ids:
        return {}
    return {
        row.id: row
        for row in db.query(EMDBG).filter(EMDBG.id.in_(emdbg_ids)).all()
    }


def _oem_names_for_loaded_tenders(db: Session, tenders: list[Tender]) -> dict[int, str]:
    oem_ids = set()
    for tender in tenders:
        if not _relationship_loaded(tender, 'products'):
            continue
        for product in tender.products or []:
            if not _relationship_loaded(product, 'oems'):
                continue
            for product_oem in product.oems or []:
                if product_oem.oem_id and not product_oem.oem_name:
                    oem_ids.add(product_oem.oem_id)
    if not oem_ids:
        return {}
    return {
        oem_id: name
        for oem_id, name in db.query(OEM.id, OEM.name).filter(OEM.id.in_(oem_ids)).all()
    }


def _primary_contacts_for_tenders(db: Session, tenders: list[Tender]) -> dict[int, CustomerContact]:
    customer_ids = {t.customer_id for t in tenders if t.customer_id}
    if not customer_ids:
        return {}
    contacts = (
        db.query(CustomerContact)
        .filter(CustomerContact.customer_id.in_(customer_ids), CustomerContact.is_active == True)
        .order_by(CustomerContact.customer_id, CustomerContact.is_primary.desc(), CustomerContact.id.asc())
        .all()
    )
    by_customer_id: dict[int, CustomerContact] = {}
    for contact in contacts:
        by_customer_id.setdefault(contact.customer_id, contact)
    return by_customer_id


@router.get("/")
def list_tenders(
    page: int = 1, per_page: int = 20,
    search: Optional[str] = None,
    status: Optional[str] = None,
    assigned_to: Optional[int] = None,
    customer_id: Optional[int] = None,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("tenders.view")),
):
    _ensure_tender_schema(db)
    _sanitize_tender_enums(db)

    q = db.query(Tender).filter(Tender.is_deleted == False)

    q = apply_data_scope(db, q, current_user, "tenders", Tender.created_by, Tender.assigned_to)

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

    if tender_ids:
        loaded_tenders = (
            db.query(Tender)
            .options(
                selectinload(Tender.products).selectinload(TenderProduct.oems),
                selectinload(Tender.documents),
                selectinload(Tender.bidders).selectinload(TenderTechBidBidder.items),
                selectinload(Tender.loss_analysis),
                selectinload(Tender.assignee),
            )
            .filter(Tender.id.in_(tender_ids))
            .all()
        )
    else:
        loaded_tenders = []

    tenders_by_id = {t.id: t for t in loaded_tenders}
    ordered_tenders = [tenders_by_id[tid] for tid in tender_ids if tid in tenders_by_id]
    approval_by_tender_id = _latest_tender_approval_requests(db, ordered_tenders)
    emdbg_by_id = _emdbg_records_for_tenders(db, ordered_tenders)
    oem_name_by_id = _oem_names_for_loaded_tenders(db, ordered_tenders)
    contact_by_customer_id = _primary_contacts_for_tenders(db, ordered_tenders)

    items = []
    for t in ordered_tenders:
        try:
            items.append(_serialize_tender(
                t,
                db,
                approval_request=approval_by_tender_id.get(t.id),
                emdbg_by_id=emdbg_by_id,
                oem_name_by_id=oem_name_by_id,
                contact_by_customer_id=contact_by_customer_id,
            ))
        except Exception as e:
            logger.error(f"Failed to serialize tender {t.id}: {e}")
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
    q = db.query(func.count(Tender.id)).filter(
        Tender.created_at  > last_seen,
        Tender.is_deleted == False,
    )
    q = apply_data_scope(db, q, cu, "tenders", Tender.created_by, Tender.assigned_to)
    count = q.scalar() or 0
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
    invalidate_badges_cache(db, cu.id)
    return {"ok": True}


# ─── Per-user list-table display preferences (tenders list only) ─────────────

class TendersTablePrefsBody(BaseModel):
    stack_order: dict = {}


@router.get("/table-prefs")
def get_tenders_table_prefs(
    cu: User = Depends(get_current_user),
):
    layout = dict(cu.dashboard_layout or {})
    return layout.get("table_prefs", {}).get("tenders-list", {"stack_order": {}})


@router.post("/table-prefs")
def save_tenders_table_prefs(
    body: TendersTablePrefsBody,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    layout = dict(cu.dashboard_layout or {})
    table_prefs = dict(layout.get("table_prefs", {}))
    table_prefs["tenders-list"] = {"stack_order": body.stack_order}
    layout["table_prefs"] = table_prefs
    cu.dashboard_layout = layout
    db.commit()
    return {"ok": True}


@router.get("/dropdown")
def tender_dropdown(
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    """Return tenders for select dropdowns, including products for line-item pre-fill."""
    q = db.query(Tender).filter(Tender.is_deleted == False)
    q = apply_data_scope(db, q, cu, "tenders", Tender.created_by, Tender.assigned_to)
    tenders = q.order_by(Tender.created_at.desc()).all()

    tender_ids = [t.id for t in tenders]
    products_by_tender: dict = {}
    if tender_ids:
        for p in (
            db.query(TenderProduct)
            .filter(TenderProduct.tender_id.in_(tender_ids))
            .order_by(TenderProduct.sort_order)
            .all()
        ):
            products_by_tender.setdefault(p.tender_id, []).append(p)

    return [
        {
            "id":            t.id,
            "tender_num":    t.tender_num    or "",
            "tender_title":  t.tender_title  or "",
            "customer_name": t.customer_name or "",
            "customer_id":   t.customer_id,
            "tender_status": t.tender_status or "",
            "products": [
                {
                    "product_name": p.product_name or "",
                    "quantity":     float(p.quantity    or 1),
                    "unit_price":   float(p.unit_price  or 0),
                    "gst_percent":  float(p.gst_percent or 0),
                }
                for p in products_by_tender.get(t.id, [])
                if not p.is_final_boq   # only initial BOQ (Step-1) products
            ],
        }
        for t in tenders
    ]


@router.get("/by-lead/{lead_id}")
def get_tender_by_lead(
    lead_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("tenders.view")),
):
    """The tender created FROM this lead (Lead → Tender flow), if any — used by the
    Lead/Opportunity 360 view to surface Tender/EMD-BG/Work Order data for leads that
    went through the tender route rather than the direct-opportunity route."""
    _ensure_tender_schema(db)
    q = db.query(Tender).filter(Tender.lead_id == lead_id, Tender.is_deleted == False)
    q = apply_data_scope(db, q, current_user, "tenders", Tender.created_by, Tender.assigned_to)
    t = q.order_by(Tender.id.desc()).first()
    if not t:
        return None
    _sanitize_tender_enums(db, t.id)
    return _serialize_tender(t, db)


@router.get("/{tender_id}")
def get_tender(
    tender_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("tenders.view")),
):
    _ensure_tender_schema(db)
    _sanitize_tender_enums(db, tender_id)

    q = db.query(Tender).filter(Tender.id == tender_id, Tender.is_deleted == False)
    q = apply_data_scope(db, q, current_user, "tenders", Tender.created_by, Tender.assigned_to)
    t = q.first()
    if not t:
        raise HTTPException(404, "Tender not found")
    return _serialize_tender(t, db)

# ─── POST / (Create) ──────────────────────────────────────────────────────────

@router.post("/")
def create_tender(
    payload: TenderUpsertIn,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("tenders.create")),
):
    _ensure_tender_schema(db)
    # ── Date-order validation ─────────────────────────────────────────────────
    if payload.published_date and payload.pre_bid_date:
        if payload.pre_bid_date < payload.published_date:
            raise HTTPException(400, "Pre-Bid Date must be after Published Date.")
    if payload.pre_bid_date and payload.submission_date:
        if payload.submission_date <= payload.pre_bid_date:
            raise HTTPException(400, "Submission Deadline must be after Pre-Bid Date.")

    t = Tender(
        tender_num         = _next_tender_num(db),   # generated immediately on creation
        customer_id        = payload.customer_id,
        customer_name      = payload.customer_name,
        tender_title       = payload.tender_title,
        portal_ref_number  = payload.portal_ref_number,
        est_value          = payload.est_value,
        source_id          = payload.source_id,
        business_vertical_id = payload.business_vertical_id,
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
        lead_id            = payload.lead_id,
    )
    db.add(t)
    db.flush()
    source_lead = None
    if payload.lead_id:
        source_lead = db.query(Lead).filter(Lead.id == payload.lead_id).first()
        if source_lead and (
            source_lead.lead_type == 'direct_opportunity'
            or (getattr(source_lead, 'conversion_target', None) or '') != 'quotation'
        ):
            source_lead.conversion_target = 'tender'
            if not getattr(source_lead, 'converted_tender_id', None):
                source_lead.converted_tender_id = t.id

    initial_products = [p for p in payload.products if not p.is_final_boq]
    # If no products provided but a source lead is given, auto-import lead products
    if not initial_products and payload.lead_id:
        lead_prods = db.query(LeadProduct).filter(LeadProduct.lead_id == payload.lead_id).all()
        lead_product_ids = [int(lp.id) for lp in lead_prods if lp.id]
        lead_oems_by_product: dict[int, list[LeadProductOEM]] = {}
        if lead_product_ids:
            for lo in db.query(LeadProductOEM).filter(LeadProductOEM.lead_product_id.in_(lead_product_ids)).all():
                lead_oems_by_product.setdefault(int(lo.lead_product_id), []).append(lo)
        for lp in lead_prods:
            tp = TenderProduct(
                tender_id    = t.id,
                product_id   = lp.product_id,
                product_name = (lp.product_name or "").strip(),
                quantity     = lp.quantity or 1,
                unit_price   = float(lp.unit_price or 0),
                gst_percent  = float(lp.gst_percent or 0),
                sort_order   = lp.sort_order or 0,
                is_final_boq = False,
            )
            db.add(tp); db.flush()
            for lo in lead_oems_by_product.get(int(lp.id), []):
                db.add(TenderProductOEM(
                    tender_product_id = tp.id,
                    oem_id            = lo.oem_id,
                    oem_name          = lo.oem_name,
                    authorization_num = lo.authorization_num,
                ))
    else:
        _upsert_products(db, t.id, initial_products, is_final=False)
    _log(db, current_user.id, t.id, 'created', f"Tender '{t.tender_title}' created", '🏗️', '#EFF6FF')
    log_module_action(
        db=db, user_id=current_user.id, module="tenders", action="create",
        record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request),
        new_data=model_snapshot(t),
    )
    db.commit()
    db.refresh(t)
    from app.services.platform_webhooks import emit_safe   # outgoing webhooks (API & webhooks); never raises
    emit_safe(getattr(request.state, "tenant_slug", None), "tender.created",
              {"id": t.id, "tender_title": t.tender_title, "tender_status": t.tender_status, "created_at": t.created_at})
    return _serialize_tender(t, db)


# ─── PUT /{tender_id} — unified update ────────────────────────────────────────
@router.put("/{tender_id}")
def update_tender(
    tender_id: int,
    payload: TenderUpsertIn,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("tenders.update")),
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
        t = _get_or_404(db, tender_id, current_user)
    except Exception as e:
        print(f"  [FAIL] _get_or_404 raised: {e}")
        print(_tb.format_exc())
        raise

    print(f"  [OK] tender loaded: step={t.current_step} workflow={t.workflow_status} result={t.result!r}")
    _before_update_snapshot = model_snapshot(t)

    # ── Generate tender_num if missing (safety net for legacy rows) ──────────
    if not getattr(t, 'tender_num', None):
        t.tender_num = _next_tender_num(db)

    # ── Date-order validation (Step 1 fields) ─────────────────────────────────
    pub  = payload.published_date
    pre  = payload.pre_bid_date
    sub  = payload.submission_date
    if pub and pre and pre < pub:
        raise HTTPException(400, "Pre-Bid Date must be after Published Date.")
    if pre and sub and sub <= pre:
        raise HTTPException(400, "Submission Deadline must be after Pre-Bid Date.")

    # ── Step-1 always ────────────────────────────────────────────────────────
    t.customer_id       = payload.customer_id
    t.customer_name     = payload.customer_name
    t.tender_title      = payload.tender_title
    t.portal_ref_number = payload.portal_ref_number
    t.est_value         = payload.est_value
    t.source_id         = payload.source_id
    t.business_vertical_id = payload.business_vertical_id
    t.source_portal     = payload.source_portal or t.source_portal
    t.tender_status     = payload.tender_status or t.tender_status
    t.published_date    = payload.published_date
    t.pre_bid_date      = payload.pre_bid_date
    t.submission_date   = payload.submission_date
    t.assigned_to       = payload.assigned_to or t.assigned_to
    t.notes             = payload.notes
    if payload.custom_data is not None:
        t.custom_data = payload.custom_data
    t.updated_at        = now_ist()
    # Preserve source lead if already set; allow setting it for the first time
    if payload.lead_id and not getattr(t, 'lead_id', None):
        t.lead_id = payload.lead_id

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
        t.tender_fee_bank_name        = payload.tender_fee_bank_name
        t.tender_fee_bank_branch      = payload.tender_fee_bank_branch
        t.tender_fee_instrument_number = payload.tender_fee_instrument_number
        t.tender_fee_issued_date      = payload.tender_fee_issued_date or None
        t.tender_fee_submitted_date   = payload.tender_fee_submitted_date or None
        t.tender_fee_valid_from       = payload.tender_fee_valid_from or None
        t.tender_fee_expiry_date      = payload.tender_fee_expiry_date or None
        t.emd_required               = payload.emd_required
        t.emd_amount                 = payload.emd_amount
        t.emd_payment_method         = payload.emd_payment_method
        t.emd_bank_name              = payload.emd_bank_name
        t.emd_bg_days                = payload.emd_bg_days
        t.emd_reference              = payload.emd_reference
        t.emd_bank_branch            = payload.emd_bank_branch
        t.emd_instrument_number      = payload.emd_instrument_number
        t.emd_issued_date            = payload.emd_issued_date or None
        t.emd_submitted_date         = payload.emd_submitted_date or None
        t.emd_valid_from             = payload.emd_valid_from or None
        t.emd_expiry_date            = payload.emd_expiry_date or None
        t.emd_purpose                = payload.emd_purpose
        t.pbg_required               = payload.pbg_required
        t.pbg_amount                 = payload.pbg_amount
        t.pbg_bg_days                = payload.pbg_bg_days
        t.pbg_reference              = payload.pbg_reference
        t.pbg_bank_name              = payload.pbg_bank_name
        t.pbg_bank_branch            = payload.pbg_bank_branch
        t.pbg_instrument_number      = payload.pbg_instrument_number
        t.pbg_issued_date            = payload.pbg_issued_date or None
        t.pbg_submitted_date         = payload.pbg_submitted_date or None
        t.pbg_valid_from             = payload.pbg_valid_from or None
        t.pbg_expiry_date            = payload.pbg_expiry_date or None
        t.pbg_purpose                = payload.pbg_purpose
        t.split_order                = payload.split_order
        t.reverse_auction            = payload.reverse_auction
        # Tender Fee payment method fields
        t.tender_fee_dd_in_favour_of = payload.tender_fee_dd_in_favour_of
        t.tender_fee_dd_payable_at = payload.tender_fee_dd_payable_at
        t.tender_fee_customer_name = payload.tender_fee_customer_name
        t.tender_fee_account_no = payload.tender_fee_account_no
        t.tender_fee_ifsc_code = payload.tender_fee_ifsc_code
        t.tender_fee_gateway_name = payload.tender_fee_gateway_name
        t.tender_fee_bg_validity_days = payload.tender_fee_bg_validity_days
        t.tender_fee_bg_validity_date = payload.tender_fee_bg_validity_date or None
        t.tender_fee_bg_bank_type = payload.tender_fee_bg_bank_type

        # EMD payment method fields
        t.emd_dd_in_favour_of = payload.emd_dd_in_favour_of
        t.emd_dd_payable_at = payload.emd_dd_payable_at
        t.emd_customer_name = payload.emd_customer_name
        t.emd_account_no = payload.emd_account_no
        t.emd_ifsc_code = payload.emd_ifsc_code
        t.emd_gateway_name = payload.emd_gateway_name
        t.emd_bg_validity_days = payload.emd_bg_validity_days
        t.emd_bg_validity_date = payload.emd_bg_validity_date or None
        t.emd_bg_bank_type = payload.emd_bg_bank_type

        # PBG payment method fields
        t.pbg_payment_method = payload.pbg_payment_method
        t.pbg_dd_in_favour_of = payload.pbg_dd_in_favour_of
        t.pbg_dd_payable_at = payload.pbg_dd_payable_at
        t.pbg_customer_name = payload.pbg_customer_name
        t.pbg_account_no = payload.pbg_account_no
        t.pbg_ifsc_code = payload.pbg_ifsc_code
        t.pbg_gateway_name = payload.pbg_gateway_name
        t.pbg_bg_validity_days = payload.pbg_bg_validity_days
        t.pbg_bg_validity_date = payload.pbg_bg_validity_date or None
        t.pbg_bg_bank_type = payload.pbg_bg_bank_type
        if hasattr(t, 'bid_tracking'):
            t.bid_tracking = payload.bid_tracking

        # ── Upsert EMDBG records for each toggled section ─────────────────────
        db.flush()  # ensure t.id is available

        if payload.tender_fee_required and payload.tender_fee_amount:
            tender_fee_type = 'Online Payment' if (payload.tender_fee_method or '').strip().lower() in {'online', 'neft', 'rtgs', 'imps', 'upi'} else 'DD'
            fee_id = _upsert_emdbg(
                db=db, tender=t,
                emdbg_id=getattr(t, 'tender_fee_emdbg_id', None) or payload.tender_fee_emdbg_id,
                instrument_type=tender_fee_type,
                amount=payload.tender_fee_amount,
                bank_name=payload.tender_fee_bank_name,
                bank_branch=payload.tender_fee_bank_branch,
                instrument_number=payload.tender_fee_instrument_number,
                issued_date=payload.tender_fee_issued_date or None,
                submitted_date=payload.tender_fee_submitted_date or None,
                valid_from=payload.tender_fee_valid_from or None,
                expiry_date=payload.tender_fee_expiry_date or None,
                purpose=f"Tender Fee for {t.portal_ref_number or t.tender_num or ''}",
                notes=payload.tender_fee_payment_details or '',
                created_by=current_user.id,
            )
            t.tender_fee_emdbg_id = fee_id
        elif not payload.tender_fee_required and getattr(t, 'tender_fee_emdbg_id', None):
            t.tender_fee_emdbg_id = None

        if payload.emd_required and payload.emd_amount:
            emd_id = _upsert_emdbg(
                db=db, tender=t,
                emdbg_id=getattr(t, 'emd_emdbg_id', None) or payload.emd_emdbg_id,
                instrument_type='EMD',
                amount=payload.emd_amount,
                bank_name=payload.emd_bank_name,
                bank_branch=payload.emd_bank_branch,
                instrument_number=payload.emd_instrument_number,
                issued_date=payload.emd_issued_date or None,
                submitted_date=payload.emd_submitted_date or None,
                valid_from=payload.emd_valid_from or None,
                expiry_date=payload.emd_expiry_date or None,
                purpose=payload.emd_purpose or f"EMD for {t.portal_ref_number or t.tender_num or ''}",
                notes='',
                created_by=current_user.id,
            )
            t.emd_emdbg_id = emd_id
        elif not payload.emd_required and getattr(t, 'emd_emdbg_id', None):
            t.emd_emdbg_id = None

        if payload.pbg_required and payload.pbg_amount and payload.pbg_expiry_date:
            pbg_id = _upsert_emdbg(
                db=db, tender=t,
                emdbg_id=getattr(t, 'pbg_emdbg_id', None) or payload.pbg_emdbg_id,
                instrument_type='Performance BG',
                amount=payload.pbg_amount,
                bank_name=payload.pbg_bank_name,
                bank_branch=payload.pbg_bank_branch,
                instrument_number=payload.pbg_instrument_number,
                issued_date=payload.pbg_issued_date or None,
                submitted_date=payload.pbg_submitted_date or None,
                valid_from=payload.pbg_valid_from or None,
                expiry_date=payload.pbg_expiry_date,
                purpose=payload.pbg_purpose or f"PBG for {t.portal_ref_number or t.tender_num or ''}",
                notes='',
                created_by=current_user.id,
            )
            t.pbg_emdbg_id = pbg_id
        elif not payload.pbg_required and getattr(t, 'pbg_emdbg_id', None):
            t.pbg_emdbg_id = None

        if t.current_step < 2:
            t.current_step = 2
        print(f"  [BLOCK >= 2] done")

    # ── Step 3 — ONLY when submit_step == 3 ──────────────────────────────────
    if submit_step == 3:
        print(f"  [BLOCK == 3] entered")
        if t.workflow_status not in ('active', 'step3_pending', 'step3_active') \
           and current_user.role not in PRIVILEGED_ROLES + ('manager', 'vp'):
            print(f"  [FAIL] step3 workflow locked: {t.workflow_status!r}")
            raise HTTPException(403, "Step 3 is locked until Tender Details approval is completed.")
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
        t.dlvry_date      = payload.dlvry_date
        t.site_eng        = payload.site_eng
        t.eng_phone       = payload.eng_phone
        t.pmnt_terms      = payload.pmnt_terms
        t.sow             = payload.sow
        t.completion_days = payload.completion_days
        t.completion_date = payload.completion_date
        t.penalty         = payload.penalty or False
        t.ld_type         = payload.ld_type
        t.ld_percent      = payload.ld_percent
        if t.current_step < 6:
            t.current_step = 6
        # Push PO details for approval (reset to pending whenever PO saved)
        t.po_workflow_status = 'pending_approval'
        print(f"  [BLOCK == 6] po_num={t.po_num!r} po_value={t.po_value!r} po_workflow_status=pending_approval")
        try:
            db.flush()
            print(f"  [BLOCK == 6] flush OK")
        except Exception as e:
            print(f"  [FAIL] step6 flush: {e}")
            print(_tb.format_exc())
            raise

    # Approval trigger for Step 2
    if submit_step == 2:
        print(f"  [APPROVAL] step 2")
        if t.workflow_status == 'step2_pending':
            db.commit()
            return _serialize_tender(t, db)

        allowed_for_step2 = ('draft', 'active', 'rejected')
        if t.workflow_status not in allowed_for_step2 and not isManagerOrAbove(current_user):
            raise HTTPException(400, "Cannot re-submit Step 2 in current workflow state")

        approval_request = create_generic_approval_request(
            db=db,
            tenant_id=_get_tenant_id(request),
            requester=current_user,
            module_key='tender',
            action_key='tender_details',
            record_id=t.id,
        )

        if (approval_request.status or "").strip().lower() == "approved":
            t.workflow_status    = 'active'
            t.listed_in_accounts = True
            if hasattr(t, 'step2_approved_at'):
                t.step2_approved_at = now_ist()
            _emit_tender_event(
                db,
                tender=t,
                event_key='step2_approved',
                actor=current_user,
            )
            _log(db, current_user.id, t.id, 'step2_auto_approved',
                 'Step 2 auto-approved by the hierarchy engine', 'OK', '#D1FAE5')
        else:
            active_step = next(
                (
                    step
                    for step in sorted(approval_request.steps or [], key=lambda item: item.step_no)
                    if step.step_no == approval_request.current_step_no
                ),
                None,
            )
            t.workflow_status = 'step2_pending'
            _emit_tender_event(
                db,
                tender=t,
                event_key='step2_approval_requested',
                actor=current_user,
                approver_user_id=active_step.approver_user_id if active_step else None,
                requester_user_id=current_user.id,
            )
            _log(db, current_user.id, t.id, 'step2_submitted',
                 'Step 2 submitted for hierarchy approval', 'PENDING', '#FFF7ED')

    # Approval trigger for Step 3
    elif submit_step == 3:
        print(f"  [APPROVAL] step 3")
        if t.workflow_status in ('step3_pending', 'step3_active'):
            db.commit()
            return _serialize_tender(t, db)

        approval_request = create_generic_approval_request(
            db=db,
            tenant_id=_get_tenant_id(request),
            requester=current_user,
            module_key='tender',
            action_key='workings',
            record_id=t.id,
        )

        if (approval_request.status or "").strip().lower() == "approved":
            t.workflow_status    = 'step3_active'
            t.tender_status      = 'Submitted'
            t.listed_in_accounts = True
            if hasattr(t, 'step3_approved_at'):
                t.step3_approved_at = now_ist()
            _emit_tender_event(
                db,
                tender=t,
                event_key='step3_approved',
                actor=current_user,
            )
            _emit_tender_event(
                db,
                tender=t,
                event_key='submitted',
                actor=current_user,
            )
            _log(db, current_user.id, t.id, 'step3_auto_approved',
                 'Step 3 auto-approved by the hierarchy engine', 'OK', '#D1FAE5')
        else:
            active_step = next(
                (
                    step
                    for step in sorted(approval_request.steps or [], key=lambda item: item.step_no)
                    if step.step_no == approval_request.current_step_no
                ),
                None,
            )
            t.workflow_status = 'step3_pending'
            _emit_tender_event(
                db,
                tender=t,
                event_key='step3_approval_requested',
                actor=current_user,
                approver_user_id=active_step.approver_user_id if active_step else None,
                requester_user_id=current_user.id,
            )
            _log(db, current_user.id, t.id, 'step3_submitted',
                 'Step 3 submitted for hierarchy approval', 'PENDING', '#F3E8FF')

    # Approval trigger for Step 6
    elif submit_step == 6:
        existing_po_request = find_latest_request_for_record(
            db,
            module_key='tender',
            action_key='po_details',
            record_id=t.id,
        )
        if existing_po_request and (existing_po_request.status or "").strip().lower() == "pending":
            _log(db, current_user.id, t.id, 'po_updated_pending',
                 'PO Details updated while hierarchy approval is still pending', 'PENDING', '#F3E8FF')
        else:
            approval_request = create_generic_approval_request(
                db=db,
                tenant_id=_get_tenant_id(request),
                requester=current_user,
                module_key='tender',
                action_key='po_details',
                record_id=t.id,
            )

            if (approval_request.status or "").strip().lower() == "approved":
                t.po_workflow_status = 'approved'
                _log(db, current_user.id, t.id, 'po_auto_approved',
                     'PO Details auto-approved by the hierarchy engine', 'OK', '#D1FAE5')
            else:
                t.po_workflow_status = 'pending_approval'
                _log(db, current_user.id, t.id, 'po_submitted',
                     'PO Details submitted for hierarchy approval', 'PENDING', '#F3E8FF')

    elif submit_step in (1, 0):
        _log(db, current_user.id, t.id, f'step{submit_step or 1}_saved',
             f'Step {submit_step or 1} saved', 'SAVE', '#EFF6FF')
    elif submit_step in (4, 5, 7):
        _log(db, current_user.id, t.id, f'step{submit_step}_saved',
             f'Step {submit_step} saved', 'SAVE', '#EFF6FF')


    log_module_action(
        db=db, user_id=current_user.id, module="tenders", action="update",
        record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request),
        old_data=_before_update_snapshot, new_data=model_snapshot(t),
    )

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
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("tenders.update")),
):
    t = _get_or_404(db, tender_id, current_user)
    contents = await file.read()   # must await in async route before passing to sync helper
    path = _save_upload(request, file, contents=contents)
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
    request: Request,
    doc_type: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("tenders.update")),
):
    t = _get_or_404(db, tender_id, current_user)
    contents = await file.read()   # must await in async route before passing to sync helper
    size_kb  = len(contents) // 1024 if contents else None
    old_po_docs: list[TenderDocument] = []
    old_po_url = getattr(t, 'po_doc', None) if doc_type == 'PO Document' else None
    old_po_size = 0
    if old_po_url:
        try:
            old_po_size = stored_file_accounted_size(media_url_to_logical_path(
                root_dir=os.path.abspath(settings.MEDIA_ROOT),
                file_url=old_po_url,
            ))
        except Exception:
            old_po_size = 0
        old_po_docs = db.query(TenderDocument).filter(
            TenderDocument.tender_id == t.id,
            TenderDocument.doc_type == 'PO Document',
        ).all()
    path     = _save_upload(
        request,
        file,
        contents=contents,
        quota_existing_bytes=old_po_size if doc_type == 'PO Document' else None,
    )

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
    for old_doc in old_po_docs:
        db.delete(old_doc)
    db.add(TenderDocument(**doc_kwargs))
    _log(db, current_user.id, t.id, 'doc_uploaded',
         f"{doc_type} uploaded: {file.filename}", '📎', '#F0FFF4')
    db.commit()
    if old_po_url and old_po_url != path:
        try:
            delete_stored_file(media_url_to_logical_path(
                root_dir=os.path.abspath(settings.MEDIA_ROOT),
                file_url=old_po_url,
            ))
        except Exception:
            logger.warning("Failed to delete replaced PO document: %s", old_po_url, exc_info=True)
        tenant_slug = str(db.info.get("tenant_slug") or "").strip()
        if tenant_slug:
            refresh_tenant_storage_usage_for_slug(tenant_slug)
    db.refresh(t)
    return _serialize_tender(t, db)


# ─── DELETE /{tender_id}/documents/{doc_id} ───────────────────────────────────

@router.delete("/{tender_id}/documents/{doc_id}")
def delete_document(
    tender_id: int,
    doc_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("tenders.delete")),
):
    _get_or_404(db, tender_id, current_user)
    doc = db.query(TenderDocument).filter(
        TenderDocument.id == doc_id,
        TenderDocument.tender_id == tender_id,
    ).first()
    if not doc:
        raise HTTPException(404, "Document not found")
    if getattr(doc, "file_url", None):
        abs_path = media_url_to_logical_path(
            root_dir=os.path.abspath(settings.MEDIA_ROOT),
            file_url=doc.file_url,
        )
        delete_stored_file(abs_path)
    db.delete(doc)
    db.commit()
    tenant_slug = str(db.info.get("tenant_slug") or "").strip()
    if tenant_slug:
        refresh_tenant_storage_usage_for_slug(tenant_slug)
    return {"message": "Document deleted"}


# ─── POST /{tender_id}/submit-consignees ──────────────────────────────────────
@router.post("/{tender_id}/submit-consignees")
def submit_consignees(
    tender_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("tenders.update")),
):
    t = _get_or_404(db, tender_id, current_user)
    if t.result != 'Won':
        raise HTTPException(400, "Consignees can only be submitted for Won tenders")
    if getattr(t, 'po_workflow_status', 'draft') != 'approved':
        raise HTTPException(400, "PO Details must be approved before submitting consignees")
    t.consignee_submitted = True
    if (t.current_step or 1) < 7:
        t.current_step = 7
    _log(db, current_user.id, t.id, 'consignees_submitted',
         'Consignees submitted (Step 7 complete)', '✅', '#D1FAE5')

    # ── Auto-create WorkOrder if one doesn't already exist ────────────────
    existing_wo = db.query(WorkOrder).filter(WorkOrder.tender_id == t.id).first()
    if not existing_wo:
        from app.services.order_service import next_number   # Orders & Projects → Settings → Order number format
        wo_number = next_number(db, getattr(t, 'po_num', None))

        wo = WorkOrder(
            wo_number      = wo_number,
            tender_id      = t.id,
            customer_id    = t.customer_id,
            customer_name  = t.customer_name or '',
            project_title  = t.tender_title or t.portal_ref_number or '',
            po_number      = getattr(t, 'po_num', None) or '',
            po_value       = float(getattr(t, 'po_value', 0) or 0),
            wo_value       = float(getattr(t, 'bid_value', 0) or getattr(t, 'po_value', 0) or 0),
            delivery_date  = getattr(t, 'dlvry_date', None),
            status         = 'Draft',
            created_by     = current_user.id,
        )
        db.add(wo)
        db.flush()
        # mirror wo_number onto the tender so the WO list query can find it
        t.wrk_order_id = wo_number
        _log(db, current_user.id, t.id, 'workorder_created',
             f'Work Order {wo_number} auto-created from submitted tender', '📋', '#DBEAFE')

    db.commit()
    db.refresh(t)
    return _serialize_tender(t, db)


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
        if ceo_id and ceo_id != current_user.id:
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
            _emit_tender_event(
                db,
                tender=t,
                event_key='step2_approval_requested',
                actor=current_user,
                approver_user_id=ceo_id,
                requester_user_id=current_user.id,
            )
            _log(db, current_user.id, t.id, 'step2_mgr_approved',
                 'Manager approved Step 2; escalated to CEO', 'OK', '#F0FFF4')
        else:
            t.workflow_status    = 'active'
            t.listed_in_accounts = True
            if hasattr(t, 'step2_approved_at'):
                t.step2_approved_at = now_ist()
            _emit_tender_event(
                db,
                tender=t,
                event_key='step2_approved',
                actor=current_user,
            )
            _log(db, current_user.id, t.id, 'step2_mgr_auto_approved',
                 'Manager approved Step 2; no separate CEO approver configured', 'OK', '#F0FFF4')
    else:
        t.workflow_status = 'rejected'
        _emit_tender_event(
            db,
            tender=t,
            event_key='step2_rejected',
            actor=current_user,
            reason=notes,
        )
        _log(db, current_user.id, t.id, 'step2_mgr_rejected',
             f'Manager rejected Step 2: {notes}', 'ERR', '#FFF5F5')
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
        _emit_tender_event(
            db,
            tender=t,
            event_key='step2_approved',
            actor=current_user,
        )
        _log(db, current_user.id, t.id, 'step2_ceo_approved',
             'CEO approved Step 2 — tender active, listed in accounts', '🎉', '#F0FFF4')
    else:
        t.workflow_status = 'rejected'
        t.updated_at = now_ist()
        _emit_tender_event(
            db,
            tender=t,
            event_key='step2_rejected',
            actor=current_user,
            reason=notes,
        )
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
        if ceo_id and ceo_id != current_user.id:
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
            _emit_tender_event(
                db,
                tender=t,
                event_key='step3_approval_requested',
                actor=current_user,
                approver_user_id=ceo_id,
                requester_user_id=current_user.id,
            )
            _log(db, current_user.id, t.id, 'step3_mgr_approved',
                 'Manager approved Step 3; escalated to CEO', 'OK', '#F0FFF4')
        else:
            t.workflow_status    = 'step3_active'
            t.tender_status      = 'Submitted'
            t.listed_in_accounts = True
            if hasattr(t, 'step3_approved_at'):
                t.step3_approved_at = now_ist()
            _emit_tender_event(
                db,
                tender=t,
                event_key='step3_approved',
                actor=current_user,
            )
            _emit_tender_event(
                db,
                tender=t,
                event_key='submitted',
                actor=current_user,
            )
            _log(db, current_user.id, t.id, 'step3_mgr_auto_approved',
                 'Manager approved Step 3; no separate CEO approver configured', 'OK', '#F0FFF4')
    else:
        t.workflow_status = 'active'
        t.updated_at = now_ist()
        _emit_tender_event(
            db,
            tender=t,
            event_key='step3_rejected',
            actor=current_user,
            reason=notes,
        )
        _log(db, current_user.id, t.id, 'step3_mgr_rejected',
             f'Manager rejected Step 3: {notes}', 'ERR', '#FFF5F5')
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
        _emit_tender_event(
            db,
            tender=t,
            event_key='step3_approved',
            actor=current_user,
        )
        _emit_tender_event(
            db,
            tender=t,
            event_key='submitted',
            actor=current_user,
        )
        _log(db, current_user.id, t.id, 'step3_ceo_approved',
             'CEO approved Step 3 — status = Submitted, listed in accounts', '🏆', '#F0FFF4')
    else:
        t.workflow_status = 'active'
        t.updated_at = now_ist()
        _emit_tender_event(
            db,
            tender=t,
            event_key='step3_rejected',
            actor=current_user,
            reason=notes,
        )
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
    current_user: User = Depends(require_permission("tenders.delete")),
):
    t = _get_or_404(db, tender_id, current_user)
    before = model_snapshot(t)
    t.is_deleted = True
    from app.models.all_models import AuditLog
    db.add(AuditLog(user_id=current_user.id, module="tenders", action="delete",
        record_id=t.id, record_name=t.tender_title, old_data=before,
        description=f"Deleted {t.tender_title}", created_at=now_ist()))
    t.updated_at = now_ist()
    _log(db, current_user.id, t.id, 'deleted',
         f"Tender '{t.tender_title}' deleted", '🗑️', '#FFF5F5')
    db.commit()
    return {"message": "Tender deleted"}


# ─── Private helpers ───────────────────────────────────────────────────────────

def _get_or_404(db: Session, tender_id: int, user: Optional[User] = None) -> Tender:
    """Fetch a live tender. When *user* is given, the tender must also fall
    inside that user's configured Data Visibility for tenders (else 404)."""
    _ensure_tender_schema(db)
    q = db.query(Tender).filter(Tender.id == tender_id, Tender.is_deleted == False)
    if user is not None:
        q = apply_data_scope(db, q, user, "tenders", Tender.created_by, Tender.assigned_to)
    t = q.first()
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
                is_authorized     = getattr(o, "is_authorized", False),
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

