"""Firebase Cloud Messaging helpers and token persistence."""

from __future__ import annotations

import logging
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.core.firebase import FirebaseConfigurationError, get_firebase_app
from app.core.timezone import now_ist
from app.models.all_models import UserPushToken

logger = logging.getLogger(__name__)

PERMANENT_TOKEN_ERROR_NAMES = {
    "InvalidArgumentError",
    "SenderIdMismatchError",
    "UnregisteredError",
}


class PushNotificationError(RuntimeError):
    """Raised when a push request is invalid or cannot be sent."""


def _normalize_token(token: str) -> str:
    normalized = (token or "").strip()
    if not normalized:
        raise PushNotificationError("FCM token is required")
    if len(normalized) > 512:
        raise PushNotificationError("FCM token is too long")
    return normalized


def _normalize_data(data: Optional[dict[str, Any]]) -> Optional[dict[str, str]]:
    if not data:
        return None
    return {
        str(key): "" if value is None else str(value)
        for key, value in data.items()
        if key is not None
    }


def _is_permanent_token_error(exc: Exception) -> bool:
    return exc.__class__.__name__ in PERMANENT_TOKEN_ERROR_NAMES


def ensure_push_token_table(db: Session) -> None:
    UserPushToken.__table__.create(bind=db.get_bind(), checkfirst=True)


def register_push_token(
    db: Session,
    *,
    user_id: int,
    token: str,
    platform: Optional[str] = None,
    device_id: Optional[str] = None,
    device_name: Optional[str] = None,
) -> UserPushToken:
    normalized_token = _normalize_token(token)
    now = now_ist()
    normalized_device_id = (device_id or "").strip() or None
    ensure_push_token_table(db)

    if normalized_device_id:
        db.query(UserPushToken).filter(
            UserPushToken.user_id == int(user_id),
            UserPushToken.device_id == normalized_device_id,
            UserPushToken.token != normalized_token,
        ).update({"is_active": False}, synchronize_session=False)

    token_row = db.query(UserPushToken).filter(
        UserPushToken.token == normalized_token
    ).first()

    if token_row is None:
        token_row = UserPushToken(
            user_id=int(user_id),
            token=normalized_token,
            created_at=now,
        )
        db.add(token_row)

    token_row.user_id = int(user_id)
    token_row.platform = (platform or "").strip()[:40] or None
    token_row.device_id = normalized_device_id
    token_row.device_name = (device_name or "").strip()[:200] or None
    token_row.is_active = True
    token_row.failed_count = 0
    token_row.last_error = None
    token_row.last_seen_at = now
    token_row.updated_at = now
    db.flush()
    return token_row


def deactivate_push_token(db: Session, *, user_id: int, token: str) -> int:
    normalized_token = _normalize_token(token)
    ensure_push_token_table(db)
    count = db.query(UserPushToken).filter(
        UserPushToken.user_id == int(user_id),
        UserPushToken.token == normalized_token,
    ).update(
        {
            "is_active": False,
            "updated_at": now_ist(),
        },
        synchronize_session=False,
    )
    db.flush()
    return int(count or 0)


def active_push_tokens_for_user(db: Session, user_id: int) -> list[UserPushToken]:
    ensure_push_token_table(db)
    return db.query(UserPushToken).filter(
        UserPushToken.user_id == int(user_id),
        UserPushToken.is_active == True,
    ).all()


def send_push(
    token: str,
    title: str = "New Lead",
    body: str = "Lead assigned successfully",
    data: Optional[dict[str, Any]] = None,
) -> str:
    normalized_token = _normalize_token(token)
    get_firebase_app()

    from firebase_admin import messaging

    message = messaging.Message(
        notification=messaging.Notification(
            title=(title or "").strip() or "Notification",
            body=(body or "").strip() or "You have a new update",
        ),
        data=_normalize_data(data),
        token=normalized_token,
    )
    return messaging.send(message)


def send_push_to_user(
    db: Session,
    *,
    user_id: int,
    title: str,
    body: str,
    data: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    token_rows = active_push_tokens_for_user(db, user_id)
    if not token_rows:
        return {"total": 0, "sent": 0, "failed": 0, "configured": True, "responses": []}

    try:
        get_firebase_app()
    except FirebaseConfigurationError as exc:
        logger.warning("Firebase push skipped for user_id=%s: %s", user_id, exc)
        return {
            "total": len(token_rows),
            "sent": 0,
            "failed": len(token_rows),
            "configured": False,
            "responses": [{"status": "configuration_error", "error": str(exc)}],
        }

    sent = 0
    failed = 0
    responses: list[dict[str, Any]] = []
    now = now_ist()

    for token_row in token_rows:
        try:
            message_id = send_push(token_row.token, title=title, body=body, data=data)
            token_row.failed_count = 0
            token_row.last_error = None
            token_row.last_seen_at = now
            token_row.updated_at = now
            sent += 1
            responses.append({
                "token_id": token_row.id,
                "status": "sent",
                "message_id": message_id,
            })
        except Exception as exc:
            failed += 1
            token_row.failed_count = int(token_row.failed_count or 0) + 1
            token_row.last_error = str(exc)[:1000]
            token_row.updated_at = now
            if _is_permanent_token_error(exc):
                token_row.is_active = False
            responses.append({
                "token_id": token_row.id,
                "status": "failed",
                "error": str(exc),
            })
            logger.warning(
                "Firebase push failed for user_id=%s token_id=%s: %s",
                user_id,
                token_row.id,
                exc,
            )

    db.flush()
    return {
        "total": len(token_rows),
        "sent": sent,
        "failed": failed,
        "configured": True,
        "responses": responses,
    }
