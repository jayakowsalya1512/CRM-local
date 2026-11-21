"""Announcements & maintenance (platform_announcements).

Platform: ``/api/v1/platform/announcements`` – Tenants permission (view to read, manage to publish / delete);
scheduling a maintenance window needs Change & Maintenance manage (it is a change on the calendar).
Tenant: ``/api/v1/announcements`` – the signed-in user's live feed for their own tenant and read receipts, merging
platform-broadcast posts (``p-<id>``) with announcements posted inside the tenant itself (``t-<id>``, see
app.services.tenant_announcements — gated by the ``announcements.create`` / ``announcements.delete`` permissions,
configured per role in Roles & Permissions). The tenant is the one the token was issued for (checked by
get_current_user), never taken from the request body.
"""

from __future__ import annotations

from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.core.timezone import as_ist_naive
from app.core.validators import NonBlank, SaneDate, field_error
from app.database import get_master_db_dep
from app.dependencies import _resolve_tenant_slug, get_current_user, get_request_ip, get_tenant_db, require_permission
from app.models.all_models import User
from app.models.tenant import Tenant
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_announcements as ann
from app.services import platform_changes as changes
from app.services import tenant_announcements as tenant_ann
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/announcements", dependencies=[Depends(enforce_platform_access)])
tenant_router = APIRouter(prefix="/api/v1/announcements")
PAGE = 20


def _fail(exc: Exception):
    status = getattr(exc, "status_code", 422)
    raise HTTPException(status_code=status, detail=str(exc))


def _schema(db: Session) -> None:
    """Create / migrate the tables before this request reads them. If that just happened, end the session's older
    snapshot (the access check already read from it) or MariaDB rejects the new columns with error 1412."""
    from app.services import platform_support as support
    fresh = not support._ready.get("schema") or not changes._schema_ready
    support.ensure_schema()
    changes.ensure_schema()
    if fresh:
        db.rollback()


@router.get("")
def overview(request: Request, offset: int = Query(0, ge=0), limit: int = Query(PAGE, ge=1, le=100), db: Session = Depends(get_master_db_dep)):
    _schema(db)
    allowed = scoped_tenant_ids(request)
    eligible = db.query(Tenant.id, Tenant.name).filter(Tenant.status.in_(ann.ELIGIBLE_STATUSES), Tenant.deletion_scheduled_at.is_(None))
    if allowed is not None:
        eligible = eligible.filter(Tenant.id.in_(allowed or {0}))
    return {
        "kpis": ann.kpis(db, allowed),
        "announcements": ann.announcements_page(db, allowed, offset, limit),
        "maintenance": ann.maintenance_windows(db),
        "tenants": [{"id": t.id, "name": t.name} for t in eligible.order_by(Tenant.name).all()],
        "scopes": ann.maintenance_scopes(),
        "all_scope": allowed is None,
    }


class AnnouncementBody(BaseModel):
    title: str = Field(..., max_length=200)
    message: str = Field(..., max_length=5000)
    type: str = Field(..., max_length=15)
    until: date
    audience: str = Field(..., max_length=40)


