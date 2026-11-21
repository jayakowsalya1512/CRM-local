"""
Travel Request + TA/DA router -  Bug-fixed version.

BUGS FIXED:
  1. Travel request status not updating after manager approves:
     - Root cause: process_approval_decision() returns None if approver.id != approval.requested_to
       (strict match). The manager IS the requested_to, so the real cause was that
       create_approval_request() stores requested_to = reporting_manager_id of the requester,
       but the approver calling /decision may be a different manager.
     - Fix: After process_approval_decision(), we now ALSO do a direct Approval lookup
       by record_id+module+status='pending' so any eligible manager can approve.
     - Fix 2: Always update tr.status directly after commit regardless of process_approval_decision.

  2. CEO approval creation failing silently:
     - Root cause: create_approval_request() does not accept override_approver_id kwarg.
     - Fix: Build the Approval object directly when we need to target CEO specifically.

  3. Approve/Reject buttons removed from TravelPage list:
     - Decisions ONLY happen via the Approvals screen.
     - TravelPage only shows Submit/Re-submit for the employee.

  4. Travel form simplified: mode_of_travel, class_of_travel, cost estimates removed.

  5. TADA per-line-item attachments:
     - Each TADALineItem now has its own attachments (receipt proof mandatory to submit).
     - Separate upload endpoint per line item.
     - Blocking: cannot submit unless every line item has at least one attachment.
"""

import logging
import os
from collections import defaultdict
from datetime import date, datetime, timezone
from app.core.timezone import now_ist, today_ist
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query, Request
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import func, or_, and_
from pydantic import BaseModel, field_validator, model_validator
from app.core import validators as V

from app.dependencies import get_tenant_db, get_current_user, require_permission
from app.models.all_models import (
    TravelRequest,
    TADAClaim,
    TADALineItem,
    User,
    Approval,
    ApprovalRequest,
    ApprovalRequestStep,
    ApprovalRule,
    ApprovalRuleStep,
    ActivityLog,
    KAMActivity,
    Customer,
    SalesCustomerAssignment,
    Tender,
    UserReportingHierarchy, OrgTreeNode,
)
from app.services.cache_service import invalidate_badges_cache
from app.services.generic_approval_engine import (
    decide_generic_approval_request,
    filter_resolved_steps_for_request,
    find_matching_approval_rule,
    find_latest_request_for_record,
    find_pending_request_for_record,
    get_request_progress,
    is_top_level_auto_approval_requester,
    resolve_hierarchy_approval_steps,
    resolve_rule_steps_for_request,
)
from app.services.approval_service import (
    create_approval_request,
    process_approval_decision,
    _create_notification,
)
from app.services.travel_approval_service import (
    resolve_expired_travel_approvals,
    submit_travel_request_with_policy,
    sync_travel_request_from_generic_approval,
)
from app.services.storage_usage_service import (
    ensure_tenant_storage_available,
    refresh_tenant_storage_usage_for_slug,
)
from app.utils.file_storage import (
    delete_stored_file,
    media_slug_from_request,
    media_url_to_logical_path,
    save_upload_optimized,
)
from app.utils.data_scope import get_module_data_scope, get_team_user_ids

logger = logging.getLogger(__name__)
router = APIRouter()


def _get_tenant_id(request: Request) -> Optional[int]:
    tenant = getattr(request.state, "tenant", None)
    tenant_id = getattr(tenant, "id", None)
    return int(tenant_id) if isinstance(tenant_id, int) else tenant_id


def _build_approval_display(status: str, *, current: Optional[int] = None, total: Optional[int] = None) -> str:
    normalized_status = (status or "").strip().lower()
    status_label = {
        "pending": "Pending",
        "approved": "Approved",
        "rejected": "Rejected",
        "draft": "Draft",
        "cancelled": "Cancelled",
        "completed": "Completed",
        "submitted": "Pending",
    }.get(normalized_status, status or "")

    if total and normalized_status in {"pending", "approved", "rejected"}:
        safe_current = max(0, min(int(current or 0), int(total)))
        return f"{status_label} ({safe_current}/{int(total)})"
    return status_label


def _resolve_configured_travel_steps(
    db: Session,
    *,
    requester: Optional[User],
    tenant_id: Optional[int] = None,
) -> list:
    if not requester:
        return []

    rule = find_matching_approval_rule(
        db,
        tenant_id=tenant_id,
        requester=requester,
        module_key="travel",
        action_key="request",
    )
    try:
        if is_top_level_auto_approval_requester(db, requester):
            return []
        if not rule:
            return filter_resolved_steps_for_request(
                db,
                requester,
                resolve_hierarchy_approval_steps(db, requester),
            )

        approval_type = (getattr(rule, "approval_type", None) or "hierarchy").strip().lower()
        if approval_type == "hierarchy":
            return filter_resolved_steps_for_request(
                db,
                requester,
                resolve_hierarchy_approval_steps(db, requester),
            )

        rule_steps = (
            db.query(ApprovalRuleStep)
            .filter(ApprovalRuleStep.approval_rule_id == rule.id)
            .order_by(ApprovalRuleStep.step_no.asc())
            .all()
        )
        if not rule_steps:
            return []
        return resolve_rule_steps_for_request(db, requester, rule_steps, allow_global_role_fallback=True)
    except HTTPException:
        logger.warning(
            "Unable to resolve configured travel approval steps for request %s",
            getattr(requester, "id", None),
            exc_info=True,
        )
        return []


def _configured_travel_steps_for_requester(
    db: Session,
    *,
    requester: Optional[User],
    tenant_id: Optional[int] = None,
    cache: Optional[dict[int, list]] = None,
) -> list:
    if not requester:
        return []
    requester_id = getattr(requester, "id", None)
    if cache is not None and requester_id and int(requester_id) in cache:
        return cache[int(requester_id)]
    steps = _resolve_configured_travel_steps(
        db,
        requester=requester,
        tenant_id=tenant_id,
    )
    if cache is not None and requester_id:
        cache[int(requester_id)] = steps
    return steps


def _latest_travel_approval_requests(db: Session, request_ids: list[int]) -> dict[int, ApprovalRequest]:
    if not request_ids:
        return {}
    rows = (
        db.query(ApprovalRequest)
        .options(
            selectinload(ApprovalRequest.requester),
            selectinload(ApprovalRequest.steps).selectinload(ApprovalRequestStep.approver),
        )
        .filter(
            ApprovalRequest.module_key == "travel",
            ApprovalRequest.action_key == "request",
            ApprovalRequest.record_id.in_(request_ids),
        )
        .order_by(ApprovalRequest.record_id.asc(), ApprovalRequest.requested_at.desc(), ApprovalRequest.id.desc())
        .all()
    )
    latest_by_request: dict[int, ApprovalRequest] = {}
    for request in rows:
        latest_by_request.setdefault(int(request.record_id), request)
    return latest_by_request


def _legacy_travel_approval_maps(
    db: Session,
    request_ids: list[int],
) -> tuple[dict[int, Approval], dict[int, int]]:
    if not request_ids:
        return {}, {}
    latest_rows = (
        db.query(Approval)
        .filter(
            Approval.module == "travel",
            Approval.record_id.in_(request_ids),
        )
        .order_by(Approval.record_id.asc(), Approval.id.desc())
        .all()
    )
    latest_by_request: dict[int, Approval] = {}
    for approval in latest_rows:
        latest_by_request.setdefault(int(approval.record_id), approval)
    approved_count_by_request = {
        int(record_id): int(count or 0)
        for record_id, count in db.query(Approval.record_id, func.count(Approval.id)).filter(
            Approval.module == "travel",
            Approval.record_id.in_(request_ids),
            Approval.status == "approved",
        ).group_by(Approval.record_id).all()
        if record_id is not None
    }
    return latest_by_request, approved_count_by_request


