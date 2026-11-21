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
from sqlalchemy import func, and_, or_, false, text as sa_text
import re
from pydantic import BaseModel, Field, field_validator, model_validator
from app.core import validators as V
from typing import Any, Dict, List, Optional
from app.dependencies import get_tenant_db, get_current_user, require_manager_or_above, require_permission, get_request_ip
from app.models.user import User
from app.models.customer import Customer, CustomerContact
from app.models.all_models import (
    CustomerBillingConsignee, CustomerBillingZone,
    CustomerShippingConsignee, CustomerShippingZone,
    # 360 models
    Lead, LeadProduct, LeadProductOEM, LeadSource,
    Quotation,
    Tender, TenderProduct, TenderProductOEM, TenderLossAnalysis,
    WorkOrder, WOInvoice, WOLineItem,
    KAMActivity, KAMWorkOrder, KAMTaskAssignment,
    EMDBG,
    SalesCustomerAssignment,
    ApprovalRequest,
    UserReportingHierarchy,
    Group, Role, Permission, RolePermission, OrgTreeNode,
    VerticalSector, ProductMaster,
)
from app.core.logging import log_module_action, model_snapshot
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
KAM_ACTIVITY_TYPE_COUNT_FIELDS = {
    "Phone Call": "call_count",
    "Video Call": "video_call_count",
    "Email": "email_count",
    "In Person Meet": "meeting_count",
    "Demo": "demo_count",
    "Follow Up": "follow_up_count",
    "Site Visit": "site_visit_count",
}


def _normalize_kam_activity_type(activity_type: Any, mode: Any = None) -> str:
    raw = str(activity_type or "").strip().casefold().replace("_", " ").replace("-", " ")
    channel = str(mode or "").strip().casefold().replace("_", " ").replace("-", " ")

    if raw == "daily call" and "video" in channel:
        return "Video Call"

    for source in (raw, channel):
        if not source:
            continue
        if "follow" in source:
            return "Follow Up"
        if "video" in source and ("call" in source or source == "video"):
            return "Video Call"
        if "email" in source or source == "mail":
            return "Email"
        if "demo" in source or "presentation" in source:
            return "Demo"
        if "site" in source or "visit" in source:
            return "Site Visit"
        if "meet" in source or "in person" in source:
            return "In Person Meet"
        if "phone" in source or "call" in source:
            return "Phone Call"

    return "Other"


def _normalize_pincode(v: Optional[str]) -> Optional[str]:
    return V.check_pincode(v)
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
        raise V.field_error(field_name, f'{label} "{existing_value}" already exists. Please use a different {label.lower()}.', 409)



def _ensure_unique_gstin(db: Session, data: Any, customer_id: Optional[int] = None) -> None:
    """GSTIN is unique across customers, except inside one account family (head office / branches share it)."""
    gst = (getattr(data, "gst_number", None) or "").strip()
    if not gst:
        return
    dup = _find_duplicate_customer_field(db, "gst_number", gst, exclude_customer_id=customer_id)
    if not dup:
        return
    parent = getattr(data, "parent_account_id", None)
    family = {x for x in (parent, customer_id) if x}
    if dup.id in family or (dup.parent_account_id and dup.parent_account_id in family):
        return
    raise V.field_error("gst_number", f'GSTIN {gst.upper()} is already used by "{dup.customer_name}".', 409)


def _validate_customer_custom(db: Session, data: Any) -> None:
    if "custom_data" not in data.model_fields_set or data.custom_data is None:
        return
    cd, errs = dict(data.custom_data), {}
    # the customer form keeps the account email / phone in custom_data
    for key, fn in (("email", V.check_email), ("phone", V.check_mobile)):
        if key in cd:
            try:
                cd[key] = fn(cd[key])
                if cd[key] is None:
                    cd.pop(key)
            except ValueError as e:
                errs[f"custom_data.{key}"] = str(e)
    V.raise_field_errors(errs)
    data.custom_data = V.validate_module_custom_data(db, "customers", cd)


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
        module_key="customers",
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
            ApprovalRequest.module_key == "customers",
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


def _load_customer_pipeline_values(db: Session, customer_ids: list[int]) -> dict[int, dict[str, Any]]:
    today = today_ist()
    values: dict[int, dict[str, Any]] = {
        customer_id: {
            "lead_count": 0,
            "lead_value": 0.0,
            "opportunity_count": 0,
            "opportunity_value": 0.0,
            "lost_opportunity_count": 0,
            "quotation_count": 0,
            "quotation_value": 0.0,
            "pending_quotation_count": 0,
            "tender_value": 0.0,
            "tender_count": 0,
            "won_value": 0.0,
            "won_tender_count": 0,
            "lost_tender_count": 0,
            "work_order_count": 0,
            "work_order_value": 0.0,
            "collected_count": 0,
            "collected_value": 0.0,
            "completed_wo_count": 0,
            "delayed_wo_count": 0,
            "ci_customer_created_today": 0,
            "ci_lead_count": 0,
            "ci_lead_value": 0.0,
            "ci_opportunity_count": 0,
            "ci_opportunity_value": 0.0,
            "ci_submitted_tender_count": 0,
            "ci_submitted_tender_value": 0.0,
            "ci_live_work_order_count": 0,
            "ci_live_work_order_value": 0.0,
            "ci_revenue_value": 0.0,
        }
        for customer_id in customer_ids
    }

    today_customer_rows = (
        db.query(Customer.id)
        .filter(
            Customer.id.in_(customer_ids),
            Customer.is_deleted == False,
            func.date(Customer.created_at) == today,
        )
        .all()
    )
    for (customer_id,) in today_customer_rows:
        values.setdefault(int(customer_id), {})["ci_customer_created_today"] = 1

    lead_rows = (
        db.query(Lead.customer_id, func.count(Lead.id), func.sum(Lead.est_value))
        .filter(
            Lead.customer_id.in_(customer_ids),
            Lead.is_deleted == False,
            or_(Lead.lead_type != "direct_opportunity", Lead.lead_type.is_(None)),
            Lead.status.in_(["Assigned", "Contacted", "Qualified", "Proposal Pending", "Nurturing"]),
        )
        .group_by(Lead.customer_id)
        .all()
    )
    for customer_id, count, total in lead_rows:
        if customer_id is not None:
            bucket = values.setdefault(int(customer_id), {})
            bucket["lead_count"] = int(count or 0)
            bucket["lead_value"] = float(total or 0)

    ci_lead_rows = (
        db.query(Lead.customer_id, func.count(Lead.id), func.sum(Lead.est_value))
        .filter(
            Lead.customer_id.in_(customer_ids),
            Lead.is_deleted == False,
            or_(Lead.lead_type != "direct_opportunity", Lead.lead_type.is_(None)),
            Lead.status.in_(["Assigned", "Contacted", "Qualified", "Proposal Pending", "Nurturing"]),
        )
        .group_by(Lead.customer_id)
        .all()
    )
    for customer_id, count, total in ci_lead_rows:
        if customer_id is not None:
            bucket = values.setdefault(int(customer_id), {})
            bucket["ci_lead_count"] = int(count or 0)
            bucket["ci_lead_value"] = float(total or 0)

    opportunity_rows = (
        db.query(Lead.customer_id, func.count(Lead.id), func.sum(Lead.est_value))
        .filter(
            Lead.customer_id.in_(customer_ids),
            Lead.is_deleted == False,
            or_(
                Lead.status == "Opportunity Created",
                Lead.lead_type == "direct_opportunity",
                Lead.conversion_target == "quotation",
            ),
        )
        .group_by(Lead.customer_id)
        .all()
    )
    for customer_id, count, total in opportunity_rows:
        if customer_id is not None:
            bucket = values.setdefault(int(customer_id), {})
            bucket["opportunity_count"] = int(count or 0)
            bucket["opportunity_value"] = float(total or 0)

    ci_opportunity_rows = (
        db.query(Lead.customer_id, func.count(Lead.id), func.sum(Lead.est_value))
        .filter(
            Lead.customer_id.in_(customer_ids),
            Lead.is_deleted == False,
            or_(
                Lead.status.in_(["Opportunity Created", "Converted"]),
                Lead.lead_type == "direct_opportunity",
                Lead.conversion_target.in_(["quotation", "tender"]),
            ),
        )
        .group_by(Lead.customer_id)
        .all()
    )
    for customer_id, count, total in ci_opportunity_rows:
        if customer_id is not None:
            bucket = values.setdefault(int(customer_id), {})
            bucket["ci_opportunity_count"] = int(count or 0)
            bucket["ci_opportunity_value"] = float(total or 0)

    lost_opportunity_rows = (
        db.query(Lead.customer_id, func.count(Lead.id))
        .filter(
            Lead.customer_id.in_(customer_ids),
            Lead.is_deleted == False,
            Lead.status == "Lost",
        )
        .group_by(Lead.customer_id)
        .all()
    )
    for customer_id, count in lost_opportunity_rows:
        if customer_id is not None:
            values.setdefault(int(customer_id), {})["lost_opportunity_count"] = int(count or 0)

    quotation_rows = (
        db.query(Quotation.customer_id, func.count(Quotation.id), func.sum(Quotation.total_amount))
        .filter(Quotation.customer_id.in_(customer_ids))
        .group_by(Quotation.customer_id)
        .all()
    )
    for customer_id, count, total in quotation_rows:
        if customer_id is not None:
            bucket = values.setdefault(int(customer_id), {})
            bucket["quotation_count"] = int(count or 0)
            bucket["quotation_value"] = float(total or 0)

    pending_quotation_rows = (
        db.query(Quotation.customer_id, func.count(Quotation.id))
        .filter(
            Quotation.customer_id.in_(customer_ids),
            Quotation.status.in_(["Draft", "Sent", "Approved"]),
        )
        .group_by(Quotation.customer_id)
        .all()
    )
    for customer_id, count in pending_quotation_rows:
        if customer_id is not None:
            values.setdefault(int(customer_id), {})["pending_quotation_count"] = int(count or 0)

    tender_rows = (
        db.query(Tender.customer_id, func.count(Tender.id), func.sum(Tender.est_value))
        .filter(
            Tender.customer_id.in_(customer_ids),
            Tender.is_deleted == False,
        )
        .group_by(Tender.customer_id)
        .all()
    )
    for customer_id, count, total in tender_rows:
        if customer_id is not None:
            bucket = values.setdefault(int(customer_id), {})
            bucket["tender_count"] = int(count or 0)
            bucket["tender_value"] = float(total or 0)

    ci_submitted_tender_rows = (
        db.query(Tender.customer_id, func.count(Tender.id), func.sum(Tender.est_value))
        .filter(
            Tender.customer_id.in_(customer_ids),
            Tender.is_deleted == False,
            Tender.tender_status == "Submitted",
        )
        .group_by(Tender.customer_id)
        .all()
    )
    for customer_id, count, total in ci_submitted_tender_rows:
        if customer_id is not None:
            bucket = values.setdefault(int(customer_id), {})
            bucket["ci_submitted_tender_count"] = int(count or 0)
            bucket["ci_submitted_tender_value"] = float(total or 0)

    won_rows = (
        db.query(Tender.customer_id, func.count(Tender.id), func.sum(func.coalesce(Tender.bid_amount, Tender.est_value, 0)))
        .filter(
            Tender.customer_id.in_(customer_ids),
            Tender.is_deleted == False,
            Tender.result == "Won",
        )
        .group_by(Tender.customer_id)
        .all()
    )
    for customer_id, count, total in won_rows:
        if customer_id is not None:
            bucket = values.setdefault(int(customer_id), {})
            bucket["won_tender_count"] = int(count or 0)
            bucket["won_value"] = float(total or 0)

    lost_tender_rows = (
        db.query(Tender.customer_id, func.count(Tender.id))
        .filter(
            Tender.customer_id.in_(customer_ids),
            Tender.is_deleted == False,
            Tender.result == "Lost",
        )
        .group_by(Tender.customer_id)
        .all()
    )
    for customer_id, count in lost_tender_rows:
        if customer_id is not None:
            values.setdefault(int(customer_id), {})["lost_tender_count"] = int(count or 0)

    work_order_rows = (
        db.query(WorkOrder.customer_id, func.count(WorkOrder.id), func.sum(WorkOrder.wo_value))
        .filter(WorkOrder.customer_id.in_(customer_ids))
        .group_by(WorkOrder.customer_id)
        .all()
    )
    for customer_id, count, total in work_order_rows:
        if customer_id is not None:
            bucket = values.setdefault(int(customer_id), {})
            bucket["work_order_count"] = int(count or 0)
            bucket["work_order_value"] = float(total or 0)

    ci_live_work_order_rows = (
        db.query(WorkOrder.customer_id, func.count(WorkOrder.id), func.sum(WorkOrder.wo_value))
        .filter(
            WorkOrder.customer_id.in_(customer_ids),
            WorkOrder.status.in_(["Confirmed", "In Progress", "On Hold", "Delayed", "Won"]),
        )
        .group_by(WorkOrder.customer_id)
        .all()
    )
    for customer_id, count, total in ci_live_work_order_rows:
        if customer_id is not None:
            bucket = values.setdefault(int(customer_id), {})
            bucket["ci_live_work_order_count"] = int(count or 0)
            bucket["ci_live_work_order_value"] = float(total or 0)

    ci_revenue_rows = (
        db.query(WorkOrder.customer_id, func.sum(WorkOrder.wo_value))
        .filter(
            WorkOrder.customer_id.in_(customer_ids),
            WorkOrder.status.in_(["Completed", "Closed"]),
        )
        .group_by(WorkOrder.customer_id)
        .all()
    )
    for customer_id, total in ci_revenue_rows:
        if customer_id is not None:
            values.setdefault(int(customer_id), {})["ci_revenue_value"] = float(total or 0)

    # collected = customer receipts acknowledged by Finance (Orders & Projects → Collections & finance)
    from app.models.commitments import OrderPaymentReceipt
    try:
        collected_rows = (
            db.query(WorkOrder.customer_id, func.count(OrderPaymentReceipt.id), func.sum(OrderPaymentReceipt.amount))
            .join(WorkOrder, OrderPaymentReceipt.wo_id == WorkOrder.id)
            .filter(
                WorkOrder.customer_id.in_(customer_ids),
                OrderPaymentReceipt.status == "Acknowledged",
            )
            .group_by(WorkOrder.customer_id)
            .all()
        )
    except Exception:
        db.rollback()
        collected_rows = []
    for customer_id, count, total in collected_rows:
        if customer_id is not None:
            bucket = values.setdefault(int(customer_id), {})
            bucket["collected_count"] = int(count or 0)
            bucket["collected_value"] = float(total or 0)

    completed_work_order_rows = (
        db.query(WorkOrder.customer_id, func.count(WorkOrder.id))
        .filter(
            WorkOrder.customer_id.in_(customer_ids),
            WorkOrder.status.in_(["Completed", "Closed"]),
        )
        .group_by(WorkOrder.customer_id)
        .all()
    )
    for customer_id, count in completed_work_order_rows:
        if customer_id is not None:
            values.setdefault(int(customer_id), {})["completed_wo_count"] = int(count or 0)

    delayed_work_order_rows = (
        db.query(WorkOrder.customer_id, func.count(WorkOrder.id))
        .filter(
            WorkOrder.customer_id.in_(customer_ids),
            WorkOrder.delivery_date.isnot(None),
            WorkOrder.delivery_date < today,
            WorkOrder.status.notin_(["Completed", "Closed", "Cancelled"]),
        )
        .group_by(WorkOrder.customer_id)
        .all()
    )
    for customer_id, count in delayed_work_order_rows:
        if customer_id is not None:
            values.setdefault(int(customer_id), {})["delayed_wo_count"] = int(count or 0)

    return values


