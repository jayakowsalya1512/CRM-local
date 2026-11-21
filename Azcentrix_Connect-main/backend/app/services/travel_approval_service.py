from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from app.core.timezone import as_ist_naive, now_ist, today_ist
from typing import Optional

from sqlalchemy.orm import Session, selectinload

from app.models.all_models import (
    ActivityLog,
    Approval,
    ApprovalRequest,
    ApprovalRequestStep,
    TravelRequest,
    User,
)
from app.services.generic_approval_engine import (
    create_generic_approval_request,
    decide_generic_approval_request,
)
from app.services.notification_service import (
    get_bool_setting,
    get_setting_value,
    upsert_notification,
)

logger = logging.getLogger(__name__)

TRAVEL_APPROVAL_REQUIRED_KEY = "travel_approval_required"
TRAVEL_AUTO_APPROVE_MINUTES_KEY = "travel_auto_approve_minutes"


def _now_utc() -> datetime:
    return now_ist()


def _as_utc(value: Optional[datetime]) -> Optional[datetime]:
    return as_ist_naive(value)


def is_travel_approval_required(db: Session) -> bool:
    return get_bool_setting(db, TRAVEL_APPROVAL_REQUIRED_KEY, True)


def get_travel_auto_approve_minutes(db: Session) -> int:
    raw_value = (get_setting_value(db, TRAVEL_AUTO_APPROVE_MINUTES_KEY, "0") or "0").strip()
    try:
        return max(0, int(raw_value))
    except (TypeError, ValueError):
        return 0


def find_ceo(db: Session) -> Optional[int]:
    for role in ("ceo", "admin"):
        user = db.query(User).filter(User.role == role, User.is_active == True).first()
        if user:
            return user.id
    return None


def find_reporting_manager(db: Session, requester: User) -> Optional[User]:
    if requester.reporting_manager_id:
        manager = (
            db.query(User)
            .filter(User.id == requester.reporting_manager_id, User.is_active == True)
            .first()
        )
        if manager and manager.id != requester.id:
            return manager

    for role in ("manager", "vp", "admin", "ceo"):
        manager = (
            db.query(User)
            .filter(User.role == role, User.is_active == True, User.id != requester.id)
            .first()
        )
        if manager:
            return manager
    return None


def find_travel_approver(db: Session, requester: User) -> Optional[User]:
    if requester.role in ("ceo", "admin"):
        return None

    if requester.role in ("manager", "vp"):
        ceo_id = find_ceo(db)
        if not ceo_id or ceo_id == requester.id:
            return None
        return db.query(User).filter(User.id == ceo_id, User.is_active == True).first()

    return find_reporting_manager(db, requester)


def _queue_travel_approval(
    db: Session,
    requester: User,
    approver: User,
    tr: TravelRequest,
) -> Approval:
    approval = Approval(
        module="travel",
        action="request",
        record_id=tr.id,
        record_ref=tr.request_number,
        requested_by=requester.id,
        requested_to=approver.id,
        status="pending",
        request_notes=f"Travel to {tr.to_city} for {tr.purpose}".strip(),
    )
    db.add(approval)
    db.flush()
    return approval


def _log_activity(
    db: Session,
    *,
    user_id: Optional[int],
    tr: TravelRequest,
    action: str,
    description: str,
    icon: str,
    color: str,
) -> None:
    db.add(
        ActivityLog(
            user_id=user_id,
            module="travel",
            record_id=tr.id,
            action=action,
            description=description,
            icon=icon,
            color=color,
        )
    )


def _sorted_dynamic_steps(request: ApprovalRequest) -> list[ApprovalRequestStep]:
    return sorted(request.steps or [], key=lambda item: item.step_no)


def _active_dynamic_step(request: ApprovalRequest) -> Optional[ApprovalRequestStep]:
    return next(
        (step for step in _sorted_dynamic_steps(request) if step.step_no == request.current_step_no),
        None,
    )


def _latest_acted_dynamic_step(request: ApprovalRequest) -> Optional[ApprovalRequestStep]:
    return next(
        (step for step in reversed(_sorted_dynamic_steps(request)) if step.acted_at),
        None,
    )


def _current_step_started_at(request: ApprovalRequest) -> Optional[datetime]:
    normalized_current_step = int(getattr(request, "current_step_no", 0) or 0)
    if normalized_current_step <= 1:
        return _as_utc(request.requested_at)

    previous_step = next(
        (step for step in _sorted_dynamic_steps(request) if step.step_no == normalized_current_step - 1),
        None,
    )
    return _as_utc(previous_step.acted_at if previous_step else request.requested_at)


