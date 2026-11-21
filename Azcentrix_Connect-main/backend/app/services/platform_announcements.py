"""Announcements & maintenance (Command → Announcements & maintenance).

Announcements
    Posted by platform staff to an audience (all tenants, Enterprise-plan tenants, trial tenants or one tenant). The
    post lives in the platform database (``platform_announcements``, shared with Support Desk broadcasts); its audience
    is one ``platform_announcement_tenants`` row per eligible tenant, with that tenant's active users at publish time
    (the reach). Tenant users see live posts (not past "Show until") in the footer Announcements panel and the newest
    unread Important / Maintenance one as a dashboard banner; opening or dismissing one records a read
    (``platform_announcement_reads``, one per user). Nothing is emailed or pushed.
Maintenance windows
    Scheduled as Maintenance changes on the change calendar (``platform_changes``), so they follow the Change &
    maintenance approval queue, freeze rules and audit trail. Scheduling never stops or restarts anything.
"""

from __future__ import annotations

import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import and_, exists, func, or_, select, text
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.orm import Session

from app.database import get_tenant_session
from app.models.platform_change import PlatformChange
from app.models.platform_support import PlatformAnnouncement, PlatformAnnouncementRead, PlatformAnnouncementTenant
from app.models.tenant import Plan, Tenant
from app.services import platform_changes as changes
from app.services import platform_support as support

logger = logging.getLogger(__name__)

KINDS = ("Info", "Important", "Maintenance")
AUDIENCES = {"all": "All tenants", "enterprise": "Enterprise plans", "trial": "Trial tenants"}
ELIGIBLE_STATUSES = ("active", "trial")      # suspended and cancelled tenants can't sign in, so they get nothing
MAX_DAYS = 365
IST = timezone(timedelta(hours=5, minutes=30))
_WINDOW = re.compile(r"^\s*(\d{1,2}):(\d{2})\s*(?:–|—|-|to)\s*(\d{1,2}):(\d{2})\s*(?:IST)?\s*$", re.I)
MAINT_SCOPES = {"all": "All tenants", "enterprise": "Enterprise tenants"}


class AnnouncementError(Exception):
    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


def _utc(value: Optional[datetime]) -> Optional[str]:
    return f"{value.replace(microsecond=0).isoformat()}Z" if value else None


def _live(today: date):
    """Feed posts that are still shown (Show until is today or later)."""
    return and_(PlatformAnnouncement.kind.isnot(None),
                or_(PlatformAnnouncement.expires_on.is_(None), PlatformAnnouncement.expires_on >= today))


def _in_scope(allowed: Optional[set[int]]):
    """Posts whose whole audience is inside a tenant-scoped staff member's tenants (None: every post)."""
    if allowed is None:
        return None
    outside = select(PlatformAnnouncementTenant.announcement_id).where(
        PlatformAnnouncementTenant.announcement_id == PlatformAnnouncement.id,
        PlatformAnnouncementTenant.tenant_id.notin_(allowed or {0}))
    return ~exists(outside)


# ─── Audience ────────────────────────────────────────────────────────────────

def region_options() -> list[str]:
    from app.services.platform_infrastructure import DEFAULT_REGION, server_inventory
    return list(dict.fromkeys((s.get("region") or DEFAULT_REGION) for s in server_inventory() if s.get("db_host")))


def resolve_audience(db: Session, audience: str, allowed: Optional[set[int]]) -> tuple[list[Tenant], str]:
    """Eligible tenants for an audience key: all | enterprise | trial | tenant:<id> | region:<name>."""
    q = db.query(Tenant).filter(Tenant.status.in_(ELIGIBLE_STATUSES), Tenant.deletion_scheduled_at.is_(None))
    if allowed is not None:
        q = q.filter(Tenant.id.in_(allowed or {0}))
    if audience == "all":
        return q.order_by(Tenant.name).all(), AUDIENCES["all"]
    if audience == "trial":
        return q.filter(Tenant.status == "trial").order_by(Tenant.name).all(), AUDIENCES["trial"]
    if audience == "enterprise":
        q = q.join(Plan, Plan.id == Tenant.plan_id).filter(or_(func.lower(Plan.name).like("%enterprise%"), func.lower(Plan.slug).like("%enterprise%")))
        return q.order_by(Tenant.name).all(), AUDIENCES["enterprise"]
    if audience.startswith("tenant:"):
        try:
            tenant_id = int(audience.split(":", 1)[1])
        except ValueError:
            raise AnnouncementError("Unknown audience")
        if allowed is not None and tenant_id not in allowed:
            raise AnnouncementError("This tenant is outside your assigned scope", 403)
        tenant = db.get(Tenant, tenant_id)
        if tenant is None:
            raise AnnouncementError("Tenant not found", 404)
        if tenant.status not in ELIGIBLE_STATUSES or tenant.deletion_scheduled_at is not None:
            raise AnnouncementError(f"{tenant.name} is {'scheduled for deletion' if tenant.deletion_scheduled_at else tenant.status} – its users can't see announcements", 409)
        return [tenant], tenant.name
    if audience.startswith("region:"):
        from app.services.platform_infrastructure import database_placements
        region = audience.split(":", 1)[1]
        placements = database_placements()
        servers = {name for name, s in placements["servers"].items() if s["region"] == region}
        tenants = [t for t in q.order_by(Tenant.name).all() if placements["databases"].get(t.db_name, {}).get("server") in servers]
        return tenants, f"Tenants in {region}"
    raise AnnouncementError("Unknown audience")


