"""Deliver saved note reminders even when the owner's browser is closed."""
import logging

from app.core.timezone import now_ist
from app.database import MasterSessionLocal, get_tenant_session_by_db_name
from app.models.all_models import Notification, StickyNote
from app.models.tenant import Tenant
from app.services.cache_service import invalidate_notifications_cache

logger = logging.getLogger(__name__)


def deliver_due_reminders(db):
    from app.routers.notes_router import ensure_notes_schema
    ensure_notes_schema(db)   # sticky_notes gained record-link columns (Notes & Pinboard)
    # Lock until both the notification and sent flag are committed. Multiple
    # application workers may run this maintenance at the same time.
    notes = db.query(StickyNote).filter(
        StickyNote.reminder_at <= now_ist(), StickyNote.reminder_sent.is_(False)
    ).with_for_update().all()
    owners = set()
    for note in notes:
        notification = db.query(Notification).filter_by(
            user_id=note.user_id, module="sticky_notes", record_id=note.id,
            action="sticky_note_reminder",
        ).first()
        if notification is None:
            notification = Notification(user_id=note.user_id, module="sticky_notes",
                                        record_id=note.id, action="sticky_note_reminder")
            db.add(notification)
        notification.title = "Sticky note reminder"
        notification.message = note.title
        notification.is_read = False
        notification.created_at = now_ist()
        note.reminder_sent = True
        owners.add(note.user_id)
    db.commit()
    for user_id in owners:
        invalidate_notifications_cache(db, user_id)
    return len(notes)


def run_sticky_note_reminders():
    with MasterSessionLocal() as master:
        tenants = master.query(Tenant).filter(Tenant.status.in_(["active", "trial"])).all()
        for tenant in tenants:
            try:
                with get_tenant_session_by_db_name(tenant.db_name) as db:
                    db.info['tenant_slug'] = tenant.slug
                    deliver_due_reminders(db)
            except Exception:
                logger.exception("Sticky note reminders failed for tenant %s", tenant.slug)
