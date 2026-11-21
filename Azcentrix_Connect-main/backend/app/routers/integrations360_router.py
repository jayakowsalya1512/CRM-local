"""Marketplace & API (prototype v17 R.integrations).  Mounted at /api/v1/integrations360

Marketplace      GET /marketplace · POST /marketplace/{key}/connect · PUT /marketplace/{key} · DELETE /marketplace/{key}/connect
API & webhooks   GET /api-keys · POST /api-keys · DELETE /api-keys/{id}
                 GET /webhooks · POST /webhooks · DELETE /webhooks/{id}
Connected apps   GET /connected-apps · DELETE /connected-apps/{app_id}

Reads need integrations.view (or admin / ceo / manager / vp); writes need integrations.manage (or admin / ceo).
The inbound lead-capture webhooks stay on /api/v1/integrations (lead_integrations_router).
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.logging import log_audit_db
from app.database import get_master_db_dep
from app.dependencies import get_current_user, get_request_ip, get_tenant_db, user_has_permission
from app.models.all_models import User
from app.models.tenant import Tenant
from app.services import integrations360_service as S

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Marketplace & API"])
ADMIN_ROLES = ("admin", "ceo")
VIEW_ROLES = ("admin", "ceo", "manager", "vp")


def viewer(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if (cu.role or "") not in VIEW_ROLES and not user_has_permission(db, cu, "integrations.view"):
        raise HTTPException(403, "You don't have access to Marketplace & API")
    S.ensure_schema(db)
    return cu


def manager(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if (cu.role or "") not in ADMIN_ROLES and not user_has_permission(db, cu, "integrations.manage"):
        raise HTTPException(403, "You don't have permission to manage integrations")
    S.ensure_schema(db)
    return cu


def _tenant(request: Request, master_db: Session, required: bool = True) -> Optional[Tenant]:
    slug = getattr(request.state, "tenant_slug", None)
    t = master_db.query(Tenant).filter(Tenant.slug == slug).first() if slug else None
    if t is None and required:
        raise HTTPException(404, "Tenant not found")
    return t


def _audit(db: Session, request: Request, cu: User, action: str, rid: Optional[int], text: str) -> None:
    try:
        log_audit_db(db, cu.id, "integrations", action, rid, get_request_ip(request), text)
        db.commit()
    except Exception as exc:  # pragma: no cover
        logger.warning("integrations audit failed: %s", exc)
        db.rollback()


# ─── Marketplace ──────────────────────────────────────────────────────────────

class ConnectIn(BaseModel):
    client_id: str = Field(..., max_length=300)
    secret: str = Field(..., max_length=500)


class ConfigureIn(BaseModel):
    sync: str = Field(..., max_length=40)


@router.get("/marketplace")
def get_marketplace(request: Request, db: Session = Depends(get_tenant_db), master_db: Session = Depends(get_master_db_dep), cu: User = Depends(viewer)):
    t = _tenant(request, master_db, required=False)
    out = S.marketplace(db, master_db, t)
    out["company"] = t.name if t else "Workspace"
    out["can_manage"] = (cu.role or "") in ADMIN_ROLES or user_has_permission(db, cu, "integrations.manage")
    return out


@router.post("/marketplace/{key}/connect")
def connect(key: str, body: ConnectIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    S.connect(db, cu, key, body.client_id, body.secret)
    _audit(db, request, cu, "connect", None, f"{S.CAT_BY_KEY[key][0]} connected")
    return {"ok": True}


@router.put("/marketplace/{key}")
def configure(key: str, body: ConfigureIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    S.configure(db, cu, key, body.sync)
    _audit(db, request, cu, "configure", None, f"{S.CAT_BY_KEY[key][0]}: sync {body.sync}")
    return {"ok": True}


@router.delete("/marketplace/{key}/connect")
def disconnect(key: str, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(manager)):
    S.disconnect(db, cu, key)
    _audit(db, request, cu, "disconnect", None, f"{S.CAT_BY_KEY[key][0]} disconnected")
    return {"ok": True}


# ─── API keys ─────────────────────────────────────────────────────────────────

class ApiKeyIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    scope: str = "rw"          # rw | ro


@router.get("/api-keys")
def get_api_keys(request: Request, master_db: Session = Depends(get_master_db_dep), _: User = Depends(viewer)):
    return {"items": S.api_keys(master_db, _tenant(request, master_db))}


@router.post("/api-keys", status_code=201)
def post_api_key(body: ApiKeyIn, request: Request, db: Session = Depends(get_tenant_db), master_db: Session = Depends(get_master_db_dep), cu: User = Depends(manager)):
    item, raw = S.create_api_key(master_db, _tenant(request, master_db), cu, body.name, body.scope)
    _audit(db, request, cu, "api_key_create", item["id"], f"API key “{body.name}” generated ({item['s']})")
    return {"item": item, "key": raw}


@router.delete("/api-keys/{key_id}")
def delete_api_key(key_id: int, request: Request, db: Session = Depends(get_tenant_db), master_db: Session = Depends(get_master_db_dep), cu: User = Depends(manager)):
    S.revoke_api_key(master_db, _tenant(request, master_db), cu, key_id)
    _audit(db, request, cu, "api_key_revoke", key_id, "API key revoked")
    return {"ok": True}


# ─── Webhooks ─────────────────────────────────────────────────────────────────

class WebhookIn(BaseModel):
    url: str = Field(..., min_length=8, max_length=500)
    events: list[str] = Field(default_factory=list)


@router.get("/webhooks")
def get_webhooks(request: Request, master_db: Session = Depends(get_master_db_dep), _: User = Depends(viewer)):
    return S.webhooks(master_db, _tenant(request, master_db))


@router.post("/webhooks", status_code=201)
def post_webhook(body: WebhookIn, request: Request, db: Session = Depends(get_tenant_db), master_db: Session = Depends(get_master_db_dep), cu: User = Depends(manager)):
    item, secret = S.create_webhook(master_db, _tenant(request, master_db), cu, body.url, body.events)
    _audit(db, request, cu, "webhook_create", item["id"], f"Webhook added: {item['u']} ({item['e']})")
    return {"item": item, "secret": secret}


@router.delete("/webhooks/{hook_id}")
def delete_webhook(hook_id: int, request: Request, db: Session = Depends(get_tenant_db), master_db: Session = Depends(get_master_db_dep), cu: User = Depends(manager)):
    S.delete_webhook(master_db, _tenant(request, master_db), hook_id)
    _audit(db, request, cu, "webhook_delete", hook_id, "Webhook removed")
    return {"ok": True}


# ─── Connected apps ───────────────────────────────────────────────────────────

@router.get("/connected-apps")
def get_connected_apps(request: Request, db: Session = Depends(get_tenant_db), master_db: Session = Depends(get_master_db_dep), _: User = Depends(viewer)):
    return {"items": S.connected_apps(db, master_db, _tenant(request, master_db))}


@router.delete("/connected-apps/{app_id}")
def revoke_app(app_id: int, request: Request, db: Session = Depends(get_tenant_db), master_db: Session = Depends(get_master_db_dep), cu: User = Depends(manager)):
    S.revoke_app(master_db, _tenant(request, master_db), app_id)
    _audit(db, request, cu, "app_revoke", app_id, f"Access of app #{app_id} revoked")
    return {"ok": True}