def _load_customer_overview_rollups(db: Session, customer_ids: list[int]) -> dict[int, dict[str, Any]]:
    today = today_ist()
    rollups: dict[int, dict[str, Any]] = {
        customer_id: {
            "kam_activity_count": 0,
            "kam_contacted_count": 0,
            "upcoming_activity_count": 0,
            "completed_activity_count": 0,
            "overdue_activity_count": 0,
            "call_count": 0,
            "video_call_count": 0,
            "email_count": 0,
            "meeting_count": 0,
            "demo_count": 0,
            "follow_up_count": 0,
            "site_visit_count": 0,
            "products_demanded": {},
            "products_supplied": {},
        }
        for customer_id in customer_ids
    }

    activities = (
        db.query(KAMActivity, Lead.customer_id.label("lead_customer_id"))
        .outerjoin(Lead, KAMActivity.lead_id == Lead.id)
        .filter(
            or_(
                KAMActivity.customer_id.in_(customer_ids),
                Lead.customer_id.in_(customer_ids),
            )
        )
        .all()
    )
    for activity, lead_customer_id in activities:
        customer_id = activity.customer_id or lead_customer_id
        if customer_id is None:
            continue
        bucket = rollups.setdefault(int(customer_id), {})
        bucket["kam_activity_count"] = int(bucket.get("kam_activity_count") or 0) + 1
        bucket["kam_contacted_count"] = 1
        status = str(activity.status or "").strip().lower()
        activity_date = activity.activity_date
        next_date = activity.next_action_date
        if status == "completed":
            bucket["completed_activity_count"] = int(bucket.get("completed_activity_count") or 0) + 1
        elif status not in {"cancelled", "canceled"}:
            if (activity_date and activity_date < today) or (next_date and next_date < today):
                bucket["overdue_activity_count"] = int(bucket.get("overdue_activity_count") or 0) + 1
            else:
                bucket["upcoming_activity_count"] = int(bucket.get("upcoming_activity_count") or 0) + 1

        count_field = KAM_ACTIVITY_TYPE_COUNT_FIELDS.get(
            _normalize_kam_activity_type(activity.activity_type, activity.mode)
        )
        if count_field:
            bucket[count_field] = int(bucket.get(count_field) or 0) + 1

    def add_product(customer_id: Any, bucket_key: str, product_name: Any, value: Any, record_key: str, *, oems: Optional[list[Any]] = None, quantity: Any = 0) -> None:
        if customer_id is None:
            return
        label = _clean_product_label(product_name)
        if not label:
            return
        customer_bucket = rollups.setdefault(int(customer_id), {})
        products = customer_bucket.setdefault(bucket_key, {})
        key = _product_rollup_key(label)
        current = products.setdefault(
            key,
            {
                "product_name": label,
                "customer_count": 1,
                "record_count": 0,
                "total_value": 0.0,
                "qty_supplied": 0.0,
                "oems": set(),
            },
        )
        current["record_count"] = int(current.get("record_count") or 0) + 1
        current["total_value"] = float(current.get("total_value") or 0) + float(value or 0)
        current["qty_supplied"] = float(current.get("qty_supplied") or 0) + float(quantity or 0)
        current["oems"].update(_unique_clean_texts(oems or []))
        current[record_key] = int(current.get(record_key) or 0) + 1

    lead_product_name = func.coalesce(func.nullif(func.trim(LeadProduct.product_name), ""), ProductMaster.name)
    tender_product_name = func.coalesce(func.nullif(func.trim(TenderProduct.product_name), ""), ProductMaster.name)
    wo_product_name = func.coalesce(func.nullif(func.trim(WOLineItem.product_name), ""), ProductMaster.name)

    lead_product_rows = (
        db.query(
            Lead.customer_id,
            lead_product_name,
            func.coalesce(
                func.nullif(func.coalesce(LeadProduct.quantity, 0) * func.coalesce(LeadProduct.unit_price, 0), 0),
                Lead.est_value,
                0,
            ),
        )
        .select_from(LeadProduct)
        .join(Lead, LeadProduct.lead_id == Lead.id)
        .outerjoin(ProductMaster, LeadProduct.product_id == ProductMaster.id)
        .filter(
            Lead.customer_id.in_(customer_ids),
            Lead.is_deleted == False,
        )
        .all()
    )
    for customer_id, product_name, value in lead_product_rows:
        add_product(customer_id, "products_demanded", product_name, value, "lead_count")

    tender_product_rows = (
        db.query(
            Tender.customer_id,
            tender_product_name,
            func.coalesce(
                TenderProduct.total_price,
                func.nullif(func.coalesce(TenderProduct.quantity, 0) * func.coalesce(TenderProduct.unit_price, 0), 0),
                Tender.est_value,
                Tender.bid_amount,
                0,
            ),
        )
        .select_from(TenderProduct)
        .join(Tender, TenderProduct.tender_id == Tender.id)
        .outerjoin(ProductMaster, TenderProduct.product_id == ProductMaster.id)
        .filter(
            Tender.customer_id.in_(customer_ids),
            Tender.is_deleted == False,
        )
        .all()
    )
    for customer_id, product_name, value in tender_product_rows:
        add_product(customer_id, "products_demanded", product_name, value, "tender_count")

    work_order_customer_id = func.coalesce(WorkOrder.customer_id, Lead.customer_id, Tender.customer_id)
    supplied_product_rows = (
        db.query(
            work_order_customer_id,
            WorkOrder.tender_id,
            WorkOrder.lead_id,
            wo_product_name,
            WOLineItem.quantity,
            WOLineItem.delivered_qty,
            func.coalesce(
                WOLineItem.total_amount,
                func.nullif(func.coalesce(WOLineItem.quantity, 0) * func.coalesce(WOLineItem.unit_price, 0), 0),
                WorkOrder.wo_value,
                0,
            ),
        )
        .select_from(WOLineItem)
        .join(WorkOrder, WOLineItem.wo_id == WorkOrder.id)
        .outerjoin(Lead, WorkOrder.lead_id == Lead.id)
        .outerjoin(Tender, WorkOrder.tender_id == Tender.id)
        .outerjoin(ProductMaster, WOLineItem.product_id == ProductMaster.id)
        .filter(
            work_order_customer_id.in_(customer_ids),
            WorkOrder.status.notin_(["Cancelled", "Lost"]),
        )
        .all()
    )
    supplied_line_sources: set[tuple[str, int, str]] = set()
    for customer_id, tender_id, lead_id, product_name, quantity, delivered_qty, value in supplied_product_rows:
        product_source_key = _product_rollup_key(product_name)
        if product_source_key:
            if tender_id:
                supplied_line_sources.add(("tender", int(tender_id), product_source_key))
            if lead_id:
                supplied_line_sources.add(("lead", int(lead_id), product_source_key))
        add_product(customer_id, "products_supplied", product_name, value, "wo_count", quantity=delivered_qty or quantity)

    won_tender_rows = (
        db.query(Tender)
        .filter(
            Tender.customer_id.in_(customer_ids),
            Tender.is_deleted == False,
            Tender.result == "Won",
        )
        .all()
    )
    won_tender_ids = [int(tender.id) for tender in won_tender_rows if tender.id]
    won_tenders_by_id = {int(tender.id): tender for tender in won_tender_rows if tender.id}
    work_orders_by_tender: dict[int, WorkOrder] = {}
    if won_tender_ids:
        for work_order in (
            db.query(WorkOrder)
            .filter(WorkOrder.tender_id.in_(won_tender_ids))
            .order_by(WorkOrder.updated_at.desc(), WorkOrder.created_at.desc())
            .all()
        ):
            if work_order.tender_id and int(work_order.tender_id) not in work_orders_by_tender:
                work_orders_by_tender[int(work_order.tender_id)] = work_order

    final_boq_products = (
        db.query(TenderProduct)
        .filter(
            TenderProduct.tender_id.in_(won_tender_ids),
            TenderProduct.is_final_boq == True,
        )
        .order_by(TenderProduct.tender_id.asc(), TenderProduct.sort_order.asc(), TenderProduct.id.asc())
        .all()
        if won_tender_ids else []
    )
    final_boq_ids = [int(product.id) for product in final_boq_products if product.id]
    final_boq_oems_by_product: dict[int, list[TenderProductOEM]] = defaultdict(list)
    if final_boq_ids:
        for oem in db.query(TenderProductOEM).filter(TenderProductOEM.tender_product_id.in_(final_boq_ids)).all():
            final_boq_oems_by_product[int(oem.tender_product_id)].append(oem)
    final_boq_master_ids = {
        int(product.product_id)
        for product in final_boq_products
        if product.product_id
    }
    final_boq_product_names_by_id = {
        int(product_id): name
        for product_id, name in db.query(ProductMaster.id, ProductMaster.name).filter(ProductMaster.id.in_(final_boq_master_ids)).all()
    } if final_boq_master_ids else {}
    for product in final_boq_products:
        tender_id = int(product.tender_id)
        tender = won_tenders_by_id.get(tender_id)
        if not tender:
            continue
        work_order = work_orders_by_tender.get(tender_id)
        if work_order and not _is_supplied_work_order_status(work_order.status):
            continue
        product_name = _tender_product_label(product, final_boq_product_names_by_id)
        product_source_key = _product_rollup_key(product_name)
        if not product_source_key or ("tender", tender_id, product_source_key) in supplied_line_sources:
            continue
        add_product(
            tender.customer_id,
            "products_supplied",
            product_name,
            _tender_product_total(product),
            "wo_count",
            oems=_tender_product_oem_names(product, final_boq_oems_by_product),
            quantity=_tender_product_quantity(product),
        )

    direct_work_order_rows = (
        db.query(WorkOrder, Lead)
        .join(Lead, WorkOrder.lead_id == Lead.id)
        .filter(
            Lead.customer_id.in_(customer_ids),
            Lead.is_deleted == False,
            WorkOrder.status.notin_(["Cancelled", "Lost"]),
        )
        .all()
    )
    direct_work_orders_by_lead: dict[int, WorkOrder] = {}
    direct_lead_customer_ids: dict[int, int] = {}
    for work_order, lead in direct_work_order_rows:
        if not work_order.lead_id:
            continue
        lead_id_key = int(work_order.lead_id)
        direct_work_orders_by_lead.setdefault(lead_id_key, work_order)
        if lead.customer_id:
            direct_lead_customer_ids[lead_id_key] = int(lead.customer_id)
    direct_lead_ids = list(direct_work_orders_by_lead.keys())
    direct_lead_products = (
        db.query(LeadProduct)
        .filter(LeadProduct.lead_id.in_(direct_lead_ids))
        .order_by(LeadProduct.lead_id.asc(), LeadProduct.id.asc())
        .all()
        if direct_lead_ids else []
    )
    direct_lead_product_ids = [int(product.id) for product in direct_lead_products if product.id]
    direct_lead_oems_by_product: dict[int, list[LeadProductOEM]] = defaultdict(list)
    if direct_lead_product_ids:
        for oem in db.query(LeadProductOEM).filter(LeadProductOEM.lead_product_id.in_(direct_lead_product_ids)).all():
            direct_lead_oems_by_product[int(oem.lead_product_id)].append(oem)
    direct_master_ids = {int(product.product_id) for product in direct_lead_products if product.product_id}
    direct_product_names_by_id = {
        int(product_id): name
        for product_id, name in db.query(ProductMaster.id, ProductMaster.name).filter(ProductMaster.id.in_(direct_master_ids)).all()
    } if direct_master_ids else {}
    for product in direct_lead_products:
        lead_id = int(product.lead_id)
        product_name = _clean_product_label(product.product_name)
        if not product_name and product.product_id:
            product_name = direct_product_names_by_id.get(int(product.product_id), "")
        product_source_key = _product_rollup_key(product_name)
        if not product_source_key or ("lead", lead_id, product_source_key) in supplied_line_sources:
            continue
        work_order = direct_work_orders_by_lead.get(lead_id)
        if not work_order:
            continue
        quantity = _safe_float(product.quantity)
        value = quantity * _safe_float(product.unit_price) if quantity and _safe_float(product.unit_price) else _safe_float(work_order.wo_value or work_order.po_value)
        add_product(
            work_order.customer_id or direct_lead_customer_ids.get(lead_id),
            "products_supplied",
            product_name,
            value,
            "wo_count",
            oems=[oem.oem_name for oem in direct_lead_oems_by_product.get(int(product.id), [])],
            quantity=quantity,
        )

    for bucket in rollups.values():
        bucket["products_demanded"] = list(bucket.get("products_demanded", {}).values())
        bucket["products_supplied"] = list(bucket.get("products_supplied", {}).values())
        for product in bucket["products_demanded"]:
            product["oems"] = sorted(product.get("oems") or [])
        for product in bucket["products_supplied"]:
            product["oems"] = sorted(product.get("oems") or [])

    return rollups


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
    overview_rollups_by_customer = _load_customer_overview_rollups(db, customer_ids)
    latest_activity_by_customer: dict[int, KAMActivity] = {}
    latest_activities = (
        db.query(KAMActivity, Lead.customer_id.label("lead_customer_id"))
        .outerjoin(Lead, KAMActivity.lead_id == Lead.id)
        .filter(
            or_(
                KAMActivity.customer_id.in_(customer_ids),
                Lead.customer_id.in_(customer_ids),
            )
        )
        .order_by(
            KAMActivity.activity_date.desc(),
            KAMActivity.id.desc(),
        )
        .all()
    )
    for activity, lead_customer_id in latest_activities:
        customer_id = activity.customer_id or lead_customer_id
        if customer_id is not None:
            latest_activity_by_customer.setdefault(int(customer_id), activity)

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
        customer.lead_count = pipeline_values.get("lead_count", 0)
        customer.leads_count = customer.lead_count
        customer.total_leads = customer.lead_count
        customer.lead_value = pipeline_values.get("lead_value", 0.0)
        customer.total_lead_value = customer.lead_value
        customer.opportunity_count = pipeline_values.get("opportunity_count", 0)
        customer.opportunities_count = customer.opportunity_count
        customer.total_opportunities = customer.opportunity_count
        customer.opportunity_value = pipeline_values.get("opportunity_value", 0.0)
        customer.total_opportunity_value = customer.opportunity_value
        customer.lost_opportunity_count = pipeline_values.get("lost_opportunity_count", 0)
        customer.lost_opp_count = customer.lost_opportunity_count
        customer.lost_lead_count = customer.lost_opportunity_count
        customer.quotation_count = pipeline_values.get("quotation_count", 0)
        customer.quotation_value = pipeline_values.get("quotation_value", 0.0)
        customer.pending_quotation_count = pipeline_values.get("pending_quotation_count", 0)
        customer.pending_quotations = customer.pending_quotation_count
        customer.tender_value = pipeline_values.get("tender_value", 0.0)
        customer.total_tender_value = customer.tender_value
        customer.tender_count = pipeline_values.get("tender_count", 0)
        customer.tenders_count = customer.tender_count
        customer.total_tenders = customer.tender_count
        customer.won_value = pipeline_values.get("won_value", 0.0)
        customer.won_tender_value = customer.won_value
        customer.won_tender_count = pipeline_values.get("won_tender_count", 0)
        customer.tenders_won = customer.won_tender_count
        customer.won_count = customer.won_tender_count
        customer.lost_tender_count = pipeline_values.get("lost_tender_count", 0)
        customer.tenders_lost = customer.lost_tender_count
        customer.lost_count = customer.lost_tender_count
        customer.work_order_count = pipeline_values.get("work_order_count", 0)
        customer.workorder_count = customer.work_order_count
        customer.wo_count = customer.work_order_count
        customer.total_work_orders = customer.work_order_count
        customer.work_order_value = pipeline_values.get("work_order_value", 0.0)
        customer.wo_value = customer.work_order_value
        customer.total_work_order_value = customer.work_order_value
        customer.collected_count = pipeline_values.get("collected_count", 0)
        customer.collected_value = pipeline_values.get("collected_value", 0.0)
        customer.payment_received = customer.collected_value
        customer.completed_wo_count = pipeline_values.get("completed_wo_count", 0)
        customer.completed_work_orders = customer.completed_wo_count
        customer.delayed_wo_count = pipeline_values.get("delayed_wo_count", 0)
        customer.delayed_work_orders = customer.delayed_wo_count
        customer.ci_customer_created_today = pipeline_values.get("ci_customer_created_today", 0)
        customer.ci_lead_count = pipeline_values.get("ci_lead_count", 0)
        customer.ci_lead_value = pipeline_values.get("ci_lead_value", 0.0)
        customer.ci_opportunity_count = pipeline_values.get("ci_opportunity_count", 0)
        customer.ci_opportunity_value = pipeline_values.get("ci_opportunity_value", 0.0)
        customer.ci_submitted_tender_count = pipeline_values.get("ci_submitted_tender_count", 0)
        customer.ci_submitted_tender_value = pipeline_values.get("ci_submitted_tender_value", 0.0)
        customer.ci_live_work_order_count = pipeline_values.get("ci_live_work_order_count", 0)
        customer.ci_live_work_order_value = pipeline_values.get("ci_live_work_order_value", 0.0)
        customer.ci_revenue_value = pipeline_values.get("ci_revenue_value", 0.0)
        overview_rollups = overview_rollups_by_customer.get(customer_id, {})
        customer.kam_activity_count = overview_rollups.get("kam_activity_count", 0)
        customer.activity_count = customer.kam_activity_count
        customer.touchpoint_count = customer.kam_activity_count
        customer.kam_contacted_count = overview_rollups.get("kam_contacted_count", 0)
        customer.upcoming_activity_count = overview_rollups.get("upcoming_activity_count", 0)
        customer.completed_activity_count = overview_rollups.get("completed_activity_count", 0)
        customer.overdue_activity_count = overview_rollups.get("overdue_activity_count", 0)
        customer.call_count = overview_rollups.get("call_count", 0)
        customer.video_call_count = overview_rollups.get("video_call_count", 0)
        customer.email_count = overview_rollups.get("email_count", 0)
        customer.meeting_count = overview_rollups.get("meeting_count", 0)
        customer.demo_count = overview_rollups.get("demo_count", 0)
        customer.follow_up_count = overview_rollups.get("follow_up_count", 0)
        customer.site_visit_count = overview_rollups.get("site_visit_count", 0)
        customer.products_demanded = overview_rollups.get("products_demanded", [])
        customer.products_supplied = overview_rollups.get("products_supplied", [])
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
            raise ValueError('This field is required.')
        return v.strip()

    @field_validator('mobile')
    @classmethod
    def phone_digits(cls, v: Optional[str]) -> Optional[str]:
        return V.check_mobile(v, 'Mobile number')

    @field_validator('office_phone')
    @classmethod
    def office_digits(cls, v: Optional[str]) -> Optional[str]:
        return V.check_phone(v, 'Office phone')

    @field_validator('office_email', 'personal_email')
    @classmethod
    def valid_email(cls, v: Optional[str]) -> Optional[str]:
        return V.check_email(v)

    @field_validator('website', 'linkedin')
    @classmethod
    def valid_url(cls, v: Optional[str]) -> Optional[str]:
        return V.check_url(v)

    @field_validator('contact_name')
    @classmethod
    def name_len(cls, v: str) -> str:
        return V.check_text(v, 'Contact name', 2, 100, required=True)


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
        return V.check_gstin(v)

    @field_validator('customer_name')
    @classmethod
    def validate_customer_name(cls, v: str) -> str:
        normalized = _normalize_customer_identity_value(v)
        if not normalized:
            raise ValueError('Customer name cannot be blank or only spaces.' if v else 'Customer name is required.')
        return V.check_text(normalized, 'Customer name', 2, 255, required=True)

    @field_validator('website')
    @classmethod
    def validate_website(cls, v: Optional[str]) -> Optional[str]:
        return V.check_url(v)

    @field_validator('potential_value')
    @classmethod
    def validate_potential(cls, v: Optional[float]) -> Optional[float]:
        return V.check_amount(v, 'Potential value')

    @field_validator('billing_city', 'shipping_city', 'billing_state', 'shipping_state', 'billing_area', 'shipping_area', 'billing_country', 'shipping_country')
    @classmethod
    def validate_place(cls, v: Optional[str], info) -> Optional[str]:
        label = info.field_name.split('_', 1)[1].capitalize()
        return V.check_text(v, label, 2, 100)

    @field_validator('remarks')
    @classmethod
    def validate_remarks(cls, v: Optional[str]) -> Optional[str]:
        return V.check_text(v, 'Remarks', 0, 5000)

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
        return V.check_pan(v)

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
    lead_count:          int             = 0
    leads_count:         int             = 0
    total_leads:         int             = 0
    lead_value:          float           = 0
    total_lead_value:    float           = 0
    opportunity_count:   int             = 0
    opportunities_count: int             = 0
    total_opportunities: int             = 0
    opportunity_value:   float           = 0
    total_opportunity_value: float        = 0
    lost_opportunity_count: int           = 0
    lost_opp_count:      int             = 0
    lost_lead_count:     int             = 0
    quotation_count:     int             = 0
    quotation_value:     float           = 0
    pending_quotation_count: int          = 0
    pending_quotations:  int             = 0
    tender_count:        int             = 0
    tenders_count:       int             = 0
    total_tenders:       int             = 0
    tender_value:        float           = 0
    total_tender_value:  float           = 0
    won_tender_count:    int             = 0
    tenders_won:         int             = 0
    won_count:           int             = 0
    lost_tender_count:   int             = 0
    tenders_lost:        int             = 0
    lost_count:          int             = 0
    won_value:           float           = 0
    won_tender_value:    float           = 0
    work_order_count:    int             = 0
    workorder_count:     int             = 0
    wo_count:            int             = 0
    total_work_orders:   int             = 0
    work_order_value:    float           = 0
    wo_value:            float           = 0
    total_work_order_value: float         = 0
    collected_count:     int             = 0
    collected_value:     float           = 0
    payment_received:    float           = 0
    completed_wo_count:  int             = 0
    completed_work_orders: int            = 0
    delayed_wo_count:    int             = 0
    delayed_work_orders: int             = 0
    ci_customer_created_today: int         = 0
    ci_lead_count:       int             = 0
    ci_lead_value:       float           = 0
    ci_opportunity_count: int            = 0
    ci_opportunity_value: float          = 0
    ci_submitted_tender_count: int       = 0
    ci_submitted_tender_value: float     = 0
    ci_live_work_order_count: int        = 0
    ci_live_work_order_value: float      = 0
    ci_revenue_value:    float           = 0
    kam_activity_count:  int             = 0
    activity_count:      int             = 0
    touchpoint_count:    int             = 0
    kam_contacted_count: int             = 0
    upcoming_activity_count: int         = 0
    completed_activity_count: int        = 0
    overdue_activity_count: int          = 0
    call_count:          int             = 0
    video_call_count:    int             = 0
    email_count:         int             = 0
    meeting_count:       int             = 0
    demo_count:          int             = 0
    follow_up_count:     int             = 0
    site_visit_count:    int             = 0
    products_demanded:   List[Dict[str, Any]] = Field(default_factory=list)
    products_supplied:   List[Dict[str, Any]] = Field(default_factory=list)
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
    request: Request, customer_id: int, file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db), cu: User = Depends(require_permission("customers.update")),
):
    if not _apply_customer_data_scope(db, db.query(Customer), cu).filter(Customer.id == customer_id, Customer.is_deleted == False).first():
        raise HTTPException(404, "Customer not found")
    rows = await _parse_excel_addresses(file, ["consignee"])
    _hard_delete_and_insert_raw(db, CustomerBillingConsignee, customer_id, rows)
    log_module_action(
        db=db, user_id=cu.id, module="customers", action="import",
        record_id=customer_id, record_name=file.filename, ip=get_request_ip(request),
        new_data={"section": "billing_consignees", "imported": len(rows)},
    )
    db.commit()
    return {"imported": len(rows), "message": f"{len(rows)} billing consignees imported"}


