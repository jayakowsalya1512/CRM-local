"""
EMD/BG Finance Router — Enhanced v3
=====================================

WORKFLOW CHANGES (v3 — BG unified with EMD flow):

  Bank Guarantees now follow the exact same workflow as EMD/Tender Fee:
    Approved → Doc Uploaded (accounts) → Acknowledged (sales) → Payment Proof (accounts) → Paid (accounts)
    → [if Won/Lost] Upload Return Doc (sales) → Confirm Return (accounts)

  Specifically:
  1. upload_instrument_doc: accounts uploads for ALL instrument types (removed non-accounts branch for PBG)
  2. acknowledge_instrument_doc: now allowed for ALL types (removed EMD/TF restriction)
  3. upload_payment_proof: allowed for ALL types (was EMD/TF only)
  4. mark_emdbg_paid:
     - For ALL types: requires instrument_acknowledged_at before payment
     - For EMD/TF (non-PBG): also requires workings approval
     - For PBG: no workings check (PBG is post-award, workings already done)
  5. upload_return_doc: allowed for ALL types except Tender Fee (was EMD only)
  6. confirm_return: allowed for ALL types except Tender Fee

  "Active" status meaning:
    - Record created and in-progress (not yet Released/Encashed/Cancelled)
    - Expiry monitoring is only meaningful AFTER payment (finance_status='paid')

BUG FIXES carried over from v2:
  - Route ordering: /expiry-summary, /won-tenders, /from-tender/* before /{id}
  - NULL approval_status normalised to 'none'
  - Date arithmetic guarded against None expiry_date
"""

import logging
import os
from datetime import date, datetime, timezone
from app.core.timezone import now_ist, today_ist
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query, Request
from sqlalchemy.orm import Session
from sqlalchemy import func, text as sa_text, or_
from pydantic import BaseModel

from app.dependencies import get_tenant_db, get_current_user, require_permission
from app.models.all_models import (
    EMDBG, EMDBGRenewalHistory, User, ActivityLog, Alert,
    Approval, Tender, Customer, UserReportingHierarchy, OrgTreeNode,
    ApprovalRequest, ApprovalRequestStep, Lead, VerticalSector, LeadSource,
)
from app.services.cache_service import invalidate_badges_cache
from app.routers.approval_workflow_router import _apply_dynamic_request_side_effects
from app.services.generic_approval_engine import (
    create_generic_approval_request,
    decide_generic_approval_request,
    find_latest_request_for_record,
    find_pending_request_for_record,
    get_request_progress,
)
from app.services.dynamic_notification_service import emit_notification_event
from app.utils.file_storage import media_slug_from_request, save_upload_optimized
from app.utils.data_scope import get_module_data_scope, get_team_user_ids

logger = logging.getLogger(__name__)
router = APIRouter()


def _get_tenant_id(request: Request) -> Optional[int]:
    tenant = getattr(request.state, "tenant", None)
    tenant_id = getattr(tenant, "id", None)
    return int(tenant_id) if isinstance(tenant_id, int) else tenant_id


def _emit_emdbg_event(
    db: Session,
    *,
    record: EMDBG,
    event_key: str,
    actor: Optional[User],
    approver_user_id: Optional[int] = None,
    requester_user_id: Optional[int] = None,
    reason: Optional[str] = None,
    dedupe_key: Optional[str] = None,
) -> None:
    try:
        emit_notification_event(
            db,
            module_key="emdbg",
            event_key=event_key,
            record_id=record.id,
            actor_user_id=getattr(actor, "id", None),
            context={
                "reference_num": getattr(record, "reference_num", "") or "",
                "instrument_type": getattr(record, "instrument_type", "") or "",
                "amount": getattr(record, "amount", 0) or 0,
                "expiry_date": getattr(record, "expiry_date", None),
                "status": getattr(record, "status", "") or "",
                "creator_user_id": getattr(record, "created_by", None),
                "approver_user_id": approver_user_id,
                "requester_user_id": requester_user_id,
                "reason": reason or "",
                "record_ref": getattr(record, "reference_num", "") or "",
                "dedupe_key": dedupe_key or "",
            },
        )
    except Exception as exc:
        logger.warning("emdbg notification failed for record=%s event=%s: %s", record.id, event_key, exc)

MEDIA_ROOT       = os.environ.get("MEDIA_ROOT", "media")
EMDBG_UPLOAD_DIR = os.path.join(os.path.abspath(MEDIA_ROOT), "emdbg")
os.makedirs(EMDBG_UPLOAD_DIR, exist_ok=True)

ALLOWED_EXTENSIONS = {".pdf", ".doc", ".docx", ".jpg", ".jpeg", ".png", ".gif", ".webp"}

INSTRUMENT_TYPES = [
    "EMD", "Performance BG", "Security Deposit",
    "Advance BG", "Retention BG", "DD", "Online Payment",
    "EB",   # security deposit furnished to the Electricity Board for a site power connection
]

# Category helpers — mirrors frontend constants
TENDER_FEE_TYPES = {"DD", "Online Payment"}
EMD_TYPES        = {"EMD"}
PBG_TYPES        = {"Performance BG", "Security Deposit", "Advance BG", "Retention BG"}

MANAGER_ROLES    = ("admin", "ceo", "manager", "vp")
PRIVILEGED_ROLES = ("admin", "ceo")
ADMIN_SCOPE_ROLES = {"admin", "ceo", "super_admin"}

_schema_ready_dbs: set[int] = set()


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
    user_ids: set[int] = {int(user_id)}
    pending = [int(user_id)]
    while pending:
        current_id = pending.pop(0)
        rows = db.query(OrgTreeNode).filter(
            OrgTreeNode.is_active == True,
            OrgTreeNode.user_id.isnot(None),
            or_(
                OrgTreeNode.parent_user_id == current_id,
                OrgTreeNode.group_lead_id == current_id,
            ),
        ).all()
        for row in rows:
            uid = int(row.user_id)
            if uid not in user_ids:
                user_ids.add(uid)
                pending.append(uid)
    return sorted(user_ids)


def _emdbg_scope_user_ids(db: Session, current_user: User) -> Optional[list[int]]:
    """Return scoped user ID list for EMDBG records.

    Returns None for "all" scope (no filter), [] for "none",
    or a list of user IDs for "own"/"team".
    """
    scope = get_module_data_scope(db, current_user, "emdbg")

    if scope == "all":
        return None

    if scope == "none":
        return []

    if scope == "own":
        return [int(current_user.id)]

    return get_team_user_ids(db, int(current_user.id))


def _apply_emdbg_scope(q, db: Session, cu: User):
    """Filter an EMDBG query by the role's configured Data Visibility.

    The dropdown alone decides visibility for every role. Accounts are
    additionally narrowed to approved records (narrowing only, never widening).
    """
    scope_user_ids = _emdbg_scope_user_ids(db, cu)
    if scope_user_ids is not None:
        q = q.outerjoin(Tender, EMDBG.tender_id == Tender.id).filter(
            or_(EMDBG.created_by.in_(scope_user_ids), Tender.assigned_to.in_(scope_user_ids))
        )
    if cu.role == "accounts":
        q = q.filter(EMDBG.approval_status == "approved")
    return q


def _is_emdbg_approver(db: Session, cu: User, record_id: int) -> bool:
    """True when cu is (or was) an approver on an approval request for this record."""
    step = (
        db.query(ApprovalRequestStep.id)
        .join(ApprovalRequest, ApprovalRequest.id == ApprovalRequestStep.approval_request_id)
        .filter(
            ApprovalRequest.module_key == "emdbg",
            ApprovalRequest.record_id == record_id,
            ApprovalRequestStep.approver_user_id == cu.id,
        )
        .first()
    )
    if step:
        return True
    legacy = db.query(Approval.id).filter(
        Approval.module == "emdbg",
        Approval.record_id == record_id,
        Approval.requested_to == cu.id,
    ).first()
    return bool(legacy)


def _ensure_emdbg_access(db: Session, cu: User, e: EMDBG) -> None:
    """403 unless the record is inside cu's configured data scope (approvers excepted)."""
    scope_user_ids = _emdbg_scope_user_ids(db, cu)
    if scope_user_ids is not None:
        allowed = set(scope_user_ids)
        visible = e.created_by in allowed
        if not visible and e.tender_id:
            t = db.query(Tender.assigned_to).filter(Tender.id == e.tender_id).first()
            visible = bool(t and t[0] in allowed)
        if not visible and not _is_emdbg_approver(db, cu, e.id):
            raise HTTPException(403, "You do not have access to this record")
    if cu.role == "accounts" and _safe_approval_status(e.approval_status) != "approved":
        if not _is_emdbg_approver(db, cu, e.id):
            raise HTTPException(403, "You do not have access to this record")