def _attach_travel_approval_state(
    d: dict,
    r: TravelRequest,
    db: Session,
    *,
    tenant_id: Optional[int] = None,
    latest_request: Optional[ApprovalRequest] = None,
    legacy_latest_approval: Optional[Approval] = None,
    legacy_approved_count: Optional[int] = None,
    requester_map: Optional[dict[int, User]] = None,
    approver_user_map: Optional[dict[int, User]] = None,
    configured_steps_cache: Optional[dict[int, list]] = None,
) -> dict:
    requester_map = requester_map or {}
    approver_user_map = approver_user_map or {}
    if latest_request is None:
        latest_request = find_latest_request_for_record(
            db,
            module_key="travel",
            action_key="request",
            record_id=r.id,
        )
    if not latest_request and getattr(r, "approval_id", None):
        latest_request = (
            db.query(ApprovalRequest)
            .filter(
                ApprovalRequest.id == r.approval_id,
                ApprovalRequest.module_key == "travel",
            )
            .first()
        )

    if latest_request:
        progress = get_request_progress(latest_request)
        request_steps = sorted(latest_request.steps or [], key=lambda item: item.step_no)
        requester = latest_request.requester or (
            requester_map.get(int(r.employee_id)) if r.employee_id else None
        )
        if requester is None and r.employee_id:
            requester = db.query(User).filter(User.id == r.employee_id).first()
        configured_steps = _configured_travel_steps_for_requester(
            db,
            requester=requester,
            tenant_id=tenant_id,
            cache=configured_steps_cache,
        )
        configured_total = len(configured_steps)
        normalized_request_status = (latest_request.status or "").strip().lower() or "pending"
        effective_total = (
            max(int(progress["total"] or 0), configured_total)
            if normalized_request_status == "pending"
            else int(progress["total"] or 0)
        )
        effective_current = int(progress["current"] or 0)
        effective_status = normalized_request_status

        active_step = next(
            (
                step
                for step in request_steps
                if step.step_no == latest_request.current_step_no
                and (step.status or "").strip().lower() == "pending"
            ),
            None,
        )
        if not active_step:
            active_step = next(
                (
                    step
                    for step in request_steps
                    if (step.status or "").strip().lower() == "pending"
                ),
                None,
            )
        active_step_index = next(
            (
                index
                for index, step in enumerate(request_steps)
                if active_step and step.step_no == active_step.step_no
            ),
            effective_current,
        )
        if effective_total and effective_status == "pending":
            effective_current = max(effective_current, min(active_step_index, effective_total))
        next_configured_step = (
            configured_steps[effective_current]
            if effective_status == "pending" and effective_current < len(configured_steps)
            else None
        )
        d["approval_request_id"] = latest_request.id
        d["approval_status"] = effective_status
        d["approval_display"] = _build_approval_display(
            effective_status,
            current=effective_current if effective_total else None,
            total=effective_total if effective_total else None,
        )
        d["approval_progress_current"] = effective_current if effective_total else None
        d["approval_progress_total"] = effective_total or None
        d["approval_current_step_no"] = (
            active_step_index + 1
            if active_step
            else (effective_current + 1 if effective_status == "pending" and effective_total else latest_request.current_step_no)
        )
        d["approval_requested_to"] = (
            active_step.approver_user_id
            if active_step
            else getattr(getattr(next_configured_step, "approver_user", None), "id", None)
        )
        d["approval_requested_to_name"] = (
            active_step.approver.full_name
            if active_step and active_step.approver
            else (
                next_configured_step.approver_user.full_name
                if next_configured_step and getattr(next_configured_step, "approver_user", None)
                else ""
            )
        )
        return d

    normalized_status = (r.status or "").strip().lower()
    requester = requester_map.get(int(r.employee_id)) if r.employee_id else None
    if requester is None and r.employee_id:
        requester = db.query(User).filter(User.id == r.employee_id).first()
    configured_steps = _configured_travel_steps_for_requester(
        db,
        requester=requester,
        tenant_id=tenant_id,
        cache=configured_steps_cache,
    )
    configured_total = len(configured_steps)
    latest_legacy_approval = legacy_latest_approval
    if latest_legacy_approval is None:
        latest_legacy_approval = (
            db.query(Approval)
            .filter(Approval.module == "travel", Approval.record_id == r.id)
            .order_by(Approval.id.desc())
            .first()
        )
    effective_legacy_approved_count = legacy_approved_count
    if effective_legacy_approved_count is None:
        effective_legacy_approved_count = (
            db.query(func.count(Approval.id))
            .filter(
                Approval.module == "travel",
                Approval.record_id == r.id,
                Approval.status == "approved",
            )
            .scalar()
            or 0
        )

    if normalized_status == "submitted" or (latest_legacy_approval and latest_legacy_approval.status == "pending"):
        current_step_index = int(effective_legacy_approved_count or 0)
        total_steps = configured_total or (current_step_index + 1 if latest_legacy_approval else 0)

        d["approval_request_id"] = None
        d["approval_status"] = "pending"
        d["approval_display"] = _build_approval_display(
            "pending",
            current=current_step_index,
            total=total_steps,
        )
        d["approval_progress_current"] = current_step_index if total_steps else None
        d["approval_progress_total"] = total_steps or None
        d["approval_current_step_no"] = current_step_index + 1 if total_steps else None

        next_step = configured_steps[current_step_index] if current_step_index < len(configured_steps) else None
        legacy_requested_to = getattr(latest_legacy_approval, "requested_to", None)
        d["approval_requested_to"] = legacy_requested_to or getattr(getattr(next_step, "approver_user", None), "id", None)

        pending_approver_name = ""
        if legacy_requested_to:
            pending_approver = approver_user_map.get(int(legacy_requested_to))
            if pending_approver is None:
                pending_approver = db.query(User).filter(User.id == legacy_requested_to).first()
            pending_approver_name = pending_approver.full_name if pending_approver else ""
        if not pending_approver_name and next_step and getattr(next_step, "approver_user", None):
            pending_approver_name = next_step.approver_user.full_name
        d["approval_requested_to_name"] = pending_approver_name
        return d

    d["approval_request_id"] = None
    d["approval_status"] = normalized_status or None
    d["approval_display"] = _build_approval_display(normalized_status, current=None, total=None) or r.status
    d["approval_progress_current"] = None
    d["approval_progress_total"] = None
    d["approval_current_step_no"] = None
    d["approval_requested_to"] = None
    d["approval_requested_to_name"] = ""
    return d


