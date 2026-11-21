"""Shared notification and email helpers for tenant-scoped workflow messages."""

from __future__ import annotations

import logging
from datetime import datetime
from app.core.timezone import now_ist, today_ist
from html import escape
from typing import Literal, Optional

from sqlalchemy.orm import Session

from app.database import MasterSessionLocal
from app.models.all_models import Notification, TenantSetting, User
from app.models.tenant import Tenant
from app.services.tenant_email_service import (
    TenantEmailConfigurationError,
    TenantEmailDeliveryError,
    send_tenant_email,
)
from app.services.cache_service import invalidate_notifications_cache

logger = logging.getLogger(__name__)

EMAIL_NOTIFICATIONS_KEY = "email_notifications"
APPROVAL_EMAIL_NOTIFICATIONS_KEY = "approval_email_notifications"
ALERT_EMAIL_NOTIFICATIONS_KEY = "alert_email_notifications"
EVENT_EMAIL_NOTIFICATIONS_KEY = "event_email_notifications"
INTERNAL_SETTING_PREFIX = "_internal_"

NotificationCategory = Literal["approval", "alert", "event"]


def ensure_tenant_settings_table(db: Session) -> None:
    try:
        TenantSetting.__table__.create(bind=db.get_bind(), checkfirst=True)
    except Exception as exc:
        logger.debug("tenant_settings ensure skipped: %s", exc)


def _normalize_bool(value: object, default: bool = False) -> bool:
    if value is None:
        return default
    return str(value).strip().lower() == "true"


def get_setting_value(db: Session, key: str, default: Optional[str] = None) -> Optional[str]:
    ensure_tenant_settings_table(db)
    row = db.query(TenantSetting).filter(TenantSetting.key == key).first()
    if not row or row.value is None:
        return default
    return row.value


def get_bool_setting(db: Session, key: str, default: bool = False) -> bool:
    return _normalize_bool(get_setting_value(db, key), default)


def get_internal_setting_value(db: Session, key: str, default: Optional[str] = None) -> Optional[str]:
    return get_setting_value(db, key, default)


def set_internal_setting_value(
    db: Session,
    key: str,
    value: object,
    value_type: str = "string",
) -> None:
    ensure_tenant_settings_table(db)
    serialized = "" if value is None else str(value)
    row = db.query(TenantSetting).filter(TenantSetting.key == key).first()
    if row:
        row.value = serialized
        row.value_type = value_type
        row.updated_at = now_ist()
        return

    db.add(TenantSetting(
        key=key,
        value=serialized,
        value_type=value_type,
        updated_at=now_ist(),
    ))


def resolve_notification_category(
    action: Optional[str] = None,
    module: Optional[str] = None,
    category: Optional[NotificationCategory] = None,
) -> NotificationCategory:
    if category in {"approval", "alert", "event"}:
        return category

    action_text = (action or "").strip().lower()
    module_text = (module or "").strip().lower()

    if module_text == "alerts" or action_text.startswith("alert"):
        return "alert"

    if (
        "approval" in action_text
        or action_text.endswith("_approved")
        or action_text.endswith("_rejected")
        or action_text in {
            "approved",
            "rejected",
            "convert",
            "conversion_approved",
            "conversion_rejected",
            "manager_approved",
            "manager_rejected",
            "ceo_approved",
            "ceo_rejected",
            "accounts_notify",
        }
    ):
        return "approval"

    return "event"


def is_email_enabled_for_category(db: Session, category: NotificationCategory) -> bool:
    if not get_bool_setting(db, EMAIL_NOTIFICATIONS_KEY, True):
        return False

    category_key = {
        "approval": APPROVAL_EMAIL_NOTIFICATIONS_KEY,
        "alert": ALERT_EMAIL_NOTIFICATIONS_KEY,
        "event": EVENT_EMAIL_NOTIFICATIONS_KEY,
    }[category]
    return get_bool_setting(db, category_key, True)