@router.post("/{customer_id}/billing-zones/import")
async def import_billing_zones(
    request: Request, customer_id: int, file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db), cu: User = Depends(require_permission("customers.update")),
):
    if not _apply_customer_data_scope(db, db.query(Customer), cu).filter(Customer.id == customer_id, Customer.is_deleted == False).first():
        raise HTTPException(404, "Customer not found")
    rows = await _parse_excel_addresses(file, ["zone"])
    _hard_delete_and_insert_raw(db, CustomerBillingZone, customer_id, rows)
    log_module_action(
        db=db, user_id=cu.id, module="customers", action="import",
        record_id=customer_id, record_name=file.filename, ip=get_request_ip(request),
        new_data={"section": "billing_zones", "imported": len(rows)},
    )
    db.commit()
    return {"imported": len(rows), "message": f"{len(rows)} billing zones imported"}


@router.post("/{customer_id}/shipping-consignees/import")
async def import_shipping_consignees(
    request: Request, customer_id: int, file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db), cu: User = Depends(require_permission("customers.update")),
):
    if not _apply_customer_data_scope(db, db.query(Customer), cu).filter(Customer.id == customer_id, Customer.is_deleted == False).first():
        raise HTTPException(404, "Customer not found")
    rows = await _parse_excel_addresses(file, ["consignee"])
    _hard_delete_and_insert_raw(db, CustomerShippingConsignee, customer_id, rows)
    log_module_action(
        db=db, user_id=cu.id, module="customers", action="import",
        record_id=customer_id, record_name=file.filename, ip=get_request_ip(request),
        new_data={"section": "shipping_consignees", "imported": len(rows)},
    )
    db.commit()
    return {"imported": len(rows), "message": f"{len(rows)} shipping consignees imported"}


@router.post("/{customer_id}/shipping-zones/import")
async def import_shipping_zones(
    request: Request, customer_id: int, file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db), cu: User = Depends(require_permission("customers.update")),
):
    if not _apply_customer_data_scope(db, db.query(Customer), cu).filter(Customer.id == customer_id, Customer.is_deleted == False).first():
        raise HTTPException(404, "Customer not found")
    rows = await _parse_excel_addresses(file, ["zone"])
    _hard_delete_and_insert_raw(db, CustomerShippingZone, customer_id, rows)
    log_module_action(
        db=db, user_id=cu.id, module="customers", action="import",
        record_id=customer_id, record_name=file.filename, ip=get_request_ip(request),
        new_data={"section": "shipping_zones", "imported": len(rows)},
    )
    db.commit()
    return {"imported": len(rows), "message": f"{len(rows)} shipping zones imported"}


# -------------------------------------------------------------------------------
# STATS (segment breakdown from master vertical_sectors table)
# -------------------------------------------------------------------------------

def _apply_customer_stats_filters(q, state: Optional[str] = None, sector: Optional[str] = None):
    normalized_state = str(state or "").strip().lower()
    if normalized_state:
        q = q.filter(
            or_(
                func.lower(func.coalesce(Customer.billing_state, "")) == normalized_state,
                func.lower(func.coalesce(Customer.shipping_state, "")) == normalized_state,
            )
        )

    normalized_sector = _normalize_customer_vertical(sector)
    if normalized_sector:
        q = q.filter(
            func.lower(func.coalesce(Customer.customer_vertical, "")) == normalized_sector.strip().lower()
        )

    return q


def _shift_month_start(ref: date, months_back: int) -> date:
    year = ref.year
    month = ref.month - months_back
    while month <= 0:
        month += 12
        year -= 1
    return date(year, month, 1)


def _as_date(value: Any) -> Optional[date]:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return None


SUPPLIED_WORK_ORDER_EXCLUDED_STATUSES = {"cancelled", "lost"}