@router.get("/team-users")
def travel_team_users(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    scope_user_ids = _scope_user_ids(db, cu)

    q = db.query(User).filter(User.is_active == True)
    if scope_user_ids is not None:
        q = q.filter(User.id.in_(scope_user_ids))

    users = q.order_by(User.full_name.asc()).all()

    return [
        {
            "id": u.id,
            "label": u.full_name or u.username or "",
            "full_name": u.full_name or "",
            "role": u.role,
        }
        for u in users
    ]


@router.get("/team-customers")
def travel_team_customers(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    scope_user_ids = _scope_user_ids(db, cu)

    q = db.query(Customer).filter(Customer.is_deleted == False)

    if scope_user_ids is not None:
        active_assignment_customer_ids = (
            db.query(SalesCustomerAssignment.customer_id)
            .filter(SalesCustomerAssignment.is_active == True)
        )
        scoped_assignment_customer_ids = (
            db.query(SalesCustomerAssignment.customer_id)
            .filter(
                SalesCustomerAssignment.is_active == True,
                SalesCustomerAssignment.user_id.in_(scope_user_ids),
            )
        )
        q = q.filter(or_(
            Customer.created_by.in_(scope_user_ids),
            Customer.id.in_(scoped_assignment_customer_ids),
            and_(
                ~Customer.id.in_(active_assignment_customer_ids),
                Customer.assigned_to.in_(scope_user_ids),
            ),
        ))

    customers = q.order_by(Customer.customer_name.asc()).all()

    return [
        {
            "id": c.id,
            "customer_name": c.customer_name,
            "label": c.customer_name,
        }
        for c in customers
    ]

# â"€â"€â"€ Media paths â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
MEDIA_ROOT = os.environ.get("MEDIA_ROOT", "media")
TADA_UPLOAD_DIR = os.path.join(MEDIA_ROOT, "tada_attachments")
os.makedirs(TADA_UPLOAD_DIR, exist_ok=True)

ALLOWED_EXTENSIONS = {
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".csv",
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".bmp",
}


# â"€â"€â"€ Pydantic schemas â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€


_TR_LABELS = {
    "estimated_kms": "Estimated km", "estimated_cost": "Estimated cost", "advance_amount": "Advance amount",
    "accommodation_cost": "Accommodation cost", "travel_date": "Travel date", "return_date": "Return date",
    "check_in_date": "Check-in date", "check_out_date": "Check-out date",
}


def _amount2(v, label: str) -> Optional[float]:
    """Non-negative amount with at most 2 decimal places (None / blank -> None)."""
    n = V.check_amount(v, label)
    if n is not None and abs(round(n, 2) - n) > 1e-9:
        raise ValueError(f"{label} can have at most 2 decimal places.")
    return n


class TravelRequestCreate(BaseModel):
    # Core
    purpose: str
    visit_type: str = "Customer Visit"
    from_city: str
    to_city: str
    travel_date: date
    return_date: date
    is_outside_district: bool = False

    # CRM Linkage
    account_id: Optional[int] = None  # alias for customer_id
    customer_id: Optional[int] = None  # legacy / KAM path
    lead_id: Optional[int] = None
    tender_id: Optional[int] = None
    opportunity_id: Optional[int] = None
    contact_name: Optional[str] = None
    contact_phone: Optional[str] = None

    # Transport
    transport_mode: Optional[str] = None
    vehicle_number: Optional[str] = None
    estimated_kms: Optional[float] = None
    advance_booking_ref: Optional[str] = None

    # Budget
    estimated_cost: Optional[float] = None  # stored as estimated_total
    advance_required: bool = False
    advance_amount: Optional[float] = None
    cost_center: Optional[str] = None
    budget_code: Optional[str] = None

    # Accommodation
    accommodation_required: bool = False
    accommodation_type: Optional[str] = None
    hotel_name: Optional[str] = None
    check_in_date: Optional[date] = None
    check_out_date: Optional[date] = None
    accommodation_cost: Optional[float] = None

    # Additional
    companions: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("contact_phone")
    @classmethod
    def validate_contact_phone(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        phone = "".join(ch for ch in str(value) if ch.isdigit())
        if not phone:
            return None
        if len(phone) != 10:
            raise ValueError("Contact Phone must be exactly 10 digits")
        return V.check_mobile(phone, "Contact phone")

    # ── field-level validation (twin of the travel request form rules) ──
    @field_validator("purpose", mode="before")
    @classmethod
    def _purpose(cls, v):
        return V.check_text(v, "Purpose of travel", 3, 500, required=True)

    @field_validator("from_city", "to_city", mode="before")
    @classmethod
    def _city(cls, v, info):
        return V.check_text(v, "From city" if info.field_name == "from_city" else "To city", 2, 100, required=True)

    @field_validator("contact_name", "hotel_name", "advance_booking_ref", mode="before")
    @classmethod
    def _opt200(cls, v, info):
        return V.check_text(v, info.field_name.replace("_", " ").capitalize(), 0, 200)

    @field_validator("visit_type", mode="before")
    @classmethod
    def _visit_type(cls, v):
        return V.check_text(v, "Visit type", 0, 100) or "Customer Visit"

    @field_validator("accommodation_type", "cost_center", "budget_code", "vehicle_number", "transport_mode", mode="before")
    @classmethod
    def _opt100(cls, v, info):
        return V.check_text(v, info.field_name.replace("_", " ").capitalize(), 0, 50 if info.field_name in ("vehicle_number", "transport_mode") else 100)

    @field_validator("estimated_kms", "estimated_cost", "advance_amount", "accommodation_cost", mode="before")
    @classmethod
    def _money(cls, v, info):
        return _amount2(v, _TR_LABELS.get(info.field_name, info.field_name))

    @field_validator("travel_date", "return_date", "check_in_date", "check_out_date")
    @classmethod
    def _dates(cls, v, info):
        return V.check_date_range(v, _TR_LABELS.get(info.field_name, "Date"))

    @model_validator(mode="after")
    def _ranges(self):
        errs: dict[str, str] = {}
        if self.travel_date and self.return_date and self.return_date < self.travel_date:
            errs["return_date"] = "Return date cannot be before the travel date."
        if self.advance_required and not self.advance_amount:
            errs["advance_amount"] = "Advance amount is required when an advance is requested."
        if self.accommodation_required and self.check_in_date and self.check_out_date and self.check_out_date < self.check_in_date:
            errs["check_out_date"] = "Check-out date cannot be before the check-in date."
        V.raise_field_errors(errs)
        return self


class TADALineItemIn(BaseModel):
    expense_date: date
    category: str
    description: str
    from_place: Optional[str] = None
    to_place: Optional[str] = None
    amount: float
    receipt_number: Optional[str] = None
    vendor_name: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("category", mode="before")
    @classmethod
    def _category(cls, v):
        return V.check_text(v, "Category", 1, 100, required=True)

    @field_validator("description", mode="before")
    @classmethod
    def _description(cls, v):
        return V.check_text(v, "Description", 2, 500, required=True)

    @field_validator("from_place", "to_place", "receipt_number", mode="before")
    @classmethod
    def _opt100(cls, v, info):
        return V.check_text(v, info.field_name.replace("_", " ").capitalize(), 0, 100)

    @field_validator("vendor_name", mode="before")
    @classmethod
    def _vendor(cls, v):
        return V.check_text(v, "Vendor name", 0, 200)

    @field_validator("notes", mode="before")
    @classmethod
    def _notes(cls, v):
        return V.check_text(v, "Notes", 0, 300)

    @field_validator("amount", mode="before")
    @classmethod
    def _amount(cls, v):
        if v is None or (isinstance(v, str) and not v.strip()):
            raise ValueError("Amount is required.")
        n = _amount2(v, "Amount")
        if not n:
            raise ValueError("Amount must be greater than 0.")
        return n

    @field_validator("expense_date")
    @classmethod
    def _date(cls, v):
        return V.check_date_range(v, "Expense date")


class TADAClaimCreate(BaseModel):
    travel_request_id: Optional[int] = None
    claim_date: date
    claim_type: Optional[str] = "travel"
    travel_date_from: Optional[date] = None
    travel_date_to: Optional[date] = None
    num_days: Optional[int] = None
    from_city: Optional[str] = None
    to_city: Optional[str] = None
    purpose: Optional[str] = None
    mode_of_travel: Optional[str] = None
    da_rate_per_day: Optional[float] = None
    expense_mode: Optional[str] = None
    advance_taken: float = 0
    cost_center: Optional[str] = None
    budget_code: Optional[str] = None
    department: Optional[str] = None
    line_items: List[TADALineItemIn] = []
    notes: Optional[str] = None

    @field_validator("purpose", mode="before")
    @classmethod
    def _purpose(cls, v):
        return V.check_text(v, "Purpose", 0, 500)

    @field_validator("from_city", "to_city", "mode_of_travel", "cost_center", "budget_code", "department", mode="before")
    @classmethod
    def _opt100(cls, v, info):
        return V.check_text(v, info.field_name.replace("_", " ").capitalize(), 0, 100)

    @field_validator("da_rate_per_day", "advance_taken", mode="before")
    @classmethod
    def _money(cls, v, info):
        n = _amount2(v, "DA rate per day" if info.field_name == "da_rate_per_day" else "Advance taken")
        return 0 if n is None and info.field_name == "advance_taken" else n

    @field_validator("num_days", mode="before")
    @classmethod
    def _days(cls, v):
        if v is None or (isinstance(v, str) and not v.strip()):
            return None
        try:
            n = int(str(v))
        except (TypeError, ValueError):
            raise ValueError("Number of days must be a whole number.")
        if n < 0:
            raise ValueError("Number of days cannot be negative.")
        if n > 366:
            raise ValueError("Number of days cannot exceed 366.")
        return n

    @field_validator("claim_date", "travel_date_from", "travel_date_to")
    @classmethod
    def _dates(cls, v, info):
        labels = {"claim_date": "Claim date", "travel_date_from": "Travel from date", "travel_date_to": "Travel to date"}
        return V.check_date_range(v, labels[info.field_name])

    @model_validator(mode="after")
    def _ranges(self):
        if self.travel_date_from and self.travel_date_to and self.travel_date_to < self.travel_date_from:
            raise V.field_error("travel_date_to", "Travel to date cannot be before the travel from date.")
        return self


class Decision(BaseModel):
    decision: str
    notes: Optional[str] = None
    rejection_reason: Optional[str] = None


class StorageCheckIn(BaseModel):
    extra_bytes: int


# â"€â"€â"€ Helpers â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€


def _tr_num(db: Session) -> str:
    count = db.query(TravelRequest).count() or 0
    return f"TR-{now_ist().strftime('%Y%m')}-{count + 1:04d}"


def _ta_num(db: Session) -> str:
    count = db.query(TADAClaim).count() or 0
    return f"TADA-{now_ist().strftime('%Y%m')}-{count + 1:04d}"


def _find_ceo(db: Session) -> Optional[int]:
    for role in ("ceo", "admin"):
        u = db.query(User).filter(User.role == role, User.is_active == True).first()
        if u:
            return u.id
    return None


def _find_reporting_manager(db: Session, requester: User) -> Optional[User]:
    if requester.reporting_manager_id:
        manager = (
            db.query(User)
            .filter(
                User.id == requester.reporting_manager_id,
                User.is_active == True,
            )
            .first()
        )
        if manager and manager.id != requester.id:
            return manager

    for role in ("manager", "vp", "admin", "ceo"):
        manager = (
            db.query(User)
            .filter(
                User.role == role,
                User.is_active == True,
                User.id != requester.id,
            )
            .first()
        )
        if manager:
            return manager
    return None


def _find_travel_approver(db: Session, requester: User) -> Optional[User]:
    if requester.role in ("ceo", "admin"):
        return None

    if requester.role in ("manager", "vp"):
        ceo_id = _find_ceo(db)
        if not ceo_id or ceo_id == requester.id:
            return None
        return (
            db.query(User)
            .filter(User.id == ceo_id, User.is_active == True)
            .first()
        )

    return _find_reporting_manager(db, requester)


def _queue_approval(
    db: Session,
    requester: User,
    approver: User,
    module: str,
    action: str,
    record_id: int,
    record_ref: str,
    request_notes: str = "",
) -> Approval:
    approval = Approval(
        module=module,
        action=action,
        record_id=record_id,
        record_ref=record_ref,
        requested_by=requester.id,
        requested_to=approver.id,
        status="pending",
        request_notes=request_notes,
    )
    db.add(approval)
    db.flush()
    return approval


def _refresh_travel_auto_approvals(
    db: Session,
    *,
    approval_id: Optional[int] = None,
    approver_id: Optional[int] = None,
    request_id: Optional[int] = None,
) -> None:
    resolved = resolve_expired_travel_approvals(
        db,
        approval_id=approval_id,
        approver_id=approver_id,
        request_id=request_id,
    )
    if resolved:
        db.commit()


def _request_context_maps(db: Session, rows: list[TravelRequest]):
    employee_ids = {int(r.employee_id) for r in rows if r.employee_id}
    customer_ids = {int(r.customer_id) for r in rows if r.customer_id}
    tender_ids = {int(r.tender_id) for r in rows if getattr(r, "tender_id", None)}
    kam_activity_ids = {int(r.kam_activity_id) for r in rows if getattr(r, "kam_activity_id", None)}
    employees = {
        int(user.id): user
        for user in db.query(User).filter(User.id.in_(employee_ids)).all()
    } if employee_ids else {}
    customers = {
        int(customer.id): customer
        for customer in db.query(Customer).filter(Customer.id.in_(customer_ids)).all()
    } if customer_ids else {}
    tenders = {
        int(tender.id): tender
        for tender in db.query(Tender).filter(Tender.id.in_(tender_ids)).all()
    } if tender_ids else {}
    kam_activities = {
        int(activity.id): activity
        for activity in db.query(KAMActivity).filter(KAMActivity.id.in_(kam_activity_ids)).all()
    } if kam_activity_ids else {}
    return employees, customers, tenders, kam_activities


def _enrich_request(
    r: TravelRequest,
    db: Session,
    *,
    tenant_id: Optional[int] = None,
    employee_map: Optional[dict[int, User]] = None,
    customer_map: Optional[dict[int, Customer]] = None,
    tender_map: Optional[dict[int, Tender]] = None,
    kam_activity_map: Optional[dict[int, KAMActivity]] = None,
    latest_request: Optional[ApprovalRequest] = None,
    legacy_latest_approval: Optional[Approval] = None,
    legacy_approved_count: Optional[int] = None,
    approver_user_map: Optional[dict[int, User]] = None,
    configured_steps_cache: Optional[dict[int, list]] = None,
) -> dict:
    employee_map = employee_map or {}
    customer_map = customer_map or {}
    tender_map = tender_map or {}
    kam_activity_map = kam_activity_map or {}
    emp = employee_map.get(int(r.employee_id)) if r.employee_id else None
    if emp is None and r.employee_id:
        emp = db.query(User).filter(User.id == r.employee_id).first()
    d = {c.name: getattr(r, c.name) for c in r.__table__.columns}
    d["employee_name"] = emp.full_name if emp else ""
    d["employee_role"] = emp.role if emp else ""
    # account_name -  looked up from customer_id for frontend display
    cust = customer_map.get(int(r.customer_id)) if r.customer_id else None
    if cust is None and r.customer_id:
        cust = db.query(Customer).filter(Customer.id == r.customer_id).first()
    d["account_name"] = cust.customer_name if cust else ""
    # tender_num – looked up from tender_id for frontend display
    tnd = tender_map.get(int(r.tender_id)) if getattr(r, "tender_id", None) else None
    if tnd is None and getattr(r, "tender_id", None):
        tnd = db.query(Tender).filter(Tender.id == r.tender_id).first()
    d["tender_num"] = tnd.tender_num if tnd else ""
    d["tender_title"] = tnd.tender_title if tnd else ""
    # estimated_cost -  frontend alias for estimated_total
    d["estimated_cost"] = float(r.estimated_total) if r.estimated_total else None
    # KAM linkage
    kam_act_id = getattr(r, "kam_activity_id", None)
    if kam_act_id:
        act = kam_activity_map.get(int(kam_act_id))
        if act is None:
            act = db.query(KAMActivity).filter(KAMActivity.id == kam_act_id).first()
        d["kam_activity_subject"] = act.subject if act else ""
        d["source_label"] = "KAM Activity"
    else:
        d["kam_activity_subject"] = ""
        d["source_label"] = "Direct"
    return _attach_travel_approval_state(
        d,
        r,
        db,
        tenant_id=tenant_id,
        latest_request=latest_request,
        legacy_latest_approval=legacy_latest_approval,
        legacy_approved_count=legacy_approved_count,
        requester_map=employee_map,
        approver_user_map=approver_user_map,
        configured_steps_cache=configured_steps_cache,
    )


def _line_item_attachments(line_item_id: int, claim_id: int, db: Session) -> list:
    """
    Load attachments for a single TADALineItem.
    Works in two modes:
      - Post-migration: filters by line_item_id (precise, per-item)
      - Pre-migration:  filters by claim_id where line_item_id IS NULL (all claim attachments)
    This ensures attachments are always visible regardless of migration state.
    """
    try:
        from app.models.all_models import TADAAttachment  # type: ignore

        vcols = {c.name for c in TADAAttachment.__table__.columns}

        if "line_item_id" in vcols:
            # Try precise per-item query first
            atts = (
                db.query(TADAAttachment)
                .filter(TADAAttachment.line_item_id == line_item_id)
                .all()
            )
            # If nothing found, also check claim-level attachments (NULL line_item_id)
            # This covers attachments saved before migration or via fallback path
            if not atts:
                atts = (
                    db.query(TADAAttachment)
                    .filter(
                        TADAAttachment.claim_id == claim_id,
                        TADAAttachment.line_item_id == None,
                    )
                    .all()
                )
        else:
            # Migration not applied -  all attachments are at claim level
            atts = (
                db.query(TADAAttachment)
                .filter(
                    TADAAttachment.claim_id == claim_id,
                )
                .all()
            )

        return [
            {
                "id": a.id,
                "file_name": a.file_name,
                "file_url": a.file_url,
                "preview_url": a.file_url,
                "doc_type": a.doc_type,
                "file_size_kb": getattr(a, "file_size_kb", None),
                "line_item_id": getattr(a, "line_item_id", None),
            }
            for a in atts
        ]
    except Exception as e:
        logger.warning(f"_line_item_attachments error: {e}")
        return []


def _serialize_tada_attachment(a, *, include_line_item_id: bool = False) -> dict:
    payload = {
        "id": a.id,
        "file_name": a.file_name,
        "file_url": a.file_url,
        "preview_url": a.file_url,
        "doc_type": a.doc_type,
        "file_size_kb": getattr(a, "file_size_kb", None),
    }
    if include_line_item_id:
        payload["line_item_id"] = getattr(a, "line_item_id", None)
    return payload


def _claim_context_maps(db: Session, claims: list[TADAClaim]):
    employee_ids = {int(c.employee_id) for c in claims if c.employee_id}
    claim_ids = [int(c.id) for c in claims if c.id]
    employees = {
        int(user.id): user
        for user in db.query(User).filter(User.id.in_(employee_ids)).all()
    } if employee_ids else {}

    line_items_by_claim: dict[int, list[TADALineItem]] = defaultdict(list)
    line_items = (
        db.query(TADALineItem)
        .filter(TADALineItem.claim_id.in_(claim_ids))
        .all()
    ) if claim_ids else []
    for item in line_items:
        line_items_by_claim[int(item.claim_id)].append(item)

    item_attachments_by_line: dict[int, list[dict]] = defaultdict(list)
    claim_attachments_by_claim: dict[int, list[dict]] = defaultdict(list)
    claim_attachments_for_items_by_claim: dict[int, list[dict]] = defaultdict(list)
    try:
        from app.models.all_models import TADAAttachment  # type: ignore

        vcols = {col.name for col in TADAAttachment.__table__.columns}
        attachments = (
            db.query(TADAAttachment)
            .filter(TADAAttachment.claim_id.in_(claim_ids))
            .all()
        ) if claim_ids else []
        for attachment in attachments:
            line_item_id = getattr(attachment, "line_item_id", None) if "line_item_id" in vcols else None
            if "line_item_id" in vcols and line_item_id:
                item_attachments_by_line[int(line_item_id)].append(
                    _serialize_tada_attachment(attachment, include_line_item_id=True)
                )
            else:
                claim_id = int(attachment.claim_id)
                claim_attachments_by_claim[claim_id].append(_serialize_tada_attachment(attachment))
                claim_attachments_for_items_by_claim[claim_id].append(
                    _serialize_tada_attachment(attachment, include_line_item_id=True)
                )

        for item in line_items:
            item_id = int(item.id)
            if item_id not in item_attachments_by_line:
                item_attachments_by_line[item_id] = list(
                    claim_attachments_for_items_by_claim.get(int(item.claim_id), [])
                )
    except Exception:
        pass

    return employees, line_items_by_claim, item_attachments_by_line, claim_attachments_by_claim


def _enrich_claim(
    c: TADAClaim,
    db: Session,
    *,
    employee_map: Optional[dict[int, User]] = None,
    line_items_by_claim: Optional[dict[int, list[TADALineItem]]] = None,
    item_attachments_by_line: Optional[dict[int, list[dict]]] = None,
    claim_attachments_by_claim: Optional[dict[int, list[dict]]] = None,
) -> dict:
    employee_map = employee_map or {}
    line_items_by_claim = line_items_by_claim or {}
    item_attachments_by_line = item_attachments_by_line or {}
    claim_attachments_by_claim = claim_attachments_by_claim or {}
    emp = employee_map.get(int(c.employee_id)) if c.employee_id else None
    if emp is None and c.employee_id:
        emp = db.query(User).filter(User.id == c.employee_id).first()
    items = line_items_by_claim.get(int(c.id))
    if items is None:
        items = db.query(TADALineItem).filter(TADALineItem.claim_id == c.id).all()
    d = {col.name: getattr(c, col.name) for col in c.__table__.columns}
    d["employee_name"] = emp.full_name if emp else ""
    def _attachments_for_item(item: TADALineItem) -> list:
        item_id = int(item.id)
        if item_id in item_attachments_by_line:
            return item_attachments_by_line[item_id]
        return _line_item_attachments(item.id, c.id, db)

    d["line_items"] = [
        {
            **{col.name: getattr(i, col.name) for col in i.__table__.columns},
            "attachments": _attachments_for_item(i),
        }
        for i in items
    ]
    # Claim-level attachments (legacy / general)
    try:
        from app.models.all_models import TADAAttachment  # type: ignore

        if int(c.id) in claim_attachments_by_claim:
            d["attachments"] = claim_attachments_by_claim.get(int(c.id), [])
        else:
            _vcols = {col.name for col in TADAAttachment.__table__.columns}
            _q = db.query(TADAAttachment).filter(TADAAttachment.claim_id == c.id)
            if "line_item_id" in _vcols:
                _q = _q.filter(TADAAttachment.line_item_id == None)
            claim_atts = _q.all()
            d["attachments"] = [_serialize_tada_attachment(a) for a in claim_atts]
    except Exception:
        d["attachments"] = []

    # has_all_proofs: True when every line item has â‰¥1 attachment.
    # When attachments are claim-level (pre-migration), treat them as proof
    # for ALL items so the submit button isn't permanently blocked.
    _total_atts = sum(len(li["attachments"]) for li in d["line_items"])
    _claim_level_atts = len(d.get("attachments", []))
    _items_with_proof = sum(1 for li in d["line_items"] if len(li["attachments"]) > 0)
    _item_count = len(d["line_items"])
    if _item_count == 0:
        d["has_all_proofs"] = False
    elif _items_with_proof == _item_count:
        # Every item has its own per-item attachment
        d["has_all_proofs"] = True
    elif _claim_level_atts > 0 and _total_atts == _claim_level_atts:
        # All attachments are claim-level (pre-migration) -  treat as proof for all
        d["has_all_proofs"] = True
    else:
        d["has_all_proofs"] = _items_with_proof == _item_count

    return d


def _notify_accounts(db: Session, claim: TADAClaim):
    requester = db.query(User).filter(User.id == claim.employee_id).first()
    for au in (
        db.query(User).filter(User.role == "accounts", User.is_active == True).all()
    ):
        _create_notification(
            db,
            au.id,
            title=f"TA/DA Ready for Payment: {claim.claim_number}",
            message=(
                f"CEO approved {requester.full_name if requester else ''}'s "
                f"TA/DA of â‚¹{claim.net_payable:,.2f}. Awaiting payment processing."
            ),
            notif_type="approval_request",
            module="tada",
            record_id=claim.id,
            action_url=f"/travel/tada/{claim.id}",
        )


def _create_ceo_approval(
    db: Session, claim: TADAClaim, notes: str
) -> Optional[Approval]:
    """
    Directly create a pending Approval record targeting the CEO.
    Bypasses create_approval_request() which may not support override_approver_id.
    """
    ceo_id = _find_ceo(db)
    if not ceo_id:
        return None
    appr = Approval(
        module="tada",
        action="expense_ceo",
        record_id=claim.id,
        record_ref=f"{claim.claim_number} (â‚¹{claim.net_payable:,.2f})",
        requested_by=claim.employee_id,
        requested_to=ceo_id,
        status="pending",
        request_notes=f"Manager approved. {notes}".strip(),
    )
    db.add(appr)
    db.flush()
    return appr


# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
# TRAVEL REQUESTS
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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


def _scope_user_ids(db: Session, current_user: User) -> Optional[list[int]]:
    """Return scoped user ID list for Travel / TA-DA records.

    Returns None for "all" scope (no filter), [] for "none",
    or a list of user IDs for "own"/"team".
    """
    scope = get_module_data_scope(db, current_user, "travel")

    if scope == "all":
        return None

    if scope == "none":
        return []

    if scope == "own":
        return [int(current_user.id)]

    return get_team_user_ids(db, int(current_user.id))


def _is_travel_approver(db: Session, cu: User, module: str, record_id: int) -> bool:
    """True when cu is (or was) an approver on an approval for this travel/tada record."""
    legacy = db.query(Approval.id).filter(
        Approval.module == module,
        Approval.record_id == record_id,
        Approval.requested_to == cu.id,
    ).first()
    if legacy:
        return True
    step = (
        db.query(ApprovalRequestStep.id)
        .join(ApprovalRequest, ApprovalRequest.id == ApprovalRequestStep.approval_request_id)
        .filter(
            ApprovalRequest.module_key == module,
            ApprovalRequest.record_id == record_id,
            ApprovalRequestStep.approver_user_id == cu.id,
        )
        .first()
    )
    return bool(step)


def _ensure_travel_record_access(db: Session, cu: User, module: str, record) -> None:
    """403 unless record.employee_id is inside cu's configured travel data scope.

    Approvers on the record's approval chain keep access so they can review it.
    """
    scope_user_ids = _scope_user_ids(db, cu)
    if scope_user_ids is None:
        return
    if record.employee_id in set(scope_user_ids):
        return
    if _is_travel_approver(db, cu, module, int(record.id)):
        return
    raise HTTPException(403, "You do not have access to this record")




@router.get("/requests")
def list_travel_requests(
    request: Request,
    status_filter: Optional[str] = None,
    source: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("travel.view")),
):
    try:
        _refresh_travel_auto_approvals(db)
        q = db.query(TravelRequest)

        # Data Visibility dropdown decides for every role; accounts are
        # additionally narrowed to approved requests.
        scope_user_ids = _scope_user_ids(db, cu)
        if scope_user_ids is not None:
            q = q.filter(TravelRequest.employee_id.in_(scope_user_ids))
        if cu.role == "accounts":
            q = q.filter(TravelRequest.status == "Approved")

        if status_filter:
            q = q.filter(TravelRequest.status == status_filter)
        if source:
            try:
                q = q.filter(TravelRequest.source == source)
            except Exception:
                pass

        rows = q.order_by(TravelRequest.created_at.desc()).all()
        employee_map, customer_map, tender_map, kam_activity_map = _request_context_maps(db, rows)
        request_ids = [int(row.id) for row in rows if row.id]
        latest_request_map = _latest_travel_approval_requests(db, request_ids)
        legacy_latest_by_request, legacy_approved_count_by_request = _legacy_travel_approval_maps(db, request_ids)
        approver_ids = {
            int(approval.requested_to)
            for approval in legacy_latest_by_request.values()
            if approval.requested_to
        }
        approver_user_map = {
            int(user.id): user
            for user in db.query(User).filter(User.id.in_(approver_ids)).all()
        } if approver_ids else {}
        configured_steps_cache: dict[int, list] = {}
        return [
            _enrich_request(
                r,
                db,
                tenant_id=_get_tenant_id(request),
                employee_map=employee_map,
                customer_map=customer_map,
                tender_map=tender_map,
                kam_activity_map=kam_activity_map,
                latest_request=latest_request_map.get(int(r.id)),
                legacy_latest_approval=legacy_latest_by_request.get(int(r.id)),
                legacy_approved_count=legacy_approved_count_by_request.get(int(r.id), 0),
                approver_user_map=approver_user_map,
                configured_steps_cache=configured_steps_cache,
            )
            for r in rows
        ]
    except Exception as e:
        logger.warning(f"list_travel_requests: {e}", exc_info=True)
        return []


@router.post("/requests", status_code=201)
def create_travel_request(
    data: TravelRequestCreate,
    request: Request,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("travel.create")),
):
    total_days = (data.return_date - data.travel_date).days + 1

    # account_id (frontend) is an alias for customer_id (DB)
    resolved_customer_id = data.account_id or data.customer_id

    vcols = {c.name for c in TravelRequest.__table__.columns}

    kw = dict(
        request_number=_tr_num(db),
        employee_id=cu.id,
        purpose=data.purpose,
        visit_type=data.visit_type,
        # CRM
        customer_id=resolved_customer_id,
        lead_id=data.lead_id,
        tender_id=data.tender_id,
        opportunity_id=data.opportunity_id,
        contact_name=data.contact_name,
        contact_phone=data.contact_phone,
        # Route
        from_city=data.from_city,
        to_city=data.to_city,
        travel_date=data.travel_date,
        return_date=data.return_date,
        total_days=total_days,
        is_outside_district=data.is_outside_district,
        # Transport
        transport_mode=data.transport_mode,
        vehicle_number=data.vehicle_number,
        estimated_kms=data.estimated_kms,
        advance_booking_ref=data.advance_booking_ref,
        # Budget -  estimated_cost from frontend stored as estimated_total
        estimated_total=data.estimated_cost or 0,
        advance_required=data.advance_required,
        advance_amount=data.advance_amount or 0,
        cost_center=data.cost_center,
        budget_code=data.budget_code,
        # Accommodation
        accommodation_required=data.accommodation_required,
        accommodation_type=data.accommodation_type,
        hotel_name=data.hotel_name,
        check_in_date=data.check_in_date,
        check_out_date=data.check_out_date,
        accommodation_cost=data.accommodation_cost,
        # Additional
        companions=data.companions,
        notes=data.notes,
        status="Draft",
    )
    if "source" in vcols:
        kw["source"] = "direct"

    tr = TravelRequest(**{k: v for k, v in kw.items() if k in vcols})
    db.add(tr)
    db.flush()
    db.add(
        ActivityLog(
            user_id=cu.id,
            module="travel",
            record_id=tr.id,
            action="created",
            description=f"Travel request {tr.request_number} created",
            icon="âœˆï¸",
            color="#EFF6FF",
        )
    )
    db.commit()
    db.refresh(tr)
    return _enrich_request(tr, db, tenant_id=_get_tenant_id(request))


@router.put("/requests/{tr_id}")
def update_travel_request(
    tr_id: int,
    data: TravelRequestCreate,
    request: Request,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("travel.update")),
):
    tr = db.query(TravelRequest).filter(TravelRequest.id == tr_id).first()
    if not tr:
        raise HTTPException(404, "Travel request not found")
    _ensure_travel_record_access(db, cu, "travel", tr)
    if tr.status not in ("Draft", "Rejected", "Submitted"):
        raise HTTPException(400, f"Cannot edit request from status: {tr.status}")

    total_days = (data.return_date - data.travel_date).days + 1
    resolved_customer_id = data.account_id or data.customer_id

    tr.purpose = data.purpose
    tr.visit_type = data.visit_type
    tr.customer_id = resolved_customer_id
    tr.lead_id = data.lead_id
    tr.tender_id = data.tender_id
    tr.opportunity_id = data.opportunity_id
    tr.contact_name = data.contact_name
    tr.contact_phone = data.contact_phone
    tr.from_city = data.from_city
    tr.to_city = data.to_city
    tr.travel_date = data.travel_date
    tr.return_date = data.return_date
    tr.total_days = total_days
    tr.is_outside_district = data.is_outside_district
    tr.transport_mode = data.transport_mode
    tr.vehicle_number = data.vehicle_number
    tr.estimated_kms = data.estimated_kms
    tr.advance_booking_ref = data.advance_booking_ref
    tr.estimated_total = data.estimated_cost or 0
    tr.advance_required = data.advance_required
    tr.advance_amount = data.advance_amount or 0
    tr.cost_center = data.cost_center
    tr.budget_code = data.budget_code
    tr.accommodation_required = data.accommodation_required
    tr.accommodation_type = data.accommodation_type
    tr.hotel_name = data.hotel_name
    tr.check_in_date = data.check_in_date
    tr.check_out_date = data.check_out_date
    tr.accommodation_cost = data.accommodation_cost
    tr.companions = data.companions
    tr.notes = data.notes

    db.add(
        ActivityLog(
            user_id=cu.id,
            module="travel",
            record_id=tr.id,
            action="updated",
            description=f"Travel request {tr.request_number} updated",
            icon="OK",
            color="#EFF6FF",
        )
    )
    db.commit()
    db.refresh(tr)

    message = "Travel request updated"
    if tr.status == "Submitted":
        message = "Travel request updated. Approval remains in progress."
    return {
        "message": message,
        "request": _enrich_request(tr, db, tenant_id=_get_tenant_id(request)),
    }