def _load_tenant_for_session(db: Session) -> Optional[Tenant]:
    tenant_slug = str(db.info.get("tenant_slug") or "").strip()
    if not tenant_slug:
        logger.debug("Notification email skipped because tenant slug is missing on DB session")
        return None

    master_db = MasterSessionLocal()
    try:
        tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
        if tenant:
            master_db.expunge(tenant)
        return tenant
    finally:
        master_db.close()


def _build_generic_email_bodies(
    db: Session,
    title: str,
    message: str,
    module: Optional[str],
    action_url: Optional[str],
    category: NotificationCategory,
) -> tuple[str, str]:
    company_name = (get_setting_value(db, "company_name", "AZCENTRIX") or "AZCENTRIX").strip() or "AZCENTRIX"
    module_label = (module or "general").replace("_", " ").title()
    category_label = category.title()
    open_line = f"\nOpen CRM: {action_url}" if action_url else "\nOpen the CRM to review this item."

    text_body = (
        f"{company_name}\n\n"
        f"{title}\n\n"
        f"{message}\n\n"
        f"Type: {category_label}\n"
        f"Module: {module_label}"
        f"{open_line}\n"
    )

    action_block = ""
    if action_url:
        action_block = (
            f'<p style="margin:24px 0 0;">'
            f'<a href="{escape(action_url)}" '
            'style="display:inline-block;padding:12px 18px;border-radius:10px;'
            'background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;">'
            "Open In CRM"
            "</a></p>"
        )

    html_body = (
        '<div style="font-family:Arial,sans-serif;background:#f8fafc;padding:24px;">'
        '<div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;'
        'border-radius:18px;overflow:hidden;">'
        '<div style="padding:20px 24px;background:#0f172a;color:#ffffff;">'
        f'<div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;opacity:0.75;">{escape(company_name)}</div>'
        f'<h2 style="margin:10px 0 0;font-size:22px;line-height:1.3;">{escape(title)}</h2>'
        "</div>"
        '<div style="padding:24px;color:#334155;">'
        f'<p style="margin:0 0 14px;font-size:15px;line-height:1.7;">{escape(message)}</p>'
        '<div style="margin-top:18px;padding:14px 16px;border-radius:12px;background:#f8fafc;border:1px solid #e2e8f0;">'
        f'<p style="margin:0 0 6px;"><strong>Type:</strong> {escape(category_label)}</p>'
        f'<p style="margin:0;"><strong>Module:</strong> {escape(module_label)}</p>'
        "</div>"
        f"{action_block}"
        '<p style="margin:22px 0 0;font-size:13px;color:#64748b;">This email was sent from your CRM notification settings.</p>'
        "</div>"
        "</div>"
        "</div>"
    )

    return text_body, html_body


def send_email_to_user(
    db: Session,
    user_id: int,
    subject: str,
    text_body: str,
    html_body: Optional[str] = None,
    *,
    category: NotificationCategory = "event",
    respect_category_setting: bool = True,
) -> bool:
    if user_id <= 0:
        return False
    if respect_category_setting:
        if not is_email_enabled_for_category(db, category):
            return False

    recipient = db.query(User).filter(User.id == user_id, User.is_active == True).first()
    if not recipient or not (recipient.email or "").strip():
        return False

    tenant = _load_tenant_for_session(db)
    if not tenant:
        return False

    try:
        send_tenant_email(
            tenant=tenant,
            to_email=recipient.email.strip(),
            subject=subject,
            text_body=text_body,
            html_body=html_body,
        )
        return True
    except (TenantEmailConfigurationError, TenantEmailDeliveryError) as exc:
        logger.warning(
            "Notification email skipped for tenant=%s user_id=%s: %s",
            getattr(tenant, "slug", "unknown"),
            user_id,
            exc,
        )
        return False
    except Exception as exc:
        logger.exception("Unexpected notification email failure for user_id=%s: %s", user_id, exc)
        return False


