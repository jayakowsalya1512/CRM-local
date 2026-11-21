"""Centralized approval service for in-app notifications and approval emails."""

import logging
from datetime import datetime, timezone
from app.core.timezone import now_ist, today_ist
from typing import Optional

from sqlalchemy.orm import Session

from app.models.all_models import ActivityLog, Approval, User
from app.services.dynamic_notification_service import emit_notification_event
from app.services.notification_service import upsert_notification

logger = logging.getLogger(__name__)


def _map_dynamic_approval_request_event(module: str, action: str) -> Optional[tuple[str, str]]:
    module_key = (module or "").strip().lower()
    action_key = (action or "").strip().lower()
    if module_key == "tender":
        if action_key in {"tender_step2_manager", "tender_step2_ceo"}:
            return "tenders", "step2_approval_requested"
        if action_key in {"tender_step3_manager", "tender_step3_ceo"}:
            return "tenders", "step3_approval_requested"
    if module_key == "emdbg":
        return "emdbg", "approval_requested"
    return None


def find_approver(db: Session, requester: User, module: str = None, action: str = None) -> Optional[User]:
    """Old-style approver lookup: reporting manager first, then first manager/vp/admin/ceo."""
    if requester.reporting_manager_id:
        approver = db.query(User).filter(
            User.id == requester.reporting_manager_id,
            User.is_active == True,
        ).first()
        if approver:
            return approver

    for role in ("manager", "vp", "admin", "ceo"):
        candidate = db.query(User).filter(User.role == role, User.is_active == True).first()
        if candidate:
            return candidate

    return None


def get_notify_users(db: Session, module: str, action: str) -> list:
    """No rule-based notification users — returns empty list."""
    return []


def create_approval_request(
    db: Session,
    requester: User,
    module: str,
    action: str,
    record_id: int,
    record_ref: str,
    request_notes: str = "",
    ip_address: str = None,
) -> Optional[Approval]:
    approver = find_approver(db, requester, module, action)
    if not approver:
        logger.warning("No approver found for %s/%s by user %s", module, action, requester.id)
        return None

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

    email_sent = _upsert_notification(
        db,
        approver.id,
        title=f"Approval Required: {record_ref}",
        message=(
            f"{requester.full_name} has requested your approval for {module} — "
            f"{record_ref}. Notes: {request_notes or 'None'}"
        ),
        module=module,
        record_id=record_id,
        action="approval_request",
        send_email=True,
        category="approval",
    )
    approval.notif_sent = True
    approval.email_sent = bool(email_sent)

    db.add(ActivityLog(
        user_id=requester.id,
        module=module,
        record_id=record_id,
        action="approval_requested",
        description=f"Approval requested from {approver.full_name} for {record_ref}",
        icon="⏳",
        color="#FEF3C7",
    ))

    return approval


def process_approval_decision(
    db: Session,
    approval_id: int,
    approver: User,
    decision: str,
    decision_notes: str = "",
    rejection_reason: str = "",
) -> Optional[Approval]:
    approval = db.query(Approval).filter(
        Approval.id == approval_id,
        Approval.requested_to == approver.id,
        Approval.status == "pending",
    ).first()
    if not approval:
        return None

    approval.status = decision
    approval.decision_notes = decision_notes
    approval.rejection_reason = rejection_reason if decision == "rejected" else None
    approval.decided_at = now_ist()
    db.flush()

    requester = db.query(User).filter(User.id == approval.requested_by).first()
    if not requester:
        return approval

    action_word = "approved" if decision == "approved" else "rejected"
    icon = "✅" if decision == "approved" else "❌"
    color = "#D1FAE5" if decision == "approved" else "#FEE2E2"

    email_sent = _upsert_notification(
        db,
        requester.id,
        title=f"Request {action_word.title()}: {approval.record_ref}",
        message=(
            f"{approver.full_name} has {action_word} your {approval.module} request — {approval.record_ref}."
            + (f" Reason: {rejection_reason}" if rejection_reason else "")
        ),
        module=approval.module,
        record_id=approval.record_id,
        action=f"approval_{decision}",
        send_email=True,
        category="approval",
    )
    approval.notif_sent = True
    approval.email_sent = bool(approval.email_sent or email_sent)

    notify_users = get_notify_users(db, approval.module, approval.action)
    for user in notify_users:
        if user.id in (requester.id, approver.id):
            continue
        _upsert_notification(
            db,
            user.id,
            title=f"{approval.module.title()} {action_word}: {approval.record_ref}",
            message=(
                f"{approver.full_name} {action_word} {requester.full_name}'s request "
                f"for {approval.record_ref}."
            ),
            module=approval.module,
            record_id=approval.record_id,
            action=f"approval_{decision}",
            send_email=True,
            category="approval",
        )

    db.add(ActivityLog(
        user_id=approver.id,
        module=approval.module,
        record_id=approval.record_id,
        action=f"approval_{decision}",
        description=f"{approver.full_name} {action_word} request for {approval.record_ref}",
        icon=icon,
        color=color,
    ))

    return approval


def _upsert_notification(
    db: Session,
    user_id: int,
    title: str,
    message: str,
    module: str = None,
    record_id: int = None,
    action: str = None,
    notif_type: str = None,
    action_url: str = None,
    send_email: bool = True,
    category: str = None,
    **_: object,
) -> bool:
    """Upsert notification and optionally send a category-aware email."""
    try:
        _, email_sent = upsert_notification(
            db,
            user_id=user_id,
            title=title,
            message=message,
            module=module,
            record_id=record_id,
            action=action,
            notif_type=notif_type,
            action_url=action_url,
            category=category,
            send_email=send_email,
        )
        logger.info(
            "Notification upserted: user=%s module=%s record=%s action=%s email_sent=%s",
            user_id,
            module,
            record_id,
            action or notif_type,
            email_sent,
        )
        return email_sent
    except Exception as exc:
        logger.warning("_upsert_notification failed: %s", exc)
        return False


_create_notification = _upsert_notification

