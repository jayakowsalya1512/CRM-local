"""Notifications router.

Improvements over previous version
────────────────────────────────────
• mark_read / delete return updated unread_count immediately
  → header badge updates in real-time without waiting for next poll
• admin/ceo list all notifications (org-wide tracking)
• GET /unread-count  → lightweight endpoint for header badge polling
• Deduplication is enforced by the leads router's _notify() upsert,
  so double-notification bug is fixed at source
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import or_
from typing import Any, Optional
from app.core.firebase import FirebaseConfigurationError
from app.dependencies import get_tenant_db, get_current_user
from app.models.all_models import Notification, User, UserPushToken
from app.services.dynamic_notification_service import preview_notification_event
from app.services.cache_service import (
    CACHE_TTL_SECONDS,
    cache_get_json,
    cache_set_json,
    invalidate_notifications_cache,
    invalidate_badges_cache,
    notifications_cache_key,
    tenant_slug_from_db,
)
from app.services.push_notification_service import (
    PushNotificationError,
    deactivate_push_token,
    ensure_push_token_table,
    register_push_token,
    send_push,
    send_push_to_user,
)

router = APIRouter()


class RegisterPushTokenRequest(BaseModel):
    token: str = Field(..., min_length=1, max_length=512)
    platform: Optional[str] = Field(default=None, max_length=40)
    device_id: Optional[str] = Field(default=None, max_length=120)
    device_name: Optional[str] = Field(default=None, max_length=200)


class SendPushNotificationRequest(BaseModel):
    token: Optional[str] = Field(default=None, max_length=512)
    user_id: Optional[int] = None
    title: str = Field(default="HRMS", min_length=1, max_length=200)
    body: str = Field(default="Employee Check-In Completed", min_length=1, max_length=1000)
    data: dict[str, Any] = Field(default_factory=dict)


def _unread_count(db: Session, user_id: int) -> int:
    tenant_slug = tenant_slug_from_db(db)
    cache_key = notifications_cache_key(tenant_slug, user_id) if tenant_slug else ""
    if cache_key:
        cached = cache_get_json(cache_key, "notifications")
        if isinstance(cached, dict) and "unread_count" in cached:
            try:
                return int(cached["unread_count"])
            except (TypeError, ValueError):
                pass

    count = db.query(Notification).filter(
        Notification.user_id == user_id,
        Notification.is_read == False,
    ).count()
    if cache_key:
        cache_set_json(cache_key, {"unread_count": int(count)}, CACHE_TTL_SECONDS["notifications"])
    return count


@router.get("/unread-count")
def get_unread_count(
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    """Lightweight endpoint — poll every 30 s from the header badge."""
    return {"unread_count": _unread_count(db, cu.id)}


@router.post("/push-token", status_code=201)
def save_push_token(
    payload: RegisterPushTokenRequest,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    try:
        token_row = register_push_token(
            db,
            user_id=cu.id,
            token=payload.token,
            platform=payload.platform,
            device_id=payload.device_id,
            device_name=payload.device_name,
        )
        db.commit()
        db.refresh(token_row)
    except PushNotificationError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Unable to save push token: {exc}") from exc

    return {
        "ok": True,
        "id": token_row.id,
        "user_id": token_row.user_id,
        "platform": token_row.platform,
        "is_active": token_row.is_active,
    }


@router.delete("/push-token")
def remove_push_token(
    token: str = Query(..., min_length=1, max_length=512),
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    try:
        count = deactivate_push_token(db, user_id=cu.id, token=token)
        db.commit()
    except PushNotificationError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Unable to remove push token: {exc}") from exc

    return {"ok": True, "removed": count}


@router.post("/send-notification")
def send_notification(
    payload: SendPushNotificationRequest,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    if payload.token:
        if cu.role not in ("admin", "ceo"):
            ensure_push_token_table(db)
            owned_token = db.query(UserPushToken).filter(
                UserPushToken.user_id == cu.id,
                UserPushToken.token == payload.token.strip(),
                UserPushToken.is_active == True,
            ).first()
            if not owned_token:
                raise HTTPException(status_code=403, detail="You can only send to your own saved push token")

        try:
            message_id = send_push(
                payload.token,
                title=payload.title,
                body=payload.body,
                data=payload.data,
            )
        except PushNotificationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FirebaseConfigurationError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Firebase send failed: {exc}") from exc

        return {"status": "sent", "sent": 1, "message_id": message_id}

    target_user_id = payload.user_id or cu.id
    if target_user_id != cu.id and cu.role not in ("admin", "ceo"):
        raise HTTPException(status_code=403, detail="Only admin users can send push notifications to another user")

    result = send_push_to_user(
        db,
        user_id=target_user_id,
        title=payload.title,
        body=payload.body,
        data=payload.data,
    )
    db.commit()

    if not result.get("configured", True):
        raise HTTPException(status_code=503, detail=result["responses"][0]["error"])

    status_label = "sent"
    if result["total"] == 0:
        status_label = "no_tokens"
    elif result["sent"] == 0:
        status_label = "failed"

    return {"status": status_label, **result}


@router.post("/preview")
def preview_notification_recipients(
    payload: dict[str, Any],
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    if cu.role not in ("admin", "ceo"):
        raise HTTPException(status_code=403, detail="Only admin users can preview notification recipients")

    module_key = str(payload.get("module_key") or payload.get("module") or "").strip()
    event_key = str(payload.get("event_key") or payload.get("event") or "").strip()
    if not module_key or not event_key:
        raise HTTPException(status_code=400, detail="module_key/module and event_key/event are required")

    record_id_value = payload.get("record_id")
    try:
        record_id = int(record_id_value) if record_id_value not in (None, "") else None
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="record_id must be an integer") from None

    actor_user_id_value = payload.get("actor_user_id")
    try:
        actor_user_id = int(actor_user_id_value) if actor_user_id_value not in (None, "") else cu.id
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="actor_user_id must be an integer") from None

    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    skip_actor = bool(payload.get("skip_actor", False))

    return preview_notification_event(
        db,
        module_key=module_key,
        event_key=event_key,
        record_id=record_id,
        actor_user_id=actor_user_id,
        context=context,
        skip_actor=skip_actor,
    )


@router.get("")
def list_notifications(
    unread_only: bool           = Query(False),
    mine_only:   bool           = Query(False),
    module:      Optional[str]  = Query(None),
    limit:       int            = Query(50, le=200),
    db: Session  = Depends(get_tenant_db),
    cu: User     = Depends(get_current_user),
):
    """
    List notifications.
    admin/ceo → all notifications in the org (for org-wide tracking).
    Others    → only their own.
    The returned unread_count is ALWAYS the current user's count
    (used for the header badge regardless of role).
    """
    q = db.query(Notification)
    # Personal reminders stay private, including in administrators' org view.
    q = q.filter(or_(Notification.module.is_(None), Notification.module != 'sticky_notes', Notification.user_id == cu.id))
    if mine_only or cu.role not in ('admin', 'ceo'):
        q = q.filter(Notification.user_id == cu.id)
    if unread_only:
        q = q.filter(Notification.is_read == False)
    if module:
        q = q.filter(Notification.module == module)

    items = q.order_by(Notification.created_at.desc()).limit(limit).all()

    return {
        "items": [
            {
                "id":         n.id,
                "user_id":    n.user_id,
                "title":      n.title,
                "message":    n.message,
                "action":     n.action,
                "module":     n.module,
                "record_id":  n.record_id,
                "is_read":    n.is_read,
                "created_at": n.created_at.isoformat() if n.created_at else None,
            }
            for n in items
        ],
        # Always current user's count for the header badge
        "unread_count": _unread_count(db, cu.id),
        "total": len(items),
    }


@router.put("/mark-all-read")
def mark_all_read(
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    db.query(Notification).filter(
        Notification.user_id == cu.id,
        Notification.is_read == False,
    ).update({"is_read": True})
    db.commit()
    invalidate_notifications_cache(db, cu.id)
    invalidate_badges_cache(db, cu.id)
    return {"ok": True, "unread_count": 0}


@router.put("/{notif_id}/read")
def mark_read(
    notif_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    n = db.query(Notification).filter(
        Notification.id      == notif_id,
        Notification.user_id == cu.id,
    ).first()
    if n:
        n.is_read = True
        db.commit()
    invalidate_notifications_cache(db, cu.id)
    invalidate_badges_cache(db, cu.id)
    return {"ok": True, "unread_count": _unread_count(db, cu.id)}


@router.delete("/{notif_id}")
def delete_notification(
    notif_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    n = db.query(Notification).filter(
        Notification.id      == notif_id,
        Notification.user_id == cu.id,
    ).first()
    if n:
        db.delete(n)
        db.commit()
    invalidate_notifications_cache(db, cu.id)
    return {"ok": True, "unread_count": _unread_count(db, cu.id)}


# ─── Inbox & Notifications page (prototype v17) ──────────────────────────────
# Tabs All | Unread | Mentions, related CRM record per notification, and the
# per-user Delivery preferences (Bid deadlines, Approvals, Mentions, Daily digest).

def _is_mention_filter():
    return or_(Notification.action.ilike("%mention%"), Notification.title.ilike("%mention%"), Notification.message.ilike("%mention%"))


@router.get("/feed")
def notification_feed(
    tab: str = Query("All", pattern="^(All|Unread|Mentions)$"),
    limit: int = Query(100, ge=1, le=300),
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    from app.services.inbox_service import notification_record
    base = db.query(Notification).filter(Notification.user_id == cu.id)
    q = base
    if tab == "Unread":
        q = q.filter(Notification.is_read == False)
    elif tab == "Mentions":
        q = q.filter(_is_mention_filter())
    rows = q.order_by(Notification.created_at.desc(), Notification.id.desc()).limit(limit).all()
    items = []
    for n in rows:
        title, message = (n.title or "").strip(), (n.message or "").strip()
        # One line like the prototype: the message, prefixed by the title when the message doesn't already say it.
        text = message if not title or title.lower() in message.lower() else (f"{title}: {message}" if message else title)
        items.append({
            "id": n.id, "title": n.title, "message": n.message,
            "text": text, "action": n.action, "module": n.module, "record_id": n.record_id,
            "is_read": bool(n.is_read), "created_at": n.created_at.isoformat() if n.created_at else None,
            "record": notification_record(db, cu, n.module, n.record_id),
        })
    return {
        "items": items,
        "counts": {
            "All": base.count(),
            "Unread": base.filter(Notification.is_read == False).count(),
            "Mentions": base.filter(_is_mention_filter()).count(),
        },
        "unread_count": _unread_count(db, cu.id),
    }


class DeliveryPrefUpdate(BaseModel):
    enabled: Optional[bool] = None
    channels: Optional[list[str]] = None
    digest_time: Optional[str] = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")


@router.get("/preferences")
def get_delivery_preferences(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    from app.services.inbox_service import ensure_inbox_schema, get_delivery_prefs
    ensure_inbox_schema(db)
    return {"items": get_delivery_prefs(db, cu.id)}


@router.put("/preferences/{pref_key}")
def update_delivery_preference(
    pref_key: str,
    payload: DeliveryPrefUpdate,
    request: Request,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    from app.core.logging import log_audit_db
    from app.dependencies import get_request_ip
    from app.models.inbox import NotificationDeliveryPreference
    from app.services.inbox_service import DELIVERY_PREFS, ensure_inbox_schema, get_delivery_prefs

    ensure_inbox_schema(db)
    spec = next((d for d in DELIVERY_PREFS if d["key"] == pref_key), None)
    if spec is None:
        raise HTTPException(status_code=404, detail="Unknown delivery preference")
    if payload.channels is not None:
        bad = [c for c in payload.channels if c not in ("app", "email", "whatsapp")]
        if bad or not payload.channels:
            raise HTTPException(status_code=400, detail="Channels must be one or more of app, email, whatsapp")
    row = db.query(NotificationDeliveryPreference).filter(
        NotificationDeliveryPreference.user_id == cu.id, NotificationDeliveryPreference.pref_key == pref_key).first()
    old = {"enabled": row.enabled, "channels": row.channels, "digest_time": row.digest_time} if row else None
    if row is None:
        row = NotificationDeliveryPreference(user_id=cu.id, pref_key=pref_key, enabled=True,
                                             channels=list(spec["channels"]), digest_time=spec["digest_time"])
        db.add(row)
    if payload.enabled is not None:
        row.enabled = payload.enabled
    if payload.channels is not None:
        row.channels = payload.channels
    if payload.digest_time is not None:
        row.digest_time = payload.digest_time
    log_audit_db(db, cu.id, "notifications", "preference", None, get_request_ip(request),
                 f"Delivery preference '{spec['label']}' {'on' if row.enabled else 'off'}",
                 old_data=old, new_data={"enabled": row.enabled, "channels": row.channels, "digest_time": row.digest_time},
                 record_name=spec["label"])
    db.commit()
    return {"items": get_delivery_prefs(db, cu.id)}