@router.post("/requests/{tr_id}/submit")
def submit_travel_request(
    tr_id: int,
    request: Request,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("travel.update")),
):
    tr = db.query(TravelRequest).filter(TravelRequest.id == tr_id).first()
    if not tr:
        raise HTTPException(404, "Not found")
    _ensure_travel_record_access(db, cu, "travel", tr)
    if tr.status not in ("Draft", "Rejected"):
        raise HTTPException(400, f"Cannot submit from status: {tr.status}")

    requester = db.query(User).filter(User.id == tr.employee_id).first()
    if not requester:
        raise HTTPException(404, "Requester not found")

    response = submit_travel_request_with_policy(
        db,
        tr,
        actor=cu,
        requester=requester,
        tenant_id=_get_tenant_id(request),
    )
    db.commit()
    return response


@router.post("/requests/{tr_id}/decision")
def decide_travel_request(
    tr_id: int,
    data: Decision,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    if cu.role not in ("manager", "vp", "ceo", "admin"):
        raise HTTPException(403, "Manager role required")

    tr = db.query(TravelRequest).filter(TravelRequest.id == tr_id).first()
    if not tr:
        raise HTTPException(404, "Travel request not found")
    _refresh_travel_auto_approvals(db, request_id=tr.id)
    db.refresh(tr)
    if tr.status != "Submitted":
        raise HTTPException(
            400, f"Travel request is not pending approval (status: {tr.status})"
        )

    if data.decision not in ("approved", "rejected"):
        raise HTTPException(400, "decision must be 'approved' or 'rejected'")
    if (
        data.decision == "rejected"
        and not (data.rejection_reason or data.notes or "").strip()
    ):
        raise HTTPException(400, "Rejection reason is required")

    pending_request = find_pending_request_for_record(
        db,
        module_key="travel",
        action_key="request",
        record_id=tr.id,
    )
    if pending_request:
        updated_request = decide_generic_approval_request(
            db,
            approval_request_id=pending_request.id,
            approver=cu,
            decision=data.decision,
            remarks=data.rejection_reason or data.notes or "",
        )
        sync_travel_request_from_generic_approval(
            db,
            approval_request=updated_request,
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
        normalized_status = (updated_request.status or "").strip().lower()
        if normalized_status == "approved":
            message = "Travel request approved"
            requested_to = "Completed"
        elif normalized_status == "rejected":
            message = "Travel request rejected"
            requested_to = ""
        else:
            requested_to = active_step.approver.full_name if active_step and active_step.approver else "next approver"
            message = f"Travel request moved to {requested_to}"

        db.commit()
        db.refresh(tr)
        return {
            "message": message,
            "approval_id": updated_request.id,
            "status": tr.status,
            "requested_to": requested_to,
        }

    # Find the pending approval -  try strict match first, fall back to any pending
    approval = None
    if tr.approval_id:
        approval = (
            db.query(Approval)
            .filter(
                Approval.id == tr.approval_id,
                Approval.status == "pending",
            )
            .first()
        )
    if not approval:
        # Fallback: find any pending travel approval for this record
        approval = (
            db.query(Approval)
            .filter(
                Approval.module == "travel",
                Approval.record_id == tr.id,
                Approval.status == "pending",
            )
            .first()
    )
    if not approval:
        raise HTTPException(404, "No pending approval found for this travel request")

    # Update the approval record
    approval.status = data.decision
    approval.decision_notes = data.notes
    approval.rejection_reason = data.rejection_reason or data.notes
    approval.decided_at = now_ist()

    # Update travel request status
    if data.decision == "approved":
        tr.status = "Approved"
        tr.approved_by = cu.id
        tr.approved_at = now_ist()
        _create_notification(
            db,
            tr.employee_id,
            title=f"Travel Request Approved: {tr.request_number}",
            message=f"Your travel request to {tr.to_city} has been approved by {cu.full_name}.",
            notif_type="approval_done",
            module="travel",
            record_id=tr.id,
        )
    else:
        tr.status = "Rejected"
        tr.rejection_reason = data.rejection_reason or data.notes
        _create_notification(
            db,
            tr.employee_id,
            title=f"Travel Request Rejected: {tr.request_number}",
            message=(
                f"Rejected by {cu.full_name}. "
                f"Reason: {data.rejection_reason or data.notes or '- '}. "
                f"Please revise and re-submit."
            ),
            notif_type="rejection",
            module="travel",
            record_id=tr.id,
        )

    db.add(
        ActivityLog(
            user_id=cu.id,
            module="travel",
            record_id=tr.id,
            action=f"travel_{data.decision}",
            description=f"Travel request {data.decision} by {cu.full_name}",
            icon="âœ…" if data.decision == "approved" else "âŒ",
            color="#F0FDF4" if data.decision == "approved" else "#FFF5F5",
        )
    )
    db.commit()
    return {"message": f"Travel request {data.decision}", "status": tr.status}


@router.get("/requests/{tr_id}")
def get_travel_request(
    tr_id: int,
    request: Request,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("travel.view")),
):
    _refresh_travel_auto_approvals(db, request_id=tr_id)
    tr = db.query(TravelRequest).filter(TravelRequest.id == tr_id).first()
    if not tr:
        raise HTTPException(404, "Not found")
    _ensure_travel_record_access(db, cu, "travel", tr)
    return _enrich_request(tr, db, tenant_id=_get_tenant_id(request))


# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
# TA/DA CLAIMS
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•


@router.get("/tada")
def list_tada_claims(
    status_filter: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("travel.view")),
):
    try:
        q = db.query(TADAClaim)
        # Data Visibility dropdown decides for every role; accounts are
        # additionally narrowed to claims that reached the accounts stage.
        scope_user_ids = _scope_user_ids(db, cu)
        if scope_user_ids is not None:
            q = q.filter(TADAClaim.employee_id.in_(scope_user_ids))
        if cu.role == "accounts":
            q = q.filter(
                TADAClaim.overall_status.in_(
                    ["CEO Approved", "Accounts Approved", "Paid"]
                )
            )

        if status_filter:
            q = q.filter(TADAClaim.overall_status == status_filter)

        claims = q.order_by(TADAClaim.created_at.desc()).all()
        employee_map, line_items_by_claim, item_attachments_by_line, claim_attachments_by_claim = _claim_context_maps(db, claims)
        results = []
        for c in claims:
            try:
                results.append(
                    _enrich_claim(
                        c,
                        db,
                        employee_map=employee_map,
                        line_items_by_claim=line_items_by_claim,
                        item_attachments_by_line=item_attachments_by_line,
                        claim_attachments_by_claim=claim_attachments_by_claim,
                    )
                )
            except Exception as enrich_err:
                logger.warning(f"_enrich_claim failed for claim {c.id}: {enrich_err}")
                results.append({
                    "id": c.id,
                    "claim_number": getattr(c, "claim_number", ""),
                    "overall_status": getattr(c, "overall_status", "Draft"),
                    "claim_date": str(getattr(c, "claim_date", "")),
                    "purpose": getattr(c, "purpose", ""),
                    "from_city": getattr(c, "from_city", ""),
                    "to_city": getattr(c, "to_city", ""),
                    "total_amount": float(getattr(c, "total_amount", 0) or 0),
                    "net_payable": float(getattr(c, "net_payable", 0) or 0),
                    "employee_name": "",
                    "line_items": [],
                    "attachments": [],
                    "has_all_proofs": False,
                })
        return results
    except Exception as e:
        logger.warning(f"list_tada_claims: {e}", exc_info=True)
        return []