def _ensure_emdbg_schema(db: Session) -> None:
    db_id = id(db.get_bind())
    if db_id in _schema_ready_dbs:
        return
    try:
        db.execute(sa_text("""
            ALTER TABLE emdbg
              ADD COLUMN IF NOT EXISTS `last_rejection_reason` TEXT NULL,
              ADD COLUMN IF NOT EXISTS `finance_status` VARCHAR(30) NOT NULL DEFAULT 'unpaid',
              ADD COLUMN IF NOT EXISTS `finance_paid_date` DATE NULL,
              ADD COLUMN IF NOT EXISTS `finance_paid_by` INT NULL,
              ADD COLUMN IF NOT EXISTS `finance_notes` TEXT NULL,
              ADD COLUMN IF NOT EXISTS `return_status` VARCHAR(30) NOT NULL DEFAULT 'none',
              ADD COLUMN IF NOT EXISTS `return_document_url` VARCHAR(500) NULL,
              ADD COLUMN IF NOT EXISTS `return_file_size_kb` INT NULL,
              ADD COLUMN IF NOT EXISTS `return_uploaded_by` INT NULL,
              ADD COLUMN IF NOT EXISTS `return_uploaded_at` DATETIME NULL,
              ADD COLUMN IF NOT EXISTS `return_confirmed_by` INT NULL,
              ADD COLUMN IF NOT EXISTS `return_confirmed_at` DATETIME NULL,
              ADD COLUMN IF NOT EXISTS `instrument_acknowledged_at` DATETIME NULL,
              ADD COLUMN IF NOT EXISTS `instrument_acknowledged_by` INT NULL,
              ADD COLUMN IF NOT EXISTS `payment_proof_url` VARCHAR(500) NULL,
              ADD COLUMN IF NOT EXISTS `payment_proof_size_kb` INT NULL
        """))
        db.commit()
        # Allow NULL expiry_date for Tender Fee and EMD instruments
        try:
            db.execute(sa_text("ALTER TABLE emdbg MODIFY COLUMN expiry_date DATE NULL"))
            db.commit()
        except Exception:
            db.rollback()
        _schema_ready_dbs.add(db_id)
    except Exception:
        db.rollback()
        raise


# ─── Pydantic schemas ─────────────────────────────────────────────────────────

class EMDBGCreate(BaseModel):
    tender_num:        str
    tender_id:         Optional[int]   = None
    client_name:       str
    customer_id:       Optional[int]   = None
    work_order_id:     Optional[int]   = None
    po_number:         Optional[str]   = None
    po_date:           Optional[date]  = None
    wo_value:          Optional[float] = None
    instrument_type:   str
    amount:            float
    bank_name:         Optional[str]   = None
    bank_branch:       Optional[str]   = None
    instrument_number: Optional[str]   = None
    issued_date:       Optional[date]  = None
    submitted_date:    Optional[date]  = None
    valid_from:        Optional[date]  = None
    expiry_date:       Optional[date]  = None
    purpose:           Optional[str]   = None
    notes:             Optional[str]   = None


class EMDBGUpdate(EMDBGCreate):
    pass


class RenewalIn(BaseModel):
    new_expiry_date: date
    new_reference:   Optional[str] = None
    notes:           Optional[str] = None


class ReleaseIn(BaseModel):
    release_date:      date
    release_reference: Optional[str] = None
    notes:             Optional[str] = None


class ReturnIn(BaseModel):
    return_date:      date
    return_reference: Optional[str] = None
    notes:            Optional[str] = None


class Decision(BaseModel):
    decision:         str
    notes:            Optional[str] = None
    rejection_reason: Optional[str] = None


class PaidIn(BaseModel):
    paid_date: Optional[date] = None
    notes: Optional[str] = None


class ReturnConfirmIn(BaseModel):
    confirmed_date: Optional[date] = None
    notes: Optional[str] = None


# ─── Helpers ──────────────────────────────────────────────────────────────────
def _ref_num(db: Session) -> str:
    prefix = now_ist().strftime("EMDBG-%Y%m-")

    row = db.execute(
        sa_text("""
            SELECT MAX(CAST(SUBSTRING(reference_num, :offset) AS UNSIGNED))
            FROM emdbg
            WHERE reference_num LIKE :prefix
        """),
        {
            "offset": len(prefix) + 1,
            "prefix": f"{prefix}%",
        },
    ).fetchone()

    last_num = row[0] if row and row[0] else 0
    return f"{prefix}{last_num + 1:04d}"


def _days_to_expiry(expiry_date) -> Optional[int]:
    if not expiry_date:
        return None
    try:
        return (expiry_date - today_ist()).days
    except Exception:
        return None


def _expiry_status(days: Optional[int]) -> str:
    if days is None:
        return "Unknown"
    if days < 0:
        return "Expired"
    if days <= 7:
        return "Critical"
    if days <= 30:
        return "Warning"
    return "OK"


def _safe_approval_status(val) -> str:
    """DB default is NULL; normalise to 'none' for frontend."""
    if val is None:
        return "none"
    return val


def _normalize_segment_name(value: Optional[str]) -> Optional[str]:
    """Customer.customer_vertical is free text, not FK-constrained — collapse
    whitespace / non-breaking spaces so "State Government" and "State Government "
    (or with a stray \\u00a0) don't split into separate analytics buckets."""
    if not isinstance(value, str):
        return value
    cleaned = " ".join(value.replace(chr(160), " ").split()).strip()
    return cleaned or None


def _customer_sub_segment(customer: Optional[Customer]) -> Optional[str]:
    if not customer:
        return None
    custom_data = getattr(customer, "custom_data", None) or {}
    candidates = [
        custom_data.get("sub_segment") if isinstance(custom_data, dict) else None,
        custom_data.get("customer_sub_segment") if isinstance(custom_data, dict) else None,
        custom_data.get("subsegment") if isinstance(custom_data, dict) else None,
        custom_data.get("customer_segment_child") if isinstance(custom_data, dict) else None,
        custom_data.get("customer_vertical_sub_segment") if isinstance(custom_data, dict) else None,
        custom_data.get("vertical_sub_sector_name") if isinstance(custom_data, dict) else None,
        getattr(customer, "division", None),
    ]
    for value in candidates:
        normalized = _normalize_segment_name(value)
        if normalized:
            return normalized
    return None


def _is_pbg(record: EMDBG) -> bool:
    return getattr(record, "instrument_type", None) in PBG_TYPES


def _is_tender_fee(record: EMDBG) -> bool:
    return getattr(record, "instrument_type", None) in TENDER_FEE_TYPES


def _has_return_flow(record: EMDBG) -> bool:
    """Return flow applies to EMD and PBG — NOT Tender Fee."""
    return not _is_tender_fee(record)


def _build_enrich_maps(rows: list, db: Session) -> dict:
    """Pre-load all related data for a batch of EMDBG rows — eliminates N+1 queries in list endpoints."""
    if not rows:
        return {"tenders": {}, "users": {}, "customers": {}, "approvals": {}, "approval_steps": {},
                "renewal_counts": {}, "business_verticals": {}, "business_vertical_categories": {},
                "lead_sources": {}}

    emdbg_ids    = {r.id for r in rows}
    tender_ids   = {r.tender_id for r in rows if r.tender_id}
    customer_ids = {r.customer_id for r in rows if r.customer_id}

    tenders = db.query(Tender).filter(Tender.id.in_(tender_ids)).all() if tender_ids else []
    tender_map: dict = {t.id: t for t in tenders}

    lead_ids = {t.lead_id for t in tenders if t.lead_id}
    leads = db.query(Lead).filter(Lead.id.in_(lead_ids)).all() if lead_ids else []
    lead_map: dict = {l.id: l for l in leads}

    bv_ids = {l.business_vertical_id for l in leads if l.business_vertical_id}
    bv_ids |= {t.business_vertical_id for t in tenders if t.business_vertical_id}
    bv_name_map: dict = {}
    bv_category_map: dict = {}
    if bv_ids:
        try:
            id_csv = ", ".join(str(int(i)) for i in bv_ids)
            bv_result = db.execute(
                sa_text(
                    "SELECT u.id, COALESCE(u.business_unit, u.business_vertical) AS vname, "
                    "COALESCE(c.business_vertical, c.business_unit) AS cname "
                    "FROM business_category_units u "
                    "LEFT JOIN business_category_units c ON c.id = u.parent_category_id "
                    f" AND c.item_type = 'category' WHERE u.id IN ({id_csv})"
                )
            ).mappings().all()
            for row in bv_result:
                bv_name_map[row["id"]] = (row["vname"] or "").strip() or f"Vertical {row['id']}"
                bv_category_map[row["id"]] = (row["cname"] or "").strip() or None
        except Exception:
            pass

    lead_source_ids = {l.source_id for l in leads if l.source_id}
    lead_source_map: dict = {}
    if lead_source_ids:
        for ls in db.query(LeadSource).filter(LeadSource.id.in_(lead_source_ids)).all():
            lead_source_map[ls.id] = ls.name

    # tender_id -> business vertical name / category / lead source.
    # Business vertical: prefer the Tender's own field (works for direct tenders too);
    # fall back to the linked Lead's business_vertical_id for older/lead-converted tenders.
    business_vertical_map: dict = {}
    business_vertical_category_map: dict = {}
    lead_source_by_tender: dict = {}
    for t in tenders:
        lead = lead_map.get(t.lead_id) if t.lead_id else None
        bv_id = t.business_vertical_id or (lead.business_vertical_id if lead else None)
        if bv_id:
            business_vertical_map[t.id] = bv_name_map.get(bv_id, f"Vertical {bv_id}")
            if bv_category_map.get(bv_id):
                business_vertical_category_map[t.id] = bv_category_map[bv_id]
        if lead and lead.source_id:
            lead_source_by_tender[t.id] = lead_source_map.get(lead.source_id)

    user_ids: set = set()
    for r in rows:
        for uid in (r.created_by, r.finance_paid_by, r.return_uploaded_by,
                    r.return_confirmed_by, r.instrument_acknowledged_by):
            if uid:
                user_ids.add(int(uid))
    for t in tenders:
        if t.assigned_to:
            user_ids.add(int(t.assigned_to))

    approval_rows = db.query(ApprovalRequest).filter(
        ApprovalRequest.module_key == "emdbg",
        ApprovalRequest.action_key == "release",
        ApprovalRequest.record_id.in_(emdbg_ids),
    ).order_by(ApprovalRequest.requested_at.desc()).all() if emdbg_ids else []

    approval_map: dict = {}
    for ar in approval_rows:
        if ar.record_id not in approval_map:
            approval_map[ar.record_id] = ar

    request_ids = {ar.id for ar in approval_map.values()}
    all_steps = db.query(ApprovalRequestStep).filter(
        ApprovalRequestStep.approval_request_id.in_(request_ids)
    ).order_by(ApprovalRequestStep.step_no.asc()).all() if request_ids else []

    steps_by_request: dict = {}
    for step in all_steps:
        steps_by_request.setdefault(int(step.approval_request_id), []).append(step)
        if step.approver_user_id:
            user_ids.add(int(step.approver_user_id))

    users = db.query(User).filter(User.id.in_(user_ids)).all() if user_ids else []
    user_map: dict = {u.id: u for u in users}

    customers = db.query(Customer).filter(Customer.id.in_(customer_ids)).all() if customer_ids else []
    customer_map: dict = {c.id: c for c in customers}

    renewal_counts: dict = {}
    if emdbg_ids:
        for emdbg_id, cnt in db.query(
            EMDBGRenewalHistory.emdbg_id, func.count(EMDBGRenewalHistory.id)
        ).filter(EMDBGRenewalHistory.emdbg_id.in_(emdbg_ids)).group_by(EMDBGRenewalHistory.emdbg_id).all():
            renewal_counts[int(emdbg_id)] = int(cnt)

    return {
        "tenders": tender_map,
        "users": user_map,
        "customers": customer_map,
        "approvals": approval_map,
        "approval_steps": steps_by_request,
        "renewal_counts": renewal_counts,
        "business_verticals": business_vertical_map,
        "business_vertical_categories": business_vertical_category_map,
        "lead_sources": lead_source_by_tender,
    }


