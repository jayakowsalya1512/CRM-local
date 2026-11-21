"""Lead event notification rules and dispatch helpers."""

from __future__ import annotations

from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.models.all_models import Lead, User
from app.services.dynamic_notification_service import emit_notification_event
from app.services.notification_service import get_bool_setting

LEAD_NOTIFICATION_EVENT_DEFAULTS: dict[str, dict[str, bool]] = {
    "new_lead": {
        "assigned_user": False,
        "manager": False,
        "admin": False,
        "ceo": False,
    },
    "lead_assignment": {
        "assigned_user": True,
        "manager": False,
        "admin": False,
        "ceo": False,
    },
    "status_qualified": {
        "assigned_user": True,
        "manager": True,
        "admin": False,
        "ceo": False,
    },
    "status_won": {
        "assigned_user": True,
        "manager": True,
        "admin": True,
        "ceo": True,
    },
    "status_lost": {
        "assigned_user": True,
        "manager": True,
        "admin": True,
        "ceo": True,
    },
    "high_priority_lead": {
        "assigned_user": True,
        "manager": True,
        "admin": True,
        "ceo": True,
    },
}

LEAD_NOTIFICATION_ACTIONS: dict[str, str] = {
    "new_lead": "lead_new",
    "lead_assignment": "lead_assign",
    "status_qualified": "lead_qualified",
    "status_won": "lead_won",
    "status_lost": "lead_lost",
    "high_priority_lead": "lead_high",
}


def lead_notification_setting_key(event_key: str, recipient_key: str) -> str:
    return f"lead_notify_{event_key}_{recipient_key}"


LEAD_NOTIFICATION_SETTING_DEFAULTS: Dict[str, Dict[str, Any]] = {
    lead_notification_setting_key(event_key, recipient_key): {
        "value": "true" if enabled else "false",
        "type": "bool",
    }
    for event_key, recipient_defaults in LEAD_NOTIFICATION_EVENT_DEFAULTS.items()
    for recipient_key, enabled in recipient_defaults.items()
}


def is_high_priority_lead(lead: Lead) -> bool:
    return str(getattr(lead, "priority", "") or "").strip().lower() == "high"


def is_lead_notification_enabled(db: Session, event_key: str, recipient_key: str) -> bool:
    default = LEAD_NOTIFICATION_EVENT_DEFAULTS.get(event_key, {}).get(recipient_key, False)
    return get_bool_setting(db, lead_notification_setting_key(event_key, recipient_key), default)


def _get_active_user(db: Session, user_id: Optional[int]) -> Optional[User]:
    if not user_id:
        return None
    return db.query(User).filter(User.id == int(user_id), User.is_active == True).first()


def _resolve_lead_notification_groups(db: Session, lead: Lead) -> dict[str, list[User]]:
    assignee = _get_active_user(db, getattr(lead, "assigned_to", None))

    manager: Optional[User] = None
    if assignee and getattr(assignee, "reporting_manager_id", None):
        manager = _get_active_user(db, assignee.reporting_manager_id)
        if manager and manager.id == assignee.id:
            manager = None

    admins = (
        db.query(User)
        .filter(User.role.in_(("admin", "ceo")), User.is_active == True)
        .all()
    )
    ceos = db.query(User).filter(User.role == "ceo", User.is_active == True).all()

    return {
        "assigned_user": [assignee] if assignee else [],
        "manager": [manager] if manager else [],
        "admin": admins,
        "ceo": ceos,
    }


def dispatch_lead_event_notification(
    db: Session,
    *,
    lead: Lead,
    event_key: str,
    title: str,
    message: str,
    actor_user_id: Optional[int] = None,
    action: Optional[str] = None,
) -> list[int]:
    emit_notification_event(
        db,
        module_key="leads",
        event_key=event_key,
        record_id=lead.id,
        actor_user_id=actor_user_id,
        context={
            "title_hint": title,
            "message_hint": message,
            "record_ref": getattr(lead, "lead_ref_id", None) or getattr(lead, "lead_title", None),
            "legacy_action": action or LEAD_NOTIFICATION_ACTIONS.get(event_key, f"lead_{event_key}")[:50],
        },
        skip_actor=True,
    )
    return []
