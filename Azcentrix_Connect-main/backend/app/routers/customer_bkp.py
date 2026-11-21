"""Customer management router — Billing & Shipping each with Customer/Consignee/Zone.
Customer 360 endpoint: Industrial-standard CRM view (Zoho/Salesforce style).

360 VIEW COVERS:
  1. Lead Pipeline   — total leads, value, stage breakdown, unconverted leads list
  2. Tender Pipeline — total tenders, value, status breakdown, win/loss analysis
  3. Work Orders     — total WOs, value, payment received, active/completed/delayed
  4. Payments        — billed, collected, pending, overdue invoices
  5. Products Supplied — which products delivered via WOs + OEM breakdown
  6. Products Demanded — from leads/tenders, leads NOT converted to tenders (gap list)
  7. KAM Activities  — calls, meetings, demos, site visits count from KAM module
  8. EMD / BG        — active instruments, expiring soon
  9. Smart Flags      — critical / warning / info alerts
  10. Assigned-to     — correct user via SalesCustomerAssignment or customers.assigned_to
"""
import io
import logging
import httpx
from collections import defaultdict
from datetime import date, datetime, timedelta
from app.core.timezone import now_ist, today_ist
from fastapi import APIRouter, Depends, HTTPException, Request, Query, UploadFile, File
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import func, and_, or_, false
import re
from pydantic import BaseModel, field_validator, model_validator
from typing import Any, Dict, List, Optional
from app.dependencies import get_tenant_db, get_current_user, require_manager_or_above, require_permission, get_request_ip
from app.models.user import User
from app.models.customer import Customer, CustomerContact
from app.models.all_models import (
    CustomerBillingConsignee, CustomerBillingZone,
    CustomerShippingConsignee, CustomerShippingZone,
    # 360 models
    Lead, LeadProduct, LeadProductOEM, LeadSource,
    Tender, TenderProduct, TenderProductOEM, TenderLossAnalysis,
    WorkOrder, WOInvoice, WOLineItem,
    KAMActivity, KAMWorkOrder, KAMTaskAssignment,
    EMDBG,
    SalesCustomerAssignment,
    ApprovalRequest,
    UserReportingHierarchy,
    Group, Role, Permission, RolePermission, OrgTreeNode,
    VerticalSector,
)
from app.core.logging import log_module_action
from app.services.dynamic_notification_service import (
    build_notification_change_context,
    emit_notification_event,
    notification_values_equal,
)
from app.services.cache_service import invalidate_badges_cache
from app.services.generic_approval_engine import (
    create_generic_approval_request,
    ensure_generic_approval_schema,
    find_latest_request_for_record,
    get_request_progress,
)
from app.utils.data_scope import get_team_user_ids

logger = logging.getLogger(__name__)
ADMIN_CUSTOMER_ROLES = {"admin", "ceo", "super_admin"}
MANAGER_CUSTOMER_ROLES = {"manager", "vp"}