def _enrich(r: EMDBG, db: Session, *, _maps: Optional[dict] = None) -> dict:
    d = {c.name: getattr(r, c.name) for c in r.__table__.columns}

    # Normalise NULL approval_status → 'none'
    d["approval_status"] = _safe_approval_status(r.approval_status)

    # Tender Fee is non-refundable — once paid it is permanently released.
    # Correct any legacy records that were paid before the auto-release existed.
    if _is_tender_fee(r) and d.get("finance_status") == "paid" and d.get("status") == "Active":
        d["status"] = "Released"
        if not d.get("release_date"):
            d["release_date"] = d.get("finance_paid_date")
        # persist the correction so it doesn't recur
        try:
            r.status = "Released"
            if not r.release_date:
                r.release_date = r.finance_paid_date
            db.commit()
        except Exception:
            db.rollback()

    # Approval request — use pre-loaded maps to skip per-record queries in list context
    if _maps is not None:
        latest_request = _maps.get("approvals", {}).get(r.id)
    else:
        latest_request = find_latest_request_for_record(
            db,
            module_key="emdbg",
            action_key="release",
            record_id=r.id,
        )
    if latest_request:
        if _maps is not None:
            steps_sorted = _maps.get("approval_steps", {}).get(latest_request.id, [])
            total_steps = len(steps_sorted)
            approved_steps = sum(1 for s in steps_sorted if (s.status or "").strip().lower() == "approved")
            norm_status = (latest_request.status or "").strip().lower() or "pending"
            if norm_status == "approved":
                approved_steps = total_steps or approved_steps
            status_label = {"pending": "Pending", "approved": "Approved", "rejected": "Rejected"}.get(norm_status, norm_status.title())
            progress = {
                "current": approved_steps,
                "total": total_steps,
                "display": f"{status_label} ({approved_steps}/{total_steps})" if total_steps else status_label,
            }
        else:
            steps_sorted = sorted(latest_request.steps or [], key=lambda item: item.step_no)
            progress = get_request_progress(latest_request)
        active_step = next(
            (step for step in steps_sorted if step.step_no == latest_request.current_step_no),
            None,
        )
        d["approval_request_id"] = latest_request.id
        d["approval_status"] = latest_request.status
        d["approval_display"] = progress["display"]
        d["approval_progress_current"] = progress["current"]
        d["approval_progress_total"] = progress["total"]
        d["approval_requested_to"] = active_step.approver_user_id if active_step else None
        if _maps is not None and active_step and active_step.approver_user_id:
            approver = _maps.get("users", {}).get(active_step.approver_user_id)
            d["approval_requested_to_name"] = approver.full_name if approver else ""
        else:
            d["approval_requested_to_name"] = (
                active_step.approver.full_name if active_step and active_step.approver else ""
            )
    else:
        d["approval_request_id"] = None
        d["approval_display"] = {
            "pending": "Pending",
            "approved": "Approved",
            "rejected": "Rejected",
            "none": "None",
        }.get(d["approval_status"], d["approval_status"])
        d["approval_progress_current"] = None
        d["approval_progress_total"] = None
        d["approval_requested_to"] = None
        d["approval_requested_to_name"] = ""

    days = _days_to_expiry(r.expiry_date)
    d["days_to_expiry"]     = days
    d["days_to_expiry_abs"] = abs(days) if days is not None else None
    d["expiry_status"]      = _expiry_status(days)
    # Released records are no longer active — stop expiry tracking
    if d.get("status") == "Released":
        d["expiry_status"] = "Released"

    # Tender title + workings check + sales person (primary source)
    sales_person_id = None
    if r.tender_id:
        t = (_maps.get("tenders", {}).get(r.tender_id) if _maps is not None else None) or (
            db.query(Tender).filter(Tender.id == r.tender_id).first()
        )
        d["tender_title"]       = t.tender_title if t else ""
        d["tender_num_display"] = t.tender_num   if t else (r.tender_num or "")
        d["tender_result"]      = t.result       if t else ""
        # workings_approved — only relevant for non-PBG types
        if not _is_pbg(r):
            d["workings_approved"] = bool(t) and (
                getattr(t, 'workflow_status', '') == 'step3_active' or
                getattr(t, 'result', '') in ('Won', 'Lost')
            )
        else:
            # PBG: workings already done at tender award stage — no restriction
            d["workings_approved"] = True
        # Sales person = tender's assigned_to
        sales_person_id = getattr(t, "assigned_to", None) if t else None
        # Business vertical / category / lead source.
        # Business vertical prefers the Tender's own field (works for direct tenders);
        # falls back to the linked Lead's business_vertical_id for lead-converted tenders.
        if _maps is not None:
            d["business_vertical"]          = _maps.get("business_verticals", {}).get(r.tender_id)
            d["business_vertical_category"] = _maps.get("business_vertical_categories", {}).get(r.tender_id)
            d["lead_source"]                = _maps.get("lead_sources", {}).get(r.tender_id)
        else:
            lead = db.query(Lead).filter(Lead.id == t.lead_id).first() if t and t.lead_id else None
            bv_id = (getattr(t, "business_vertical_id", None) if t else None) or (lead.business_vertical_id if lead else None)
            if bv_id:
                bv_row = db.execute(
                    sa_text(
                        "SELECT COALESCE(u.business_unit, u.business_vertical) AS vname, "
                        "COALESCE(c.business_vertical, c.business_unit) AS cname "
                        "FROM business_category_units u "
                        "LEFT JOIN business_category_units c ON c.id = u.parent_category_id "
                        " AND c.item_type = 'category' WHERE u.id = :bv_id"
                    ),
                    {"bv_id": bv_id},
                ).mappings().first()
                d["business_vertical"] = (bv_row["vname"].strip() if bv_row and bv_row["vname"] else None) or f"Vertical {bv_id}"
                d["business_vertical_category"] = (bv_row["cname"].strip() if bv_row and bv_row["cname"] else None)
            else:
                d["business_vertical"] = None
                d["business_vertical_category"] = None
            if lead and lead.source_id:
                ls = db.query(LeadSource).filter(LeadSource.id == lead.source_id).first()
                d["lead_source"] = ls.name if ls else None
            else:
                d["lead_source"] = None
    else:
        d["tender_title"]       = ""
        d["tender_num_display"] = r.tender_num or ""
        d["tender_result"]      = ""
        d["workings_approved"]  = True  # no linked tender — no restriction
        d["business_vertical"]  = None
        d["business_vertical_category"] = None
        d["lead_source"]        = None

    # Sales person details
    # Primary: Tender.assigned_to — the person responsible for this tender/instrument
    # Fallback: EMDBG.created_by  — whoever created the record manually
    _sp_id = sales_person_id or r.created_by
    if _sp_id:
        sp = (_maps.get("users", {}).get(_sp_id) if _maps is not None else None) or (
            db.query(User).filter(User.id == _sp_id).first()
        )
        d["sales_person_id"]    = _sp_id
        d["sales_person_name"]  = sp.full_name  if sp else ""
        d["sales_person_email"] = sp.email      if sp else ""
        d["sales_person_phone"] = getattr(sp, "phone", None) or getattr(sp, "mobile", None) or ""
        d["sales_person_role"]  = sp.role       if sp else ""
    else:
        d["sales_person_id"]    = None
        d["sales_person_name"]  = ""
        d["sales_person_email"] = ""
        d["sales_person_phone"] = ""
        d["sales_person_role"]  = ""

    # Customer name + segment
    if r.customer_id:
        c = (_maps.get("customers", {}).get(r.customer_id) if _maps is not None else None) or (
            db.query(Customer).filter(Customer.id == r.customer_id).first()
        )
        d["customer_name_display"] = c.customer_name if c else r.client_name
        d["customer_segment"] = _normalize_segment_name(c.customer_vertical) if c else None
        d["customer_sub_segment"] = _customer_sub_segment(c)
    else:
        d["customer_name_display"] = r.client_name
        d["customer_segment"] = None
        d["customer_sub_segment"] = None

    # Created by
    if r.created_by:
        u = (_maps.get("users", {}).get(r.created_by) if _maps is not None else None) or (
            db.query(User).filter(User.id == r.created_by).first()
        )
        d["created_by_name"] = u.full_name if u else ""
    else:
        d["created_by_name"] = ""

    # Instrument acknowledgment
    d["instrument_acknowledged"] = bool(getattr(r, "instrument_acknowledged_at", None))
    d["payment_proof_url"] = getattr(r, "payment_proof_url", None)

    for key, source_id in [
        ("finance_paid_by_name",        getattr(r, "finance_paid_by",             None)),
        ("return_uploaded_by_name",     getattr(r, "return_uploaded_by",          None)),
        ("return_confirmed_by_name",    getattr(r, "return_confirmed_by",         None)),
        ("acknowledged_by_name",        getattr(r, "instrument_acknowledged_by",  None)),
    ]:
        if source_id:
            u = (_maps.get("users", {}).get(source_id) if _maps is not None else None) or (
                db.query(User).filter(User.id == source_id).first()
            )
            d[key] = u.full_name if u else ""
        else:
            d[key] = ""

    # Renewal count
    if _maps is not None:
        d["renewal_count"] = _maps.get("renewal_counts", {}).get(r.id, 0)
    else:
        d["renewal_count"] = db.query(EMDBGRenewalHistory).filter(
            EMDBGRenewalHistory.emdbg_id == r.id
        ).count()

    return d


