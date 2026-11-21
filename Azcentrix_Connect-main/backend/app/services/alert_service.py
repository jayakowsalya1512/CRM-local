"""Persisted alert generation and email dispatch helpers."""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from app.core.timezone import now_ist, today_ist
from html import escape
from typing import Any, Dict, List

from sqlalchemy.orm import Session

from app.models.all_models import Alert, EMDBG, Lead, TADAClaim, Tender, User
from app.services.notification_service import (
    INTERNAL_SETTING_PREFIX,
    get_setting_value,
    get_internal_setting_value,
    send_email_to_user,
    set_internal_setting_value,
)

logger = logging.getLogger(__name__)

ALERT_DIGEST_KEY_TEMPLATE = f"{INTERNAL_SETTING_PREFIX}alert_digest_last_sent_user_{{user_id}}"


def _utcnow() -> datetime:
    return now_ist()


def _alert_identity(module: str | None, record_id: int | None, subcategory: str | None) -> tuple[str, int, str]:
    return ((module or "").strip().lower(), int(record_id or 0), (subcategory or "").strip().lower())


def _alert_action_url(module: str, record_id: int) -> str:
    return {
        "emdbg": f"/emdbg/{record_id}",
        "tenders": f"/tenders/{record_id}",
        "leads": f"/leads/{record_id}",
        "tada": f"/travel/tada/{record_id}",
    }.get(module, "/alerts")


def _ensure_emdbg_columns(db: Session) -> None:
    """Ensure newer EMDBG columns exist before querying the model."""
    try:
        from sqlalchemy import text as _sa_text
        db.execute(_sa_text("""
            ALTER TABLE emdbg
              ADD COLUMN IF NOT EXISTS `last_rejection_reason` TEXT NULL,
              ADD COLUMN IF NOT EXISTS `finance_status` VARCHAR(30) NOT NULL DEFAULT 'unpaid',
              ADD COLUMN IF NOT EXISTS `finance_paid_date` DATE NULL,
              ADD COLUMN IF NOT EXISTS `finance_paid_by` INT NULL,
              ADD COLUMN IF NOT EXISTS `finance_notes` TEXT NULL,
              ADD COLUMN IF NOT EXISTS `return_status` VARCHAR(30) NOT NULL DEFAULT 'none',
              ADD COLUMN IF NOT EXISTS `return_document_url` VARCHAR(500) NULL,
              ADD COLUMN IF NOT EXISTS `return_file_size_kb` INT NULL,
              ADD COLUMN IF NOT EXISTS `return_uploaded_by` INT NULL,
              ADD COLUMN IF NOT EXISTS `return_uploaded_at` DATETIME NULL,
              ADD COLUMN IF NOT EXISTS `return_confirmed_by` INT NULL,
              ADD COLUMN IF NOT EXISTS `return_confirmed_at` DATETIME NULL
        """))
        db.commit()
    except Exception:
        db.rollback()