def _active_users(tenant: Tenant) -> int:
    session = get_tenant_session(tenant.slug)
    try:
        return int(session.execute(text("SELECT COUNT(*) FROM users WHERE is_active = 1")).scalar_one())
    finally:
        session.close()


# ─── Publish / delete ────────────────────────────────────────────────────────

def validate_post(title: str, message: str, kind: str, expires_on: Optional[date]) -> tuple[str, str]:
    title, message = " ".join((title or "").split()), (message or "").strip()
    if not title:
        raise AnnouncementError("Add a title")
    if len(title) > 200:
        raise AnnouncementError("The title can be at most 200 characters")
    if not message:
        raise AnnouncementError("Add a message")
    if kind not in KINDS:
        raise AnnouncementError(f"Type must be one of {', '.join(KINDS)}")
    today = date.today()
    if expires_on is None:
        raise AnnouncementError("Choose the last day to show it")
    if expires_on < today:
        raise AnnouncementError("“Show until” can't be in the past")
    if expires_on > today + timedelta(days=MAX_DAYS):
        raise AnnouncementError(f"“Show until” must be within the next {MAX_DAYS} days")
    return title, message


def publish(db: Session, admin, title: str, message: str, kind: str, expires_on: Optional[date], audience: str,
            allowed: Optional[set[int]], change_id: Optional[int] = None) -> PlatformAnnouncement:
    """Store the post and its audience (flushed, not committed). Tenants whose database can't be reached are skipped."""
    support.ensure_schema()
    title, message = validate_post(title, message, kind, expires_on)
    tenants, label = resolve_audience(db, audience, allowed)
    if not tenants:
        raise AnnouncementError(f"No active or trial tenants match “{label}”", 409)
    reach, failed = {}, []
    with ThreadPoolExecutor(max_workers=min(8, len(tenants))) as pool:
        for tenant, result in zip(tenants, pool.map(lambda t: _safe_count(t), tenants)):
            if isinstance(result, int):
                reach[tenant.id] = result
            else:
                failed.append({"tenant_id": tenant.id, "tenant": tenant.name, "error": result})
    if not reach:
        raise AnnouncementError(f"Not published – no tenant database could be reached ({', '.join(f['tenant'] for f in failed)})", 502)
    row = PlatformAnnouncement(title=title, message=message, kind=kind, expires_on=expires_on, audience=audience.split(":")[0][:20],
                               audience_label=label[:250], tenant_ids=list(reach), recipients=sum(reach.values()), failed=failed or None,
                               sent_by=(admin.full_name or admin.username) if admin else "Platform", published_by_id=admin.id if admin else None,
                               sent_at=datetime.utcnow(), change_id=change_id)
    db.add(row)
    db.flush()
    db.add_all([PlatformAnnouncementTenant(announcement_id=row.id, tenant_id=tid, recipients=n) for tid, n in reach.items()])
    db.flush()
    return row


def _safe_count(tenant: Tenant):
    try:
        return _active_users(tenant)
    except Exception as exc:  # noqa: BLE001 - one unreachable tenant database must not stop the others
        logger.warning("Announcement reach for %s failed: %s", tenant.slug, exc)
        return str(exc)[:200]


def get_feed_post(db: Session, announcement_id: int, allowed: Optional[set[int]]) -> PlatformAnnouncement:
    support.ensure_schema()
    q = db.query(PlatformAnnouncement).filter(PlatformAnnouncement.id == announcement_id, PlatformAnnouncement.kind.isnot(None))
    scope = _in_scope(allowed)
    if scope is not None:
        q = q.filter(scope)
    row = q.first()
    if row is None:
        raise AnnouncementError("Announcement not found", 404)
    return row


# ─── Page data ───────────────────────────────────────────────────────────────