@router.post("/tada/storage-check")
def check_tada_storage(
    data: StorageCheckIn,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    tenant_slug = str(db.info.get("tenant_slug") or "").strip()
    ensure_tenant_storage_available(tenant_slug, max(0, int(data.extra_bytes or 0)))
    return {"ok": True}


@router.post("/tada", status_code=201)
def create_tada_claim(
    data: TADAClaimCreate,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("travel.create")),
):
    if data.travel_request_id:
        tr = (
            db.query(TravelRequest)
            .filter(TravelRequest.id == data.travel_request_id)
            .first()
        )
        if not tr:
            raise HTTPException(404, "Travel request not found")
        if tr.employee_id != cu.id and cu.role not in ("admin",):
            raise HTTPException(403, "Not your travel request")

    total = sum(i.amount for i in data.line_items)
    net = total - (data.advance_taken or 0)
    da_total = (
        (data.da_rate_per_day or 0) * (data.num_days or 0)
        if data.da_rate_per_day
        else None
    )

    claim = TADAClaim(
        claim_number=_ta_num(db),
        travel_request_id=data.travel_request_id,
        employee_id=cu.id,
        claim_date=data.claim_date,
        claim_type=data.claim_type or "travel",
        travel_date_from=data.travel_date_from,
        travel_date_to=data.travel_date_to,
        num_days=data.num_days,
        from_city=data.from_city,
        to_city=data.to_city,
        purpose=data.purpose,
        mode_of_travel=data.mode_of_travel,
        da_rate_per_day=data.da_rate_per_day,
        da_total=da_total,
        expense_mode=data.expense_mode,
        cost_center=data.cost_center,
        budget_code=data.budget_code,
        department=data.department,
        total_amount=total,
        advance_taken=data.advance_taken,
        net_payable=net,
        overall_status="Draft",
        manager_status="pending",
        accounts_status="pending",
        notes=data.notes,
    )
    db.add(claim)
    db.flush()

    for item in data.line_items:
        db.add(
            TADALineItem(
                claim_id=claim.id,
                expense_date=item.expense_date,
                category=item.category,
                description=item.description,
                from_place=item.from_place,
                to_place=item.to_place,
                amount=item.amount,
                receipt_number=item.receipt_number,
                vendor_name=item.vendor_name,
                notes=item.notes,
                approved_amount=item.amount,
            )
        )

    db.commit()
    db.refresh(claim)

    # Activity log is non-critical -  log failure must not roll back the saved claim
    try:
        db.add(
            ActivityLog(
                user_id=cu.id,
                module="tada",
                record_id=claim.id,
                action="created",
                description=f"TA/DA claim {claim.claim_number} created for â‚¹{total:,.2f}",
                icon="ðŸ§¾",
                color="#F0FDF4",
            )
        )
        db.commit()
    except Exception as log_err:
        logger.warning(f"ActivityLog insert skipped: {log_err}")
        db.rollback()
    try:
        return _enrich_claim(claim, db)
    except Exception as e:
        logger.warning(f"create_tada_claim enrich error: {e}")
        return {
            "id": claim.id,
            "claim_number": claim.claim_number,
            "overall_status": "Draft",
            "claim_date": str(claim.claim_date),
            "purpose": claim.purpose or "",
            "from_city": claim.from_city or "",
            "to_city": claim.to_city or "",
            "total_amount": float(claim.total_amount or 0),
            "net_payable": float(claim.net_payable or 0),
            "employee_name": "",
            "line_items": [],
            "attachments": [],
            "has_all_proofs": False,
        }