def _save_file(request: Request, file: UploadFile, contents: bytes) -> tuple[str, int]:
    """Save uploaded file, return (relative_url, size_kb)."""
    ext = os.path.splitext(file.filename or "")[-1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"File type '{ext}' not allowed.")
    saved = save_upload_optimized(
        root_dir=os.path.abspath(MEDIA_ROOT),
        subfolder="emdbg",
        original_filename=file.filename,
        contents=contents,
        media_slug=media_slug_from_request(request),
        content_type=file.content_type,
    )
    return saved.url, saved.size_kb


# ═══════════════════════════════════════════════════════════════════════════════
#  LITERAL-PATH ROUTES  — must come BEFORE /{id} to avoid 422
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/master-options")
def emdbg_master_options(
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    """Master lists for the Analytics tab — Customer Segment (VerticalSector) and
    Business Vertical (business_category_units), independent of what's present
    in the currently loaded EMDBG records."""
    segments = db.query(VerticalSector).filter(VerticalSector.is_active == True).order_by(
        VerticalSector.display_order, VerticalSector.name, VerticalSector.id,
    ).all()

    try:
        bv_rows = db.execute(sa_text(
            "SELECT u.id, u.business_unit AS name, c.business_vertical AS subtitle "
            "FROM business_category_units u "
            "INNER JOIN business_category_units c ON c.id = u.parent_category_id "
            "  AND c.item_type = 'category' AND c.is_active = 1 "
            "WHERE u.item_type = 'unit' AND u.business_unit IS NOT NULL AND u.is_active = 1 "
            "ORDER BY c.display_order, c.business_vertical, u.display_order, u.business_unit, u.id"
        )).fetchall()
        business_verticals = [{"id": r[0], "name": r[1], "subtitle": r[2]} for r in bv_rows]
    except Exception:
        business_verticals = []

    return {
        "segments": [{"id": s.id, "name": _normalize_segment_name(s.name)} for s in segments],
        "business_verticals": business_verticals,
    }


@router.get("/expiry-summary")
def expiry_summary(
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("emdbg.view")),
):
    _ensure_emdbg_schema(db)
    _lazy_approve_step2_emdbg(db)
    today = today_ist()
    q     = _apply_emdbg_scope(db.query(EMDBG).filter(EMDBG.status == "Active"), db, cu)
    active = q.all()

    # Expiry stats only meaningful for paid instruments
    paid_active = [e for e in active if getattr(e, 'finance_status', 'unpaid') == 'paid']

    expired  = [e for e in paid_active if e.expiry_date and e.expiry_date <  today]
    critical = [e for e in paid_active if e.expiry_date and 0 <= (e.expiry_date - today).days <= 7]
    warning  = [e for e in paid_active if e.expiry_date and 7 < (e.expiry_date - today).days <= 30]
    healthy  = [e for e in paid_active if e.expiry_date and (e.expiry_date - today).days > 30]

    total_amount = sum(float(e.amount or 0) for e in active)

    by_type: dict = {}
    for t in INSTRUMENT_TYPES:
        by_type[t] = sum(float(e.amount or 0) for e in active if e.instrument_type == t)

    won_tender_linked = 0
    try:
        won_ids = {
            r[0] for r in db.query(EMDBG.id).join(
                Tender, EMDBG.tender_id == Tender.id
            ).filter(Tender.result == "Won", EMDBG.status == "Active").all()
        }
        won_tender_linked = sum(1 for e in active if e.id in won_ids)
    except Exception:
        pass

    returned_count = _apply_emdbg_scope(
        db.query(EMDBG).filter(EMDBG.status == "Released"), db, cu
    ).count()

    return {
        "total_active":      len(active),
        "expired":           len(expired),
        "critical_7d":       len(critical),
        "warning_30d":       len(warning),
        "healthy":           len(healthy),
        "total_amount":      total_amount,
        "won_tender_linked": won_tender_linked,
        "by_type":           by_type,
        "returned_count":    returned_count,
        "pending_approval":  _apply_emdbg_scope(
            db.query(EMDBG).filter(EMDBG.approval_status == "pending"), db, cu
        ).count(),
    }


@router.get("/won-tenders")
def won_tenders_for_emdbg(
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("emdbg.view")),
):
    q = db.query(Tender).filter(Tender.result == "Won", Tender.is_deleted == False)
    if cu.role == "sales":
        q = q.filter(Tender.assigned_to == cu.id)
    tenders = q.order_by(Tender.updated_at.desc()).limit(100).all()

    tender_ids_list = [t.id for t in tenders]
    emdbg_count_map: dict = {}
    if tender_ids_list:
        for _tid, _cnt in db.query(EMDBG.tender_id, func.count(EMDBG.id)).filter(
            EMDBG.tender_id.in_(tender_ids_list)
        ).group_by(EMDBG.tender_id).all():
            emdbg_count_map[int(_tid)] = int(_cnt)
    out = []
    for t in tenders:
        existing_count = emdbg_count_map.get(t.id, 0)
        out.append({
            "id":              t.id,
            "tender_num":      t.tender_num,
            "tender_title":    t.tender_title,
            "customer_name":   t.customer_name,
            "customer_id":     t.customer_id,
            "emd_required":    bool(getattr(t, "emd_required", False)),
            "emd_amount":      float(t.emd_amount) if getattr(t, "emd_amount", None) else None,
            "pbg_required":    bool(getattr(t, "pbg_required", False)),
            "pbg_amount":      float(t.pbg_amount) if getattr(t, "pbg_amount", None) else None,
            "bid_amount":      float(t.bid_amount) if t.bid_amount else None,
            "existing_emdbg":  existing_count,
            "needs_attention": existing_count == 0 and (
                bool(getattr(t, "emd_required", False)) or bool(getattr(t, "pbg_required", False))
            ),
        })
    return out


@router.get("/from-tender/{tender_id}")
def list_by_tender(
    tender_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("emdbg.view")),
):
    rows = _apply_emdbg_scope(db.query(EMDBG).filter(EMDBG.tender_id == tender_id), db, cu).all()
    _maps = _build_enrich_maps(rows, db)
    return [_enrich(r, db, _maps=_maps) for r in rows]


@router.get("/from-tender/{tender_id}/prefill")
def prefill_from_tender(
    tender_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("emdbg.view")),
):
    t = db.query(Tender).filter(Tender.id == tender_id).first()
    if not t:
        raise HTTPException(404, "Tender not found")
    if t.result != "Won":
        raise HTTPException(400, "EMDBG tracking is only available for Won tenders")

    suggestions = []
    if getattr(t, "emd_required", False) and getattr(t, "emd_amount", None):
        suggestions.append({
            "instrument_type": "EMD",
            "amount":          float(t.emd_amount),
            "notes":           f"EMD for tender {t.tender_num}",
        })
    if getattr(t, "pbg_required", False) and getattr(t, "pbg_amount", None):
        suggestions.append({
            "instrument_type": "Performance BG",
            "amount":          float(t.pbg_amount),
            "notes":           f"Performance BG for tender {t.tender_num}",
        })

    return {
        "tender_id":    t.id,
        "tender_num":   t.tender_num,
        "tender_title": t.tender_title,
        "customer_id":  t.customer_id,
        "client_name":  t.customer_name,
        "suggestions":  suggestions,
        "emd_amount":   float(t.emd_amount) if getattr(t, "emd_amount", None) else None,
        "pbg_amount":   float(t.pbg_amount) if getattr(t, "pbg_amount", None) else None,
    }