def _reach_and_reads(db: Session, ids: list[int]) -> tuple[dict[int, int], dict[int, int]]:
    """Recipients and reads per announcement – two grouped queries for any number of posts."""
    if not ids:
        return {}, {}
    reach = dict(db.query(PlatformAnnouncementTenant.announcement_id, func.sum(PlatformAnnouncementTenant.recipients))
                 .filter(PlatformAnnouncementTenant.announcement_id.in_(ids)).group_by(PlatformAnnouncementTenant.announcement_id).all())
    reads = dict(db.query(PlatformAnnouncementRead.announcement_id, func.count(PlatformAnnouncementRead.id))
                 .filter(PlatformAnnouncementRead.announcement_id.in_(ids)).group_by(PlatformAnnouncementRead.announcement_id).all())
    return {k: int(v or 0) for k, v in reach.items()}, {k: int(v) for k, v in reads.items()}


def _rate(reads: int, recipients: int) -> Optional[float]:
    return round(min(100.0, reads / recipients * 100), 1) if recipients else None


def announcements_page(db: Session, allowed: Optional[set[int]], offset: int, limit: int) -> dict:
    support.ensure_schema()
    q = db.query(PlatformAnnouncement).filter(PlatformAnnouncement.kind.isnot(None))
    scope = _in_scope(allowed)
    if scope is not None:
        q = q.filter(scope)
    total = q.order_by(None).count()
    rows = q.order_by(PlatformAnnouncement.sent_at.desc(), PlatformAnnouncement.id.desc()).offset(offset).limit(limit).all()
    reach, reads = _reach_and_reads(db, [a.id for a in rows])
    today = date.today()
    items = [{
        "id": a.id, "title": a.title, "message": a.message, "type": a.kind, "posted_by": a.sent_by, "posted_at": _utc(a.sent_at),
        "until": a.expires_on.isoformat() if a.expires_on else None, "live": a.expires_on is None or a.expires_on >= today,
        "audience": a.audience_label, "tenants": len(a.tenant_ids or []), "recipients": reach.get(a.id, 0), "reads": reads.get(a.id, 0),
        "read_rate": _rate(reads.get(a.id, 0), reach.get(a.id, 0)), "failed": a.failed or [], "maintenance_change_id": a.change_id,
    } for a in rows]
    return {"items": items, "total": total, "offset": offset, "limit": limit}


def kpis(db: Session, allowed: Optional[set[int]]) -> dict:
    support.ensure_schema()
    today = date.today()
    live = db.query(PlatformAnnouncement.id).filter(_live(today))
    scope = _in_scope(allowed)
    if scope is not None:
        live = live.filter(scope)
    live_ids = [r[0] for r in live.all()]
    reach, reads = _reach_and_reads(db, live_ids)
    # Users reached: each targeted tenant's users counted once (the largest reach recorded for that tenant).
    users = 0
    if live_ids:
        per_tenant = (db.query(PlatformAnnouncementTenant.tenant_id, func.max(PlatformAnnouncementTenant.recipients).label("n"))
                      .filter(PlatformAnnouncementTenant.announcement_id.in_(live_ids)).group_by(PlatformAnnouncementTenant.tenant_id).subquery())
        users = int(db.query(func.coalesce(func.sum(per_tenant.c.n), 0)).scalar() or 0)
    rates = [r for r in (_rate(reads.get(i, 0), reach.get(i, 0)) for i in live_ids) if r is not None]
    return {"live": len(live_ids), "users_reached": users, "avg_read_rate": round(sum(rates) / len(rates), 1) if rates else None,
            "upcoming_maintenance": upcoming_maintenance(db)}


# ─── Maintenance windows ─────────────────────────────────────────────────────

def _maintenance_query(db: Session):
    changes.ensure_schema()
    return db.query(PlatformChange).filter(PlatformChange.type == "Maintenance")


def upcoming_maintenance(db: Session) -> int:
    now = datetime.utcnow()
    return (_maintenance_query(db).filter(PlatformChange.status.in_(changes.ACTIVE), PlatformChange.executed_at.is_(None),
                                         or_(PlatformChange.ends_at > now, and_(PlatformChange.ends_at.is_(None), PlatformChange.window_start >= date.today())))
            .order_by(None).count())


def maintenance_status(c: PlatformChange, now: Optional[datetime] = None) -> str:
    if c.status == "pending":
        return "Awaiting approval"
    if c.status != "approved":
        return changes.APPROVAL_LABEL.get(c.status, c.status.title())
    now = now or datetime.utcnow()
    start = c.starts_at or datetime.combine(c.window_start, datetime.min.time())
    end = c.ends_at or datetime.combine(c.window_end, datetime.max.time())
    return "Scheduled" if now < start else "In progress" if now < end else "Completed"


def _when(c: PlatformChange) -> str:
    if c.starts_at and c.ends_at:
        s = c.starts_at.replace(tzinfo=timezone.utc).astimezone(IST)
        e = c.ends_at.replace(tzinfo=timezone.utc).astimezone(IST)
        return f"{s:%d %b %Y} {s:%H:%M} – {e:%H:%M} IST"
    return c.window_start.strftime("%d %b %Y")