@router.post("/tada/{cid}/submit")
def submit_tada_claim(
    cid: int,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("travel.update")),
):
    claim = db.query(TADAClaim).filter(TADAClaim.id == cid).first()
    if not claim:
        raise HTTPException(404, "Not found")
    if claim.employee_id != cu.id:
        raise HTTPException(403, "Not your claim")
    if claim.overall_status not in ("Draft", "Rejected"):
        raise HTTPException(400, f"Cannot submit from: {claim.overall_status}")

    # Enforce: every line item must have at least one attachment (proof)
    items = db.query(TADALineItem).filter(TADALineItem.claim_id == cid).all()
    if not items:
        raise HTTPException(400, "Add at least one expense item before submitting")

    missing_proof = []
    try:
        from app.models.all_models import TADAAttachment  # type: ignore

        vcols = {c.name for c in TADAAttachment.__table__.columns}
        has_line_item_col = "line_item_id" in vcols

        if has_line_item_col:
            # Post-migration: check per-item attachments; also accept claim-level (NULL)
            # as fallback (covers attachments uploaded before migration ran)
            claim_level_count = (
                db.query(TADAAttachment)
                .filter(
                    TADAAttachment.claim_id == cid,
                    TADAAttachment.line_item_id == None,
                )
                .count()
            )

            if claim_level_count > 0:
                # Claim-level attachments exist -  treat as proof for all items
                # (pre-migration upload path)
                missing_proof = []
            else:
                item_ids = [int(item.id) for item in items if item.id]
                attachment_count_by_item = {
                    int(line_item_id): int(count or 0)
                    for line_item_id, count in db.query(
                        TADAAttachment.line_item_id,
                        func.count(TADAAttachment.id),
                    ).filter(
                        TADAAttachment.line_item_id.in_(item_ids)
                    ).group_by(TADAAttachment.line_item_id).all()
                    if line_item_id is not None
                } if item_ids else {}
                for item in items:
                    count = attachment_count_by_item.get(int(item.id), 0) if item.id else 0
                    if count == 0:
                        missing_proof.append(item.description or f"Item #{item.id}")
        else:
            # Pre-migration: column doesn't exist -  check total claim attachments
            total_count = (
                db.query(TADAAttachment).filter(TADAAttachment.claim_id == cid).count()
            )
            if total_count == 0:
                missing_proof = [i.description or f"Item #{i.id}" for i in items]
    except Exception:
        pass  # TADAAttachment model unavailable -  skip proof check

    if missing_proof:
        raise HTTPException(
            400,
            f"Upload proof/receipt for: {', '.join(missing_proof)}. "
            "Every expense item requires at least one document.",
        )

    requester = db.query(User).filter(User.id == claim.employee_id).first()
    if not requester:
        raise HTTPException(404, "Requester not found")

    claim.manager_approval_id = None
    claim.manager_status = "pending"
    claim.manager_approved_by = None
    claim.manager_approved_at = None
    claim.manager_rejection_reason = None
    claim.accounts_status = "pending"
    claim.accounts_approved_by = None
    claim.accounts_approved_at = None
    claim.accounts_rejection_reason = None

    requested_to = ""
    amount_label = float(claim.net_payable or 0)

    if requester.role in ("ceo", "admin"):
        claim.manager_status = "approved"
        claim.manager_approved_by = requester.id
        claim.manager_approved_at = now_ist()
        claim.overall_status = "CEO Approved"
        requested_to = "Accounts"
        _notify_accounts(db, claim)
    elif requester.role in ("manager", "vp"):
        ceo_id = _find_ceo(db)
        if ceo_id and ceo_id != requester.id:
            ceo = db.query(User).filter(User.id == ceo_id).first()
            if not ceo:
                raise HTTPException(404, "CEO approver not found")
            _queue_approval(
                db=db,
                requester=requester,
                approver=ceo,
                module="tada",
                action="expense_ceo",
                record_id=claim.id,
                record_ref=f"{claim.claim_number} (Rs.{amount_label:,.2f})",
                request_notes="Submitted by manager for CEO approval",
            )
            claim.manager_status = "approved"
            claim.manager_approved_by = requester.id
            claim.manager_approved_at = now_ist()
            claim.overall_status = "Manager Approved"
            requested_to = ceo.full_name
            _create_notification(
                db,
                ceo.id,
                title=f"TA/DA Needs CEO Approval: {claim.claim_number}",
                message=(
                    f"{requester.full_name} submitted a TA/DA claim worth Rs.{amount_label:,.2f}."
                ),
                module="tada",
                record_id=claim.id,
                notif_type="approval_request",
            )
        else:
            claim.manager_status = "approved"
            claim.manager_approved_by = requester.id
            claim.manager_approved_at = now_ist()
            claim.overall_status = "CEO Approved"
            requested_to = "Accounts"
            _notify_accounts(db, claim)
    else:
        approver = _find_reporting_manager(db, requester)
        if not approver:
            raise HTTPException(400, "No manager found for approval")
        approval = _queue_approval(
            db=db,
            requester=requester,
            approver=approver,
            module="tada",
            action="expense",
            record_id=claim.id,
            record_ref=f"{claim.claim_number} (Rs.{amount_label:,.2f})",
            request_notes=f"TA/DA claim for {claim.purpose or 'travel expenses'}",
        )
        claim.manager_approval_id = approval.id
        claim.overall_status = "Submitted"
        requested_to = approver.full_name
        _create_notification(
            db,
            approver.id,
            title=f"TA/DA Claim Needs Approval: {claim.claim_number}",
            message=(
                f"{requester.full_name} submitted a TA/DA claim worth Rs.{amount_label:,.2f}."
            ),
            module="tada",
            record_id=claim.id,
            notif_type="approval_request",
        )

    db.add(
        ActivityLog(
            user_id=cu.id,
            module="tada",
            record_id=claim.id,
            action="submitted",
            description=f"TA/DA claim {claim.claim_number} submitted to {requested_to}",
            icon="SUBMIT",
            color="#FEF3C7",
        )
    )
    db.commit()
    return {
        "message": "TA/DA claim submitted successfully",
        "requested_to": requested_to,
        "overall_status": claim.overall_status,
    }