# ═══════════════════════════════════════════════════════════════════════════════
#  COLLECTION ROUTES
# ═══════════════════════════════════════════════════════════════════════════════

def _lazy_approve_step2_emdbg(db: Session) -> None:
    """Auto-approve EMDBG records linked to tenders where step 2 is fully approved."""
    try:
        from sqlalchemy import text as _t
        try:
            db.execute(_t("ALTER TABLE tenders ADD COLUMN IF NOT EXISTS `listed_in_accounts` TINYINT(1) NOT NULL DEFAULT 0"))
            db.commit()
        except Exception:
            db.rollback()

        db.execute(_t("""
            UPDATE emdbg e
            JOIN tenders t ON t.id = e.tender_id
            SET e.approval_status = 'approved'
            WHERE t.listed_in_accounts = 1
              AND (e.approval_status IS NULL OR e.approval_status IN ('none', 'pending'))
        """))
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.warning("lazy_approve_step2_emdbg failed: %s", exc)


@router.get("")
def list_emdbg(
    instrument_type: Optional[str] = None,
    status:          Optional[str] = None,
    expiry_filter:   Optional[str] = None,
    tender_id:       Optional[int] = None,
    customer_id:     Optional[int] = None,
    search:          Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("emdbg.view")),
):
    _ensure_emdbg_schema(db)
    _lazy_approve_step2_emdbg(db)
    q = _apply_emdbg_scope(db.query(EMDBG), db, cu)

    if instrument_type: q = q.filter(EMDBG.instrument_type == instrument_type)
    if status:          q = q.filter(EMDBG.status == status)
    if tender_id:       q = q.filter(EMDBG.tender_id == tender_id)
    if customer_id:     q = q.filter(EMDBG.customer_id == customer_id)
    if search:
        like = f"%{search}%"
        q = q.filter(
            EMDBG.reference_num.ilike(like) |
            EMDBG.client_name.ilike(like) |
            EMDBG.tender_num.ilike(like) |
            EMDBG.instrument_number.ilike(like)
        )

    rows = q.order_by(EMDBG.expiry_date.asc()).all()
    _maps = _build_enrich_maps(rows, db)
    out  = []
    for r in rows:
        d = _enrich(r, db, _maps=_maps)
        if expiry_filter:
            es = d["expiry_status"]
            if expiry_filter == "critical" and es != "Critical":                   continue
            if expiry_filter == "warning"  and es not in ("Warning", "Critical"):  continue
            if expiry_filter == "expired"  and es != "Expired":                    continue
        out.append(d)
    return out


@router.post("", status_code=201)
def create_emdbg(
    data: EMDBGCreate,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("emdbg.create")),
):
    _ensure_emdbg_schema(db)
    vcols = {c.name for c in EMDBG.__table__.columns}
    kw = dict(
        reference_num     = _ref_num(db),
        tender_num        = data.tender_num,
        tender_id         = data.tender_id,
        client_name       = data.client_name,
        customer_id       = data.customer_id,
        instrument_type   = data.instrument_type,
        amount            = data.amount,
        bank_name         = data.bank_name,
        bank_branch       = data.bank_branch,
        instrument_number = data.instrument_number,
        issued_date       = data.issued_date,
        submitted_date    = data.submitted_date,
        valid_from        = data.valid_from,
        expiry_date       = data.expiry_date,
        purpose           = data.purpose,
        notes             = data.notes,
        status            = "Active",
        approval_status   = "none",
        finance_status    = "unpaid",
        return_status     = "none",
        created_by        = cu.id,
    )
    for col_name, val in [
        ("work_order_id", data.work_order_id),
        ("po_number",     data.po_number),
        ("po_date",       data.po_date),
        ("wo_value",      data.wo_value),
    ]:
        if col_name in vcols:
            kw[col_name] = val

    e = EMDBG(**{k: v for k, v in kw.items() if k in vcols})
    db.add(e)
    db.flush()
    db.add(ActivityLog(
        user_id=cu.id, module="emdbg", record_id=e.id, action="created",
        description=f"{data.instrument_type} {e.reference_num} created. Expiry: {data.expiry_date}",
        icon="🏦", color="#EFF6FF",
    ))
    _emit_emdbg_event(db, record=e, event_key="created", actor=cu)
    db.commit()
    db.refresh(e)
    return _enrich(e, db)


# ─── Badge / mark-seen ────────────────────────────────────────────────────────

@router.get("/badge")
def get_emdbg_badge(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    _ensure_emdbg_schema(db)
    layout = dict(cu.dashboard_layout or {})
    last_seen_str = layout.get("emdbg_last_seen_at")
    if not last_seen_str:
        layout["emdbg_last_seen_at"] = now_ist().isoformat()
        cu.dashboard_layout = layout; db.commit()
        return {"count": 0}
    try:
        last_seen = datetime.fromisoformat(last_seen_str)
    except ValueError:
        return {"count": 0}

    q = _apply_emdbg_scope(
        db.query(func.count(EMDBG.id)).filter(EMDBG.created_at > last_seen), db, cu
    )

    count = q.scalar() or 0
    return {"count": count}


@router.post("/mark-seen")
def mark_emdbg_seen(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    layout = dict(cu.dashboard_layout or {})
    layout["emdbg_last_seen_at"] = now_ist().isoformat()
    cu.dashboard_layout = layout; db.commit()
    invalidate_badges_cache(db, cu.id)
    return {"ok": True}


# ─── Per-user list-table display preferences (EMD/BG list only) ─────────────

class EmdbgTablePrefsBody(BaseModel):
    stack_order: dict = {}


@router.get("/table-prefs")
def get_emdbg_table_prefs(
    cu: User = Depends(get_current_user),
):
    layout = dict(cu.dashboard_layout or {})
    return layout.get("table_prefs", {}).get("emdbg-list", {"stack_order": {}})


@router.post("/table-prefs")
def save_emdbg_table_prefs(
    body: EmdbgTablePrefsBody,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    layout = dict(cu.dashboard_layout or {})
    table_prefs = dict(layout.get("table_prefs", {}))
    table_prefs["emdbg-list"] = {"stack_order": body.stack_order}
    layout["table_prefs"] = table_prefs
    cu.dashboard_layout = layout
    db.commit()
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════════════════════
#  ITEM ROUTES
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/{id}")
def get_emdbg(
    id: int,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("emdbg.view")),
):
    _ensure_emdbg_schema(db)
    e = db.query(EMDBG).filter(EMDBG.id == id).first()
    if not e:
        raise HTTPException(404, "Not found")
    _ensure_emdbg_access(db, cu, e)
    return _enrich(e, db)


@router.put("/{id}")
def update_emdbg(
    id:   int,
    data: EMDBGUpdate,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("emdbg.update")),
):
    _ensure_emdbg_schema(db)
    e = db.query(EMDBG).filter(EMDBG.id == id).first()
    if not e:
        raise HTTPException(404, "Not found")
    _ensure_emdbg_access(db, cu, e)
    if _safe_approval_status(e.approval_status) in ("pending", "approved") and cu.role not in PRIVILEGED_ROLES:
        raise HTTPException(400, "This record is locked after approval request.")

    vcols = {c.name for c in EMDBG.__table__.columns}
    for field in [
        "tender_num", "tender_id", "client_name", "customer_id",
        "instrument_type", "amount", "bank_name", "bank_branch",
        "instrument_number", "issued_date", "submitted_date",
        "valid_from", "expiry_date", "purpose", "notes",
        "work_order_id", "po_number", "po_date", "wo_value",
    ]:
        if field in vcols and hasattr(data, field):
            setattr(e, field, getattr(data, field))


    db.add(ActivityLog(
        user_id=cu.id, module="emdbg", record_id=id, action="updated",
        description=f"{e.reference_num} updated",
        icon="✏️", color="#EFF6FF",
    ))
    db.commit()
    db.refresh(e)
    return _enrich(e, db)


@router.get("/{id}/renewals")
def list_renewals(
    id: int,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("emdbg.view")),
):
    e = db.query(EMDBG).filter(EMDBG.id == id).first()
    if not e:
        raise HTTPException(404, "Not found")
    _ensure_emdbg_access(db, cu, e)
    history = db.query(EMDBGRenewalHistory).filter(
        EMDBGRenewalHistory.emdbg_id == id
    ).order_by(EMDBGRenewalHistory.created_at.desc()).all()
    renewed_by_ids = {h.renewed_by for h in history if h.renewed_by}
    user_map: dict = {
        u.id: u for u in db.query(User).filter(User.id.in_(renewed_by_ids)).all()
    } if renewed_by_ids else {}
    out = []
    for h in history:
        d = {c.name: getattr(h, c.name) for c in h.__table__.columns}
        u = user_map.get(h.renewed_by) if h.renewed_by else None
        d["renewed_by_name"] = u.full_name if u else ""
        out.append(d)
    return out


