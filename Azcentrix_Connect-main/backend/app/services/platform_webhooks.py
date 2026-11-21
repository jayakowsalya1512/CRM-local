"""Outgoing webhooks: tenant endpoints, signed event delivery with retries, delivery log.

* Events are recorded once (unique ``event_id``) and fanned out once per endpoint (unique event + endpoint), so an event
  is never delivered twice to the same endpoint; receivers also get ``X-Azcentrix-Event-Id`` to de-duplicate retries.
* Each request is signed: ``X-Azcentrix-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>``.
* Retries: up to RETRIES attempts with exponential back-off, each attempt time-limited to TIMEOUT seconds
  (the Control Center "Webhooks & events" defaults: 5 retries, exponential, 10 s).
* Destinations must be public HTTPS URLs: every address the host resolves to is checked (private, loopback, link-local,
  reserved and multicast ranges are refused), the check is repeated before every attempt, and redirects are not followed.
* Secrets are stored encrypted (AES-GCM, key derived from SECRET_KEY) and never logged or returned after creation.
  The delivery log keeps status, response code, latency and a short error – never the payload or the secret.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import secrets
import socket
import threading
import time
import uuid
from datetime import datetime, timedelta
from typing import Optional
from urllib.parse import urlsplit

import requests
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.database import MasterSessionLocal, master_engine
from app.models.platform_api import PlatformWebhookDelivery, PlatformWebhookEndpoint, PlatformWebhookEvent
from app.models.tenant import Tenant

logger = logging.getLogger(__name__)

EVENTS = ("lead.created", "tender.created")
RETRIES, TIMEOUT, BACKOFF_BASE = 5, 10, 30          # attempts, seconds per attempt, seconds before the 2nd attempt (then ×4)
MAX_ENDPOINTS = 20
ALLOWED_PORTS = (443, 8443)
POLL_SECONDS = 15
_ready: dict[str, bool] = {}


def ensure_schema() -> None:
    if not _ready.get("schema"):
        for model in (PlatformWebhookEndpoint, PlatformWebhookEvent, PlatformWebhookDelivery):
            model.__table__.create(bind=master_engine, checkfirst=True)
        _ready["schema"] = True


class WebhookError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


# ─── Secrets ─────────────────────────────────────────────────────────────────

def _aead() -> AESGCM:
    return AESGCM(hashlib.sha256(("webhook-secret:" + settings.SECRET_KEY).encode()).digest())


def _seal(secret: str) -> str:
    nonce = os.urandom(12)
    return base64.b64encode(nonce + _aead().encrypt(nonce, secret.encode(), b"azx-webhook")).decode()


def _open(sealed: str) -> str:
    raw = base64.b64decode(sealed)
    return _aead().decrypt(raw[:12], raw[12:], b"azx-webhook").decode()


def sign(secret: str, timestamp: int, body: bytes) -> str:
    return hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()


# ─── Destination safety (SSRF) ───────────────────────────────────────────────

def check_destination(url: str) -> str:
    """Raise WebhookError unless ``url`` is a public HTTPS destination; returns the normalised URL."""
    try:
        parts = urlsplit((url or "").strip())
    except ValueError:
        raise WebhookError("Not a valid URL", 422)
    if parts.scheme != "https":
        raise WebhookError("Webhook URLs must use https", 422)
    if not parts.hostname or parts.username or parts.password:
        raise WebhookError("Webhook URLs need a host name and no credentials", 422)
    port = parts.port or 443
    if port not in ALLOWED_PORTS:
        raise WebhookError(f"Port {port} is not allowed (use {', '.join(map(str, ALLOWED_PORTS))})", 422)
    try:
        infos = socket.getaddrinfo(parts.hostname, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise WebhookError(f"{parts.hostname} does not resolve", 422)
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if not ip.is_global or ip.is_multicast:
            raise WebhookError(f"{parts.hostname} resolves to a non-public address – not allowed", 422)
    return parts.geturl()


# ─── Endpoints (tenant API) ──────────────────────────────────────────────────

def create_endpoint(db: Session, tenant: Tenant, url: str, events: list[str], user_id: Optional[int]) -> tuple[PlatformWebhookEndpoint, str]:
    ensure_schema()
    chosen = sorted(set(events or EVENTS))
    unknown = [e for e in chosen if e not in EVENTS]
    if unknown:
        raise WebhookError(f"Unknown event(s): {', '.join(unknown)} (supported: {', '.join(EVENTS)})", 422)
    url = check_destination(url)
    if db.query(PlatformWebhookEndpoint).filter(PlatformWebhookEndpoint.tenant_id == tenant.id, PlatformWebhookEndpoint.is_active == True).count() >= MAX_ENDPOINTS:  # noqa: E712
        raise WebhookError(f"A tenant can have at most {MAX_ENDPOINTS} endpoints", 409)
    secret = "whsec_" + secrets.token_urlsafe(32)
    row = PlatformWebhookEndpoint(tenant_id=tenant.id, url=url[:500], secret_enc=_seal(secret), events=chosen, is_active=True,
                                  created_by_user=user_id, created_at=datetime.utcnow())
    db.add(row)
    db.flush()
    return row, secret


def endpoint_dict(e: PlatformWebhookEndpoint) -> dict:
    return {"id": e.id, "url": e.url, "events": e.events, "is_active": e.is_active, "created_at": e.created_at}


# ─── Events ──────────────────────────────────────────────────────────────────

def emit(db: Session, tenant_id: int, event_type: str, data: dict, event_id: Optional[str] = None) -> Optional[PlatformWebhookEvent]:
    """Record an event and one delivery per subscribed endpoint (idempotent on event_id). Delivery happens in the worker."""
    ensure_schema()
    if event_type not in EVENTS:
        raise WebhookError(f"Unknown event {event_type}")
    endpoints = [e for e in db.query(PlatformWebhookEndpoint).filter(PlatformWebhookEndpoint.tenant_id == tenant_id, PlatformWebhookEndpoint.is_active == True).all()  # noqa: E712
                 if event_type in (e.events or [])]
    if not endpoints:
        return None
    event_id = event_id or f"evt_{uuid.uuid4().hex}"
    existing = db.query(PlatformWebhookEvent).filter(PlatformWebhookEvent.event_id == event_id).first()
    if existing is not None:
        return existing
    now = datetime.utcnow()
    event = PlatformWebhookEvent(event_id=event_id, tenant_id=tenant_id, event_type=event_type, payload=data, created_at=now)
    db.add(event)
    db.flush()
    db.add_all(PlatformWebhookDelivery(event_ref=event.id, endpoint_id=e.id, tenant_id=tenant_id, event_type=event_type, status="pending",
                                       next_attempt_at=now, created_at=now) for e in endpoints)
    db.flush()
    return event


def emit_safe(tenant_slug: Optional[str], event_type: str, data: dict) -> None:
    """For application code: never raises, never slows the request down noticeably (one indexed lookup)."""
    if not tenant_slug:
        return
    db = MasterSessionLocal()
    try:
        tenant_id = db.query(Tenant.id).filter(Tenant.slug == tenant_slug).scalar()
        if tenant_id and emit(db, tenant_id, event_type, data):
            db.commit()
            wake()
    except Exception:  # noqa: BLE001 - webhooks must never break the action that caused them
        db.rollback()
        logger.exception("Webhook event %s for %s not recorded", event_type, tenant_slug)
    finally:
        db.close()


# ─── Delivery ────────────────────────────────────────────────────────────────

def _claim(delivery_id: int) -> bool:
    """Take one due delivery for this worker (atomic, so two workers never send the same delivery)."""
    with master_engine.begin() as conn:
        # next_attempt_at becomes the claim time while sending, so recover_stuck() can tell a dead claim from a live one.
        return conn.execute(text("UPDATE platform_webhook_deliveries SET status = 'sending', next_attempt_at = :now WHERE id = :i "
                                 "AND status IN ('pending', 'retrying') AND (next_attempt_at IS NULL OR next_attempt_at <= :now)"),
                            {"i": delivery_id, "now": datetime.utcnow()}).rowcount == 1


def attempt(delivery_id: int, post=None) -> str:
    """One delivery attempt (after a successful claim). Returns the new status."""
    db = MasterSessionLocal()
    try:
        d = db.get(PlatformWebhookDelivery, delivery_id)
        endpoint, event = db.get(PlatformWebhookEndpoint, d.endpoint_id), db.get(PlatformWebhookEvent, d.event_ref)
        body = json.dumps({"id": event.event_id, "type": event.event_type, "created": int(event.created_at.timestamp()), "data": event.payload},
                          separators=(",", ":"), default=str).encode()
        d.attempts += 1
        code, error, started = None, None, time.monotonic()
        if endpoint is None or not endpoint.is_active:
            error = "endpoint removed"
        else:
            try:
                url = check_destination(endpoint.url)
                ts = int(time.time())
                headers = {"Content-Type": "application/json", "User-Agent": "Azcentrix-Webhooks/1", "X-Azcentrix-Event-Id": event.event_id,
                           "X-Azcentrix-Event": event.event_type, "X-Azcentrix-Signature": f"t={ts},v1={sign(_open(endpoint.secret_enc), ts, body)}"}
                response = (post or requests.post)(url, data=body, headers=headers, timeout=TIMEOUT, allow_redirects=False)
                code = response.status_code
                if not 200 <= code < 300:
                    error = f"HTTP {code}"
            except WebhookError as exc:
                error = str(exc)
            except requests.Timeout:
                error = f"timed out after {TIMEOUT} s"
            except requests.RequestException as exc:
                error = type(exc).__name__
        d.latency_ms, d.response_code = int((time.monotonic() - started) * 1000), code
        if error is None:
            d.status, d.last_error, d.finished_at, d.next_attempt_at = "delivered", None, datetime.utcnow(), None
        elif d.attempts >= RETRIES or error == "endpoint removed":
            d.status, d.last_error, d.finished_at, d.next_attempt_at = "failed", error[:300], datetime.utcnow(), None
        else:
            d.status, d.last_error = "retrying", error[:300]
            d.next_attempt_at = datetime.utcnow() + timedelta(seconds=BACKOFF_BASE * 4 ** (d.attempts - 1))
        db.commit()
        return d.status
    except Exception:
        db.rollback()
        logger.exception("Webhook delivery %s crashed", delivery_id)
        with master_engine.begin() as conn:   # don't leave it stuck in 'sending'
            conn.execute(text("UPDATE platform_webhook_deliveries SET status = 'retrying', next_attempt_at = :t WHERE id = :i AND status = 'sending'"),
                         {"t": datetime.utcnow() + timedelta(seconds=BACKOFF_BASE), "i": delivery_id})
        return "retrying"
    finally:
        db.close()


def run_due(limit: int = 50, post=None) -> int:
    """Deliver everything due now; returns how many attempts were made."""
    ensure_schema()
    with master_engine.connect() as conn:
        ids = [r[0] for r in conn.execute(text("SELECT id FROM platform_webhook_deliveries WHERE status IN ('pending', 'retrying') "
                                               "AND next_attempt_at <= :now ORDER BY next_attempt_at LIMIT :n"), {"now": datetime.utcnow(), "n": limit})]
    done = 0
    for i in ids:
        if _claim(i):
            attempt(i, post)
            done += 1
    return done


def recover_stuck(minutes: int = 5) -> int:
    """Deliveries left in 'sending' by a crashed worker go back to the retry queue."""
    with master_engine.begin() as conn:
        return conn.execute(text("UPDATE platform_webhook_deliveries SET status = 'retrying', next_attempt_at = :now "
                                 "WHERE status = 'sending' AND next_attempt_at < :old"),
                            {"now": datetime.utcnow(), "old": datetime.utcnow() - timedelta(minutes=minutes)}).rowcount


_event = threading.Event()
_worker: dict[str, threading.Thread] = {}


def wake() -> None:
    start_worker()
    _event.set()


def start_worker() -> None:
    """One daemon thread per API process: delivers due webhooks every POLL_SECONDS (sooner when woken)."""
    if _worker.get("t") and _worker["t"].is_alive():
        return

    def loop():
        while True:
            _event.wait(POLL_SECONDS)
            _event.clear()
            try:
                recover_stuck()
                while run_due():
                    pass
            except Exception:  # noqa: BLE001
                logger.exception("Webhook worker pass failed")
    t = threading.Thread(target=loop, daemon=True, name="webhook-delivery")
    _worker["t"] = t
    t.start()
