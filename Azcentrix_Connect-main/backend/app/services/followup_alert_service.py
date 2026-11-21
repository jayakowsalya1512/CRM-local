"""Follow-up date alert service — runs every 6 hours, sends reminder notifications
1 day and 2 days before a lead/opportunity follow-up date is due."""

from __future__ import annotations

import logging
from datetime import timedelta

from sqlalchemy.orm import Session

from app.core.timezone import today_ist
from app.database import MasterSessionLocal, get_tenant_session_by_db_name
from app.models.all_models import Lead, Notification, UserReportingHierarchy
from app.models.tenant import Tenant

logger = logging.getLogger(__name__)

_ACTION_1DAY = "followup_alert_1day"
_ACTION_2DAY = "followup_alert_2day"


def _run_for_db(db: Session) -> dict:
    today = today_ist()
    sent = 0

    for offset_days, action_key in ((1, _ACTION_1DAY), (2, _ACTION_2DAY)):
        target_date = today + timedelta(days=offset_days)
        day_label = "tomorrow" if offset_days == 1 else "in 2 days"
        date_str = target_date.strftime("%d %b %Y")

        leads = (
            db.query(Lead)
            .filter(
                Lead.follow_up == target_date,
                Lead.is_deleted == False,
                Lead.assigned_to.isnot(None),
            )
            .all()
        )

        for lead in leads:
            if not lead.assigned_to:
                continue

            # Dedup: skip if alert already exists for this lead+user+action combo
            already = (
                db.query(Notification)
                .filter(
                    Notification.user_id == lead.assigned_to,
                    Notification.record_id == lead.id,
                    Notification.action == action_key,
                )
                .first()
            )
            if already:
                continue

            lead_type = "opportunity" if lead.lead_type == "direct_opportunity" else "lead"
            ref = lead.lead_ref_id or str(lead.id)

            title = f"Follow-up Due {day_label.title()}"
            message = (
                f"Your follow-up for {lead_type} '{lead.lead_title}' "
                f"(Ref: {ref}) is due on {date_str}. Please take action."
            )

            uids: set[int] = {int(lead.assigned_to)}

            # Also notify the reporting manager
            hier = (
                db.query(UserReportingHierarchy)
                .filter(
                    UserReportingHierarchy.reporting_user_id == lead.assigned_to,
                    UserReportingHierarchy.is_active == True,
                )
                .first()
            )
            if hier and hier.parent_user_id:
                uids.add(int(hier.parent_user_id))

            for uid in uids:
                db.add(Notification(
                    user_id=uid,
                    title=title,
                    message=message,
                    module="leads",
                    record_id=lead.id,
                    action=action_key,
                ))
                sent += 1

        db.commit()

    return {"alerts_sent": sent}


def run_followup_alert_maintenance_for_all_tenants() -> dict:
    """Iterate all active tenants and send upcoming follow-up reminder notifications."""
    master_db = MasterSessionLocal()
    results: dict = {}
    try:
        tenants = master_db.query(Tenant).filter(Tenant.status.in_(["active", "trial"])).all()
        for tenant in tenants:
            try:
                tenant_db = get_tenant_session_by_db_name(tenant.db_name)
                try:
                    counts = _run_for_db(tenant_db)
                    if counts.get("alerts_sent", 0) > 0:
                        results[tenant.db_name] = counts
                finally:
                    tenant_db.close()
            except Exception as exc:
                logger.warning("followup_alert: tenant %s error: %s", tenant.db_name, exc)
    finally:
        master_db.close()
    return results