@router.post("/{id}/request-approval")
def request_approval(
    id:    int,
    request: Request,
    notes: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    _ensure_emdbg_schema(db)
    e = db.query(EMDBG).filter(EMDBG.id == id).first()
    if not e:
        raise HTTPException(404, "Not found")
    if _safe_approval_status(e.approval_status) == "pending":
        raise HTTPException(400, "Approval is already pending for this record")
    if _safe_approval_status(e.approval_status) == "approved":
        raise HTTPException(400, "Approved records cannot be re-submitted for approval")

    approval_request = create_generic_approval_request(
        db=db,
        tenant_id=_get_tenant_id(request),
        requester=cu,
        module_key="emdbg",
        action_key="release",
        record_id=e.id,
    )
    _apply_dynamic_request_side_effects(
        db,
        request=approval_request,
        actor=cu,
        remarks=notes or "",
    )

    active_step = next(
        (
            step
            for step in sorted(approval_request.steps or [], key=lambda item: item.step_no)
            if step.step_no == approval_request.current_step_no
        ),
        None,
    )
    approver = active_step.approver if active_step else None
    e.approval_id = approval_request.id

    if (approval_request.status or "").strip().lower() == "approved":
        action = "approval_auto_approved"
        description = f"{e.reference_num} auto-approved via hierarchy"
        icon = "OK"
        color = "#D1FAE5"
        _emit_emdbg_event(db, record=e, event_key="approved", actor=cu, requester_user_id=cu.id)
        message = "Approval auto-approved"
        requested_to = "Auto-approved"
    else:
        action = "approval_requested"
        description = f"Approval requested from {approver.full_name if approver else 'next approver'} for {e.reference_num}"
        icon = "PENDING"
        color = "#FEF3C7"
        _emit_emdbg_event(db, record=e, event_key="approval_requested", actor=cu,
                          approver_user_id=approver.id if approver else None, requester_user_id=cu.id)
        message = "Approval requested"
        requested_to = approver.full_name if approver else ""

    db.add(ActivityLog(
        user_id=cu.id, module="emdbg", record_id=e.id,
        action=action, description=description, icon=icon, color=color,
    ))
    db.commit()
    return {
        "message": message,
        "approval_id": approval_request.id,
        "requested_to": requested_to,
        "approval_status": e.approval_status,
    }


@router.post("/{id}/approve")
def approve_emdbg(
    id:   int,
    data: Decision,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    _ensure_emdbg_schema(db)
    if cu.role not in MANAGER_ROLES:
        raise HTTPException(403, "Manager or above required")

    e = db.query(EMDBG).filter(EMDBG.id == id).first()
    if not e:
        raise HTTPException(404, "Not found")
    if _safe_approval_status(e.approval_status) != "pending":
        raise HTTPException(400, f"No pending approval (status: {e.approval_status})")

    if data.decision not in ("approved", "rejected"):
        raise HTTPException(400, "decision must be 'approved' or 'rejected'")
    if data.decision == "rejected" and not (data.rejection_reason or data.notes or "").strip():
        raise HTTPException(400, "Rejection reason required")

    pending_request = find_pending_request_for_record(
        db,
        module_key="emdbg",
        action_key="release",
        record_id=e.id,
    )
    if pending_request:
        updated_request = decide_generic_approval_request(
            db,
            approval_request_id=pending_request.id,
            approver=cu,
            decision=data.decision,
            remarks=data.rejection_reason or data.notes or "",
        )
        _apply_dynamic_request_side_effects(
            db,
            request=updated_request,
            actor=cu,
            remarks=data.rejection_reason or data.notes or "",
        )

        active_step = next(
            (
                step
                for step in sorted(updated_request.steps or [], key=lambda item: item.step_no)
                if step.step_no == updated_request.current_step_no
            ),
            None,
        )
        progress = get_request_progress(updated_request)
        normalized_status = (updated_request.status or "").strip().lower()

        if normalized_status == "approved":
            message = "EMD/BG approved"
            action = "approval_approved"
            description = f"{e.reference_num} approved by {cu.full_name}"
            icon = "OK"
            color = "#D1FAE5"
            _emit_emdbg_event(db, record=e, event_key="approved", actor=cu,
                              requester_user_id=updated_request.requested_by)
        elif normalized_status == "rejected":
            message = "EMD/BG rejected"
            action = "approval_rejected"
            description = f"{e.reference_num} rejected by {cu.full_name}"
            icon = "ERR"
            color = "#FFF5F5"
            _emit_emdbg_event(db, record=e, event_key="rejected", actor=cu,
                              requester_user_id=updated_request.requested_by,
                              reason=data.rejection_reason or data.notes)
        else:
            next_approver_name = active_step.approver.full_name if active_step and active_step.approver else "next approver"
            message = "Approval moved to the next approver"
            action = "approval_progressed"
            description = f"{e.reference_num} approved by {cu.full_name}; moved to {next_approver_name}"
            icon = "PENDING"
            color = "#FEF3C7"
            _emit_emdbg_event(db, record=e, event_key="approval_requested", actor=cu,
                              approver_user_id=active_step.approver_user_id if active_step else None,
                              requester_user_id=updated_request.requested_by)

        db.add(ActivityLog(
            user_id=cu.id, module="emdbg", record_id=id,
            action=action, description=description, icon=icon, color=color,
        ))
        db.commit()
        return {
            "message": message,
            "approval_id": updated_request.id,
            "approval_status": e.approval_status,
            "approval_display": progress["display"],
        }

    # Legacy fallback
    approval = None
    if e.approval_id:
        approval = db.query(Approval).filter(
            Approval.id == e.approval_id, Approval.status == "pending"
        ).first()
    if not approval:
        approval = db.query(Approval).filter(
            Approval.module    == "emdbg",
            Approval.record_id == e.id,
            Approval.status    == "pending",
        ).first()

    if approval:
        approval.status           = data.decision
        approval.decision_notes   = data.notes
        approval.rejection_reason = data.rejection_reason or data.notes
        approval.decided_at       = now_ist()

    e.approval_status = data.decision
    if data.decision == "approved":
        if hasattr(e, "last_rejection_reason"):
            e.last_rejection_reason = None
    else:
        if hasattr(e, "last_rejection_reason"):
            e.last_rejection_reason = data.rejection_reason or data.notes

    if data.decision == "approved":
        _emit_emdbg_event(db, record=e, event_key="approved", actor=cu,
                          approver_user_id=getattr(approval, "requested_to", None),
                          requester_user_id=getattr(approval, "requested_by", None))
    else:
        _emit_emdbg_event(db, record=e, event_key="rejected", actor=cu,
                          approver_user_id=getattr(approval, "requested_to", None),
                          requester_user_id=getattr(approval, "requested_by", None),
                          reason=data.rejection_reason or data.notes)

    db.add(ActivityLog(
        user_id=cu.id, module="emdbg", record_id=id,
        action=f"approval_{data.decision}",
        description=f"{e.reference_num} {data.decision} by {cu.full_name}",
        icon="OK" if data.decision == "approved" else "ERR",
        color="#D1FAE5" if data.decision == "approved" else "#FFF5F5",
    ))
    db.commit()
    return {"message": f"EMD/BG {data.decision}", "approval_status": e.approval_status}


@router.post("/{id}/renew")
def renew_emdbg(
    id:   int,
    data: RenewalIn,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("emdbg.update")),
):
    """
    Renew a BG instrument (PBG only, typically).
    After renewal, the doc→ack→proof→paid workflow restarts so the
    new BG document is uploaded, acknowledged, and paid again.
    """
    _ensure_emdbg_schema(db)
    e = db.query(EMDBG).filter(EMDBG.id == id).first()
    if not e:
        raise HTTPException(404, "Not found")
    _ensure_emdbg_access(db, cu, e)
    if e.status in ("Released", "Encashed", "Cancelled"):
        raise HTTPException(400, f"Cannot renew — current status is {e.status}")

    history = EMDBGRenewalHistory(
        emdbg_id        = e.id,
        old_expiry_date = e.expiry_date,
        new_expiry_date = data.new_expiry_date,
        old_reference   = e.instrument_number,
        new_reference   = data.new_reference,
        renewed_by      = cu.id,
        notes           = data.notes,
    )
    db.add(history)

    e.expiry_date    = data.new_expiry_date
    e.renewal_status = "renewed"
    e.renewal_date   = today_ist()
    e.status         = "Renewed"

    # Reset the doc→ack→proof→paid workflow for the new BG period
    if hasattr(e, "finance_status"):
        e.finance_status = "unpaid"
    if hasattr(e, "instrument_acknowledged_at"):
        e.instrument_acknowledged_at = None
        e.instrument_acknowledged_by = None
    if hasattr(e, "payment_proof_url"):
        e.payment_proof_url     = None
        e.payment_proof_size_kb = None
    if hasattr(e, "instrument_document_url"):
        e.instrument_document_url = None
    if data.new_reference:
        e.renewed_reference = data.new_reference
    e.approval_status = "none"

    db.add(ActivityLog(
        user_id=cu.id, module="emdbg", record_id=id, action="renewed",
        description=f"{e.reference_num} renewed. New expiry: {data.new_expiry_date}. Workflow reset.",
        icon="🔄", color="#D1FAE5",
    ))
    _emit_emdbg_event(db, record=e, event_key="renewed", actor=cu)
    db.commit()
    db.refresh(e)
    return {"message": "Renewed", "new_expiry": str(data.new_expiry_date), "record": _enrich(e, db)}


@router.post("/{id}/release")
def release_emdbg(
    id:   int,
    data: ReleaseIn,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("emdbg.update")),
):
    """Mark instrument as Released (manager action — final closure bypassing the return-doc flow)."""
    _ensure_emdbg_schema(db)
    if cu.role not in MANAGER_ROLES:
        raise HTTPException(403, "Manager or above required to release")
    e = db.query(EMDBG).filter(EMDBG.id == id).first()
    if not e:
        raise HTTPException(404, "Not found")
    _ensure_emdbg_access(db, cu, e)
    if e.status in ("Released", "Encashed", "Cancelled"):
        raise HTTPException(400, f"Cannot release — current status is {e.status}")

    e.status            = "Released"
    e.release_date      = data.release_date
    e.release_reference = data.release_reference
    if hasattr(e, "return_status"):
        e.return_status       = "confirmed"
        e.return_confirmed_by = cu.id
        e.return_confirmed_at = now_ist()

    db.add(ActivityLog(
        user_id=cu.id, module="emdbg", record_id=id, action="released",
        description=f"{e.reference_num} released on {data.release_date}",
        icon="✅", color="#D1FAE5",
    ))
    _emit_emdbg_event(db, record=e, event_key="returned_released", actor=cu)
    db.commit()
    db.refresh(e)
    return {"message": "Released", "record": _enrich(e, db)}


