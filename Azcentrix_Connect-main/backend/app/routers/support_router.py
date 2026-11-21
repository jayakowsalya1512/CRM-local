"""Tenant-side support tickets: a signed-in tenant user raises a ticket to the platform team and lists their own.

The tenant is the one the request is signed in to (never taken from the body), so a user can only raise and see
tickets for their own tenant. Replies and satisfaction ratings are limited to the requester and the tenant's admins.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import _resolve_tenant_slug, get_current_user, get_request_ip
from app.models.all_models import User
from app.models.tenant import Tenant
from app.routers.platform_router import _write_platform_audit
from app.services import platform_support as support

router = APIRouter()
OPEN_LIMIT = 20   # open tickets one user may have at a time


def _tenant(request: Request, master_db: Session) -> Tenant:
    tenant = master_db.query(Tenant).filter(Tenant.slug == _resolve_tenant_slug(request)).first()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return tenant


class TicketBody(BaseModel):
    subject: str = Field(..., max_length=300)
    description: str = Field("", max_length=10000)
    priority: str = "Medium"


@router.post("/tickets", status_code=201)
def raise_ticket(body: TicketBody, request: Request, current_user: User = Depends(get_current_user), master_db: Session = Depends(get_master_db_dep)):
    tenant = _tenant(request, master_db)
    support.ensure_schema()
    from app.models.platform_support import PlatformSupportTicket
    open_count = master_db.query(PlatformSupportTicket.id).filter(PlatformSupportTicket.tenant_id == tenant.id, PlatformSupportTicket.user_id == current_user.id,
                                                                  PlatformSupportTicket.status == "open").count()
    if open_count >= OPEN_LIMIT:
        raise HTTPException(status_code=429, detail=f"You already have {open_count} open tickets – wait for a reply before raising more")
    try:
        ticket = support.raise_ticket(master_db, tenant, current_user, body.subject, body.description, body.priority)
    except support.SupportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    _write_platform_audit(master_db, None, "support_ticket_raised", "tenant", tenant.id, tenant.name,
                          f"Support ticket {ticket.ref} raised by {current_user.email or current_user.username}: {ticket.subject[:120]} ({ticket.priority})",
                          get_request_ip(request), new_data={"ticket": ticket.ref, "priority": ticket.priority, "user_id": current_user.id})
    master_db.commit()
    return support.ticket_dict(ticket, tenant.name)


@router.get("/tickets")
def my_tickets(request: Request, current_user: User = Depends(get_current_user), master_db: Session = Depends(get_master_db_dep)):
    return support.tenant_tickets(master_db, _tenant(request, master_db).id, current_user.id)


def _own_ticket(request: Request, current_user: User, master_db: Session, ticket_id: int):
    """The requester's ticket, or any ticket of the tenant for a tenant admin; 404 otherwise (no existence leak)."""
    tenant = _tenant(request, master_db)
    try:
        t = support.get_ticket(master_db, ticket_id, [tenant.id])
    except support.SupportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    if t.user_id != current_user.id and (current_user.role or "").lower() != "admin":
        raise HTTPException(status_code=404, detail="Ticket not found")
    return tenant, t


@router.get("/tickets/{ticket_id}")
def ticket_detail(ticket_id: int, request: Request, current_user: User = Depends(get_current_user), master_db: Session = Depends(get_master_db_dep)):
    _, t = _own_ticket(request, current_user, master_db, ticket_id)
    return support.ticket_detail(master_db, t)


class ReplyBody(BaseModel):
    body: str = Field(..., max_length=10000)


@router.post("/tickets/{ticket_id}/replies", status_code=201)
def reply(ticket_id: int, body: ReplyBody, request: Request, current_user: User = Depends(get_current_user), master_db: Session = Depends(get_master_db_dep)):
    tenant, t = _own_ticket(request, current_user, master_db, ticket_id)
    try:
        r = support.add_reply(master_db, t, "tenant", current_user.full_name or current_user.username, current_user.email, body.body)
    except support.SupportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    _write_platform_audit(master_db, None, "support_ticket_tenant_reply", "tenant", tenant.id, t.ref,
                          f"{current_user.email or current_user.username} replied to {t.ref}{' (reopened)' if r['reopened'] else ''}", get_request_ip(request),
                          new_data={"ticket": t.ref, "reply_id": r["id"], "reopened": r["reopened"], "user_id": current_user.id})
    master_db.commit()
    return r


class RatingBody(BaseModel):
    rating: int
    feedback: str = Field("", max_length=2000)


@router.post("/tickets/{ticket_id}/satisfaction", status_code=201)
def rate(ticket_id: int, body: RatingBody, request: Request, current_user: User = Depends(get_current_user), master_db: Session = Depends(get_master_db_dep)):
    from app.services import platform_sla as sla
    tenant, t = _own_ticket(request, current_user, master_db, ticket_id)
    try:
        row = sla.submit_csat(master_db, t, body.rating, body.feedback, current_user.email or current_user.username, "app")
    except sla.SlaError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    _write_platform_audit(master_db, None, "support_csat_submitted", "tenant", tenant.id, t.ref, f"CSAT {row.rating}/5 for {t.ref} by {row.submitted_by}",
                          get_request_ip(request), new_data={"ticket": t.ref, "rating": row.rating, "channel": "app"})
    master_db.commit()
    return sla.csat_dict(row)