def sync_travel_request_from_generic_approval(
    db: Session,
    *,
    approval_request: ApprovalRequest,
    actor: Optional[User],
    remarks: str = "",
) -> Optional[TravelRequest]:
    if approval_request.module_key != "travel" or approval_request.action_key != "request":
        return None

    tr = db.query(TravelRequest).filter(TravelRequest.id == approval_request.record_id).first()
    if not tr:
        return None

    requester = approval_request.requester or db.query(User).filter(User.id == approval_request.requested_by).first()
    active_step = _active_dynamic_step(approval_request)
    latest_acted_step = _latest_acted_dynamic_step(approval_request)
    normalized_status = (approval_request.status or "").strip().lower()
    effective_notes = (remarks or (latest_acted_step.remarks if latest_acted_step else "") or "").strip()

    tr.approval_id = approval_request.id

    if normalized_status == "approved":
        tr.status = "Approved"
        tr.approved_by = latest_acted_step.approver_user_id if latest_acted_step else getattr(actor, "id", None)
        tr.approved_at = latest_acted_step.acted_at or _now_utc() if latest_acted_step else _now_utc()
        tr.rejection_reason = None

        approver_name = (
            latest_acted_step.approver.full_name
            if latest_acted_step and latest_acted_step.approver
            else getattr(actor, "full_name", "the approver")
        )
        upsert_notification(
            db,
            tr.employee_id,
            title=f"Travel Request Approved: {tr.request_number}",
            message=f"Your travel request to {tr.to_city} has been approved by {approver_name}.",
            module="travel",
            record_id=tr.id,
            action="travel_approved",
            category="approval",
            send_email=True,
        )
        _log_activity(
            db,
            user_id=getattr(actor, "id", None),
            tr=tr,
            action="travel_approved",
            description=f"Travel request {tr.request_number} approved",
            icon="OK",
            color="#F0FDF4",
        )
        return tr

    if normalized_status == "rejected":
        tr.status = "Rejected"
        tr.approved_by = None
        tr.approved_at = None
        tr.rejection_reason = effective_notes or None

        rejector_name = (
            latest_acted_step.approver.full_name
            if latest_acted_step and latest_acted_step.approver
            else getattr(actor, "full_name", "the approver")
        )
        upsert_notification(
            db,
            tr.employee_id,
            title=f"Travel Request Rejected: {tr.request_number}",
            message=(
                f"Your travel request to {tr.to_city} was rejected by {rejector_name}."
                f"{f' Reason: {effective_notes}' if effective_notes else ''}"
            ),
            module="travel",
            record_id=tr.id,
            action="travel_rejected",
            category="approval",
            send_email=True,
        )
        _log_activity(
            db,
            user_id=getattr(actor, "id", None),
            tr=tr,
            action="travel_rejected",
            description=f"Travel request {tr.request_number} rejected",
            icon="ERR",
            color="#FFF5F5",
        )
        return tr

    tr.status = "Submitted"
    tr.approved_by = None
    tr.approved_at = None
    tr.rejection_reason = None

    if active_step and active_step.approver_user_id:
        approver_name = active_step.approver.full_name if active_step.approver else "next approver"
        requester_name = requester.full_name if requester else "A user"
        is_progression = latest_acted_step is not None
        upsert_notification(
            db,
            active_step.approver_user_id,
            title=(
                f"Travel Approval Moved: {tr.request_number}"
                if is_progression
                else f"Travel Request Needs Approval: {tr.request_number}"
            ),
            message=(
                f"{requester_name}'s travel request to {tr.to_city} moved to your approval step."
                if is_progression
                else f"{requester_name} submitted a travel request to {tr.to_city}. Travel date: {tr.travel_date}."
            ),
            module="travel",
            record_id=tr.id,
            action="approval_request",
            category="approval",
            send_email=True,
        )
        _log_activity(
            db,
            user_id=getattr(actor, "id", None),
            tr=tr,
            action="travel_progressed" if is_progression else "submitted",
            description=(
                f"Travel request {tr.request_number} moved to {approver_name}"
                if is_progression
                else f"Travel request {tr.request_number} submitted to {approver_name}"
            ),
            icon="PENDING",
            color="#FEF3C7",
        )

    return tr


def _approve_travel_request(
    db: Session,
    tr: TravelRequest,
    approval: Approval,
    *,
    decided_at: datetime,
    decision_notes: str,
    notify_title: str,
    notify_message: str,
    log_description: str,
) -> None:
    approval.status = "approved"
    approval.decision_notes = decision_notes
    approval.rejection_reason = None
    approval.decided_at = decided_at

    tr.status = "Approved"
    tr.approved_by = None
    tr.approved_at = decided_at
    tr.rejection_reason = None

    upsert_notification(
        db,
        tr.employee_id,
        title=notify_title,
        message=notify_message,
        module="travel",
        record_id=tr.id,
        action="travel_auto_approved",
        category="approval",
        send_email=True,
    )
    _log_activity(
        db,
        user_id=None,
        tr=tr,
        action="travel_auto_approved",
        description=log_description,
        icon="OK",
        color="#F0FDF4",
    )


