"""Lead Channel Integrations Router
────────────────────────────────
Auto-creates Leads from inbound webhooks:
  • WhatsApp  — Meta Cloud API (Business API)
  • Email     — SendGrid / Mailgun / Postmark inbound-parse
  • Telephone — Exotel / Twilio / Knowlarity call-event

Webhook URL pattern (no auth — verified by token/secret):
  GET  /api/v1/integrations/webhook/whatsapp?tenant={slug}  ← verification handshake
  POST /api/v1/integrations/webhook/whatsapp?tenant={slug}
  POST /api/v1/integrations/webhook/email?tenant={slug}
  POST /api/v1/integrations/webhook/telephone?tenant={slug}

Config + Logs (require admin Bearer auth):
  GET  /api/v1/integrations/config
  PUT  /api/v1/integrations/config
  GET  /api/v1/integrations/logs
  GET  /api/v1/integrations/webhook-info
"""
import logging
import json
from datetime import datetime, timezone
from app.core.timezone import now_ist, today_ist
from typing import Optional, Any

from fastapi import APIRouter, Depends, HTTPException, Request, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import func, text as _text

from app.core.config import settings
from app.core.logging import log_module_action
from app.dependencies import get_tenant_db, get_current_user, get_request_ip
from app.models.all_models import Lead, LeadChannelLog, Setting, User

logger = logging.getLogger(__name__)
router = APIRouter()

# ─── Helpers ──────────────────────────────────────────────────────────────────

def _next_lead_ref_id(db: Session) -> str:
    prefix = now_ist().strftime("LD%Y%m")
    row = db.execute(
        _text("SELECT MAX(CAST(SUBSTRING(lead_ref_id, :offset) AS UNSIGNED)) FROM leads WHERE lead_ref_id LIKE :p"),
        {"p": f"{prefix}%", "offset": len(prefix) + 1}
    ).fetchone()
    n = row[0] if row and row[0] else 0
    return f"{prefix}{(n + 1):06d}"


def _get_setting(db: Session, key: str, default: Any = None) -> Any:
    row = db.query(Setting).filter(Setting.key == key).first()
    if not row:
        return default
    if row.type == 'number':
        try:
            return int(row.value)
        except Exception:
            return default
    if row.type == 'boolean':
        return row.value in ('true', '1', 'yes')
    if row.type == 'json':
        try:
            return json.loads(row.value)
        except Exception:
            return default
    return row.value or default


