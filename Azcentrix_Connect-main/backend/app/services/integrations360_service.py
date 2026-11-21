"""Marketplace & API (prototype v17 R.integrations) – queries and writes.

Marketplace      the prototype INTG catalogue × tenant_integrations (one SELECT); WhatsApp Business / Gmail also drive the
                 lead-capture channel settings (integration.whatsapp.enabled / integration.email.enabled) so the two never
                 disagree.  Credentials are sealed with AES-GCM (key derived from SECRET_KEY) and never returned.
API & webhooks   platform_api_keys (master DB, tenant_id) and platform_webhook_endpoints + the latest delivery per endpoint
                 (one grouped sub-query joined back – no per-row lookups).
Connected apps   active marketplace installs (apps ⨝ publishers) with the authorising user resolved in one tenant query.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import threading
from datetime import datetime
from typing import Any, Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.timezone import now_ist
from app.models.all_models import Setting, User
from app.models.integrations360 import INTEGRATIONS360_TABLES, TenantIntegration
from app.models.platform_api import PlatformApiKey, PlatformWebhookDelivery, PlatformWebhookEndpoint
from app.models.platform_marketplace import PlatformMarketApp, PlatformMarketInstall, PlatformMarketPublisher
from app.models.tenant import Tenant
from app.services import platform_api_keys as keys
from app.services import platform_marketplace as mk
from app.services import platform_webhooks as wh

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()

# prototype INTG: key, name, category, description, lead-capture channel it switches (or None)
CATALOGUE: list[tuple[str, str, str, str, Optional[str]]] = [
    ("gem_portal", "GeM Portal", "Tender sources", "Auto-import bids matching your keywords", None),
    ("cppp", "CPPP / eProcure", "Tender sources", "Daily tender alerts by department", None),
    ("tender247", "Tender247", "Tender sources", "Premium tender feed", None),
    ("gmail", "Gmail", "Email & calendar", "Sync emails to leads and tenders", "email"),
    ("outlook", "Microsoft Outlook", "Email & calendar", "Two-way mail and calendar sync", None),
    ("gcal", "Google Calendar", "Email & calendar", "Bid deadlines and site visits", None),
    ("whatsapp", "WhatsApp Business", "Messaging", "Alerts and customer messages", "whatsapp"),
    ("slack", "Slack", "Messaging", "Channel alerts and approvals", None),
    ("teams", "Microsoft Teams", "Messaging", "Approval cards in Teams", None),
    ("tally", "Tally Prime", "Accounting", "Push invoices, pull receipts", None),
    ("zoho_books", "Zoho Books", "Accounting", "Invoice and payment sync", None),
    ("sap_b1", "SAP Business One", "ERP", "Master and order sync", None),
    ("digisign", "DigiSign / e-Sign", "Documents", "Sign letters and quotations", None),
    ("gdrive", "Google Drive", "Documents", "Attach files from Drive", None),
    ("sms", "SMS gateway", "Messaging", "OTP and bid reminders", "telephone"),
    ("webhooks", "Webhooks & API", "Developer", "Events to your systems", None),
]
CAT_BY_KEY = {k: (n, c, d, ch) for k, n, c, d, ch in CATALOGUE}
SYNC_OPTIONS = ("Every 15 minutes", "Hourly", "Daily")
DEFAULT_MAPPING = "Source “Tender No” → Tender.tenderNo · “Organisation” → Tender.customer · “Closing date” → Tender.submit"
SCOPE_LABEL = {"read,write": "Read / write", "read": "Read only"}


# ─── schema ───────────────────────────────────────────────────────────────────

def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        bind = db.get_bind()
        for t in INTEGRATIONS360_TABLES:
            t.create(bind=bind, checkfirst=True)
        db.commit()
        _READY.add(slug)


def ensure_schema_all_tenants() -> None:
    from app.database import MasterSessionLocal, get_tenant_session
    master = MasterSessionLocal()
    try:
        slugs = [t.slug for t in master.query(Tenant.slug).all()]
    except Exception as exc:  # pragma: no cover
        logger.warning("Integrations schema sync: unable to list tenants: %s", exc)
        return
    finally:
        master.close()
    for slug in slugs:
        try:
            db = get_tenant_session(slug)
            try:
                db.info["tenant_slug"] = slug
                ensure_schema(db)
            finally:
                db.close()
        except Exception as exc:
            logger.warning("Integrations schema sync failed for %s: %s", slug, exc)


# ─── secrets ──────────────────────────────────────────────────────────────────

def _aead() -> AESGCM:
    return AESGCM(hashlib.sha256(("tenant-integration:" + settings.SECRET_KEY).encode()).digest())


def _seal(data: dict) -> str:
    nonce = os.urandom(12)
    return base64.b64encode(nonce + _aead().encrypt(nonce, json.dumps(data).encode(), b"azx-integration")).decode()


# ─── marketplace ──────────────────────────────────────────────────────────────

def _setting(db: Session, key: str) -> Optional[str]:
    row = db.query(Setting.value).filter(Setting.key == key).first()
    return row[0] if row else None


def _set_setting(db: Session, cu: User, key: str, value: str, type_: str = "boolean") -> None:
    row = db.query(Setting).filter(Setting.key == key).first()
    if row is None:
        db.add(Setting(key=key, value=value, type=type_, category="integrations", updated_by=cu.id))
    else:
        row.value, row.updated_by = value, cu.id


def marketplace(db: Session, master_db: Session, tenant: Optional[Tenant]) -> dict[str, Any]:
    rows = {r.key: r for r in db.query(TenantIntegration).all()}
    channel_on = {ch: str(_setting(db, f"integration.{ch}.enabled") or "").lower() == "true" for ch in ("whatsapp", "email", "telephone")}
    dev_on = False
    if tenant is not None:
        wh.ensure_schema()
        keys.ensure_schema()
        dev_on = bool(master_db.query(PlatformWebhookEndpoint.id).filter(PlatformWebhookEndpoint.tenant_id == tenant.id, PlatformWebhookEndpoint.is_active.is_(True)).first()
                      or master_db.query(PlatformApiKey.id).filter(PlatformApiKey.tenant_id == tenant.id, PlatformApiKey.revoked_at.is_(None)).first())
    items = []
    for key, name, cat, desc, ch in CATALOGUE:
        r = rows.get(key)
        cfg = (r.config if r else None) or {}
        connected = bool(r and r.connected)
        if ch:
            connected = channel_on.get(ch, False)
        if key == "webhooks":
            connected = dev_on
        items.append({"key": key, "name": name, "cat": cat, "desc": desc, "connected": connected, "sync": cfg.get("sync") or SYNC_OPTIONS[0],
                      "mapping": cfg.get("mapping") or DEFAULT_MAPPING, "last_sync": r.last_sync_at.isoformat() if r and r.last_sync_at else None,
                      "has_secret": bool(r and r.credentials_enc), "channel": ch, "developer": key == "webhooks"})
    cats = []
    for _, _, c, _, _ in CATALOGUE:
        if c not in cats:
            cats.append(c)
    return {"items": items, "categories": cats, "connected": sum(1 for i in items if i["connected"]), "sync_options": list(SYNC_OPTIONS)}


def _row(db: Session, key: str) -> TenantIntegration:
    if key not in CAT_BY_KEY:
        raise HTTPException(404, "Unknown integration")
    r = db.query(TenantIntegration).filter(TenantIntegration.key == key).first()
    if r is None:
        r = TenantIntegration(key=key, connected=False, config={})
        db.add(r)
        db.flush()
    return r


def connect(db: Session, cu: User, key: str, client_id: str, secret: str) -> None:
    if key == "webhooks":
        raise HTTPException(422, "Webhooks & API are set up on the “API & webhooks” tab")
    client_id, secret = (client_id or "").strip()[:300], (secret or "").strip()[:500]
    if not client_id or not secret:
        raise HTTPException(422, "Paste the API key / client ID and the secret")
    r = _row(db, key)
    r.credentials_enc = _seal({"client_id": client_id, "secret": secret})
    r.connected, r.connected_by, r.connected_at = True, cu.id, now_ist()
    r.config = {**(r.config or {}), "sync": (r.config or {}).get("sync") or SYNC_OPTIONS[0]}
    ch = CAT_BY_KEY[key][3]
    if ch:
        _set_setting(db, cu, f"integration.{ch}.enabled", "true")
    db.commit()


def configure(db: Session, cu: User, key: str, sync: str) -> None:
    if sync not in SYNC_OPTIONS:
        raise HTTPException(422, "Choose a sync frequency")
    r = _row(db, key)
    r.config = {**(r.config or {}), "sync": sync}
    db.commit()


def disconnect(db: Session, cu: User, key: str) -> None:
    r = _row(db, key)
    r.connected, r.credentials_enc = False, None
    ch = CAT_BY_KEY[key][3]
    if ch:
        _set_setting(db, cu, f"integration.{ch}.enabled", "false")
    db.commit()


# ─── API keys (master DB) ─────────────────────────────────────────────────────

def _key_dict(k: PlatformApiKey) -> dict:
    return {"id": k.id, "n": k.name, "k": keys.masked(k), "s": SCOPE_LABEL.get(k.scopes or "read,write", "Read / write"), "c": k.created_at.isoformat() if k.created_at else None,
            "last": k.last_used_at.isoformat() if k.last_used_at else None, "status": keys.status(k)}


def api_keys(master_db: Session, tenant: Tenant) -> list[dict]:
    keys.ensure_schema()
    rows = master_db.query(PlatformApiKey).filter(PlatformApiKey.tenant_id == tenant.id, PlatformApiKey.revoked_at.is_(None)) \
        .order_by(PlatformApiKey.created_at.desc()).limit(200).all()
    return [_key_dict(k) for k in rows]


def create_api_key(master_db: Session, tenant: Tenant, cu: User, name: str, scope: str) -> tuple[dict, str]:
    scopes = ("read", "write") if scope != "ro" else ("read",)
    try:
        row, raw = keys.create_key(master_db, tenant, cu.id, name, cu.email or cu.username or str(cu.id), scopes)
    except keys.ApiKeyError as exc:
        raise HTTPException(exc.status_code, str(exc))
    master_db.commit()
    return _key_dict(row), raw


def revoke_api_key(master_db: Session, tenant: Tenant, cu: User, key_id: int) -> None:
    row = master_db.query(PlatformApiKey).filter(PlatformApiKey.id == key_id, PlatformApiKey.tenant_id == tenant.id).first()
    if row is None:
        raise HTTPException(404, "API key not found")
    try:
        keys.revoke(master_db, row, cu.email or cu.username or str(cu.id))
    except keys.ApiKeyError as exc:
        raise HTTPException(exc.status_code, str(exc))
    master_db.commit()


# ─── webhooks (master DB) ─────────────────────────────────────────────────────

def webhooks(master_db: Session, tenant: Tenant) -> dict[str, Any]:
    wh.ensure_schema()
    eps = master_db.query(PlatformWebhookEndpoint).filter(PlatformWebhookEndpoint.tenant_id == tenant.id, PlatformWebhookEndpoint.is_active.is_(True)) \
        .order_by(PlatformWebhookEndpoint.created_at.desc()).limit(200).all()
    last: dict[int, PlatformWebhookDelivery] = {}
    if eps:
        latest = master_db.query(PlatformWebhookDelivery.endpoint_id, func.max(PlatformWebhookDelivery.id).label("mid")) \
            .filter(PlatformWebhookDelivery.tenant_id == tenant.id, PlatformWebhookDelivery.endpoint_id.in_([e.id for e in eps])) \
            .group_by(PlatformWebhookDelivery.endpoint_id).subquery()
        for d in master_db.query(PlatformWebhookDelivery).join(latest, latest.c.mid == PlatformWebhookDelivery.id).all():
            last[d.endpoint_id] = d
    items = []
    for e in eps:
        d = last.get(e.id)
        st = "Active" if d is None or d.status != "failed" else "Failed"
        items.append({"id": e.id, "e": ", ".join(e.events or []), "events": e.events or [], "u": e.url, "s": st,
                      "l": (d.created_at.isoformat() if d and d.created_at else None), "code": d.response_code if d else None, "err": d.last_error if d else None})
    return {"items": items, "events": list(wh.EVENTS)}


def create_webhook(master_db: Session, tenant: Tenant, cu: User, url: str, events: list[str]) -> tuple[dict, str]:
    try:
        row, secret = wh.create_endpoint(master_db, tenant, (url or "").strip(), events, cu.id)
    except wh.WebhookError as exc:
        raise HTTPException(exc.status_code, str(exc))
    master_db.commit()
    return {"id": row.id, "e": ", ".join(row.events or []), "events": row.events, "u": row.url, "s": "Active", "l": None}, secret


def delete_webhook(master_db: Session, tenant: Tenant, hook_id: int) -> None:
    row = master_db.query(PlatformWebhookEndpoint).filter(PlatformWebhookEndpoint.id == hook_id, PlatformWebhookEndpoint.tenant_id == tenant.id,
                                                          PlatformWebhookEndpoint.is_active.is_(True)).first()
    if row is None:
        raise HTTPException(404, "Webhook not found")
    row.is_active = False
    master_db.commit()


# ─── connected apps (marketplace installs) ────────────────────────────────────

def connected_apps(db: Session, master_db: Session, tenant: Tenant) -> list[dict]:
    if mk.ensure_schema():
        master_db.rollback()
    rows = master_db.query(PlatformMarketInstall, PlatformMarketApp.name, PlatformMarketPublisher.name) \
        .join(PlatformMarketApp, PlatformMarketApp.id == PlatformMarketInstall.app_id) \
        .join(PlatformMarketPublisher, PlatformMarketPublisher.id == PlatformMarketApp.publisher_id) \
        .filter(PlatformMarketInstall.tenant_id == tenant.id, PlatformMarketInstall.active.is_(True)) \
        .order_by(PlatformMarketInstall.installed_at.desc()).limit(200).all()
    uids = {i.installed_by_user for i, _, _ in rows if i.installed_by_user}
    names = dict(db.query(User.id, User.full_name).filter(User.id.in_(uids)).all()) if uids else {}
    return [{"app_id": i.app_id, "a": app, "pub": pub, "u": names.get(i.installed_by_user, "—"), "s": " ".join(i.scopes_granted or []),
             "d": i.installed_at.isoformat() if i.installed_at else None} for i, app, pub in rows]


def revoke_app(master_db: Session, tenant: Tenant, app_id: int) -> None:
    try:
        mk.uninstall(master_db, tenant, app_id)
    except mk.MarketError as exc:
        raise HTTPException(exc.status_code, str(exc))
    master_db.commit()
