"""Tenant-side webhook endpoints: tenant admins register, list and remove the URLs their events are delivered to.

The tenant is the one the request is signed in to. The signing secret is returned once, when the endpoint is created.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import _resolve_tenant_slug, get_current_user, get_request_ip
from app.models.all_models import User
from app.models.platform_api import PlatformWebhookEndpoint
from app.models.tenant import Tenant
from app.routers.platform_router import _write_platform_audit
from app.services import platform_webhooks as wh

router = APIRouter()


def _tenant_admin(request: Request, user: User, master_db: Session) -> Tenant:
    if (user.role or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Only tenant administrators can manage webhooks")
    tenant = master_db.query(Tenant).filter(Tenant.slug == _resolve_tenant_slug(request)).first()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return tenant


class EndpointBody(BaseModel):
    url: str = Field(..., max_length=500)
    events: list[str] = Field(default_factory=lambda: list(wh.EVENTS))


@router.get("/events")
def events():
    return {"events": list(wh.EVENTS), "signature": "X-Azcentrix-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, '<t>.<raw body>')>",
            "event_id_header": "X-Azcentrix-Event-Id"}


@router.get("/endpoints")
def list_endpoints(request: Request, current_user: User = Depends(get_current_user), master_db: Session = Depends(get_master_db_dep)):
    tenant = _tenant_admin(request, current_user, master_db)
    wh.ensure_schema()
    rows = master_db.query(PlatformWebhookEndpoint).filter(PlatformWebhookEndpoint.tenant_id == tenant.id, PlatformWebhookEndpoint.is_active == True).all()  # noqa: E712
    return [wh.endpoint_dict(e) for e in rows]


@router.post("/endpoints", status_code=201)
def create_endpoint(body: EndpointBody, request: Request, current_user: User = Depends(get_current_user), master_db: Session = Depends(get_master_db_dep)):
    tenant = _tenant_admin(request, current_user, master_db)
    try:
        row, secret = wh.create_endpoint(master_db, tenant, body.url, body.events, current_user.id)
    except wh.WebhookError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    _write_platform_audit(master_db, None, "webhook_endpoint_created", "tenant", tenant.id, tenant.name,
                          f"Webhook endpoint {row.url} added by {current_user.email or current_user.username} ({', '.join(row.events)})",
                          get_request_ip(request), new_data={"endpoint_id": row.id, "url": row.url, "events": row.events})
    master_db.commit()
    return {**wh.endpoint_dict(row), "secret": secret, "secret_note": "Store this secret now – it is not shown again."}


@router.delete("/endpoints/{endpoint_id}")
def delete_endpoint(endpoint_id: int, request: Request, current_user: User = Depends(get_current_user), master_db: Session = Depends(get_master_db_dep)):
    tenant = _tenant_admin(request, current_user, master_db)
    wh.ensure_schema()
    row = master_db.get(PlatformWebhookEndpoint, endpoint_id)
    if row is None or row.tenant_id != tenant.id or not row.is_active:
        raise HTTPException(status_code=404, detail="Endpoint not found")
    row.is_active = False
    _write_platform_audit(master_db, None, "webhook_endpoint_removed", "tenant", tenant.id, tenant.name,
                          f"Webhook endpoint {row.url} removed by {current_user.email or current_user.username}", get_request_ip(request))
    master_db.commit()
    return {"removed": endpoint_id}
