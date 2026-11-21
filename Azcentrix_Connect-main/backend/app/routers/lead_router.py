"""Lead router — updated workflow with step-based flow + kanban drag-drop.

Steps
──────
Step 1: Lead Info  (status: Assigned / Qualified)
Step 2: Opportunity Details  (status: Opportunity Created)
Step 3: Conversion  (approval_status: pending → approved → Converted)

Kanban columns
──────────────
  Assigned | Qualified | Opportunity Created
  | Pending Approval | Rejected Opportunity | Converted | Lost

Drag-drop endpoints
───────────────────
PATCH  /{id}/status              → Assigned / Qualification / Lost
PATCH  /{id}/status              → Opportunity Created  (frontend also calls PUT /products after)
PATCH  /{id}/qualify             → saves competitor_ids, notes, product_description (gate modal)
POST   /{id}/request-conversion  → Pending Approval column drop & list-page action
                                   (admin/ceo = direct; others = pending)
POST   /{id}/approve-conversion  → Rejected Opportunity column drop & approvals page
POST   /{id}/re-request-conversion → after rejection
"""
import logging
import json
from collections import defaultdict
from datetime import date, datetime, timezone
from app.core.timezone import now_ist, today_ist
from typing import Any, Optional, List
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import and_, bindparam, false, func, or_, true, text as _text
from sqlalchemy.orm import Session, selectinload
from pydantic import BaseModel
from app.dependencies import (
    get_tenant_db, get_current_user, require_permission, get_request_ip,
    ensure_permission, user_has_permission,
)
from app.models.all_models import (
    Lead, LeadProduct, LeadProductOEM,
    Customer, CustomerContact, User, Tender, Notification, ActivityLog,
    ProductMaster, OEM, LeadSource, SalesCustomerAssignment, UserReportingHierarchy, OrgTreeNode,
    Role, Permission, RolePermission, KAMActivity, ApprovalRequest, ApprovalRequestStep, Approval,
)
from app.services.lead_notification_service import (
    dispatch_lead_event_notification,
    is_high_priority_lead,
)
from app.services.notification_service import upsert_notification
from app.services.cache_service import invalidate_badges_cache
from app.services.approval_service import create_approval_request, process_approval_decision
from app.services.generic_approval_engine import (
    create_generic_approval_request,
    find_latest_request_for_record,
    get_request_progress,
)
from app.core.logging import log_module_action, log_error_db, model_snapshot
from app.utils.data_scope import apply_data_scope, get_module_data_scope, get_team_user_ids

logger = logging.getLogger(__name__)
router = APIRouter()

# ─── Transition map ───────────────────────────────────────────────────────────

# Open stages (prototype v17: New = Assigned · Contacted · Qualified · Proposal Pending · Nurturing) move freely
# between each other, to Opportunity Created (deal) or to Lost (Disqualified).
_OPEN_LEAD = ['Assigned', 'Contacted', 'Qualified', 'Proposal Pending', 'Nurturing']
ALLOWED_TRANSITIONS: dict[str, list[str]] = {
    'Assigned':                  _OPEN_LEAD + ['Opportunity Created', 'Lost'],
    'Contacted':                 _OPEN_LEAD + ['Opportunity Created', 'Lost'],
    'Qualified':                 _OPEN_LEAD + ['Opportunity Created', 'Lost'],
    'Proposal Pending':          _OPEN_LEAD + ['Opportunity Created', 'Lost'],
    'Nurturing':                 _OPEN_LEAD + ['Opportunity Created', 'Lost'],
    'Opportunity Created':       ['Opportunity Created'],
    'Converted':                 ['Converted'],
    'Lost':                      ['Lost'],
}

PRIVILEGED_ROLES = ('admin', 'ceo')
MANAGER_ROLES    = ('admin', 'ceo', 'manager', 'vp')


def _assert_transition(old: str, new: str):
    if old == new:
        return
    allowed = ALLOWED_TRANSITIONS.get(old, [old])
    if new not in allowed:
        forward = [s for s in allowed if s != old]
        raise HTTPException(
            400,
            f"Cannot change status from '{old}' to '{new}'. "
            f"Allowed next state(s): {forward or ['none (terminal)']}",
        )


# ─── Ref-ID generators ────────────────────────────────────────────────────────

def _next_lead_ref_id(db: Session) -> str:
    prefix = now_ist().strftime("LD%Y%m")
    row = db.execute(
        _text("SELECT MAX(CAST(SUBSTRING(lead_ref_id, :offset) AS UNSIGNED)) FROM leads WHERE lead_ref_id LIKE :p"),
        {"p": f"{prefix}%", "offset": len(prefix) + 1}
    ).fetchone()
    n = row[0] if row and row[0] else 0
    return f"{prefix}{(n + 1):06d}"

def _next_opportunity_ref_id(db: Session) -> str:
    prefix = now_ist().strftime("OP%Y%m")
    row = db.execute(
        _text("SELECT MAX(CAST(SUBSTRING(opportunity_ref_id, :offset) AS UNSIGNED)) FROM leads WHERE opportunity_ref_id LIKE :p"),
        {"p": f"{prefix}%", "offset": len(prefix) + 1}
    ).fetchone()
    n = row[0] if row and row[0] else 0
    return f"{prefix}{(n + 1):06d}"

def _next_tender_ref_id(db: Session) -> str:
    """Sequential tender number — same format as manual tender creation: TND-YYYYMM-000001."""
    prefix = now_ist().strftime("TND-%Y%m-")
    row = db.execute(
        _text("SELECT MAX(CAST(SUBSTRING(tender_num, :offset) AS UNSIGNED)) FROM tenders WHERE tender_num LIKE :p"),
        {"p": f"{prefix}%", "offset": len(prefix) + 1}
    ).fetchone()
    n = row[0] if row and row[0] else 0
    return f"{prefix}{(n + 1):06d}"


# ─── Notification helper ──────────────────────────────────────────────────────

def _notify(db: Session, user_id: int, title: str, message: str,
            module: str, record_id: int, action: str) -> None:
    try:
        upsert_notification(
            db,
            user_id=user_id,
            title=title,
            message=message,
            module=module,
            record_id=record_id,
            action=action,
            send_email=True,
        )
    except Exception as e:
        logger.warning(f"_notify failed: {e}")


def _get_lead_conversion_approval_state(db: Session, lead: Lead) -> dict:
    latest_request = find_latest_request_for_record(
        db,
        module_key="lead",
        action_key="convert",
        record_id=lead.id,
    )
    if latest_request:
        progress = get_request_progress(latest_request)
        active_step = next(
            (
                step
                for step in sorted(latest_request.steps or [], key=lambda item: item.step_no)
                if step.step_no == latest_request.current_step_no
            ),
            None,
        )
        return {
            "approval_request_id": latest_request.id,
            "approval_status": latest_request.status,
            "approval_display": progress["display"],
            "approval_progress_current": progress["current"],
            "approval_progress_total": progress["total"],
            "approval_requested_to": active_step.approver_user_id if active_step else None,
            "approval_requested_to_name": (
                active_step.approver.full_name
                if active_step and active_step.approver
                else ""
            ),
        }

    normalized_status = (lead.approval_status or "").strip().lower()
    return {
        "approval_request_id": None,
        "approval_status": lead.approval_status or "",
        "approval_display": {
            "pending": "Pending",
            "approved": "Approved",
            "rejected": "Rejected",
            "none": "None",
        }.get(normalized_status, lead.approval_status or ""),
        "approval_progress_current": None,
        "approval_progress_total": None,
        "approval_requested_to": None,
        "approval_requested_to_name": "",
    }


def _lead_conversion_approval_state_from_request(lead: Lead, latest_request: Optional[ApprovalRequest]) -> dict:
    if latest_request:
        progress = get_request_progress(latest_request)
        active_step = next(
            (
                step
                for step in sorted(latest_request.steps or [], key=lambda item: item.step_no)
                if step.step_no == latest_request.current_step_no
            ),
            None,
        )
        return {
            "approval_request_id": latest_request.id,
            "approval_status": latest_request.status,
            "approval_display": progress["display"],
            "approval_progress_current": progress["current"],
            "approval_progress_total": progress["total"],
            "approval_requested_to": active_step.approver_user_id if active_step else None,
            "approval_requested_to_name": (
                active_step.approver.full_name
                if active_step and active_step.approver
                else ""
            ),
        }

    normalized_status = (lead.approval_status or "").strip().lower()
    return {
        "approval_request_id": None,
        "approval_status": lead.approval_status or "",
        "approval_display": {
            "pending": "Pending",
            "approved": "Approved",
            "rejected": "Rejected",
            "none": "None",
        }.get(normalized_status, lead.approval_status or ""),
        "approval_progress_current": None,
        "approval_progress_total": None,
        "approval_requested_to": None,
        "approval_requested_to_name": "",
    }


def _latest_lead_conversion_requests(db: Session, lead_ids: list[int]) -> dict[int, ApprovalRequest]:
    if not lead_ids:
        return {}
    rows = (
        db.query(ApprovalRequest)
        .options(
            selectinload(ApprovalRequest.steps).selectinload(ApprovalRequestStep.approver),
        )
        .filter(
            ApprovalRequest.module_key == "lead",
            ApprovalRequest.action_key == "convert",
            ApprovalRequest.record_id.in_(lead_ids),
        )
        .order_by(ApprovalRequest.record_id, ApprovalRequest.requested_at.desc(), ApprovalRequest.id.desc())
        .all()
    )
    latest_by_lead: dict[int, ApprovalRequest] = {}
    for request in rows:
        latest_by_lead.setdefault(int(request.record_id), request)
    return latest_by_lead


def _is_high_priority_value(value: Optional[str]) -> bool:
    return str(value or "").strip().lower() == "high"


def _optional_iso_date(value: Any, field_label: str, *, as_date: bool = False) -> Optional[str | date]:
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value.date()
        return parsed if as_date else parsed.isoformat()
    if isinstance(value, date):
        return value if as_date else value.isoformat()

    raw = str(value).strip()
    if not raw:
        return None

    try:
        parsed = date.fromisoformat(raw[:10])
    except ValueError:
        raise HTTPException(422, f"{field_label} must be a valid date.")

    return parsed if as_date else parsed.isoformat()


def _lead_assignee_name(db: Session, lead: Lead) -> str:
    if not getattr(lead, "assigned_to", None):
        return "Unassigned"
    assignee = db.query(User).filter(User.id == lead.assigned_to).first()
    return assignee.full_name if assignee and assignee.full_name else "Assigned user"