def send_notification_email(
    db: Session,
    user_id: int,
    title: str,
    message: str,
    *,
    module: Optional[str] = None,
    action: Optional[str] = None,
    action_url: Optional[str] = None,
    category: Optional[NotificationCategory] = None,
) -> bool:
    resolved_category = resolve_notification_category(action=action, module=module, category=category)
    text_body, html_body = _build_generic_email_bodies(
        db,
        title=title,
        message=message,
        module=module,
        action_url=action_url,
        category=resolved_category,
    )
    return send_email_to_user(
        db,
        user_id=user_id,
        subject=title,
        text_body=text_body,
        html_body=html_body,
        category=resolved_category,
    )


def upsert_notification(
    db: Session,
    user_id: int,
    title: str,
    message: str,
    *,
    module: Optional[str] = None,
    record_id: Optional[int] = None,
    action: Optional[str] = None,
    notif_type: Optional[str] = None,
    action_url: Optional[str] = None,
    category: Optional[NotificationCategory] = None,
    send_email: bool = True,
) -> tuple[Optional[Notification], bool]:
    if user_id is None or int(user_id) <= 0:
        return None, False

    title = (title or "")[:200]
    message = (message or "")[:2000]

    resolved_action = action or notif_type

    # Per-user delivery preferences (Inbox & Notifications → Delivery preferences): a category the user
    # switched off (or a channel removed from it) is filed in-app as already read and is not e-mailed/pushed.
    deliver_app, deliver_email = True, True
    try:
        from app.services.inbox_service import delivery_channels_for
        deliver_app, deliver_email = delivery_channels_for(
            db, int(user_id), module=module, action=resolved_action, title=title, message=message,
            category=resolve_notification_category(resolved_action, module, category),
        )
    except Exception as exc:  # preferences must never block a notification
        logger.debug("Delivery preference lookup skipped for user_id=%s: %s", user_id, exc)
    send_email = send_email and deliver_email

    notification = db.query(Notification).filter_by(
        user_id=int(user_id),
        module=module,
        record_id=record_id,
        action=resolved_action,
    ).first()
    if notification:
        # Only unread if the content changed — a genuinely new event on the same record.
        # Idempotent re-triggers (same title + message) should not undo "mark as read".
        if (notification.title != title or notification.message != message) and deliver_app:
            notification.is_read = False
        notification.title = title
        notification.message = message
    else:
        notification = Notification(
            user_id=int(user_id),
            title=title,
            message=message,
            module=module,
            record_id=record_id,
            action=resolved_action,
            is_read=not deliver_app,
        )
        db.add(notification)

    tenant_slug = str(db.info.get("tenant_slug") or "").strip()

    email_sent = False
    if send_email and tenant_slug:
        try:
            from app.tasks.notification_tasks import send_notification_email_task

            send_notification_email_task.delay(
                tenant_slug,
                int(user_id),
                title=title,
                message=message,
                module=module,
                action=resolved_action,
                action_url=action_url,
                category=category,
            )
            email_sent = True  # queued, not a delivery guarantee
        except Exception as exc:
            logger.warning("Notification email queue failed for user_id=%s: %s", user_id, exc)
    elif send_email:
        logger.warning("Notification email skipped for user_id=%s: tenant slug missing on session", user_id)

    if tenant_slug and deliver_app:
        try:
            from app.tasks.notification_tasks import send_push_notification_task

            send_push_notification_task.delay(
                tenant_slug,
                int(user_id),
                title,
                message,
                {
                    "module": module or "",
                    "record_id": "" if record_id is None else str(record_id),
                    "action": resolved_action or "",
                },
            )
        except Exception as exc:
            logger.warning("Push notification skipped for user_id=%s: %s", user_id, exc)

    invalidate_notifications_cache(db, int(user_id))
    return notification, email_sent