@router.post("/{id}/mark-returned")
def mark_returned(
    id:   int,
    data: ReturnIn,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("emdbg.update")),
):
    """
    Final positive closure — instrument physically returned / money credited back.
    Manager action that bypasses the return-doc upload flow if needed.
    """
    _ensure_emdbg_schema(db)
    e = db.query(EMDBG).filter(EMDBG.id == id).first()
    if not e:
        raise HTTPException(404, "Not found")
    _ensure_emdbg_access(db, cu, e)
    if e.status in ("Encashed", "Cancelled"):
        raise HTTPException(400, f"Cannot mark returned — current status is {e.status}")

    e.status            = "Released"
    e.release_date      = data.return_date
    e.release_reference = data.return_reference
    if hasattr(e, "return_status"):
        e.return_status       = "confirmed"
        e.return_confirmed_by = cu.id
        e.return_confirmed_at = now_ist()
    if data.notes:
        e.notes = (e.notes or "") + f"\nReturned: {data.notes}"

    db.add(ActivityLog(
        user_id=cu.id, module="emdbg", record_id=id, action="returned",
        description=(
            f"{e.reference_num} marked as RETURNED on {data.return_date}."
            f"{' Ref: ' + data.return_reference if data.return_reference else ''}"
        ),
        icon="💰", color="#D1FAE5",
    ))
    _emit_emdbg_event(db, record=e, event_key="returned_released", actor=cu)
    db.commit()
    db.refresh(e)
    return {"message": "Marked as Returned", "record": _enrich(e, db)}


@router.post("/{id}/encash")
def encash_emdbg(
    id:    int,
    notes: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("emdbg.update")),
):
    _ensure_emdbg_schema(db)
    if cu.role not in MANAGER_ROLES:
        raise HTTPException(403, "Manager or above required")
    e = db.query(EMDBG).filter(EMDBG.id == id).first()
    if not e:
        raise HTTPException(404, "Not found")
    _ensure_emdbg_access(db, cu, e)

    e.status = "Encashed"
    if notes:
        e.notes = (e.notes or "") + f"\nEncashed: {notes}"

    db.add(ActivityLog(
        user_id=cu.id, module="emdbg", record_id=id, action="encashed",
        description=f"{e.reference_num} encashed",
        icon="⚠️", color="#FFF7ED",
    ))
    _emit_emdbg_event(db, record=e, event_key="encashed", actor=cu)
    db.commit()
    db.refresh(e)
    return {"message": "Marked as Encashed", "record": _enrich(e, db)}


# ─── Document upload — instrument / BG draft ─────────────────────────────────
# CHANGE (v3): accounts uploads for ALL instrument types (previously PBG was uploaded by non-accounts)

@router.post("/{id}/upload-instrument", status_code=200)
async def upload_instrument_doc(
    id:   int,
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("emdbg.update")),
):
    """
    Accounts uploads the instrument / BG draft document for ALL instrument types.
    Sales/manager cannot upload the instrument doc — they acknowledge it instead.
    """
    _ensure_emdbg_schema(db)
    e = db.query(EMDBG).filter(EMDBG.id == id).first()
    if not e:
        raise HTTPException(404, "Not found")
    _ensure_emdbg_access(db, cu, e)
    # Only accounts (or privileged admin/ceo) can upload — except right after a BG
    # renewal, where the renewer attaches the freshly renewed document themselves.
    is_renewal_upload = e.status == "Renewed" and not e.instrument_document_url
    if cu.role not in ("accounts",) + PRIVILEGED_ROLES and not is_renewal_upload:
        raise HTTPException(403, "Only accounts team can upload the instrument document.")

    contents = await file.read()
    if not contents:
        raise HTTPException(400, "Uploaded file is empty")

    url, size_kb = _save_file(request, file, contents)
    e.instrument_document_url = url

    vcols = {c.name for c in EMDBG.__table__.columns}
    if "instrument_file_size_kb" in vcols:
        e.instrument_file_size_kb = size_kb

    # Reset acknowledgment when document is replaced
    if hasattr(e, "instrument_acknowledged_at"):
        e.instrument_acknowledged_at = None
        e.instrument_acknowledged_by = None

    doc_label = "BG draft document" if _is_pbg(e) else "Instrument document"
    db.add(ActivityLog(
        user_id=cu.id, module="emdbg", record_id=id, action="doc_uploaded",
        description=f"{doc_label} uploaded: {file.filename}",
        icon="📎", color="#EFF6FF",
    ))
    db.commit()
    db.refresh(e)
    return {
        "message":      "Uploaded",
        "file_url":     url,
        "file_size_kb": size_kb,
        "record":       _enrich(e, db),
    }


# ─── Acknowledge instrument doc ───────────────────────────────────────────────
# CHANGE (v3): now applies to ALL instrument types (was EMD/TF only)

@router.post("/{id}/acknowledge-instrument")
def acknowledge_instrument_doc(
    id: int,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("emdbg.update")),
):
    """
    Sales person (or manager) acknowledges the instrument/BG document uploaded by accounts.
    Applies to ALL instrument types (EMD, Tender Fee, and Bank Guarantees).
    """
    _ensure_emdbg_schema(db)
    if cu.role == "accounts":
        raise HTTPException(403, "Accounts users cannot acknowledge instrument documents")

    e = db.query(EMDBG).filter(EMDBG.id == id).first()
    if not e:
        raise HTTPException(404, "Not found")
    _ensure_emdbg_access(db, cu, e)
    if not getattr(e, "instrument_document_url", None):
        raise HTTPException(400, "No instrument document has been uploaded yet")
    if getattr(e, "instrument_acknowledged_at", None):
        raise HTTPException(400, "Document has already been acknowledged")

    e.instrument_acknowledged_at = now_ist()
    e.instrument_acknowledged_by = cu.id

    doc_label = "BG draft document" if _is_pbg(e) else "Instrument document"
    db.add(ActivityLog(
        user_id=cu.id, module="emdbg", record_id=id, action="doc_acknowledged",
        description=f"{doc_label} acknowledged by {cu.full_name}",
        icon="✅", color="#D1FAE5",
    ))
    db.commit()
    db.refresh(e)
    return {"message": "Acknowledged", "record": _enrich(e, db)}


# ─── Upload payment proof ─────────────────────────────────────────────────────
# CHANGE (v3): now applies to ALL instrument types (was EMD/TF only)

@router.post("/{id}/upload-payment-proof", status_code=200)
async def upload_payment_proof(
    id:   int,
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("emdbg.update")),
):
    """
    Accounts team uploads payment proof for ALL instrument types.
    Must be uploaded AFTER instrument doc is acknowledged.
    """
    _ensure_emdbg_schema(db)
    if cu.role not in ("accounts",) + PRIVILEGED_ROLES:
        raise HTTPException(403, "Accounts role required")

    e = db.query(EMDBG).filter(EMDBG.id == id).first()
    if not e:
        raise HTTPException(404, "Not found")
    _ensure_emdbg_access(db, cu, e)

    if not getattr(e, "instrument_acknowledged_at", None):
        raise HTTPException(
            400,
            "Payment proof can only be uploaded after the instrument document has been acknowledged by sales."
        )

    contents = await file.read()
    if not contents:
        raise HTTPException(400, "Uploaded file is empty")

    url, size_kb = _save_file(request, file, contents)
    e.payment_proof_url     = url
    e.payment_proof_size_kb = size_kb

    db.add(ActivityLog(
        user_id=cu.id, module="emdbg", record_id=id, action="payment_proof_uploaded",
        description=f"Payment proof uploaded: {file.filename}",
        icon="💳", color="#ECFDF5",
    ))
    db.commit()
    db.refresh(e)
    return {"message": "Payment proof uploaded", "file_url": url, "record": _enrich(e, db)}


# ─── Mark as paid ─────────────────────────────────────────────────────────────
# CHANGE (v3): all types require doc + ack + payment_proof before paid

