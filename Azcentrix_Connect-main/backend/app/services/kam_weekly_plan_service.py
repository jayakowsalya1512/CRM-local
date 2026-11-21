"""Weekly KAM plan compliance escalations."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import time as time_module
from datetime import date, datetime, time as datetime_time, timedelta
from html import escape
from typing import Any
from urllib.parse import urlencode, urljoin

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.timezone import now_ist
from app.database import MasterSessionLocal, get_tenant_session_by_db_name
from app.models.all_models import KAMActivity, User
from app.models.tenant import Tenant
from app.services.notification_service import (
    EMAIL_NOTIFICATIONS_KEY,
    get_bool_setting,
    get_internal_setting_value,
    is_email_enabled_for_category,
    send_email_to_user,
    set_internal_setting_value,
    upsert_notification,
)
from app.services.tenant_email_service import get_missing_tenant_smtp_fields

logger = logging.getLogger(__name__)

CEO_REPORT_SENT_KEY = "_internal_kam_weekly_plan_ceo_report_week"
PLANNER_EXCLUDED_ROLES = {"ceo", "admin", "super_admin", "accounts"}
ACTION_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60
WEEKLY_PLAN_GRACE_WEEKDAY = 0
WEEKLY_PLAN_GRACE_TIME = datetime_time(11, 0)
WEEKLY_PLAN_GRACE_LABEL = "Monday 11:00 AM IST"
WEEKLY_PLAN_NOT_DUE_REASON = "not_due_until_monday_11am"
WEEKLY_PLAN_HEAD_ROLES = {"manager", "sales_head", "saleshead", "vp"}
WEEKLY_PLAN_ADMIN_ROLES = {"admin", "super_admin"}


class WeeklyPlanTokenError(ValueError):
    """Raised when an email action token is invalid or expired."""


def kam_week_window(anchor: date | None = None) -> tuple[date, date]:
    """Return the Monday-Saturday KAM planning week for the given date."""
    current = anchor or now_ist().date()
    week_start = current - timedelta(days=current.weekday())
    return week_start, week_start + timedelta(days=5)


def _is_weekly_check_due(current: datetime) -> bool:
    weekday = current.weekday()
    if weekday < WEEKLY_PLAN_GRACE_WEEKDAY:
        return False
    if weekday == WEEKLY_PLAN_GRACE_WEEKDAY:
        return current.time() >= WEEKLY_PLAN_GRACE_TIME
    return True


def _format_date(value: date) -> str:
    return value.strftime("%d %b %Y")


def _display_name(user: User) -> str:
    return (user.full_name or user.username or user.email or f"User #{user.id}").strip()


def _token_secret() -> bytes:
    secret = (settings.SECRET_KEY or settings.MASTER_DATABASE_URL or "digitcrm-local-secret").strip()
    return secret.encode("utf-8")


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64decode(value: str) -> bytes:
    padding = "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode(f"{value}{padding}".encode("ascii"))


def _make_action_token(
    *,
    tenant_slug: str,
    week_start: date,
    action: str,
    user_id: int | None = None,
) -> str:
    payload = {
        "tenant_slug": tenant_slug,
        "week_start": week_start.isoformat(),
        "action": action,
        "user_id": user_id,
        "exp": int(time_module.time()) + ACTION_TOKEN_TTL_SECONDS,
    }
    body = _b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = hmac.new(_token_secret(), body.encode("ascii"), hashlib.sha256).digest()
    return f"{body}.{_b64encode(signature)}"


def _read_action_token(db: Session, token: str) -> dict[str, Any]:
    try:
        body, signature = token.split(".", 1)
    except ValueError as exc:
        raise WeeklyPlanTokenError("Invalid escalation link.") from exc

    expected = _b64encode(hmac.new(_token_secret(), body.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(signature, expected):
        raise WeeklyPlanTokenError("Invalid escalation link.")

    try:
        payload = json.loads(_b64decode(body).decode("utf-8"))
    except Exception as exc:
        raise WeeklyPlanTokenError("Invalid escalation link.") from exc

    if int(payload.get("exp") or 0) < int(time_module.time()):
        raise WeeklyPlanTokenError("This escalation link has expired.")

    tenant_slug = str(db.info.get("tenant_slug") or "").strip()
    if tenant_slug and payload.get("tenant_slug") != tenant_slug:
        raise WeeklyPlanTokenError("This escalation link does not belong to the current tenant.")

    if payload.get("action") not in {"all", "user"}:
        raise WeeklyPlanTokenError("Invalid escalation action.")

    return payload


def _get_frontend_base_url() -> str:
    configured = str(getattr(settings, "FRONTEND_BASE_URL", "") or "").strip().rstrip("/")
    if configured:
        return configured

    for origin in getattr(settings, "ALLOWED_ORIGINS", []) or []:
        normalized = str(origin or "").strip().rstrip("/")
        if normalized.startswith(("http://", "https://")):
            return normalized
    return ""


def _action_url(tenant_slug: str, token: str) -> str:
    query = urlencode({"tenant": tenant_slug, "token": token})
    path = f"/api/v1/kam/weekly-plan/send-escalation-link?{query}"
    base_url = _get_frontend_base_url()
    return urljoin(f"{base_url}/", path.lstrip("/")) if base_url else path


def _planner_users(db: Session) -> list[User]:
    role_lower = func.lower(User.role)
    return (
        db.query(User)
        .filter(User.is_active == True)
        .filter(~role_lower.in_(PLANNER_EXCLUDED_ROLES))
        .order_by(User.full_name.asc(), User.username.asc())
        .all()
    )


def _ceo_recipients(db: Session) -> list[User]:
    role_lower = func.lower(User.role)
    recipients = (
        db.query(User)
        .filter(
            User.is_active == True,
            role_lower.in_(["ceo", *sorted(WEEKLY_PLAN_HEAD_ROLES), *sorted(WEEKLY_PLAN_ADMIN_ROLES)]),
        )
        .order_by(User.full_name.asc(), User.username.asc())
        .all()
    )
    priority = {"ceo": 0, "vp": 1, "manager": 2, "sales_head": 2, "saleshead": 2, "admin": 3, "super_admin": 3}
    return sorted(recipients, key=lambda user: (priority.get(str(user.role or "").lower(), 9), _display_name(user).lower()))


def _load_tenant_for_status(db: Session) -> Tenant | None:
    tenant_slug = str(db.info.get("tenant_slug") or "").strip()
    if not tenant_slug:
        return None

    master_db = MasterSessionLocal()
    try:
        tenant = master_db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
        if tenant:
            master_db.expunge(tenant)
        return tenant
    finally:
        master_db.close()


def _user_summary(user: User) -> dict[str, Any]:
    return {
        "id": int(user.id),
        "name": _display_name(user),
        "email": user.email or "",
        "role": user.role or "",
    }


def users_without_weekly_plan(db: Session, week_start: date, week_end: date) -> list[User]:
    users = _planner_users(db)
    if not users:
        return []

    user_ids = [int(user.id) for user in users]
    planned_user_ids = {
        int(row[0])
        for row in (
            db.query(KAMActivity.user_id)
            .filter(KAMActivity.user_id.in_(user_ids))
            .filter(KAMActivity.activity_date >= week_start)
            .filter(KAMActivity.activity_date <= week_end)
            .filter(or_(KAMActivity.status.is_(None), KAMActivity.status != "Cancelled"))
            .distinct()
            .all()
        )
        if row[0] is not None
    }
    return [user for user in users if int(user.id) not in planned_user_ids]


def weekly_plan_report_status(db: Session) -> dict[str, Any]:
    current = now_ist()
    week_start, week_end = kam_week_window(current.date())
    week_key = week_start.isoformat()
    sent_marker = get_internal_setting_value(db, CEO_REPORT_SENT_KEY)
    missing_users = users_without_weekly_plan(db, week_start, week_end)
    recipients = _ceo_recipients(db)
    tenant = _load_tenant_for_status(db)
    missing_smtp_fields = get_missing_tenant_smtp_fields(tenant) if tenant else ["tenant"]
    email_notifications_enabled = get_bool_setting(db, EMAIL_NOTIFICATIONS_KEY, True)
    event_email_enabled = is_email_enabled_for_category(db, "event")
    due_now = _is_weekly_check_due(current)
    already_sent = sent_marker == week_key

    if not due_now:
        reason = WEEKLY_PLAN_NOT_DUE_REASON
    elif already_sent:
        reason = "already_sent_for_week"
    elif not missing_users:
        reason = "all_users_planned"
    elif not recipients:
        reason = "no_ceo_or_head_recipient"
    elif missing_smtp_fields:
        reason = "tenant_smtp_incomplete"
    else:
        reason = "ready_to_send"

    return {
        "now_ist": current.isoformat(),
        "due_now": due_now,
        "grace_time": WEEKLY_PLAN_GRACE_LABEL,
        "week_start": week_start.isoformat(),
        "week_end": week_end.isoformat(),
        "week_label": f"{_format_date(week_start)} to {_format_date(week_end)}",
        "sent_marker": sent_marker,
        "already_sent_for_week": already_sent,
        "email_notifications_enabled": email_notifications_enabled,
        "event_email_enabled": event_email_enabled,
        "tenant_slug": str(db.info.get("tenant_slug") or ""),
        "tenant_smtp_ready": not missing_smtp_fields,
        "missing_smtp_fields": missing_smtp_fields,
        "ceo_recipients": [_user_summary(user) for user in recipients],
        "report_recipients": [_user_summary(user) for user in recipients],
        "pending_users": len(missing_users),
        "missing_users": [_user_summary(user) for user in missing_users],
        "reason": reason,
        "can_send_now": reason == "ready_to_send",
        "force_send_possible": bool(missing_users and recipients and not missing_smtp_fields),
    }


def _build_ceo_report_body(
    *,
    tenant_slug: str,
    missing_users: list[User],
    week_start: date,
    week_end: date,
) -> tuple[str, str]:
    week_label = f"{_format_date(week_start)} to {_format_date(week_end)}"
    all_token = _make_action_token(tenant_slug=tenant_slug, week_start=week_start, action="all")
    all_url = _action_url(tenant_slug, all_token)

    rows_text = "\n".join(
        f"- {_display_name(user)} ({user.email or 'no email'}, role: {user.role or '-'})"
        for user in missing_users
    )
    text_body = (
        f"KAM weekly plan escalation\n\n"
        f"Week: {week_label} (Monday to Saturday)\n"
        f"Employees without a plan: {len(missing_users)}\n\n"
        f"{rows_text}\n\n"
        f"Send escalation to all: {all_url}"
    )

    rows_html = []
    for user in missing_users:
        token = _make_action_token(
            tenant_slug=tenant_slug,
            week_start=week_start,
            action="user",
            user_id=int(user.id),
        )
        action_url = _action_url(tenant_slug, token)
        rows_html.append(
            "<div style='border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin:0 0 10px;background:#ffffff;'>"
            f"<div style='font-weight:700;color:#0f172a;font-size:14px;line-height:1.35;'>{escape(_display_name(user))}</div>"
            f"<div style='margin-top:4px;color:#475569;font-size:13px;line-height:1.45;word-break:break-word;'>{escape(user.email or '-')}</div>"
            f"<div style='margin-top:4px;color:#64748b;font-size:12px;line-height:1.4;'>Role: {escape(user.role or '-')}</div>"
            f"<p style='margin:10px 0 0;'><a href='{escape(action_url)}' style='display:inline-block;color:#2563eb;font-weight:700;text-decoration:none;font-size:13px;'>Send Escalation</a></p>"
            "</div>"
        )

    html_body = (
        "<div style='font-family:Inter,Arial,sans-serif;background:#f8fafc;padding:16px;'>"
        "<div style='max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:18px;'>"
        "<h2 style='margin:0 0 8px;color:#0f172a;'>KAM weekly plan escalation</h2>"
        f"<p style='margin:0 0 14px;color:#475569;line-height:1.45;'>Week: <b>{escape(week_label)}</b> (Monday to Saturday). Grace time: {escape(WEEKLY_PLAN_GRACE_LABEL)}.</p>"
        f"<p style='margin:0 0 16px;color:#0f172a;line-height:1.45;'><b>{len(missing_users)}</b> employees have not planned this week.</p>"
        f"<p style='margin:0 0 18px;'><a href='{escape(all_url)}' style='display:inline-block;background:#0b1f3a;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none;font-weight:700;'>Send Escalation to All</a></p>"
        f"<div>{''.join(rows_html)}</div>"
        "</div>"
        "</div>"
    )
    return text_body, html_body


def send_weekly_plan_ceo_report_if_due(db: Session, *, force: bool = False) -> dict[str, Any]:
    current = now_ist()
    if not force and not _is_weekly_check_due(current):
        return {"checked": 0, "ceo_reports_sent": 0, "pending_users": 0, "reason": WEEKLY_PLAN_NOT_DUE_REASON}

    week_start, week_end = kam_week_window(current.date())
    week_key = week_start.isoformat()
    if not force and get_internal_setting_value(db, CEO_REPORT_SENT_KEY) == week_key:
        return {"checked": 1, "ceo_reports_sent": 0, "pending_users": 0, "reason": "already_sent_for_week"}

    missing_users = users_without_weekly_plan(db, week_start, week_end)
    if not missing_users:
        set_internal_setting_value(db, CEO_REPORT_SENT_KEY, week_key)
        return {"checked": 1, "ceo_reports_sent": 0, "pending_users": 0, "reason": "all_users_planned"}

    recipients = _ceo_recipients(db)
    if not recipients:
        logger.warning("KAM weekly plan report skipped because no CEO/head recipient exists")
        return {"checked": 1, "ceo_reports_sent": 0, "pending_users": len(missing_users), "reason": "no_ceo_or_head_recipient"}

    tenant_slug = str(db.info.get("tenant_slug") or "").strip()
    text_body, html_body = _build_ceo_report_body(
        tenant_slug=tenant_slug,
        missing_users=missing_users,
        week_start=week_start,
        week_end=week_end,
    )
    subject = f"KAM weekly plan escalation: {len(missing_users)} employee(s) pending"
    sent_count = 0
    for recipient in recipients:
        sent = send_email_to_user(
            db,
            int(recipient.id),
            subject,
            text_body,
            html_body,
            category="event",
            respect_category_setting=False,
        )
        sent_count += int(bool(sent))

    if sent_count:
        set_internal_setting_value(db, CEO_REPORT_SENT_KEY, week_key)

    return {
        "checked": 1,
        "ceo_reports_sent": sent_count,
        "pending_users": len(missing_users),
        "reason": "sent" if sent_count else "email_send_failed",
    }


def send_weekly_plan_escalations(
    db: Session,
    *,
    user_ids: list[int] | None = None,
    week_start: date | None = None,
) -> dict[str, Any]:
    current_week_start, _ = kam_week_window(now_ist().date())
    week_start = week_start or current_week_start
    week_end = week_start + timedelta(days=5)
    missing_users = users_without_weekly_plan(db, week_start, week_end)

    if user_ids is not None:
        requested_ids = {int(user_id) for user_id in user_ids if int(user_id or 0) > 0}
        missing_users = [user for user in missing_users if int(user.id) in requested_ids]

    week_label = f"{_format_date(week_start)} to {_format_date(week_end)}"
    subject = f"Escalation: Plan your KAM week ({week_label})"

    sent_users: list[dict[str, Any]] = []
    for user in missing_users:
        employee_name = _display_name(user)
        text_body = (
            f"Dear {employee_name},\n\n"
            f"Week: {week_label} (Monday to Saturday).\n\n"
            "We noticed that your weekly KAM activity plan for the current week has not yet been submitted. "
            "Please take a few minutes to complete your planning at the earliest to ensure activities are tracked effectively.\n\n"
            "Thanks and regards,\n"
            "Management"
        )
        html_body = (
            "<div style='font-family:Inter,Arial,sans-serif;background:#f4f7fb;padding:24px;'>"
            "<div style='max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #dbe4f0;border-radius:14px;overflow:hidden;'>"
            "<div style='background:#0b1f3a;padding:16px 22px;color:#ffffff;'>"
            "<h2 style='margin:0;font-size:19px;line-height:1.3;color:#ffffff;'>Weekly KAM activity plan reminder</h2>"
            "</div>"
            "<div style='padding:24px;color:#334155;'>"
            f"<p style='margin:0 0 16px;color:#334155;'>Dear {escape(employee_name)},</p>"
            f"<div style='margin:0 0 18px;padding:12px 14px;border-radius:10px;background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a;line-height:1.45;'><span style='display:inline-block;margin-right:8px;'>&#128197;</span>Week: <b>{escape(week_label)}</b> (Monday to Saturday).</div>"
            "<p style='margin:0 0 16px;color:#334155;line-height:1.65;'>"
            "We noticed that your weekly KAM activity plan for the current week has not yet been submitted. "
            "Please take a few minutes to complete your planning at the earliest to ensure activities are tracked effectively."
            "</p>"
            "<p style='margin:20px 0 0;color:#334155;line-height:1.65;'>Thanks and regards,<br/><b>Management</b></p>"
            "</div>"
            "</div>"
            "</div>"
        )
        sent = send_email_to_user(
            db,
            int(user.id),
            subject,
            text_body,
            html_body,
            category="event",
            respect_category_setting=False,
        )
        if sent:
            sent_users.append({"id": int(user.id), "name": employee_name, "email": user.email})
            upsert_notification(
                db,
                int(user.id),
                "Plan your KAM week",
                f"Please plan your KAM activities for {week_label}.",
                module="kam",
                action="weekly_plan_escalation",
                category="event",
                send_email=False,
            )

    return {
        "week_start": week_start.isoformat(),
        "week_end": week_end.isoformat(),
        "requested": len(missing_users),
        "sent": len(sent_users),
        "sent_users": sent_users,
    }


def send_weekly_plan_reminders_from_token(db: Session, token: str) -> dict[str, Any]:
    payload = _read_action_token(db, token)
    week_start = date.fromisoformat(str(payload["week_start"]))

    user_ids = None
    if payload.get("action") == "user":
        user_ids = [int(payload.get("user_id") or 0)]

    return send_weekly_plan_escalations(db, user_ids=user_ids, week_start=week_start)


def run_weekly_plan_maintenance_for_all_tenants() -> dict[str, dict[str, Any]]:
    if not _is_weekly_check_due(now_ist()):
        return {}

    summary: dict[str, dict[str, Any]] = {}
    master_db = MasterSessionLocal()
    try:
        tenants = master_db.query(Tenant).filter(Tenant.status.in_(["active", "trial"])).all()
        for tenant in tenants:
            tenant_db = get_tenant_session_by_db_name(tenant.db_name, cache_key=tenant.slug)
            try:
                tenant_db.info["tenant_slug"] = tenant.slug
                summary[tenant.slug] = send_weekly_plan_ceo_report_if_due(tenant_db)
                tenant_db.commit()
            except Exception as exc:
                tenant_db.rollback()
                logger.warning("KAM weekly plan maintenance failed for tenant=%s: %s", tenant.slug, exc)
            finally:
                tenant_db.close()
    finally:
        master_db.close()
    return summary