@router.post("", status_code=201)
def publish(body: AnnouncementBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    admin, ip = _get_platform_admin(request), get_request_ip(request)
    try:
        row = ann.publish(db, admin, body.title, body.message, body.type, body.until, body.audience, scoped_tenant_ids(request))
    except ann.AnnouncementError as exc:
        db.rollback()
        _fail(exc)
    _write_platform_audit(db, admin, "announcement_published", "announcement", row.id, row.title,
                          f"{row.kind} announcement '{row.title[:80]}' published to {row.audience_label}: {row.recipients} user(s) in "
                          f"{len(row.tenant_ids)} tenant(s), shown until {row.expires_on:%d %b %Y}" + (f"; {len(row.failed)} tenant(s) unreachable" if row.failed else ""),
                          ip, new_data={"type": row.kind, "audience": body.audience, "until": row.expires_on.isoformat(), "tenant_ids": row.tenant_ids})
    db.commit()
    return {"id": row.id, "audience": row.audience_label, "tenants": len(row.tenant_ids), "recipients": row.recipients, "failed": row.failed or []}


@router.delete("/{announcement_id}")
def delete(announcement_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    admin, ip = _get_platform_admin(request), get_request_ip(request)
    try:
        row = ann.get_feed_post(db, announcement_id, scoped_tenant_ids(request))
    except ann.AnnouncementError as exc:
        _fail(exc)
    old = {"title": row.title, "type": row.kind, "audience": row.audience_label, "until": row.expires_on.isoformat() if row.expires_on else None}
    db.delete(row)  # audience and read rows go with it (ON DELETE CASCADE)
    _write_platform_audit(db, admin, "announcement_deleted", "announcement", announcement_id, old["title"],
                          f"Announcement '{old['title'][:80]}' deleted – no longer shown to {old['audience']}", ip, old_data=old)
    db.commit()
    return {"deleted": announcement_id}


class MaintenanceBody(BaseModel):
    title: str = Field(..., max_length=500)
    date: date
    window: str = Field(..., max_length=40)
    scope: str = Field(..., max_length=80)
    notify: bool = True


@router.post("/maintenance", status_code=201)
def schedule_maintenance(body: MaintenanceBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    admin, ip = _get_platform_admin(request), get_request_ip(request)
    try:
        scope = ann.scope_label(body.scope)
        starts_at, ends_at = ann.parse_window(body.date, body.window)
        if body.notify:  # check the audience before anything is stored
            ann.resolve_audience(db, body.scope, scoped_tenant_ids(request))
        change = changes.create(db, admin, body.title, "Maintenance", body.date, ip, scope=scope, starts_at=starts_at, ends_at=ends_at)
    except (ann.AnnouncementError, changes.ChangeError) as exc:
        db.rollback()
        _fail(exc)
    notice, warning = None, None
    if body.notify:
        when = ann._when(change)
        try:
            notice = ann.publish(db, admin, f"Scheduled maintenance – {change.description}"[:200], f"Window: {when}. The app may be read-only.",
                                 "Maintenance", body.date, body.scope, scoped_tenant_ids(request), change_id=change.id)
            _write_platform_audit(db, admin, "announcement_published", "announcement", notice.id, notice.title,
                                  f"Maintenance notice for {changes.code(change)} published to {notice.audience_label}: {notice.recipients} user(s)",
                                  ip, new_data={"type": "Maintenance", "change": changes.code(change), "tenant_ids": notice.tenant_ids})
            db.commit()
        except ann.AnnouncementError as exc:
            db.rollback()
            warning = f"Window scheduled, but the tenant notice was not published: {exc}"
    return {"id": change.id, "code": changes.code(change), "status": ann.maintenance_status(change), "approval_required": change.status == "pending",
            "notice_id": notice.id if notice else None, "warning": warning}


# ─── Tenant side ─────────────────────────────────────────────────────────────

def _tenant(request: Request, master_db: Session) -> Tenant:
    tenant = master_db.query(Tenant).filter(Tenant.slug == _resolve_tenant_slug(request)).first()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return tenant


@tenant_router.get("")
def my_announcements(
    request: Request,
    current_user: User = Depends(get_current_user),
    master_db: Session = Depends(get_master_db_dep),
    tenant_db: Session = Depends(get_tenant_db),
):
    """The signed-in user's live feed: platform-broadcast posts (``p-<id>``) merged with
    announcements posted inside their own tenant (``t-<id>``), newest first."""
    _schema(master_db)
    platform_feed = ann.tenant_feed(master_db, _tenant(request, master_db).id, current_user.id)
    team_items = tenant_ann.feed(tenant_db, current_user)
    items = (
        [{**item, "id": f"p-{item['id']}"} for item in platform_feed["items"]]
        + [{**item, "id": f"t-{item['id']}"} for item in team_items]
    )
    items.sort(key=lambda item: item["posted_at"], reverse=True)
    return {"items": items, "unread": sum(1 for item in items if not item["read"])}


@tenant_router.post("/read-all")
def read_all(
    request: Request,
    current_user: User = Depends(get_current_user),
    master_db: Session = Depends(get_master_db_dep),
    tenant_db: Session = Depends(get_tenant_db),
):
    _schema(master_db)
    marked = ann.mark_read(master_db, _tenant(request, master_db).id, current_user.id, None)
    marked += tenant_ann.mark_read(tenant_db, current_user, None)
    master_db.commit()
    tenant_db.commit()
    return {"marked": marked}


@tenant_router.post("/{announcement_id}/read")
def read_one(
    announcement_id: str,
    request: Request,
    current_user: User = Depends(get_current_user),
    master_db: Session = Depends(get_master_db_dep),
    tenant_db: Session = Depends(get_tenant_db),
):
    source, _, raw_id = announcement_id.partition("-")
    try:
        numeric_id = int(raw_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Announcement not found")
    try:
        if source == "t":
            marked = tenant_ann.mark_read(tenant_db, current_user, numeric_id)
            tenant_db.commit()
        else:
            _schema(master_db)
            marked = ann.mark_read(master_db, _tenant(request, master_db).id, current_user.id, numeric_id)
            master_db.commit()
    except (ann.AnnouncementError, tenant_ann.AnnouncementError) as exc:
        _fail(exc)
    return {"marked": marked}


class TenantAnnouncementBody(BaseModel):
    title: NonBlank("Title", 3, 200)  # type: ignore[valid-type]
    message: NonBlank("Message", 1, 5000)  # type: ignore[valid-type]
    type: str = Field("Info", max_length=15)
    scheduled_at: datetime | None = None   # None = publish immediately
    until: SaneDate = None                 # optional "show until" expiry
    roles: list[str] | None = None         # None/empty = every role in the tenant

    @field_validator("type")
    @classmethod
    def _type(cls, v: str) -> str:
        if v not in ("Info", "Important", "Maintenance"):
            raise ValueError("Please select a type.")
        return v


@tenant_router.post("", status_code=201, dependencies=[Depends(require_permission("announcements.create"))])
def post_announcement(
    body: TenantAnnouncementBody,
    current_user: User = Depends(get_current_user),
    tenant_db: Session = Depends(get_tenant_db),
):
    if body.until is not None:
        start = as_ist_naive(body.scheduled_at) if body.scheduled_at else None
        if body.until < (start.date() if start else date.today()):
            raise field_error("until", "Show until must be on or after the posting date.")
    try:
        row = tenant_ann.create(tenant_db, current_user, body.title, body.message, body.type, as_ist_naive(body.scheduled_at), body.until, body.roles)
    except tenant_ann.AnnouncementError as exc:
        tenant_db.rollback()
        _fail(exc)
    tenant_db.commit()
    return {"id": f"t-{row.id}", "scheduled": bool(row.scheduled_at)}


@tenant_router.delete("/{announcement_id}", dependencies=[Depends(require_permission("announcements.delete"))])
def delete_announcement(announcement_id: str, tenant_db: Session = Depends(get_tenant_db)):
    source, _, raw_id = announcement_id.partition("-")
    if source != "t":
        raise HTTPException(status_code=403, detail="Platform announcements can only be deleted from the platform console")
    try:
        numeric_id = int(raw_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Announcement not found")
    try:
        tenant_ann.delete(tenant_db, numeric_id)
    except tenant_ann.AnnouncementError as exc:
        _fail(exc)
    tenant_db.commit()
    return {"deleted": announcement_id}