def submit_travel_request_with_policy(
    db: Session,
    tr: TravelRequest,
    *,
    actor: User,
    requester: User,
    tenant_id: Optional[int] = None,
    request_group_id: Optional[int] = None,
) -> dict:
    tr.rejection_reason = None
    tr.approved_by = None
    tr.approved_at = None

    approval_required = is_travel_approval_required(db)
    if not approval_required:
        now = _now_utc()
        tr.status = "Approved"
        tr.approved_by = None
        tr.approved_at = now
        tr.approval_id = None

        _log_activity(
            db,
            user_id=actor.id,
            tr=tr,
            action="auto_approved",
            description=f"Travel request {tr.request_number} auto-approved on submit (approval disabled in settings)",
            icon="OK",
            color="#F0FDF4",
        )
        return {
            "message": "Travel request auto-approved",
            "requested_to": "Auto-approved",
            "status": tr.status,
            "auto_approved": True,
        }

    approval_request = create_generic_approval_request(
        db=db,
        tenant_id=tenant_id,
        requester=requester,
        module_key="travel",
        action_key="request",
        record_id=tr.id,
        request_group_id=request_group_id,
    )
    tr.approval_id = approval_request.id
    sync_travel_request_from_generic_approval(
        db,
        approval_request=approval_request,
        actor=actor,
    )

    if (approval_request.status or "").strip().lower() == "approved":
        return {
            "message": "Travel request auto-approved",
            "requested_to": "Auto-approved",
            "status": tr.status,
            "auto_approved": True,
            "approval_id": approval_request.id,
        }

    auto_approve_minutes = get_travel_auto_approve_minutes(db)
    active_step = _active_dynamic_step(approval_request)
    approver_name = active_step.approver.full_name if active_step and active_step.approver else ""
    message = "Travel request submitted successfully"
    if auto_approve_minutes > 0:
        message = (
            "Travel request submitted successfully. "
            f"The current approval step will auto-approve after {auto_approve_minutes} minute(s) if no decision is taken."
        )

    return {
        "message": message,
        "requested_to": approver_name,
        "status": tr.status,
        "auto_approve_after_minutes": auto_approve_minutes,
        "auto_approved": False,
        "approval_id": approval_request.id,
    }


