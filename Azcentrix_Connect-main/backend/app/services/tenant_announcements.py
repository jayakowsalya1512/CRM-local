"""Tenant-internal announcements — a user inside a tenant posting to their own colleagues
(``announcements.create``), as opposed to platform-broadcast announcements which come down
from the platform console (see app.services.platform_announcements). Lives in the tenant's
own database, next to roles/permissions, so it follows the same per-tenant isolation as
everything else in this module.

Scheduling: a post with ``scheduled_at`` in the future is stored immediately but excluded
from the feed query until that time arrives — no background job needed, the "schedule" is
just a filter checked on every read.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Optional, Sequence

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.timezone import now_ist
from app.models.all_models import TenantAnnouncement, TenantAnnouncementRead, User

KINDS = ("Info", "Important", "Maintenance")
MAX_DAYS_AHEAD = 365


class AnnouncementError(Exception):
    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


def _visible_to_role(row: TenantAnnouncement, role: str) -> bool:
    targets = row.target_roles or []
    return not targets or role in targets


def create(
    db: Session,
    current_user: User,
    title: str,
    message: str,
    kind: str,
    scheduled_at: Optional[datetime],
    expires_on: Optional[date],
    target_roles: Optional[Sequence[str]],
) -> TenantAnnouncement:
    title = " ".join((title or "").split())
    message = (message or "").strip()
    if not title:
        raise AnnouncementError("Title is required")
    if not message:
        raise AnnouncementError("Message is required")
    if kind not in KINDS:
        raise AnnouncementError("Unknown announcement type")
    now = now_ist()
    if scheduled_at and scheduled_at < now - timedelta(minutes=1):
        raise AnnouncementError("Scheduled time can't be in the past")
    if scheduled_at and scheduled_at > now + timedelta(days=MAX_DAYS_AHEAD):
        raise AnnouncementError(f"Can't schedule more than {MAX_DAYS_AHEAD} days ahead")
    if expires_on and expires_on < now.date():
        raise AnnouncementError("Show until can't be in the past")

    row = TenantAnnouncement(
        title=title[:200],
        message=message[:5000],
        kind=kind,
        created_by=current_user.id,
        created_by_name=current_user.full_name or current_user.username,
        scheduled_at=scheduled_at,
        expires_on=expires_on,
        target_roles=list(dict.fromkeys(target_roles)) if target_roles else None,
    )
    db.add(row)
    db.flush()
    return row


def _due(now: datetime):
    """Rows whose schedule has arrived and have not expired — the live feed."""
    today = now.date()
    return (
        or_(TenantAnnouncement.scheduled_at.is_(None), TenantAnnouncement.scheduled_at <= now),
        or_(TenantAnnouncement.expires_on.is_(None), TenantAnnouncement.expires_on >= today),
    )


def feed(db: Session, current_user: User, limit: int = 50) -> list[dict]:
    now = now_ist()
    due_scheduled, not_expired = _due(now)
    rows = (
        db.query(TenantAnnouncement)
        .filter(due_scheduled, not_expired)
        .order_by(TenantAnnouncement.created_at.desc(), TenantAnnouncement.id.desc())
        .limit(limit * 2)  # role filtering happens in Python; over-fetch a little before trimming
        .all()
    )
    rows = [r for r in rows if _visible_to_role(r, current_user.role)][:limit]
    ids = [r.id for r in rows]
    read_ids: set[int] = set()
    if ids:
        read_ids = {
            row.announcement_id
            for row in db.query(TenantAnnouncementRead.announcement_id).filter(
                TenantAnnouncementRead.user_id == current_user.id,
                TenantAnnouncementRead.announcement_id.in_(ids),
            ).all()
        }
    return [
        {
            "id": r.id,
            "title": r.title,
            "message": r.message,
            "type": r.kind,
            "posted_at": (r.scheduled_at or r.created_at).isoformat(),
            "posted_by": r.created_by_name or "—",
            "until": r.expires_on.isoformat() if r.expires_on else None,
            "read": r.id in read_ids,
        }
        for r in rows
    ]


def mark_read(db: Session, current_user: User, announcement_id: Optional[int]) -> int:
    """Record a read for one live post (or every live post the user can see)."""
    now = now_ist()
    due_scheduled, not_expired = _due(now)
    q = db.query(TenantAnnouncement.id).filter(due_scheduled, not_expired)
    if announcement_id is not None:
        q = q.filter(TenantAnnouncement.id == announcement_id)
    live_ids = {row[0] for row in q.all()}
    if announcement_id is not None and not live_ids:
        raise AnnouncementError("Announcement not found", 404)

    already_read = {
        row.announcement_id
        for row in db.query(TenantAnnouncementRead.announcement_id).filter(
            TenantAnnouncementRead.user_id == current_user.id,
            TenantAnnouncementRead.announcement_id.in_(live_ids),
        ).all()
    } if live_ids else set()

    marked = 0
    for announcement_id_ in live_ids - already_read:
        db.add(TenantAnnouncementRead(announcement_id=announcement_id_, user_id=current_user.id))
        marked += 1
    return marked


def delete(db: Session, announcement_id: int) -> TenantAnnouncement:
    row = db.get(TenantAnnouncement, announcement_id)
    if row is None:
        raise AnnouncementError("Announcement not found", 404)
    db.delete(row)  # reads go with it (ON DELETE CASCADE)
    return row