def _dispatch_lead_event(
    db: Session,
    *,
    lead: Lead,
    event_key: str,
    title: str,
    message: str,
    actor_user_id: Optional[int],
) -> None:
    try:
        dispatch_lead_event_notification(
            db,
            lead=lead,
            event_key=event_key,
            title=title,
            message=message,
            actor_user_id=actor_user_id,
        )
    except Exception as exc:
        logger.warning("lead event notification failed for lead=%s event=%s: %s", lead.id, event_key, exc)

# ─── Pydantic schemas ─────────────────────────────────────────────────────────

class OEMEntry(BaseModel):
    oem_id:   Optional[int] = None
    oem_name: Optional[str] = None

class ProductEntry(BaseModel):
    product_id:   Optional[int] = None
    product_name: Optional[str] = None
    quantity:     int = 1
    description:  Optional[str] = None
    oems:         List[OEMEntry] = []

class ProductsUpdate(BaseModel):
    products: List[ProductEntry] = []

class LeadCreate(BaseModel):
    customer_id:         Optional[int]       = None
    customer_name:       Optional[str]       = None
    customer_address:    Optional[str]       = None
    department:          Optional[str]       = None
    contact_person:      Optional[str]       = None
    designation:         Optional[str]       = None
    mobile:              Optional[str]       = None
    email:               Optional[str]       = None
    lead_title:          str
    source_id:           Optional[int]       = None
    business_vertical_id: Optional[int] = None
    priority:            str                 = "Medium"
    status:              str                 = "Assigned"
    est_value:           float               = 0
    tender_id_ref:       Optional[str]       = None
    timeline:            Optional[str]       = None
    follow_up:           Optional[str]       = None
    product_description: Optional[str]       = None
    notes:               Optional[str]       = None
    competitor_ids:      Optional[List[int]] = None
    assigned_to:         Optional[int]       = None
    region:              Optional[str]       = None
    branch:              Optional[str]       = None
    products:            List[ProductEntry]  = []
    lead_type:           Optional[str]       = 'lead'
    conversion_target:   Optional[str]       = None
    custom_data:         Optional[dict]      = None

class LeadUpdate(LeadCreate):
    lead_title: Optional[str] = None
    status:     Optional[str] = None  # Override parent default — None means "keep existing status"

class Decision(BaseModel):
    decision:         str
    notes:            Optional[str] = None
    rejection_reason: Optional[str] = None

class ConversionRequestBody(BaseModel):
    # 'tender' (default — preserves existing behaviour) or 'quotation'
    conversion_target: Optional[str] = 'tender'

# ─── NEW: Qualification patch schema ─────────────────────────────────────────

class LeadQualifyPatch(BaseModel):
    """
    Sent by the Kanban qualification-gate modal when a lead is dragged
    out of 'Assigned' and one or more of these fields were empty.
    Only updates these three fields — nothing else changes.
    """
    competitor_ids:      Optional[List[int]] = None
    notes:               Optional[str]       = None
    product_description: Optional[str]       = None

    model_config = {"extra": "ignore"}


# ─── Scope helper ─────────────────────────────────────────────────────────────

ADMIN_LEAD_ROLES = {"admin", "ceo", "super_admin"}

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

def _user_group_ids_overlap(user_group_id: Optional[str], manager_group_ids: set[int]) -> bool:
    return bool(_parse_group_ids(user_group_id) & manager_group_ids)

def _get_org_tree_user_ids(db: Session, user_id: int) -> list[int]:
    """Return all user IDs visible to user_id based on the Group Fixing tree (OrgTreeNode)."""
    return get_team_user_ids(db, int(user_id))


def _lead_scope_user_ids(db: Session, current_user: User) -> Optional[list[int]]:
    role = _normalized_role(getattr(current_user, "role", ""))

    if role in ADMIN_LEAD_ROLES:
        return None

    current_user_id = int(current_user.id)

    if role in ("sales", "sales_executive"):
        return [current_user_id]

    raw_group_id = getattr(current_user, "group_id", None)
    user_group_ids = _parse_group_ids(raw_group_id)

    team_ids = [current_user_id]

    if not user_group_ids:
        return _get_org_tree_user_ids(db, current_user_id)

    # For manager/sales_head: find groups where this user is the group lead
    group_lead_group_ids: set[int] = set()
    if role == "manager":  # sales_head normalises to manager
        lead_rows = (
            db.query(UserReportingHierarchy.group_id)
            .filter(
                UserReportingHierarchy.reporting_user_id == current_user_id,
                UserReportingHierarchy.is_group_lead == 1,
                UserReportingHierarchy.is_active == True,
                UserReportingHierarchy.group_id.is_not(None),
            )
            .all()
        )
        for row in lead_rows:
            gid = getattr(row, "group_id", None)
            if gid is not None:
                try:
                    group_lead_group_ids.add(int(gid))
                except (TypeError, ValueError):
                    pass

    for user in db.query(User).filter(User.is_active == True).all():
        uid = int(user.id)
        if uid == current_user_id:
            continue

        user_role = _normalized_role(getattr(user, "role", ""))
        user_group_id = getattr(user, "group_id", None)

        if not _user_group_ids_overlap(user_group_id, user_group_ids):
            continue

        if role == "vp":
            if user_role in ("manager", "sales_head", "sales"):
                team_ids.append(uid)

        elif role == "manager":
            if user_role in ("sales", "sales_executive"):
                team_ids.append(uid)
            elif user_role in ("manager", "sales_head") and group_lead_group_ids:
                other_gids = _parse_group_ids(user_group_id)
                if other_gids & group_lead_group_ids:
                    team_ids.append(uid)

    return sorted(set(team_ids))


def _get_lead_module_data_scope(db: Session, user: User) -> str:
    role_row = db.query(Role).filter(
        Role.name == user.role,
        Role.is_active == True,
    ).first()

    if not role_row:
        return "own"

    row = (
        db.query(RolePermission)
        .join(Permission, Permission.id == RolePermission.permission_id)
        .filter(
            RolePermission.role_id == role_row.id,
            Permission.module.in_(["leads", "lead"]),
        )
        .first()
    )

    scope = (getattr(row, "data_scope", None) or "own").lower() if row else "own"
    return scope if scope in {"all", "team", "own", "none"} else "own"

# Leads and Opportunities share the Lead table. A record belongs to the
# Opportunities module when it is a direct opportunity or has progressed to
# 'Opportunity Created' / 'Converted' (mirrors getOpportunityStageKey /
# shouldOpenQuotationOpportunityView in the frontend). Each half is governed by
# its own role permissions and data-visibility scope.
_OPPORTUNITY_STATUSES = ("Opportunity Created", "Converted")


def _is_opportunity_lead(lead) -> bool:
    return (
        (getattr(lead, "lead_type", None) or "lead") == "direct_opportunity"
        or getattr(lead, "status", None) in _OPPORTUNITY_STATUSES
    )


def _lead_perm_module(lead) -> str:
    """Permission module ("leads" / "opportunities") governing *lead*."""
    return "opportunities" if _is_opportunity_lead(lead) else "leads"


def _opportunity_clause():
    return or_(
        func.coalesce(Lead.lead_type, "lead") == "direct_opportunity",
        func.coalesce(Lead.status, "").in_(_OPPORTUNITY_STATUSES),
    )


def _module_scope_clause(db: Session, cu: User, module_key: str):
    scope = get_module_data_scope(db, cu, module_key)
    if scope == "all":
        return true()
    if scope == "none":
        return false()
    user_ids = [int(cu.id)] if scope == "own" else get_team_user_ids(db, int(cu.id))
    return or_(Lead.created_by.in_(user_ids), Lead.assigned_to.in_(user_ids))


def _scope_query(q, db: Session, cu: User):
    """Lead rows use the Leads view permission + scope; opportunity rows use the
    Opportunities view permission + scope."""
    q = q.filter(Lead.is_deleted == False)
    parts = []
    if user_has_permission(db, cu, "leads.view"):
        parts.append(and_(~_opportunity_clause(), _module_scope_clause(db, cu, "leads")))
    if user_has_permission(db, cu, "opportunities.view"):
        parts.append(and_(_opportunity_clause(), _module_scope_clause(db, cu, "opportunity")))
    if not parts:
        return q.filter(false())
    return q.filter(or_(*parts))


def _ensure_any_lead_view(db: Session, cu: User) -> None:
    if not (user_has_permission(db, cu, "leads.view")
            or user_has_permission(db, cu, "opportunities.view")):
        ensure_permission(db, cu, "leads.view")  # raises 403


def _ensure_lead_access(db: Session, cu: User, lead: Lead, action: str) -> None:
    """403 unless the role holds <module>.<action> for this record's module;
    404 when the record is outside the user's data-visibility scope."""
    module = _lead_perm_module(lead)
    ensure_permission(db, cu, f"{module}.{action}")
    scope_key = "opportunity" if module == "opportunities" else "leads"
    visible = (
        db.query(Lead.id)
        .filter(Lead.id == lead.id, _module_scope_clause(db, cu, scope_key))
        .first()
    )
    if not visible:
        raise HTTPException(404, "Lead not found")