@router.post("/{id}/mark-paid")
def mark_emdbg_paid(
    id: int,
    data: PaidIn,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("emdbg.update")),
):
    """
    Mark instrument as paid (accounts only).
    
    Prerequisites (all instrument types):
      1. approval_status = 'approved'
      2. instrument_document_url is set (doc uploaded)
      3. instrument_acknowledged_at is set (sales acknowledged)
      4. payment_proof_url is set (proof uploaded)
    
    Additional for non-PBG types (EMD, Tender Fee):
      5. workings_approved = True (tender workings approved by manager)
    
    PBG types skip the workings check — workings were already approved at tender award stage.
    """
    _ensure_emdbg_schema(db)
    if cu.role not in ("accounts",) + PRIVILEGED_ROLES:
        raise HTTPException(403, "Accounts role required")

    e = db.query(EMDBG).filter(EMDBG.id == id).first()
    if not e:
        raise HTTPException(404, "Not found")
    _ensure_emdbg_access(db, cu, e)

    if _safe_approval_status(e.approval_status) != "approved":
        raise HTTPException(400, "Only approved records can be marked as paid")

    # Step 1: Instrument doc must be uploaded
    if not getattr(e, "instrument_document_url", None):
        raise HTTPException(
            400,
            f"{'BG draft document' if _is_pbg(e) else 'Instrument document'} must be uploaded before marking as paid."
        )

    # Step 2: Doc must be acknowledged by sales
    if not getattr(e, "instrument_acknowledged_at", None):
        raise HTTPException(
            400,
            "The instrument document must be acknowledged by the sales person before marking as paid."
        )

    # Step 3: Payment proof must be uploaded
    if not getattr(e, "payment_proof_url", None):
        raise HTTPException(
            400,
            "Payment proof must be uploaded before marking as paid."
        )

    # Step 4: Workings check — only for non-PBG types
    if not _is_pbg(e) and e.tender_id:
        t_check = db.query(Tender).filter(Tender.id == e.tender_id).first()
        if t_check:
            workings_ok = (
                getattr(t_check, 'workflow_status', '') == 'step3_active' or
                getattr(t_check, 'result', '') in ('Won', 'Lost')
            )
            if not workings_ok:
                raise HTTPException(
                    400,
                    "Tender workings are not yet approved. Payment cannot be processed until workings approval is complete."
                )

    if hasattr(e, "finance_status"):
        e.finance_status = "paid"
    if hasattr(e, "finance_paid_date"):
        e.finance_paid_date = data.paid_date or today_ist()
    if hasattr(e, "finance_paid_by"):
        e.finance_paid_by = cu.id
    if data.notes and hasattr(e, "finance_notes"):
        e.finance_notes = data.notes

    # Tender Fee is non-refundable — no return flow, no expiry monitoring.
    # Auto-release immediately on payment so status doesn't linger as "Active".
    if _is_tender_fee(e):
        e.status       = "Released"
        e.release_date = data.paid_date or today_ist()

    db.add(ActivityLog(
        user_id=cu.id, module="emdbg", record_id=id, action="marked_paid",
        description=f"{e.reference_num} marked as paid"
                    + (" and auto-released (Tender Fee)" if _is_tender_fee(e) else ""),
        icon="💳", color="#ECFDF5",
    ))
    db.commit()
    db.refresh(e)
    return {"message": "Marked as paid", "record": _enrich(e, db)}


# ─── Upload return document ───────────────────────────────────────────────────
# CHANGE (v3): now applies to EMD and PBG (was EMD only); Tender Fee excluded

@router.post("/{id}/upload-return", status_code=200)
async def upload_return_doc(
    id: int,
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("emdbg.update")),
):
    """
    Sales uploads the return/discharge document after payment is confirmed.
    Applies to EMD and Bank Guarantees (not Tender Fee — non-refundable).
    
    Triggers: Tender Won (return EMD / release BG) or Tender Lost (return EMD) 
              or BG expiry (return expired BG).
    """
    _ensure_emdbg_schema(db)
    e = db.query(EMDBG).filter(EMDBG.id == id).first()
    if not e:
        raise HTTPException(404, "Not found")
    _ensure_emdbg_access(db, cu, e)

    # Tender Fee instruments are non-refundable — no return flow
    if _is_tender_fee(e):
        raise HTTPException(400, "Tender Fee instruments are non-refundable and do not have a return flow.")

    if cu.role == "accounts":
        raise HTTPException(403, "Accounts users cannot upload return documents — this is a sales action.")

    # Must be paid before return doc can be uploaded
    if getattr(e, "finance_status", "unpaid") != "paid":
        raise HTTPException(400, "Return document can only be uploaded after payment is confirmed.")

    # Authorisation: assigned sales user or manager
    if e.tender_id:
        t_check = db.query(Tender).filter(Tender.id == e.tender_id).first()
        if t_check and getattr(t_check, 'assigned_to', None) != cu.id and cu.role not in MANAGER_ROLES:
            raise HTTPException(403, "Not authorised")
    elif e.created_by != cu.id and cu.role not in MANAGER_ROLES:
        raise HTTPException(403, "Not authorised")

    contents = await file.read()
    if not contents:
        raise HTTPException(400, "Uploaded file is empty")

    url, size_kb = _save_file(request, file, contents)
    if hasattr(e, "return_document_url"):
        e.return_document_url = url
    if hasattr(e, "return_file_size_kb"):
        e.return_file_size_kb = size_kb
    if hasattr(e, "return_uploaded_by"):
        e.return_uploaded_by = cu.id
    if hasattr(e, "return_uploaded_at"):
        e.return_uploaded_at = now_ist()
    if hasattr(e, "return_status"):
        e.return_status = "pending_confirmation"

    doc_label = "BG release document" if _is_pbg(e) else "Return document"
    db.add(ActivityLog(
        user_id=cu.id, module="emdbg", record_id=id, action="return_doc_uploaded",
        description=f"{doc_label} uploaded: {file.filename}",
        icon="📎", color="#ECFDF5",
    ))
    db.commit()
    db.refresh(e)
    return {
        "message":     f"{doc_label} uploaded",
        "file_url":    url,
        "file_size_kb": size_kb,
        "record":      _enrich(e, db),
    }


# ─── Confirm return ───────────────────────────────────────────────────────────
# CHANGE (v3): now applies to EMD and PBG (was EMD only)

@router.post("/{id}/confirm-return")
def confirm_return_status(
    id: int,
    data: ReturnConfirmIn,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("emdbg.update")),
):
    """
    Accounts confirms the return after sales uploads return document.
    Applies to EMD and Bank Guarantees. Sets status to Released.
    """
    _ensure_emdbg_schema(db)
    if cu.role not in ("accounts",) + PRIVILEGED_ROLES:
        raise HTTPException(403, "Accounts role required")

    e = db.query(EMDBG).filter(EMDBG.id == id).first()
    if not e:
        raise HTTPException(404, "Not found")
    _ensure_emdbg_access(db, cu, e)

    if _is_tender_fee(e):
        raise HTTPException(400, "Tender Fee instruments do not have a return flow.")

    if not getattr(e, "return_document_url", None):
        raise HTTPException(400, "Upload the return document before confirming return status")

    confirm_date = data.confirmed_date or today_ist()
    if hasattr(e, "return_status"):
        e.return_status = "confirmed"
    if hasattr(e, "return_confirmed_by"):
        e.return_confirmed_by = cu.id
    if hasattr(e, "return_confirmed_at"):
        e.return_confirmed_at = now_ist()
    e.status       = "Released"
    e.release_date = confirm_date
    if data.notes:
        e.notes = ((e.notes or "").rstrip() + f"\nReturn confirmed by accounts: {data.notes}").strip()

    instrument_label = "BG release" if _is_pbg(e) else "Return"
    db.add(ActivityLog(
        user_id=cu.id, module="emdbg", record_id=id, action="return_confirmed",
        description=f"{e.reference_num} {instrument_label} confirmed by accounts",
        icon="✅", color="#D1FAE5",
    ))
    db.commit()
    db.refresh(e)
    return {"message": f"{instrument_label} confirmed", "record": _enrich(e, db)}


@router.post("/{id}/upload-release", status_code=200)
async def upload_release_doc(
    id:   int,
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("emdbg.update")),
):
    """Upload a formal release/discharge document (manager action, supplementary to confirm-return)."""
    _ensure_emdbg_schema(db)
    if cu.role not in MANAGER_ROLES:
        raise HTTPException(403, "Manager or above required")

    e = db.query(EMDBG).filter(EMDBG.id == id).first()
    if not e:
        raise HTTPException(404, "Not found")
    _ensure_emdbg_access(db, cu, e)

    contents = await file.read()
    if not contents:
        raise HTTPException(400, "Uploaded file is empty")

    url, size_kb = _save_file(request, file, contents)
    e.release_document_url = url

    vcols = {c.name for c in EMDBG.__table__.columns}
    if "release_file_size_kb" in vcols:
        e.release_file_size_kb = size_kb

    db.add(ActivityLog(
        user_id=cu.id, module="emdbg", record_id=id, action="release_doc_uploaded",
        description=f"Release document uploaded: {file.filename}",
        icon="📎", color="#D1FAE5",
    ))
    db.commit()
    db.refresh(e)
    return {
        "message":      "Uploaded",
        "file_url":     url,
        "file_size_kb": size_kb,
        "record":       _enrich(e, db),
    }

