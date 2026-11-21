"""Celery tasks that perform the actual notification email/push send.

Each task opens its own tenant DB session (the request thread's session
cannot cross into the worker process) and reuses the existing, unmodified
notification_service / push_notification_service functions.
"""

import logging
from typing import Optional

from app.celery_app import celery_app
from app.database import get_tenant_session

logger = logging.getLogger(__name__)


@celery_app.task(name="notifications.send_email", max_retries=3, default_retry_delay=30)
def send_notification_email_task(
    tenant_slug: str,
    user_id: int,
    title: str,
    message: str,
    module: Optional[str] = None,
    action: Optional[str] = None,
    action_url: Optional[str] = None,
    category: Optional[str] = None,
) -> bool:
    from app.services.notification_service import send_notification_email

    db = get_tenant_session(tenant_slug)
    try:
        return send_notification_email(
            db,
            user_id,
            title=title,
            message=message,
            module=module,
            action=action,
            action_url=action_url,
            category=category,
        )
    finally:
        db.close()


@celery_app.task(name="notifications.send_push", max_retries=3, default_retry_delay=30)
def send_push_notification_task(
    tenant_slug: str,
    user_id: int,
    title: str,
    body: str,
    data: Optional[dict] = None,
) -> dict:
    from app.services.push_notification_service import send_push_to_user

    db = get_tenant_session(tenant_slug)
    try:
        return send_push_to_user(db, user_id=user_id, title=title, body=body, data=data)
    finally:
        db.close()