@router.get("/team-users")
def lead_team_users(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    scope = get_module_data_scope(db, cu, "leads")

    if scope == "all":
        scope_user_ids = None
    elif scope == "none":
        scope_user_ids = []
    elif scope == "own":
        scope_user_ids = [int(cu.id)]
    else:  # team
        scope_user_ids = get_team_user_ids(db, int(cu.id))

    if scope_user_ids is None:
        users = db.query(User).filter(User.is_active == True).order_by(User.full_name).all()
    else:
        users = db.query(User).filter(
            User.id.in_(scope_user_ids),
            User.is_active == True,
        ).order_by(User.full_name).all()

    return [
        {"id": u.id, "label": u.full_name, "role": u.role}
        for u in users
    ]

@router.get("/team-customers")
def lead_team_customers(
    assigned_only: bool = False,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    # Letter creation is always limited to the signed-in sales executive's
    # portfolio when requested, irrespective of broader Leads list access.
    scope = "own" if assigned_only else get_module_data_scope(db, cu, "leads")

    if scope == "all":
        scope_user_ids = None
    elif scope == "none":
        scope_user_ids = []
    elif scope == "own":
        scope_user_ids = [int(cu.id)]
    else:  # team
        scope_user_ids = get_team_user_ids(db, int(cu.id))

    q = db.query(Customer).filter(Customer.is_deleted == False)

    if scope_user_ids is not None:
        if not scope_user_ids:
            q = q.filter(false())
        else:
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

    customers = q.order_by(Customer.customer_name).all()

    def _approval_display(customer: Customer) -> Optional[str]:
        normalized_status = (customer.approval_status or "").strip().lower()
        if not normalized_status:
            return None
        return {
            "approved": "Approved",
            "rejected": "Rejected",
            "pending": "Pending",
        }.get(normalized_status, str(customer.approval_status or "").replace("_", " ").title())

    return [
        {
            "id": c.id,
            "customer_name": c.customer_name,
            "approval_status": c.approval_status,
            "approval_display": _approval_display(c),
            "is_active": c.is_active,
        }
        for c in customers
        if c.customer_name
    ]

# ─── Sidebar badge ────────────────────────────────────────────────────────────

@router.get("/badge")
def get_lead_badge(
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    layout = dict(cu.dashboard_layout or {})
    last_seen_str = layout.get("leads_last_seen_at")

    if not last_seen_str:
        layout["leads_last_seen_at"] = now_ist().isoformat()
        cu.dashboard_layout = layout
        db.commit()
        return {"count": 0}

    try:
        last_seen = datetime.fromisoformat(last_seen_str)
    except ValueError:
        return {"count": 0}

    q = db.query(func.count(Lead.id)).filter(
        Lead.created_at > last_seen,
    )

    # Apply same lead hierarchy / group based scope
    q = _scope_query(q, db, cu)

    count = q.scalar() or 0
    return {"count": count}

@router.post("/mark-seen")
def mark_leads_seen(
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    layout = dict(cu.dashboard_layout or {})
    layout["leads_last_seen_at"] = now_ist().isoformat()
    cu.dashboard_layout = layout
    db.commit()
    invalidate_badges_cache(db, cu.id)
    return {"ok": True}


# ─── Per-user list-table display preferences (leads list only) ────────────────

class LeadsTablePrefsBody(BaseModel):
    stack_order: dict = {}


@router.get("/table-prefs")
def get_leads_table_prefs(
    cu: User = Depends(get_current_user),
):
    layout = dict(cu.dashboard_layout or {})
    return layout.get("table_prefs", {}).get("leads-list", {"stack_order": {}})


@router.post("/table-prefs")
def save_leads_table_prefs(
    body: LeadsTablePrefsBody,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    layout = dict(cu.dashboard_layout or {})
    table_prefs = dict(layout.get("table_prefs", {}))
    table_prefs["leads-list"] = {"stack_order": body.stack_order}
    layout["table_prefs"] = table_prefs
    cu.dashboard_layout = layout
    db.commit()
    return {"ok": True}


# ─── Customer active contact ──────────────────────────────────────────────────

@router.get("/customer/{customer_id}/active-contact")
def get_customer_active_contact(
    customer_id: int,
    db: Session = Depends(get_tenant_db),
    _: User     = Depends(get_current_user),
):
    cust = db.query(Customer).filter(Customer.id == customer_id).first()
    if not cust:
        raise HTTPException(404, "Customer not found")
    contact = (
        db.query(CustomerContact).filter(
            CustomerContact.customer_id == customer_id,
            CustomerContact.is_active   == True,
            CustomerContact.is_primary  == True,
        ).first()
        or
        db.query(CustomerContact).filter(
            CustomerContact.customer_id == customer_id,
            CustomerContact.is_active   == True,
        ).first()
    )
    parts = [p for p in [cust.billing_city, cust.billing_state] if p]
    return {
        "customer_name":       cust.customer_name,
        "customer_address":    ", ".join(parts),
        "billing_city":        cust.billing_city  or "",
        "billing_state":       cust.billing_state or "",
        "department":          contact.department       if contact else "",
        "contact_name":        contact.contact_name     if contact else "",
        "contact_designation": contact.designation      if contact else "",
        "contact_phone":       contact.mobile           if contact else "",
        "contact_email":       contact.office_email     if contact else "",
    }


# ─── Kanban ───────────────────────────────────────────────────────────────────

@router.get("/kanban")
def get_leads_kanban(
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    _ensure_any_lead_view(db, cu)
    try:
        # Apply same lead hierarchy / group based scope
        q = _scope_query(db.query(Lead), db, cu)

        leads = q.filter(Lead.lead_type == 'lead').order_by(Lead.created_at.desc()).all()
        user_map = {u.id: u for u in db.query(User).all()}
        lead_ids = [int(lead.id) for lead in leads if lead.id]
        approval_requests_by_lead = _latest_lead_conversion_requests(db, lead_ids)

        competitor_ids_by_lead: dict[int, list] = {}
        if lead_ids:
            try:
                competitor_stmt = _text(
                    "SELECT id, competitor_ids FROM leads WHERE id IN :lead_ids"
                ).bindparams(bindparam("lead_ids", expanding=True))
                for row in db.execute(competitor_stmt, {"lead_ids": lead_ids}).fetchall():
                    raw = row[1]
                    competitor_ids_by_lead[int(row[0])] = json.loads(raw) if raw else []
            except Exception:
                competitor_ids_by_lead = {}

        products_by_lead: dict[int, list[LeadProduct]] = {}
        product_rows = (
            db.query(LeadProduct)
            .filter(LeadProduct.lead_id.in_(lead_ids))
            .all()
        ) if lead_ids else []
        for product in product_rows:
            products_by_lead.setdefault(int(product.lead_id), []).append(product)

        product_ids = {int(p.id) for p in product_rows if p.id}
        product_master_ids = {int(p.product_id) for p in product_rows if p.product_id and not p.product_name}
        oems_by_product: dict[int, list[LeadProductOEM]] = {}
        oem_rows = (
            db.query(LeadProductOEM)
            .filter(LeadProductOEM.lead_product_id.in_(product_ids))
            .all()
        ) if product_ids else []
        for oem in oem_rows:
            oems_by_product.setdefault(int(oem.lead_product_id), []).append(oem)

        oem_master_ids = {int(o.oem_id) for o in oem_rows if o.oem_id and not o.oem_name}
        product_name_by_id = dict(
            db.query(ProductMaster.id, ProductMaster.name).filter(ProductMaster.id.in_(product_master_ids)).all()
        ) if product_master_ids else {}
        oem_name_by_id = dict(
            db.query(OEM.id, OEM.name).filter(OEM.id.in_(oem_master_ids)).all()
        ) if oem_master_ids else {}

        def _kanban_col(lead: Lead) -> str:
            if lead.status == 'Opportunity Created':
                appr = (lead.approval_status or '').lower()
                if appr == 'pending':
                    return 'Pending Approval'
                if appr in ('rejected', 'rejected opportunity'):
                    return 'Rejected Opportunity'
            return lead.status

        result: dict[str, list] = {
            'Assigned':             [],
            'Qualified':            [],
            'Opportunity Created':  [],
            'Pending Approval':     [],
            'Rejected Opportunity': [],
            'Converted':            [],
            'Lost':                 [],
        }

        for lead in leads:
            col = _kanban_col(lead)
            if col not in result:
                continue

            assigned_user = user_map.get(lead.assigned_to)
            approval_state = _lead_conversion_approval_state_from_request(
                lead,
                approval_requests_by_lead.get(int(lead.id)),
            )
            competitor_ids = competitor_ids_by_lead.get(int(lead.id), [])

            result[col].append({
                "id": lead.id,
                "lead_name": lead.lead_title or '—',
                "lead_title": lead.lead_title or '—',
                "customer_name": lead.customer_name or '—',
                "lead_ref_id": lead.lead_ref_id or '—',
                "opportunity_ref_id": lead.opportunity_ref_id or '—',
                "customer_address": lead.customer_address or '—',
                "contact_person": lead.contact_person or '—',
                "mobile": lead.mobile or '—',
                "email": lead.email or '',
                "department": lead.department or '',
                "designation": lead.designation or '',
                "est_value": float(lead.est_value) if lead.est_value else 0,
                "lead_value": float(lead.est_value) if lead.est_value else 0,
                "status": lead.status,
                "lead_type": lead.lead_type or 'lead',
                "approval_status": approval_state["approval_status"],
                "approval_display": approval_state["approval_display"],
                "approval_progress_current": approval_state["approval_progress_current"],
                "approval_progress_total": approval_state["approval_progress_total"],
                "approval_request_id": approval_state["approval_request_id"],
                "approval_requested_to": approval_state["approval_requested_to"],
                "approval_requested_to_name": approval_state["approval_requested_to_name"],
                "rejection_reason": lead.rejection_reason or '',
                "priority": lead.priority or '',
                "assigned_to": assigned_user.full_name if assigned_user else "—",
                "assigned_to_id": lead.assigned_to,
                "notes": lead.notes or '',
                "product_description": lead.product_description or '',
                "competitor_ids": competitor_ids,
                "created_at": lead.created_at.isoformat() if lead.created_at else None,
                "converted_at": lead.converted_at.isoformat() if lead.converted_at else None,
                "converted_tender_id": getattr(lead, "converted_tender_id", None),
                "conversion_target": getattr(lead, "conversion_target", None) or "",
                "products": [
                    _prod_dict_from_maps(p, oems_by_product, product_name_by_id, oem_name_by_id)
                    for p in products_by_lead.get(int(lead.id), [])
                ],
            })

        return {
            "columns": [
                {"key": k, "leads": v, "count": len(v)}
                for k, v in result.items()
            ],
            "total": sum(len(v) for v in result.values()),
        }

    except Exception as e:
        logger.exception(f"KANBAN ERROR: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ─── List ─────────────────────────────────────────────────────────────────────

@router.get("")
def list_leads(
    status:                      Optional[str] = None,
    customer_id:                 Optional[int] = None,
    priority:                    Optional[str] = None,
    search:                      Optional[str] = None,
    assigned_to:                 Optional[int] = None,
    exclude_direct_opportunity:  bool = False,
    db: Session  = Depends(get_tenant_db),
    cu: User     = Depends(get_current_user),
):
    if exclude_direct_opportunity:
        ensure_permission(db, cu, "leads.view")  # Leads module list
    else:
        _ensure_any_lead_view(db, cu)
    q = _scope_query(db.query(Lead), db, cu)
    if exclude_direct_opportunity:
        q = q.filter(Lead.lead_type != 'direct_opportunity')  # Leads module only
    if status:      q = q.filter(Lead.status == status)
    if customer_id: q = q.filter(Lead.customer_id == customer_id)
    if priority:    q = q.filter(Lead.priority == priority)
    if search:      q = q.filter(Lead.lead_title.contains(search))
    if assigned_to: q = q.filter(Lead.assigned_to == assigned_to)

    lead_rows = q.order_by(Lead.created_at.desc()).all()

    source_ids = {int(lead.source_id) for lead in lead_rows if lead.source_id}
    source_names = dict(
        db.query(LeadSource.id, LeadSource.name).filter(LeadSource.id.in_(source_ids)).all()
    ) if source_ids else {}

    lead_ids = [lead.id for lead in lead_rows]
    latest_activity_by_lead: dict[int, ActivityLog] = {}
    if lead_ids:
        activity_rows = (
            db.query(ActivityLog)
            .filter(
                ActivityLog.module == "leads",
                ActivityLog.record_id.in_(lead_ids),
            )
            .order_by(
                ActivityLog.record_id,
                ActivityLog.created_at.desc(),
                ActivityLog.id.desc(),
            )
            .all()
        )
        for activity in activity_rows:
            latest_activity_by_lead.setdefault(int(activity.record_id), activity)

    assigned_user_ids = {int(lead.assigned_to) for lead in lead_rows if lead.assigned_to}
    assigned_users = {
        int(user.id): user
        for user in db.query(User).filter(User.id.in_(assigned_user_ids)).all()
    } if assigned_user_ids else {}

    competitor_ids_by_lead: dict[int, list] = {}
    if lead_ids:
        try:
            competitor_stmt = _text(
                "SELECT id, competitor_ids FROM leads WHERE id IN :lead_ids"
            ).bindparams(bindparam("lead_ids", expanding=True))
            for row in db.execute(competitor_stmt, {"lead_ids": lead_ids}).fetchall():
                raw = row[1]
                competitor_ids_by_lead[int(row[0])] = json.loads(raw) if raw else []
        except Exception:
            competitor_ids_by_lead = {}

    products_by_lead: dict[int, list[LeadProduct]] = {}
    product_rows = (
        db.query(LeadProduct)
        .filter(LeadProduct.lead_id.in_(lead_ids))
        .all()
    ) if lead_ids else []
    for product in product_rows:
        products_by_lead.setdefault(int(product.lead_id), []).append(product)

    product_ids = {int(p.id) for p in product_rows if p.id}
    product_master_ids = {int(p.product_id) for p in product_rows if p.product_id and not p.product_name}
    oems_by_product: dict[int, list[LeadProductOEM]] = {}
    oem_rows = (
        db.query(LeadProductOEM)
        .filter(LeadProductOEM.lead_product_id.in_(product_ids))
        .all()
    ) if product_ids else []
    for oem in oem_rows:
        oems_by_product.setdefault(int(oem.lead_product_id), []).append(oem)

    oem_master_ids = {int(o.oem_id) for o in oem_rows if o.oem_id and not o.oem_name}
    product_name_by_id = dict(
        db.query(ProductMaster.id, ProductMaster.name).filter(ProductMaster.id.in_(product_master_ids)).all()
    ) if product_master_ids else {}
    oem_name_by_id = dict(
        db.query(OEM.id, OEM.name).filter(OEM.id.in_(oem_master_ids)).all()
    ) if oem_master_ids else {}

    out = []
    for lead in lead_rows:
        d = {c.name: getattr(lead, c.name) for c in lead.__table__.columns}
        d["source_name"] = source_names.get(int(lead.source_id)) if lead.source_id else None
        latest_activity = latest_activity_by_lead.get(int(lead.id))
        d["last_activity"] = latest_activity.action if latest_activity else None
        d["last_activity_at"] = latest_activity.created_at if latest_activity else None
        if lead.status == 'Converted':
            d['lead_ref_id'] = None; d['lead_created_at'] = None
        d['competitor_ids'] = competitor_ids_by_lead.get(int(lead.id), [])
        u = assigned_users.get(int(lead.assigned_to)) if lead.assigned_to else None
        d['assigned_to_name'] = u.full_name if u else ''
        d['products'] = [
            _prod_dict_from_maps(p, oems_by_product, product_name_by_id, oem_name_by_id)
            for p in products_by_lead.get(int(lead.id), [])
        ]
        out.append(d)
    return out


def _prod_dict_from_maps(
    p,
    oems_by_product: dict[int, list[LeadProductOEM]],
    product_name_by_id: dict[int, str],
    oem_name_by_id: dict[int, str],
):
    d = {c.name: getattr(p, c.name) for c in p.__table__.columns}
    d['oems'] = [
        {c.name: getattr(o, c.name) for c in o.__table__.columns}
        for o in oems_by_product.get(int(p.id), [])
    ]

    if not d.get('product_name') and d.get('product_id'):
        d['product_name'] = product_name_by_id.get(int(d['product_id']), '') or ''

    for oem in d['oems']:
        if not oem.get('oem_name') and oem.get('oem_id'):
            oem['oem_name'] = oem_name_by_id.get(int(oem['oem_id']), '') or ''

    return d


def _prod_dict(
    db,
    p,
    *,
    oems_by_product: Optional[dict[int, list[LeadProductOEM]]] = None,
    product_name_map: Optional[dict[int, str]] = None,
    oem_name_map: Optional[dict[int, str]] = None,
):
    oems_by_product = oems_by_product or {}
    product_name_map = product_name_map or {}
    oem_name_map = oem_name_map or {}
    d = {c.name: getattr(p, c.name) for c in p.__table__.columns}
    oem_rows = oems_by_product.get(int(p.id))
    if oem_rows is None:
        oem_rows = db.query(LeadProductOEM).filter(
            LeadProductOEM.lead_product_id == p.id
        ).all()
    d['oems'] = [{c.name: getattr(o, c.name) for c in o.__table__.columns} for o in oem_rows]

    if not d.get('product_name') and d.get('product_id'):
        product_name = product_name_map.get(int(d['product_id']))
        if product_name is None:
            product_name = db.query(ProductMaster.name).filter(ProductMaster.id == d['product_id']).scalar()
        d['product_name'] = product_name or ''

    for oem in d['oems']:
        if not oem.get('oem_name') and oem.get('oem_id'):
            oem_name = oem_name_map.get(int(oem['oem_id']))
            if oem_name is None:
                oem_name = db.query(OEM.name).filter(OEM.id == oem['oem_id']).scalar()
            oem['oem_name'] = oem_name or ''

    return d


# ─── Get single ───────────────────────────────────────────────────────────────

@router.get("/{lead_id}")
def get_lead(
    lead_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    lead = db.query(Lead).filter(Lead.id == lead_id).first()
    if not lead:
        raise HTTPException(404, "Lead not found")
    _ensure_lead_access(db, cu, lead, "view")
    d = {c.name: getattr(lead, c.name) for c in lead.__table__.columns}
    try:
        row = db.execute(
            _text("SELECT competitor_ids FROM leads WHERE id = :lid"),
            {"lid": lead_id}
        ).fetchone()
        d['competitor_ids'] = json.loads(row[0]) if (row and row[0]) else []
    except Exception:
        d['competitor_ids'] = []
    products = db.query(LeadProduct).filter(LeadProduct.lead_id == lead_id).all()
    lead_product_ids = [int(product.id) for product in products if product.id]
    oems_by_product: dict[int, list[LeadProductOEM]] = defaultdict(list)
    if lead_product_ids:
        for oem in db.query(LeadProductOEM).filter(LeadProductOEM.lead_product_id.in_(lead_product_ids)).all():
            oems_by_product[int(oem.lead_product_id)].append(oem)
    product_ids = {
        int(product.product_id)
        for product in products
        if product.product_id and not (product.product_name or "").strip()
    }
    product_name_map = {
        int(product_id): name or ""
        for product_id, name in db.query(ProductMaster.id, ProductMaster.name).filter(
            ProductMaster.id.in_(product_ids)
        ).all()
    } if product_ids else {}
    oem_ids = {
        int(oem.oem_id)
        for oem_rows in oems_by_product.values()
        for oem in oem_rows
        if oem.oem_id and not (oem.oem_name or "").strip()
    }
    oem_name_map = {
        int(oem_id): name or ""
        for oem_id, name in db.query(OEM.id, OEM.name).filter(
            OEM.id.in_(oem_ids)
        ).all()
    } if oem_ids else {}
    d['products'] = [
        _prod_dict(
            db,
            product,
            oems_by_product=oems_by_product,
            product_name_map=product_name_map,
            oem_name_map=oem_name_map,
        )
        for product in products
    ]
    u = db.query(User).filter(User.id == lead.assigned_to).first() if lead.assigned_to else None
    d['assigned_to_name'] = u.full_name if u else ''
    d["source_name"] = db.query(LeadSource.name).filter(LeadSource.id == lead.source_id).scalar() if lead.source_id else None
    return d


# ─── Approval timeline (read-only) ─────────────────────────────────────────────
# Stitches together existing Lead / Tender / Approval rows into a single
# chronological view. Purely a read/aggregation endpoint — does not touch or
# alter any of the underlying workflow, status, or approval logic.

def _timeline_user_name(db: Session, user_id: Optional[int]) -> Optional[str]:
    if not user_id:
        return None
    u = db.query(User).filter(User.id == user_id).first()
    return u.full_name if u else None


def _tender_progress_at(tender: Tender):
    """Best real timestamp for 'tender processed to next step' — prefers specific
    workflow/business events over the blunt row-level updated_at."""
    if getattr(tender, 'step3_approved_at', None):
        return tender.step3_approved_at
    if getattr(tender, 'submission_date', None):
        return datetime.combine(tender.submission_date, datetime.min.time())
    if getattr(tender, 'step2_approved_at', None):
        return tender.step2_approved_at
    return tender.updated_at or tender.created_at


def _timeline_sort_key(event: dict):
    at = event.get("at")
    if at is None:
        return (1, datetime.max)
    if isinstance(at, datetime):
        return (0, at)
    return (0, datetime(at.year, at.month, at.day))


@router.get("/{lead_id}/timeline")
def get_lead_timeline(
    lead_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    lead = db.query(Lead).filter(Lead.id == lead_id).first()
    if not lead:
        raise HTTPException(404, "Lead not found")
    _ensure_lead_access(db, cu, lead, "view")

    def approval_event(key: str, title: str, approval_id: Optional[int], extra_reason: Optional[str] = None):
        if not approval_id:
            return None
        appr = db.query(Approval).filter(Approval.id == approval_id).first()
        if not appr:
            return None
        status = {"pending": "pending", "approved": "done", "rejected": "rejected"}.get(appr.status, "pending")
        return {
            "key": key,
            "event_type": "APPROVAL",
            "title": title,
            "status": status,
            "at": appr.decided_at or appr.created_at,
            "actor_name": _timeline_user_name(db, appr.requested_by),
            "approver_name": _timeline_user_name(db, appr.requested_to),
            "notes": appr.decision_notes or appr.request_notes,
            "reason": appr.rejection_reason or extra_reason,
        }

    events: list[dict] = []

    events.append({
        "key": "lead_posted",
        "event_type": "LEAD_POSTED",
        "title": "Lead Posted",
        "status": "done",
        "at": lead.created_at,
        "actor_name": _timeline_user_name(db, lead.created_by),
        "approver_name": None,
        "notes": lead.lead_title,
        "reason": None,
    })

    if lead.opportunity_created_at:
        events.append({
            "key": "opportunity_created",
            "event_type": "OPPORTUNITY_CREATED",
            "title": "Opportunity Created",
            "status": "done",
            "at": lead.opportunity_created_at,
            "actor_name": None, "approver_name": None, "notes": None, "reason": None,
        })

    conv_event = approval_event("lead_conversion_approval", "Lead Conversion Approval", lead.approval_id, lead.rejection_reason)
    if conv_event:
        events.append(conv_event)

    if lead.converted_at:
        events.append({
            "key": "lead_converted",
            "event_type": "LEAD_CONVERTED",
            "title": "Lead Converted",
            "status": "done",
            "at": lead.converted_at,
            "actor_name": None, "approver_name": None,
            "notes": f"Converted to {lead.conversion_target}" if lead.conversion_target else None,
            "reason": None,
        })

    if lead.lost_at:
        events.append({
            "key": "lead_lost",
            "event_type": "LEAD_LOST",
            "title": "Lead Lost",
            "status": "rejected",
            "at": lead.lost_at,
            "actor_name": None, "approver_name": None, "notes": None,
            "reason": lead.rejection_reason,
        })

    tender = None
    if lead.converted_tender_id:
        tender = db.query(Tender).filter(Tender.id == lead.converted_tender_id).first()
    if not tender:
        tender = db.query(Tender).filter(Tender.lead_id == lead_id).order_by(Tender.id.asc()).first()

    if tender:
        events.append({
            "key": "tender_posted",
            "event_type": "TENDER_POSTED",
            "title": "Tender Posted",
            "status": "done",
            "at": tender.created_at or tender.updated_at,
            "actor_name": _timeline_user_name(db, tender.created_by),
            "approver_name": None,
            "notes": tender.tender_title,
            "reason": None,
        })

        step2_event = approval_event("tender_step2_approval", "Tender Step 2 Approval — Alignment", tender.step2_approval_id)
        if step2_event:
            events.append(step2_event)

        step3_event = approval_event("tender_step3_approval", "Tender Step 3 Approval — Submission", tender.step3_approval_id)
        if step3_event:
            events.append(step3_event)

        if (tender.current_step or 1) > 1 or (tender.workflow_status or 'draft') != 'draft':
            events.append({
                "key": "tender_processing",
                "event_type": "TENDER_STATUS",
                "title": f"Tender processed to: {tender.tender_status}" if tender.tender_status else "Tender moved to next step",
                "status": "done",
                "at": _tender_progress_at(tender),
                "actor_name": None, "approver_name": None,
                "notes": f"Step {tender.current_step} — {tender.workflow_status}" if tender.current_step else None,
                "reason": None,
            })

        if tender.result and tender.result != "Pending":
            events.append({
                "key": "tender_result",
                "event_type": "TENDER_RESULT",
                "title": f"Tender {tender.result}",
                "status": "done" if tender.result == "Won" else "rejected",
                "at": tender.result_date,
                "actor_name": None, "approver_name": None, "notes": None, "reason": None,
            })

    events.sort(key=_timeline_sort_key)
    return events


# ─── Create ───────────────────────────────────────────────────────────────────

@router.post("", status_code=201)
def create_lead(
    data: LeadCreate,
    request: Request,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    is_opportunity = (
        (data.lead_type or "lead") == "direct_opportunity"
        or data.status in _OPPORTUNITY_STATUSES
    )
    ensure_permission(db, cu, "opportunities.create" if is_opportunity else "leads.create")
    try:
        if data.status == 'New':
            raise HTTPException(400, "Status 'New' is not allowed. Use 'Assigned' instead.")
        if data.status == 'Converted':
            raise HTTPException(400, "Cannot create a lead with status 'Converted'.")
        if data.conversion_target and data.conversion_target not in ('tender', 'quotation'):
            raise HTTPException(400, "conversion_target must be 'tender' or 'quotation'.")

        contact_person = data.contact_person; designation = data.designation
        mobile = data.mobile; email = data.email; department = data.department
        customer_name = data.customer_name; customer_addr = data.customer_address

        if data.customer_id:
            cust = db.query(Customer).filter(Customer.id == data.customer_id).first()
            if cust:
                customer_name = cust.customer_name
                if not customer_addr:
                    parts = [p for p in [cust.billing_city, cust.billing_state] if p]
                    customer_addr = ", ".join(parts)
                active = (
                    db.query(CustomerContact).filter(
                        CustomerContact.customer_id == data.customer_id,
                        CustomerContact.is_active == True, CustomerContact.is_primary == True,
                    ).first()
                    or db.query(CustomerContact).filter(
                        CustomerContact.customer_id == data.customer_id,
                        CustomerContact.is_active == True,
                    ).first()
                )
                if active:
                    contact_person = contact_person or active.contact_name
                    designation    = designation    or active.designation
                    mobile         = mobile         or active.mobile
                    email          = email          or active.office_email
                    department     = department     or active.department

        assigned_to = data.assigned_to or cu.id
        # if cu.role not in PRIVILEGED_ROLES and cu.role not in ('manager', 'vp'):
        #     assigned_to = cu.id

        now = now_ist()
        opp_ref = None; opp_at = None; lost_at = None

        if data.status == 'Opportunity Created':
            opp_ref = _next_opportunity_ref_id(db); opp_at = now
        elif data.status == 'Lost':
            lost_at = now

        timeline_value = _optional_iso_date(data.timeline, "Timeline")
        follow_up_value = _optional_iso_date(data.follow_up, "Follow-up date", as_date=True)

        lead = Lead(
            lead_ref_id            = _next_lead_ref_id(db),
            opportunity_ref_id     = opp_ref,
            lead_title             = data.lead_title,
            customer_id            = data.customer_id,
            customer_name          = customer_name,
            customer_address       = data.customer_address,
            department             = data.department,
            contact_person         = data.contact_person,
            designation            = data.designation,
            mobile                 = data.mobile,
            email                  = data.email,
            source_id              = data.source_id,
            business_vertical_id   = data.business_vertical_id,
            priority               = data.priority,
            status                 = data.status,
            est_value              = data.est_value,
            tender_id_ref          = data.tender_id_ref,
            timeline               = timeline_value,
            follow_up              = follow_up_value,
            product_description    = data.product_description,
            notes                  = data.notes,
            assigned_to            = assigned_to,
            region                 = data.region,
            branch                 = data.branch,
            created_by             = cu.id,
            lead_created_at        = now,
            approval_status        = None,
            opportunity_created_at = opp_at,
            lost_at                = lost_at,
            lead_type              = data.lead_type or 'lead',
            conversion_target      = (
                data.conversion_target
                or ('quotation' if (data.lead_type or 'lead') == 'direct_opportunity' else None)
            ),
        )
        db.add(lead); db.flush()

        if data.competitor_ids is not None:
            db.execute(
                _text("UPDATE leads SET competitor_ids = :val WHERE id = :lid"),
                {"val": json.dumps(data.competitor_ids), "lid": lead.id}
            )

        if data.products:
            _save_products(db, lead.id, data.products)

        if lead.follow_up and assigned_to:
            try:
                _act_user = db.query(User).filter(User.id == assigned_to).first()
                _vcols = {c.name for c in KAMActivity.__table__.columns}
                db.add(KAMActivity(**{k: v for k, v in dict(
                    user_id=assigned_to,
                    user_role=_act_user.role if _act_user else None,
                    customer_id=lead.customer_id,
                    lead_id=lead.id,
                    activity_type="Follow Up",
                    mode="Phone Call",
                    subject=f"Follow up: {lead.lead_title}",
                    activity_date=lead.follow_up,
                    status="Planned",
                    description=f"Auto-created on lead entry. Lead ref: {lead.lead_ref_id}",
                    created_by=cu.id,
                ).items() if k in _vcols}))

                # Notify the assigned user and their reporting manager
                _date_str = lead.follow_up.strftime('%d %b %Y') if hasattr(lead.follow_up, 'strftime') else str(lead.follow_up)
                _notif_title = "Follow-up Activity Scheduled"
                _notif_msg = (
                    f"A follow-up activity has been scheduled on {_date_str} "
                    f"for {'lead' if lead.lead_type != 'direct_opportunity' else 'opportunity'} "
                    f"'{lead.lead_title}'."
                )
                _notify_uids: list[int] = [assigned_to]
                _hier = db.query(UserReportingHierarchy).filter(
                    UserReportingHierarchy.reporting_user_id == assigned_to,
                    UserReportingHierarchy.is_active == True,
                ).first()
                if _hier and _hier.parent_user_id:
                    _notify_uids.append(_hier.parent_user_id)
                for _uid in set(_notify_uids):
                    db.add(Notification(
                        user_id=_uid,
                        title=_notif_title,
                        message=_notif_msg,
                        module="leads",
                        record_id=lead.id,
                        action="follow_up_activity",
                    ))
            except Exception as _e:
                logger.warning(f"create_lead: KAM activity auto-creation failed: {_e}")

        assignee_name = _lead_assignee_name(db, lead)
        _dispatch_lead_event(
            db,
            lead=lead,
            event_key="new_lead",
            title="New Lead Created",
            message=(
                f"Lead '{lead.lead_title}' was created by {cu.full_name}"
                + (f" and assigned to {assignee_name}." if getattr(lead, "assigned_to", None) else ".")
            ),
            actor_user_id=cu.id,
        )

        if getattr(lead, "assigned_to", None):
            _dispatch_lead_event(
                db,
                lead=lead,
                event_key="lead_assignment",
                title="Lead Assigned",
                message=f"Lead '{lead.lead_title}' was assigned to {assignee_name} by {cu.full_name}.",
                actor_user_id=cu.id,
            )

        if lead.status == "Opportunity Created":
            _dispatch_lead_event(
                db,
                lead=lead,
                event_key="status_qualified",
                title="Lead Qualified",
                message=f"Lead '{lead.lead_title}' moved to Opportunity Created by {cu.full_name}.",
                actor_user_id=cu.id,
            )

        if lead.status == "Lost":
            _dispatch_lead_event(
                db,
                lead=lead,
                event_key="status_lost",
                title="Lead Lost",
                message=f"Lead '{lead.lead_title}' was marked Lost by {cu.full_name}.",
                actor_user_id=cu.id,
            )

        if is_high_priority_lead(lead):
            _dispatch_lead_event(
                db,
                lead=lead,
                event_key="high_priority_lead",
                title="High Priority Lead",
                message=f"Lead '{lead.lead_title}' is marked High priority.",
                actor_user_id=cu.id,
            )

        log_module_action(db=db, user_id=cu.id, module="leads", action="create",
                          record_id=lead.id, record_name=data.lead_title,
                          ip=get_request_ip(request),
                          new_data=data.model_dump(exclude={"products"}))
        db.commit(); db.refresh(lead)
        from app.services.platform_webhooks import emit_safe   # outgoing webhooks (API & webhooks); never raises
        emit_safe(getattr(request.state, "tenant_slug", None), "lead.created",
                  {"id": lead.id, "lead_title": lead.lead_title, "status": lead.status, "created_at": lead.created_at})
        return lead

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"create_lead: {e}")
        try:
            log_error_db(db, cu.id, "leads", e, request_data=data.model_dump(exclude={"products"}))
        except Exception:
            pass
        db.rollback()
        raise HTTPException(500, "Failed to create lead. Please check the entered values and try again.")


# ─── Update (Step 1 fields + status) ─────────────────────────────────────────

@router.put("/{lead_id}")
def update_lead(
    lead_id: int,
    data: LeadUpdate,
    request: Request,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    lead = db.query(Lead).filter(Lead.id == lead_id).first()
    if not lead:
        raise HTTPException(404, "Lead not found")
    _ensure_lead_access(db, cu, lead, "update")

    if lead.status == 'Converted' and getattr(lead, 'conversion_target', None) not in ('quotation', 'tender'):
        raise HTTPException(400, "Converted leads cannot be edited.")
    if (lead.status == 'Opportunity Created'
            and getattr(lead, 'lead_type', 'lead') != 'direct_opportunity'
            and cu.role not in MANAGER_ROLES):
        raise HTTPException(
            403,
            "Only managers and above can edit lead info once it is in 'Opportunity Created'. "
            "Use the products endpoint to update products."
        )

    old_assigned_to = lead.assigned_to
    old_priority = lead.priority
    old_status = lead.status
    new_status = data.status if data.status is not None else old_status
    now        = now_ist()

    if new_status != old_status:
        _assert_transition(old_status, new_status)
        if new_status == 'Converted':
            raise HTTPException(400, "Cannot set 'Converted' directly. Use 'Request Conversion' instead.")
    if lead.approval_status == 'pending' and new_status != old_status:
        raise HTTPException(400, "Approval is pending. Cannot change status until the manager decides.")
    if data.conversion_target and data.conversion_target not in ('tender', 'quotation'):
        raise HTTPException(400, "conversion_target must be 'tender' or 'quotation'.")

    updates = data.model_dump(exclude_unset=True, exclude={"products", "status", "competitor_ids"})
    if "timeline" in updates:
        updates["timeline"] = _optional_iso_date(updates.get("timeline"), "Timeline")
    if "follow_up" in updates:
        updates["follow_up"] = _optional_iso_date(updates.get("follow_up"), "Follow-up date", as_date=True)
    for field, val in updates.items():
        if hasattr(lead, field):
            setattr(lead, field, val)
    lead.status = new_status

    if old_status != 'Opportunity Created' and new_status == 'Opportunity Created':
        if not lead.opportunity_ref_id:
            lead.opportunity_ref_id     = _next_opportunity_ref_id(db)
            lead.opportunity_created_at = now
        if lead.approval_status == 'rejected':
            lead.approval_status = None

    if old_status != 'Lost' and new_status == 'Lost':
        lead.lost_at = now

    db.flush()

    if 'competitor_ids' in data.model_dump(exclude_unset=True):
        raw_ids = data.competitor_ids
        serialized = json.dumps(raw_ids) if isinstance(raw_ids, list) else (None if raw_ids is None else str(raw_ids))
        db.execute(
            _text("UPDATE leads SET competitor_ids = :val WHERE id = :lid"),
            {"val": serialized, "lid": lead_id}
        )

    if data.products is not None and len(data.products) > 0:
        _delete_products(db, lead_id)
        _save_products(db, lead_id, data.products)
    elif old_status == 'Opportunity Created' and new_status != 'Opportunity Created':
        _delete_products(db, lead_id)

    assignee_name = _lead_assignee_name(db, lead)
    if old_assigned_to != lead.assigned_to and getattr(lead, "assigned_to", None):
        _dispatch_lead_event(
            db,
            lead=lead,
            event_key="lead_assignment",
            title="Lead Assigned",
            message=f"Lead '{lead.lead_title}' was assigned to {assignee_name} by {cu.full_name}.",
            actor_user_id=cu.id,
        )

    if old_status != "Opportunity Created" and new_status == "Opportunity Created":
        _dispatch_lead_event(
            db,
            lead=lead,
            event_key="status_qualified",
            title="Lead Qualified",
            message=f"Lead '{lead.lead_title}' moved to Opportunity Created by {cu.full_name}.",
            actor_user_id=cu.id,
        )

    if old_status != "Lost" and new_status == "Lost":
        _dispatch_lead_event(
            db,
            lead=lead,
            event_key="status_lost",
            title="Lead Lost",
            message=f"Lead '{lead.lead_title}' was marked Lost by {cu.full_name}.",
            actor_user_id=cu.id,
        )

    if not _is_high_priority_value(old_priority) and is_high_priority_lead(lead):
        _dispatch_lead_event(
            db,
            lead=lead,
            event_key="high_priority_lead",
            title="High Priority Lead",
            message=f"Lead '{lead.lead_title}' is marked High priority.",
            actor_user_id=cu.id,
        )

    log_module_action(
        db=db, user_id=cu.id, module="leads", action="update",
        record_id=lead.id, record_name=lead.lead_title,
        ip=get_request_ip(request),
        new_data={**data.model_dump(exclude_unset=True, exclude={"products"}), "_old": old_status},
    )
    if lead.assigned_to != old_assigned_to:
        log_module_action(
            db=db, user_id=cu.id, module="leads",
            action="reassign" if old_assigned_to else "assign",
            record_id=lead.id, record_name=lead.lead_title, ip=get_request_ip(request),
            old_data={"assigned_to": old_assigned_to}, new_data={"assigned_to": lead.assigned_to},
        )
    if lead.status != old_status:
        log_module_action(
            db=db, user_id=cu.id, module="leads", action="status_change",
            record_id=lead.id, record_name=lead.lead_title, ip=get_request_ip(request),
            old_data={"status": old_status}, new_data={"status": lead.status},
        )
    db.commit(); db.refresh(lead)
    return lead


# ─── Update products only (Step 2) ───────────────────────────────────────────

@router.put("/{lead_id}/products")
def update_lead_products(
    lead_id: int,
    data: ProductsUpdate,
    request: Request,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    lead = db.query(Lead).filter(Lead.id == lead_id).first()
    if not lead:
        raise HTTPException(404, "Lead not found")
    _ensure_lead_access(db, cu, lead, "update")
    if lead.status == 'Converted' and getattr(lead, 'conversion_target', None) not in ('quotation', 'tender'):
        raise HTTPException(400, "Converted leads cannot be edited.")
    if lead.status != 'Opportunity Created' and not (
        lead.status == 'Converted' and getattr(lead, 'conversion_target', None) in ('quotation', 'tender')
    ):
        raise HTTPException(400, "Products can only be updated for 'Opportunity Created' leads.")
    if lead.approval_status == 'pending':
        raise HTTPException(400, "Cannot update products while approval is pending.")

    _delete_products(db, lead_id)
    if data.products:
        _save_products(db, lead_id, data.products)

    log_module_action(
        db=db, user_id=cu.id, module="leads", action="update_products",
        record_id=lead.id, record_name=lead.lead_title,
        ip=get_request_ip(request), new_data={"product_count": len(data.products)},
    )
    db.commit(); db.refresh(lead)
    return lead


# ─── Kanban status patch ──────────────────────────────────────────────────────

@router.delete("/{lead_id}")
def delete_lead(
    lead_id: int,
    request: Request,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    lead = db.query(Lead).filter(Lead.id == lead_id, Lead.is_deleted == False).first()
    if not lead:
        raise HTTPException(404, "Lead not found")
    # Permission + data-visibility scope decide (no role-name shortcut).
    _ensure_lead_access(db, cu, lead, "delete")

    before = model_snapshot(lead)
    lead.is_deleted = True
    log_module_action(
        db=db, user_id=cu.id, module="leads", action="delete",
        record_id=lead.id, record_name=lead.lead_title,
        ip=get_request_ip(request), old_data=before,
    )
    db.commit()
    return {"message": "Lead deleted"}


@router.patch("/{lead_id}/status")
def update_lead_status(
    lead_id: int,
    payload: dict,
    request: Request,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    """
    Simple column moves: Assigned / Qualified /
    Opportunity Created / Lost.

    'Pending Approval' drag  → handled by POST /request-conversion
    'Converted' drag         → handled by POST /request-conversion
    'Rejected' drag          → handled by POST /approve-conversion
    """
    lead = db.query(Lead).filter(Lead.id == lead_id, Lead.is_deleted == False).first()
    if not lead:
        raise HTTPException(404, "Lead not found")
    _ensure_lead_access(db, cu, lead, "update")

    new_col = payload.get("status")

    # These three must go through dedicated endpoints
    DEDICATED = {'Converted', 'Rejected Opportunity', 'Pending Approval'}
    if new_col in DEDICATED:
        raise HTTPException(
            400,
            f"'{new_col}' requires a dedicated endpoint. "
            "Use POST /request-conversion or POST /approve-conversion.",
        )

    SIMPLE_COLS = {*_OPEN_LEAD, 'Opportunity Created', 'Lost'}
    if new_col not in SIMPLE_COLS:
        raise HTTPException(400, f"Invalid status: {new_col}")

    if lead.status == 'Converted':
        raise HTTPException(400, "Converted leads cannot be moved.")

    if lead.status == 'Opportunity Created' and new_col != 'Opportunity Created':
        if cu.role not in MANAGER_ROLES:
            raise HTTPException(
                403, "Only managers and above can move a lead out of Opportunity Created."
            )

    now        = now_ist()
    old_status = lead.status

    if new_col == 'Opportunity Created' and lead.status != 'Opportunity Created':
        if not lead.opportunity_ref_id:
            lead.opportunity_ref_id     = _next_opportunity_ref_id(db)
            lead.opportunity_created_at = now
        lead.approval_status = None   # clear any old rejection

    if new_col == 'Lost' and lead.status != 'Lost':
        lead.lost_at = now

    lead.status = new_col

    try:
        db.add(ActivityLog(
            user_id     = cu.id,
            module      = 'leads',
            record_id   = lead.id,
            action      = 'status_changed',
            description = f"Lead moved from '{old_status}' to '{new_col}' via kanban",
            icon        = '🔄',
            color       = '#EFF6FF',
        ))
    except Exception:
        pass   # ActivityLog is non-critical

    log_module_action(
        db=db, user_id=cu.id, module="leads", action="status_change",
        record_id=lead.id, record_name=lead.lead_title,
        ip=get_request_ip(request),
        new_data={"old_status": old_status, "new_status": new_col, "via": "kanban"},
    )

    if old_status != "Opportunity Created" and new_col == "Opportunity Created":
        _dispatch_lead_event(
            db,
            lead=lead,
            event_key="status_qualified",
            title="Lead Qualified",
            message=f"Lead '{lead.lead_title}' moved to Opportunity Created by {cu.full_name}.",
            actor_user_id=cu.id,
        )

    if old_status != "Lost" and new_col == "Lost":
        _dispatch_lead_event(
            db,
            lead=lead,
            event_key="status_lost",
            title="Lead Lost",
            message=f"Lead '{lead.lead_title}' was marked Lost by {cu.full_name}.",
            actor_user_id=cu.id,
        )

    db.commit(); db.refresh(lead)
    return {"id": lead.id, "status": lead.status, "approval_status": lead.approval_status}


# ─── Qualification gate patch (kanban modal) ──────────────────────────────────

@router.patch("/{lead_id}/qualify")
def qualify_lead(
    lead_id: int,
    data: LeadQualifyPatch,
    request: Request,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    """
    PATCH /leads/{lead_id}/qualify

    Called by the Kanban qualification-gate modal when a lead is dragged
    out of 'Assigned' and competitor_ids / notes / product_description
    were missing.

    Only updates those three fields — does NOT change status, products,
    approval_status, or any other field.

    Rules:
      - Lead must exist and not be deleted.
      - Lead must NOT be 'Converted' (sealed).
      - Only the three fields present in the payload are written.
        Fields absent from the payload (None) are left as-is.
    """
    lead = db.query(Lead).filter(
        Lead.id == lead_id,
        Lead.is_deleted == False,
    ).first()

    if not lead:
        raise HTTPException(404, "Lead not found")
    _ensure_lead_access(db, cu, lead, "update")

    if lead.status == "Converted":
        raise HTTPException(400, "Converted leads cannot be modified.")

    changed: dict = {}

    # ── notes ──────────────────────────────────────────────────────────────
    if data.notes is not None:
        new_notes = data.notes.strip() or None
        if lead.notes != new_notes:
            lead.notes = new_notes
            changed["notes"] = new_notes

    # ── product_description ────────────────────────────────────────────────
    if data.product_description is not None:
        new_desc = data.product_description.strip() or None
        if lead.product_description != new_desc:
            lead.product_description = new_desc
            changed["product_description"] = new_desc

    # ── competitor_ids (JSON column on Lead row) ───────────────────────────
    if data.competitor_ids is not None:
        serialized = json.dumps(data.competitor_ids)
        db.execute(
            _text("UPDATE leads SET competitor_ids = :val WHERE id = :lid"),
            {"val": serialized, "lid": lead_id},
        )
        changed["competitor_ids"] = data.competitor_ids

    if changed:
        lead.updated_at = now_ist()

        # Log the qualification action
        log_module_action(
            db=db, user_id=cu.id, module="leads", action="qualify",
            record_id=lead.id, record_name=lead.lead_title,
            ip=get_request_ip(request),
            new_data={"qualified_fields": list(changed.keys()), "via": "kanban_gate"},
        )

    db.commit()
    db.refresh(lead)

    # Return current values of the three fields so the frontend can confirm
    try:
        row = db.execute(
            _text("SELECT competitor_ids FROM leads WHERE id = :lid"),
            {"lid": lead_id}
        ).fetchone()
        competitor_ids = json.loads(row[0]) if (row and row[0]) else []
    except Exception:
        competitor_ids = data.competitor_ids or []

    return {
        "id":                  lead.id,
        "status":              lead.status,
        "notes":               lead.notes,
        "product_description": lead.product_description,
        "competitor_ids":      competitor_ids,
        "fields_updated":      list(changed.keys()),
    }


# ─── Request conversion (list action + Pending Approval kanban drop) ──────────

@router.post("/{lead_id}/request-conversion")
def request_lead_conversion(
    lead_id: int,
    request: Request,
    data: Optional[ConversionRequestBody] = None,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    """
    The only path to a Tender OR a Quotation.
    Called from:
    1. List page "Request Conversion" action button
    2. Kanban drag-drop → 'Pending Approval' column  (any role)
    3. Kanban drag-drop → 'Converted' column         (admin/ceo → direct)

    `data.conversion_target` selects the outcome:
    - 'tender'    (default — preserves prior behaviour): auto-create a Tender.
    - 'quotation': mark the lead Converted with no Tender; a Quotation can then
      be created directly against this lead's id (same as a Direct Opportunity).

    Admin/CEO: applies the chosen outcome immediately (direct=True).
    Others:    creates ApprovalRequest, sets approval_status='pending' and
               stores the chosen target for the approver to action later.
    """
    target = (data.conversion_target if data else None) or 'tender'
    if target not in ('tender', 'quotation'):
        raise HTTPException(400, "conversion_target must be 'tender' or 'quotation'.")

    lead = db.query(Lead).filter(Lead.id == lead_id).first()
    if not lead:
        raise HTTPException(404, "Lead not found")
    if lead.status != 'Opportunity Created':
        raise HTTPException(400, "Lead must be in 'Opportunity Created' to request conversion.")
    if lead.status == 'Converted':
        raise HTTPException(400, "Lead is already converted.")
    if lead.approval_status == 'pending':
        raise HTTPException(400, "A conversion approval is already pending.")

    # ── Admin / CEO: direct conversion ────────────────────────────────────
    approval_request = create_generic_approval_request(
        db=db,
        tenant_id=getattr(getattr(request.state, "tenant", None), "id", None),
        requester=cu,
        module_key="lead",
        action_key="convert",
        record_id=lead.id,
    )

    if (approval_request.status or "").strip().lower() == "approved":
        now = now_ist()

        if target == 'quotation':
            lead.status            = 'Converted'
            lead.approval_status   = 'approved'
            lead.converted_at      = now
            lead.conversion_target = 'quotation'

            _dispatch_lead_event(
                db,
                lead=lead,
                event_key="status_won",
                title="Lead Won",
                message=f"Lead '{lead.lead_title}' was converted directly to Quotation by {cu.full_name}.",
                actor_user_id=cu.id,
            )

            log_module_action(db=db, user_id=cu.id, module="leads", action="convert",
                              record_id=lead.id, record_name=lead.lead_title,
                              ip=get_request_ip(request),
                              new_data={"conversion_target": "quotation", "by": "hierarchy_auto_approve"})
            db.commit()
            return {"message": "Lead converted. Ready to create a Quotation.",
                    "tender_num": None, "tender_id": None,
                    "approver_name": cu.full_name, "approval_id": None, "direct": True,
                    "conversion_target": "quotation"}

        tender_num = _next_tender_ref_id(db)
        tender     = _create_tender_from_lead(db, lead, tender_num, cu)

        lead.status              = 'Converted'
        lead.approval_status     = 'approved'
        lead.converted_at        = now
        lead.converted_tender_id = tender.id
        lead.conversion_target   = 'tender'

        _dispatch_lead_event(
            db,
            lead=lead,
            event_key="status_won",
            title="Lead Won",
            message=f"Lead '{lead.lead_title}' was converted to Tender {tender_num} by {cu.full_name}.",
            actor_user_id=cu.id,
        )

        log_module_action(db=db, user_id=cu.id, module="leads", action="convert",
                          record_id=lead.id, record_name=lead.lead_title,
                          ip=get_request_ip(request),
                          new_data={"tender_num": tender_num, "by": "hierarchy_auto_approve"})
        db.commit()
        return {"message": f"Lead converted. Tender {tender_num} created.",
                "tender_num": tender_num, "tender_id": tender.id,
                "approver_name": cu.full_name, "approval_id": None, "direct": True,
                "conversion_target": "tender"}

    lead.approval_status   = 'pending'
    lead.approval_id       = None
    lead.conversion_target = target

    active_step = next(
        (
            step
            for step in sorted(approval_request.steps or [], key=lambda item: item.step_no)
            if step.step_no == approval_request.current_step_no
        ),
        None,
    )
    approver = active_step.approver if active_step else None

    log_module_action(db=db, user_id=cu.id, module="leads", action="status_change",
                      record_id=lead.id, record_name=lead.lead_title,
                      ip=get_request_ip(request),
                      new_data={"approval_status": "pending", "approval_request_id": approval_request.id})
    db.commit()

    return {"message": "Conversion request sent for approval.",
            "approver_name": approver.full_name if approver else "",
            "approval_id": approval_request.id, "direct": False}



# ─── Approve / reject conversion ─────────────────────────────────────────────

@router.post("/{lead_id}/approve-conversion")
def approve_lead_conversion(
    lead_id: int,
    data: Decision,
    request: Request,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    """
    Approve or reject a lead conversion.

    Called from:
    1. Approvals page (normal flow — lead.approval_id is set)
    2. Kanban drag-drop → 'Rejected Opportunity' column (manager; no prior approval_id needed)

    Direct rejection without a prior request is allowed for managers.
    Direct approval without a request is only allowed via request-conversion (admin/ceo path).
    """
    lead = db.query(Lead).filter(Lead.id == lead_id).first()
    if not lead:
        raise HTTPException(404, "Lead not found")

    if cu.role not in MANAGER_ROLES:
        raise HTTPException(403, "Only managers and above can approve or reject conversions.")

    if lead.status not in ('Opportunity Created', 'Converted'):
        raise HTTPException(
            400,
            f"Lead must be in 'Opportunity Created' to action a conversion decision. "
            f"Current status: '{lead.status}'."
        )

    now      = now_ist()
    assignee = db.query(User).filter(User.id == lead.assigned_to).first() if lead.assigned_to else None

    # ── Case 1: normal approval flow (approval_id exists) ─────────────────
    if lead.approval_id:
        result = process_approval_decision(
            db=db, approval_id=lead.approval_id, approver=cu,
            decision=data.decision, decision_notes=data.notes or "",
            rejection_reason=data.rejection_reason or "",
        )
        if not result:
            raise HTTPException(403, "You are not authorised to action this approval.")
        # Purge stale notifications
        if lead.assigned_to:
            from sqlalchemy import or_
            db.query(Notification).filter(
                and_(
                    Notification.user_id   == lead.assigned_to,
                    Notification.record_id == lead.id,
                    or_(Notification.module == "lead", Notification.module == "leads"),
                    Notification.action.in_([
                        "approved", "rejected", "convert",
                        "conversion_approved", "conversion_rejected",
                    ]),
                )
            ).delete(synchronize_session="fetch")

    # ── Case 2: direct manager rejection from kanban (no approval_id) ─────
    else:
        if data.decision == 'approved':
            raise HTTPException(
                400,
                "Direct approval without a prior conversion request is not allowed. "
                "Use 'Request Conversion' first, or drag to Converted as admin/CEO."
            )
        logger.info(
            f"Direct rejection by {cu.full_name} (role={cu.role}) "
            f"for lead {lead_id} — no prior approval_id"
        )

    # ── Handle decision ───────────────────────────────────────────────────

    if data.decision == 'approved':
        target = lead.conversion_target or 'tender'

        if target == 'quotation':
            lead.status            = 'Converted'
            lead.approval_status   = 'approved'
            lead.converted_at      = now
            lead.conversion_target = 'quotation'

            _dispatch_lead_event(
                db,
                lead=lead,
                event_key="status_won",
                title="Lead Won",
                message=f"Lead '{lead.lead_title}' was converted directly to Quotation by {cu.full_name}.",
                actor_user_id=cu.id,
            )

            log_module_action(db=db, user_id=cu.id, module="leads", action="convert",
                              record_id=lead.id, record_name=lead.lead_title,
                              ip=get_request_ip(request),
                              new_data={"conversion_target": "quotation", "status": "Converted"})
            db.commit()

            return {"message": "Approved. Ready to create a Quotation.",
                    "status": lead.status, "tender_id": None, "tender_num": None,
                    "conversion_target": "quotation"}

        tender_num = _next_tender_ref_id(db)
        tender     = _create_tender_from_lead(db, lead, tender_num, cu)

        lead.status              = 'Converted'
        lead.approval_status     = 'approved'
        lead.converted_at        = now
        lead.converted_tender_id = tender.id
        lead.conversion_target   = 'tender'

        _dispatch_lead_event(
            db,
            lead=lead,
            event_key="status_won",
            title="Lead Won",
            message=f"Lead '{lead.lead_title}' was converted to Tender {tender_num} by {cu.full_name}.",
            actor_user_id=cu.id,
        )

        log_module_action(db=db, user_id=cu.id, module="leads", action="convert",
                          record_id=lead.id, record_name=lead.lead_title,
                          ip=get_request_ip(request),
                          new_data={"tender_num": tender_num, "status": "Converted"})
        db.commit()

        return {"message": "Approved. Tender created.",
                "status": lead.status, "tender_id": tender.id, "tender_num": tender_num,
                "conversion_target": "tender"}

    else:  # rejected
        lead.approval_status  = 'rejected'
        lead.rejection_reason = data.rejection_reason

        if assignee:
            reason_part = f" Reason: {data.rejection_reason}" if data.rejection_reason else ""
            _notify(db=db, user_id=assignee.id,
                    title="Lead Conversion Rejected ✗",
                    message=(f"Your lead '{lead.lead_title}' was rejected by "
                             f"{cu.full_name}.{reason_part}"),
                    module="leads", record_id=lead.id, action="conversion_rejected")

        log_module_action(db=db, user_id=cu.id, module="leads", action="status_change",
                          record_id=lead.id, record_name=lead.lead_title,
                          ip=get_request_ip(request),
                          new_data={
                              "approval_status": "rejected",
                              "reason": data.rejection_reason,
                              "via": "direct" if not lead.approval_id else "approval_flow",
                          })
        db.commit()

        return {"message": "Rejected. Sales may re-request after updates.",
                "status": lead.status, "tender_id": None}


# ─── Re-request after rejection ───────────────────────────────────────────────

@router.post("/{lead_id}/re-request-conversion")
def re_request_lead_conversion(
    lead_id: int,
    request: Request,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    lead = db.query(Lead).filter(Lead.id == lead_id).first()
    if not lead:
        raise HTTPException(404, "Lead not found")
    if lead.status != 'Opportunity Created':
        raise HTTPException(400, "Lead must be in 'Opportunity Created' to re-request.")
    if lead.approval_status not in ('rejected', 'none'):
        raise HTTPException(400, f"Cannot re-request when approval_status='{lead.approval_status}'.")

    lead.approval_status = 'none'
    try:
        db.query(Notification).filter(
            Notification.record_id == lead_id,
            Notification.module    == 'lead',
            Notification.action    == 'approval_request',
        ).delete(synchronize_session='fetch')
        db.flush()
    except Exception as e:
        logger.warning(f"re_request: failed to clear stale notif: {e}")
        db.rollback()

    return request_lead_conversion(
        lead_id=lead_id,
        request=request,
        data=ConversionRequestBody(conversion_target=lead.conversion_target or "tender"),
        db=db,
        cu=cu,
    )


# ─── Tender creation ──────────────────────────────────────────────────────────

def _create_tender_from_lead(db: Session, lead: Lead, tender_num: str, cu: User) -> Tender:
    from app.models.all_models import TenderProduct, TenderProductOEM

    tender = Tender(
        tender_num        = tender_num,    # sequential TND-YYYYMM-NNNNNN
        customer_id       = lead.customer_id,
        customer_name     = lead.customer_name,
        tender_title      = lead.lead_title,
        est_value         = lead.est_value,
        source_id         = lead.source_id,
        business_vertical_id = lead.business_vertical_id,
        assigned_to       = lead.assigned_to,
        notes             = (
            f"Auto-created from lead: {lead.lead_title} "
            f"(Lead: {lead.lead_ref_id or lead.id}, "
            f"Opp: {lead.opportunity_ref_id or '—'})"
        ),
        created_by    = cu.id,
        lead_id       = lead.id,
        workflow_status = 'draft',
        current_step    = 1,
    )
    db.add(tender); db.flush()

    lead_products = db.query(LeadProduct).filter(LeadProduct.lead_id == lead.id).all()
    lead_product_ids = [int(product.id) for product in lead_products if product.id]
    lead_oems_by_product: dict[int, list[LeadProductOEM]] = defaultdict(list)
    if lead_product_ids:
        for oem in db.query(LeadProductOEM).filter(LeadProductOEM.lead_product_id.in_(lead_product_ids)).all():
            lead_oems_by_product[int(oem.lead_product_id)].append(oem)
    for lp in lead_products:
        qty        = float(lp.quantity    or 1)
        unit_price = float(lp.unit_price  or 0)
        gst_pct    = float(lp.gst_percent or 0)
        total      = round(qty * unit_price * (1 + gst_pct / 100), 2)

        tp = TenderProduct(
            tender_id    = tender.id,
            product_id   = lp.product_id,
            product_name = (lp.product_name or "").strip(),
            quantity     = lp.quantity or 1,
            unit_price   = unit_price,
            gst_percent  = gst_pct,
            total_price  = total,
            sort_order   = lp.sort_order or 0,
        )
        db.add(tp); db.flush()

        for lo in lead_oems_by_product.get(int(lp.id), []):
            db.add(TenderProductOEM(
                tender_product_id = tp.id,
                oem_id            = lo.oem_id,
                oem_name          = lo.oem_name,
                authorization_num = lo.authorization_num,
            ))

    return tender


# ─── Product helpers ──────────────────────────────────────────────────────────

def _delete_products(db: Session, lead_id: int):
    ids = [r.id for r in db.query(LeadProduct.id).filter(LeadProduct.lead_id == lead_id).all()]
    if ids:
        db.query(LeadProductOEM).filter(
            LeadProductOEM.lead_product_id.in_(ids)
        ).delete(synchronize_session='fetch')
        db.query(LeadProduct).filter(
            LeadProduct.lead_id == lead_id
        ).delete(synchronize_session='fetch')


def _save_products(db: Session, lead_id: int, products: List[ProductEntry]):
    product_ids = {
        int(prod.product_id)
        for prod in products
        if prod.product_id and not (prod.product_name or "").strip()
    }
    product_name_map = {
        int(product_id): name or ""
        for product_id, name in db.query(ProductMaster.id, ProductMaster.name).filter(
            ProductMaster.id.in_(product_ids)
        ).all()
    } if product_ids else {}
    oem_ids = {
        int(oem.oem_id)
        for prod in products
        for oem in prod.oems
        if oem.oem_id and not (oem.oem_name or "").strip()
    }
    oem_name_map = {
        int(oem_id): name or ""
        for oem_id, name in db.query(OEM.id, OEM.name).filter(
            OEM.id.in_(oem_ids)
        ).all()
    } if oem_ids else {}
    for prod in products:
        if not (bool(prod.product_id) or bool(prod.product_name and prod.product_name.strip())):
            continue
        resolved_product_name = (prod.product_name or "").strip()
        if not resolved_product_name and prod.product_id:
            resolved_product_name = product_name_map.get(int(prod.product_id), "")
        lp = LeadProduct(
            lead_id      = lead_id,
            product_id   = prod.product_id,
            product_name = resolved_product_name,
            quantity     = max(1, prod.quantity),
            description  = (prod.description or "").strip() or None,
            notes        = (prod.description or "").strip() or None,
        )
        db.add(lp); db.flush()
        for oem in prod.oems:
            if not (bool(oem.oem_id) or bool(oem.oem_name and oem.oem_name.strip())):
                continue
            resolved_oem_name = (oem.oem_name or "").strip()
            if not resolved_oem_name and oem.oem_id:
                resolved_oem_name = oem_name_map.get(int(oem.oem_id), "")
            db.add(LeadProductOEM(
                lead_product_id = lp.id,
                oem_id          = oem.oem_id,
                oem_name        = resolved_oem_name,
            ))