def _clean_product_label(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def _product_rollup_key(value: Any) -> str:
    return _clean_product_label(value).casefold()


def _safe_float(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _safe_int(value: Any) -> int:
    try:
        return int(float(value or 0))
    except (TypeError, ValueError):
        return 0


def _is_supplied_work_order_status(status: Any) -> bool:
    return str(status or "").strip().casefold() not in SUPPLIED_WORK_ORDER_EXCLUDED_STATUSES


def _unique_clean_texts(values: list[Any]) -> list[str]:
    seen: set[str] = set()
    rows: list[str] = []
    for value in values:
        label = _clean_product_label(value)
        if not label:
            continue
        key = label.casefold()
        if key in seen:
            continue
        seen.add(key)
        rows.append(label)
    return rows


def _tender_product_quantity(product: TenderProduct) -> float:
    return _safe_float(getattr(product, "quantity", 0))


def _tender_product_rate(product: TenderProduct) -> float:
    if bool(getattr(product, "is_works_item", False)):
        return _safe_float(getattr(product, "work_unit_rate", 0))
    return _safe_float(getattr(product, "unit_price", 0))


def _tender_product_total(product: TenderProduct) -> float:
    total = _safe_float(getattr(product, "total_price", 0))
    if total:
        return total
    quantity = _tender_product_quantity(product)
    rate = _tender_product_rate(product)
    if not quantity or not rate:
        return 0.0
    gst_percent = _safe_float(getattr(product, "gst_percent", 0))
    return round(quantity * rate * (1 + gst_percent / 100), 2)


def _tender_product_label(product: TenderProduct, product_names_by_id: Optional[dict[int, str]] = None) -> str:
    if bool(getattr(product, "is_works_item", False)):
        label = _clean_product_label(getattr(product, "work_type", None))
        if label:
            return label
    label = _clean_product_label(getattr(product, "product_name", None))
    if label:
        return label
    product_id = getattr(product, "product_id", None)
    if product_id and product_names_by_id:
        return product_names_by_id.get(int(product_id), "")
    return ""


def _tender_product_oem_names(product: TenderProduct, oems_by_product: dict[int, list[TenderProductOEM]]) -> list[str]:
    values: list[Any] = [getattr(product, "oem_name", None)]
    product_id = getattr(product, "id", None)
    if product_id:
        values.extend(getattr(oem, "oem_name", None) for oem in oems_by_product.get(int(product_id), []))
    return _unique_clean_texts(values)


def _build_customer_portfolio_intelligence(
    db: Session,
    customers: list[Customer],
) -> dict[str, Any]:
    today = today_ist()
    customer_ids = [int(customer.id) for customer in customers if getattr(customer, "id", None)]
    month_rows = []
    month_map: dict[str, dict[str, Any]] = {}
    for offset in range(11, -1, -1):
        month_start = _shift_month_start(today, offset)
        bucket = {
            "key": month_start.strftime("%Y-%m"),
            "label": month_start.strftime("%b"),
            "booked": 0.0,
            "collected": 0.0,
            "outstanding": 0.0,
        }
        month_rows.append(bucket)
        month_map[bucket["key"]] = bucket

    if not customer_ids:
        return {
            "revenue_trend": month_rows,
            "top_customers": {
                "revenue": [],
                "potential": [],
            },
            "products": {
                "demanded": [],
                "supplied": [],
            },
            "alert_details": {
                "overdue_invoices": [],
                "overdue_followups": [],
                "stalled_opportunities": [],
                "cross_sell": [],
            },
            "alerts": [
                {"key": "overdue_invoices", "title": "0 overdue invoices", "sub": "- pending", "tone": "critical"},
                {"key": "overdue_followups", "title": "0 overdue follow-ups", "sub": "High-priority customers need immediate contact", "tone": "warning"},
                {"key": "stalled_opportunities", "title": "0 stalled opportunities", "sub": "Open opportunities requiring movement", "tone": "warning"},
                {"key": "cross_sell", "title": "0 cross-sell opportunities identified", "sub": "Customers with revenue and remaining potential", "tone": "opportunity"},
            ],
        }

    pipeline_values = _load_customer_pipeline_values(db, customer_ids)
    customer_names_by_id = {
        int(customer.id): str(customer.customer_name or f"Customer #{int(customer.id)}")
        for customer in customers
        if getattr(customer, "id", None)
    }
    customer_owner_user_ids: dict[int, int] = {}
    active_assignments = (
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
    for assignment in active_assignments:
        if assignment.customer_id is None or assignment.user_id is None:
            continue
        customer_owner_user_ids.setdefault(int(assignment.customer_id), int(assignment.user_id))

    owner_user_ids: set[int] = set(customer_owner_user_ids.values())
    for customer in customers:
        customer_id = int(customer.id)
        if customer_id not in customer_owner_user_ids and getattr(customer, "assigned_to", None):
            customer_owner_user_ids[customer_id] = int(customer.assigned_to)
            owner_user_ids.add(int(customer.assigned_to))

    owner_names_by_id: dict[int, str] = {}
    if owner_user_ids:
        for user_id, full_name in db.query(User.id, User.full_name).filter(User.id.in_(sorted(owner_user_ids))).all():
            owner_names_by_id[int(user_id)] = full_name

    def customer_revenue_value(bucket: dict[str, Any]) -> float:
        return (
            _safe_float(bucket.get("ci_revenue_value"))
            or _safe_float(bucket.get("collected_value"))
            or _safe_float(bucket.get("won_value"))
            or _safe_float(bucket.get("work_order_value"))
        )

    def customer_pipeline_value(bucket: dict[str, Any]) -> float:
        return float(
            (_safe_float(bucket.get("ci_lead_value")) or _safe_float(bucket.get("lead_value")))
            + (_safe_float(bucket.get("ci_opportunity_value")) or _safe_float(bucket.get("opportunity_value")))
            + (_safe_float(bucket.get("ci_submitted_tender_value")) or _safe_float(bucket.get("tender_value")))
        )

    def build_top_customer_rows(mode: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for customer in customers:
            if not getattr(customer, "id", None):
                continue
            customer_id = int(customer.id)
            bucket = pipeline_values.get(customer_id, {})
            revenue_value = customer_revenue_value(bucket)
            pipeline_value = customer_pipeline_value(bucket)
            account_potential_value = _safe_float(getattr(customer, "potential_value", None))
            potential_value = pipeline_value or account_potential_value
            lead_count = _safe_int(bucket.get("ci_lead_count") or bucket.get("lead_count"))
            opportunity_count = _safe_int(bucket.get("ci_opportunity_count") or bucket.get("opportunity_count"))
            tender_count = _safe_int(bucket.get("ci_submitted_tender_count") or bucket.get("tender_count"))
            work_order_count = _safe_int(bucket.get("work_order_count"))
            revenue_count = _safe_int(bucket.get("completed_wo_count") or bucket.get("collected_count") or work_order_count or bucket.get("won_tender_count"))
            pipeline_count = lead_count + opportunity_count + tender_count
            selected_value = revenue_value if mode == "revenue" else potential_value
            if selected_value <= 0:
                continue
            owner_user_id = customer_owner_user_ids.get(customer_id)
            rows.append({
                "id": customer_id,
                "customer_id": customer_id,
                "customer_name": customer_names_by_id.get(customer_id, customer.customer_name),
                "segment": customer.customer_vertical or customer.industry or customer.division,
                "owner_id": owner_user_id,
                "owner": owner_names_by_id.get(owner_user_id) if owner_user_id else None,
                "value": float(selected_value),
                "revenue_value": float(revenue_value),
                "potential_value": float(potential_value),
                "account_potential_value": float(account_potential_value),
                "pipeline_value": float(pipeline_value),
                "lead_count": lead_count,
                "opportunity_count": opportunity_count,
                "tender_count": tender_count,
                "work_order_count": work_order_count,
                "revenue_count": revenue_count,
                "pipeline_count": pipeline_count,
                "record_count": revenue_count if mode == "revenue" else pipeline_count,
                "account_status": customer.account_status,
                "account_potential": customer.account_potential,
            })

        rows.sort(key=lambda item: (-float(item.get("value") or 0), str(item.get("customer_name") or "").casefold()))
        return rows[:10]

    top_customers = {
        "revenue": build_top_customer_rows("revenue"),
        "potential": build_top_customer_rows("potential"),
    }

    work_orders = (
        db.query(WorkOrder)
        .filter(
            WorkOrder.customer_id.in_(customer_ids),
            WorkOrder.status.notin_(["Draft", "Cancelled", "Lost"]),
        )
        .all()
    )
    for work_order in work_orders:
        booked_date = _as_date(work_order.po_date) or _as_date(work_order.created_at)
        if not booked_date:
            continue
        bucket = month_map.get(booked_date.strftime("%Y-%m"))
        if bucket is None:
            continue
        bucket["booked"] += float(work_order.wo_value or work_order.po_value or 0)

    invoice_rows = (
        db.query(WOInvoice, WorkOrder)
        .join(WorkOrder, WOInvoice.wo_id == WorkOrder.id)
        .filter(WorkOrder.customer_id.in_(customer_ids))
        .all()
    )
    overdue_invoice_count = 0
    overdue_invoice_pending = 0.0
    overdue_invoice_details: list[dict[str, Any]] = []
    for invoice, invoice_work_order in invoice_rows:
        total_amount = float(invoice.total_amount or 0)
        paid_amount = float(invoice.paid_amount or 0)
        pending_amount = max(total_amount - paid_amount, 0.0)

        paid_date = _as_date(invoice.paid_date)
        if paid_date and paid_amount > 0:
            bucket = month_map.get(paid_date.strftime("%Y-%m"))
            if bucket is not None:
                bucket["collected"] += paid_amount

        outstanding_date = _as_date(invoice.due_date) or _as_date(invoice.invoice_date)
        if outstanding_date and pending_amount > 0:
            bucket = month_map.get(outstanding_date.strftime("%Y-%m"))
            if bucket is not None:
                bucket["outstanding"] += pending_amount

        if invoice.due_date and invoice.due_date < today and pending_amount > 0:
            overdue_invoice_count += 1
            overdue_invoice_pending += pending_amount
            customer_id = int(invoice_work_order.customer_id) if invoice_work_order.customer_id else None
            overdue_invoice_details.append({
                "id": invoice.id,
                "invoice_id": invoice.id,
                "invoice_number": invoice.invoice_number,
                "customer_id": customer_id,
                "customer_name": (
                    customer_names_by_id.get(customer_id)
                    if customer_id
                    else None
                ) or invoice_work_order.customer_name or "Unassigned",
                "wo_id": invoice_work_order.id,
                "wo_number": invoice_work_order.wo_number,
                "project_title": invoice_work_order.project_title,
                "invoice_date": _fmt_date(invoice.invoice_date),
                "due_date": _fmt_date(invoice.due_date),
                "days_overdue": _days(invoice.due_date, today) or 0,
                "amount": total_amount,
                "total_amount": total_amount,
                "paid_amount": paid_amount,
                "pending_amount": pending_amount,
                "payment_status": invoice.payment_status,
            })

    overdue_follow_up_count = 0
    overdue_follow_up_oldest = 0
    activities = (
        db.query(
            KAMActivity,
            Lead.customer_id.label("lead_customer_id"),
            Lead.customer_name.label("lead_customer_name"),
            Lead.lead_ref_id.label("lead_ref_id"),
            Lead.lead_title.label("lead_title"),
        )
        .outerjoin(Lead, KAMActivity.lead_id == Lead.id)
        .filter(
            or_(
                KAMActivity.customer_id.in_(customer_ids),
                Lead.customer_id.in_(customer_ids),
            )
        )
        .all()
    )
    activity_user_ids = sorted({
        int(activity.user_id)
        for activity, *_ in activities
        if getattr(activity, "user_id", None)
    })
    activity_user_names: dict[int, str] = {}
    if activity_user_ids:
        for user_id, full_name in db.query(User.id, User.full_name).filter(User.id.in_(activity_user_ids)).all():
            activity_user_names[int(user_id)] = full_name

    overdue_follow_up_details: list[dict[str, Any]] = []
    for activity, lead_customer_id, lead_customer_name, lead_ref_id, lead_title in activities:
        customer_id = activity.customer_id or lead_customer_id
        if customer_id is None:
            continue
        status = str(activity.status or "").strip().lower()
        if status == "completed" or status in {"cancelled", "canceled"}:
            continue
        activity_date = _as_date(activity.activity_date)
        next_date = _as_date(activity.next_action_date)
        overdue_date = next_date or activity_date
        if overdue_date and overdue_date < today:
            days_overdue = _days(overdue_date, today) or 0
            overdue_follow_up_count += 1
            overdue_follow_up_oldest = max(overdue_follow_up_oldest, days_overdue)
            cid = int(customer_id)
            overdue_follow_up_details.append({
                "id": activity.id,
                "activity_id": activity.id,
                "subject": activity.subject,
                "activity_type": _normalize_kam_activity_type(activity.activity_type, activity.mode),
                "mode": activity.mode,
                "customer_id": cid,
                "customer_name": customer_names_by_id.get(cid) or lead_customer_name or "Unassigned",
                "lead_id": activity.lead_id,
                "lead_ref_id": lead_ref_id,
                "lead_title": lead_title,
                "activity_date": _fmt_date(activity.activity_date),
                "next_action_date": _fmt_date(activity.next_action_date),
                "due_date": _fmt_date(overdue_date),
                "days_overdue": days_overdue,
                "status": activity.status,
                "next_action": activity.next_action,
                "outcome": activity.outcome,
                "owner": activity_user_names.get(int(activity.user_id)) if activity.user_id else None,
                "assigned_to_name": activity_user_names.get(int(activity.user_id)) if activity.user_id else None,
            })

    stale_opportunity_count = 0
    stale_opportunity_value = 0.0
    opportunity_rows = (
        db.query(Lead)
        .filter(
            Lead.customer_id.in_(customer_ids),
            Lead.is_deleted == False,
            Lead.status == "Opportunity Created",
        )
        .all()
    )
    opportunity_owner_ids = sorted({
        int(opportunity.assigned_to)
        for opportunity in opportunity_rows
        if getattr(opportunity, "assigned_to", None)
    })
    opportunity_owner_names: dict[int, str] = {}
    if opportunity_owner_ids:
        for user_id, full_name in db.query(User.id, User.full_name).filter(User.id.in_(opportunity_owner_ids)).all():
            opportunity_owner_names[int(user_id)] = full_name

    stale_opportunity_details: list[dict[str, Any]] = []
    for opportunity in opportunity_rows:
        opened_on = _as_date(opportunity.opportunity_created_at) or _as_date(opportunity.created_at)
        days_open = _days(opened_on, today) or 0
        if days_open > 60:
            stale_opportunity_count += 1
            opportunity_value = float(opportunity.est_value or 0)
            stale_opportunity_value += opportunity_value
            cid = int(opportunity.customer_id) if opportunity.customer_id else None
            stale_opportunity_details.append({
                "id": opportunity.id,
                "lead_id": opportunity.id,
                "lead_ref_id": opportunity.lead_ref_id,
                "opportunity_ref_id": opportunity.opportunity_ref_id,
                "title": opportunity.lead_title,
                "lead_title": opportunity.lead_title,
                "customer_id": cid,
                "customer_name": (
                    customer_names_by_id.get(cid)
                    if cid
                    else None
                ) or opportunity.customer_name or "Unassigned",
                "status": opportunity.status,
                "priority": opportunity.priority,
                "value": opportunity_value,
                "est_value": opportunity_value,
                "created": _fmt_date(opportunity.created_at),
                "opportunity_created_at": _fmt_date(opportunity.opportunity_created_at),
                "days_open": days_open,
                "owner": opportunity_owner_names.get(int(opportunity.assigned_to)) if opportunity.assigned_to else None,
                "assigned_to_name": opportunity_owner_names.get(int(opportunity.assigned_to)) if opportunity.assigned_to else None,
            })

    cross_sell_count = 0
    cross_sell_details: list[dict[str, Any]] = []
    for customer in customers:
        bucket = pipeline_values.get(int(customer.id), {})
        revenue_value = float(
            bucket.get("ci_revenue_value")
            or bucket.get("won_value")
            or bucket.get("work_order_value")
            or 0
        )
        potential_value = float(
            getattr(customer, "potential_value", None)
            or bucket.get("ci_opportunity_value")
            or 0
        )
        pipeline_value = float(
            (bucket.get("ci_lead_value") or bucket.get("lead_value") or 0)
            + (bucket.get("ci_opportunity_value") or bucket.get("opportunity_value") or 0)
            + (bucket.get("ci_submitted_tender_value") or bucket.get("tender_value") or 0)
        )
        future_value = potential_value or pipeline_value
        if revenue_value > 0 and future_value > revenue_value:
            cross_sell_count += 1
            cross_sell_details.append({
                "id": int(customer.id),
                "customer_id": int(customer.id),
                "customer_name": customer_names_by_id.get(int(customer.id), customer.customer_name),
                "revenue_value": revenue_value,
                "potential_value": potential_value,
                "pipeline_value": pipeline_value,
                "future_value": future_value,
                "gap_value": max(future_value - revenue_value, 0.0),
                "account_status": customer.account_status,
                "account_potential": customer.account_potential,
            })

    overdue_invoice_details.sort(key=lambda item: (int(item.get("days_overdue") or 0), float(item.get("pending_amount") or 0)), reverse=True)
    overdue_follow_up_details.sort(key=lambda item: (int(item.get("days_overdue") or 0), item.get("due_date") or ""), reverse=True)
    stale_opportunity_details.sort(key=lambda item: (int(item.get("days_open") or 0), float(item.get("value") or 0)), reverse=True)
    cross_sell_details.sort(key=lambda item: (float(item.get("gap_value") or 0), float(item.get("future_value") or 0)), reverse=True)

    product_rollups: dict[str, dict[str, dict[str, Any]]] = {
        "demanded": {},
        "supplied": {},
    }

    def product_key(value: Any) -> str:
        return _product_rollup_key(value)

    def product_label(value: Any) -> str:
        return _clean_product_label(value)

    def ensure_product(kind: str, label: str) -> dict[str, Any]:
        key = product_key(label)
        bucket = product_rollups[kind].setdefault(
            key,
            {
                "product_name": label,
                "customer_ids": set(),
                "customer_names": set(),
                "record_count": 0,
                "lead_count": 0,
                "tender_count": 0,
                "wo_count": 0,
                "quantity": 0.0,
                "qty_supplied": 0.0,
                "total_value": 0.0,
                "lead_refs": [],
                "tender_refs": [],
                "wo_numbers": [],
                "oems": set(),
                "records": [],
            },
        )
        return bucket

    def add_product_record(
        kind: str,
        customer_id: Any,
        product_name: Any,
        *,
        value: Any = 0,
        quantity: Any = 0,
        qty_supplied: Any = 0,
        count_key: str,
        ref_key: str,
        ref_value: Any = None,
        oems: Optional[list[Any]] = None,
        detail: Optional[dict[str, Any]] = None,
    ) -> None:
        if customer_id is None:
            return
        try:
            cid = int(customer_id)
        except (TypeError, ValueError):
            return
        label = product_label(product_name)
        if not label:
            return
        product = ensure_product(kind, label)
        amount = float(value or 0)
        qty = float(quantity or 0)
        delivered_qty = float(qty_supplied or 0)
        ref = str(ref_value or "").strip()
        customer_name = customer_names_by_id.get(cid, f"Customer #{cid}")
        oem_names = _unique_clean_texts(oems or [])

        product["customer_ids"].add(cid)
        product["customer_names"].add(customer_name)
        product["oems"].update(oem_names)
        product["record_count"] += 1
        product[count_key] += 1
        product["quantity"] += qty
        product["qty_supplied"] += delivered_qty or qty
        product["total_value"] += amount
        if ref:
            product[ref_key].append(ref)

        record = {
            "id": f"{kind}-{cid}-{product_key(label)}-{product['record_count']}",
            "product": label,
            "product_name": label,
            "oems": oem_names,
            "customerId": cid,
            "customer_id": cid,
            "customer": customer_name,
            "mode": "Supplied" if kind == "supplied" else "Demanded",
            "value": amount,
            "quantity": delivered_qty or qty,
            "quantityLabel": f"{delivered_qty or qty:g}" if (delivered_qty or qty) else "-",
            "recordCount": 1,
            "leadCount": 1 if count_key == "lead_count" else 0,
            "tenderCount": 1 if count_key == "tender_count" else 0,
            "woCount": 1 if count_key == "wo_count" else 0,
            "leadRefs": ref if ref_key == "lead_refs" else "",
            "tenderRefs": ref if ref_key == "tender_refs" else "",
            "woRefs": ref if ref_key == "wo_numbers" else "",
            "leadDetails": [detail] if count_key == "lead_count" and detail else [],
            "tenderDetails": [detail] if count_key == "tender_count" and detail else [],
            "woDetails": [detail] if count_key == "wo_count" and detail else [],
            "raw": detail or {},
        }
        product["records"].append(record)

    lead_product_name = func.coalesce(func.nullif(func.trim(LeadProduct.product_name), ""), ProductMaster.name)
    lead_product_rows = (
        db.query(
            Lead.customer_id,
            Lead.id,
            Lead.lead_ref_id,
            Lead.lead_title,
            Lead.status,
            Lead.est_value,
            Lead.created_at,
            lead_product_name,
            LeadProduct.quantity,
            func.coalesce(
                func.nullif(func.coalesce(LeadProduct.quantity, 0) * func.coalesce(LeadProduct.unit_price, 0), 0),
                Lead.est_value,
                0,
            ),
        )
        .select_from(LeadProduct)
        .join(Lead, LeadProduct.lead_id == Lead.id)
        .outerjoin(ProductMaster, LeadProduct.product_id == ProductMaster.id)
        .filter(
            Lead.customer_id.in_(customer_ids),
            Lead.is_deleted == False,
        )
        .all()
    )
    for customer_id, lead_id, lead_ref, title, status, est_value, created_at, product_name, quantity, value in lead_product_rows:
        add_product_record(
            "demanded",
            customer_id,
            product_name,
            value=value,
            quantity=quantity,
            count_key="lead_count",
            ref_key="lead_refs",
            ref_value=lead_ref,
            detail={
                "id": lead_id,
                "ref": lead_ref,
                "lead_ref_id": lead_ref,
                "title": title,
                "lead_title": title,
                "status": status,
                "value": float(value or est_value or 0),
                "quantity": float(quantity or 0),
                "created": _fmt_date(created_at),
            },
        )

    tender_product_name = func.coalesce(func.nullif(func.trim(TenderProduct.product_name), ""), ProductMaster.name)
    tender_product_rows = (
        db.query(
            Tender.customer_id,
            Tender.id,
            Tender.tender_num,
            Tender.portal_ref_number,
            Tender.tender_title,
            Tender.tender_status,
            Tender.result,
            Tender.est_value,
            Tender.bid_amount,
            Tender.submission_date,
            tender_product_name,
            TenderProduct.quantity,
            func.coalesce(
                TenderProduct.total_price,
                func.nullif(func.coalesce(TenderProduct.quantity, 0) * func.coalesce(TenderProduct.unit_price, 0), 0),
                Tender.est_value,
                Tender.bid_amount,
                0,
            ),
        )
        .select_from(TenderProduct)
        .join(Tender, TenderProduct.tender_id == Tender.id)
        .outerjoin(ProductMaster, TenderProduct.product_id == ProductMaster.id)
        .filter(
            Tender.customer_id.in_(customer_ids),
            Tender.is_deleted == False,
        )
        .all()
    )
    for customer_id, tender_id, tender_num, portal_ref, title, status, result, est_value, bid_amount, submission_date, product_name, quantity, value in tender_product_rows:
        tender_ref = tender_num or portal_ref
        add_product_record(
            "demanded",
            customer_id,
            product_name,
            value=value,
            quantity=quantity,
            count_key="tender_count",
            ref_key="tender_refs",
            ref_value=tender_ref,
            detail={
                "id": tender_id,
                "ref": tender_ref,
                "tender_num": tender_num,
                "portal_ref_number": portal_ref,
                "title": title,
                "tender_title": title,
                "status": status,
                "result": result,
                "value": float(value or bid_amount or est_value or 0),
                "quantity": float(quantity or 0),
                "submission": _fmt_date(submission_date),
            },
        )

    work_order_customer_id = func.coalesce(WorkOrder.customer_id, Lead.customer_id, Tender.customer_id)
    wo_product_name = func.coalesce(func.nullif(func.trim(WOLineItem.product_name), ""), ProductMaster.name)
    supplied_line_sources: set[tuple[str, int, str]] = set()
    supplied_product_rows = (
        db.query(
            work_order_customer_id,
            WorkOrder.id,
            WorkOrder.tender_id,
            WorkOrder.lead_id,
            WorkOrder.wo_number,
            WorkOrder.project_title,
            WorkOrder.status,
            WorkOrder.po_number,
            WorkOrder.created_at,
            WorkOrder.delivery_date,
            wo_product_name,
            WOLineItem.quantity,
            WOLineItem.delivered_qty,
            func.coalesce(
                WOLineItem.total_amount,
                func.nullif(func.coalesce(WOLineItem.quantity, 0) * func.coalesce(WOLineItem.unit_price, 0), 0),
                WorkOrder.wo_value,
                0,
            ),
        )
        .select_from(WOLineItem)
        .join(WorkOrder, WOLineItem.wo_id == WorkOrder.id)
        .outerjoin(Lead, WorkOrder.lead_id == Lead.id)
        .outerjoin(Tender, WorkOrder.tender_id == Tender.id)
        .outerjoin(ProductMaster, WOLineItem.product_id == ProductMaster.id)
        .filter(
            work_order_customer_id.in_(customer_ids),
            WorkOrder.status.notin_(["Cancelled", "Lost"]),
        )
        .all()
    )
    for customer_id, wo_id, tender_id, lead_id, wo_number, project_title, status, po_number, created_at, delivery_date, product_name, quantity, delivered_qty, value in supplied_product_rows:
        product_source_key = product_key(product_name)
        if product_source_key:
            if wo_id:
                supplied_line_sources.add(("wo", int(wo_id), product_source_key))
            if tender_id:
                supplied_line_sources.add(("tender", int(tender_id), product_source_key))
            if lead_id:
                supplied_line_sources.add(("lead", int(lead_id), product_source_key))
        add_product_record(
            "supplied",
            customer_id,
            product_name,
            value=value,
            quantity=quantity,
            qty_supplied=delivered_qty,
            count_key="wo_count",
            ref_key="wo_numbers",
            ref_value=wo_number,
            detail={
                "id": wo_id,
                "ref": wo_number,
                "wo_number": wo_number,
                "title": project_title or wo_number,
                "project": project_title,
                "status": status,
                "value": float(value or 0),
                "quantity": float(delivered_qty or quantity or 0),
                "ordered_quantity": float(quantity or 0),
                "delivered": float(delivered_qty or 0),
                "po_number": po_number,
                "created": _fmt_date(created_at),
                "delivery": _fmt_date(delivery_date),
            },
        )

    won_tender_rows = (
        db.query(Tender)
        .filter(
            Tender.customer_id.in_(customer_ids),
            Tender.is_deleted == False,
            Tender.result == "Won",
        )
        .all()
    )
    won_tender_ids = [int(tender.id) for tender in won_tender_rows if tender.id]
    won_tenders_by_id = {int(tender.id): tender for tender in won_tender_rows if tender.id}
    work_orders_by_tender: dict[int, WorkOrder] = {}
    if won_tender_ids:
        tender_work_orders = (
            db.query(WorkOrder)
            .filter(WorkOrder.tender_id.in_(won_tender_ids))
            .order_by(WorkOrder.updated_at.desc(), WorkOrder.created_at.desc())
            .all()
        )
        for work_order in tender_work_orders:
            if work_order.tender_id and int(work_order.tender_id) not in work_orders_by_tender:
                work_orders_by_tender[int(work_order.tender_id)] = work_order

    final_boq_products = (
        db.query(TenderProduct)
        .filter(
            TenderProduct.tender_id.in_(won_tender_ids),
            TenderProduct.is_final_boq == True,
        )
        .order_by(TenderProduct.tender_id.asc(), TenderProduct.sort_order.asc(), TenderProduct.id.asc())
        .all()
        if won_tender_ids else []
    )
    final_boq_product_ids = [int(product.id) for product in final_boq_products if product.id]
    final_boq_oems_by_product: dict[int, list[TenderProductOEM]] = defaultdict(list)
    if final_boq_product_ids:
        for oem in db.query(TenderProductOEM).filter(TenderProductOEM.tender_product_id.in_(final_boq_product_ids)).all():
            final_boq_oems_by_product[int(oem.tender_product_id)].append(oem)

    final_boq_master_ids = {
        int(product.product_id)
        for product in final_boq_products
        if product.product_id
    }
    final_boq_product_names_by_id = {
        int(product_id): name
        for product_id, name in db.query(ProductMaster.id, ProductMaster.name).filter(ProductMaster.id.in_(final_boq_master_ids)).all()
    } if final_boq_master_ids else {}

    for product in final_boq_products:
        tender_id = int(product.tender_id)
        tender = won_tenders_by_id.get(tender_id)
        if not tender:
            continue
        work_order = work_orders_by_tender.get(tender_id)
        if work_order and not _is_supplied_work_order_status(work_order.status):
            continue
        product_name = _tender_product_label(product, final_boq_product_names_by_id)
        product_source_key = product_key(product_name)
        if not product_source_key:
            continue
        if ("tender", tender_id, product_source_key) in supplied_line_sources:
            continue
        if work_order and ("wo", int(work_order.id), product_source_key) in supplied_line_sources:
            continue
        quantity = _tender_product_quantity(product)
        value = _tender_product_total(product)
        ref = (
            (work_order.wo_number if work_order else None)
            or getattr(tender, "wrk_order_id", None)
            or tender.tender_num
            or tender.portal_ref_number
        )
        status = (work_order.status if work_order else None) or tender.result or tender.tender_status
        oem_names = _tender_product_oem_names(product, final_boq_oems_by_product)
        add_product_record(
            "supplied",
            tender.customer_id,
            product_name,
            value=value,
            quantity=quantity,
            qty_supplied=quantity,
            count_key="wo_count",
            ref_key="wo_numbers",
            ref_value=ref,
            oems=oem_names,
            detail={
                "id": work_order.id if work_order else tender.id,
                "ref": ref,
                "wo_number": ref,
                "title": (work_order.project_title if work_order else None) or tender.tender_title or ref,
                "project": (work_order.project_title if work_order else None) or tender.tender_title,
                "status": status,
                "value": float(value or (work_order.wo_value if work_order else 0) or 0),
                "quantity": float(quantity or 0),
                "ordered_quantity": float(quantity or 0),
                "delivered": float(quantity or 0),
                "po_number": work_order.po_number if work_order else getattr(tender, "po_num", None),
                "created": _fmt_date(work_order.created_at if work_order else tender.created_at),
                "delivery": _fmt_date(work_order.delivery_date if work_order else getattr(tender, "dlvry_date", None)),
                "tender_num": tender.tender_num,
                "portal_ref_number": tender.portal_ref_number,
                "product_name": product_name,
                "oems": oem_names,
            },
        )

    direct_work_orders = (
        db.query(WorkOrder, Lead)
        .join(Lead, WorkOrder.lead_id == Lead.id)
        .filter(
            Lead.customer_id.in_(customer_ids),
            Lead.is_deleted == False,
            WorkOrder.status.notin_(["Cancelled", "Lost"]),
        )
        .all()
    )
    direct_work_orders_by_lead: dict[int, WorkOrder] = {}
    direct_lead_customer_ids: dict[int, int] = {}
    for work_order, lead in direct_work_orders:
        if not work_order.lead_id:
            continue
        lead_id_key = int(work_order.lead_id)
        direct_work_orders_by_lead.setdefault(lead_id_key, work_order)
        if lead.customer_id:
            direct_lead_customer_ids[lead_id_key] = int(lead.customer_id)
    direct_lead_ids = list(direct_work_orders_by_lead.keys())
    direct_lead_products = (
        db.query(LeadProduct)
        .filter(LeadProduct.lead_id.in_(direct_lead_ids))
        .order_by(LeadProduct.lead_id.asc(), LeadProduct.id.asc())
        .all()
        if direct_lead_ids else []
    )
    direct_lead_product_ids = [int(product.id) for product in direct_lead_products if product.id]
    direct_lead_oems_by_product: dict[int, list[LeadProductOEM]] = defaultdict(list)
    if direct_lead_product_ids:
        for oem in db.query(LeadProductOEM).filter(LeadProductOEM.lead_product_id.in_(direct_lead_product_ids)).all():
            direct_lead_oems_by_product[int(oem.lead_product_id)].append(oem)
    direct_product_master_ids = {
        int(product.product_id)
        for product in direct_lead_products
        if product.product_id
    }
    direct_product_names_by_id = {
        int(product_id): name
        for product_id, name in db.query(ProductMaster.id, ProductMaster.name).filter(ProductMaster.id.in_(direct_product_master_ids)).all()
    } if direct_product_master_ids else {}

    for product in direct_lead_products:
        lead_id = int(product.lead_id)
        work_order = direct_work_orders_by_lead.get(lead_id)
        if not work_order:
            continue
        product_name = product_label(getattr(product, "product_name", None))
        if not product_name and product.product_id:
            product_name = direct_product_names_by_id.get(int(product.product_id), "")
        product_source_key = product_key(product_name)
        if not product_source_key or ("lead", lead_id, product_source_key) in supplied_line_sources:
            continue
        quantity = _safe_float(getattr(product, "quantity", 0))
        unit_price = _safe_float(getattr(product, "unit_price", 0))
        value = quantity * unit_price if quantity and unit_price else _safe_float(work_order.wo_value or work_order.po_value)
        oem_names = _unique_clean_texts([
            getattr(oem, "oem_name", None)
            for oem in direct_lead_oems_by_product.get(int(product.id), [])
        ])
        add_product_record(
            "supplied",
            work_order.customer_id or direct_lead_customer_ids.get(lead_id),
            product_name,
            value=value,
            quantity=quantity,
            qty_supplied=quantity,
            count_key="wo_count",
            ref_key="wo_numbers",
            ref_value=work_order.wo_number,
            oems=oem_names,
            detail={
                "id": work_order.id,
                "ref": work_order.wo_number,
                "wo_number": work_order.wo_number,
                "title": work_order.project_title or work_order.wo_number,
                "project": work_order.project_title,
                "status": work_order.status,
                "value": float(value or 0),
                "quantity": float(quantity or 0),
                "ordered_quantity": float(quantity or 0),
                "delivered": float(quantity or 0),
                "po_number": work_order.po_number,
                "created": _fmt_date(work_order.created_at),
                "delivery": _fmt_date(work_order.delivery_date),
                "product_name": product_name,
                "oems": oem_names,
            },
        )

    def serialize_product_rollups(kind: str) -> list[dict[str, Any]]:
        rows = []
        for product in product_rollups[kind].values():
            customer_ids_out = sorted(product["customer_ids"])
            rows.append({
                **product,
                "customer_ids": customer_ids_out,
                "customer_names": sorted(product["customer_names"]),
                "customer_count": len(customer_ids_out),
                "lead_refs": list(dict.fromkeys(product["lead_refs"]))[:20],
                "tender_refs": list(dict.fromkeys(product["tender_refs"]))[:20],
                "wo_numbers": list(dict.fromkeys(product["wo_numbers"]))[:20],
                "records": product["records"][:200],
                "oems": sorted(product["oems"]),
            })
        rows.sort(key=lambda item: (float(item.get("total_value") or 0), int(item.get("record_count") or 0)), reverse=True)
        return rows[:20]

    return {
        "revenue_trend": month_rows,
        "top_customers": top_customers,
        "products": {
            "demanded": serialize_product_rollups("demanded"),
            "supplied": serialize_product_rollups("supplied"),
        },
        "alert_details": {
            "overdue_invoices": overdue_invoice_details[:200],
            "overdue_followups": overdue_follow_up_details[:200],
            "stalled_opportunities": stale_opportunity_details[:200],
            "cross_sell": cross_sell_details[:200],
        },
        "alerts": [
            {
                "key": "overdue_invoices",
                "title": f"{overdue_invoice_count} overdue invoices",
                "sub": f"{'₹{:,.0f}'.format(overdue_invoice_pending) if overdue_invoice_pending else '-'} pending",
                "tone": "critical",
            },
            {
                "key": "overdue_followups",
                "title": f"{overdue_follow_up_count} overdue follow-ups",
                "sub": (
                    f"Oldest follow-up is {overdue_follow_up_oldest} days overdue"
                    if overdue_follow_up_count and overdue_follow_up_oldest
                    else "High-priority customers need immediate contact"
                ),
                "tone": "warning",
            },
            {
                "key": "stalled_opportunities",
                "title": f"{stale_opportunity_count} stalled opportunities",
                "sub": (
                    f"₹{stale_opportunity_value:,.0f} in ageing opportunity pipeline"
                    if stale_opportunity_count and stale_opportunity_value
                    else "Open opportunities requiring movement"
                ),
                "tone": "warning",
            },
            {
                "key": "cross_sell",
                "title": f"{cross_sell_count} cross-sell opportunities identified",
                "sub": "Customers with revenue and remaining potential",
                "tone": "opportunity",
            },
        ],
    }


def _build_customer_value_engagement_matrix(
    db: Session,
    customers: list[Customer],
) -> dict[str, Any]:
    customer_ids = [int(customer.id) for customer in customers if getattr(customer, "id", None)]
    empty_bucket = {"customer_ids": [], "count": 0, "value": 0.0}
    if not customer_ids:
        return {
            "nurture": dict(empty_bucket),
            "strategic": dict(empty_bucket),
            "dormant": dict(empty_bucket),
            "growth": dict(empty_bucket),
            "thresholds": {"value": 0.0, "engagement": 0.0},
        }

    pipeline_values = _load_customer_pipeline_values(db, customer_ids)

    assigned_customer_ids = {
        int(customer_id)
        for (customer_id,) in (
            db.query(SalesCustomerAssignment.customer_id)
            .filter(
                SalesCustomerAssignment.customer_id.in_(customer_ids),
                SalesCustomerAssignment.is_active == True,
            )
            .all()
        )
        if customer_id is not None
    }

    activity_customer_id = func.coalesce(KAMActivity.customer_id, Lead.customer_id)
    activity_rows = (
        db.query(KAMActivity, Lead.customer_id.label("lead_customer_id"))
        .outerjoin(Lead, KAMActivity.lead_id == Lead.id)
        .filter(activity_customer_id.in_(customer_ids))
        .all()
    )

    engagement_rollups: dict[int, dict[str, Any]] = {
        customer_id: {
            "kam_activity_count": 0,
            "upcoming_activity_count": 0,
            "completed_activity_count": 0,
            "call_count": 0,
            "video_call_count": 0,
            "email_count": 0,
            "meeting_count": 0,
            "demo_count": 0,
            "follow_up_count": 0,
            "site_visit_count": 0,
        }
        for customer_id in customer_ids
    }
    latest_activity_by_customer: dict[int, date] = {}

    for activity, lead_customer_id in activity_rows:
        customer_id = activity.customer_id or lead_customer_id
        if customer_id is None:
            continue
        customer_id = int(customer_id)
        bucket = engagement_rollups.setdefault(customer_id, {})
        bucket["kam_activity_count"] = int(bucket.get("kam_activity_count") or 0) + 1

        activity_date = _as_date(activity.activity_date)
        if activity_date and (
            customer_id not in latest_activity_by_customer
            or activity_date > latest_activity_by_customer[customer_id]
        ):
            latest_activity_by_customer[customer_id] = activity_date

        status = str(activity.status or "").strip().lower()
        if status == "completed":
            bucket["completed_activity_count"] = int(bucket.get("completed_activity_count") or 0) + 1
        elif status not in {"cancelled", "canceled"}:
            bucket["upcoming_activity_count"] = int(bucket.get("upcoming_activity_count") or 0) + 1

        count_field = KAM_ACTIVITY_TYPE_COUNT_FIELDS.get(
            _normalize_kam_activity_type(activity.activity_type, activity.mode)
        )
        if count_field:
            bucket[count_field] = int(bucket.get(count_field) or 0) + 1

    today = today_ist()

    def business_value(customer: Customer, bucket: dict[str, Any]) -> float:
        pipeline_value = float(
            (bucket.get("ci_lead_value") or bucket.get("lead_value") or 0)
            + (bucket.get("ci_opportunity_value") or bucket.get("opportunity_value") or 0)
            + (bucket.get("ci_submitted_tender_value") or bucket.get("tender_value") or 0)
        )
        revenue_value = float(
            bucket.get("ci_revenue_value")
            or bucket.get("won_value")
            or bucket.get("work_order_value")
            or 0
        )
        potential_value = float(getattr(customer, "potential_value", None) or 0)
        return potential_value or pipeline_value or revenue_value

    def engagement_score(customer: Customer, customer_id: int, rollup: dict[str, Any]) -> float:
        last_activity_date = latest_activity_by_customer.get(customer_id)
        days_since_touch = 999
        if last_activity_date:
            try:
                last_touch = _as_date(last_activity_date)
                days_since_touch = abs((today - last_touch).days) if last_touch else 999
            except Exception:
                days_since_touch = 999

        has_owner = bool(getattr(customer, "assigned_to", None)) or customer_id in assigned_customer_ids
        return float(
            int(rollup.get("kam_activity_count") or 0)
            + int(rollup.get("completed_activity_count") or 0)
            + int(rollup.get("upcoming_activity_count") or 0)
            + int(rollup.get("call_count") or 0)
            + int(rollup.get("video_call_count") or 0)
            + int(rollup.get("email_count") or 0)
            + int(rollup.get("meeting_count") or 0)
            + int(rollup.get("demo_count") or 0)
            + int(rollup.get("follow_up_count") or 0)
            + int(rollup.get("site_visit_count") or 0)
            + (1 if has_owner else 0)
            + (3 if days_since_touch <= 90 else 1 if days_since_touch <= 180 else 0)
        )

    scored = []
    for customer in customers:
        customer_id = int(customer.id)
        pipeline_bucket = pipeline_values.get(customer_id, {})
        rollup = engagement_rollups.get(customer_id, {})
        scored.append({
            "customer_id": customer_id,
            "value": business_value(customer, pipeline_bucket),
            "engagement": engagement_score(customer, customer_id, rollup),
        })

    def median(values: list[float], fallback: float) -> float:
        ordered = sorted(value for value in values if value > 0)
        return float(ordered[len(ordered) // 2]) if ordered else fallback

    value_threshold = median([row["value"] for row in scored], 1.0)
    engagement_threshold = max(1.0, median([row["engagement"] for row in scored], 1.0))

    buckets = {
        "nurture": [],
        "strategic": [],
        "dormant": [],
        "growth": [],
    }
    for row in scored:
        high_value = row["value"] >= value_threshold
        high_engagement = row["engagement"] >= engagement_threshold
        if high_value and high_engagement:
            buckets["strategic"].append(row)
        elif high_value:
            buckets["growth"].append(row)
        elif high_engagement:
            buckets["nurture"].append(row)
        else:
            buckets["dormant"].append(row)

    def serialize_bucket(rows: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "customer_ids": [int(row["customer_id"]) for row in rows],
            "count": len(rows),
            "value": float(sum(float(row["value"] or 0) for row in rows)),
        }

    return {
        "nurture": serialize_bucket(buckets["nurture"]),
        "strategic": serialize_bucket(buckets["strategic"]),
        "dormant": serialize_bucket(buckets["dormant"]),
        "growth": serialize_bucket(buckets["growth"]),
        "thresholds": {
            "value": value_threshold,
            "engagement": engagement_threshold,
        },
    }


@router.get("/stats")
def customer_stats(
    state: Optional[str] = Query(None),
    sector: Optional[str] = Query(None),
    db:  Session = Depends(get_tenant_db),
    cu:  User    = Depends(require_permission("customers.view")),
):
    scoped_customers = _apply_customer_stats_filters(
        _apply_customer_data_scope(
            db,
            db.query(Customer).filter(Customer.is_deleted == False),
            cu,
        ),
        state=state,
        sector=sector,
    ).all()

    # All active segments from master table
    active_sectors = (
        db.query(VerticalSector)
        .filter(VerticalSector.is_active == True)
        .order_by(VerticalSector.display_order, VerticalSector.name, VerticalSector.id)
        .all()
    )

    # Count customers per customer_vertical value (raw, case-insensitive key)
    raw_counts: dict[str, int] = {}
    for customer in scoped_customers:
        raw_val = customer.customer_vertical
        if raw_val and raw_val.strip():
            key = raw_val.strip().lower()
            raw_counts[key] = raw_counts.get(key, 0) + 1

    # Build lead-source name lookup
    lead_source_map: dict[int, str] = {
        ls.id: ls.name
        for ls in db.query(LeadSource).all()
    }

    customer_ids = [int(customer.id) for customer in scoped_customers if getattr(customer, "id", None)]

    # Count leads per (customer_vertical, source_id)
    segment_source_map: dict[str, dict[str, int]] = {
        s.name.strip().lower(): {} for s in active_sectors
    }
    if customer_ids:
        lead_src_rows = (
            db.query(Customer.customer_vertical, Lead.source_id, func.count(Lead.id))
            .join(Lead, Lead.customer_id == Customer.id)
            .filter(
                Customer.id.in_(customer_ids),
                Customer.customer_vertical.isnot(None),
                Lead.source_id.isnot(None),
                Lead.is_deleted == False,
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
        },
        "portfolio_intelligence": _build_customer_portfolio_intelligence(db, scoped_customers),
        "value_engagement_matrix": _build_customer_value_engagement_matrix(db, scoped_customers),
    }


# -------------------------------------------------------------------------------
# DYNAMIC ROUTES
# -------------------------------------------------------------------------------

@router.get("/", response_model=list[CustomerResponse])
def list_customers(
    search:      Optional[str] = Query(None),
    status:      Optional[str] = Query(None),
    assigned_to: Optional[int] = Query(None),
    skip: int = 0, limit: int = 100000,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("customers.view")),
):
    q = db.query(Customer).filter(Customer.is_deleted == False)
    q = _apply_customer_data_scope(db, q, current_user)
    if search:      q = q.filter(Customer.customer_name.ilike(f"%{search}%"))
    if status:      q = q.filter(Customer.account_status == status)
    if assigned_to: q = q.filter(Customer.assigned_to == assigned_to)
    customers = q.offset(skip).limit(limit).all()
    return _attach_customers_for_list(db, customers)


def _district_name_variants(name: str) -> set:
    base = re.sub(r"\s+", " ", (name or "").strip()).casefold()
    if not base:
        return set()
    variants = {base}
    if base.startswith("the "):
        variants.add(base[4:])
    else:
        variants.add(f"the {base}")
    return variants


def _active_master_districts(db: Session) -> list:
    return db.execute(sa_text(
        "SELECT name FROM location_masters WHERE item_type = 'district' AND is_active = 1"
    )).mappings().all()


@router.get("/district-audit")
def audit_customer_districts(
    db: Session = Depends(get_tenant_db),
    _: User = Depends(require_permission("customers.view")),
):
    """Read-only report of customers whose billing_city text does not match any
    active district in the location master, so they can't be attributed to a real
    district on the Customer Distribution chart (they fall into "Others")."""
    valid_keys: set = set()
    for row in _active_master_districts(db):
        valid_keys |= _district_name_variants(row["name"])

    customers = db.query(Customer).filter(Customer.is_deleted == False).all()

    mismatched: List[dict] = []
    matched_count = 0
    blank_city_count = 0
    for c in customers:
        city = (c.billing_city or "").strip()
        if not city:
            blank_city_count += 1
            continue
        key = re.sub(r"\s+", " ", city).casefold()
        if key in valid_keys:
            matched_count += 1
            continue
        mismatched.append({
            "customer_id": c.id,
            "customer_name": c.customer_name,
            "billing_state": c.billing_state,
            "billing_city": c.billing_city,
            "billing_pincode": c.billing_pincode,
        })

    return {
        "total_customers": len(customers),
        "matching_master_district": matched_count,
        "blank_city": blank_city_count,
        "mismatched_count": len(mismatched),
        "mismatched": mismatched,
    }


async def _resolve_pincode_district(pincode: str) -> Optional[str]:
    if not pincode or not pincode.isdigit() or len(pincode) != 6:
        return None
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"http://www.postalpincode.in/api/pincode/{pincode}")
            r.raise_for_status()
            data = r.json()
            result = data[0] if isinstance(data, list) and data else data
            post_offices = result.get("PostOffice") if isinstance(result, dict) else None
            if isinstance(result, dict) and result.get("Status") == "Success" and post_offices:
                return post_offices[0].get("District") or None
    except Exception:
        return None
    return None


@router.post("/district-reconcile")
async def reconcile_customer_districts(
    dry_run: bool = Query(True),
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("customers.update")),
):
    """Fixes customers whose billing_city doesn't match a master district by
    looking up their billing_pincode against the India Post pincode API and
    snapping billing_city to the matching master district name. Defaults to
    dry_run=True (no writes) so results can be reviewed before applying."""
    canonical_by_key: Dict[str, str] = {}
    for row in _active_master_districts(db):
        for key in _district_name_variants(row["name"]):
            canonical_by_key.setdefault(key, row["name"])

    customers = db.query(Customer).filter(Customer.is_deleted == False).all()

    fixed: List[dict] = []
    unmatched_no_pincode = 0
    unmatched_lookup_failed = 0
    unmatched_no_district_match = 0

    for c in customers:
        city = (c.billing_city or "").strip()
        key = re.sub(r"\s+", " ", city).casefold() if city else ""
        if key in canonical_by_key:
            continue

        pincode = (c.billing_pincode or "").strip()
        if not pincode or not pincode.isdigit() or len(pincode) != 6:
            unmatched_no_pincode += 1
            continue

        district_text = await _resolve_pincode_district(pincode)
        if not district_text:
            unmatched_lookup_failed += 1
            continue

        lookup_key = re.sub(r"\s+", " ", district_text).strip().casefold()
        canonical = canonical_by_key.get(lookup_key)
        if not canonical:
            unmatched_no_district_match += 1
            continue

        fixed.append({
            "customer_id": c.id,
            "customer_name": c.customer_name,
            "old_billing_city": c.billing_city,
            "new_billing_city": canonical,
        })
        if not dry_run:
            c.billing_city = canonical

    if not dry_run and fixed:
        db.commit()

    return {
        "dry_run": dry_run,
        "total_customers": len(customers),
        "fixed_count": len(fixed),
        "fixed": fixed,
        "unmatched_no_pincode": unmatched_no_pincode,
        "unmatched_lookup_failed": unmatched_lookup_failed,
        "unmatched_no_district_match": unmatched_no_district_match,
    }


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


# ─── Per-user list-table display preferences (customers list only) ──────────

class CustomersTablePrefsBody(BaseModel):
    stack_order: dict = {}


@router.get("/table-prefs")
def get_customers_table_prefs(
    current_user: User = Depends(get_current_user),
):
    layout = dict(current_user.dashboard_layout or {})
    return layout.get("table_prefs", {}).get("customers-list", {"stack_order": {}})


@router.post("/table-prefs")
def save_customers_table_prefs(
    body: CustomersTablePrefsBody,
    db:           Session = Depends(get_tenant_db),
    current_user: User    = Depends(get_current_user),
):
    layout = dict(current_user.dashboard_layout or {})
    table_prefs = dict(layout.get("table_prefs", {}))
    table_prefs["customers-list"] = {"stack_order": body.stack_order}
    layout["table_prefs"] = table_prefs
    current_user.dashboard_layout = layout
    db.commit()
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
    _ensure_unique_gstin(db, data)
    _validate_customer_custom(db, data)

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
        module_key='customers',
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
    c = _apply_customer_data_scope(db, db.query(Customer), current_user).filter(Customer.id == customer_id, Customer.is_deleted == False).first()
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
    if "gst_number" in data.model_fields_set and (data.gst_number or "").upper() != (c.gst_number or "").strip().upper():
        _ensure_unique_gstin(db, data, customer_id)
    _validate_customer_custom(db, data)


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

    # Store only fields that actually changed.  This makes the audit detail
    # view a useful Before / After comparison instead of a full record dump.
    audit_old_data = {field: old_field_values.get(field) for field in sorted(changed_fields)}
    audit_new_data = {field: getattr(c, field, None) for field in sorted(changed_fields)}
    if related_section_notes:
        audit_old_data["related_sections"] = "No change"
        audit_new_data["related_sections"] = " ".join(related_section_notes)

    log_module_action(
        db=db, user_id=current_user.id, module="customers", action="update",
        record_id=customer_id, record_name=c.customer_name,
        ip=get_request_ip(request),
        old_data=audit_old_data,
        new_data=audit_new_data,
    )
    if "assigned_to" in changed_fields:
        log_module_action(
            db=db, user_id=current_user.id, module="customers",
            action="reassign" if old_field_values.get("assigned_to") else "assign",
            record_id=c.id, record_name=c.customer_name, ip=get_request_ip(request),
            old_data={"assigned_to": old_field_values.get("assigned_to")},
            new_data={"assigned_to": c.assigned_to},
        )
    generic_changed_fields = sorted(changed_fields - {"account_status", "account_potential", "potential_value"})
    status_changed = "account_status" in changed_fields
    if status_changed:
        log_module_action(
            db=db, user_id=current_user.id, module="customers", action="status_change",
            record_id=c.id, record_name=c.customer_name, ip=get_request_ip(request),
            old_data={"account_status": old_account_status},
            new_data={"account_status": c.account_status},
        )
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
    current_user: User = Depends(require_permission("customers.update")),
):
    valid = {"Active", "Inactive", "Prospect", "Churned"}
    if status not in valid:
        raise HTTPException(400, f"Invalid status. Must be one of {valid}")
    c = _apply_customer_data_scope(db, db.query(Customer), current_user).filter(Customer.id == customer_id, Customer.is_deleted == False).first()
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
    c = _apply_customer_data_scope(db, db.query(Customer), current_user).filter(Customer.id == customer_id, Customer.is_deleted == False).first()
    if not c:
        raise HTTPException(404, "Customer not found")
    before = model_snapshot(c)
    c.is_deleted = True
    _emit_customer_event(
        db,
        customer=c,
        event_key="deleted",
        actor=current_user,
    )
    # This is a soft delete: keep the customer's related records so a restore
    # from the Recycle Bin returns the customer with its contacts and addresses.

    log_module_action(
        db=db, user_id=current_user.id, module="customers", action="delete",
        record_id=customer_id, record_name=c.customer_name,
        ip=get_request_ip(request), old_data=before,
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

def _lead_brief(l, source_names: Optional[dict[int, str]] = None, owner_names: Optional[dict[int, str]] = None) -> dict:
    source_names = source_names or {}
    owner_names = owner_names or {}
    source_name = source_names.get(int(l.source_id)) if l.source_id else None
    owner_name = owner_names.get(int(l.assigned_to)) if l.assigned_to else None
    return {
        "id": l.id, "ref": l.lead_ref_id, "title": l.lead_title,
        "status": l.status, "value": float(l.est_value or 0),
        "created": _fmt_date(l.created_at), "priority": l.priority,
        "source_id": l.source_id, "source_name": source_name,
        "assigned_to": l.assigned_to, "assigned_to_name": owner_name,
        "lead_type": l.lead_type, "conversion_target": l.conversion_target,
        "contact_person": l.contact_person, "mobile": l.mobile, "email": l.email,
    }

def _tender_brief(t, owner_names: Optional[dict[int, str]] = None) -> dict:
    owner_names = owner_names or {}
    document_url = (
        getattr(t, "rfp_document", None)
        or getattr(t, "workings_document", None)
        or getattr(t, "corrigendum_document", None)
        or getattr(t, "po_doc", None)
    )
    return {
        "id": t.id, "tender_id": t.id, "tender_num": t.tender_num,
        "ref": t.portal_ref_number, "title": t.tender_title,
        "status": t.tender_status, "result": t.result,
        "est_value": float(t.est_value or 0),
        "bid_amount": float(t.bid_amount or 0) if t.bid_amount else None,
        "submission": _fmt_date(t.submission_date),
        "document_url": document_url,
        "rfp_document": getattr(t, "rfp_document", None),
        "workings_document": getattr(t, "workings_document", None),
        "corrigendum_document": getattr(t, "corrigendum_document", None),
        "po_doc": getattr(t, "po_doc", None),
        "assigned_to_name": owner_names.get(int(t.assigned_to)) if t.assigned_to else None,
    }

def _quotation_brief(q, owner_names: Optional[dict[int, str]] = None) -> dict:
    owner_names = owner_names or {}
    return {
        "id": q.id,
        "quotation_number": q.quotation_number,
        "ref": q.ref_number,
        "subject": q.subject,
        "status": q.status,
        "amount": float(q.amount or 0),
        "tax_amount": float(q.tax_amount or 0),
        "total_amount": float(q.total_amount or 0),
        "valid_until": _fmt_date(q.valid_until),
        "created": _fmt_date(q.created_at),
        "revision_number": q.revision_number,
        "lead_id": q.lead_id,
        "tender_id": q.tender_id,
        "owner": owner_names.get(int(q.created_by)) if q.created_by else None,
    }


@router.get("/{customer_id}/360")
def customer_360(
    customer_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("customers.view")),
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

    c = _apply_customer_data_scope(db, db.query(Customer), cu).filter(
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

    lead_source_ids = sorted({int(l.source_id) for l in all_leads if l.source_id})
    lead_source_names: dict[int, str] = {}
    if lead_source_ids:
        for sid, name in db.query(LeadSource.id, LeadSource.name).filter(LeadSource.id.in_(lead_source_ids)).all():
            lead_source_names[int(sid)] = name

    # Stage breakdown
    lead_by_stage: dict = {}
    for l in all_leads:
        lead_by_stage[l.status] = lead_by_stage.get(l.status, 0) + 1

        # Lead ownership tally — who has actually been working leads on this account
    lead_owner_ids = sorted({int(l.assigned_to) for l in all_leads if l.assigned_to})
    lead_owner_names: dict[int, str] = {}
    if lead_owner_ids:
        for uid, full_name in db.query(User.id, User.full_name).filter(User.id.in_(lead_owner_ids)).all():
            lead_owner_names[int(uid)] = full_name

    leads_by_owner: dict = defaultdict(lambda: {"count": 0, "value": 0.0, "won": 0, "lost": 0})
    for l in all_leads:
        if not l.assigned_to:
            continue
        bucket = leads_by_owner[int(l.assigned_to)]
        bucket["count"] += 1
        bucket["value"] += float(l.est_value or 0)
        if l.status == "Converted":
            bucket["won"] += 1
        elif l.status == "Lost":
            bucket["lost"] += 1

    leads_by_owner_list = sorted(
        [
            {"user_id": uid, "user_name": lead_owner_names.get(uid, f"User #{uid}"), **b}
            for uid, b in leads_by_owner.items()
        ],
        key=lambda x: x["count"], reverse=True,
    )

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

    tender_owner_ids = sorted({int(t.assigned_to) for t in all_tenders if t.assigned_to})
    tender_owner_names: dict[int, str] = {}
    if tender_owner_ids:
        for uid, full_name in db.query(User.id, User.full_name).filter(User.id.in_(tender_owner_ids)).all():
            tender_owner_names[int(uid)] = full_name
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

    # -- 3. QUOTATIONS ---------------------------------------------------------
    all_quotations = db.query(Quotation).filter(
        Quotation.customer_id == customer_id,
    ).order_by(Quotation.created_at.desc()).all()
    q_pending = [q for q in all_quotations if q.status in ("Draft", "Sent", "Approved")]
    q_accepted = [q for q in all_quotations if q.status == "Accepted"]
    q_rejected = [q for q in all_quotations if q.status == "Rejected"]
    q_total_value = float(sum(float(q.total_amount or q.amount or 0) for q in all_quotations))
    q_pending_value = float(sum(float(q.total_amount or q.amount or 0) for q in q_pending))
    q_accepted_value = float(sum(float(q.total_amount or q.amount or 0) for q in q_accepted))
    q_owner_ids = sorted({int(q.created_by) for q in all_quotations if q.created_by})
    q_owner_names: dict[int, str] = {}
    if q_owner_ids:
        for uid, full_name in db.query(User.id, User.full_name).filter(User.id.in_(q_owner_ids)).all():
            q_owner_names[int(uid)] = full_name

    # -- 4. WORK ORDERS --------------------------------------------------------
    work_order_scope_filters = [WorkOrder.customer_id == customer_id]
    if lead_ids:
        work_order_scope_filters.append(WorkOrder.lead_id.in_(lead_ids))
    if tender_ids:
        work_order_scope_filters.append(WorkOrder.tender_id.in_(tender_ids))
    all_wos = db.query(WorkOrder).filter(or_(*work_order_scope_filters)).all()
    wo_ids = [int(wo.id) for wo in all_wos if wo.id]
    wo_line_items = db.query(WOLineItem).filter(WOLineItem.wo_id.in_(wo_ids)).all() if wo_ids else []
    wo_line_items_by_wo: dict[int, list[WOLineItem]] = defaultdict(list)
    for line_item in wo_line_items:
        wo_line_items_by_wo[int(line_item.wo_id)].append(line_item)
    product_ids: set[int] = set()
    for product_row in [*lead_products, *tender_products, *wo_line_items]:
        product_id = getattr(product_row, "product_id", None)
        if product_id:
            product_ids.add(int(product_id))
    product_names_by_id: dict[int, str] = {}
    if product_ids:
        for product_id, name in db.query(ProductMaster.id, ProductMaster.name).filter(ProductMaster.id.in_(product_ids)).all():
            if name and str(name).strip():
                product_names_by_id[int(product_id)] = str(name).strip()

    def resolved_product_name(row: Any) -> str:
        label = str(getattr(row, "product_name", None) or "").strip()
        if label:
            return label
        product_id = getattr(row, "product_id", None)
        if not product_id:
            return ""
        return product_names_by_id.get(int(product_id), "")

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

    wo_owner_ids = sorted({int(w.created_by) for w in all_wos if w.created_by})
    wo_owner_names: dict[int, str] = {}
    if wo_owner_ids:
        for uid, full_name in db.query(User.id, User.full_name).filter(User.id.in_(wo_owner_ids)).all():
            wo_owner_names[int(uid)] = full_name

    workorder_list = [
        {
            "id":        w.id,
            "wo_number": w.wo_number,
            "project":   w.project_title,
            "status":    w.status,
            "value":     float(w.wo_value or 0),
            "po_value":   float(w.po_value or 0),
            "po_number":  w.po_number,
            "created":   _fmt_date(w.created_at),
            "delivery":  _fmt_date(w.delivery_date),
            "completion": _fmt_date(w.completion_date),
            "document":   w.po_doc or w.po_document_url,
            "owner":     wo_owner_names.get(int(w.created_by)) if w.created_by else None,
        }
        for w in sorted(all_wos, key=lambda x: x.created_at or datetime.min, reverse=True)
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
            "document_url":    i.document_url,
        }
        for i in inv_overdue
    ]
    invoice_history = [
        {
            "id":                i.id,
            "invoice_id":        i.id,
            "invoice_number":    i.invoice_number,
            "receipt_number":    i.payment_reference,
            "wo_id":             i.wo_id,
            "amount":            float(i.amount or 0),
            "gst_amount":        float(i.gst_amount or 0),
            "total_amount":      float(i.total_amount or 0),
            "paid_amount":       float(i.paid_amount or 0),
            "invoice_date":      _fmt_date(i.invoice_date),
            "due_date":          _fmt_date(i.due_date),
            "paid_date":         _fmt_date(i.paid_date),
            "payment_date":      _fmt_date(i.paid_date),
            "payment_status":    i.payment_status,
            "status":            i.payment_status,
            "payment_mode":      i.payment_mode,
            "payment_reference": i.payment_reference,
            "document_url":      i.document_url,
        }
        for i in sorted(all_invoices, key=lambda x: x.invoice_date or x.due_date or date.min, reverse=True)
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

    # -- 5. PRODUCTS SUPPLIED (from Work Orders module product sources) --------
    # Prefer real WO line items; fall back to won-tender Final BOQ and direct
    # opportunity lead products because that is what the Work Orders module shows.
    products_supplied: dict = {}
    supplied_line_sources: set[tuple[str, int, str]] = set()
    for wo in all_wos:
        if not _is_supplied_work_order_status(wo.status):
            continue
        for li in wo_line_items_by_wo.get(int(wo.id), []):
            pname = resolved_product_name(li)
            if not pname:
                continue
            key = _product_rollup_key(pname)
            if wo.tender_id:
                supplied_line_sources.add(("tender", int(wo.tender_id), key))
            if wo.lead_id:
                supplied_line_sources.add(("lead", int(wo.lead_id), key))
            supplied_line_sources.add(("wo", int(wo.id), key))
            if key not in products_supplied:
                products_supplied[key] = {
                    "product_name": pname,
                    "product_id":   li.product_id,
                    "qty_supplied":    0,
                    "total_value":     0.0,
                    "wo_count":        0,
                    "oems":            set(),
                    "wo_numbers":      [],
                    "wo_details":      [],
                    "serial_numbers":  [],
                }
            line_value = _safe_float(li.total_amount)
            if not line_value:
                line_value = _safe_float(li.quantity) * _safe_float(li.unit_price)
            products_supplied[key]["qty_supplied"]   += _safe_int(li.delivered_qty or li.quantity)
            products_supplied[key]["total_value"]    += line_value or _safe_float(wo.wo_value)
            products_supplied[key]["wo_count"]       += 1
            products_supplied[key]["wo_numbers"].append(wo.wo_number)
            products_supplied[key]["wo_details"].append({
                "id":          wo.id,
                "ref":         wo.wo_number,
                "wo_number":   wo.wo_number,
                "title":       wo.project_title or wo.wo_number,
                "project":     wo.project_title,
                "status":      wo.status,
                "value":       float(line_value or wo.wo_value or 0),
                "quantity":    int(li.quantity or 0),
                "delivered":   int(li.delivered_qty or 0),
                "po_number":   wo.po_number,
                "created":     _fmt_date(wo.created_at),
                "delivery":    _fmt_date(wo.delivery_date),
                "owner":       wo_owner_names.get(int(wo.created_by)) if wo.created_by else None,
                "product_name": pname,
            })
            if li.serial_numbers:
                sn = li.serial_numbers
                if isinstance(sn, list):
                    products_supplied[key]["serial_numbers"].extend(sn)

    # OEM from WO line items — check TenderProduct linked to the WO's tender
    for wo in all_wos:
        if wo.tender_id:
            for tp in tender_final_products_by_tender.get(int(wo.tender_id), []):
                key = _product_rollup_key(_tender_product_label(tp, product_names_by_id) or resolved_product_name(tp))
                if key in products_supplied:
                    products_supplied[key]["oems"].update(_tender_product_oem_names(tp, tender_oems_by_product))

    work_orders_by_tender: dict[int, WorkOrder] = {}
    for wo in sorted(all_wos, key=lambda item: item.updated_at or item.created_at or datetime.min, reverse=True):
        if wo.tender_id and int(wo.tender_id) not in work_orders_by_tender:
            work_orders_by_tender[int(wo.tender_id)] = wo

    for tender in t_won:
        for tp in tender_final_products_by_tender.get(int(tender.id), []):
            pname = _tender_product_label(tp, product_names_by_id) or resolved_product_name(tp)
            key = _product_rollup_key(pname)
            if not key:
                continue
            wo = work_orders_by_tender.get(int(tender.id))
            if wo and not _is_supplied_work_order_status(wo.status):
                continue
            if ("tender", int(tender.id), key) in supplied_line_sources:
                continue
            if wo and ("wo", int(wo.id), key) in supplied_line_sources:
                continue
            if key not in products_supplied:
                products_supplied[key] = {
                    "product_name": pname,
                    "product_id":   tp.product_id,
                    "qty_supplied":    0,
                    "total_value":     0.0,
                    "wo_count":        0,
                    "oems":            set(),
                    "wo_numbers":      [],
                    "wo_details":      [],
                    "serial_numbers":  [],
                }
            quantity = _tender_product_quantity(tp)
            value = _tender_product_total(tp)
            ref = (
                (wo.wo_number if wo else None)
                or getattr(tender, "wrk_order_id", None)
                or tender.tender_num
                or tender.portal_ref_number
            )
            oem_names = _tender_product_oem_names(tp, tender_oems_by_product)
            products_supplied[key]["qty_supplied"] += quantity
            products_supplied[key]["total_value"] += value or _safe_float(wo.wo_value if wo else tender.bid_amount or tender.est_value)
            products_supplied[key]["wo_count"] += 1
            if ref:
                products_supplied[key]["wo_numbers"].append(ref)
            products_supplied[key]["oems"].update(oem_names)
            products_supplied[key]["wo_details"].append({
                "id":          wo.id if wo else tender.id,
                "ref":         ref,
                "wo_number":   ref,
                "title":       (wo.project_title if wo else None) or tender.tender_title or ref,
                "project":     (wo.project_title if wo else None) or tender.tender_title,
                "status":      (wo.status if wo else None) or tender.result or tender.tender_status,
                "value":       float(value or (wo.wo_value if wo else tender.bid_amount or tender.est_value) or 0),
                "quantity":    float(quantity or 0),
                "delivered":   float(quantity or 0),
                "po_number":   wo.po_number if wo else getattr(tender, "po_num", None),
                "created":     _fmt_date(wo.created_at if wo else tender.created_at),
                "delivery":    _fmt_date(wo.delivery_date if wo else getattr(tender, "dlvry_date", None)),
                "owner":       wo_owner_names.get(int(wo.created_by)) if wo and wo.created_by else None,
                "tender_num":  tender.tender_num,
                "portal_ref_number": tender.portal_ref_number,
                "product_name": pname,
                "oems":        oem_names,
            })

    work_orders_by_lead: dict[int, WorkOrder] = {}
    for wo in sorted(all_wos, key=lambda item: item.updated_at or item.created_at or datetime.min, reverse=True):
        if wo.lead_id and int(wo.lead_id) not in work_orders_by_lead and _is_supplied_work_order_status(wo.status):
            work_orders_by_lead[int(wo.lead_id)] = wo

    for lead in all_leads:
        wo = work_orders_by_lead.get(int(lead.id))
        if not wo:
            continue
        for lp in lead_products_by_lead.get(int(lead.id), []):
            pname = resolved_product_name(lp)
            key = _product_rollup_key(pname)
            if not key or ("lead", int(lead.id), key) in supplied_line_sources:
                continue
            if key not in products_supplied:
                products_supplied[key] = {
                    "product_name": pname,
                    "product_id":   lp.product_id,
                    "qty_supplied":    0,
                    "total_value":     0.0,
                    "wo_count":        0,
                    "oems":            set(),
                    "wo_numbers":      [],
                    "wo_details":      [],
                    "serial_numbers":  [],
                }
            quantity = _safe_float(lp.quantity)
            unit_price = _safe_float(lp.unit_price)
            value = quantity * unit_price if quantity and unit_price else _safe_float(wo.wo_value or wo.po_value)
            oem_names = _unique_clean_texts([
                oem.oem_name
                for oem in lead_oems_by_product.get(int(lp.id), [])
            ])
            products_supplied[key]["qty_supplied"] += quantity
            products_supplied[key]["total_value"] += value
            products_supplied[key]["wo_count"] += 1
            products_supplied[key]["wo_numbers"].append(wo.wo_number)
            products_supplied[key]["oems"].update(oem_names)
            products_supplied[key]["wo_details"].append({
                "id":          wo.id,
                "ref":         wo.wo_number,
                "wo_number":   wo.wo_number,
                "title":       wo.project_title or wo.wo_number,
                "project":     wo.project_title,
                "status":      wo.status,
                "value":       float(value or 0),
                "quantity":    float(quantity or 0),
                "delivered":   float(quantity or 0),
                "po_number":   wo.po_number,
                "created":     _fmt_date(wo.created_at),
                "delivery":    _fmt_date(wo.delivery_date),
                "owner":       wo_owner_names.get(int(wo.created_by)) if wo.created_by else None,
                "lead_ref_id": lead.lead_ref_id,
                "product_name": pname,
                "oems":        oem_names,
            })

    products_supplied_list = [
        {
            **v,
            "oems": sorted(v["oems"]),
            "wo_numbers": list(dict.fromkeys(v["wo_numbers"])),
            "wo_details": v["wo_details"][:20],
            "serial_numbers": list(dict.fromkeys(v["serial_numbers"])),
        }
        for v in products_supplied.values()
    ]
    products_supplied_list.sort(key=lambda x: x["total_value"], reverse=True)

    # -- 6. PRODUCTS DEMANDED (from leads + tenders) ---------------------------
    # Gap analysis: lead products that never progressed to a tender
    product_demand: dict = {}

    # From leads
    for lead in all_leads:
        for lp in lead_products_by_lead.get(int(lead.id), []):
            pname = resolved_product_name(lp)
            key = pname.lower()
            if not key:
                continue
            if key not in product_demand:
                product_demand[key] = {
                    "product_name": pname,
                    "product_id":   lp.product_id,
                    "lead_count":   0,
                    "tender_count": 0,
                    "wo_count":     0,
                    "won_count":    0,
                    "oems":         set(),
                    "lead_refs":    [],
                    "tender_refs":  [],
                    "lead_details": [],
                    "tender_details": [],
                    "wo_details":   [],
                }
            product_demand[key]["lead_count"] += 1
            if lead.lead_ref_id:
                product_demand[key]["lead_refs"].append(lead.lead_ref_id)
            lead_product_oems = sorted({
                oem.oem_name.strip()
                for oem in lead_oems_by_product.get(int(lp.id), [])
                if oem.oem_name and oem.oem_name.strip()
            })
            product_demand[key]["lead_details"].append({
                "id":             lead.id,
                "ref":            lead.lead_ref_id,
                "lead_ref_id":    lead.lead_ref_id,
                "title":          lead.lead_title,
                "lead_title":     lead.lead_title,
                "status":         lead.status,
                "value":          float(lead.est_value or 0),
                "quantity":       float(lp.quantity or 0),
                "unit_price":     float(lp.unit_price or 0),
                "product_name":   pname,
                "oems":           lead_product_oems,
                "created":        _fmt_date(lead.created_at),
                "follow_up":      _fmt_date(lead.follow_up),
                "priority":       lead.priority,
                "source_name":    lead_source_names.get(int(lead.source_id)) if lead.source_id else None,
                "assigned_to":    lead.assigned_to,
                "assigned_to_name": lead_owner_names.get(int(lead.assigned_to)) if lead.assigned_to else None,
                "contact_person": lead.contact_person,
                "mobile":         lead.mobile,
                "email":          lead.email,
            })
            for oem in lead_oems_by_product.get(int(lp.id), []):
                if oem.oem_name:
                    product_demand[key]["oems"].add(oem.oem_name.strip())

    # From tenders
    for tender in all_tenders:
        for tp in tender_non_final_products_by_tender.get(int(tender.id), []):
            pname = resolved_product_name(tp)
            key = pname.lower()
            if not key:
                continue
            if key not in product_demand:
                product_demand[key] = {
                    "product_name": pname,
                    "product_id":   tp.product_id,
                    "lead_count":   0,
                    "tender_count": 0,
                    "wo_count":     0,
                    "won_count":    0,
                    "oems":         set(),
                    "lead_refs":    [],
                    "tender_refs":  [],
                    "lead_details": [],
                    "tender_details": [],
                    "wo_details":   [],
                }
            product_demand[key]["tender_count"] += 1
            if tender.result == "Won":
                product_demand[key]["won_count"] += 1
            if tender.portal_ref_number:
                product_demand[key]["tender_refs"].append(tender.portal_ref_number)
            if tender.tender_num:
                product_demand[key]["tender_refs"].append(tender.tender_num)
            tender_product_oems = sorted({
                oem.oem_name.strip()
                for oem in tender_oems_by_product.get(int(tp.id), [])
                if oem.oem_name and oem.oem_name.strip()
            })
            if tp.oem_name:
                tender_product_oems = sorted(set(tender_product_oems + [tp.oem_name.strip()]))
            product_demand[key]["tender_details"].append({
                "id":               tender.id,
                "ref":              tender.tender_num or tender.portal_ref_number,
                "tender_num":       tender.tender_num,
                "portal_ref_number": tender.portal_ref_number,
                "title":            tender.tender_title,
                "tender_title":     tender.tender_title,
                "status":           tender.tender_status,
                "result":           tender.result,
                "workflow_status":  tender.workflow_status,
                "value":            float(tender.est_value or 0),
                "bid_amount":       float(tender.bid_amount or 0) if tender.bid_amount else None,
                "quantity":         float(tp.quantity or 0),
                "unit_price":       float(tp.unit_price or 0),
                "product_name":     pname,
                "oems":             tender_product_oems,
                "published":        _fmt_date(tender.published_date),
                "pre_bid":          _fmt_date(tender.pre_bid_date),
                "submission":       _fmt_date(tender.submission_date),
                "result_date":      _fmt_date(tender.result_date),
                "source_portal":    tender.source_portal,
                "assigned_to":      tender.assigned_to,
                "assigned_to_name": tender_owner_names.get(int(tender.assigned_to)) if tender.assigned_to else None,
            })
            for oem in tender_oems_by_product.get(int(tp.id), []):
                if oem.oem_name:
                    product_demand[key]["oems"].add(oem.oem_name.strip())

    # From work orders
    for wo in all_wos:
        for li in wo_line_items_by_wo.get(int(wo.id), []):
            key = resolved_product_name(li).lower()
            if key in product_demand:
                product_demand[key]["wo_count"] += 1
                product_demand[key]["wo_details"].append({
                    "id":          wo.id,
                    "ref":         wo.wo_number,
                    "wo_number":   wo.wo_number,
                    "title":       wo.project_title or wo.wo_number,
                    "project":     wo.project_title,
                    "status":      wo.status,
                    "value":       float(li.total_amount or wo.wo_value or 0),
                    "quantity":    int(li.quantity or 0),
                    "delivered":   int(li.delivered_qty or 0),
                    "po_number":   wo.po_number,
                    "created":     _fmt_date(wo.created_at),
                    "delivery":    _fmt_date(wo.delivery_date),
                    "owner":       wo_owner_names.get(int(wo.created_by)) if wo.created_by else None,
                })

    products_demanded_list = []
    for v in product_demand.values():
        total = v["lead_count"] + v["tender_count"] + v["wo_count"]
        products_demanded_list.append({
            **v,
            "oems":          sorted(v["oems"]),
            "lead_refs":     v["lead_refs"][:5],
            "tender_refs":   v["tender_refs"][:5],
            "lead_details":  v["lead_details"][:20],
            "tender_details": v["tender_details"][:20],
            "wo_details":    v["wo_details"][:20],
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

    # Breakdown by normalized KAM activity type
    kam_by_type: dict = {}
    kam_completed_by_type: dict = {}
    for a in kam_acts:
        k = _normalize_kam_activity_type(a.activity_type, a.mode)
        kam_by_type[k] = kam_by_type.get(k, 0) + 1
        if a.status == "Completed":
            kam_completed_by_type[k] = kam_completed_by_type.get(k, 0) + 1

    # Specific completed counts
    kam_calls       = kam_completed_by_type.get("Phone Call", 0)
    kam_video_calls = kam_completed_by_type.get("Video Call", 0)
    kam_emails      = kam_completed_by_type.get("Email", 0)
    kam_meetings    = kam_completed_by_type.get("In Person Meet", 0)
    kam_demos       = kam_completed_by_type.get("Demo", 0)
    kam_follow_ups  = kam_completed_by_type.get("Follow Up", 0)
    kam_sv          = kam_completed_by_type.get("Site Visit", 0)

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

    kam_user_ids = sorted({int(a.user_id) for a in kam_acts if a.user_id})
    kam_user_names: dict[int, str] = {}
    if kam_user_ids:
        for uid, full_name in db.query(User.id, User.full_name).filter(User.id.in_(kam_user_ids)).all():
            kam_user_names[int(uid)] = full_name

    kam_activity_list = [
        {
            "id":      a.id,
            "type":    a.activity_type,
            "subject": a.subject,
            "description": getattr(a, "description", None),
            "date":    _fmt_date(a.activity_date),
            "activity_date": _fmt_date(a.activity_date),
            "time":    str(a.start_time)[:5] if a.start_time else None,
            "next_action": getattr(a, "next_action", None),
            "next_followup_date": _fmt_date(getattr(a, "next_action_date", None)),
            "status":  a.status,
            "outcome": getattr(a, "outcome", None),
            "owner":   kam_user_names.get(int(a.user_id)) if a.user_id else None,
            "assigned_to_name": kam_user_names.get(int(a.user_id)) if a.user_id else None,
        }
        for a in kam_acts[:100]
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
    emdbg_list = [
        {
            "id":                 e.id,
            "ref":                e.reference_num,
            "reference_num":      e.reference_num,
            "type":               e.instrument_type,
            "instrument_type":    e.instrument_type,
            "amount":             float(e.amount or 0),
            "bank_name":          e.bank_name,
            "bank_branch":        e.bank_branch,
            "instrument_number":  e.instrument_number,
            "issued_date":        _fmt_date(e.issued_date),
            "submitted_date":     _fmt_date(e.submitted_date),
            "valid_from":         _fmt_date(e.valid_from),
            "expiry":             _fmt_date(e.expiry_date),
            "expiry_date":        _fmt_date(e.expiry_date),
            "days_left":          _days(today, e.expiry_date) if e.expiry_date else None,
            "tender_num":         e.tender_num,
            "tender_id":          e.tender_id,
            "work_order_id":      e.work_order_id,
            "po_number":          e.po_number,
            "status":             e.status,
            "payment_status":     e.finance_status,
            "payment_mode":       e.instrument_type,
            "paid_date":          _fmt_date(e.finance_paid_date),
            "document_url":       e.instrument_document_url,
            "return_document_url": e.return_document_url,
        }
        for e in sorted(emdbgs, key=lambda x: x.created_at or datetime.min, reverse=True)
    ]

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
            "office_email": ct.office_email,
            "office_phone": ct.office_phone,
            "personal_email": ct.personal_email,
            "website":     ct.website,
            "linkedin":    ct.linkedin,
            "is_primary":  ct.is_primary,
            "is_active":   ct.is_active,
            "notes":       ct.notes,
        }
        for ct in (getattr(c_with, "contacts", []) or [])
    ]
    address_out = lambda rows: [
        {
            "id":          row.id,
            "customer_id": row.customer_id,
            "name":        row.name,
            "address":     row.address,
            "pincode":     row.pincode,
            "country":     row.country,
            "state":       row.state,
            "city":        row.city,
            "area":        row.area,
            "sort_order":  row.sort_order,
            "is_active":   row.is_active,
        }
        for row in (rows or [])
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
            "detail": f"₹{inv_total_pending:,.0f} pending · oldest {worst['days_overdue']}d overdue",
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
            "detail": f"₹{sum(o['value'] for o in stale_opps):,.0f} at risk",
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
            "id":                       c.id,
            "name":                     c.customer_name,
            "vertical":                 _normalize_customer_vertical(c.customer_vertical),
            "division":                 c.division,
            "group_name":               c.group_name,
            "industry":                 c.industry,
            "tags":                     c.tags,
            "parent_account_id":        c.parent_account_id,
            "billing_address":          c.billing_address,
            "billing_pincode":          c.billing_pincode,
            "billing_country":          c.billing_country,
            "billing_state":            c.billing_state,
            "billing_city":             c.billing_city,
            "billing_area":             c.billing_area,
            "shipping_same_as_billing": c.shipping_same_as_billing,
            "shipping_address":         c.shipping_address,
            "shipping_pincode":         c.shipping_pincode,
            "shipping_country":         c.shipping_country,
            "shipping_state":           c.shipping_state,
            "shipping_city":            c.shipping_city,
            "shipping_area":            c.shipping_area,
            "gst_number":               c.gst_number,
            "pan_number":               c.pan_number,
            "annual_revenue":           float(c.annual_revenue) if c.annual_revenue is not None else None,
            "employee_count":           c.employee_count,
            "website":                  c.website,
            "account_status":           c.account_status,
            "account_potential":        c.account_potential,
            "potential_value":          float(c.potential_value or 0),
            "assigned_to":              c.assigned_to,
            "remarks":                  c.remarks,
            "is_active":                c.is_active,
            "approval_status":          c.approval_status,
            "custom_data":              c.custom_data,
            "created_by":               c.created_by,
            "updated_by":               c.updated_by,
            "created_at":               c.created_at.isoformat() if c.created_at else None,
            "updated_at":               c.updated_at.isoformat() if c.updated_at else None,
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
            "by_owner":         leads_by_owner_list,
            "stale_opps":       stale_opps,
            "unconverted_leads": leads_no_tender,
            "won_list":         [_lead_brief(l, lead_source_names, lead_owner_names) for l in lead_converted[:50]],
            "lost_list":        [_lead_brief(l, lead_source_names, lead_owner_names) for l in lead_lost[:50]],
            "pipeline_list":    [_lead_brief(l, lead_source_names, lead_owner_names) for l in lead_active[:50]],
            "all_list":         [_lead_brief(l, lead_source_names, lead_owner_names) for l in all_leads[:50]],
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
            "won_list":       [_tender_brief(t, tender_owner_names) for t in t_won[:50]],
            "lost_list":      [_tender_brief(t, tender_owner_names) for t in t_lost[:50]],
            "pipeline_list":  [_tender_brief(t, tender_owner_names) for t in t_pending[:50]],
            "all_list":       [_tender_brief(t, tender_owner_names) for t in all_tenders[:50]],
            "recent":         [_tender_brief(t, tender_owner_names) for t in all_tenders[:5]],
        },

        # -- Quotation summary -------------------------------------------------
        "quotation_summary": {
            "total":          len(all_quotations),
            "pending":        len(q_pending),
            "accepted":       len(q_accepted),
            "rejected":       len(q_rejected),
            "total_value":    q_total_value,
            "pending_value":  q_pending_value,
            "accepted_value": q_accepted_value,
            "pending_list":   [_quotation_brief(q, q_owner_names) for q in q_pending[:50]],
            "accepted_list":  [_quotation_brief(q, q_owner_names) for q in q_accepted[:50]],
            "rejected_list":  [_quotation_brief(q, q_owner_names) for q in q_rejected[:50]],
            "all_list":       [_quotation_brief(q, q_owner_names) for q in all_quotations[:50]],
            "recent":         [_quotation_brief(q, q_owner_names) for q in all_quotations[:5]],
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
            "recent":            workorder_list[:5],
            "all_list":          workorder_list[:100],
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
            "history":          invoice_history[:100],
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
            "video_calls":      kam_video_calls,
            "emails":           kam_emails,
            "meetings":         kam_meetings,
            "demos":            kam_demos,
            "follow_ups":       kam_follow_ups,
            "site_visits":      kam_sv,
            "open_tasks":       open_tasks,
            "overdue_tasks":    overdue_tasks,
            "pending_actions":  pending_actions,
            "recent":           kam_activity_list[:10],
            "all_list":         kam_activity_list,
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
            "all_list":       emdbg_list[:100],
            "active_list":    [item for item in emdbg_list if item.get("status") == "Active"],
            "recent":         emdbg_list[:10],
            "by_type": {
                k: sum(1 for e in emdbg_active if e.instrument_type == k)
                for k in {e.instrument_type for e in emdbgs}
            },
        },

        # -- Contacts ----------------------------------------------------------
        "contacts": contacts_out,
        "billing_consignees":  address_out(getattr(c_with, "billing_consignees", [])),
        "billing_zones":       address_out(getattr(c_with, "billing_zones", [])),
        "shipping_consignees": address_out(getattr(c_with, "shipping_consignees", [])),
        "shipping_zones":      address_out(getattr(c_with, "shipping_zones", [])),
    }