def _generate_alert_payloads(db: Session, _: User) -> List[Dict[str, Any]]:
    today = today_ist()
    alerts: List[Dict[str, Any]] = []

    _ensure_emdbg_columns(db)

    try:
        expiring = db.query(EMDBG).filter(
            EMDBG.status == "Active",
            EMDBG.expiry_date != None,  # noqa: E711
            EMDBG.expiry_date <= today + timedelta(days=30),
        ).all()
        for row in expiring:
            days = (row.expiry_date - today).days
            severity = "critical" if days <= 7 else "warning"
            alerts.append({
                "category": "EMD/BG",
                "subcategory": "expiry_window",
                "title": f"{'Expired' if days < 0 else 'Expiring Soon'}: {row.instrument_type}",
                "message": (
                    f"{row.instrument_type} for {row.client_name} is "
                    f"{abs(days)} day(s) {'overdue' if days < 0 else 'away'} "
                    f"for amount Rs {float(row.amount or 0):,.0f}."
                ),
                "severity": severity,
                "module": "emdbg",
                "record_id": row.id,
                "record_ref": row.reference_num,
                "action_url": _alert_action_url("emdbg", row.id),
            })
    except Exception as exc:
        logger.warning("EMD/BG alert generation skipped: %s", exc)

    try:
        upcoming = db.query(Tender).filter(
            Tender.submission_date != None,  # noqa: E711
            Tender.submission_date >= today,
            Tender.submission_date <= today + timedelta(days=7),
            ~Tender.tender_status.in_(["Closed", "Cancelled"]),
        ).all()
        for row in upcoming:
            days = (row.submission_date - today).days
            alerts.append({
                "category": "Tenders",
                "subcategory": "submission_due",
                "title": f"Tender Submission In {days} Day(s)",
                "message": (
                    f"Tender {row.tender_num or row.portal_ref_number or row.id} for "
                    f"{row.customer_name or 'customer'} is due on {row.submission_date}."
                ),
                "severity": "warning" if days <= 2 else "info",
                "module": "tenders",
                "record_id": row.id,
                "record_ref": row.tender_num or row.portal_ref_number or str(row.id),
                "action_url": _alert_action_url("tenders", row.id),
            })
    except Exception as exc:
        logger.warning("Tender alert generation skipped: %s", exc)

    try:
        follow_ups = db.query(Lead).filter(
            Lead.follow_up == today,
            ~Lead.status.in_(["Converted", "Lost"]),
        ).all()
        for row in follow_ups:
            alerts.append({
                "category": "Leads",
                "subcategory": "follow_up_due",
                "title": "Lead Follow-Up Due Today",
                "message": f"Lead {row.lead_title or row.id} for {row.customer_name or 'customer'} needs follow-up today.",
                "severity": "info",
                "module": "leads",
                "record_id": row.id,
                "record_ref": row.lead_ref_id or str(row.id),
                "action_url": _alert_action_url("leads", row.id),
            })
    except Exception as exc:
        logger.warning("Lead alert generation skipped: %s", exc)

    try:
        claims = db.query(TADAClaim).filter(TADAClaim.overall_status == "Submitted").all()
        for row in claims:
            if not row.claim_date:
                continue
            age_days = (today - row.claim_date).days
            if age_days <= 3:
                continue
            alerts.append({
                "category": "TA/DA",
                "subcategory": "pending_approval",
                "title": "TA/DA Claim Awaiting Approval",
                "message": f"Claim {row.claim_number} has been waiting for approval for {age_days} day(s).",
                "severity": "warning",
                "module": "tada",
                "record_id": row.id,
                "record_ref": row.claim_number,
                "action_url": _alert_action_url("tada", row.id),
            })
    except Exception as exc:
        logger.warning("TA/DA alert generation skipped: %s", exc)

    return alerts


def _critical_alert_bodies(alert: Alert, company_name: str) -> tuple[str, str]:
    text_body = (
        f"{company_name}\n\n"
        f"{alert.title}\n\n"
        f"{alert.message}\n\n"
        f"Module: {(alert.module or 'alerts').title()}\n"
        "Please review this alert in the CRM as soon as possible.\n"
    )
    html_body = (
        '<div style="font-family:Arial,sans-serif;background:#fff7ed;padding:24px;">'
        '<div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #fdba74;'
        'border-radius:18px;overflow:hidden;">'
        '<div style="padding:20px 24px;background:#9a3412;color:#ffffff;">'
        f'<div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;opacity:0.75;">{escape(company_name)}</div>'
        f'<h2 style="margin:10px 0 0;font-size:22px;line-height:1.3;">{escape(alert.title)}</h2>'
        "</div>"
        '<div style="padding:24px;color:#7c2d12;">'
        f'<p style="margin:0;font-size:15px;line-height:1.7;">{escape(alert.message)}</p>'
        '<p style="margin:18px 0 0;font-size:13px;color:#9a3412;">Please review this alert in the CRM as soon as possible.</p>'
        "</div>"
        "</div>"
        "</div>"
    )
    return text_body, html_body


def _send_critical_alert_email(db: Session, user: User, alert: Alert) -> bool:
    company_name = (get_setting_value(db, "company_name", "AZCENTRIX") or "AZCENTRIX").strip() or "AZCENTRIX"
    text_body, html_body = _critical_alert_bodies(alert, company_name)
    return send_email_to_user(
        db,
        user_id=user.id,
        subject=f"Critical Alert: {alert.title}",
        text_body=text_body,
        html_body=html_body,
        category="alert",
    )