def _normalize_pincode(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    raw = v.strip()
    if not raw:
        return None
    digits = ''.join(ch for ch in raw if ch.isdigit())
    if len(digits) != 6:
        raise ValueError('Pincode must be exactly 6 digits')
    return digits
router = APIRouter()


def _normalized_role(role: Optional[str]) -> str:
    normalized = (role or "").strip().lower().replace("-", "_").replace(" ", "_")
    return {
        "sales_executive": "sales",
        "salesexecutive": "sales",
    }.get(normalized, normalized)


def _resolve_customer_owner_user_id(db: Session, customer: Customer) -> Optional[int]:
    assignment = db.query(SalesCustomerAssignment).filter(
        SalesCustomerAssignment.customer_id == customer.id,
        SalesCustomerAssignment.is_active == True,
    ).first()
    if assignment and assignment.user_id:
        return int(assignment.user_id)
    return int(customer.assigned_to) if getattr(customer, "assigned_to", None) else None


def _payload_value(item: Any, key: str, default: Any = None) -> Any:
    if isinstance(item, dict):
        return item.get(key, default)
    return getattr(item, key, default)


def _normalize_payload_text(value: Any) -> str:
    return str(value or "").strip()


def _normalize_customer_identity_value(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def _find_duplicate_customer_field(
    db: Session,
    field_name: str,
    value: Any,
    *,
    exclude_customer_id: Optional[int] = None,
) -> Optional[Customer]:
    normalized_value = _normalize_customer_identity_value(value).casefold()
    if not normalized_value:
        return None

    query = db.query(Customer).filter(Customer.is_deleted == False)
    if exclude_customer_id is not None:
        query = query.filter(Customer.id != exclude_customer_id)

    for customer in query.all():
        current_value = _normalize_customer_identity_value(getattr(customer, field_name, ""))
        if current_value.casefold() == normalized_value:
            return customer
    return None


def _ensure_unique_customer_field(
    db: Session,
    field_name: str,
    value: Any,
    label: str,
    *,
    exclude_customer_id: Optional[int] = None,
) -> None:
    duplicate = _find_duplicate_customer_field(
        db,
        field_name,
        value,
        exclude_customer_id=exclude_customer_id,
    )
    if duplicate:
        existing_value = _normalize_customer_identity_value(getattr(duplicate, field_name, "") or value)
        raise HTTPException(
            status_code=400,
            detail=f'{label} "{existing_value}" already exists. Please use a different {label.lower()}.',
        )




def _normalize_contact_snapshot(item: Any) -> dict[str, Any]:
    return {
        "contact_name": _normalize_payload_text(_payload_value(item, "contact_name")),
        "designation": _normalize_payload_text(_payload_value(item, "designation")),
        "department": _normalize_payload_text(_payload_value(item, "department")),
        "office_phone": _normalize_payload_text(_payload_value(item, "office_phone")),
        "mobile": _normalize_payload_text(_payload_value(item, "mobile")),
        "office_email": _normalize_payload_text(_payload_value(item, "office_email")).lower(),
        "personal_email": _normalize_payload_text(_payload_value(item, "personal_email")).lower(),
        "website": _normalize_payload_text(_payload_value(item, "website")),
        "linkedin": _normalize_payload_text(_payload_value(item, "linkedin")),
        "is_primary": bool(_payload_value(item, "is_primary", False)),
        "notes": _normalize_payload_text(_payload_value(item, "notes")),
    }


def _normalize_address_snapshot(item: Any) -> dict[str, Any]:
    return {
        "name": _normalize_payload_text(_payload_value(item, "name")),
        "address": _normalize_payload_text(_payload_value(item, "address")),
        "pincode": _normalize_payload_text(_payload_value(item, "pincode")),
        "country": _normalize_payload_text(_payload_value(item, "country") or "India"),
        "state": _normalize_payload_text(_payload_value(item, "state")),
        "city": _normalize_payload_text(_payload_value(item, "city")),
        "area": _normalize_payload_text(_payload_value(item, "area")),
        "sort_order": int(_payload_value(item, "sort_order", 0) or 0),
    }


def _normalized_snapshots(rows: List[Any], serializer) -> list[dict[str, Any]]:
    normalized = [serializer(row) for row in rows]
    return sorted(normalized, key=lambda item: tuple(str(item.get(key) or "") for key in sorted(item.keys())))


def _section_has_actual_changes(
    existing_rows: List[Any],
    incoming_rows: List[Any],
    serializer,
) -> bool:
    return _normalized_snapshots(existing_rows, serializer) != _normalized_snapshots(incoming_rows, serializer)


def _normalize_customer_vertical(value: Optional[str]) -> Optional[str]:
    if not isinstance(value, str):
        return value
    cleaned = " ".join(value.replace(" ", " ").split()).strip()
    return cleaned or None


def _emit_customer_event(
    db: Session,
    *,
    customer: Customer,
    event_key: str,
    actor: Optional[User],
    approver_user_id: Optional[int] = None,
    requester_user_id: Optional[int] = None,
    reason: Optional[str] = None,
    extra_context: Optional[Dict[str, Any]] = None,
) -> None:
    try:
        context = {
            "customer_id": customer.id,
            "customer_name": getattr(customer, "customer_name", "") or "",
            "account_status": getattr(customer, "account_status", "") or "",
            "account_potential": getattr(customer, "account_potential", "") or "",
            "potential_value": getattr(customer, "potential_value", None),
            "creator_user_id": getattr(customer, "created_by", None),
            "customer_owner_user_id": _resolve_customer_owner_user_id(db, customer),
            "approver_user_id": approver_user_id,
            "requester_user_id": requester_user_id,
            "reason": reason or "",
            "record_ref": getattr(customer, "customer_name", "") or "",
        }
        if extra_context:
            context.update(extra_context)
        emit_notification_event(
            db,
            module_key="customers",
            event_key=event_key,
            record_id=customer.id,
            actor_user_id=getattr(actor, "id", None),
            context=context,
        )
    except Exception as exc:
        logger.warning("customer notification failed for customer=%s event=%s: %s", customer.id, event_key, exc)


def _get_tenant_id(request: Request) -> Optional[int]:
    tenant = getattr(request.state, "tenant", None)
    tenant_id = getattr(tenant, "id", None)
    return int(tenant_id) if isinstance(tenant_id, int) else tenant_id


def _attach_customer_approval_state(db: Session, customer: Customer) -> Customer:
    latest_request = find_latest_request_for_record(
        db,
        module_key="customer",
        action_key="create",
        record_id=customer.id,
    )

    return _apply_customer_approval_state(customer, latest_request)


def _apply_customer_approval_state(customer: Customer, latest_request: Optional[ApprovalRequest]) -> Customer:
    if latest_request:
        progress = get_request_progress(latest_request)
        customer.approval_status = latest_request.status
        customer.approval_display = progress["display"]
        customer.approval_progress_current = progress["current"]
        customer.approval_progress_total = progress["total"]
        customer.approval_request_id = latest_request.id
        return customer

    normalized_status = (customer.approval_status or "").strip().lower()
    fallback_display = str(customer.approval_status or "").replace("_", " ").title() if customer.approval_status else None
    customer.approval_display = {
        "approved": "Approved",
        "rejected": "Rejected",
        "pending": "Pending",
    }.get(normalized_status, fallback_display)
    customer.approval_progress_current = None
    customer.approval_progress_total = None
    customer.approval_request_id = None
    return customer


def _load_customer_approval_requests_by_customer(
    db: Session,
    customer_ids: list[int],
) -> tuple[dict[int, ApprovalRequest], dict[int, ApprovalRequest]]:
    latest_requests_by_customer: dict[int, ApprovalRequest] = {}
    pending_requests_by_customer: dict[int, ApprovalRequest] = {}
    if not customer_ids:
        return latest_requests_by_customer, pending_requests_by_customer

    approval_requests = (
        db.query(ApprovalRequest)
        .options(selectinload(ApprovalRequest.steps))
        .filter(
            ApprovalRequest.module_key == "customer",
            ApprovalRequest.action_key == "create",
            ApprovalRequest.record_id.in_(customer_ids),
        )
        .order_by(ApprovalRequest.requested_at.desc(), ApprovalRequest.id.desc())
        .all()
    )
    for request in approval_requests:
        record_id = int(request.record_id)
        latest_requests_by_customer.setdefault(record_id, request)
        if (request.status or "").strip().lower() == "pending":
            pending_requests_by_customer.setdefault(record_id, request)

    return latest_requests_by_customer, pending_requests_by_customer


def _group_by_customer_id(rows: List[Any]) -> dict[int, list[Any]]:
    grouped: dict[int, list[Any]] = defaultdict(list)
    for row in rows:
        grouped[int(row.customer_id)].append(row)
    return grouped


def _load_customer_child_rows(db: Session, model, customer_ids: list[int]) -> dict[int, list[Any]]:
    rows = (
        db.query(model)
        .filter(model.customer_id.in_(customer_ids), model.is_active == True)
        .order_by(model.customer_id, model.sort_order, model.id)
        .all()
    )
    return _group_by_customer_id(rows)


def _load_customer_pipeline_values(db: Session, customer_ids: list[int]) -> dict[int, dict[str, float]]:
    values: dict[int, dict[str, float]] = {
        customer_id: {
            "lead_value": 0.0,
            "tender_value": 0.0,
            "won_value": 0.0,
        }
        for customer_id in customer_ids
    }

    lead_rows = (
        db.query(Lead.customer_id, func.sum(Lead.est_value))
        .filter(
            Lead.customer_id.in_(customer_ids),
            Lead.is_deleted == False,
        )
        .group_by(Lead.customer_id)
        .all()
    )
    for customer_id, total in lead_rows:
        if customer_id is not None:
            values.setdefault(int(customer_id), {})["lead_value"] = float(total or 0)

    tender_rows = (
        db.query(Tender.customer_id, func.sum(Tender.est_value))
        .filter(
            Tender.customer_id.in_(customer_ids),
            Tender.is_deleted == False,
        )
        .group_by(Tender.customer_id)
        .all()
    )
    for customer_id, total in tender_rows:
        if customer_id is not None:
            values.setdefault(int(customer_id), {})["tender_value"] = float(total or 0)

    won_rows = (
        db.query(Tender.customer_id, func.sum(func.coalesce(Tender.bid_amount, Tender.est_value, 0)))
        .filter(
            Tender.customer_id.in_(customer_ids),
            Tender.is_deleted == False,
            Tender.result == "Won",
        )
        .group_by(Tender.customer_id)
        .all()
    )
    for customer_id, total in won_rows:
        if customer_id is not None:
            values.setdefault(int(customer_id), {})["won_value"] = float(total or 0)

    return values


def _attach_customers_for_list(db: Session, customers: List[Customer]) -> List[Customer]:
    if not customers:
        return customers

    customer_ids = [int(c.id) for c in customers]

    contacts_by_customer = _group_by_customer_id(
        db.query(CustomerContact)
        .filter(
            CustomerContact.customer_id.in_(customer_ids),
            CustomerContact.is_active == True,
        )
        .order_by(CustomerContact.customer_id, CustomerContact.id)
        .all()
    )
    billing_consignees_by_customer = _load_customer_child_rows(db, CustomerBillingConsignee, customer_ids)
    billing_zones_by_customer = _load_customer_child_rows(db, CustomerBillingZone, customer_ids)
    shipping_consignees_by_customer = _load_customer_child_rows(db, CustomerShippingConsignee, customer_ids)
    shipping_zones_by_customer = _load_customer_child_rows(db, CustomerShippingZone, customer_ids)
    pipeline_values_by_customer = _load_customer_pipeline_values(db, customer_ids)
    latest_activity_by_customer: dict[int, KAMActivity] = {}
    latest_activities = (
        db.query(KAMActivity)
        .filter(KAMActivity.customer_id.in_(customer_ids))
        .order_by(
            KAMActivity.customer_id,
            KAMActivity.activity_date.desc(),
            KAMActivity.id.desc(),
        )
        .all()
    )
    for activity in latest_activities:
        latest_activity_by_customer.setdefault(int(activity.customer_id), activity)

    assignments_by_customer: dict[int, int] = {}
    assignments = (
        db.query(SalesCustomerAssignment)
        .filter(
            SalesCustomerAssignment.customer_id.in_(customer_ids),
            SalesCustomerAssignment.is_active == True,
        )
        .order_by(
            SalesCustomerAssignment.customer_id,
            SalesCustomerAssignment.updated_at.desc(),
            SalesCustomerAssignment.id.desc(),
        )
        .all()
    )
    for assignment in assignments:
        assignments_by_customer.setdefault(int(assignment.customer_id), int(assignment.user_id))

    user_ids: set[int] = set()
    for customer in customers:
        owner_user_id = assignments_by_customer.get(int(customer.id))
        if owner_user_id:
            customer.assigned_to = owner_user_id
            user_ids.add(owner_user_id)
        elif customer.assigned_to:
            user_ids.add(int(customer.assigned_to))
        if customer.created_by:
            user_ids.add(int(customer.created_by))

    user_names: dict[int, str] = {}
    if user_ids:
        for user_id, full_name in db.query(User.id, User.full_name).filter(User.id.in_(user_ids)).all():
            user_names[int(user_id)] = full_name

    latest_requests_by_customer, pending_requests_by_customer = _load_customer_approval_requests_by_customer(
        db,
        customer_ids,
    )

    for customer in customers:
        customer_id = int(customer.id)
        customer.contacts = contacts_by_customer.get(customer_id, [])
        customer.billing_consignees = billing_consignees_by_customer.get(customer_id, [])
        customer.billing_zones = billing_zones_by_customer.get(customer_id, [])
        customer.shipping_consignees = shipping_consignees_by_customer.get(customer_id, [])
        customer.shipping_zones = shipping_zones_by_customer.get(customer_id, [])

        owner_user_id = customer.assigned_to
        customer.assigned_user_name = user_names.get(int(owner_user_id)) if owner_user_id else None
        customer.created_by_name = user_names.get(int(customer.created_by)) if customer.created_by else None

        latest_request = pending_requests_by_customer.get(customer_id) or latest_requests_by_customer.get(customer_id)
        _apply_customer_approval_state(customer, latest_request)

        pipeline_values = pipeline_values_by_customer.get(customer_id, {})
        customer.lead_value = pipeline_values.get("lead_value", 0.0)
        customer.total_lead_value = customer.lead_value
        customer.tender_value = pipeline_values.get("tender_value", 0.0)
        customer.total_tender_value = customer.tender_value
        customer.won_value = pipeline_values.get("won_value", 0.0)
        customer.won_tender_value = customer.won_value
        customer.customer_vertical = _normalize_customer_vertical(customer.customer_vertical)

        latest_activity = latest_activity_by_customer.get(customer_id)
        customer.last_activity_type = latest_activity.activity_type if latest_activity else None
        customer.last_activity_date = _fmt_date(latest_activity.activity_date) if latest_activity else None

    return customers


# --- Schemas ------------------------------------------------------------------

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
    if not manager_group_ids:
        return False

    user_group_ids = _parse_group_ids(user_group_id)
    return bool(user_group_ids & manager_group_ids)


def _customer_scope_user_ids(db: Session, current_user: User) -> Optional[list[int]]:
    role = _normalized_role(getattr(current_user, "role", ""))

    if role in ADMIN_CUSTOMER_ROLES:
        return None

    current_user_id = int(current_user.id)

    # Sales executive: own data only
    if role in ("sales", "sales_executive"):
        return [current_user_id]

    raw_group_id = getattr(current_user, "group_id", None)
    user_group_ids = _parse_group_ids(raw_group_id)

    team_ids = [current_user_id]

    if not user_group_ids:
        return team_ids

    # For sales_head/manager: find which groups this user is the group lead for
    group_lead_group_ids: set[int] = set()
    if role in ("manager", "sales_head"):
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

    users = db.query(User).filter(User.is_active == True).all()

    for user in users:
        uid = int(user.id)
        if uid == current_user_id:
            continue

        user_role = _normalized_role(getattr(user, "role", ""))
        user_group_id = getattr(user, "group_id", None)

        if not _user_group_ids_overlap(user_group_id, user_group_ids):
            continue

        # VP login: show own + group sales heads/managers + sales executives
        if role == "vp":
            if user_role in ("manager", "sales_head", "sales"):
                team_ids.append(uid)

        # Sales head / manager login:
        # - always show group sales executives
        # - if this user is group lead for any of the overlapping groups,
        #   also show other sales heads in those groups
        elif role in ("manager", "sales_head"):
            if user_role in ("sales", "sales_executive"):
                team_ids.append(uid)
            elif user_role in ("sales_head", "manager") and group_lead_group_ids:
                # Include this sales head only if they share a group where current user is lead
                other_user_group_ids = _parse_group_ids(user_group_id)
                if other_user_group_ids & group_lead_group_ids:
                    team_ids.append(uid)

        # Other non-admin roles: own only
        else:
            pass

    return sorted(set(team_ids))
    
@router.get("/debug-scope")
def debug_scope(
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    role_raw = getattr(current_user, "role", "")
    normalized_role = _normalized_role(role_raw)

    raw_group_id = getattr(current_user, "group_id", None)
    parsed_group_ids = _parse_group_ids(raw_group_id)

    scope_user_ids = _customer_scope_user_ids(db, current_user)

    users_debug = []
    users = db.query(User).filter(User.is_active == True).order_by(User.id).all()

    for user in users:
        user_raw_group_id = getattr(user, "group_id", None)
        user_group_ids = _parse_group_ids(user_raw_group_id)

        users_debug.append({
            "user_id": user.id,
            "full_name": getattr(user, "full_name", None),
            "role": getattr(user, "role", None),
            "raw_group_id": user_raw_group_id,
            "parsed_group_ids": sorted(user_group_ids),
            "overlap_with_logged_user": bool(user_group_ids & parsed_group_ids),
            "included_in_scope": scope_user_ids is None or int(user.id) in scope_user_ids,
        })

    return {
        "step_1_logged_user": {
            "user_id": current_user.id,
            "full_name": getattr(current_user, "full_name", None),
            "role_raw": role_raw,
            "normalized_role": normalized_role,
        },
        "step_2_group_parse": {
            "raw_group_id": raw_group_id,
            "parsed_group_ids": sorted(parsed_group_ids),
        },
        "step_3_scope_result": {
            "scope_user_ids": scope_user_ids,
        },
        "step_4_users_checked": users_debug,
    }

def _get_module_data_scope(db: Session, user: User, module_key: str = "customers") -> str:
    role = db.query(Role).filter(
        Role.name == user.role,
        Role.is_active == True,
    ).first()

    if not role:
        return "none"

    row = (
        db.query(RolePermission)
        .join(Permission, Permission.id == RolePermission.permission_id)
        .filter(
            RolePermission.role_id == role.id,
            Permission.module.in_([module_key, module_key.rstrip("s")]),
        )
        .first()
    )

    scope = (getattr(row, "data_scope", None) or "own").lower() if row else "own"

    if scope not in {"all", "team", "own", "none"}:
        return "own"

    return scope


def _get_team_user_ids_from_org_tree(db: Session, user_id: int) -> list[int]:
    return get_team_user_ids(db, int(user_id))

def _apply_customer_data_scope(db: Session, q, user: User):
    scope = _get_module_data_scope(db, user, "customers")

    if scope == "all":
        return q

    if scope == "none":
        return q.filter(false())

    if scope == "own":
        user_ids = [user.id]
    else:
        user_ids = _get_team_user_ids_from_org_tree(db, user.id)

    assigned_customer_ids = db.query(SalesCustomerAssignment.customer_id).filter(
        SalesCustomerAssignment.is_active == True,
        SalesCustomerAssignment.user_id.in_(user_ids),
    )

    return q.filter(
        or_(
            Customer.created_by.in_(user_ids),
            Customer.assigned_to.in_(user_ids),
            Customer.id.in_(assigned_customer_ids),
        )
    )

def _apply_customer_role_scope(db: Session, q, current_user: User):
    scope_user_ids = _customer_scope_user_ids(db, current_user)

    if scope_user_ids is None:
        return q

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

    return q.filter(or_(
        Customer.created_by.in_(scope_user_ids),

        Customer.id.in_(scoped_assignment_customer_ids),

        and_(
            ~Customer.id.in_(active_assignment_customer_ids),
            Customer.assigned_to.in_(scope_user_ids),
        ),
    ))
@router.get("/team-users")
def customer_team_users(
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    scope = _get_module_data_scope(db, current_user, "customers")

    if scope == "all":
        scope_user_ids = None
    elif scope == "none":
        scope_user_ids = []
    elif scope == "own":
        scope_user_ids = [current_user.id]
    else:
        scope_user_ids = _get_team_user_ids_from_org_tree(db, current_user.id)

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

class ContactCreate(BaseModel):
    contact_name:   str
    designation:    str
    department:     str
    office_phone:   Optional[str] = None
    mobile:         str
    office_email:   Optional[str] = None
    personal_email: Optional[str] = None
    website:        Optional[str] = None
    linkedin:       Optional[str] = None
    is_primary:     bool           = False
    notes:          Optional[str] = None

    @field_validator('contact_name', 'designation', 'department', 'mobile')
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError('This field is required')
        return v.strip()

    @field_validator('mobile', 'office_phone')
    @classmethod
    def phone_digits(cls, v: Optional[str]) -> Optional[str]:
        if v and v.strip():
            digits = re.sub(r'\D', '', v.strip())
            if len(digits) != 10:
                raise ValueError('Phone number must be exactly 10 digits')
        return v

    @field_validator('office_email', 'personal_email')
    @classmethod
    def valid_email(cls, v: Optional[str]) -> Optional[str]:
        if v and v.strip():
            if not re.match(r'^[^\s@]+@[^\s@]+\.[^\s@]+$', v.strip()):
                raise ValueError('Invalid email address')
        return v


class AddressEntry(BaseModel):
    id:         Optional[int] = None
    name:       str
    address:    Optional[str] = None
    pincode:    Optional[str] = None
    country:    Optional[str] = "India"
    state:      Optional[str] = None
    city:       Optional[str] = None
    area:       Optional[str] = None
    sort_order: int            = 0

    @field_validator('pincode')
    @classmethod
    def validate_pincode(cls, v: Optional[str]) -> Optional[str]:
        return _normalize_pincode(v)


class AddressResponse(AddressEntry):
    customer_id: int
    is_active:   bool = True
    model_config = {"from_attributes": True}


class CustomerCreate(BaseModel):
    customer_name:      str
    customer_vertical:  Optional[str] = None
    division:           Optional[str] = None
    group_name:         Optional[str] = None
    parent_account_id:  Optional[int] = None
    billing_address:    Optional[str] = None
    billing_pincode:    Optional[str] = None
    billing_country:    Optional[str] = None
    billing_state:      Optional[str] = None
    billing_city:       Optional[str] = None
    billing_area:       Optional[str] = None
    shipping_same_as_billing: bool     = False
    shipping_address:   Optional[str] = None
    shipping_pincode:   Optional[str] = None
    shipping_country:   Optional[str] = None
    shipping_state:     Optional[str] = None
    shipping_city:      Optional[str] = None
    shipping_area:      Optional[str] = None
    gst_number:         Optional[str] = None
    pan_number:         Optional[str] = None
    website:            Optional[str] = None
    account_status:     str            = "Prospect"
    account_potential:  str            = "Medium"
    potential_value:    Optional[float] = None
    assigned_to:        Optional[int] = None
    remarks:            Optional[str] = None
    contacts:            Optional[List[ContactCreate]] = None
    billing_consignees:  Optional[List[AddressEntry]]  = None
    billing_zones:       Optional[List[AddressEntry]]  = None
    shipping_consignees: Optional[List[AddressEntry]]  = None
    shipping_zones:      Optional[List[AddressEntry]]  = None
    custom_data:         Optional[Dict[str, Any]] = None

    @field_validator('gst_number')
    @classmethod
    def validate_gst(cls, v: Optional[str]) -> Optional[str]:
        if v and v.strip():
            if not re.match(r'^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$', v.strip(), re.IGNORECASE):
                raise ValueError('Invalid GST number format (e.g. 22AAAAA0000A1Z5)')
        return v

    @field_validator('customer_name')
    @classmethod
    def validate_customer_name(cls, v: str) -> str:
        normalized = _normalize_customer_identity_value(v)
        if not normalized:
            raise ValueError('Customer name is required')
        return normalized

    @field_validator('group_name')
    @classmethod
    def validate_group_name(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        normalized = _normalize_customer_identity_value(v)
        return normalized or None



    @field_validator('pan_number')
    @classmethod
    def validate_pan(cls, v: Optional[str]) -> Optional[str]:
        if v and v.strip():
            if not re.match(r'^[A-Z]{5}[0-9]{4}[A-Z]{1}$', v.strip(), re.IGNORECASE):
                raise ValueError('Invalid PAN number format (e.g. ABCDE1234F)')
        return v

    @field_validator('billing_pincode', 'shipping_pincode')
    @classmethod
    def validate_pincode(cls, v: Optional[str]) -> Optional[str]:
        return _normalize_pincode(v)


class ContactResponse(BaseModel):
    id:             int
    customer_id:    int
    contact_name:   str
    designation:    Optional[str] = None
    department:     Optional[str] = None
    office_phone:   Optional[str] = None
    mobile:         Optional[str] = None
    office_email:   Optional[str] = None
    personal_email: Optional[str] = None
    website:        Optional[str] = None
    linkedin:       Optional[str] = None
    is_primary:     bool           = False
    is_active:      bool           = True
    notes:          Optional[str] = None
    model_config = {"from_attributes": True}


class CustomerResponse(BaseModel):
    id:                  int
    customer_name:       str
    customer_vertical:   Optional[str] = None
    division:            Optional[str] = None
    assigned_user_name:  Optional[str] = None
    created_by_name:     Optional[str] = None
    group_name:          Optional[str] = None
    parent_account_id:   Optional[int] = None
    billing_address:     Optional[str] = None
    billing_pincode:     Optional[str] = None
    billing_country:     Optional[str] = None
    billing_state:       Optional[str] = None
    billing_city:        Optional[str] = None
    billing_area:        Optional[str] = None
    shipping_same_as_billing: bool      = False
    shipping_address:    Optional[str] = None
    shipping_pincode:    Optional[str] = None
    shipping_country:    Optional[str] = None
    shipping_state:      Optional[str] = None
    shipping_city:       Optional[str] = None
    shipping_area:       Optional[str] = None
    gst_number:          Optional[str] = None
    pan_number:          Optional[str] = None
    website:             Optional[str] = None
    account_status:      str            = "Prospect"
    account_potential:   str            = "Medium"
    potential_value:     Optional[float] = None
    lead_value:          float           = 0
    total_lead_value:    float           = 0
    tender_value:        float           = 0
    total_tender_value:  float           = 0
    won_value:           float           = 0
    won_tender_value:    float           = 0
    assigned_to:         Optional[int] = None
    remarks:             Optional[str] = None
    created_by:          Optional[int] = None
    is_active:           bool           = False
    approval_status:     Optional[str] = None
    approval_display:    Optional[str] = None
    approval_progress_current: Optional[int] = None
    approval_progress_total: Optional[int] = None
    approval_request_id: Optional[int] = None
    last_activity_type: Optional[str] = None
    last_activity_date: Optional[str] = None
    contacts:            List[ContactResponse] = []
    billing_consignees:  List[AddressResponse] = []
    billing_zones:       List[AddressResponse] = []
    shipping_consignees: List[AddressResponse] = []
    shipping_zones:      List[AddressResponse] = []
    custom_data:          Optional[Dict[str, Any]] = None
    model_config = {"from_attributes": True}


# --- Helpers ------------------------------------------------------------------



def _attach_addresses(db: Session, c: Customer) -> Customer:
    """Load all related address lists onto the customer object."""
    def q(model):
        return (
            db.query(model)
              .filter(model.customer_id == c.id, model.is_active == True)
              .order_by(model.sort_order, model.id)
              .all()
        )
    c.contacts            = db.query(CustomerContact).filter(
        CustomerContact.customer_id == c.id,
        CustomerContact.is_active   == True,
    ).all()
    c.billing_consignees  = q(CustomerBillingConsignee)
    c.billing_zones       = q(CustomerBillingZone)
    c.shipping_consignees = q(CustomerShippingConsignee)
    c.shipping_zones      = q(CustomerShippingZone)

    # -- FIX: Resolve assigned_user_name correctly --------------------------
    # Priority 1: SalesCustomerAssignment (exclusive assignment)
    # Priority 2: customers.assigned_to FK
    c.assigned_user_name = None
    resolved_owner_user_id = _resolve_customer_owner_user_id(db, c)
    c.assigned_to = resolved_owner_user_id
    if resolved_owner_user_id:
        user = db.query(User).filter(User.id == resolved_owner_user_id).first()
        c.assigned_user_name = user.full_name if user else None

    # Resolve created_by_name
    c.created_by_name = None
    if c.created_by:
        creator = db.query(User).filter(User.id == c.created_by).first()
        c.created_by_name = creator.full_name if creator else None

    return _attach_customer_approval_state(db, c)


def _hard_delete_and_insert(db: Session, model, customer_id: int, entries: List[AddressEntry]):
    db.query(model).filter(model.customer_id == customer_id).delete(synchronize_session=False)
    for i, e in enumerate(entries):
        if e.name.strip():
            db.add(model(
                customer_id=customer_id,
                name=e.name.strip(),
                address=e.address,
                pincode=e.pincode,
                country=e.country or "India",
                state=e.state,
                city=e.city,
                area=e.area,
                sort_order=e.sort_order or i,
            ))


def _hard_delete_and_insert_raw(db: Session, model, customer_id: int, rows: List[dict]):
    db.query(model).filter(model.customer_id == customer_id).delete(synchronize_session=False)
    for i, r in enumerate(rows):
        db.add(model(customer_id=customer_id, sort_order=i, **r))


def _hard_delete_contacts(db: Session, customer_id: int, contacts_in: List[ContactCreate]):
    db.query(CustomerContact).filter(
        CustomerContact.customer_id == customer_id
    ).delete(synchronize_session=False)
    has_primary = any(ct.is_primary for ct in contacts_in)
    for i, cd in enumerate(contacts_in):
        if cd.contact_name.strip():
            db.add(CustomerContact(
                customer_id=customer_id,
                is_primary=(cd.is_primary if has_primary else i == 0),
                **cd.model_dump(exclude={"is_primary"}),
            ))


# --- Excel parser -------------------------------------------------------------

async def _parse_excel_addresses(file: UploadFile, name_keywords: list) -> List[dict]:
    import openpyxl

    raw = await file.read()

    try:
        wb = openpyxl.load_workbook(io.BytesIO(raw), data_only=True)
    except Exception:
        raise HTTPException(400, "Invalid Excel file. Please use the downloaded template.")

    ws = wb.active
    header_row_num = None

    for row in ws.iter_rows(min_row=1, max_row=8):
        cells = [str(c.value or "").strip().lower() for c in row]
        non_empty = [v for v in cells if v]

        if len(non_empty) < 2:
            continue

        has_name = any("name" in v for v in cells)
        has_address = any("address" in v or "addr" in v for v in cells)

        if has_name and has_address:
            header_row_num = row[0].row
            break

    if not header_row_num:
        raise HTTPException(
            400,
            "Cannot find header row. Expected columns: Name, Address, Pincode, State, District, Area.",
        )

    headers = [
        str(ws.cell(header_row_num, col).value or "").strip().lower()
        for col in range(1, ws.max_column + 1)
    ]

    def col_idx(keywords: list):
        for kw in keywords:
            for i, h in enumerate(headers):
                if kw in h:
                    return i + 1
        return None

    name_col = col_idx(name_keywords + ["name"])
    addr_col = col_idx(["address", "addr"])
    pin_col = col_idx(["pincode", "pin", "zip", "postal"])
    state_col = col_idx(["state"])
    district_col = col_idx(["district", "city"])
    area_col = col_idx(["area", "locality"])
    country_col = col_idx(["country"])

    if not name_col:
        raise HTTPException(400, f"Missing column: '{name_keywords[0]} Name'. Please use the template.")

    rows = []

    for row in ws.iter_rows(min_row=header_row_num + 1, values_only=True):
        if all(v is None or str(v).strip() == "" for v in row):
            continue

        def cell(col):
            if not col:
                return ""
            return str(row[col - 1] or "").strip()

        name = cell(name_col)
        address = cell(addr_col)
        raw_pin = cell(pin_col)
        pincode = "".join(filter(str.isdigit, raw_pin.split(".")[0]))

        state = cell(state_col)
        district = cell(district_col)
        area = cell(area_col)
        country = cell(country_col) or "India"

        if not name:
            continue

        if raw_pin and len(pincode) != 6:
            continue

        rows.append(dict(
            name=name,
            address=address or None,
            pincode=pincode or None,
            country=country,
            state=state or None,
            city=district or None,
            area=area or None,
        ))

    if not rows:
        raise HTTPException(
            400,
            "No valid data rows found. Ensure each row has at least a Name.",
        )

    return rows

# -------------------------------------------------------------------------------
# STATIC ROUTES
# -------------------------------------------------------------------------------



# -- Import endpoints ----------------------------------------------------------

@router.post("/{customer_id}/billing-consignees/import")
async def import_billing_consignees(
    customer_id: int, file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user),
):
    if not db.query(Customer).filter(Customer.id == customer_id, Customer.is_deleted == False).first():
        raise HTTPException(404, "Customer not found")
    rows = await _parse_excel_addresses(file, ["consignee"])
    _hard_delete_and_insert_raw(db, CustomerBillingConsignee, customer_id, rows)
    db.commit()
    return {"imported": len(rows), "message": f"{len(rows)} billing consignees imported"}


@router.post("/{customer_id}/billing-zones/import")
async def import_billing_zones(
    customer_id: int, file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user),
):
    if not db.query(Customer).filter(Customer.id == customer_id, Customer.is_deleted == False).first():
        raise HTTPException(404, "Customer not found")
    rows = await _parse_excel_addresses(file, ["zone"])
    _hard_delete_and_insert_raw(db, CustomerBillingZone, customer_id, rows)
    db.commit()
    return {"imported": len(rows), "message": f"{len(rows)} billing zones imported"}


@router.post("/{customer_id}/shipping-consignees/import")
async def import_shipping_consignees(
    customer_id: int, file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user),
):
    if not db.query(Customer).filter(Customer.id == customer_id, Customer.is_deleted == False).first():
        raise HTTPException(404, "Customer not found")
    rows = await _parse_excel_addresses(file, ["consignee"])
    _hard_delete_and_insert_raw(db, CustomerShippingConsignee, customer_id, rows)
    db.commit()
    return {"imported": len(rows), "message": f"{len(rows)} shipping consignees imported"}


@router.post("/{customer_id}/shipping-zones/import")
async def import_shipping_zones(
    customer_id: int, file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user),
):
    if not db.query(Customer).filter(Customer.id == customer_id, Customer.is_deleted == False).first():
        raise HTTPException(404, "Customer not found")
    rows = await _parse_excel_addresses(file, ["zone"])
    _hard_delete_and_insert_raw(db, CustomerShippingZone, customer_id, rows)
    db.commit()
    return {"imported": len(rows), "message": f"{len(rows)} shipping zones imported"}


# -------------------------------------------------------------------------------
# STATS (segment breakdown from master vertical_sectors table)
# -------------------------------------------------------------------------------

@router.get("/stats")
def customer_stats(
    db:  Session = Depends(get_tenant_db),
    cu:  User    = Depends(get_current_user),
):
    # All active segments from master table
    active_sectors = (
        db.query(VerticalSector)
        .filter(VerticalSector.is_active == True)
        .order_by(VerticalSector.display_order, VerticalSector.name, VerticalSector.id)
        .all()
    )

    # Count customers per customer_vertical value (raw, case-insensitive key)
    raw_counts: dict[str, int] = {}
    for raw_val, cnt in (
        db.query(Customer.customer_vertical, func.count(Customer.id))
        .filter(Customer.customer_vertical.isnot(None), Customer.is_deleted == False)
        .group_by(Customer.customer_vertical)
        .all()
    ):
        if raw_val and raw_val.strip():
            key = raw_val.strip().lower()
            raw_counts[key] = raw_counts.get(key, 0) + int(cnt or 0)

    # Build lead-source name lookup
    lead_source_map: dict[int, str] = {
        ls.id: ls.name
        for ls in db.query(LeadSource).all()
    }

    # Count leads per (customer_vertical, source_id)
    segment_source_map: dict[str, dict[str, int]] = {
        s.name.strip().lower(): {} for s in active_sectors
    }
    lead_src_rows = (
        db.query(Customer.customer_vertical, Lead.source_id, func.count(Lead.id))
        .join(Lead, Lead.customer_id == Customer.id)
        .filter(
            Customer.customer_vertical.isnot(None),
            Customer.is_deleted == False,
            Lead.source_id.isnot(None),
        )
        .group_by(Customer.customer_vertical, Lead.source_id)
        .all()
    )
    for vert_name, src_id, cnt in lead_src_rows:
        if not vert_name:
            continue
        key = vert_name.strip().lower()
        if key not in segment_source_map:
            continue
        src_name = lead_source_map.get(src_id, f"Source {src_id}")
        segment_source_map[key][src_name] = segment_source_map[key].get(src_name, 0) + int(cnt or 0)

    # Build segment list: every active sector with customer count + source breakdown
    by_vertical = [
        {
            "name": s.name,
            "value": raw_counts.get(s.name.strip().lower(), 0),
            "sources": sorted(
                [{"name": k, "value": v} for k, v in segment_source_map.get(s.name.strip().lower(), {}).items()],
                key=lambda x: -x["value"],
            ),
        }
        for s in active_sectors
    ]

    return {
        "charts": {
            "by_vertical": by_vertical,
        }
    }


# -------------------------------------------------------------------------------
# DYNAMIC ROUTES
# -------------------------------------------------------------------------------

@router.get("/", response_model=list[CustomerResponse])
def list_customers(
    search:      Optional[str] = Query(None),
    status:      Optional[str] = Query(None),
    assigned_to: Optional[int] = Query(None),
    skip: int = 0, limit: int = 1000,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    q = db.query(Customer).filter(Customer.is_deleted == False)
    q = _apply_customer_data_scope(db, q, current_user)
    if search:      q = q.filter(Customer.customer_name.ilike(f"%{search}%"))
    if status:      q = q.filter(Customer.account_status == status)
    if assigned_to: q = q.filter(Customer.assigned_to == assigned_to)
    customers = q.offset(skip).limit(limit).all()
    return _attach_customers_for_list(db, customers)


@router.get("/badge")
def get_customer_badge(
    db:           Session = Depends(get_tenant_db),
    current_user: User    = Depends(get_current_user),
):
    """Return count of customers created since last visit, visible to this user."""
    layout = dict(current_user.dashboard_layout or {})
    last_seen_str = layout.get("customers_last_seen_at")
    if not last_seen_str:
        layout["customers_last_seen_at"] = now_ist().isoformat()
        current_user.dashboard_layout = layout
        db.commit()
        return {"count": 0}
    try:
        last_seen = datetime.fromisoformat(last_seen_str)
    except ValueError:
        return {"count": 0}
    q = db.query(func.count(Customer.id)).filter(
        Customer.is_deleted == False,
        Customer.created_at > last_seen,
    )
    q = _apply_customer_data_scope(db, q, current_user)
    count = q.scalar() or 0
    return {"count": count}


@router.post("/mark-seen")
def mark_customers_seen(
    db:           Session = Depends(get_tenant_db),
    current_user: User    = Depends(get_current_user),
):
    layout = dict(current_user.dashboard_layout or {})
    layout["customers_last_seen_at"] = now_ist().isoformat()
    current_user.dashboard_layout = layout
    db.commit()
    invalidate_badges_cache(db, current_user.id)
    return {"ok": True}


@router.get("/dropdown")
def customers_dropdown(
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    q = db.query(Customer).filter(
        Customer.is_deleted == False,
        Customer.is_active == True,
    )

    q = _apply_customer_data_scope(db, q, current_user)

    rows = q.order_by(Customer.customer_name).all()

    return [
        {"id": r.id, "customer_name": r.customer_name}
        for r in rows
    ]

@router.get("/group-dropdown")
def customer_groups_dropdown(
    db: Session = Depends(get_tenant_db),
    _:  User    = Depends(get_current_user),
):
    """Return all active customer group names for use in select boxes."""
    rows = (
        db.query(Customer.group_name)
        .filter(
            Customer.is_deleted == False,
            Customer.is_active == True,
            Customer.group_name.isnot(None),
            func.length(func.trim(Customer.group_name)) > 0,
        )
        .distinct()
        .order_by(Customer.group_name)
        .all()
    )
    return [{"group_name": str(r.group_name).strip()} for r in rows if getattr(r, "group_name", None)]


@router.get("/name-dropdown")
def customer_names_dropdown(
    db: Session = Depends(get_tenant_db),
    _:  User    = Depends(get_current_user),
):
    """
    Return all customer names, including pending/rejected records, so the customer
    creation form can show approval state and prevent duplicate names early.
    """
    customers = (
        db.query(Customer)
        .filter(Customer.is_deleted == False)
        .order_by(Customer.customer_name)
        .all()
    )
    customer_ids = [int(customer.id) for customer in customers]
    latest_requests_by_customer, pending_requests_by_customer = _load_customer_approval_requests_by_customer(
        db,
        customer_ids,
    )

    items: list[dict[str, Any]] = []
    for customer in customers:
        customer_id = int(customer.id)
        latest_request = pending_requests_by_customer.get(customer_id) or latest_requests_by_customer.get(customer_id)
        _apply_customer_approval_state(customer, latest_request)
        items.append({
            "id": customer.id,
            "customer_name": customer.customer_name,
            "approval_status": customer.approval_status,
            "approval_display": customer.approval_display,
        })
    return items


@router.get("/{customer_id}", response_model=CustomerResponse)
def get_customer(
    customer_id: int,
    db: Session = Depends(get_tenant_db),
    _:  User    = Depends(get_current_user),
):
    c = db.query(Customer).filter(Customer.id == customer_id, Customer.is_deleted == False).first()
    if not c:
        raise HTTPException(404, "Customer not found")
    return _attach_addresses(db, c)


@router.post("/", response_model=CustomerResponse, status_code=201)
def create_customer(
    data: CustomerCreate, request: Request,
    db:   Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("customers.create")),
):
    ensure_generic_approval_schema(db)
    _ensure_unique_customer_field(db, "customer_name", data.customer_name, "Customer name")

    customer_fields = {col.key for col in Customer.__table__.columns}
    customer_data   = {
        k: v for k, v in data.model_dump(exclude={
            "contacts","billing_consignees","billing_zones",
            "shipping_consignees","shipping_zones",
        }).items() if k in customer_fields
    }
    if "customer_vertical" in customer_data:
        customer_data["customer_vertical"] = _normalize_customer_vertical(customer_data["customer_vertical"])
    customer = Customer(
        **customer_data,
        created_by=current_user.id,
        is_active=False,
        approval_status='pending',
    )
    if not customer.assigned_to:
        customer.assigned_to = current_user.id
    db.add(customer)
    db.flush()

    if customer.assigned_to:
        db.add(SalesCustomerAssignment(
            user_id=int(customer.assigned_to),
            customer_id=customer.id,
            assigned_by=current_user.id,
            is_active=True,
            updated_at=now_ist(),
        ))

    contacts_in = data.contacts or []
    has_primary = any(c.is_primary for c in contacts_in)
    for i, cd in enumerate(contacts_in):
        if cd.contact_name.strip():
            db.add(CustomerContact(
                customer_id=customer.id,
                is_primary=(cd.is_primary if has_primary else i == 0),
                **cd.model_dump(exclude={"is_primary"}),
            ))

    for i, e in enumerate(data.billing_consignees or []):
        if e.name.strip():
            db.add(CustomerBillingConsignee(
                customer_id=customer.id, name=e.name.strip(),
                address=e.address, pincode=e.pincode, country=e.country or "India",
                state=e.state, city=e.city, area=e.area, sort_order=e.sort_order or i,
            ))
    for i, e in enumerate(data.billing_zones or []):
        if e.name.strip():
            db.add(CustomerBillingZone(
                customer_id=customer.id, name=e.name.strip(),
                address=e.address, pincode=e.pincode, country=e.country or "India",
                state=e.state, city=e.city, area=e.area, sort_order=e.sort_order or i,
            ))

    ship_cons  = data.billing_consignees if data.shipping_same_as_billing else data.shipping_consignees
    ship_zones = data.billing_zones      if data.shipping_same_as_billing else data.shipping_zones

    for i, e in enumerate(ship_cons or []):
        if e.name.strip():
            db.add(CustomerShippingConsignee(
                customer_id=customer.id, name=e.name.strip(),
                address=e.address, pincode=e.pincode, country=e.country or "India",
                state=e.state, city=e.city, area=e.area, sort_order=e.sort_order or i,
            ))
    for i, e in enumerate(ship_zones or []):
        if e.name.strip():
            db.add(CustomerShippingZone(
                customer_id=customer.id, name=e.name.strip(),
                address=e.address, pincode=e.pincode, country=e.country or "India",
                state=e.state, city=e.city, area=e.area, sort_order=e.sort_order or i,
            ))

    log_module_action(
        db=db, user_id=current_user.id, module="customers", action="create",
        record_id=customer.id, record_name=data.customer_name,
        ip=get_request_ip(request),
        new_data=data.model_dump(exclude={
            "contacts","billing_consignees","billing_zones",
            "shipping_consignees","shipping_zones",
        }),
    )

    approval_request = create_generic_approval_request(
        db,
        tenant_id=_get_tenant_id(request),
        requester=current_user,
        module_key='customer',
        action_key='create',
        record_id=customer.id,
    )
    if (approval_request.status or "").strip().lower() == "approved":
        customer.is_active = True
        customer.approval_status = "approved"
    else:
        active_step = next(
            (step for step in sorted(approval_request.steps or [], key=lambda item: item.step_no) if step.step_no == approval_request.current_step_no),
            None,
        )
        _emit_customer_event(
            db,
            customer=customer,
            event_key="approval_requested",
            actor=current_user,
            approver_user_id=getattr(active_step, "approver_user_id", None),
            requester_user_id=current_user.id,
        )

    _emit_customer_event(
        db,
        customer=customer,
        event_key="created",
        actor=current_user,
    )

    db.commit()
    db.refresh(customer)
    return _attach_addresses(db, customer)


@router.put("/{customer_id}", response_model=CustomerResponse)
def update_customer(
    customer_id: int, data: CustomerCreate, request: Request,
    db:           Session = Depends(get_tenant_db),
    current_user: User    = Depends(require_permission("customers.update")),
):
    c = db.query(Customer).filter(Customer.id == customer_id, Customer.is_deleted == False).first()
    if not c:
        raise HTTPException(404, "Customer not found")

    current_customer_name = _normalize_customer_identity_value(getattr(c, "customer_name", ""))
    next_customer_name = _normalize_customer_identity_value(data.customer_name)
    if next_customer_name.casefold() != current_customer_name.casefold():
        _ensure_unique_customer_field(
            db,
            "customer_name",
            data.customer_name,
            "Customer name",
            exclude_customer_id=customer_id,
        )


    customer_fields = {col.key for col in Customer.__table__.columns}
    update_data = data.model_dump(exclude={
        "contacts","billing_consignees","billing_zones",
        "shipping_consignees","shipping_zones","created_by",
    }, exclude_unset=True)
    if "customer_vertical" in update_data:
        update_data["customer_vertical"] = _normalize_customer_vertical(update_data["customer_vertical"])
    old_account_status = getattr(c, "account_status", "") or ""
    old_account_potential = getattr(c, "account_potential", "") or ""
    old_potential_value = getattr(c, "potential_value", None)
    old_field_values = {
        field: getattr(c, field, None)
        for field in update_data
        if field in customer_fields
    }
    changed_fields: set[str] = set()
    existing_contacts = db.query(CustomerContact).filter(CustomerContact.customer_id == customer_id).all() if data.contacts is not None else []
    existing_billing_consignees = db.query(CustomerBillingConsignee).filter(CustomerBillingConsignee.customer_id == customer_id).all() if data.billing_consignees is not None else []
    existing_billing_zones = db.query(CustomerBillingZone).filter(CustomerBillingZone.customer_id == customer_id).all() if data.billing_zones is not None else []
    ship_cons  = data.billing_consignees if data.shipping_same_as_billing else data.shipping_consignees
    ship_zones = data.billing_zones      if data.shipping_same_as_billing else data.shipping_zones
    existing_shipping_consignees = db.query(CustomerShippingConsignee).filter(CustomerShippingConsignee.customer_id == customer_id).all() if ship_cons is not None else []
    existing_shipping_zones = db.query(CustomerShippingZone).filter(CustomerShippingZone.customer_id == customer_id).all() if ship_zones is not None else []
    related_section_notes: list[str] = []
    if data.contacts is not None and _section_has_actual_changes(existing_contacts, data.contacts, _normalize_contact_snapshot):
        related_section_notes.append("Customer contacts updated.")
    if (
        (data.billing_consignees is not None and _section_has_actual_changes(existing_billing_consignees, data.billing_consignees, _normalize_address_snapshot))
        or (data.billing_zones is not None and _section_has_actual_changes(existing_billing_zones, data.billing_zones, _normalize_address_snapshot))
    ):
        related_section_notes.append("Billing details updated.")
    if data.shipping_same_as_billing and (
        (ship_cons is not None and _section_has_actual_changes(existing_shipping_consignees, ship_cons, _normalize_address_snapshot))
        or (ship_zones is not None and _section_has_actual_changes(existing_shipping_zones, ship_zones, _normalize_address_snapshot))
    ):
        related_section_notes.append("Shipping details synced from billing details.")
    elif (
        (data.shipping_consignees is not None and _section_has_actual_changes(existing_shipping_consignees, data.shipping_consignees, _normalize_address_snapshot))
        or (data.shipping_zones is not None and _section_has_actual_changes(existing_shipping_zones, data.shipping_zones, _normalize_address_snapshot))
    ):
        related_section_notes.append("Shipping details updated.")
    related_sections_updated = bool(related_section_notes)

    for field, val in update_data.items():
        if field in customer_fields:
            if not notification_values_equal(getattr(c, field, None), val):
                changed_fields.add(field)
            setattr(c, field, val)

    if "assigned_to" in update_data:
        assignment_now = now_ist()
        db.query(SalesCustomerAssignment).filter(
            SalesCustomerAssignment.customer_id == customer_id
        ).update({"is_active": False}, synchronize_session=False)
        if c.assigned_to:
            existing_assignment = db.query(SalesCustomerAssignment).filter(
                SalesCustomerAssignment.customer_id == customer_id,
                SalesCustomerAssignment.user_id == int(c.assigned_to),
            ).first()
            if existing_assignment:
                existing_assignment.is_active = True
                existing_assignment.assigned_by = current_user.id
                existing_assignment.updated_at = assignment_now
            else:
                db.add(SalesCustomerAssignment(
                    user_id=int(c.assigned_to),
                    customer_id=customer_id,
                    assigned_by=current_user.id,
                    is_active=True,
                    updated_at=assignment_now,
                ))

    if data.contacts is not None:
        _hard_delete_contacts(db, customer_id, data.contacts)

    if data.billing_consignees is not None:
        _hard_delete_and_insert(db, CustomerBillingConsignee, customer_id, data.billing_consignees)
    if data.billing_zones is not None:
        _hard_delete_and_insert(db, CustomerBillingZone, customer_id, data.billing_zones)

    if ship_cons is not None:
        _hard_delete_and_insert(db, CustomerShippingConsignee, customer_id, ship_cons)
    if ship_zones is not None:
        _hard_delete_and_insert(db, CustomerShippingZone, customer_id, ship_zones)

    log_module_action(
        db=db, user_id=current_user.id, module="customers", action="update",
        record_id=customer_id, record_name=c.customer_name,
        ip=get_request_ip(request),
        new_data=data.model_dump(exclude={
            "contacts","billing_consignees","billing_zones",
            "shipping_consignees","shipping_zones",
        }),
    )
    generic_changed_fields = sorted(changed_fields - {"account_status", "account_potential", "potential_value"})
    status_changed = "account_status" in changed_fields
    potential_changed = bool({"account_potential", "potential_value"} & changed_fields)
    generic_change_payload = {
        field_name: {
            "old": old_field_values.get(field_name),
            "new": getattr(c, field_name, None),
        }
        for field_name in generic_changed_fields
    }
    status_change_payload = {
        "account_status": {
            "old": old_account_status,
            "new": getattr(c, "account_status", "") or "",
            "label": "Status",
        }
    } if status_changed else {}
    potential_change_payload = {
        "account_potential": {
            "old": old_account_potential,
            "new": getattr(c, "account_potential", "") or "",
            "label": "Potential",
        },
        "potential_value": {
            "old": old_potential_value,
            "new": getattr(c, "potential_value", None),
            "label": "Potential Value",
        },
    } if potential_changed else {}

    primary_event_key: Optional[str] = None
    primary_change_payload: Dict[str, Any] = {}

    if status_changed:
        primary_event_key = "status_changed"
        primary_change_payload.update(generic_change_payload)
        primary_change_payload.update(status_change_payload)
        primary_change_payload.update(potential_change_payload)
    elif potential_changed:
        primary_event_key = "potential_changed"
        primary_change_payload.update(generic_change_payload)
        primary_change_payload.update(potential_change_payload)
    elif generic_changed_fields or related_sections_updated:
        primary_event_key = "updated"
        primary_change_payload.update(generic_change_payload)

    if primary_event_key:
        _emit_customer_event(
            db,
            customer=c,
            event_key=primary_event_key,
            actor=current_user,
            extra_context=build_notification_change_context(
                changes=primary_change_payload,
                notes=related_section_notes,
            ),
        )
    db.commit()
    db.refresh(c)
    return _attach_addresses(db, c)


@router.patch("/{customer_id}/status")
def change_status(
    customer_id: int, request: Request, status: str = Query(...),
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    valid = {"Active", "Inactive", "Prospect", "Churned"}
    if status not in valid:
        raise HTTPException(400, f"Invalid status. Must be one of {valid}")
    c = db.query(Customer).filter(Customer.id == customer_id, Customer.is_deleted == False).first()
    if not c:
        raise HTTPException(404, "Customer not found")
    old_account_status = getattr(c, "account_status", "") or ""
    if old_account_status == status:
        return {"message": f"Status is already {status}"}
    c.account_status = status
    log_module_action(
        db=db, user_id=current_user.id, module="customers", action="status_change",
        record_id=customer_id, record_name=c.customer_name,
        ip=get_request_ip(request), new_data={"account_status": status},
    )
    _emit_customer_event(
        db,
        customer=c,
        event_key="status_changed",
        actor=current_user,
        extra_context=build_notification_change_context(
            changes={
                "account_status": {
                    "old": old_account_status,
                    "new": status,
                    "label": "Status",
                }
            }
        ),
    )
    db.commit()
    return {"message": f"Status updated to {status}"}


@router.delete("/{customer_id}")
def delete_customer(
    customer_id: int, request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("customers.delete")),
):
    c = db.query(Customer).filter(Customer.id == customer_id, Customer.is_deleted == False).first()
    if not c:
        raise HTTPException(404, "Customer not found")
    c.is_deleted = True
    _emit_customer_event(
        db,
        customer=c,
        event_key="deleted",
        actor=current_user,
    )
    for model in [
        CustomerContact,
        CustomerBillingConsignee, CustomerBillingZone,
        CustomerShippingConsignee, CustomerShippingZone,
    ]:
        db.query(model).filter(model.customer_id == customer_id).delete(synchronize_session=False)

    log_module_action(
        db=db, user_id=current_user.id, module="customers", action="delete",
        record_id=customer_id, record_name=c.customer_name,
        ip=get_request_ip(request),
    )
    db.commit()
    return {"message": "Customer deleted"}


# -------------------------------------------------------------------------------
# CUSTOMER 360  -  Industrial-Standard CRM View
# -------------------------------------------------------------------------------

def _days(d1, d2) -> Optional[int]:
    if not d1 or not d2:
        return None
    try:
        t1 = d1.date() if hasattr(d1, "date") else d1
        t2 = d2.date() if hasattr(d2, "date") else d2
        return abs((t2 - t1).days)
    except Exception:
        return None


def _fmt_date(d) -> Optional[str]:
    if not d:
        return None
    try:
        return str(d)[:10]
    except Exception:
        return None


@router.get("/{customer_id}/360")
def customer_360(
    customer_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    """
    Complete 360° view — industrial CRM standard.

    Sections returned:
      customer        — profile snapshot
      assigned_kam    — who owns this customer (SalesCustomerAssignment priority)
      lead_summary    — pipeline, stage breakdown, value, unconverted list
      tender_summary  — pipeline, win/loss, value, loss analysis
      workorder_summary — WO counts, value, payment received, delayed
      payment_summary — billed, collected, pending, overdue, trend
      products_supplied — products & OEMs delivered via completed WO line items
      products_demanded — products from leads/tenders, gap list (lead?no tender)
      kam_summary     — calls, meetings, demos, site visits, tasks
      emdbg_summary   — BG/EMD active, expiring soon
      contacts        — contact list
      flags           — smart alerts (critical/warning/info)
      flag_count      — {critical, warning, info}
    """
    today = today_ist()

    c = db.query(Customer).filter(
        Customer.id == customer_id, Customer.is_deleted == False
    ).first()
    if not c:
        raise HTTPException(404, "Customer not found")

    # -- ASSIGNED KAM ----------------------------------------------------------
    # Priority: SalesCustomerAssignment ? customers.assigned_to
    assigned_user = None
    assignment = db.query(SalesCustomerAssignment).filter(
        SalesCustomerAssignment.customer_id == customer_id,
        SalesCustomerAssignment.is_active   == True,
    ).first()
    if assignment:
        assigned_user = db.query(User).filter(User.id == assignment.user_id).first()
    elif c.assigned_to:
        assigned_user = db.query(User).filter(User.id == c.assigned_to).first()

    # -- 1. LEADS --------------------------------------------------------------
    all_leads = db.query(Lead).filter(
        Lead.customer_id == customer_id,
        Lead.is_deleted  == False,
    ).order_by(Lead.created_at.desc()).all()
    lead_ids = [int(lead.id) for lead in all_leads if lead.id]
    lead_products = db.query(LeadProduct).filter(LeadProduct.lead_id.in_(lead_ids)).all() if lead_ids else []
    lead_products_by_lead: dict[int, list[LeadProduct]] = defaultdict(list)
    for product in lead_products:
        lead_products_by_lead[int(product.lead_id)].append(product)
    lead_product_ids = [int(product.id) for product in lead_products if product.id]
    lead_oems_by_product: dict[int, list[LeadProductOEM]] = defaultdict(list)
    if lead_product_ids:
        for oem in db.query(LeadProductOEM).filter(LeadProductOEM.lead_product_id.in_(lead_product_ids)).all():
            lead_oems_by_product[int(oem.lead_product_id)].append(oem)

    # Stage breakdown
    lead_by_stage: dict = {}
    for l in all_leads:
        lead_by_stage[l.status] = lead_by_stage.get(l.status, 0) + 1

    lead_converted  = [l for l in all_leads if l.status == "Converted"]
    lead_lost       = [l for l in all_leads if l.status == "Lost"]
    lead_active     = [l for l in all_leads if l.status not in ("Converted", "Lost")]
    lead_opp        = [l for l in all_leads if l.status == "Opportunity Created"]

    lead_pipeline   = float(sum(float(l.est_value or 0) for l in lead_active))
    lead_total_val  = float(sum(float(l.est_value or 0) for l in all_leads))
    lead_conv_val   = float(sum(float(l.est_value or 0) for l in lead_converted))

    conv_times    = [_days(l.lead_created_at or l.created_at, l.converted_at) for l in lead_converted if l.converted_at]
    valid_times   = [t for t in conv_times if t]
    avg_conv_days = round(sum(valid_times) / len(valid_times), 1) if valid_times else None

    # Stale opportunities — 60+ days in Opportunity Created without conversion
    stale_opps = []
    for l in lead_opp:
        opp_since = l.opportunity_created_at or l.created_at
        d = _days(opp_since, today) or 0
        if d > 60:
            stale_opps.append({
                "id":         l.id,
                "ref":        l.lead_ref_id,
                "title":      l.lead_title,
                "value":      float(l.est_value or 0),
                "days_open":  d,
                "status":     l.status,
                "assigned_to": l.assigned_to,
            })

    # Leads NOT converted to tender — requires follow-up
    unconverted_leads = [
        {
            "id":        l.id,
            "ref":       l.lead_ref_id,
            "title":     l.lead_title,
            "status":    l.status,
            "value":     float(l.est_value or 0),
            "created":   _fmt_date(l.created_at),
            "days_open": _days(l.created_at, today) or 0,
            "priority":  l.priority,
        }
        for l in all_leads
        if l.status not in ("Converted", "Lost")
    ]

    # -- 2. TENDERS ------------------------------------------------------------
    all_tenders = db.query(Tender).filter(
        Tender.customer_id == customer_id,
        Tender.is_deleted  == False,
    ).order_by(Tender.created_at.desc()).all()
    tender_ids = [int(tender.id) for tender in all_tenders if tender.id]
    tender_products = db.query(TenderProduct).filter(TenderProduct.tender_id.in_(tender_ids)).all() if tender_ids else []
    tender_products_by_tender: dict[int, list[TenderProduct]] = defaultdict(list)
    tender_final_products_by_tender: dict[int, list[TenderProduct]] = defaultdict(list)
    tender_non_final_products_by_tender: dict[int, list[TenderProduct]] = defaultdict(list)
    for product in tender_products:
        tender_id_key = int(product.tender_id)
        tender_products_by_tender[tender_id_key].append(product)
        if getattr(product, "is_final_boq", False):
            tender_final_products_by_tender[tender_id_key].append(product)
        else:
            tender_non_final_products_by_tender[tender_id_key].append(product)
    tender_product_ids = [int(product.id) for product in tender_products if product.id]
    tender_oems_by_product: dict[int, list[TenderProductOEM]] = defaultdict(list)
    if tender_product_ids:
        for oem in db.query(TenderProductOEM).filter(TenderProductOEM.tender_product_id.in_(tender_product_ids)).all():
            tender_oems_by_product[int(oem.tender_product_id)].append(oem)
    lost_tender_ids = [int(tender.id) for tender in all_tenders if tender.result == "Lost" and tender.id]
    loss_analysis_map = {
        int(loss.tender_id): loss
        for loss in db.query(TenderLossAnalysis).filter(TenderLossAnalysis.tender_id.in_(lost_tender_ids)).all()
        if loss.tender_id
    } if lost_tender_ids else {}

    t_won      = [t for t in all_tenders if t.result == "Won"]
    t_lost     = [t for t in all_tenders if t.result == "Lost"]
    t_pending  = [t for t in all_tenders if t.result == "Pending"]
    t_active   = [t for t in all_tenders if t.tender_status not in ("Closed",)]

    t_won_val  = float(sum(float(t.bid_amount or t.est_value or 0) for t in t_won))
    t_lost_val = float(sum(float(t.bid_amount or t.est_value or 0) for t in t_lost))
    t_pipeline = float(sum(float(t.est_value or 0) for t in t_pending))
    t_total    = float(sum(float(t.est_value or 0) for t in all_tenders))
    win_rate   = round(len(t_won) / (len(t_won) + len(t_lost)) * 100, 1) if (t_won or t_lost) else None

    discounts   = [
        (float(t.est_value) - float(t.bid_amount)) / float(t.est_value) * 100
        for t in all_tenders if t.est_value and t.bid_amount and float(t.est_value) > 0
    ]
    avg_discount = round(sum(discounts) / len(discounts), 1) if discounts else None

    # Status breakdown
    t_by_status: dict = {}
    for t in all_tenders:
        k = t.tender_status or "Unknown"
        t_by_status[k] = t_by_status.get(k, 0) + 1

    # Loss analyses
    loss_analyses = []
    for t in t_lost[:10]:
        la = loss_analysis_map.get(int(t.id)) if t.id else None
        if la:
            loss_analyses.append({
                "tender_id":    t.id,
                "tender_title": t.tender_title,
                "our_bid":      float(la.our_bid_amount or 0),
                "l1_company":   la.l1_company,
                "l1_amount":    float(la.l1_amount or 0),
                "loss_reason":  getattr(la, "loss_reason", "") or "",
                "our_position": la.our_position,
                "result_date":  _fmt_date(t.result_date),
            })

    # -- 3. WORK ORDERS --------------------------------------------------------
    all_wos           = db.query(WorkOrder).filter(WorkOrder.customer_id == customer_id).all()
    wo_ids = [int(wo.id) for wo in all_wos if wo.id]
    wo_line_items = db.query(WOLineItem).filter(WOLineItem.wo_id.in_(wo_ids)).all() if wo_ids else []
    wo_line_items_by_wo: dict[int, list[WOLineItem]] = defaultdict(list)
    for line_item in wo_line_items:
        wo_line_items_by_wo[int(line_item.wo_id)].append(line_item)
    wo_active_list    = [w for w in all_wos if w.status in ("Confirmed", "In Progress", "On Hold")]
    wo_completed_list = [w for w in all_wos if w.status in ("Completed", "Closed")]
    wo_delayed_list   = [
        w for w in all_wos
        if w.delivery_date and w.delivery_date < today
        and w.status not in ("Completed", "Closed", "Cancelled")
    ]

    wo_total_value     = float(sum(float(w.wo_value or 0) for w in all_wos))
    wo_active_value    = float(sum(float(w.wo_value or 0) for w in wo_active_list))
    wo_completed_value = float(sum(float(w.wo_value or 0) for w in wo_completed_list))
    wo_advance_due     = float(sum(
        float(w.advance_amount or 0) for w in all_wos
        if not w.advance_received and (w.advance_amount or 0) > 0
    ))

    # Warranty expiring within 60 days
    warranty_expiring = []
    for w in all_wos:
        if w.warranty_expiry:
            dl = _days(today, w.warranty_expiry) or 999
            if 0 <= dl <= 60:
                warranty_expiring.append({
                    "wo_id":     w.id,
                    "wo_number": w.wo_number,
                    "project":   w.project_title,
                    "expiry":    _fmt_date(w.warranty_expiry),
                    "days_left": dl,
                })

    delayed_wos = [
        {
            "wo_id":     w.id,
            "wo_number": w.wo_number,
            "project":   w.project_title,
            "due":       _fmt_date(w.delivery_date),
            "days_late": _days(w.delivery_date, today) or 0,
            "status":    w.status,
            "value":     float(w.wo_value or 0),
        }
        for w in wo_delayed_list
    ]

    recent_wos = [
        {
            "id":        w.id,
            "wo_number": w.wo_number,
            "project":   w.project_title,
            "status":    w.status,
            "value":     float(w.wo_value or 0),
            "created":   _fmt_date(w.created_at),
            "delivery":  _fmt_date(w.delivery_date),
        }
        for w in sorted(all_wos, key=lambda x: x.created_at or datetime.min, reverse=True)[:5]
    ]

    # -- 4. INVOICES & PAYMENT -------------------------------------------------
    wo_ids       = [w.id for w in all_wos]
    all_invoices = db.query(WOInvoice).filter(WOInvoice.wo_id.in_(wo_ids)).all() if wo_ids else []

    inv_total_billed  = float(sum(float(i.total_amount or 0) for i in all_invoices))
    inv_total_paid    = float(sum(float(i.paid_amount  or 0) for i in all_invoices))
    inv_total_pending = inv_total_billed - inv_total_paid
    inv_overdue       = [
        i for i in all_invoices
        if i.due_date and i.due_date < today and i.payment_status not in ("Paid",)
    ]

    pay_cycles      = [
        _days(i.invoice_date, i.paid_date) for i in all_invoices
        if i.payment_status == "Paid" and i.invoice_date and i.paid_date
    ]
    valid_cycles    = [d for d in pay_cycles if d]
    avg_days_to_pay = round(sum(valid_cycles) / len(valid_cycles), 1) if valid_cycles else None

    overdue_invoices_detail = [
        {
            "invoice_id":     i.id,
            "invoice_number": i.invoice_number,
            "wo_id":          i.wo_id,
            "total_amount":   float(i.total_amount or 0),
            "paid_amount":    float(i.paid_amount  or 0),
            "due_date":       _fmt_date(i.due_date),
            "days_overdue":   _days(i.due_date, today) or 0,
            "payment_status": i.payment_status,
        }
        for i in inv_overdue
    ]

    # 12-month payment trend
    payment_trend = []
    for m in range(11, -1, -1):
        ref       = today.replace(day=1) - timedelta(days=m * 28)
        month_key = ref.strftime("%Y-%m")
        billed    = float(sum(
            float(i.total_amount or 0) for i in all_invoices
            if i.invoice_date and i.invoice_date.strftime("%Y-%m") == month_key
        ))
        paid = float(sum(
            float(i.paid_amount or 0) for i in all_invoices
            if i.paid_date and i.paid_date.strftime("%Y-%m") == month_key
        ))
        payment_trend.append({"month": month_key, "billed": billed, "paid": paid})

    # -- 5. PRODUCTS SUPPLIED (from completed WO line items) -------------------
    # "What we have actually delivered to this customer"
    products_supplied: dict = {}
    for wo in wo_completed_list:
        for li in wo_line_items_by_wo.get(int(wo.id), []):
            pname = (li.product_name or "").strip()
            if not pname:
                continue
            key = pname.lower()
            if key not in products_supplied:
                products_supplied[key] = {
                    "product_name": pname,
                    "product_id":   li.product_id,
                    "qty_supplied":    0,
                    "total_value":     0.0,
                    "wo_count":        0,
                    "oems":            set(),
                    "wo_numbers":      [],
                    "serial_numbers":  [],
                }
            products_supplied[key]["qty_supplied"]   += int(li.quantity or 0)
            products_supplied[key]["total_value"]    += float(li.total_amount or 0)
            products_supplied[key]["wo_count"]       += 1
            products_supplied[key]["wo_numbers"].append(wo.wo_number)
            if li.serial_numbers:
                sn = li.serial_numbers
                if isinstance(sn, list):
                    products_supplied[key]["serial_numbers"].extend(sn)

    # OEM from WO line items — check TenderProduct linked to the WO's tender
    for wo in all_wos:
        if wo.tender_id:
            for tp in tender_final_products_by_tender.get(int(wo.tender_id), []):
                key = (tp.product_name or "").strip().lower()
                if key in products_supplied:
                    if tp.oem_name:
                        products_supplied[key]["oems"].add(tp.oem_name.strip())
                    for o in tender_oems_by_product.get(int(tp.id), []):
                        if o.oem_name:
                            products_supplied[key]["oems"].add(o.oem_name.strip())

    products_supplied_list = [
        {**v, "oems": sorted(v["oems"]), "wo_numbers": list(set(v["wo_numbers"]))}
        for v in products_supplied.values()
    ]
    products_supplied_list.sort(key=lambda x: x["total_value"], reverse=True)

    # -- 6. PRODUCTS DEMANDED (from leads + tenders) ---------------------------
    # Gap analysis: lead products that never progressed to a tender
    product_demand: dict = {}

    # From leads
    for lead in all_leads:
        for lp in lead_products_by_lead.get(int(lead.id), []):
            key = (lp.product_name or "").strip().lower()
            if not key:
                continue
            if key not in product_demand:
                product_demand[key] = {
                    "product_name": (lp.product_name or "").strip(),
                    "product_id":   lp.product_id,
                    "lead_count":   0,
                    "tender_count": 0,
                    "wo_count":     0,
                    "won_count":    0,
                    "oems":         set(),
                    "lead_refs":    [],
                    "tender_refs":  [],
                }
            product_demand[key]["lead_count"] += 1
            if lead.lead_ref_id:
                product_demand[key]["lead_refs"].append(lead.lead_ref_id)
            for oem in lead_oems_by_product.get(int(lp.id), []):
                if oem.oem_name:
                    product_demand[key]["oems"].add(oem.oem_name.strip())

    # From tenders
    for tender in all_tenders:
        for tp in tender_non_final_products_by_tender.get(int(tender.id), []):
            key = (tp.product_name or "").strip().lower()
            if not key:
                continue
            if key not in product_demand:
                product_demand[key] = {
                    "product_name": (tp.product_name or "").strip(),
                    "product_id":   tp.product_id,
                    "lead_count":   0,
                    "tender_count": 0,
                    "wo_count":     0,
                    "won_count":    0,
                    "oems":         set(),
                    "lead_refs":    [],
                    "tender_refs":  [],
                }
            product_demand[key]["tender_count"] += 1
            if tender.result == "Won":
                product_demand[key]["won_count"] += 1
            if tender.portal_ref_number:
                product_demand[key]["tender_refs"].append(tender.portal_ref_number)
            for oem in tender_oems_by_product.get(int(tp.id), []):
                if oem.oem_name:
                    product_demand[key]["oems"].add(oem.oem_name.strip())

    # From work orders
    for wo in all_wos:
        for li in wo_line_items_by_wo.get(int(wo.id), []):
            key = (li.product_name or "").strip().lower()
            if key in product_demand:
                product_demand[key]["wo_count"] += 1

    products_demanded_list = []
    for v in product_demand.values():
        total = v["lead_count"] + v["tender_count"] + v["wo_count"]
        products_demanded_list.append({
            **v,
            "oems":          sorted(v["oems"]),
            "lead_refs":     v["lead_refs"][:5],
            "tender_refs":   v["tender_refs"][:5],
            "total_demand":  total,
            # Gap: appeared in leads but no tender raised yet
            "lead_no_tender": v["lead_count"] > 0 and v["tender_count"] == 0,
            # Conversion rate lead?tender
            "conv_rate": round(v["tender_count"] / v["lead_count"] * 100, 1)
                         if v["lead_count"] > 0 else None,
        })
    products_demanded_list.sort(key=lambda x: x["total_demand"], reverse=True)

    # Leads NOT yet converted to tenders (the gap list the user explicitly asked for)
    leads_no_tender = [
        {
            "id":        l.id,
            "ref":       l.lead_ref_id,
            "title":     l.lead_title,
            "status":    l.status,
            "value":     float(l.est_value or 0),
            "created":   _fmt_date(l.created_at),
            "days_open": _days(l.created_at, today) or 0,
            "priority":  l.priority,
            "assigned_to": l.assigned_to,
        }
        for l in all_leads
        if l.status not in ("Converted", "Lost")
    ]

    # -- 7. KAM ACTIVITIES -----------------------------------------------------
    kam_acts = (
        db.query(KAMActivity)
          .filter(KAMActivity.customer_id == customer_id)
          .order_by(KAMActivity.activity_date.desc())
          .all()
    )
    kam_total     = len(kam_acts)
    kam_completed = sum(1 for a in kam_acts if a.status == "Completed")
    kam_last_date = _fmt_date(kam_acts[0].activity_date) if kam_acts else None
    days_since    = _days(kam_acts[0].activity_date if kam_acts else None, today)

    # Breakdown by type
    kam_by_type: dict = {}
    for a in kam_acts:
        k = a.activity_type or "Other"
        kam_by_type[k] = kam_by_type.get(k, 0) + 1

    # Specific counts the user asked for
    kam_calls    = sum(1 for a in kam_acts if a.activity_type == "Daily Call"  and a.status == "Completed")
    kam_meetings = sum(1 for a in kam_acts if a.activity_type == "Meeting"     and a.status == "Completed")
    kam_demos    = sum(1 for a in kam_acts if a.activity_type == "Demo"        and a.status == "Completed")
    kam_sv       = sum(1 for a in kam_acts if a.activity_type == "Site Visit"  and a.status == "Completed")

    # Overdue follow-up actions
    pending_actions = [
        {
            "activity_id":  a.id,
            "subject":      a.subject,
            "next_action":  getattr(a, "next_action", None),
            "due_date":     _fmt_date(getattr(a, "next_action_date", None)),
            "days_overdue": _days(getattr(a, "next_action_date", None), today),
        }
        for a in kam_acts[:50]
        if getattr(a, "next_action", None)
        and getattr(a, "next_action_date", None)
        and a.next_action_date < today
        and a.status not in ("Completed", "Cancelled")
    ][:10]

    # Tasks
    kam_task_rows = db.query(KAMTaskAssignment).filter(
        KAMTaskAssignment.customer_id == customer_id,
        KAMTaskAssignment.status.in_(["Open", "In Progress"]),
    ).all()
    open_tasks    = len(kam_task_rows)
    overdue_tasks = sum(1 for t in kam_task_rows if t.due_date and t.due_date < today)

    # KAM Work Orders — revenue tracked via KAM
    kam_wos       = db.query(KAMWorkOrder).filter(KAMWorkOrder.customer_id == customer_id).all()
    kam_revenue   = float(sum(float(w.order_value      or 0) for w in kam_wos))
    kam_collected = float(sum(float(w.payment_received or 0) for w in kam_wos))

    recent_kam = [
        {
            "id":      a.id,
            "type":    a.activity_type,
            "subject": a.subject,
            "date":    _fmt_date(a.activity_date),
            "status":  a.status,
            "outcome": getattr(a, "outcome", None),
        }
        for a in kam_acts[:10]
    ]

    # -- 8. EMD / BG -----------------------------------------------------------
    emdbgs       = db.query(EMDBG).filter(EMDBG.customer_id == customer_id).all()
    emdbg_active = [e for e in emdbgs if e.status == "Active"]
    emdbg_expiring = [
        {
            "id":        e.id,
            "ref":       e.reference_num,
            "type":      e.instrument_type,
            "amount":    float(e.amount or 0),
            "expiry":    _fmt_date(e.expiry_date),
            "days_left": _days(today, e.expiry_date),
            "tender_num": e.tender_num,
        }
        for e in emdbg_active
        if e.expiry_date and 0 <= (_days(today, e.expiry_date) or 999) <= 30
    ]
    emdbg_exposure = float(sum(float(e.amount or 0) for e in emdbg_active))

    # -- 9. CONTACTS -----------------------------------------------------------
    c_with   = _attach_addresses(db, c)
    contacts_out = [
        {
            "id":          ct.id,
            "name":        ct.contact_name,
            "designation": ct.designation,
            "department":  ct.department,
            "mobile":      ct.mobile,
            "email":       ct.office_email,
            "phone":       ct.office_phone,
            "is_primary":  ct.is_primary,
        }
        for ct in (getattr(c_with, "contacts", []) or [])
    ]

    # -- 10. SMART FLAGS -------------------------------------------------------
    flags: list = []

    # Critical: Overdue invoices
    if inv_overdue:
        worst = max(overdue_invoices_detail, key=lambda x: x["days_overdue"])
        flags.append({
            "type":     "payment_overdue",
            "severity": "critical",
            "title":    f"{len(inv_overdue)} Overdue Invoice{'s' if len(inv_overdue)>1 else ''}",
            "detail":   f"?{inv_total_pending:,.0f} pending · oldest {worst['days_overdue']}d overdue",
            "action":   "Follow up on payment collection immediately",
        })

    # Critical: BG/EMD expiring
    if emdbg_expiring:
        flags.append({
            "type":     "bg_expiring",
            "severity": "critical",
            "title":    f"{len(emdbg_expiring)} BG/EMD Expiring Within 30 Days",
            "detail":   ", ".join(e["ref"] for e in emdbg_expiring[:3]),
            "action":   "Initiate renewal process immediately",
        })

    # Warning: Slow payer
    if avg_days_to_pay and avg_days_to_pay > 45:
        flags.append({
            "type":     "slow_payer",
            "severity": "warning",
            "title":    f"Slow Payment Cycle — avg {int(avg_days_to_pay)} days",
            "detail":   "Customer consistently pays >45 days after invoice",
            "action":   "Review credit terms or request advance payment",
        })

    # Warning: Stale opportunities
    if stale_opps:
        flags.append({
            "type":     "stale_opportunity",
            "severity": "warning",
            "title":    f"{len(stale_opps)} Stalled Lead{'s' if len(stale_opps)>1 else ''} (>60 days in Opportunity)",
            "detail":   f"?{sum(o['value'] for o in stale_opps):,.0f} at risk",
            "action":   "Push for conversion or re-qualify with the customer",
        })

    # Warning: No recent activity
    if days_since is not None and days_since > 30:
        flags.append({
            "type":     "no_recent_activity",
            "severity": "warning",
            "title":    f"No KAM Activity in {days_since} Days",
            "detail":   f"Last contact: {kam_last_date or 'never'}",
            "action":   "Schedule a call or visit to maintain relationship",
        })

    # Warning: Delayed WOs
    if wo_delayed_list:
        flags.append({
            "type":     "delivery_delayed",
            "severity": "warning",
            "title":    f"{len(wo_delayed_list)} Work Order{'s' if len(wo_delayed_list)>1 else ''} Overdue",
            "detail":   f"Max delay: {max(w['days_late'] for w in delayed_wos)}d",
            "action":   "Update delivery schedule and notify customer",
        })

    # Info: Warranty expiring
    if warranty_expiring:
        flags.append({
            "type":     "warranty_expiring",
            "severity": "info",
            "title":    f"{len(warranty_expiring)} Warranty Expiring Within 60 Days",
            "detail":   ", ".join(w["wo_number"] for w in warranty_expiring[:3]),
            "action":   "Proactively offer AMC or renewal contract",
        })

    # Info: Low win rate
    if win_rate is not None and win_rate < 30 and (len(t_won) + len(t_lost)) >= 3:
        flags.append({
            "type":     "low_win_rate",
            "severity": "info",
            "title":    f"Low Tender Win Rate — {win_rate}%",
            "detail":   f"{len(t_won)} won / {len(t_won)+len(t_lost)} decided",
            "action":   "Review pricing strategy and loss analysis",
        })

    # Info: Products demanded but no tender (gap leads)
    gap_products = [p for p in products_demanded_list if p["lead_no_tender"] and p["lead_count"] >= 2]
    if gap_products:
        flags.append({
            "type":     "product_no_tender",
            "severity": "info",
            "title":    f"{len(gap_products)} Products in Leads Never Progressing to Tender",
            "detail":   ", ".join(p["product_name"] for p in gap_products[:3]),
            "action":   "Investigate why these products aren't reaching the tender stage",
        })

    # Info: Overdue follow-ups
    if pending_actions:
        flags.append({
            "type":     "overdue_followups",
            "severity": "warning",
            "title":    f"{len(pending_actions)} Overdue Follow-Up Action{'s' if len(pending_actions)>1 else ''}",
            "detail":   f"Oldest: {max(a['days_overdue'] or 0 for a in pending_actions)}d overdue",
            "action":   "Complete or reschedule overdue KAM follow-ups",
        })

    # Sort: critical ? warning ? info
    sev_order = {"critical": 0, "warning": 1, "info": 2}
    flags.sort(key=lambda f: sev_order.get(f["severity"], 9))

    # -- ASSEMBLE RESPONSE -----------------------------------------------------
    return {
        # -- Customer profile --------------------------------------------------
        "customer": {
            "id":                c.id,
            "name":              c.customer_name,
            "vertical":          _normalize_customer_vertical(c.customer_vertical),
            "division":          c.division,
            "group_name":        c.group_name,
            "account_status":    c.account_status,
            "account_potential": c.account_potential,
            "potential_value":   float(c.potential_value or 0),
            "billing_city":      c.billing_city,
            "billing_state":     c.billing_state,
            "gst_number":        c.gst_number,
            "pan_number":        c.pan_number,
            "website":           c.website,
            "remarks":           c.remarks,
        },

        # -- Assigned KAM user -------------------------------------------------
        "assigned_kam": {
            "user_id":   assigned_user.id        if assigned_user else None,
            "user_name": assigned_user.full_name  if assigned_user else None,
            "role":      assigned_user.role       if assigned_user else None,
            "email":     assigned_user.email      if assigned_user else None,
            "phone":     assigned_user.phone      if assigned_user else None,
        },

        # -- Flags -------------------------------------------------------------
        "flags": flags,
        "flag_count": {
            "critical": sum(1 for f in flags if f["severity"] == "critical"),
            "warning":  sum(1 for f in flags if f["severity"] == "warning"),
            "info":     sum(1 for f in flags if f["severity"] == "info"),
        },

        # -- Lead summary ------------------------------------------------------
        "lead_summary": {
            "total":            len(all_leads),
            "active":           len(lead_active),
            "converted":        len(lead_converted),
            "lost":             len(lead_lost),
            "pipeline_value":   lead_pipeline,
            "total_value":      lead_total_val,
            "converted_value":  lead_conv_val,
            "avg_conv_days":    avg_conv_days,
            "by_stage":         lead_by_stage,
            "stale_opps":       stale_opps,
            # Leads not converted to tender — key gap list
            "unconverted_leads": leads_no_tender,
            "recent": [
                {
                    "id":      l.id,
                    "ref":     l.lead_ref_id,
                    "title":   l.lead_title,
                    "status":  l.status,
                    "value":   float(l.est_value or 0),
                    "created": _fmt_date(l.created_at),
                    "priority": l.priority,
                }
                for l in all_leads[:5]
            ],
        },

        # -- Tender summary ----------------------------------------------------
        "tender_summary": {
            "total":          len(all_tenders),
            "won":            len(t_won),
            "lost":           len(t_lost),
            "pending":        len(t_pending),
            "active":         len(t_active),
            "win_rate":       win_rate,
            "total_value":    t_total,
            "won_value":      t_won_val,
            "lost_value":     t_lost_val,
            "pipeline":       t_pipeline,
            "avg_discount":   avg_discount,
            "by_status":      t_by_status,
            "loss_analyses":  loss_analyses,
            "recent": [
                {
                    "id":         t.id,
                    "ref":        t.portal_ref_number,
                    "title":      t.tender_title,
                    "status":     t.tender_status,
                    "result":     t.result,
                    "est_value":  float(t.est_value or 0),
                    "bid_amount": float(t.bid_amount or 0) if t.bid_amount else None,
                    "submission": _fmt_date(t.submission_date),
                }
                for t in all_tenders[:5]
            ],
        },

        # -- Work order summary ------------------------------------------------
        "workorder_summary": {
            "total":             len(all_wos),
            "active":            len(wo_active_list),
            "completed":         len(wo_completed_list),
            "delayed":           len(wo_delayed_list),
            "total_value":       wo_total_value,
            "active_value":      wo_active_value,
            "completed_value":   wo_completed_value,
            "advance_due":       wo_advance_due,
            "delayed_wos":       delayed_wos,
            "warranty_expiring": warranty_expiring,
            "recent":            recent_wos,
        },

        # -- Payment summary ---------------------------------------------------
        "payment_summary": {
            "total_billed":     inv_total_billed,
            "total_paid":       inv_total_paid,
            "total_pending":    inv_total_pending,
            "collection_rate":  round(inv_total_paid / inv_total_billed * 100, 1)
                                if inv_total_billed > 0 else None,
            "avg_days_to_pay":  avg_days_to_pay,
            "overdue_count":    len(inv_overdue),
            "overdue_amount":   float(sum(
                (float(i.total_amount or 0) - float(i.paid_amount or 0))
                for i in inv_overdue
            )),
            "overdue_invoices": overdue_invoices_detail,
            "monthly_trend":    payment_trend,
        },

        # -- Products SUPPLIED (delivered via WOs) -----------------------------
        "products_supplied": products_supplied_list[:20],

        # -- Products DEMANDED (from leads/tenders) + gap analysis -------------
        "products_demanded": products_demanded_list[:20],

        # -- KAM summary -------------------------------------------------------
        "kam_summary": {
            "total_activities": kam_total,
            "completed":        kam_completed,
            "last_activity":    kam_last_date,
            "days_since":       days_since,
            "by_type":          kam_by_type,
            # Specific counts
            "calls":            kam_calls,
            "meetings":         kam_meetings,
            "demos":            kam_demos,
            "site_visits":      kam_sv,
            "open_tasks":       open_tasks,
            "overdue_tasks":    overdue_tasks,
            "pending_actions":  pending_actions,
            "recent":           recent_kam,
            "revenue_tracked":  kam_revenue,
            "collected":        kam_collected,
            "uncollected":      max(0.0, kam_revenue - kam_collected),
        },

        # -- EMD / BG summary -------------------------------------------------
        "emdbg_summary": {
            "total":          len(emdbgs),
            "active":         len(emdbg_active),
            "expiring_soon":  emdbg_expiring,
            "total_exposure": emdbg_exposure,
            "by_type": {
                k: sum(1 for e in emdbg_active if e.instrument_type == k)
                for k in {e.instrument_type for e in emdbgs}
            },
        },

        # -- Contacts ----------------------------------------------------------
        "contacts": contacts_out,
    }