def resolve_expired_travel_approvals(
    db: Session,
    *,
    approval_id: Optional[int] = None,
    approver_id: Optional[int] = None,
    request_id: Optional[int] = None,
) -> int:
    approval_required = is_travel_approval_required(db)
    auto_approve_minutes = get_travel_auto_approve_minutes(db)

    if approval_required and auto_approve_minutes <= 0:
        return 0

    approvals_query = db.query(Approval).filter(
        Approval.module == "travel",
        Approval.status == "pending",
    )
    if approval_id is not None:
        approvals_query = approvals_query.filter(Approval.id == approval_id)
    if approver_id is not None:
        approvals_query = approvals_query.filter(Approval.requested_to == approver_id)
    if request_id is not None:
        approvals_query = approvals_query.filter(Approval.record_id == request_id)

    now = _now_utc()
    cutoff = now - timedelta(minutes=auto_approve_minutes) if approval_required else None
    resolved_count = 0

    approvals = approvals_query.all()
    travel_request_ids = {
        int(approval.record_id)
        for approval in approvals
        if getattr(approval, "record_id", None)
    }
    travel_requests_by_id = {
        int(travel_request.id): travel_request
        for travel_request in db.query(TravelRequest)
        .filter(TravelRequest.id.in_(travel_request_ids))
        .all()
    } if travel_request_ids else {}

    for approval in approvals:
        created_at = _as_utc(approval.created_at)
        if approval_required and (created_at is None or created_at > cutoff):
            continue

        tr = travel_requests_by_id.get(int(approval.record_id)) if approval.record_id else None
        if not tr:
            approval.status = "approved"
            approval.decision_notes = (
                f"Auto-approved after {auto_approve_minutes} minute(s); request record was not found."
                if approval_required
                else "Auto-approved because travel approval is disabled in settings."
            )
            approval.decided_at = now
            resolved_count += 1
            continue

        if tr.status != "Submitted":
            approval.status = "approved" if tr.status == "Approved" else "rejected"
            approval.decision_notes = approval.decision_notes or (
                f"Closed automatically because travel request is already {tr.status}."
            )
            approval.rejection_reason = tr.rejection_reason if tr.status == "Rejected" else None
            approval.decided_at = approval.decided_at or now
            resolved_count += 1
            continue

        if approval_required:
            decision_notes = f"Auto-approved after {auto_approve_minutes} minute(s) without manager action."
            notify_message = (
                f"Your travel request to {tr.to_city} was auto-approved after "
                f"{auto_approve_minutes} minute(s) with no manager action."
            )
            log_description = (
                f"Travel request {tr.request_number} auto-approved after "
                f"{auto_approve_minutes} minute(s) without manager action"
            )
        else:
            decision_notes = "Auto-approved because travel approval is disabled in settings."
            notify_message = (
                f"Your travel request to {tr.to_city} was auto-approved because "
                "travel approval is disabled in settings."
            )
            log_description = (
                f"Travel request {tr.request_number} auto-approved because "
                "travel approval is disabled in settings"
            )

        _approve_travel_request(
            db,
            tr,
            approval,
            decided_at=now,
            decision_notes=decision_notes,
            notify_title=f"Travel Request Approved: {tr.request_number}",
            notify_message=notify_message,
            log_description=log_description,
        )
        resolved_count += 1

    dynamic_query = (
        db.query(ApprovalRequest)
        .options(
            selectinload(ApprovalRequest.steps).selectinload(ApprovalRequestStep.approver),
        )
        .filter(
            ApprovalRequest.module_key == "travel",
            ApprovalRequest.action_key == "request",
            ApprovalRequest.status == "pending",
        )
    )
    if approval_id is not None:
        dynamic_query = dynamic_query.filter(ApprovalRequest.id == approval_id)
    if request_id is not None:
        dynamic_query = dynamic_query.filter(ApprovalRequest.record_id == request_id)

    dynamic_requests = dynamic_query.order_by(
        ApprovalRequest.requested_at.asc(),
        ApprovalRequest.id.asc(),
    ).all()
    dynamic_travel_request_ids = {
        int(approval_request.record_id)
        for approval_request in dynamic_requests
        if getattr(approval_request, "record_id", None)
    }
    dynamic_travel_requests_by_id = {
        int(travel_request.id): travel_request
        for travel_request in db.query(TravelRequest)
        .filter(TravelRequest.id.in_(dynamic_travel_request_ids))
        .all()
    } if dynamic_travel_request_ids else {}

    for approval_request in dynamic_requests:
        active_step = _active_dynamic_step(approval_request)
        if approver_id is not None and getattr(active_step, "approver_user_id", None) != approver_id:
            continue

        step_started_at = _current_step_started_at(approval_request)
        if approval_required and (step_started_at is None or step_started_at > cutoff):
            continue

        tr = dynamic_travel_requests_by_id.get(int(approval_request.record_id)) if approval_request.record_id else None
        if not tr:
            approval_request.status = "approved"
            approval_request.final_decided_at = now
            if active_step and active_step.status == "pending":
                active_step.status = "approved"
                active_step.acted_at = now
                active_step.remarks = (
                    f"Auto-approved after {auto_approve_minutes} minute(s); request record was not found."
                    if approval_required
                    else "Auto-approved because travel approval is disabled in settings."
                )
            resolved_count += 1
            continue

        if tr.status != "Submitted":
            normalized_travel_status = (tr.status or "").strip().lower()
            if normalized_travel_status in {"approved", "rejected"}:
                approval_request.status = normalized_travel_status
                approval_request.final_decided_at = approval_request.final_decided_at or now
                if active_step and active_step.status == "pending":
                    active_step.status = normalized_travel_status
                    active_step.acted_at = active_step.acted_at or now
                    active_step.remarks = active_step.remarks or (
                        f"Closed automatically because travel request is already {tr.status}."
                    )
                resolved_count += 1
            continue

        if not active_step or not active_step.approver_user_id:
            continue

        approver = active_step.approver or db.query(User).filter(User.id == active_step.approver_user_id).first()
        if not approver:
            continue

        decision_notes = (
            f"Auto-approved after {auto_approve_minutes} minute(s) without approver action."
            if approval_required
            else "Auto-approved because travel approval is disabled in settings."
        )
        updated_request = decide_generic_approval_request(
            db,
            approval_request_id=approval_request.id,
            approver=approver,
            decision="approved",
            remarks=decision_notes,
        )
        sync_travel_request_from_generic_approval(
            db,
            approval_request=updated_request,
            actor=approver,
            remarks=decision_notes,
        )
        resolved_count += 1

    return resolved_count