def _build_digest_bodies(db: Session, alerts: List[Alert]) -> tuple[str, str, str]:
    company_name = (get_setting_value(db, "company_name", "AZCENTRIX") or "AZCENTRIX").strip() or "AZCENTRIX"
    subject = f"{company_name}: Daily Alert Digest ({len(alerts)})"

    text_lines = [company_name, "", "Daily alert digest", ""]
    for alert in alerts:
        text_lines.append(f"- [{(alert.severity or 'info').upper()}] {alert.title}")
        text_lines.append(f"  {alert.message}")
    text_lines.append("")
    text_lines.append("Open the CRM to review these alerts.")

    cards = []
    for alert in alerts:
        cards.append(
            '<div style="padding:14px 16px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc;">'
            f'<div style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;">{escape((alert.severity or "info").title())}</div>'
            f'<h3 style="margin:8px 0 6px;font-size:16px;color:#0f172a;">{escape(alert.title)}</h3>'
            f'<p style="margin:0;font-size:14px;line-height:1.6;color:#475569;">{escape(alert.message)}</p>'
            "</div>"
        )

    html_body = (
        '<div style="font-family:Arial,sans-serif;background:#f8fafc;padding:24px;">'
        '<div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;'
        'border-radius:18px;overflow:hidden;">'
        '<div style="padding:20px 24px;background:#0f172a;color:#ffffff;">'
        f'<div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;opacity:0.75;">{escape(company_name)}</div>'
        '<h2 style="margin:10px 0 0;font-size:22px;line-height:1.3;">Daily Alert Digest</h2>'
        "</div>"
        '<div style="padding:24px;display:grid;gap:12px;">'
        + "".join(cards) +
        '<p style="margin:10px 0 0;font-size:13px;color:#64748b;">Open the CRM to review and clear these alerts.</p>'
        "</div>"
        "</div>"
        "</div>"
    )

    return subject, "\n".join(text_lines), html_body


def _send_daily_digest_if_due(db: Session, user: User) -> None:
    digest_key = ALERT_DIGEST_KEY_TEMPLATE.format(user_id=user.id)
    today_value = today_ist().isoformat()
    if get_internal_setting_value(db, digest_key) == today_value:
        return

    pending = db.query(Alert).filter(
        Alert.user_id == user.id,
        Alert.auto_generated == True,
        Alert.is_dismissed == False,
        Alert.severity != "critical",
        Alert.email_sent_at == None,  # noqa: E711
    ).order_by(Alert.created_at.asc(), Alert.id.asc()).all()
    if not pending:
        return

    subject, text_body, html_body = _build_digest_bodies(db, pending)
    if not send_email_to_user(
        db,
        user_id=user.id,
        subject=subject,
        text_body=text_body,
        html_body=html_body,
        category="alert",
    ):
        return

    sent_at = _utcnow()
    for alert in pending:
        alert.email_sent_at = sent_at
    set_internal_setting_value(db, digest_key, today_value)


def sync_alerts_for_user(db: Session, user: User) -> None:
    generated = _generate_alert_payloads(db, user)
    existing = db.query(Alert).filter(
        Alert.user_id == user.id,
        Alert.auto_generated == True,
    ).all()
    existing_by_key = {
        _alert_identity(alert.module, alert.record_id, alert.subcategory): alert
        for alert in existing
    }

    active_keys = set()
    for payload in generated:
        key = _alert_identity(payload["module"], payload["record_id"], payload["subcategory"])
        active_keys.add(key)

        alert = existing_by_key.get(key)
        previous_severity = alert.severity if alert else None
        if alert:
            alert.category = payload["category"]
            alert.title = payload["title"]
            alert.message = payload["message"]
            alert.severity = payload["severity"]
            alert.record_ref = payload["record_ref"]
            alert.action_url = payload["action_url"]
        else:
            alert = Alert(
                user_id=user.id,
                category=payload["category"],
                subcategory=payload["subcategory"],
                title=payload["title"],
                message=payload["message"],
                severity=payload["severity"],
                module=payload["module"],
                record_id=payload["record_id"],
                record_ref=payload["record_ref"],
                action_url=payload["action_url"],
                auto_generated=True,
            )
            db.add(alert)

        should_send_instant = (
            payload["severity"] == "critical"
            and not bool(alert.is_dismissed)
            and (alert.email_sent_at is None or previous_severity != "critical")
        )
        if should_send_instant and _send_critical_alert_email(db, user, alert):
            alert.email_sent_at = _utcnow()

    for alert in existing:
        key = _alert_identity(alert.module, alert.record_id, alert.subcategory)
        if key not in active_keys:
            db.delete(alert)

    _send_daily_digest_if_due(db, user)


def serialize_alert(alert: Alert) -> Dict[str, Any]:
    return {
        "id": alert.id,
        "title": alert.title,
        "message": alert.message,
        "severity": alert.severity,
        "category": alert.category,
        "module": alert.module,
        "record_id": alert.record_id,
        "record_ref": alert.record_ref,
        "is_read": alert.is_read,
        "is_dismissed": alert.is_dismissed,
        "created_at": alert.created_at.isoformat() if alert.created_at else None,
    }