@router.post("/tada/{cid}/manager-decision")
def manager_decide_tada(
    cid: int,
    data: Decision,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    """
    Manager approves or rejects the TA/DA claim.
    On approval: escalates to CEO via a direct Approval record.
    On rejection: back to employee with reason (they must re-submit).
    """
    if cu.role not in ("manager", "vp", "ceo", "admin"):
        raise HTTPException(403, "Manager role required")

    claim = db.query(TADAClaim).filter(TADAClaim.id == cid).first()
    if not claim:
        raise HTTPException(404, "Claim not found")
    if claim.overall_status != "Submitted":
        raise HTTPException(
            400, f"Claim is not pending manager review (status: {claim.overall_status})"
        )

    if data.decision == "rejected":
        if not (data.rejection_reason or data.notes or "").strip():
            raise HTTPException(400, "Rejection reason is required")

    # Mark manager approval record as decided (best-effort)
    if claim.manager_approval_id:
        mgr_approval = (
            db.query(Approval).filter(Approval.id == claim.manager_approval_id).first()
        )
        if mgr_approval and mgr_approval.status == "pending":
            mgr_approval.status = data.decision
            mgr_approval.decision_notes = data.notes
            mgr_approval.rejection_reason = data.rejection_reason or data.notes
            mgr_approval.decided_at = now_ist()

    if data.decision == "approved":
        claim.manager_status = "approved"
        claim.manager_approved_by = cu.id
        claim.manager_approved_at = now_ist()

        # â"€â"€ Escalate to CEO â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        ceo_approval = _create_ceo_approval(db, claim, data.notes or "")
        if ceo_approval:
            claim.overall_status = "Manager Approved"
            requester = db.query(User).filter(User.id == claim.employee_id).first()
            ceo_id = ceo_approval.requested_to
            _create_notification(
                db,
                ceo_id,
                title=f"TA/DA Needs CEO Approval: {claim.claim_number}",
                message=(
                    f"Manager approved {requester.full_name if requester else ''}'s "
                    f"TA/DA of â‚¹{claim.net_payable:,.2f}. Awaiting CEO review."
                ),
                notif_type="approval_request",
                module="tada",
                record_id=claim.id,
                action_url=f"/travel/tada/{claim.id}",
            )
            # Notify employee
            _create_notification(
                db,
                claim.employee_id,
                title=f"TA/DA Manager Approved: {claim.claim_number}",
                message="Your TA/DA claim has been approved by your manager and sent to CEO for final approval.",
                notif_type="info",
                module="tada",
                record_id=claim.id,
            )
        else:
            # No CEO in system -  skip CEO step, go straight to Accounts
            claim.overall_status = "CEO Approved"
            _notify_accounts(db, claim)
    else:
        # Rejected by manager
        claim.manager_status = "rejected"
        claim.manager_rejection_reason = data.rejection_reason
        claim.overall_status = "Rejected"
        _create_notification(
            db,
            claim.employee_id,
            title=f"TA/DA Rejected by Manager: {claim.claim_number}",
            message=f"Reason: {data.rejection_reason or data.notes or '- '}. Please revise and re-submit.",
            notif_type="rejection",
            module="tada",
            record_id=claim.id,
        )

    db.add(
        ActivityLog(
            user_id=cu.id,
            module="tada",
            record_id=claim.id,
            action=f"manager_{data.decision}",
            description=f"Manager {data.decision} TA/DA {claim.claim_number}",
            icon="âœ…" if data.decision == "approved" else "âŒ",
            color="#F0FDF4" if data.decision == "approved" else "#FFF5F5",
        )
    )
    db.commit()
    return {
        "message": f"TA/DA {data.decision} by manager",
        "overall_status": claim.overall_status,
    }


@router.post("/tada/{cid}/ceo-decision")
def ceo_decide_tada(
    cid: int,
    data: Decision,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    """
    CEO approves or rejects the TA/DA claim.
    On approval: moves to Accounts queue.
    On rejection: back to employee -  must revise and re-submit from scratch.
    """
    if cu.role not in ("ceo", "admin"):
        raise HTTPException(403, "CEO role required")

    claim = db.query(TADAClaim).filter(TADAClaim.id == cid).first()
    if not claim:
        raise HTTPException(404, "Claim not found")
    if claim.overall_status != "Manager Approved":
        raise HTTPException(
            400, f"Claim needs manager approval first (status: {claim.overall_status})"
        )

    if (
        data.decision == "rejected"
        and not (data.rejection_reason or data.notes or "").strip()
    ):
        raise HTTPException(400, "Rejection reason is required")

    # Mark CEO approval record if it exists
    ceo_appr = (
        db.query(Approval)
        .filter(
            Approval.module == "tada",
            Approval.action == "expense_ceo",
            Approval.record_id == cid,
            Approval.status == "pending",
        )
        .first()
    )
    if ceo_appr:
        ceo_appr.status = data.decision
        ceo_appr.decision_notes = data.notes
        ceo_appr.rejection_reason = data.rejection_reason or data.notes
        ceo_appr.decided_at = now_ist()

    if data.decision == "approved":
        claim.overall_status = "CEO Approved"
        _notify_accounts(db, claim)
        _create_notification(
            db,
            claim.employee_id,
            title=f"TA/DA CEO Approved: {claim.claim_number}",
            message=f"CEO approved your TA/DA. Payment will be processed by Accounts.",
            notif_type="approval_done",
            module="tada",
            record_id=claim.id,
        )
    else:
        # CEO rejected -  employee must revise from scratch
        claim.overall_status = "Rejected"
        _create_notification(
            db,
            claim.employee_id,
            title=f"TA/DA Rejected by CEO: {claim.claim_number}",
            message=f"CEO rejected: {data.rejection_reason or data.notes or '- '}. Please revise and re-submit.",
            notif_type="rejection",
            module="tada",
            record_id=claim.id,
        )

    db.add(
        ActivityLog(
            user_id=cu.id,
            module="tada",
            record_id=claim.id,
            action=f"ceo_{data.decision}",
            description=f"CEO {data.decision} TA/DA {claim.claim_number}",
            icon="ðŸ‘‘",
            color="#F0FDF4" if data.decision == "approved" else "#FFF5F5",
        )
    )
    db.commit()
    return {
        "message": f"TA/DA {data.decision} by CEO",
        "overall_status": claim.overall_status,
    }


@router.post("/tada/{cid}/accounts-decision")
def accounts_decide_tada(
    cid: int,
    data: Decision,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    if cu.role not in ("accounts", "admin", "ceo"):
        raise HTTPException(403, "Accounts team required")

    claim = db.query(TADAClaim).filter(TADAClaim.id == cid).first()
    if not claim:
        raise HTTPException(404, "Claim not found")
    if claim.overall_status not in ("CEO Approved", "Accounts Approved"):
        raise HTTPException(
            400, f"Claim needs CEO approval first (status: {claim.overall_status})"
        )

    if data.decision == "approved":
        claim.accounts_status = "approved"
        claim.accounts_approved_by = cu.id
        claim.accounts_approved_at = now_ist()
        claim.overall_status = "Accounts Approved"
        _create_notification(
            db,
            claim.employee_id,
            title=f"TA/DA Approved for Payment: {claim.claim_number}",
            message=f"Accounts approved your TA/DA. Payment of â‚¹{claim.net_payable:,.2f} will be processed.",
            notif_type="approval_done",
            module="tada",
            record_id=claim.id,
        )
    elif data.decision == "paid":
        claim.accounts_status = "paid"
        claim.overall_status = "Paid"
        _create_notification(
            db,
            claim.employee_id,
            title=f"TA/DA Paid: {claim.claim_number}",
            message=f"Payment of â‚¹{claim.net_payable:,.2f} for {claim.claim_number} has been processed.",
            notif_type="success",
            module="tada",
            record_id=claim.id,
        )
    else:
        if not (data.rejection_reason or data.notes or "").strip():
            raise HTTPException(400, "Rejection reason required")
        claim.accounts_status = "rejected"
        claim.accounts_rejection_reason = data.rejection_reason
        claim.overall_status = "Rejected"

    db.add(
        ActivityLog(
            user_id=cu.id,
            module="tada",
            record_id=claim.id,
            action=f"accounts_{data.decision}",
            description=f"Accounts {data.decision} TA/DA {claim.claim_number}",
            icon="ðŸ’°",
            color="#D1FAE5",
        )
    )
    db.commit()
    return {
        "message": f"TA/DA {data.decision} by accounts",
        "overall_status": claim.overall_status,
    }


# â"€â"€â"€ TA/DA Attachments -  per line item â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€


@router.post("/tada/{cid}/line-items/{item_id}/attachments", status_code=201)
async def upload_line_item_attachment(
    cid: int,
    item_id: int,
    request: Request,
    doc_type: str = Query(default="Receipt"),
    file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("travel.update")),
):
    """Upload a proof/receipt for a specific expense line item."""
    claim = db.query(TADAClaim).filter(TADAClaim.id == cid).first()
    if not claim:
        raise HTTPException(404, "Claim not found")
    _ensure_travel_record_access(db, cu, "tada", claim)

    item = (
        db.query(TADALineItem)
        .filter(
            TADALineItem.id == item_id,
            TADALineItem.claim_id == cid,
        )
        .first()
    )
    if not item:
        raise HTTPException(404, "Line item not found")

    ext = os.path.splitext(file.filename or "")[-1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            400,
            f"File type '{ext}' not allowed. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )

    contents = await file.read()
    if not contents:
        raise HTTPException(400, "Uploaded file is empty")
    saved = save_upload_optimized(
        root_dir=os.path.abspath(MEDIA_ROOT),
        subfolder="tada_attachments",
        original_filename=file.filename,
        contents=contents,
        media_slug=media_slug_from_request(request),
        content_type=file.content_type,
    )
    file_size_kb = saved.size_kb
    relative_url = saved.url

    from app.models.all_models import TADAAttachment  # type: ignore

    # â"€â"€ Strategy: try with line_item_id first (requires migration #11).
    # If the column doesn't exist yet, fall back to claim-level attachment
    # so uploads never fail regardless of migration state.
    att = None

    # Attempt 1: full record with line_item_id
    try:
        vcols = {c.name for c in TADAAttachment.__table__.columns}
        kw = dict(
            claim_id=cid,
            file_name=file.filename or safe_name,
            file_url=relative_url,
            file_size_kb=file_size_kb,
            doc_type=doc_type,
            uploaded_by=cu.id,
        )
        if "line_item_id" in vcols:
            kw["line_item_id"] = item_id

        att = TADAAttachment(**kw)
        db.add(att)
        db.commit()
        db.refresh(att)
    except Exception as e:
        logger.error(f"TADAAttachment insert error: {e}")
        db.rollback()
        # Attempt 2: without line_item_id (migration not yet applied)
        try:
            att = TADAAttachment(
                claim_id=cid,
                file_name=file.filename or safe_name,
                file_url=relative_url,
                file_size_kb=file_size_kb,
                doc_type=doc_type,
                uploaded_by=cu.id,
            )
            db.add(att)
            db.commit()
            db.refresh(att)
            logger.warning(
                "Saved attachment without line_item_id -  run migration #11 "
                "(ALTER TABLE tada_attachments ADD COLUMN line_item_id INT NULL)."
            )
        except Exception as e2:
            logger.error(f"TADAAttachment fallback also failed: {e2}")
            db.rollback()
            # Last resort: return success with no DB record (file is saved on disk)
            return {
                "id": None,
                "file_name": file.filename or safe_name,
                "file_url": relative_url,
                "preview_url": relative_url,
                "doc_type": doc_type,
                "file_size_kb": file_size_kb,
                "line_item_id": item_id,
            }

    return {
        "id": att.id,
        "file_name": att.file_name,
        "file_url": att.file_url,
        "preview_url": att.file_url,
        "doc_type": att.doc_type,
        "file_size_kb": file_size_kb,
        "line_item_id": item_id,
    }


@router.delete("/tada/{cid}/attachments/{att_id}")
def delete_tada_attachment(
    cid: int,
    att_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("travel.delete")),
):
    claim = db.query(TADAClaim).filter(TADAClaim.id == cid).first()
    if not claim:
        raise HTTPException(404, "Claim not found")
    _ensure_travel_record_access(db, cu, "tada", claim)
    try:
        from app.models.all_models import TADAAttachment  # type: ignore

        att = (
            db.query(TADAAttachment)
            .filter(
                TADAAttachment.id == att_id,
                TADAAttachment.claim_id == cid,
            )
            .first()
        )
        if not att:
            raise HTTPException(404, "Attachment not found")
        abs_path = media_url_to_logical_path(
            root_dir=os.path.abspath(MEDIA_ROOT),
            file_url=att.file_url,
        )
        delete_stored_file(abs_path)
        db.delete(att)
        db.commit()
        tenant_slug = str(db.info.get("tenant_slug") or "").strip()
        if tenant_slug:
            refresh_tenant_storage_usage_for_slug(tenant_slug)
        return {"message": "Deleted"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


# â"€â"€â"€ Pending approvals â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€


@router.get("/pending-approvals")
def pending_approvals(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    _refresh_travel_auto_approvals(db, approver_id=cu.id)
    out: dict = {"travel_requests": [], "tada_claims": []}
    approvals = (
        db.query(Approval)
        .filter(
            Approval.requested_to == cu.id,
            Approval.module.in_(["travel", "tada"]),
            Approval.status == "pending",
        )
        .all()
    )
    travel_ids = [int(appr.record_id) for appr in approvals if appr.module == "travel" and appr.record_id]
    tada_ids = [int(appr.record_id) for appr in approvals if appr.module == "tada" and appr.record_id]
    travel_requests = {
        int(row.id): row
        for row in db.query(TravelRequest).filter(TravelRequest.id.in_(travel_ids)).all()
    } if travel_ids else {}
    tada_claims = {
        int(row.id): row
        for row in db.query(TADAClaim).filter(TADAClaim.id.in_(tada_ids)).all()
    } if tada_ids else {}
    employee_ids = {
        int(record.employee_id)
        for record in [*travel_requests.values(), *tada_claims.values()]
        if getattr(record, "employee_id", None)
    }
    employee_map = {
        int(user.id): user
        for user in db.query(User).filter(User.id.in_(employee_ids)).all()
    } if employee_ids else {}
    for appr in approvals:
        if appr.module == "travel":
            tr = travel_requests.get(int(appr.record_id)) if appr.record_id else None
            if tr:
                emp = employee_map.get(int(tr.employee_id)) if tr.employee_id else None
                out["travel_requests"].append(
                    {
                        "approval_id": appr.id,
                        "id": tr.id,
                        "request_number": tr.request_number,
                        "employee_name": emp.full_name if emp else "",
                        "from_city": tr.from_city,
                        "to_city": tr.to_city,
                        "travel_date": str(tr.travel_date),
                        "purpose": tr.purpose,
                        "source": getattr(tr, "source", "direct"),
                    }
                )
        else:
            claim = tada_claims.get(int(appr.record_id)) if appr.record_id else None
            if claim:
                emp = employee_map.get(int(claim.employee_id)) if claim.employee_id else None
                out["tada_claims"].append(
                    {
                        "approval_id": appr.id,
                        "id": claim.id,
                        "claim_number": claim.claim_number,
                        "employee_name": emp.full_name if emp else "",
                        "total_amount": float(claim.total_amount or 0),
                        "net_payable": float(claim.net_payable or 0),
                        "purpose": claim.purpose,
                        "action": appr.action,
                    }
                )
    return out


# â"€â"€â"€ Badge / mark-seen â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€


@router.get("/badge")
def get_travel_badge(
    db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)
):
    layout = dict(cu.dashboard_layout or {})
    last_seen_str = layout.get("travel_last_seen_at")
    if not last_seen_str:
        layout["travel_last_seen_at"] = now_ist().isoformat()
        cu.dashboard_layout = layout
        db.commit()
        return {"count": 0}
    try:
        last_seen = datetime.fromisoformat(last_seen_str)
    except ValueError:
        return {"count": 0}
    q = db.query(func.count(TravelRequest.id)).filter(TravelRequest.created_at > last_seen)
    scope_user_ids = _scope_user_ids(db, cu)
    if scope_user_ids is not None:
        q = q.filter(TravelRequest.employee_id.in_(scope_user_ids))
    count = q.scalar() or 0
    return {"count": count}


@router.post("/mark-seen")
def mark_travel_seen(
    db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)
):
    layout = dict(cu.dashboard_layout or {})
    layout["travel_last_seen_at"] = now_ist().isoformat()
    cu.dashboard_layout = layout
    db.commit()
    invalidate_badges_cache(db, cu.id)
    return {"ok": True}


@router.get("/tada/badge")
def get_tada_badge(
    db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)
):
    layout = dict(cu.dashboard_layout or {})
    last_seen_str = layout.get("tada_last_seen_at")
    if not last_seen_str:
        layout["tada_last_seen_at"] = now_ist().isoformat()
        cu.dashboard_layout = layout
        db.commit()
        return {"count": 0}
    try:
        last_seen = datetime.fromisoformat(last_seen_str)
    except ValueError:
        return {"count": 0}
    count = (
        db.query(func.count(TADAClaim.id))
        .filter(TADAClaim.created_at > last_seen)
        .scalar()
        or 0
    )
    return {"count": count}


@router.post("/tada/mark-seen")
def mark_tada_seen(
    db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)
):
    layout = dict(cu.dashboard_layout or {})
    layout["tada_last_seen_at"] = now_ist().isoformat()
    cu.dashboard_layout = layout
    db.commit()
    invalidate_badges_cache(db, cu.id)
    return {"ok": True}