def _set_setting(db: Session, key: str, value: str, type_: str = 'string',
                 category: str = 'integrations', label: str = '') -> None:
    row = db.query(Setting).filter(Setting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(Setting(key=key, value=value, type=type_,
                       category=category, label=label))


def _create_lead_from_channel(
    db: Session,
    channel: str,
    lead_title: str,
    contact_person: str = '',
    mobile: str = '',
    email: str = '',
    notes: str = '',
    channel_id: str = '',
    channel_metadata: dict = None,
) -> Lead:
    """Create a Lead record from an inbound channel event."""
    default_assignee_id = _get_setting(
        db, f'integration.{channel}.default_assignee', None
    )
    if default_assignee_id:
        try:
            default_assignee_id = int(default_assignee_id)
        except Exception:
            default_assignee_id = None

    # Fall back to first admin/sales user if no default configured
    if not default_assignee_id:
        user = (
            db.query(User).filter(User.is_active == True, User.role == 'sales').first()
            or db.query(User).filter(User.is_active == True).first()
        )
        default_assignee_id = user.id if user else None

    lead = Lead(
        lead_ref_id      = _next_lead_ref_id(db),
        lead_title       = lead_title,
        contact_person   = contact_person or None,
        mobile           = mobile or None,
        email            = email or None,
        notes            = notes or None,
        status           = 'Assigned',
        priority         = 'Medium',
        assigned_to      = default_assignee_id,
        channel          = channel,
        channel_id       = channel_id or None,
        channel_metadata = channel_metadata,
        lead_created_at  = now_ist(),
    )
    db.add(lead)
    db.flush()   # get lead.id before committing
    return lead


def _log_channel_event(
    db: Session,
    channel: str,
    channel_ref_id: str,
    raw_payload: dict,
    status: str = 'processed',
    lead_id: int = None,
    error_message: str = None,
) -> None:
    db.add(LeadChannelLog(
        channel        = channel,
        channel_ref_id = channel_ref_id,
        raw_payload    = raw_payload,
        status         = status,
        lead_id        = lead_id,
        error_message  = error_message,
    ))


# ─── WhatsApp Webhook ─────────────────────────────────────────────────────────

@router.get("/webhook/whatsapp", response_class=PlainTextResponse)
def whatsapp_verify(
    hub_mode:         str = Query(None, alias="hub.mode"),
    hub_challenge:    str = Query(None, alias="hub.challenge"),
    hub_verify_token: str = Query(None, alias="hub.verify_token"),
):
    """Meta WhatsApp Business API webhook verification handshake."""
    if hub_mode == "subscribe" and hub_verify_token == settings.WHATSAPP_VERIFY_TOKEN:
        logger.info("WhatsApp webhook verified")
        return hub_challenge or ""
    logger.warning(f"WhatsApp verification failed — token mismatch: '{hub_verify_token}'")
    raise HTTPException(status_code=403, detail="Verification token mismatch")


@router.post("/webhook/whatsapp")
async def whatsapp_receive(
    request: Request,
    db: Session = Depends(get_tenant_db),
):
    """
    Receive WhatsApp message events from Meta Cloud API.
    Supports text messages from individual users.
    """
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON payload")

    results = []
    try:
        entries = payload.get("entry", [])
        for entry in entries:
            for change in entry.get("changes", []):
                value = change.get("value", {})
                messages = value.get("messages", [])

                for msg in messages:
                    msg_id   = msg.get("id", "")
                    from_num = msg.get("from", "")
                    msg_type = msg.get("type", "")
                    timestamp = msg.get("timestamp", "")

                    # Only process text messages (skip image/audio/etc for now)
                    body = ""
                    if msg_type == "text":
                        body = msg.get("text", {}).get("body", "")

                    # Sender display name (from contacts array)
                    contacts = value.get("contacts", [])
                    sender_name = ""
                    for c in contacts:
                        if c.get("wa_id") == from_num:
                            sender_name = c.get("profile", {}).get("name", "")
                            break

                    # Deduplicate by channel_id
                    if db.query(LeadChannelLog).filter(
                        LeadChannelLog.channel == 'whatsapp',
                        LeadChannelLog.channel_ref_id == msg_id,
                    ).first():
                        _log_channel_event(db, 'whatsapp', msg_id, payload, 'duplicate')
                        db.commit()
                        results.append({"msg_id": msg_id, "status": "duplicate"})
                        continue

                    lead_title = f"WhatsApp Lead — {sender_name or from_num}"
                    notes = f"Message: {body}" if body else f"Received {msg_type} message"

                    lead = _create_lead_from_channel(
                        db            = db,
                        channel       = 'whatsapp',
                        lead_title    = lead_title,
                        contact_person= sender_name,
                        mobile        = from_num,
                        notes         = notes,
                        channel_id    = msg_id,
                        channel_metadata = {
                            "from": from_num,
                            "name": sender_name,
                            "type": msg_type,
                            "body": body,
                            "timestamp": timestamp,
                        },
                    )
                    _log_channel_event(db, 'whatsapp', msg_id, payload, 'processed', lead.id)
                    db.commit()
                    logger.info(f"WhatsApp lead created: {lead.lead_ref_id} from {from_num}")
                    results.append({"msg_id": msg_id, "lead_ref_id": lead.lead_ref_id, "status": "created"})

    except Exception as e:
        logger.exception(f"WhatsApp webhook error: {e}")
        try:
            _log_channel_event(db, 'whatsapp', '', payload, 'failed', error_message=str(e))
            db.commit()
        except Exception:
            pass
        # Return 200 anyway so Meta doesn't disable the webhook
        return {"status": "error", "detail": str(e)}

    return {"status": "ok", "processed": results}


# ─── Email Webhook ────────────────────────────────────────────────────────────

@router.post("/webhook/email")
async def email_receive(
    request: Request,
    db: Session = Depends(get_tenant_db),
):
    """
    Receive inbound email events.

    Compatible with:
      • SendGrid  Inbound Parse  (multipart/form-data)
      • Mailgun   Inbound Routes (multipart/form-data)
      • Postmark  Inbound        (application/json)

    At minimum expects: `from`, `subject`, `text` / `body-plain` / `plain-body`
    """
    content_type = request.headers.get("content-type", "")

    try:
        if "application/json" in content_type:
            data = await request.json()
        else:
            form = await request.form()
            data = dict(form)
    except Exception:
        raise HTTPException(400, "Cannot parse email payload")

    # Normalise field names across providers
    from_raw    = (data.get("from") or data.get("From") or "").strip()
    subject     = (data.get("subject") or data.get("Subject") or "No Subject").strip()
    body        = (data.get("text") or data.get("body-plain") or
                   data.get("plain-body") or data.get("TextBody") or "").strip()
    msg_id      = (data.get("message-id") or data.get("MessageID") or
                   data.get("Message-Id") or "").strip()

    # Parse "Name <email@example.com>" format
    sender_name  = ""
    sender_email = from_raw
    if "<" in from_raw:
        parts        = from_raw.split("<")
        sender_name  = parts[0].strip().strip('"')
        sender_email = parts[1].rstrip(">").strip()

    try:
        # Deduplicate
        if msg_id and db.query(LeadChannelLog).filter(
            LeadChannelLog.channel == 'email',
            LeadChannelLog.channel_ref_id == msg_id,
        ).first():
            _log_channel_event(db, 'email', msg_id, data, 'duplicate')
            db.commit()
            return {"status": "duplicate"}

        lead_title = subject or f"Email Lead from {sender_email}"
        notes = f"From: {from_raw}\n\n{body}" if body else f"From: {from_raw}"

        lead = _create_lead_from_channel(
            db               = db,
            channel          = 'email',
            lead_title       = lead_title,
            contact_person   = sender_name,
            email            = sender_email,
            notes            = notes,
            channel_id       = msg_id,
            channel_metadata = {
                "from":    from_raw,
                "subject": subject,
                "msg_id":  msg_id,
            },
        )
        _log_channel_event(db, 'email', msg_id or sender_email, data, 'processed', lead.id)
        db.commit()
        logger.info(f"Email lead created: {lead.lead_ref_id} from {sender_email}")
        return {"status": "ok", "lead_ref_id": lead.lead_ref_id}

    except Exception as e:
        logger.exception(f"Email webhook error: {e}")
        try:
            _log_channel_event(db, 'email', msg_id or '', data, 'failed', error_message=str(e))
            db.commit()
        except Exception:
            pass
        raise HTTPException(500, f"Failed to process email: {e}")


# ─── Telephone Webhook ────────────────────────────────────────────────────────

@router.post("/webhook/telephone")
async def telephone_receive(
    request: Request,
    db: Session = Depends(get_tenant_db),
):
    """
    Receive inbound call events.

    Compatible with:
      • Exotel    (form-data: From, CallSid, Status, RecordingUrl)
      • Twilio    (form-data: From, CallSid, CallStatus, RecordingUrl)
      • Knowlarity (JSON: caller_id, call_id, status)
      • Generic   (JSON: from / caller / phone, call_id / sid)
    """
    content_type = request.headers.get("content-type", "")

    try:
        if "application/json" in content_type:
            data = await request.json()
        else:
            form = await request.form()
            data = dict(form)
    except Exception:
        raise HTTPException(400, "Cannot parse telephone payload")

    # Normalise across providers
    caller   = (data.get("From") or data.get("from") or
                data.get("caller_id") or data.get("caller") or
                data.get("phone") or "").strip()
    call_id  = (data.get("CallSid") or data.get("call_id") or
                data.get("sid") or data.get("CallUUID") or "").strip()
    status   = (data.get("CallStatus") or data.get("Status") or
                data.get("status") or "").strip()
    duration = (data.get("Duration") or data.get("duration") or "").strip()
    rec_url  = (data.get("RecordingUrl") or data.get("recording_url") or "").strip()

    # Only create a lead for completed/answered calls (skip busy/no-answer)
    if status and status.lower() in ('busy', 'no-answer', 'canceled', 'failed', 'noanswer'):
        return {"status": "skipped", "reason": f"call status is '{status}'"}

    try:
        # Deduplicate by call_id
        if call_id and db.query(LeadChannelLog).filter(
            LeadChannelLog.channel == 'telephone',
            LeadChannelLog.channel_ref_id == call_id,
        ).first():
            _log_channel_event(db, 'telephone', call_id, data, 'duplicate')
            db.commit()
            return {"status": "duplicate"}

        lead_title = f"Call Lead — {caller}"
        notes_parts = [f"Caller: {caller}"]
        if status:   notes_parts.append(f"Status: {status}")
        if duration: notes_parts.append(f"Duration: {duration}s")
        if rec_url:  notes_parts.append(f"Recording: {rec_url}")
        notes = "\n".join(notes_parts)

        lead = _create_lead_from_channel(
            db               = db,
            channel          = 'telephone',
            lead_title       = lead_title,
            mobile           = caller,
            notes            = notes,
            channel_id       = call_id,
            channel_metadata = {
                "caller":    caller,
                "call_id":   call_id,
                "status":    status,
                "duration":  duration,
                "recording": rec_url,
            },
        )
        _log_channel_event(db, 'telephone', call_id or caller, data, 'processed', lead.id)
        db.commit()
        logger.info(f"Telephone lead created: {lead.lead_ref_id} from {caller}")
        return {"status": "ok", "lead_ref_id": lead.lead_ref_id}

    except Exception as e:
        logger.exception(f"Telephone webhook error: {e}")
        try:
            _log_channel_event(db, 'telephone', call_id or '', data, 'failed', error_message=str(e))
            db.commit()
        except Exception:
            pass
        raise HTTPException(500, f"Failed to process call: {e}")


# ─── Config (authenticated) ───────────────────────────────────────────────────

class IntegrationConfig(BaseModel):
    whatsapp_enabled:       Optional[bool] = None
    whatsapp_verify_token:  Optional[str]  = None
    whatsapp_default_assignee: Optional[int] = None

    email_enabled:          Optional[bool] = None
    email_default_assignee: Optional[int]  = None

    telephone_enabled:          Optional[bool] = None
    telephone_provider:         Optional[str]  = None   # exotel | twilio | knowlarity | generic
    telephone_default_assignee: Optional[int]  = None


@router.get("/config")
def get_integration_config(
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    if cu.role not in ('admin', 'ceo'):
        raise HTTPException(403, "Admin access required")

    return {
        "whatsapp": {
            "enabled":          _get_setting(db, 'integration.whatsapp.enabled', False),
            "verify_token":     _get_setting(db, 'integration.whatsapp.verify_token',
                                             settings.WHATSAPP_VERIFY_TOKEN),
            "default_assignee": _get_setting(db, 'integration.whatsapp.default_assignee'),
        },
        "email": {
            "enabled":          _get_setting(db, 'integration.email.enabled', False),
            "default_assignee": _get_setting(db, 'integration.email.default_assignee'),
        },
        "telephone": {
            "enabled":          _get_setting(db, 'integration.telephone.enabled', False),
            "provider":         _get_setting(db, 'integration.telephone.provider', 'generic'),
            "default_assignee": _get_setting(db, 'integration.telephone.default_assignee'),
        },
    }


@router.put("/config")
def update_integration_config(
    data: IntegrationConfig,
    request: Request,
    db:   Session = Depends(get_tenant_db),
    cu:   User    = Depends(get_current_user),
):
    if cu.role not in ('admin', 'ceo'):
        raise HTTPException(403, "Admin access required")

    mapping = [
        ('whatsapp_enabled',           'integration.whatsapp.enabled',           'boolean'),
        ('whatsapp_verify_token',      'integration.whatsapp.verify_token',      'string'),
        ('whatsapp_default_assignee',  'integration.whatsapp.default_assignee',  'number'),
        ('email_enabled',              'integration.email.enabled',              'boolean'),
        ('email_default_assignee',     'integration.email.default_assignee',     'number'),
        ('telephone_enabled',          'integration.telephone.enabled',          'boolean'),
        ('telephone_provider',         'integration.telephone.provider',         'string'),
        ('telephone_default_assignee', 'integration.telephone.default_assignee', 'number'),
    ]
    changed = {}
    for field, key, type_ in mapping:
        val = getattr(data, field, None)
        if val is not None:
            _set_setting(db, key, str(val).lower() if type_ == 'boolean' else str(val),
                         type_=type_, category='integrations')
            changed[field] = val

    if changed:
        log_module_action(
            db=db, user_id=cu.id, module="integrations", action="integration_change",
            record_id=None, record_name="Lead Capture Integrations", ip=get_request_ip(request),
            new_data=changed,
        )
    db.commit()
    return {"status": "ok"}


# ─── Logs (authenticated) ─────────────────────────────────────────────────────

@router.get("/logs")
def get_channel_logs(
    channel: Optional[str] = None,
    status:  Optional[str] = None,
    limit:   int           = 50,
    offset:  int           = 0,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    if cu.role not in ('admin', 'ceo'):
        raise HTTPException(403, "Admin access required")

    q = db.query(LeadChannelLog)
    if channel: q = q.filter(LeadChannelLog.channel == channel)
    if status:  q = q.filter(LeadChannelLog.status  == status)

    total = q.count()
    rows  = q.order_by(LeadChannelLog.created_at.desc()).offset(offset).limit(limit).all()

    return {
        "total": total,
        "items": [
            {
                "id":             r.id,
                "channel":        r.channel,
                "channel_ref_id": r.channel_ref_id,
                "status":         r.status,
                "lead_id":        r.lead_id,
                "error_message":  r.error_message,
                "created_at":     r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
    }


# ─── Webhook info (authenticated) ─────────────────────────────────────────────

@router.get("/webhook-info")
def get_webhook_info(
    request: Request,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    """Return the webhook URLs the admin should configure in external services."""
    if cu.role not in ('admin', 'ceo'):
        raise HTTPException(403, "Admin access required")

    # Resolve tenant slug from request
    tenant_slug = (
        getattr(request.state, "tenant_slug", None)
        or request.headers.get("x-tenant-slug", "")
        or request.query_params.get("tenant", "")
    )

    base = str(request.base_url).rstrip("/")
    pfx  = f"{base}/api/v1/integrations/webhook"

    verify_token = _get_setting(
        db, 'integration.whatsapp.verify_token', settings.WHATSAPP_VERIFY_TOKEN
    )

    return {
        "whatsapp": {
            "webhook_url":   f"{pfx}/whatsapp?tenant={tenant_slug}",
            "verify_token":  verify_token,
            "instructions":  "Set this URL in Meta → WhatsApp → Configuration → Webhook",
        },
        "email": {
            "webhook_url":   f"{pfx}/email?tenant={tenant_slug}",
            "instructions":  "Set this URL as Inbound Parse destination in SendGrid / Mailgun / Postmark",
        },
        "telephone": {
            "webhook_url":   f"{pfx}/telephone?tenant={tenant_slug}",
            "instructions":  "Set this URL as the call-event / post-call webhook in Exotel / Twilio / Knowlarity",
        },
    }