def maintenance_windows(db: Session, limit: int = 50) -> list[dict]:
    rows = (_maintenance_query(db).filter(PlatformChange.status != "cancelled")
            .order_by(PlatformChange.window_start.desc(), PlatformChange.id.desc()).limit(limit).all())
    now = datetime.utcnow()
    return [{"id": c.id, "code": changes.code(c), "title": c.description, "when": _when(c), "scope": c.scope, "status": maintenance_status(c, now),
             "starts_at": _utc(c.starts_at), "ends_at": _utc(c.ends_at)} for c in rows]


def maintenance_scopes() -> list[dict]:
    return [{"key": k, "label": v} for k, v in MAINT_SCOPES.items()] + [{"key": f"region:{r}", "label": r} for r in region_options()]


def parse_window(day: date, window: str) -> tuple[datetime, datetime]:
    """'02:00 – 04:00 IST' on ``day`` → (start, end) as naive UTC."""
    m = _WINDOW.match(window or "")
    if not m:
        raise AnnouncementError("Enter the window as HH:MM – HH:MM, e.g. 02:00 – 04:00 IST")
    h1, m1, h2, m2 = (int(x) for x in m.groups())
    if h1 > 23 or h2 > 23 or m1 > 59 or m2 > 59:
        raise AnnouncementError("Enter valid times between 00:00 and 23:59")
    start = datetime(day.year, day.month, day.day, h1, m1, tzinfo=IST)
    end = datetime(day.year, day.month, day.day, h2, m2, tzinfo=IST)
    if end <= start:
        raise AnnouncementError("The window must end after it starts (same day)")
    if start <= datetime.now(timezone.utc):
        raise AnnouncementError("The window must start in the future")
    return start.astimezone(timezone.utc).replace(tzinfo=None), end.astimezone(timezone.utc).replace(tzinfo=None)


def scope_label(key: str) -> str:
    if key in MAINT_SCOPES:
        return MAINT_SCOPES[key]
    if key.startswith("region:") and key.split(":", 1)[1] in region_options():
        return key.split(":", 1)[1]
    raise AnnouncementError("Unknown scope")


# ─── Tenant feed ─────────────────────────────────────────────────────────────

def tenant_feed(db: Session, tenant_id: int, user_id: int, limit: int = 50) -> dict:
    """Live posts for one tenant with the user's read flag – one query, joined on the tenant's audience rows."""
    support.ensure_schema()
    today = date.today()
    rows = (db.query(PlatformAnnouncement, PlatformAnnouncementRead.read_at)
            .join(PlatformAnnouncementTenant, and_(PlatformAnnouncementTenant.announcement_id == PlatformAnnouncement.id,
                                                   PlatformAnnouncementTenant.tenant_id == tenant_id))
            .outerjoin(PlatformAnnouncementRead, and_(PlatformAnnouncementRead.announcement_id == PlatformAnnouncement.id,
                                                      PlatformAnnouncementRead.tenant_id == tenant_id, PlatformAnnouncementRead.user_id == user_id))
            .filter(_live(today))
            .order_by(PlatformAnnouncement.sent_at.desc(), PlatformAnnouncement.id.desc()).limit(limit).all())
    items = [{"id": a.id, "title": a.title, "message": a.message, "type": a.kind, "posted_at": _utc(a.sent_at), "posted_by": "Platform team",
              "until": a.expires_on.isoformat() if a.expires_on else None, "read": read_at is not None} for a, read_at in rows]
    return {"items": items, "unread": sum(1 for i in items if not i["read"])}


def mark_read(db: Session, tenant_id: int, user_id: int, announcement_id: Optional[int]) -> int:
    """Record reads for one live post (or all live posts) of this tenant; repeats are ignored by the unique key."""
    support.ensure_schema()
    q = (db.query(PlatformAnnouncement.id)
         .join(PlatformAnnouncementTenant, and_(PlatformAnnouncementTenant.announcement_id == PlatformAnnouncement.id,
                                                PlatformAnnouncementTenant.tenant_id == tenant_id))
         .filter(_live(date.today())))
    if announcement_id is not None:
        q = q.filter(PlatformAnnouncement.id == announcement_id)
    ids = [r[0] for r in q.all()]
    if announcement_id is not None and not ids:
        raise AnnouncementError("Announcement not found", 404)
    if not ids:
        return 0
    now = datetime.utcnow()
    stmt = mysql_insert(PlatformAnnouncementRead.__table__).prefix_with("IGNORE").values(
        [{"announcement_id": i, "tenant_id": tenant_id, "user_id": user_id, "read_at": now} for i in ids])
    return db.execute(stmt).rowcount
