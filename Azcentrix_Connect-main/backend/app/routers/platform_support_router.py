"""Support Desk (Governance): open tickets and broadcast announcements (platform_support).

Under ``/support`` (Tenants permission: view to read, manage to broadcast, reply and resolve). Tenant-scoped staff see
their tenants' tickets and can broadcast only to their tenants.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.tenant import Tenant
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_support as support
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/support", dependencies=[Depends(enforce_platform_access)])
PAGE = 25


@router.get("")
def overview(request: Request, db: Session = Depends(get_master_db_dep)):
    allowed = scoped_tenant_ids(request)
    tenants = db.query(Tenant.id, Tenant.name).filter(Tenant.status != "cancelled")
    if allowed is not None:
        tenants = tenants.filter(Tenant.id.in_(allowed or [0]))
    return {"tickets": support.open_tickets(db, allowed, 0, PAGE), "announcements": support.announcements(db, allowed),
            "tenants": [{"id": t.id, "name": t.name} for t in tenants.order_by(Tenant.name).all()], "all_scope": allowed is None}


@router.get("/tickets")
def tickets(request: Request, offset: int = Query(0, ge=0), limit: int = Query(PAGE, ge=1, le=100), db: Session = Depends(get_master_db_dep)):
    return support.open_tickets(db, scoped_tenant_ids(request), offset, limit)


class BroadcastBody(BaseModel):
    audience: str = Field(..., max_length=40)
    title: str = Field(..., max_length=200)
    message: str = Field(..., max_length=5000)


@router.post("/announcements", status_code=201)
def broadcast(body: BroadcastBody, request: Request, db: Session = Depends(get_master_db_dep)):
    admin, ip = _get_platform_admin(request), get_request_ip(request)
    actor = getattr(admin, "email", None) or "platform admin"
    try:
        row = support.broadcast(db, body.audience, body.title, body.message, scoped_tenant_ids(request), actor)
    except support.SupportError as exc:
        if exc.status_code == 502:
            db.rollback()
            _write_platform_audit(db, admin, "broadcast_announcement_failed", "announcement", None, body.title[:200],
                                  f"Announcement '{body.title[:80]}' not delivered: {exc}", ip, new_data={"audience": body.audience})
            db.commit()
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    _write_platform_audit(db, admin, "broadcast_announcement", "announcement", row.id, row.title,
                          f"Announcement '{row.title[:80]}' sent to {row.audience_label}: {row.recipients} recipient(s) in {len(row.tenant_ids)} tenant(s)"
                          + (f", {len(row.failed)} unreachable" if row.failed else ""), ip,
                          new_data={"audience": row.audience_label, "title": row.title, "message": row.message, "tenant_ids": row.tenant_ids,
                                    "recipients": row.recipients, "failed": row.failed})
    db.commit()
    return support.announcement_dict(row)


def _ticket(db: Session, request: Request, ticket_id: int):
    allowed = scoped_tenant_ids(request)
    try:
        return support.get_ticket(db, ticket_id, list(allowed) if allowed is not None else None)
    except support.SupportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))


@router.get("/tickets/{ticket_id}")
def ticket(ticket_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    return support.ticket_detail(db, _ticket(db, request, ticket_id))


class ReplyBody(BaseModel):
    body: str = Field(..., max_length=10000)
    resolve: bool = False


@router.post("/tickets/{ticket_id}/replies", status_code=201)
def reply(ticket_id: int, body: ReplyBody, request: Request, db: Session = Depends(get_master_db_dep)):
    t = _ticket(db, request, ticket_id)
    admin, ip = _get_platform_admin(request), get_request_ip(request)
    name = (getattr(admin, "full_name", None) or getattr(admin, "username", None) or "Platform support") if admin else "Platform support"
    try:
        r = support.add_reply(db, t, "staff", name, getattr(admin, "email", None), body.body)
        res = support.resolve(db, t, name) if body.resolve else None
    except support.SupportError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    _write_platform_audit(db, admin, "support_ticket_reply", "tenant", t.tenant_id, t.ref,
                          f"Replied to {t.ref}{' and resolved it' if res else ''} (e-mail: {r['email']})", ip,
                          new_data={"ticket": t.ref, "reply_id": r["id"], "resolved": bool(res), "email": r["email"]})
    db.commit()
    return {**r, "resolved": res, "ticket": support.ticket_detail(db, t)}


@router.post("/tickets/{ticket_id}/resolve")
def resolve(ticket_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    t = _ticket(db, request, ticket_id)
    admin, ip = _get_platform_admin(request), get_request_ip(request)
    name = (getattr(admin, "full_name", None) or getattr(admin, "username", None) or "Platform support") if admin else "Platform support"
    try:
        res = support.resolve(db, t, name)
    except support.SupportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    _write_platform_audit(db, admin, "support_ticket_resolved", "tenant", t.tenant_id, t.ref, f"Resolved {t.ref} (e-mail: {res['email']})", ip,
                          new_data={"ticket": t.ref, **res})
    db.commit()
    return {**res, "ticket": support.ticket_detail(db, t)}


@router.post("/tickets/{ticket_id}/reopen")
def reopen(ticket_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    t = _ticket(db, request, ticket_id)
    try:
        support.reopen(db, t)
    except support.SupportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    _write_platform_audit(db, _get_platform_admin(request), "support_ticket_reopened", "tenant", t.tenant_id, t.ref, f"Reopened {t.ref}",
                          get_request_ip(request), new_data={"ticket": t.ref})
    db.commit()
    return {"ticket": support.ticket_detail(db, t)}
