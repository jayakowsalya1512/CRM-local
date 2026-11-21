import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import DataError, IntegrityError

from app.core.config import settings
from app.core.firebase import FirebaseConfigurationError, get_firebase_app
from app.core.logging import setup_logging
from app.database import (
    create_master_tables,
    sync_tenant_approval_escalation_schema,
    sync_tenant_competitor_columns,
    sync_tenant_document_folder_columns,
    sync_tenant_letter_management_columns,
    sync_tenant_letter_management_tables,
    sync_tenant_misc_columns,
    sync_tenant_missing_permissions,
    sync_tenant_quotation_approval_columns,
    sync_tenant_runtime_catalogs,
    sync_tenant_user_auth_columns,
)
from app.middleware.session_activity import SessionActivityMiddleware
from app.middleware.tenant_resolver import TenantResolverMiddleware
from app.services import platform_traffic
from app.services.dynamic_notification_service import run_due_notification_maintenance_for_all_tenants
from app.services.followup_alert_service import run_followup_alert_maintenance_for_all_tenants
from app.services.generic_approval_engine import run_approval_escalation_maintenance_for_all_tenants
from app.services.kam_weekly_plan_service import run_weekly_plan_maintenance_for_all_tenants
from app.routers import (
    alerts_router,
    approvals_router,
    approval_workflow_router,
    auth_router,
    customer_router,
    dashboard_router,
    document_management_router,
    emdbg_router,
    kam_router,
    kam_user_location_router,
    kam_activity_reopen_router,
    lead_router,
    letter_router,
    masters_router,
    modules_router,
    notifications_router,
    inbox_router,
    calendar_router,
    notes_router,
    customer360_router,
    lead360_router,
    app_settings_router,
    admin360_router,
    automation_router,
    funnel_router,
    studio_router,
    process_router,
    integrations360_router,
    directory_router,
    masters360_router,
    approvals360_router,
    dochub_router,
    correspondence_router,
    datahub_router,
    capture_forms_router,
    capture_public_router,
    deals_router,
    bids_router,
    oem_router,
    platform_router,
    preview_router,
    questionnaire_router,
    quotation_router,
    quotes_router,
    products_router,
    forecasts_router,
    orders_router,
    instruments_router,
    field_sales_router,
    commitments_router,
    travel_expense_router,
    reports_v17_router,
    analytics_v17_router,
    recycle_bin_router,
    audit_log_router,
    reports_router,
    rfp_router,
    roles_router,
    tender_router,
    theme_router,
    storage_router,
    travel_router,
    workorder_router,
    user_location_router,
)
from app.routers import consignee_router, lead_integrations_router, search_router, form_config_router
from app.routers import report_engine_router
from app.routers import sticky_notes_router
from app.routers import chat_router
from app.services.sticky_note_service import run_sticky_note_reminders
from app.services.chat_service import run_chat_maintenance_for_all_tenants

# Setup logging
setup_logging()
from app.services import platform_logs  # noqa: E402
platform_logs.install("api")  # Logs explorer: every log record also goes to platform_log_entries
logger = logging.getLogger(__name__)


# ─── Scheduled jobs (Jobs & queues): every loop runs its work through platform_jobs.run, which records each run ───
from app.services import platform_jobs  # noqa: E402


def _run_due_backups():
    from datetime import datetime
    from app.database import MasterSessionLocal, master_engine
    from sqlalchemy import text
    from app.models.platform_backup import TenantBackup
    from app.models.tenant import Tenant
    from app.services.platform_backup_service import run_backup
    started = 0
    # A MySQL advisory lock keeps multiple application workers from running the same schedule at once.
    with master_engine.connect() as lock_connection:
        if lock_connection.execute(text("SELECT GET_LOCK('platform_backup_scheduler', 0)")).scalar() != 1:
            return "another worker is checking the schedules"
        try:
            with MasterSessionLocal() as db:
                for backup in db.query(TenantBackup).filter(TenantBackup.frequency.isnot(None), TenantBackup.next_run_at <= datetime.utcnow()).all():
                    tenant = db.get(Tenant, backup.tenant_id)
                    if tenant:
                        copy = TenantBackup(tenant_id=backup.tenant_id, name=backup.name, frequency=backup.frequency, status='pending')
                        backup.frequency = None
                        backup.next_run_at = None
                        db.add(copy); db.commit()
                        run_backup(db, copy, tenant)
                        started += 1
        finally:
            lock_connection.execute(text("SELECT RELEASE_LOCK('platform_backup_scheduler')"))
    return {"backups_run": started}


def _metrics_flush():
    from app.services import platform_monitoring, platform_usage
    platform_monitoring.flush()  # every worker writes its own finished minutes
    platform_usage.flush()  # hourly tenant usage meters


def _alert_evaluation():
    from app.services import platform_monitoring
    return platform_monitoring.evaluate()  # alert rules, once per minute across workers


def _storage_jobs():
    from app.services import platform_storage
    platform_storage.tick()  # file opens; storage index, scans and lifecycle policies run in their own thread


def _data_transfer_housekeeping():
    from app.services import tenant_data_transfer, tenant_migration
    return {"exports": tenant_data_transfer.recover_and_expire(), "migrations": tenant_migration.housekeeping()}


def _uptime_sample():
    from app.services import platform_uptime
    platform_uptime.sample()


def _sandbox_housekeeping():
    from app.services import platform_sandboxes
    return platform_sandboxes.housekeeping()


def _billing_dunning():
    from app.database import MasterSessionLocal
    from app.services import platform_invoicing
    with MasterSessionLocal() as db:
        return platform_invoicing.run_dunning(db)


def _instrument_alerts():
    from app.services.instrument_service import run_jobs_for_all_tenants
    return run_jobs_for_all_tenants()


def _order_milestone_alerts():
    from app.services.order_service import run_milestone_alerts_for_all_tenants
    return run_milestone_alerts_for_all_tenants()


def _usage_close():
    from app.database import MasterSessionLocal
    from app.services import platform_addons
    with MasterSessionLocal() as db:
        return platform_addons.close_months(db)


def _report_schedules():
    from app.services.reports_v17_service import run_due_schedules
    return run_due_schedules()


def _schema_auto_increment():
    """Every tenant database: integer id columns are PRIMARY KEY + AUTO_INCREMENT (repairs manual imports / restores)."""
    from app.services.schema_integrity import repair_all_tenants
    return repair_all_tenants()


def _release_pipeline():
    from app.services import platform_capacity, platform_releases
    return {"pipeline": platform_releases.reconcile(), "capacity": platform_capacity.sample()}


for _key, _name, _schedule, _interval, _fn in [
    ("uptime_sample", "Uptime & server health sample", "every 1 min", 60, _uptime_sample),
    ("metrics_flush", "Metrics & usage metering rollup", "every 1 min", 60, _metrics_flush),
    ("alert_evaluation", "Alert evaluation", "every 1 min", 60, _alert_evaluation),
    ("storage_jobs", "Storage index, malware scans & lifecycle policies", "every 1 min", 60, _storage_jobs),
    ("release_pipeline", "Release pipeline checks & capacity sampling", "every 1 min", 60, _release_pipeline),
    ("usage_close", "Usage overage – close finished months for billing", "every 6 h", 6 * 3600, _usage_close),
    ("billing_dunning", "Invoice dunning (reminders, retries, suspension requests)", "every 15 min", 15 * 60, _billing_dunning),
    ("sandbox_housekeeping", "Sandbox expiry, stalled builds & change-set detection", "every 5 min", 5 * 60, _sandbox_housekeeping),
    ("data_transfer_housekeeping", "Export & migration housekeeping (cut-overs, expiry, recovery)", "every 1 min", 60, _data_transfer_housekeeping),
    ("scheduled_backups", "Scheduled tenant backups", "every 1 min", 60, _run_due_backups),
    ("approval_escalation", "Approval escalations", "every 1 min", 60, run_approval_escalation_maintenance_for_all_tenants),
    ("sticky_note_reminders", "Sticky-note reminders", "every 1 min", 60, run_sticky_note_reminders),
    ("chat_maintenance", "Team Chat — scheduled messages & retention purge", "every 1 min", 60, run_chat_maintenance_for_all_tenants),
    ("kam_weekly_plan", "KAM weekly plans & CEO reports", "every 15 min", 15 * 60, run_weekly_plan_maintenance_for_all_tenants),
    ("notification_maintenance", "Notification maintenance (due-date events)", "every 6 h", 6 * 3600, run_due_notification_maintenance_for_all_tenants),
    ("followup_alerts", "Follow-up alerts", "every 6 h", 6 * 3600, run_followup_alert_maintenance_for_all_tenants),
    ("order_milestone_alerts", "Orders & Projects – overdue milestone alerts", "every 6 h", 6 * 3600, _order_milestone_alerts),
    ("instrument_alerts", "Guarantees & Deposits – expiry reminders & unreleased escalation", "every 6 h", 6 * 3600, _instrument_alerts),
    ("report_schedules", "Reports – scheduled report deliveries", "every 5 min", 5 * 60, _report_schedules),
    ("schema_auto_increment", "Tenant schema – id columns keep PRIMARY KEY + AUTO_INCREMENT", "every 1 h", 3600, _schema_auto_increment),
]:
    platform_jobs.register(_key, _name, _schedule, _interval, _fn)


async def _notification_maintenance_loop():
    while True:
        try:
            summary = await asyncio.to_thread(platform_jobs.run, "notification_maintenance")
            changed = {
                tenant: counts
                for tenant, counts in summary.items()
                if any(int(value or 0) > 0 for value in counts.values())
            }
            if changed:
                logger.info("Dynamic notification maintenance sent events: %s", changed)
        except Exception as exc:
            logger.warning("Dynamic notification maintenance failed: %s", exc)
        await asyncio.sleep(6 * 60 * 60)


async def _inbox_scheduled_mail_loop():
    """Inbox: send scheduled mail when its time comes (also dispatched lazily on mailbox activity)."""
    from app.services.inbox_service import dispatch_scheduled_all_tenants, send_daily_digests_all_tenants
    tick = 0
    while True:
        try:
            sent = await asyncio.to_thread(dispatch_scheduled_all_tenants)
            if sent:
                logger.info("Inbox scheduled mail sent: %s", sent)
        except Exception as exc:
            logger.warning("Inbox scheduled mail dispatch failed: %s", exc)
        if tick % 5 == 0:  # Delivery preferences → Daily digest, checked every 5 minutes
            try:
                digests = await asyncio.to_thread(send_daily_digests_all_tenants)
                if digests:
                    logger.info("Daily digests sent: %s", digests)
            except Exception as exc:
                logger.warning("Daily digest run failed: %s", exc)
        tick += 1
        await asyncio.sleep(60)


async def _sticky_note_reminder_loop():
    while True:
        try:
            await asyncio.to_thread(platform_jobs.run, "sticky_note_reminders")
        except Exception:
            logger.exception("Sticky note reminder maintenance failed")
        await asyncio.sleep(60)


async def _followup_alert_loop():
    while True:
        try:
            summary = await asyncio.to_thread(platform_jobs.run, "followup_alerts")
            if summary:
                logger.info("Follow-up alerts sent: %s", summary)
        except Exception as exc:
            logger.warning("Follow-up alert maintenance failed: %s", exc)
        await asyncio.sleep(6 * 60 * 60)


async def _kam_weekly_plan_loop():
    while True:
        try:
            summary = await asyncio.to_thread(platform_jobs.run, "kam_weekly_plan")
            changed = {
                tenant: counts
                for tenant, counts in summary.items()
                if int(counts.get("ceo_reports_sent") or 0) > 0
            }
            if changed:
                logger.info("KAM weekly plan CEO reports sent: %s", changed)
        except Exception as exc:
            logger.warning("KAM weekly plan maintenance failed: %s", exc)
        await asyncio.sleep(15 * 60)


async def _approval_escalation_loop():
    while True:
        logger.info("Approval escalation loop: running check...")
        try:
            summary = await asyncio.to_thread(platform_jobs.run, "approval_escalation")
            logger.info("Approval escalation loop: result=%s", summary)
        except Exception as exc:
            logger.warning("Approval escalation maintenance failed: %s", exc)
        await asyncio.sleep(60)


async def _platform_uptime_loop():
    from app.services import platform_uptime

    await asyncio.to_thread(platform_uptime.record_start)
    while True:
        for key, label in (("uptime_sample", "Platform uptime sample"), ("metrics_flush", "Platform metrics flush"), ("alert_evaluation", "Alert evaluation"),
                           ("storage_jobs", "Platform storage cycle"), ("data_transfer_housekeeping", "Data export & migration housekeeping"),
                           ("release_pipeline", "Release pipeline checks")):
            try:
                await asyncio.to_thread(platform_jobs.run, key)
            except Exception as exc:
                logger.warning("%s failed: %s", label, exc)
        await asyncio.sleep(60 - time.time() % 60 + 1)


async def _platform_interval_loop():
    """Registered jobs that run on their own interval (each job is idempotent and guards against other workers itself)."""
    last: dict[str, float] = {}
    while True:
        for key, label in (("billing_dunning", "Invoice dunning"), ("usage_close", "Usage overage close"), ("sandbox_housekeeping", "Sandbox housekeeping"),
                           ("order_milestone_alerts", "Order milestone alerts"), ("instrument_alerts", "Instrument alerts"),
                           ("report_schedules", "Scheduled reports"), ("schema_auto_increment", "Tenant schema AUTO_INCREMENT check")):
            if time.time() - last.get(key, 0) >= platform_jobs.JOBS[key]["interval"]:
                last[key] = time.time()
                try:
                    await asyncio.to_thread(platform_jobs.run, key)
                except Exception as exc:
                    logger.warning("%s failed: %s", label, exc)
        await asyncio.sleep(60)


async def _platform_backup_loop():
    while True:
        await asyncio.sleep(60)
        try:
            await asyncio.to_thread(platform_jobs.run, "scheduled_backups")
        except Exception:
            logger.exception('Scheduled backup check failed')

@asynccontextmanager
async def lifespan(_app: FastAPI):
    background_tasks = []
    logger.info("Starting %s v%s", settings.APP_NAME, settings.APP_VERSION)

    try:
        db_info = settings.MASTER_DATABASE_URL.split("@")[-1]
    except Exception:
        db_info = "Unknown DB"

    logger.info("   Master DB: %s", db_info)
    logger.info("   Debug: %s", settings.DEBUG)

    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)

    # Team Chat: bind the real event loop so sync (threadpool) REST routes can still
    # schedule a realtime push — see chat_realtime.schedule_publish()'s docstring.
    from app.services import chat_realtime
    chat_realtime.bind_main_loop(asyncio.get_running_loop())

    try:
        from app.models import platform_backup, tenant_hierarchy  # noqa: F401
        from app.services.tenant_hierarchy import ensure_schema as ensure_tenant_hierarchy_schema
        create_master_tables()
        ensure_tenant_hierarchy_schema()
        # Release pipeline, capacity samples and change calendar: created before any request reads them
        # (a request transaction older than a lazily created table fails with MariaDB error 1412).
        from app.services import platform_capacity, platform_changes, platform_releases
        platform_releases.ensure_schema()
        platform_capacity.ensure_schema()
        platform_changes.ensure_schema()
        from app.services import platform_support  # announcements, their audience and read receipts
        platform_support.ensure_schema()
        from app.services import platform_sandboxes  # sandboxes, baselines and change sets
        platform_sandboxes.ensure_schema()
        from app.services import platform_regions  # registered regions and failover-test results
        platform_regions.ensure_schema()
        from app.services import platform_discounts  # coupons, redemptions, tiers, negotiated discounts
        platform_discounts.ensure_schema()
        from app.services import platform_invoicing  # payments, credit notes, reminders, dunning, gateway events
        platform_invoicing.ensure_schema()
        from app.services import platform_addons  # add-on catalogue, subscriptions, usage rates and charges, price books
        platform_addons.ensure_schema()
        from app.services import platform_mobile
        platform_mobile.ensure_schema()
        from app.services import platform_marketplace
        platform_marketplace.ensure_schema()
        from app.services import platform_revenue
        platform_revenue.ensure_schema()
        platform_revenue.install_listener()
        from app.services import platform_finops  # monthly cost & margin history (Cost & margin)
        platform_finops.ensure_schema()
        from app.services import platform_api_keys  # API keys (scopes, rotation), plan limits (daily cap), API versions
        platform_api_keys.ensure_schema()
        from app.services import platform_customer_success
        platform_customer_success.ensure_schema()
        _seed_platform_data()
        sync_tenant_user_auth_columns()
        sync_tenant_competitor_columns()
        sync_tenant_document_folder_columns()
        sync_tenant_quotation_approval_columns()
        sync_tenant_approval_escalation_schema()
        sync_tenant_misc_columns()
        sync_tenant_missing_permissions()
        sync_tenant_runtime_catalogs()
        try:  # Inbox & Notifications tables (mail, threads, recipients, attachments, templates, delivery preferences)
            from app.services.inbox_service import ensure_inbox_schema_all_tenants
            ensure_inbox_schema_all_tenants()
        except Exception as exc:
            logger.error("Inbox schema sync failed: %s", exc)
        try:  # Team Chat tables (conversations, messages, attachments, reactions, polls, …)
            from app.services.chat_schema import ensure_chat_schema_all_tenants
            ensure_chat_schema_all_tenants()
        except Exception as exc:
            logger.error("Team Chat schema sync failed: %s", exc)
        try:  # Calendar & Tasks tables (tasks, Google Calendar connections, sync mapping)
            from app.services.calendar_service import ensure_calendar_schema_all_tenants
            ensure_calendar_schema_all_tenants()
        except Exception as exc:
            logger.error("Calendar schema sync failed: %s", exc)
        try:  # Notes & Pinboard: record-link columns on sticky_notes (before the note reminder job reads the table)
            from app.routers.notes_router import ensure_notes_schema_all_tenants
            ensure_notes_schema_all_tenants()
        except Exception as exc:
            logger.error("Notes schema sync failed: %s", exc)
        try:  # Customers & Contacts – Customer 360 side tables (hierarchy level, KAM coverage, account plan, buying roles)
            from app.services.customer360_service import ensure_schema_all_tenants as ensure_c360
            ensure_c360()
        except Exception as exc:
            logger.error("Customer 360 schema sync failed: %s", exc)
        try:  # Leads (prototype v17): contact link + notes tables, lead scoring settings
            from app.services.lead360_service import ensure_schema_all_tenants as ensure_leads360
            ensure_leads360()
        except Exception as exc:
            logger.error("Leads schema sync failed: %s", exc)
        try:  # Application settings (prototype v17 p25): app_settings + app_setting_changes tables
            from app.services.app_settings_service import ensure_schema_all_tenants as ensure_app_settings
            ensure_app_settings()
        except Exception as exc:
            logger.error("App settings schema sync failed: %s", exc)
        try:  # Users & Teams / Roles & Security (prototype v17): territories, sharing rules, field security
            from app.services.admin360_service import ensure_schema_all_tenants as ensure_admin360
            ensure_admin360()
        except Exception as exc:
            logger.error("Admin360 schema sync failed: %s", exc)
        try:  # Customization Studio (prototype v17): form_fields extra columns, custom objects, validation rules
            from app.services.studio_service import ensure_schema_all_tenants as ensure_studio
            ensure_studio()
        except Exception as exc:
            logger.error("Studio schema sync failed: %s", exc)
        try:  # Funnel & analytics (Intelligence): Customer.sub_segment_id column + workflow_record_stage_history
            from app.services.funnel_service import ensure_schema_all_tenants as ensure_funnel
            ensure_funnel()
        except Exception as exc:
            logger.error("Funnel schema sync failed: %s", exc)
        try:  # Process Designer (prototype v17): process_config / process_stage_extras / process_lifecycles
            from app.services.process_service import ensure_schema_all_tenants as ensure_process
            ensure_process()
        except Exception as exc:
            logger.error("Process designer schema sync failed: %s", exc)
        try:  # Marketplace & API (prototype v17): tenant_integrations
            from app.services.integrations360_service import ensure_schema_all_tenants as ensure_integrations360
            ensure_integrations360()
        except Exception as exc:
            logger.error("Integrations schema sync failed: %s", exc)
        try:  # Partners & OEM / Competitive Intel (prototype v17): oems columns + indexes
            from app.services.directory_service import ensure_schema_all_tenants as ensure_directory
            ensure_directory()
        except Exception as exc:
            logger.error("Directory schema sync failed: %s", exc)
        try:  # Masters (prototype v17): master_defs / master_values
            from app.services.masters360_service import ensure_schema_all_tenants as ensure_masters360
            ensure_masters360()
        except Exception as exc:
            logger.error("Masters schema sync failed: %s", exc)
        for _label, _mod in (("Document hub", "dochub_service"), ("Correspondence", "correspondence_service"), ("Data hub", "datahub_service")):
            try:  # prototype v17 modules: columns / tables created per tenant
                __import__(f"app.services.{_mod}", fromlist=["ensure_schema_all_tenants"]).ensure_schema_all_tenants()
            except Exception as exc:
                logger.error("%s schema sync failed: %s", _label, exc)
        try:  # Lead capture forms (prototype v17): forms + submissions tables
            from app.services.capture_form_service import ensure_schema_all_tenants as ensure_capture
            ensure_capture()
        except Exception as exc:
            logger.error("Capture forms schema sync failed: %s", exc)
        try:  # Deals (prototype v17): pipelines & stages (default Tender / Quotation pipelines), deal profiles
            from app.services.deal_service import ensure_schema_all_tenants as ensure_deals
            ensure_deals()
        except Exception as exc:
            logger.error("Deals schema sync failed: %s", exc)
        try:  # Bids & Tenders (prototype v17): tender workflow (default stages), bid side tables, settings
            from app.services.bid_service import ensure_schema_all_tenants as ensure_bids
            ensure_bids()
        except Exception as exc:
            logger.error("Bids & Tenders schema sync failed: %s", exc)
        try:  # Quotes (prototype v17): quote lifecycle (default stages), quote profiles, line discount / product columns
            from app.services.quote_service import ensure_schema_all_tenants as ensure_quotes
            ensure_quotes()
        except Exception as exc:
            logger.error("Quotes schema sync failed: %s", exc)
        try:  # Product & Price Books (prototype v17): catalogue columns, price books, overrides, price history, notes
            from app.services.product_service import ensure_schema_all_tenants as ensure_products
            ensure_products()
        except Exception as exc:
            logger.error("Product & Price Books schema sync failed: %s", exc)
        try:  # Forecasts (prototype v17): manager adjustments, submitted forecast snapshots (versions + per-rep lines)
            from app.services.forecast_service import ensure_schema_all_tenants as ensure_forecasts
            ensure_forecasts()
        except Exception as exc:
            logger.error("Forecasts schema sync failed: %s", exc)
        try:  # Orders & Projects (prototype v17): order lifecycles (default Project / Supply stages), order profiles, notes
            from app.services.order_service import ensure_schema_all_tenants as ensure_orders
            ensure_orders()
        except Exception as exc:
            logger.error("Orders & Projects schema sync failed: %s", exc)
        try:  # Guarantees & Deposits (prototype v17): instrument types, profiles (release / extension / margin / FDR), notes
            from app.services.instrument_service import ensure_schema_all_tenants as ensure_instruments
            ensure_instruments()
        except Exception as exc:
            logger.error("Guarantees & Deposits schema sync failed: %s", exc)
        try:  # Field Sales 360 (prototype v17): visit check-in / check-out details, annual KAM targets + history
            from app.services.field_sales_service import ensure_schema_all_tenants as ensure_field_sales
            ensure_field_sales()
        except Exception as exc:
            logger.error("Field Sales 360 schema sync failed: %s", exc)
        try:  # Commitments (prototype v18): commitments + entries, teams, settings, order payment receipts
            from app.services.commitment_service import ensure_schema_all_tenants as ensure_commitments
            ensure_commitments()
        except Exception as exc:
            logger.error("Commitments schema sync failed: %s", exc)
        try:  # Travel & Expense (prototype v17): advance transactions (disbursed / refunded), trip notes
            from app.services.travel_expense_service import ensure_schema_all_tenants as ensure_travel_expense
            ensure_travel_expense()
        except Exception as exc:
            logger.error("Travel & Expense schema sync failed: %s", exc)
        try:  # Reports (prototype v17): favourites, schedules, execution / delivery history
            from app.services.reports_v17_service import ensure_schema_all_tenants as ensure_reports_v17
            ensure_reports_v17()
        except Exception as exc:
            logger.error("Reports schema sync failed: %s", exc)
        sync_tenant_letter_management_tables()
        sync_tenant_letter_management_columns()
        try:
            get_firebase_app()
        except FirebaseConfigurationError as exc:
            logger.warning("Firebase Admin SDK not initialized: %s", exc)
        _run_tada_migrations()
        _sync_report_engine_tables()
        _seed_report_engine_data()
    except Exception as e:
        logger.error("Startup error: %s", e)

    background_tasks.append(asyncio.create_task(_platform_backup_loop()))
    background_tasks.append(asyncio.create_task(_platform_uptime_loop()))
    background_tasks.append(asyncio.create_task(_platform_interval_loop()))
    background_tasks.append(asyncio.create_task(_notification_maintenance_loop()))
    background_tasks.append(asyncio.create_task(_sticky_note_reminder_loop()))
    background_tasks.append(asyncio.create_task(_inbox_scheduled_mail_loop()))
    background_tasks.append(asyncio.create_task(_followup_alert_loop()))
    background_tasks.append(asyncio.create_task(_kam_weekly_plan_loop()))
    background_tasks.append(asyncio.create_task(_approval_escalation_loop()))
    try:  # outgoing webhook deliveries and retries (API & webhooks)
        from app.services import platform_webhooks
        platform_webhooks.start_worker()
    except Exception as exc:
        logger.error("Webhook worker not started: %s", exc)
    try:  # scheduled mobile push notifications (Mobile app control)
        from app.services import platform_mobile
        platform_mobile.start_push_worker()
    except Exception as exc:
        logger.error("Mobile push worker not started: %s", exc)
    try:  # subscription ledger: baseline + periodic reconcile (Revenue analytics)
        from app.services import platform_revenue
        platform_revenue.record(None, "reconcile")
        platform_revenue.start_worker()
    except Exception as exc:
        logger.error("Subscription ledger not started: %s", exc)
    try:  # hourly cost & margin snapshot (Cost & margin trend)
        from app.services import platform_finops
        platform_finops.start_worker()
    except Exception as exc:
        logger.error("Cost & margin worker not started: %s", exc)

    try:  # after every module's schema sync above: integer id columns are PRIMARY KEY + AUTO_INCREMENT in every tenant
        from app.services.schema_integrity import repair_all_tenants
        _ai = repair_all_tenants()
        if _ai:
            logger.warning("Tenant AUTO_INCREMENT check: %s", _ai)
    except Exception as exc:
        logger.error("Tenant AUTO_INCREMENT check failed: %s", exc)

    logger.info("App ready -- Swagger at /docs")

    yield

    for background_task in background_tasks:
        background_task.cancel()
        try:
            await background_task
        except asyncio.CancelledError:
            pass

    logger.info("Shutdown complete")


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="DigitCRM SaaS Backend",
    lifespan=lifespan,
)

# CORS FIRST
logger.info("CORS allowed origins: %s", settings.ALLOWED_ORIGINS)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Tenant middleware
app.add_middleware(TenantResolverMiddleware)
app.add_middleware(SessionActivityMiddleware)

from app.services import platform_rate_limits  # noqa: E402


def _content_length(response) -> int:
    """Response bytes for the egress meter; streamed responses carry no Content-Length and count as 0."""
    try:
        return int(response.headers.get("content-length") or 0) if response is not None else 0
    except (TypeError, ValueError):
        return 0


@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.perf_counter()
    response = None
    # Tenant of every log line written while serving this request (validated against the tenants table when stored).
    tenant_token = platform_logs.current_tenant.set((request.headers.get("x-tenant-slug") or request.query_params.get("tenant") or "").strip().lower() or None)
    try:
        response = await call_next(request)
        if request.url.path.startswith("/api/v"):   # Deprecation / Sunset on a deprecated API version (Rate limits & API keys)
            response.headers.update(platform_rate_limits.deprecation_headers(request.url.path))
        return response
    finally:
        ms = (time.perf_counter() - start) * 1000
        platform_traffic.record(request.url.path, response.status_code if response else 500, ms, getattr(request.state, "tenant_slug", None),
                                _content_length(response))
        platform_logs.record_request(request.method, request.url.path, response.status_code if response else 500, ms,
                                     getattr(request.state, "tenant_slug", None) or platform_logs.current_tenant.get())
        platform_logs.current_tenant.reset(tenant_token)

        if ms >= 1000:
            logger.warning(
                "SLOW API %s %s took %.1fms",
                request.method,
                request.url.path,
                ms,
            )
        else:
            logger.info(
                "API %s %s -> %.1fms",
                request.method,
                request.url.path,
                ms,
            )

_FIELD_LABELS = {
    "emd": "EMD", "nit": "Tender / NIT number", "submit": "Submission date", "customer_id": "Customer", "gst_number": "GSTIN",
    "pan_number": "PAN", "est_value": "Expected value", "valid_till": "Valid till", "follow_up": "Follow-up date",
    "owner_id": "Owner", "pm_id": "Project manager", "po": "PO number", "ref": "Reference number", "gst_percent": "GST %",
    "list_price": "List price", "std_cost": "Standard cost", "close": "Close date", "due": "Due date", "start": "Start date",
}


@app.exception_handler(RequestValidationError)
async def request_validation_handler(request: Request, exc: RequestValidationError):
    """422 with user-facing messages plus a {field: message} map so forms can show each error under its field.
    `detail` keeps FastAPI's list shape (loc / msg / type) for existing clients."""
    detail, field_errors = [], {}
    for err in exc.errors():
        loc = [str(x) for x in err.get("loc", ()) if x not in ("body", "query", "path")]
        msg = str(err.get("msg", "Invalid value")).removeprefix("Value error, ").removeprefix("Assertion failed, ")
        etype = err.get("type", "")
        key0 = loc[-1] if loc else "value"
        label = _FIELD_LABELS.get(key0) or key0.replace("_", " ").capitalize()
        if etype == "missing":
            msg = f"{label} is required."
        elif etype in ("float_parsing", "int_parsing", "decimal_parsing", "float_type", "int_type"):
            msg = f"{label} must be a valid number."
        elif etype in ("date_parsing", "date_from_datetime_parsing", "date_type"):
            msg = f"{label} is not a valid date."
        elif etype == "string_too_long":
            msg = f"{label} cannot exceed {err.get('ctx', {}).get('max_length')} characters."
        elif etype == "string_too_short":
            msg = f"{label} is required." if err.get("ctx", {}).get("min_length") == 1 else f"{label} must be at least {err.get('ctx', {}).get('min_length')} characters."
        elif etype in ("greater_than_equal", "greater_than") and err.get("ctx", {}).get("ge", err.get("ctx", {}).get("gt")) in (0, 0.0):
            msg = f"{label} cannot be negative."
        detail.append({"loc": ["body", *loc], "msg": msg, "type": etype})
        key = ".".join(loc)
        if key and key not in field_errors:
            field_errors[key] = msg
    return JSONResponse(status_code=422, content={"detail": detail, "field_errors": field_errors})


@app.exception_handler(DataError)
async def data_error_handler(request: Request, exc: DataError):
    logger.warning("Database data error: %s", exc.orig)
    orig = str(exc.orig) if exc.orig else str(exc)
    if "Data too long for column" in orig:
        import re
        col = re.search(r"column '(\w+)'", orig)
        field = col.group(1).replace("_", " ").title() if col else "a field"
        detail = f"'{field}' value is too long. Please shorten your input."
    else:
        detail = "One or more values are invalid (out of range or wrong format)."
    return JSONResponse(status_code=422, content={"detail": detail})


@app.exception_handler(IntegrityError)
async def integrity_error_handler(request: Request, exc: IntegrityError):
    logger.warning("Database integrity error: %s", exc.orig)
    orig = str(exc.orig) if exc.orig else str(exc)
    if "Duplicate entry" in orig:
        import re
        val = re.search(r"Duplicate entry '(.+?)' for key", orig)
        key = re.search(r"for key '(.+?)'", orig)
        field = key.group(1).split(".")[-1].replace("_", " ").title() if key else "field"
        entry = val.group(1) if val else "this value"
        detail = f"'{entry}' already exists for {field}. Please use a different value."
    elif "cannot be null" in orig.lower():
        import re
        col = re.search(r"Column '(\w+)'", orig)
        field = col.group(1).replace("_", " ").title() if col else "A required field"
        detail = f"{field} is required and cannot be empty."
    else:
        detail = "This record conflicts with an existing entry."
    return JSONResponse(status_code=409, content={"detail": detail})


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error("Unhandled exception: %s", exc, exc_info=True)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


# Static files
os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=settings.UPLOAD_DIR), name="uploads")


# Routers
app.include_router(platform_router.router, prefix="/api/v1/platform")
app.include_router(auth_router.router, prefix="/api/v1/auth")
app.include_router(customer_router.router, prefix="/api/v1/customers")
app.include_router(lead_router.router, prefix="/api/v1/leads")
app.include_router(tender_router.router, prefix="/api/v1/tenders")
app.include_router(oem_router.router, prefix="/api/v1/oems")
app.include_router(workorder_router.router, prefix="/api/v1/workorders")
app.include_router(emdbg_router.router, prefix="/api/v1/emdbg")
app.include_router(dashboard_router.router, prefix="/api/v1/dashboard")
app.include_router(alerts_router.router, prefix="/api/v1/alerts")
app.include_router(reports_router.router, prefix="/api/v1/reports")
app.include_router(kam_router.router, prefix="/api/v1/kam")
app.include_router(kam_user_location_router.router, prefix="/api/v1/kam")
app.include_router(kam_activity_reopen_router.router, prefix="/api/v1/kam")
app.include_router(notifications_router.router, prefix="/api/v1/notifications")
app.include_router(inbox_router.router, prefix="/api/v1/inbox")
app.include_router(calendar_router.router, prefix="/api/v1/calendar")
app.include_router(notes_router.router, prefix="/api/v1/notes")
app.include_router(customer360_router.router, prefix="/api/v1/customer360")
app.include_router(lead360_router.router, prefix="/api/v1/lead360")
app.include_router(app_settings_router.router, prefix="/api/v1/app-settings")
app.include_router(admin360_router.router, prefix="/api/v1/admin360")
app.include_router(automation_router.router, prefix="/api/v1/automation")
app.include_router(funnel_router.router, prefix="/api/v1/funnel")
app.include_router(studio_router.router, prefix="/api/v1/studio")
app.include_router(process_router.router, prefix="/api/v1/process")
app.include_router(integrations360_router.router, prefix="/api/v1/integrations360")
app.include_router(directory_router.router, prefix="/api/v1/directory")
app.include_router(masters360_router.router, prefix="/api/v1/masters360")
app.include_router(approvals360_router.router, prefix="/api/v1/approvals360")
app.include_router(dochub_router.router, prefix="/api/v1/dochub")
app.include_router(correspondence_router.router, prefix="/api/v1/correspondence")
app.include_router(datahub_router.router, prefix="/api/v1/datahub")
app.include_router(capture_forms_router.router, prefix="/api/v1/capture-forms")
app.include_router(capture_public_router.router, prefix="/api/v1/public/capture")
app.include_router(deals_router.router, prefix="/api/v1/deals")
app.include_router(bids_router.router, prefix="/api/v1/bids")
app.include_router(travel_router.router, prefix="/api/v1/travel")
app.include_router(theme_router.router, prefix="/api/v1/settings")
app.include_router(storage_router.router, prefix="/api/v1/storage")
app.include_router(approvals_router.router, prefix="/api/v1/approvals")
app.include_router(approval_workflow_router.router, prefix="/api/v1/approval-workflows")
app.include_router(rfp_router.router, prefix="/api/v1/rfp")
app.include_router(letter_router.router, prefix="/api/v1/letters")
app.include_router(document_management_router.router, prefix="/api/v1/document-management")
app.include_router(masters_router.router, prefix="/api/v1/masters")
app.include_router(questionnaire_router.router, prefix="/api/v1/questionnaire")
app.include_router(modules_router.router, prefix="/api/v1/modules")
app.include_router(chat_router.router, prefix="/api/v1/team-chat")
from app.routers import platform_backup_router
app.include_router(platform_backup_router.router)
from app.routers import platform_tenant_hierarchy_router
app.include_router(platform_tenant_hierarchy_router.router)
app.include_router(platform_tenant_hierarchy_router.public_router)
from app.routers import platform_control_router
app.include_router(platform_control_router.router)
from app.routers import platform_database_router
app.include_router(platform_database_router.router)
from app.routers import platform_monitoring_router
app.include_router(platform_monitoring_router.router)
from app.routers import platform_usage_router
app.include_router(platform_usage_router.router)
from app.routers import platform_storage_router
app.include_router(platform_storage_router.router)
from app.routers import platform_data_transfer_router
app.include_router(platform_data_transfer_router.router)
from app.routers import platform_logs_router
app.include_router(platform_logs_router.router)
from app.routers import platform_jobs_router
app.include_router(platform_jobs_router.router)
from app.routers import platform_billing_router
app.include_router(platform_billing_router.router)
from app.routers import platform_entitlements_router
app.include_router(platform_entitlements_router.router)
from app.routers import platform_workflow_templates_router
app.include_router(platform_workflow_templates_router.router)
from app.routers import platform_security_router
app.include_router(platform_security_router.router)
from app.routers import platform_trust_safety_router
app.include_router(platform_trust_safety_router.router)
from app.routers import platform_audit_trail_router
app.include_router(platform_audit_trail_router.router)
from app.routers import platform_support_router, support_router
app.include_router(platform_support_router.router)
app.include_router(support_router.router, prefix="/api/v1/support")
from app.routers import platform_addons_router, platform_announcements_router, platform_discounts_router, platform_invoicing_router, platform_regions_router, platform_sandboxes_router
app.include_router(platform_announcements_router.router)
app.include_router(platform_announcements_router.tenant_router)
app.include_router(platform_sandboxes_router.router)
app.include_router(platform_regions_router.router)
app.include_router(platform_discounts_router.router)
app.include_router(platform_invoicing_router.router)
app.include_router(platform_invoicing_router.webhook_router)
app.include_router(platform_addons_router.router)
from app.routers import platform_api_webhooks_router, webhooks_router
app.include_router(platform_api_webhooks_router.router)
app.include_router(webhooks_router.router, prefix="/api/v1/webhooks")
from app.routers import platform_resellers_router
app.include_router(platform_resellers_router.router)
from app.routers import platform_mobile_router, mobile_router
app.include_router(platform_mobile_router.router)
app.include_router(mobile_router.router, prefix="/api/v1/mobile")
from app.routers import platform_marketplace_router, marketplace_router
app.include_router(platform_marketplace_router.router)
app.include_router(marketplace_router.router, prefix="/api/v1/marketplace")
from app.routers import platform_revenue_router
app.include_router(platform_revenue_router.router)
from app.routers import platform_finops_router
app.include_router(platform_finops_router.router)
from app.routers import platform_rate_limits_router
app.include_router(platform_rate_limits_router.router)
from app.routers import platform_kpi_router
app.include_router(platform_kpi_router.router)
from app.routers import platform_sla_router
app.include_router(platform_sla_router.router)
app.include_router(platform_sla_router.public_router)
from app.routers import platform_customer_success_router
app.include_router(platform_customer_success_router.router)
from app.routers import platform_infrastructure_router
app.include_router(platform_infrastructure_router.router)
from app.routers import platform_changes_router
app.include_router(platform_changes_router.router)
app.include_router(roles_router.router, prefix="/api/v1/roles")
app.include_router(preview_router.router, prefix="/api/v1/preview")
app.include_router(consignee_router.router, prefix="/api/v1/consignees")
app.include_router(lead_integrations_router.router, prefix="/api/v1/integrations")
app.include_router(quotation_router.router, prefix="/api/v1/quotations")
app.include_router(quotes_router.router, prefix="/api/v1/quotes")
app.include_router(products_router.router, prefix="/api/v1/products")
app.include_router(forecasts_router.router, prefix="/api/v1/forecasts")
app.include_router(orders_router.router, prefix="/api/v1/orders")
app.include_router(instruments_router.router, prefix="/api/v1/instruments")
app.include_router(field_sales_router.router, prefix="/api/v1/field-sales")
app.include_router(commitments_router.router, prefix="/api/v1/commitments")
app.include_router(travel_expense_router.router, prefix="/api/v1/travel-expense")
app.include_router(reports_v17_router.router, prefix="/api/v1/report-catalogue")
app.include_router(analytics_v17_router.router, prefix="/api/v1/analytics-v17")
app.include_router(recycle_bin_router.router, prefix="/api/v1/recycle-bin")
app.include_router(audit_log_router.router, prefix="/api/v1/audit-logs")
app.include_router(sticky_notes_router.router, prefix="/api/v1/sticky-notes")
app.include_router(user_location_router.router, prefix="/api/v1/user-locations")
app.include_router(search_router.router, prefix="/api/v1/search")
app.include_router(form_config_router.router, prefix="/api/v1/form-config")
app.include_router(form_config_router.router, prefix="/api/v1/form-builder")
app.include_router(report_engine_router.router, prefix="/api/v1/reports")


# Health APIs
@app.get("/")
def root():
    return {"status": "ok"}


@app.get("/health")
def health():
    return {"status": "healthy"}


def _run_tada_migrations():
    """Auto-apply TA/DA column migrations on all active tenant DBs at startup."""
    import pymysql
    from sqlalchemy import create_engine

    from app.core.config import settings
    from app.database import MasterSessionLocal, TenantBase, build_tenant_db_name, tenant_db_url
    from app.models.tenant import Tenant
    import app.models.all_models  # noqa: F401 -- ensure all models are registered

    statements = [
        """ALTER TABLE tada_claims
          ADD COLUMN IF NOT EXISTS `claim_type`                VARCHAR(50)   DEFAULT 'travel'    AFTER `claim_date`,
          ADD COLUMN IF NOT EXISTS `travel_date_from`          DATE                               AFTER `claim_type`,
          ADD COLUMN IF NOT EXISTS `travel_date_to`            DATE                               AFTER `travel_date_from`,
          ADD COLUMN IF NOT EXISTS `num_days`                  INT                                AFTER `travel_date_to`,
          ADD COLUMN IF NOT EXISTS `from_city`                 VARCHAR(100)                       AFTER `num_days`,
          ADD COLUMN IF NOT EXISTS `to_city`                   VARCHAR(100)                       AFTER `from_city`,
          ADD COLUMN IF NOT EXISTS `purpose`                   VARCHAR(500)                       AFTER `to_city`,
          ADD COLUMN IF NOT EXISTS `mode_of_travel`            VARCHAR(100)                       AFTER `purpose`,
          ADD COLUMN IF NOT EXISTS `da_rate_per_day`           DECIMAL(10,2)                      AFTER `mode_of_travel`,
          ADD COLUMN IF NOT EXISTS `da_total`                  DECIMAL(12,2)                      AFTER `da_rate_per_day`,
          ADD COLUMN IF NOT EXISTS `expense_mode`              VARCHAR(50)                        AFTER `da_total`,
          ADD COLUMN IF NOT EXISTS `cost_center`               VARCHAR(100)                       AFTER `expense_mode`,
          ADD COLUMN IF NOT EXISTS `budget_code`               VARCHAR(100)                       AFTER `cost_center`,
          ADD COLUMN IF NOT EXISTS `department`                VARCHAR(100)                       AFTER `budget_code`,
          ADD COLUMN IF NOT EXISTS `manager_rejection_reason`  TEXT                               AFTER `manager_approved_at`,
          ADD COLUMN IF NOT EXISTS `accounts_status`           ENUM('pending','approved','rejected','paid') DEFAULT 'pending' AFTER `manager_rejection_reason`,
          ADD COLUMN IF NOT EXISTS `accounts_approval_id`      INT                                AFTER `accounts_status`,
          ADD COLUMN IF NOT EXISTS `accounts_approved_by`      INT                                AFTER `accounts_approval_id`,
          ADD COLUMN IF NOT EXISTS `accounts_approved_at`      DATETIME                           AFTER `accounts_approved_by`,
          ADD COLUMN IF NOT EXISTS `accounts_rejection_reason` TEXT                               AFTER `accounts_approved_at`,
          ADD COLUMN IF NOT EXISTS `payment_date`              DATE                               AFTER `accounts_rejection_reason`,
          ADD COLUMN IF NOT EXISTS `payment_reference`         VARCHAR(100)                       AFTER `payment_date`,
          ADD COLUMN IF NOT EXISTS `payment_mode`              ENUM('Bank Transfer','Cheque','Cash','UPI') AFTER `payment_reference`""",
        """ALTER TABLE tada_line_items
          MODIFY COLUMN `category` ENUM(
            'Transport Fare','Auto/Cab','Auto / Cab','Fuel','Accommodation',
            'Meals','Daily Allowance','Communication',
            'Toll/Parking','Toll / Parking','Visa/Passport','Miscellaneous'
          ) NOT NULL""",
        """ALTER TABLE activity_logs
          ADD COLUMN IF NOT EXISTS `icon`  VARCHAR(10)  DEFAULT 'pin' AFTER `description`,
          ADD COLUMN IF NOT EXISTS `color` VARCHAR(20)  DEFAULT '#EFF6FF' AFTER `icon`""",
        """ALTER TABLE tenders
          ADD COLUMN IF NOT EXISTS `po_doc`             VARCHAR(500) NULL,
          ADD COLUMN IF NOT EXISTS `no_of_consignee`    INT NULL COMMENT 'Number of consignees for PO',
          ADD COLUMN IF NOT EXISTS `bid_tracking`       VARCHAR(200) NULL COMMENT 'Bid tracking reference',
          ADD COLUMN IF NOT EXISTS `wrk_order_id`       VARCHAR(50)  NULL,
          ADD COLUMN IF NOT EXISTS `wo_value`           DECIMAL(10,0) NULL,
          ADD COLUMN IF NOT EXISTS `dlvry_date`         DATE         NULL,
          ADD COLUMN IF NOT EXISTS `instln_date`        DATE         NULL,
          ADD COLUMN IF NOT EXISTS `site_loc`           VARCHAR(30)  NULL,
          ADD COLUMN IF NOT EXISTS `site_eng`           VARCHAR(30)  NULL,
          ADD COLUMN IF NOT EXISTS `eng_phone`          VARCHAR(20)  NULL,
          ADD COLUMN IF NOT EXISTS `advance`            VARCHAR(10)  NULL,
          ADD COLUMN IF NOT EXISTS `retention`          VARCHAR(10)  NULL,
          ADD COLUMN IF NOT EXISTS `pmnt_terms`         TEXT         NULL,
          ADD COLUMN IF NOT EXISTS `sow`                TEXT         NULL,
          ADD COLUMN IF NOT EXISTS `step2_approved_at`  DATETIME     NULL,
          ADD COLUMN IF NOT EXISTS `step3_approved_at`  DATETIME     NULL,
          ADD COLUMN IF NOT EXISTS `listed_in_accounts` TINYINT(1)   NOT NULL DEFAULT 0""",
        """ALTER TABLE tenders
          MODIFY COLUMN `po_doc` VARCHAR(500) NULL""",
        """ALTER TABLE tender_documents
          MODIFY COLUMN `doc_type` ENUM(
            'Tender Document','BOQ','Workings','Corrigendum','OEM Document','PO Document','Other'
          ) NOT NULL DEFAULT 'Other'""",
        """ALTER TABLE tender_loss_analysis
          ADD COLUMN IF NOT EXISTS `loss_reason` TEXT NULL COMMENT 'Reason for losing the tender'""",
        """ALTER TABLE tender_consignees
          ADD COLUMN IF NOT EXISTS `tender_id`      INT          NULL COMMENT 'FK to tenders.id',
          ADD COLUMN IF NOT EXISTS `consignee_name` VARCHAR(255) NULL,
          ADD COLUMN IF NOT EXISTS `contact_phone`  VARCHAR(30)  NULL,
          ADD COLUMN IF NOT EXISTS `delivery_date`  DATE         NULL,
          ADD COLUMN IF NOT EXISTS `created_by`     INT          NULL""",
        """ALTER TABLE `groups`
          ADD COLUMN IF NOT EXISTS `role_id` INT NULL""",
        """CREATE TABLE IF NOT EXISTS `quotations` (
          `id`               INT          AUTO_INCREMENT PRIMARY KEY,
          `tenant_id`        INT          NULL,
          `lead_id`          INT          NOT NULL,
          `customer_id`      INT          NULL,
          `quotation_number` VARCHAR(50)  NOT NULL,
          `revision_number`  INT          NOT NULL DEFAULT 1,
          `subject`          VARCHAR(500) NULL,
          `amount`           DECIMAL(15,2) DEFAULT 0,
          `tax_amount`       DECIMAL(15,2) DEFAULT 0,
          `total_amount`     DECIMAL(15,2) DEFAULT 0,
          `valid_until`      DATE         NULL,
          `status`           ENUM('Draft','Sent','Approved','Accepted','Rejected') NOT NULL DEFAULT 'Draft',
          `notes`            TEXT         NULL,
          `terms_conditions` TEXT         NULL,
          `created_by`       INT          NULL,
          `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
          `updated_at`       DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE,
          INDEX `idx_quotation_lead` (`lead_id`),
          INDEX `idx_quotation_number` (`quotation_number`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""",
        """CREATE TABLE IF NOT EXISTS `quotation_line_items` (
          `id`           INT           AUTO_INCREMENT PRIMARY KEY,
          `quotation_id` INT           NOT NULL,
          `description`  VARCHAR(500)  NOT NULL,
          `quantity`     DECIMAL(10,2) DEFAULT 1,
          `unit_price`   DECIMAL(15,2) DEFAULT 0,
          `tax_percent`  DECIMAL(5,2)  DEFAULT 0,
          `line_total`   DECIMAL(15,2) DEFAULT 0,
          `sort_order`   INT           DEFAULT 0,
          FOREIGN KEY (`quotation_id`) REFERENCES `quotations`(`id`) ON DELETE CASCADE,
          INDEX `idx_qli_quotation` (`quotation_id`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""",
        """ALTER TABLE work_orders
          ADD COLUMN IF NOT EXISTS `lead_id`      INT NULL COMMENT 'FK to leads.id for direct opportunity flow',
          ADD COLUMN IF NOT EXISTS `quotation_id` INT NULL COMMENT 'FK to quotations.id for direct opportunity flow',
          ADD COLUMN IF NOT EXISTS `po_doc`       VARCHAR(500) NULL""",
        """ALTER TABLE work_orders
          MODIFY COLUMN `po_doc` VARCHAR(500) NULL""",
        """ALTER TABLE tender_consignees
          ADD COLUMN IF NOT EXISTS `lead_id` INT NULL COMMENT 'FK to leads.id for direct opportunity flow'""",
        """ALTER TABLE leads
          ADD COLUMN IF NOT EXISTS `lead_type` VARCHAR(30) NOT NULL DEFAULT 'lead'
            COMMENT 'lead = normal flow, direct_opportunity = created directly as opportunity'""",
        """ALTER TABLE report_type_fields
          ADD COLUMN IF NOT EXISTS `drilldown_kind`          VARCHAR(20)  NULL COMMENT 'NULL, detail, or report',
          ADD COLUMN IF NOT EXISTS `drilldown_target`        VARCHAR(100) NULL COMMENT 'Entity key for detail or report_type_key for report drilldown',
          ADD COLUMN IF NOT EXISTS `drilldown_id_field`      VARCHAR(100) NULL COMMENT 'Source field_key from current report row used as ID/filter value',
          ADD COLUMN IF NOT EXISTS `drilldown_filter_field`  VARCHAR(100) NULL COMMENT 'Target report filter field, required only for report drilldown'""",
        """CREATE TABLE IF NOT EXISTS `tada_attachments` (
          `id`           INT          AUTO_INCREMENT PRIMARY KEY,
          `claim_id`     INT          NOT NULL,
          `line_item_id` INT          NULL,
          `file_name`    VARCHAR(300) NOT NULL,
          `file_url`     VARCHAR(500) NOT NULL,
          `file_size_kb` INT          NULL,
          `doc_type`     VARCHAR(100) NOT NULL DEFAULT 'Receipt',
          `uploaded_by`  INT          NULL,
          `created_at`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (`claim_id`)     REFERENCES `tada_claims`(`id`)     ON DELETE CASCADE,
          FOREIGN KEY (`line_item_id`) REFERENCES `tada_line_items`(`id`) ON DELETE CASCADE,
          FOREIGN KEY (`uploaded_by`)  REFERENCES `users`(`id`)           ON DELETE SET NULL,
          INDEX `idx_tada_att_claim`    (`claim_id`),
          INDEX `idx_tada_att_lineitem` (`line_item_id`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""",
    ]

    db = MasterSessionLocal()
    try:
        tenants = db.query(Tenant).filter(Tenant.status.in_(["active", "trial"])).all()
    except Exception as e:
        logger.warning("TA/DA migration: cannot read tenants -- %s", e)
        return
    finally:
        db.close()

    for tenant in tenants:
        try:
            db_name = build_tenant_db_name(tenant.slug)
            engine_url = tenant_db_url(db_name)
            engine = create_engine(engine_url)
            TenantBase.metadata.create_all(bind=engine)
            engine.dispose()
        except Exception as e:
            logger.warning("TA/DA table-create skipped [%s]: %s", tenant.slug, e)
            continue

        try:
            conn = pymysql.connect(
                host=settings.TENANT_DB_HOST,
                port=int(settings.TENANT_DB_PORT),
                user=settings.TENANT_DB_USER,
                password=settings.TENANT_DB_PASSWORD,
                database=db_name,
                charset="utf8mb4",
                connect_timeout=5,
            )
            with conn.cursor() as cur:
                try:
                    cur.execute("SHOW COLUMNS FROM `work_orders` LIKE 'lead_id'")
                    if cur.fetchone() is None:
                        cur.execute("ALTER TABLE `work_orders` ADD COLUMN `lead_id` INT NULL")
                except pymysql.err.OperationalError as e:
                    logger.warning("Work order lead_id migration [%s]: %s", tenant.slug, e.args[1])

                for statement in statements:
                    try:
                        cur.execute(statement)
                    except pymysql.err.OperationalError as e:
                        if e.args[0] != 1060:
                            logger.warning("TA/DA migration [%s]: %s", tenant.slug, e.args[1])
            conn.commit()
            conn.close()
            logger.info("TA/DA migration applied: %s", tenant.slug)
        except Exception as e:
            logger.warning("TA/DA migration skipped [%s]: %s", tenant.slug, e)


# Seed data
def _seed_platform_data():
    from app.core.security import hash_password
    from app.database import MasterSessionLocal
    from app.models.tenant import SuperAdmin
    from app.routers.platform_router import seed_default_features, migrate_legacy_feature_keys

    db = MasterSessionLocal()
    try:
        if not db.query(SuperAdmin).first():
            db.add(
                SuperAdmin(
                    username="superadmin",
                    email="superadmin@edigit.in",
                    full_name="Platform Administrator",
                    hashed_password=hash_password("SuperAdmin@123"),
                    is_active=True,
                )
            )

        migrate_legacy_feature_keys(db)
        seed_default_features(db)
        from app.routers.platform_router import entitle_new_dashboard_tabs
        entitle_new_dashboard_tabs(db)
        db.commit()
        logger.info("Seed data ready")

        # Clear cached theme responses so company_name changes take effect immediately
        from app.services.cache_service import cache_delete_pattern
        cache_delete_pattern("theme:*")
        logger.info("Theme cache flushed on startup")

    except Exception as e:
        db.rollback()
        logger.error("Seed error: %s", e)

    finally:
        db.close()


def _sync_report_engine_tables():
    """Create report engine tables on every active tenant DB via TenantBase.metadata.create_all."""
    from sqlalchemy import create_engine
    from app.database import MasterSessionLocal, TenantBase, build_tenant_db_name, tenant_db_url
    from app.models.tenant import Tenant
    import app.models.all_models  # noqa: F401 -- registers all models including report engine tables

    db = MasterSessionLocal()
    try:
        tenants = db.query(Tenant).filter(Tenant.status.in_(["active", "trial"])).all()
    except Exception as e:
        logger.warning("Report engine sync: cannot read tenants -- %s", e)
        return
    finally:
        db.close()

    for tenant in tenants:
        try:
            db_name = build_tenant_db_name(tenant.slug)
            engine_url = tenant_db_url(db_name)
            engine = create_engine(engine_url)
            TenantBase.metadata.create_all(bind=engine)
            engine.dispose()
            logger.info("Report engine tables synced: %s", tenant.slug)
        except Exception as e:
            logger.warning("Report engine table sync skipped [%s]: %s", tenant.slug, e)


def _seed_report_engine_data():
    """Seed report_types + report_type_fields + system folders + standard saved reports per tenant."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.database import MasterSessionLocal, TenantBase, build_tenant_db_name, tenant_db_url
    from app.models.tenant import Tenant
    from app.models.all_models import ReportType, ReportTypeField, ReportFolder, SavedReport  # noqa: ReportPermission removed — using visibility field instead

    def _enrich_seed_fields(fields_data: list, rt_key: str) -> list:
        """Enrich seed field dicts with SQL source mapping from REPORT_ENGINE_CONFIG.

        Keeps source mapping DRY — expressions live only in REPORT_ENGINE_CONFIG
        and are stamped into the DB row at seed time.
        """
        from app.routers.report_engine_router import REPORT_ENGINE_CONFIG
        cfg = REPORT_ENGINE_CONFIG.get(rt_key, {})
        cfg_fields = cfg.get("fields", {})
        cfg_filters = cfg.get("filter_fields", {})
        enriched = []
        for f in fields_data:
            fk = f["field_key"]
            e = dict(f)
            if fk in cfg_fields:
                expr, joins = cfg_fields[fk]
                e["expression"] = expr
                e["join_key"] = ",".join(joins) if joins else ""
                if "." in expr and "(" not in expr:
                    tbl, col = expr.split(".", 1)
                    e["source_table"] = tbl
                    e["source_column"] = col
            if f.get("is_filterable"):
                if fk in cfg_filters:
                    e["filter_expression"] = cfg_filters[fk][0]
                elif fk in cfg_fields and not cfg_fields[fk][1]:  # direct column, no join
                    e["filter_expression"] = cfg_fields[fk][0]
            enriched.append(e)
        return enriched

    REPORT_TYPES_SEED = [
        {
            "key": "leads", "name": "Leads", "base_table": "leads",
            "module_permission_key": "reports.leads.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 1,
            "fields": [
                {"field_key": "id",               "label": "ID",              "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 0},
                {"field_key": "lead_ref_id",       "label": "Lead ID",         "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 1},
                {"field_key": "lead_title",        "label": "Lead Title",      "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 2,
                 "drilldown_kind": "report", "drilldown_target": "lead_linkage", "drilldown_id_field": "id", "drilldown_filter_field": "id"},
                {"field_key": "customer_name",     "label": "Customer",        "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 3,
                 "drilldown_kind": "report", "drilldown_target": "customer_pipeline", "drilldown_id_field": "customer_id", "drilldown_filter_field": "id"},
                {"field_key": "customer_id",       "label": "Customer ID",     "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "status",            "label": "Status",          "data_type": "enum",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 4,
                 "enum_values": ["New","Qualified","In Progress","Won","Lost","Dropped"],
                 "allowed_operators": ["eq","neq","in","not_in"]},
                {"field_key": "priority",          "label": "Priority",        "data_type": "enum",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 5,
                 "enum_values": ["Low","Medium","High","Critical"],
                 "allowed_operators": ["eq","neq","in"]},
                {"field_key": "est_value",         "label": "Est. Value",      "data_type": "currency",  "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_aggregatable": True, "display_order": 6},
                {"field_key": "region",            "label": "Region",          "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 7},
                {"field_key": "branch",            "label": "Branch",          "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 8},
                {"field_key": "assigned_to_name",  "label": "Assigned To",     "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": False, "display_order": 9},
                {"field_key": "created_by_name",   "label": "Created By",      "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": False, "display_order": 10},
                {"field_key": "source_name",       "label": "Source",          "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": False, "is_groupable": True, "display_order": 11},
                {"field_key": "vertical_name",     "label": "Vertical",        "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": False, "is_groupable": True, "display_order": 12},
                {"field_key": "created_at",        "label": "Created Date",    "data_type": "datetime", "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 13},
                {"field_key": "follow_up",         "label": "Follow Up",       "data_type": "date",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 14},
                {"field_key": "timeline",          "label": "Timeline",        "data_type": "date",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 15},
                {"field_key": "converted_at",      "label": "Converted Date",  "data_type": "datetime", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 16},
                {"field_key": "contact_person",    "label": "Contact Name",    "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 17},
                {"field_key": "mobile",            "label": "Phone",           "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 18},
                {"field_key": "email",             "label": "Email",           "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 19},
            ],
        },
        {
            "key": "customers", "name": "Customers", "base_table": "customers",
            "module_permission_key": "reports.customers.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 2,
            "fields": [
                {"field_key": "id",                "label": "ID",              "data_type": "number",   "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 0},
                {"field_key": "customer_name",     "label": "Customer Name",   "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 1,
                 "drilldown_kind": "report", "drilldown_target": "customer_pipeline", "drilldown_id_field": "id", "drilldown_filter_field": "id"},
                {"field_key": "customer_vertical", "label": "Segment",         "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 2},
                {"field_key": "billing_city",      "label": "District",        "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 3},
                {"field_key": "billing_state",     "label": "State",           "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 4},
                {"field_key": "account_status",    "label": "Status",          "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 5},
                {"field_key": "account_potential", "label": "Potential",       "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 6},
                {"field_key": "assigned_to_name",  "label": "Assigned To",     "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": False, "display_order": 7},
                {"field_key": "group_name",        "label": "Group",           "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 8},
                {"field_key": "region",            "label": "Region",          "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 9},
                {"field_key": "division",          "label": "Division",        "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 10},
                {"field_key": "gst_number",        "label": "GST Number",      "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": False, "display_order": 11},
                {"field_key": "pan_number",        "label": "PAN Number",      "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": False, "display_order": 12},
                {"field_key": "website",           "label": "Website",         "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": False, "display_order": 13},
                {"field_key": "created_by_name",   "label": "Created By",      "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": False, "display_order": 14},
                {"field_key": "created_at",        "label": "Created Date",    "data_type": "datetime", "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 15},
            ],
        },
        {
            "key": "tenders", "name": "Tenders", "base_table": "tenders",
            "module_permission_key": "reports.tenders.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 3,
            "fields": [
                {"field_key": "id",               "label": "ID",              "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 0},
                {"field_key": "tender_ref_id",     "label": "Tender ID",       "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 1,
                 "drilldown_kind": "report", "drilldown_target": "tender_linkage", "drilldown_id_field": "id", "drilldown_filter_field": "id"},
                {"field_key": "tender_title",      "label": "Tender Title",    "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 2,
                 "drilldown_kind": "report", "drilldown_target": "tender_linkage", "drilldown_id_field": "id", "drilldown_filter_field": "id"},
                {"field_key": "customer_name",     "label": "Customer",        "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 3,
                 "drilldown_kind": "report", "drilldown_target": "customer_pipeline", "drilldown_id_field": "customer_id", "drilldown_filter_field": "id"},
                {"field_key": "customer_id",       "label": "Customer ID",     "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "lead_id",           "label": "Lead ID",         "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "lead_title",        "label": "Source Lead",     "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 16,
                 "drilldown_kind": "report", "drilldown_target": "lead_linkage", "drilldown_id_field": "lead_id", "drilldown_filter_field": "id"},
                {"field_key": "status",            "label": "Status",          "data_type": "enum",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 4,
                 "enum_values": ["Aligned","Evaluation","Submitted","Pre-Bid","Reverse Auction","Closed"],
                 "allowed_operators": ["eq","neq","in","not_in"]},
                {"field_key": "result",            "label": "Result",          "data_type": "enum",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 5,
                 "enum_values": ["Pending","Won","Lost","Cancelled"],
                 "allowed_operators": ["eq","neq","in"]},
                {"field_key": "bid_amount",        "label": "Bid Amount",      "data_type": "currency",  "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_aggregatable": True, "display_order": 6},
                {"field_key": "est_value",         "label": "Est. Value",      "data_type": "currency",  "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_aggregatable": True, "display_order": 7},
                {"field_key": "current_step",      "label": "Current Step",    "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 8},
                {"field_key": "assigned_to_name",  "label": "Assigned To",     "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": False, "display_order": 9},
                {"field_key": "created_by_name",   "label": "Created By",      "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": False, "display_order": 10},
                {"field_key": "vertical_name",     "label": "Vertical",        "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": False, "is_groupable": True, "display_order": 11},
                {"field_key": "tender_date",       "label": "Published Date",  "data_type": "date",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 12},
                {"field_key": "submission_date",   "label": "Submission Date", "data_type": "date",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 13},
                {"field_key": "result_date",       "label": "Result Date",     "data_type": "date",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 14},
                {"field_key": "created_at",        "label": "Created Date",    "data_type": "datetime", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 15},
            ],
        },
        {
            "key": "opportunities", "name": "Opportunities", "base_table": "leads",
            "module_permission_key": "reports.opportunities.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 4,
            "fields": [
                {"field_key": "id",               "label": "ID",              "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 0},
                {"field_key": "lead_title",        "label": "Title",           "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 1,
                 "drilldown_kind": "report", "drilldown_target": "lead_linkage", "drilldown_id_field": "id", "drilldown_filter_field": "id"},
                {"field_key": "customer_name",     "label": "Customer",        "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 2,
                 "drilldown_kind": "report", "drilldown_target": "customer_pipeline", "drilldown_id_field": "customer_id", "drilldown_filter_field": "id"},
                {"field_key": "customer_id",       "label": "Customer ID",     "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "status",            "label": "Status",          "data_type": "enum",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 3,
                 "enum_values": ["New","Qualified","In Progress","Won","Lost","Dropped"],
                 "allowed_operators": ["eq","neq","in","not_in"]},
                {"field_key": "priority",          "label": "Priority",        "data_type": "enum",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 4},
                {"field_key": "est_value",         "label": "Est. Value",      "data_type": "currency",  "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_aggregatable": True, "display_order": 5},
                {"field_key": "region",            "label": "Region",          "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 6},
                {"field_key": "assigned_to_name",  "label": "Assigned To",     "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": False, "display_order": 7},
                {"field_key": "vertical_name",     "label": "Vertical",        "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": False, "is_groupable": True, "display_order": 8},
                {"field_key": "created_at",        "label": "Created Date",    "data_type": "datetime", "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 9},
            ],
        },
        {
            "key": "workorders", "name": "Work Orders", "base_table": "work_orders",
            "module_permission_key": "reports.workorders.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 5,
            "fields": [
                {"field_key": "id",               "label": "ID",              "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 0},
                {"field_key": "wo_number",         "label": "WO Number",       "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 1,
                 "drilldown_kind": "report", "drilldown_target": "workorder_linkage", "drilldown_id_field": "id", "drilldown_filter_field": "id"},
                {"field_key": "project_title",     "label": "Project Title",   "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 2},
                {"field_key": "customer_name",     "label": "Customer",        "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 3,
                 "drilldown_kind": "report", "drilldown_target": "customer_pipeline", "drilldown_id_field": "customer_id", "drilldown_filter_field": "id"},
                {"field_key": "customer_id",       "label": "Customer ID",     "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "lead_id",           "label": "Lead ID",         "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "lead_title",        "label": "Source Lead",     "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 13,
                 "drilldown_kind": "report", "drilldown_target": "lead_linkage", "drilldown_id_field": "lead_id", "drilldown_filter_field": "id"},
                {"field_key": "wo_type",           "label": "WO Type",         "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 4},
                {"field_key": "po_number",         "label": "PO Number",       "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 5},
                {"field_key": "po_value",          "label": "PO Value",        "data_type": "currency",  "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_aggregatable": True, "display_order": 6},
                {"field_key": "wo_value",          "label": "WO Value",        "data_type": "currency",  "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_aggregatable": True, "display_order": 7},
                {"field_key": "status",            "label": "Status",          "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 8},
                {"field_key": "progress_percent",  "label": "Progress %",      "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 9},
                {"field_key": "delivery_date",     "label": "Delivery Date",   "data_type": "date",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 10},
                {"field_key": "created_by_name",   "label": "Created By",      "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": False, "display_order": 11},
                {"field_key": "created_at",        "label": "Created Date",    "data_type": "datetime", "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 12},
            ],
        },
        {
            "key": "emdbg", "name": "EMD / BG", "base_table": "emdbg",
            "module_permission_key": "reports.emdbg.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 6,
            "fields": [
                {"field_key": "id",                "label": "ID",              "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 0},
                {"field_key": "instrument_type",   "label": "Type",            "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 1},
                {"field_key": "instrument_number", "label": "Instrument No.",  "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 2,
                 "drilldown_kind": "report", "drilldown_target": "emdbg_linkage", "drilldown_id_field": "id", "drilldown_filter_field": "id"},
                {"field_key": "bank_name",         "label": "Bank",            "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 3},
                {"field_key": "amount",            "label": "Amount",          "data_type": "currency",  "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_aggregatable": True, "display_order": 4},
                {"field_key": "issue_date",        "label": "Issue Date",      "data_type": "date",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 5},
                {"field_key": "expiry_date",       "label": "Expiry Date",     "data_type": "date",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 6},
                {"field_key": "status",            "label": "Status",          "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 7},
                {"field_key": "customer_name",     "label": "Customer",        "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 11,
                 "drilldown_kind": "report", "drilldown_target": "customer_pipeline", "drilldown_id_field": "customer_id", "drilldown_filter_field": "id"},
                {"field_key": "customer_id",       "label": "Customer ID",     "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "tender_id",         "label": "Tender ID",       "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "tender_title",      "label": "Linked Tender",   "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": False, "display_order": 8,
                 "drilldown_kind": "report", "drilldown_target": "tender_linkage", "drilldown_id_field": "tender_id", "drilldown_filter_field": "id"},
                {"field_key": "created_by_name",   "label": "Created By",      "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": False, "display_order": 9},
                {"field_key": "created_at",        "label": "Created Date",    "data_type": "datetime", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 10},
            ],
        },
        {
            "key": "travel", "name": "Travel Requests", "base_table": "travel_requests",
            "module_permission_key": "reports.travel.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 7,
            "fields": [
                {"field_key": "id",              "label": "ID",            "data_type": "number",   "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 0},
                {"field_key": "purpose",         "label": "Purpose",       "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 1},
                {"field_key": "from_city",       "label": "From",          "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 2},
                {"field_key": "to_city",         "label": "To",            "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 3},
                {"field_key": "travel_date",     "label": "Travel Date",   "data_type": "date",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 4},
                {"field_key": "return_date",     "label": "Return Date",   "data_type": "date",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 5},
                {"field_key": "visit_type",      "label": "Visit Type",    "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 6},
                {"field_key": "status",          "label": "Status",        "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 7},
                {"field_key": "advance_required","label": "Advance Req.",  "data_type": "boolean",  "is_default_column": False, "is_filterable": True,  "is_sortable": False, "display_order": 8},
                {"field_key": "advance_amount",  "label": "Advance Amt.",  "data_type": "currency",  "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_aggregatable": True, "display_order": 9},
                {"field_key": "created_by_name", "label": "Created By",    "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": False, "display_order": 10},
                {"field_key": "created_at",      "label": "Created Date",  "data_type": "datetime", "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 11},
            ],
        },
        {
            "key": "quotations", "name": "Quotations", "base_table": "quotations",
            "module_permission_key": "reports.quotations.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 8,
            "fields": [
                {"field_key": "id",               "label": "ID",              "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 0},
                {"field_key": "quotation_number",  "label": "Quotation No.",   "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 1,
                 "drilldown_kind": "report", "drilldown_target": "quotation_linkage", "drilldown_id_field": "id", "drilldown_filter_field": "id"},
                {"field_key": "subject",           "label": "Subject",         "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 2},
                {"field_key": "customer_name",     "label": "Customer",        "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 3,
                 "drilldown_kind": "report", "drilldown_target": "customer_pipeline", "drilldown_id_field": "customer_id", "drilldown_filter_field": "id"},
                {"field_key": "customer_id",       "label": "Customer ID",     "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "lead_id",           "label": "Lead ID",         "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "lead_title",        "label": "Source Lead",     "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 10,
                 "drilldown_kind": "report", "drilldown_target": "lead_linkage", "drilldown_id_field": "lead_id", "drilldown_filter_field": "id"},
                {"field_key": "amount",            "label": "Amount",          "data_type": "currency",  "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_aggregatable": True, "display_order": 4},
                {"field_key": "total_amount",      "label": "Total Amount",    "data_type": "currency",  "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_aggregatable": True, "display_order": 5},
                {"field_key": "status",            "label": "Status",          "data_type": "enum",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 6,
                 "enum_values": ["Draft","Sent","Approved","Accepted","Rejected"],
                 "allowed_operators": ["eq","neq","in","not_in"]},
                {"field_key": "valid_until",       "label": "Valid Until",     "data_type": "date",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 7},
                {"field_key": "created_by_name",   "label": "Created By",      "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": False, "display_order": 8},
                {"field_key": "created_at",        "label": "Created Date",    "data_type": "datetime", "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 9},
            ],
        },
        {
            "key": "customer_leads", "name": "Customer → Leads", "base_table": "leads",
            "description": "Leads with full customer profile — customer fields from customers table, lead fields from leads table",
            "module_permission_key": "leads.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 10,
            "fields": [
                # ── Customer fields (always joined via base FROM) ──────────────────
                {"field_key": "customer_name",     "label": "Customer Name",      "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 0,
                 "drilldown_kind": "report", "drilldown_target": "customer_pipeline", "drilldown_id_field": "customer_id", "drilldown_filter_field": "id"},
                {"field_key": "customer_id",       "label": "Customer ID",        "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "customer_vertical", "label": "Customer Vertical",  "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 1},
                {"field_key": "account_status",    "label": "Account Status",     "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 2},
                {"field_key": "customer_region",   "label": "Customer Region",    "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 3},
                {"field_key": "division",          "label": "Division",           "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 4},
                {"field_key": "group_name",        "label": "Group",              "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 5},
                # ── Lead fields ───────────────────────────────────────────────────
                {"field_key": "lead_ref_id",       "label": "Lead ID",            "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 6},
                {"field_key": "lead_title",        "label": "Lead Title",         "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 7},
                {"field_key": "status",            "label": "Lead Status",        "data_type": "enum",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 8,
                 "enum_values": ["New","Qualified","In Progress","Won","Lost","Dropped"],
                 "allowed_operators": ["eq","neq","in","not_in"]},
                {"field_key": "priority",          "label": "Priority",           "data_type": "enum",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 9,
                 "enum_values": ["Low","Medium","High","Critical"],
                 "allowed_operators": ["eq","neq","in"]},
                {"field_key": "est_value",         "label": "Est. Value",         "data_type": "currency", "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_aggregatable": True, "display_order": 10},
                {"field_key": "branch",            "label": "Branch",             "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 11},
                {"field_key": "follow_up",         "label": "Follow Up",          "data_type": "date",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 12},
                {"field_key": "converted_at",      "label": "Converted Date",     "data_type": "datetime", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 13},
                # ── Join fields ───────────────────────────────────────────────────
                {"field_key": "assigned_to_name",  "label": "Assigned To",        "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": False, "display_order": 14},
                {"field_key": "created_by_name",   "label": "Created By",         "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": False, "display_order": 15},
                {"field_key": "source_name",       "label": "Source",             "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": False, "is_groupable": True, "display_order": 16},
                {"field_key": "vertical_name",     "label": "Industry Vertical",  "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": False, "is_groupable": True, "display_order": 17},
                {"field_key": "created_at",        "label": "Created Date",       "data_type": "datetime", "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 18},
            ],
        },
        {
            "key": "customer_pipeline", "name": "Customer Pipeline", "base_table": "customers",
            "description": "Customer-wise lead and quotation pipeline",
            "module_permission_key": "reports.customers.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 9,
            "fields": [
                {"field_key": "id",                 "label": "ID",                 "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 0},
                {"field_key": "customer_name",      "label": "Customer",           "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 1,
                 "drilldown_kind": "report", "drilldown_target": "customer_pipeline", "drilldown_id_field": "id", "drilldown_filter_field": "id"},
                {"field_key": "customer_vertical",  "label": "Segment",            "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 2},
                {"field_key": "billing_city",       "label": "District",           "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 3},
                {"field_key": "customer_region",    "label": "State",              "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 4},
                {"field_key": "customer_status",    "label": "Customer Status",    "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 5},
                {"field_key": "account_potential",  "label": "Potential",          "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 6},
                {"field_key": "group_name",         "label": "Group",              "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 7},
                {"field_key": "lead_ref_id",        "label": "Lead ID",            "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 8},
                {"field_key": "lead_title",         "label": "Lead Title",         "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 9},
                {"field_key": "lead_status",        "label": "Lead Status",        "data_type": "enum",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 10,
                 "enum_values": ["Assigned","Contacted","Qualified","Proposal Pending","Nurturing","Opportunity Created","Converted","Lost"],
                 "allowed_operators": ["eq","neq","in","not_in"]},
                {"field_key": "lead_value",         "label": "Lead Value",         "data_type": "currency", "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 11},
                {"field_key": "quotation_number",   "label": "Quotation No.",      "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 12},
                {"field_key": "quotation_status",   "label": "Quotation Status",   "data_type": "enum",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 13,
                 "enum_values": ["Draft","Sent","Approved","Accepted","Rejected"],
                 "allowed_operators": ["eq","neq","in","not_in","is_null","is_not_null"]},
                {"field_key": "quotation_amount",   "label": "Quotation Amount",   "data_type": "currency", "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 14},
                {"field_key": "assigned_to_name",   "label": "Assigned To",        "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": False, "display_order": 15},
                {"field_key": "created_at",         "label": "Customer Created",   "data_type": "datetime", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 16},
            ],
        },
        {
            "key": "lead_quotation", "name": "Lead to Quotation", "base_table": "leads",
            "description": "Leads with linked quotation details",
            "module_permission_key": "reports.leads.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 10,
            "fields": [
                {"field_key": "id",                   "label": "ID",                   "data_type": "number",   "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 0},
                {"field_key": "lead_ref_id",          "label": "Lead ID",              "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 1},
                {"field_key": "lead_title",           "label": "Lead Title",           "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 2},
                {"field_key": "customer_name",        "label": "Customer",             "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 3},
                {"field_key": "lead_status",          "label": "Lead Status",          "data_type": "enum",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 4,
                 "enum_values": ["Assigned","Contacted","Qualified","Proposal Pending","Nurturing","Opportunity Created","Converted","Lost"],
                 "allowed_operators": ["eq","neq","in","not_in"]},
                {"field_key": "lead_value",           "label": "Lead Value",           "data_type": "currency", "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 5},
                {"field_key": "quotation_number",     "label": "Quotation No.",        "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 6},
                {"field_key": "quotation_status",     "label": "Quotation Status",     "data_type": "enum",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 7,
                 "enum_values": ["Draft","Sent","Approved","Accepted","Rejected"],
                 "allowed_operators": ["eq","neq","in","not_in","is_null","is_not_null"]},
                {"field_key": "quotation_amount",     "label": "Quotation Amount",     "data_type": "currency", "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 8},
                {"field_key": "quotation_created_at", "label": "Quotation Created",    "data_type": "datetime", "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 9},
                {"field_key": "assigned_to_name",     "label": "Assigned To",          "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": False, "display_order": 10},
                {"field_key": "created_at",           "label": "Lead Created",         "data_type": "datetime", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 11},
            ],
        },
        {
            "key": "quotation_workorder", "name": "Quotation to Work Order", "base_table": "quotations",
            "description": "Accepted quotations and their linked work orders",
            "module_permission_key": "reports.quotations.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 11,
            "fields": [
                {"field_key": "id",                 "label": "ID",                 "data_type": "number",   "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 0},
                {"field_key": "quotation_number",   "label": "Quotation No.",      "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 1},
                {"field_key": "quotation_status",   "label": "Quotation Status",   "data_type": "enum",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 2,
                 "enum_values": ["Draft","Sent","Approved","Accepted","Rejected"],
                 "allowed_operators": ["eq","neq","in","not_in","is_null","is_not_null"]},
                {"field_key": "quotation_amount",   "label": "Quotation Amount",   "data_type": "currency", "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 3},
                {"field_key": "lead_title",         "label": "Lead Title",         "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 4},
                {"field_key": "customer_name",      "label": "Customer",           "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 5},
                {"field_key": "work_order_number",  "label": "WO Number",          "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 6},
                {"field_key": "work_order_value",   "label": "WO Value",           "data_type": "currency", "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 7},
                {"field_key": "work_order_status",  "label": "WO Status",          "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 8},
                {"field_key": "created_at",         "label": "Quotation Created",  "data_type": "datetime", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 9},
            ],
        },
        {
            "key": "tender_workorder", "name": "Tender to Work Order", "base_table": "tenders",
            "description": "Won tenders and their linked work orders",
            "module_permission_key": "reports.tenders.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 12,
            "fields": [
                {"field_key": "id",                 "label": "ID",              "data_type": "number",   "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 0},
                {"field_key": "tender_ref_id",      "label": "Tender ID",       "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 1},
                {"field_key": "tender_title",       "label": "Tender Title",    "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 2},
                {"field_key": "tender_result",      "label": "Tender Result",   "data_type": "enum",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 3,
                 "enum_values": ["Pending","Won","Lost","Cancelled"],
                 "allowed_operators": ["eq","neq","in","not_in"]},
                {"field_key": "bid_amount",         "label": "Bid Amount",      "data_type": "currency", "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 4},
                {"field_key": "customer_name",      "label": "Customer",        "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 5},
                {"field_key": "work_order_number",  "label": "WO Number",       "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 6},
                {"field_key": "work_order_value",   "label": "WO Value",        "data_type": "currency", "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 7},
                {"field_key": "work_order_status",  "label": "WO Status",       "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 8},
                {"field_key": "assigned_to_name",   "label": "Assigned To",     "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": False, "display_order": 9},
                {"field_key": "created_at",         "label": "Tender Created",  "data_type": "datetime", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 10},
            ],
        },
        {
            "key": "lead_linkage", "name": "Lead Linkage", "base_table": "leads",
            "description": "A lead with its tender, quotation, work order, and KAM activity summary — drilldown destination for Lead Title clicks",
            "module_permission_key": "reports.leads.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 13,
            "fields": [
                {"field_key": "id",                 "label": "ID",                 "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 0},
                {"field_key": "lead_ref_id",         "label": "Lead ID",            "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 1},
                {"field_key": "lead_title",          "label": "Lead Title",         "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 2},
                {"field_key": "status",              "label": "Lead Status",        "data_type": "enum",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 3,
                 "enum_values": ["Assigned","Contacted","Qualified","Proposal Pending","Nurturing","Opportunity Created","Converted","Lost"],
                 "allowed_operators": ["eq","neq","in","not_in"]},
                {"field_key": "priority",            "label": "Priority",           "data_type": "enum",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 4},
                {"field_key": "est_value",           "label": "Est. Value",         "data_type": "currency", "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_aggregatable": True, "display_order": 5},
                {"field_key": "customer_name",       "label": "Customer",           "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 6},
                {"field_key": "customer_id",         "label": "Customer ID",        "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "tender_ref_id",       "label": "Tender ID",          "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 7},
                {"field_key": "tender_title",        "label": "Tender Title",       "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 8},
                {"field_key": "tender_status",       "label": "Tender Status",      "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 9},
                {"field_key": "quotation_number",    "label": "Quotation No.",      "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 10},
                {"field_key": "quotation_status",    "label": "Quotation Status",   "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 11},
                {"field_key": "quotation_amount",    "label": "Quotation Amount",   "data_type": "currency", "is_default_column": False, "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 12},
                {"field_key": "work_order_number",   "label": "WO Number",          "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 13},
                {"field_key": "work_order_status",   "label": "WO Status",          "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 14},
                {"field_key": "work_order_value",    "label": "WO Value",           "data_type": "currency", "is_default_column": False, "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 15},
                {"field_key": "activity_count",      "label": "Activity Count",     "data_type": "number",   "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 16},
                {"field_key": "last_activity_date",  "label": "Last Activity Date", "data_type": "date",     "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 17},
                {"field_key": "last_activity_type",  "label": "Last Activity Type", "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": False, "display_order": 18},
                {"field_key": "next_followup_date",  "label": "Next Follow-up",     "data_type": "date",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 19},
                {"field_key": "created_at",          "label": "Lead Created",       "data_type": "datetime", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 20},
            ],
        },
        {
            "key": "tender_linkage", "name": "Tender Linkage", "base_table": "tenders",
            "description": "A tender with its lead, customer, EMD/BG, quotation, and work order — drilldown destination for Tender ID/Title clicks",
            "module_permission_key": "reports.tenders.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 14,
            "fields": [
                {"field_key": "id",                 "label": "ID",              "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 0},
                {"field_key": "tender_ref_id",       "label": "Tender ID",       "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 1},
                {"field_key": "tender_title",        "label": "Tender Title",    "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 2},
                {"field_key": "status",              "label": "Status",         "data_type": "enum",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 3,
                 "enum_values": ["Aligned","Evaluation","Submitted","Pre-Bid","Reverse Auction","Closed"],
                 "allowed_operators": ["eq","neq","in","not_in"]},
                {"field_key": "result",              "label": "Result",         "data_type": "enum",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 4,
                 "enum_values": ["Pending","Won","Lost","Cancelled"],
                 "allowed_operators": ["eq","neq","in"]},
                {"field_key": "bid_amount",          "label": "Bid Amount",      "data_type": "currency", "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 5},
                {"field_key": "customer_name",       "label": "Customer",       "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 6},
                {"field_key": "customer_id",         "label": "Customer ID",     "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "lead_id",             "label": "Lead ID",         "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "lead_title",          "label": "Source Lead",     "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 7},
                {"field_key": "emd_bg_number",       "label": "EMD/BG No.",      "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 8},
                {"field_key": "emd_bg_amount",       "label": "EMD/BG Amount",   "data_type": "currency", "is_default_column": False, "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 9},
                {"field_key": "emd_bg_status",       "label": "EMD/BG Status",   "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 10},
                {"field_key": "quotation_number",    "label": "Quotation No.",   "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 11},
                {"field_key": "quotation_status",    "label": "Quotation Status","data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 12},
                {"field_key": "work_order_number",   "label": "WO Number",       "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 13},
                {"field_key": "work_order_status",   "label": "WO Status",       "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 14},
                {"field_key": "work_order_value",    "label": "WO Value",        "data_type": "currency", "is_default_column": False, "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 15},
                {"field_key": "created_at",          "label": "Created Date",    "data_type": "datetime", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 16},
            ],
        },
        {
            "key": "quotation_linkage", "name": "Quotation Linkage", "base_table": "quotations",
            "description": "A quotation with its lead, customer, tender, and work order — drilldown destination for Quotation Number clicks",
            "module_permission_key": "reports.quotations.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 15,
            "fields": [
                {"field_key": "id",                 "label": "ID",              "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 0},
                {"field_key": "quotation_number",    "label": "Quotation No.",   "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 1},
                {"field_key": "subject",             "label": "Subject",        "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 2},
                {"field_key": "amount",              "label": "Amount",         "data_type": "currency", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_aggregatable": True, "display_order": 3},
                {"field_key": "total_amount",        "label": "Total Amount",   "data_type": "currency", "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_aggregatable": True, "display_order": 4},
                {"field_key": "status",              "label": "Status",         "data_type": "enum",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 5,
                 "enum_values": ["Draft","Sent","Approved","Accepted","Rejected"],
                 "allowed_operators": ["eq","neq","in","not_in"]},
                {"field_key": "customer_name",       "label": "Customer",       "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 6},
                {"field_key": "customer_id",         "label": "Customer ID",     "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "lead_id",             "label": "Lead ID",         "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "lead_title",          "label": "Source Lead",     "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 7},
                {"field_key": "tender_ref_id",       "label": "Tender ID",       "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 8},
                {"field_key": "tender_title",        "label": "Tender Title",    "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 9},
                {"field_key": "work_order_number",   "label": "WO Number",       "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 10},
                {"field_key": "work_order_status",   "label": "WO Status",       "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 11},
                {"field_key": "work_order_value",    "label": "WO Value",        "data_type": "currency", "is_default_column": False, "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 12},
                {"field_key": "created_at",          "label": "Created Date",    "data_type": "datetime", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 13},
            ],
        },
        {
            "key": "workorder_linkage", "name": "Work Order Linkage", "base_table": "work_orders",
            "description": "A work order with its lead, customer, tender, and quotation — drilldown destination for WO Number clicks",
            "module_permission_key": "reports.workorders.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 16,
            "fields": [
                {"field_key": "id",                 "label": "ID",              "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 0},
                {"field_key": "wo_number",           "label": "WO Number",       "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 1},
                {"field_key": "project_title",       "label": "Project Title",   "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 2},
                {"field_key": "wo_type",             "label": "WO Type",        "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 3},
                {"field_key": "status",              "label": "Status",        "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 4},
                {"field_key": "po_number",           "label": "PO Number",      "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 5},
                {"field_key": "po_value",            "label": "PO Value",       "data_type": "currency", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_aggregatable": True, "display_order": 6},
                {"field_key": "wo_value",            "label": "WO Value",       "data_type": "currency", "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_aggregatable": True, "display_order": 7},
                {"field_key": "customer_name",       "label": "Customer",       "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 8},
                {"field_key": "customer_id",         "label": "Customer ID",     "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "lead_id",             "label": "Lead ID",         "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "lead_title",          "label": "Source Lead",     "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 9},
                {"field_key": "tender_ref_id",       "label": "Tender ID",       "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 10},
                {"field_key": "tender_title",        "label": "Tender Title",    "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 11},
                {"field_key": "quotation_number",    "label": "Quotation No.",   "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 12},
                {"field_key": "quotation_status",    "label": "Quotation Status","data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 13},
                {"field_key": "created_at",          "label": "Created Date",    "data_type": "datetime", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 14},
            ],
        },
        {
            "key": "emdbg_linkage", "name": "EMD/BG Linkage", "base_table": "emdbg",
            "description": "An EMD/BG instrument with its tender, customer, lead, and related work order — drilldown destination for Instrument Number clicks",
            "module_permission_key": "reports.emdbg.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 17,
            "fields": [
                {"field_key": "id",                 "label": "ID",              "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 0},
                {"field_key": "instrument_type",     "label": "Type",           "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 1},
                {"field_key": "instrument_number",   "label": "Instrument No.",  "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 2},
                {"field_key": "bank_name",           "label": "Bank",           "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 3},
                {"field_key": "amount",              "label": "Amount",         "data_type": "currency", "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_aggregatable": True, "display_order": 4},
                {"field_key": "issue_date",          "label": "Issue Date",     "data_type": "date",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 5},
                {"field_key": "expiry_date",         "label": "Expiry Date",    "data_type": "date",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 6},
                {"field_key": "status",              "label": "Status",        "data_type": "text",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 7},
                {"field_key": "tender_id",           "label": "Tender ID",       "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "tender_ref_id",       "label": "Tender Ref.",     "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 8},
                {"field_key": "tender_title",        "label": "Tender Title",    "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 9},
                {"field_key": "customer_name",       "label": "Customer",       "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 10},
                {"field_key": "customer_id",         "label": "Customer ID",     "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "lead_id",             "label": "Lead ID",         "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "lead_title",          "label": "Source Lead",     "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 11},
                {"field_key": "work_order_number",   "label": "WO Number",       "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 12},
                {"field_key": "work_order_status",   "label": "WO Status",       "data_type": "text",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 13},
                {"field_key": "created_at",          "label": "Created Date",    "data_type": "datetime", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 14},
            ],
        },
        {
            "key": "questionnaire", "name": "Questionnaire Completion", "base_table": "customer_questionnaires",
            "description": "Per-customer questionnaire completion status and progress",
            "module_permission_key": "reports.questionnaire.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 18,
            "fields": [
                {"field_key": "id",                  "label": "ID",              "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 0},
                {"field_key": "questionnaire_id",     "label": "Questionnaire ID", "data_type": "number",  "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "questionnaire_code",   "label": "Questionnaire Code", "data_type": "text",  "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 1},
                {"field_key": "questionnaire_name",   "label": "Questionnaire",   "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 2},
                {"field_key": "customer_id",          "label": "Customer ID",     "data_type": "number",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "customer_name",        "label": "Customer",       "data_type": "text",     "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 3,
                 "drilldown_kind": "report", "drilldown_target": "customer_pipeline", "drilldown_id_field": "customer_id", "drilldown_filter_field": "id"},
                {"field_key": "status",               "label": "Status",         "data_type": "enum",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 4,
                 "enum_values": ["not_started","in_progress","completed","reopened"], "allowed_operators": ["eq","neq","in","not_in"]},
                {"field_key": "progress_percentage",  "label": "Progress %",     "data_type": "number",   "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_aggregatable": True, "display_order": 5},
                {"field_key": "total_questions",      "label": "Total Questions", "data_type": "number",  "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 6},
                {"field_key": "completed_questions",  "label": "Answered",       "data_type": "number",   "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 7},
                {"field_key": "stale_days",           "label": "Stale For (Days)", "data_type": "number", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 8},
                {"field_key": "started_at",           "label": "Started",        "data_type": "date",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 9},
                {"field_key": "completed_at",         "label": "Completed",      "data_type": "date",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 10},
                {"field_key": "last_saved_at",        "label": "Last Activity",  "data_type": "date",     "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "display_order": 11},
                {"field_key": "reopened_at",          "label": "Reopened At",    "data_type": "date",     "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 12},
                {"field_key": "reopened_by_name",     "label": "Reopened By",    "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 13},
                {"field_key": "reopen_reason",        "label": "Reopen Reason",  "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": False, "display_order": 14},
                {"field_key": "created_by_name",      "label": "Created By",     "data_type": "text",     "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 15},
                {"field_key": "created_at",           "label": "Created Date",   "data_type": "datetime", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 16},
            ],
        },
        {
            "key": "questionnaire_adoption", "name": "Questionnaire Adoption Summary", "base_table": "questionnaires",
            "description": "Rollout progress per questionnaire — assigned customers, status breakdown, completion rate",
            "module_permission_key": "reports.questionnaire.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 19,
            "fields": [
                {"field_key": "id",                    "label": "ID",              "data_type": "number", "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 0},
                {"field_key": "questionnaire_code",     "label": "Code",            "data_type": "text",   "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 1},
                {"field_key": "questionnaire_name",     "label": "Questionnaire",   "data_type": "text",   "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 2,
                 "drilldown_kind": "report", "drilldown_target": "questionnaire", "drilldown_id_field": "id", "drilldown_filter_field": "questionnaire_id"},
                {"field_key": "status",                 "label": "Status",         "data_type": "enum",   "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 3,
                 "enum_values": ["draft","published","archived"], "allowed_operators": ["eq","neq","in","not_in"]},
                {"field_key": "total_assigned",         "label": "Total Assigned", "data_type": "number", "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 4},
                {"field_key": "not_started_count",      "label": "Not Started",    "data_type": "number", "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 5},
                {"field_key": "in_progress_count",      "label": "In Progress",    "data_type": "number", "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 6},
                {"field_key": "completed_count",        "label": "Completed",      "data_type": "number", "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 7},
                {"field_key": "reopened_count",         "label": "Reopened",       "data_type": "number", "is_default_column": False, "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 8},
                {"field_key": "completion_rate_pct",    "label": "Completion Rate %", "data_type": "number", "is_default_column": True, "is_filterable": False, "is_sortable": True, "is_aggregatable": True, "display_order": 9},
                {"field_key": "avg_days_to_complete",   "label": "Avg. Days To Complete", "data_type": "number", "is_default_column": False, "is_filterable": False, "is_sortable": True, "is_aggregatable": True, "display_order": 10},
                {"field_key": "created_by_name",        "label": "Created By",     "data_type": "text",   "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 11},
                {"field_key": "created_at",             "label": "Created Date",   "data_type": "datetime", "is_default_column": False, "is_filterable": True, "is_sortable": True,  "display_order": 12},
            ],
        },
        {
            "key": "questionnaire_sections", "name": "Section Completion Analysis", "base_table": "questionnaire_structure",
            "description": "Section/subsection-wise completion — which parts of a questionnaire customers struggle to finish",
            "module_permission_key": "reports.questionnaire.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 20,
            "fields": [
                {"field_key": "id",                     "label": "ID",              "data_type": "number", "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 0},
                {"field_key": "questionnaire_id",        "label": "Questionnaire ID", "data_type": "number", "is_default_column": False, "is_filterable": True, "is_sortable": True,  "display_order": 99},
                {"field_key": "questionnaire_name",      "label": "Questionnaire",   "data_type": "text",   "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 1},
                {"field_key": "structure_type",          "label": "Level",           "data_type": "enum",   "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 2,
                 "enum_values": ["section","subsection"], "allowed_operators": ["eq","neq","in","not_in"]},
                {"field_key": "section_name",             "label": "Section",        "data_type": "text",   "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 3,
                 "drilldown_kind": "report", "drilldown_target": "questionnaire_answers", "drilldown_id_field": "id", "drilldown_filter_field": "section_id"},
                {"field_key": "parent_section_name",     "label": "Parent Section",  "data_type": "text",   "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 4},
                {"field_key": "display_order",           "label": "Order",           "data_type": "number", "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 5},
                {"field_key": "total_questions",         "label": "Total Questions", "data_type": "number", "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 6},
                {"field_key": "avg_completion_pct",      "label": "Avg. Completion %", "data_type": "number", "is_default_column": True, "is_filterable": False, "is_sortable": True, "is_aggregatable": True, "display_order": 7},
                {"field_key": "fully_completed_customers", "label": "Fully Completed By", "data_type": "number", "is_default_column": True, "is_filterable": False, "is_sortable": True, "is_aggregatable": True, "display_order": 8},
            ],
        },
        {
            "key": "questionnaire_answers", "name": "Questionnaire Answer Detail", "base_table": "customer_questionnaire_answers",
            "description": "Raw answer-level export — every customer's response to every question. Drilldown destination for Section and Question clicks",
            "module_permission_key": "reports.questionnaire.view", "default_date_field": "created_at",
            "supports_charts": False, "supports_grouping": True, "sort_order": 21,
            "fields": [
                {"field_key": "id",                 "label": "ID",              "data_type": "number", "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 0},
                {"field_key": "questionnaire_id",     "label": "Questionnaire ID", "data_type": "number", "is_default_column": False, "is_filterable": True, "is_sortable": True,  "display_order": 99},
                {"field_key": "questionnaire_name",   "label": "Questionnaire",   "data_type": "text",   "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 1},
                {"field_key": "customer_id",          "label": "Customer ID",     "data_type": "number", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "customer_name",        "label": "Customer",       "data_type": "text",   "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 2,
                 "drilldown_kind": "report", "drilldown_target": "customer_pipeline", "drilldown_id_field": "customer_id", "drilldown_filter_field": "id"},
                {"field_key": "section_id",           "label": "Section ID",     "data_type": "number", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "section_name",         "label": "Section",        "data_type": "text",   "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 3},
                {"field_key": "subsection_id",        "label": "Subsection ID",  "data_type": "number", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "subsection_name",      "label": "Subsection",     "data_type": "text",   "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 4},
                {"field_key": "element_id",           "label": "Question ID",    "data_type": "number", "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "display_order": 99},
                {"field_key": "question_label",       "label": "Question",       "data_type": "text",   "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 5},
                {"field_key": "input_type",           "label": "Input Type",     "data_type": "text",   "is_default_column": False, "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 6},
                {"field_key": "answer_value",         "label": "Answer",         "data_type": "text",   "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 7},
                {"field_key": "remarks",              "label": "Remarks",        "data_type": "text",   "is_default_column": False, "is_filterable": False, "is_sortable": False, "display_order": 8},
                {"field_key": "answered_by_name",     "label": "Answered By",    "data_type": "text",   "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 9},
                {"field_key": "answered_at",          "label": "Answered At",    "data_type": "datetime", "is_default_column": True, "is_filterable": True,  "is_sortable": True,  "display_order": 10},
                {"field_key": "created_at",           "label": "Created Date",   "data_type": "datetime", "is_default_column": False, "is_filterable": True, "is_sortable": True,  "display_order": 11},
            ],
        },
        {
            "key": "questionnaire_questions", "name": "Question Response Analysis", "base_table": "questionnaire_form_elements",
            "description": "Per-question response distribution and skip rate across all customers",
            "module_permission_key": "reports.questionnaire.view", "default_date_field": "created_at",
            "supports_charts": True, "supports_grouping": True, "sort_order": 22,
            "fields": [
                {"field_key": "id",                 "label": "ID",              "data_type": "number", "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 0},
                {"field_key": "questionnaire_id",     "label": "Questionnaire ID", "data_type": "number", "is_default_column": False, "is_filterable": True, "is_sortable": True,  "display_order": 99},
                {"field_key": "questionnaire_name",   "label": "Questionnaire",   "data_type": "text",   "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 1},
                {"field_key": "section_name",         "label": "Section",        "data_type": "text",   "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 2},
                {"field_key": "subsection_name",      "label": "Subsection",     "data_type": "text",   "is_default_column": False, "is_filterable": False, "is_sortable": True,  "display_order": 3},
                {"field_key": "question_label",       "label": "Question",       "data_type": "text",   "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "display_order": 4,
                 "drilldown_kind": "report", "drilldown_target": "questionnaire_answers", "drilldown_id_field": "id", "drilldown_filter_field": "element_id"},
                {"field_key": "input_type",           "label": "Input Type",     "data_type": "text",   "is_default_column": True,  "is_filterable": True,  "is_sortable": True,  "is_groupable": True, "display_order": 5},
                {"field_key": "is_required",          "label": "Required",       "data_type": "boolean", "is_default_column": False, "is_filterable": True, "is_sortable": True,  "display_order": 6},
                {"field_key": "total_assigned",       "label": "Total Assigned", "data_type": "number", "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 7},
                {"field_key": "answered_count",       "label": "Answered",       "data_type": "number", "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 8},
                {"field_key": "skipped_count",        "label": "Skipped",        "data_type": "number", "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 9},
                {"field_key": "skip_rate_pct",         "label": "Skip Rate %",    "data_type": "number", "is_default_column": True,  "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 10},
                {"field_key": "yes_count",             "label": "Yes",            "data_type": "number", "is_default_column": False, "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 11},
                {"field_key": "no_count",              "label": "No",             "data_type": "number", "is_default_column": False, "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 12},
                {"field_key": "na_count",              "label": "N/A",            "data_type": "number", "is_default_column": False, "is_filterable": False, "is_sortable": True,  "is_aggregatable": True, "display_order": 13},
            ],
        },
    ]

    def _dynamic_field_label(field_key: str) -> str:
        replacements = {
            "emdbg": "EMD/BG",
            "kam": "KAM",
            "wo": "WO",
            "id": "ID",
        }
        parts = field_key.split("_")
        return " ".join(replacements.get(part, part.title()) for part in parts)

    def _dynamic_field_type(field_key: str, cfg_filters: dict) -> str:
        if field_key in cfg_filters and len(cfg_filters[field_key]) > 1:
            return cfg_filters[field_key][1]
        lowered = field_key.lower()
        if any(token in lowered for token in ("amount", "value", "revenue", "bid")):
            return "currency"
        if lowered.endswith("_at"):
            return "datetime"
        if "date" in lowered or lowered in {"expiry_date", "valid_until"}:
            return "date"
        if any(token in lowered for token in ("count", "percent", "duration", "_id")) or lowered == "id":
            return "number"
        return "text"

    from app.routers.report_engine_router import REPORT_ENGINE_CONFIG as _REPORT_ENGINE_CONFIG
    seeded_report_type_keys = {rt["key"] for rt in REPORT_TYPES_SEED}
    for rt_key, cfg in _REPORT_ENGINE_CONFIG.items():
        if rt_key in seeded_report_type_keys or not cfg.get("report_type_name"):
            continue
        cfg_fields = cfg.get("fields", {})
        cfg_filters = cfg.get("filter_fields", {})
        cfg_field_meta = cfg.get("field_metadata", {})
        fields = []
        default_count = 0
        for idx, field_key in enumerate(cfg_fields.keys()):
            meta = dict(cfg_field_meta.get(field_key) or {})
            is_default = bool(meta.get("is_default_column")) if "is_default_column" in meta else field_key != "id" and default_count < 10
            if is_default:
                default_count += 1
            field_data = {
                "field_key": field_key,
                "label": meta.pop("label", _dynamic_field_label(field_key)),
                "data_type": meta.pop("data_type", _dynamic_field_type(field_key, cfg_filters)),
                "is_default_column": is_default,
                "is_filterable": meta.pop("is_filterable", field_key in cfg_filters),
                "is_sortable": meta.pop("is_sortable", True),
                "display_order": meta.pop("display_order", idx),
            }
            field_data.update(meta)
            fields.append(field_data)
        REPORT_TYPES_SEED.append({
            "key": rt_key,
            "name": cfg.get("report_type_name") or rt_key.replace("_", " ").title(),
            "base_table": rt_key,
            "description": cfg.get("description"),
            "module_permission_key": cfg.get("module_permission_key"),
            "default_date_field": "created_at",
            "supports_charts": True,
            "supports_grouping": True,
            "sort_order": int(cfg.get("sort_order") or 100),
            "fields": fields,
        })

    SYSTEM_FOLDERS = [
        {"name": "Standard Reports", "visibility": "org", "is_system": True},
        {"name": "My Reports",       "visibility": "private", "is_system": False},
    ]

    # Standard saved reports (system = True, cloneable by users)
    STANDARD_SAVED_REPORTS = [
        {
            "report_type_key": "leads",
            "name": "All Leads",
            "description": "Complete leads listing with default columns",
            "config_json": {"fields": ["lead_ref_id","lead_title","customer_name","status","priority","est_value","assigned_to_name","created_at"]},
        },
        {
            "report_type_key": "leads",
            "name": "Leads by Status",
            "description": "Leads grouped by status",
            "config_json": {"fields": ["lead_ref_id","lead_title","customer_name","status","est_value","assigned_to_name","created_at"], "sort": [{"field": "status","direction": "asc"}]},
        },
        {
            "report_type_key": "tenders",
            "name": "All Tenders",
            "description": "Complete tender listing",
            "config_json": {"fields": ["tender_ref_id","tender_title","customer_name","status","result","bid_amount","submission_date","assigned_to_name"]},
        },
        {
            "report_type_key": "tenders",
            "name": "Won Tenders",
            "description": "Tenders with result = Won",
            "config_json": {"fields": ["tender_ref_id","tender_title","customer_name","bid_amount","result_date","assigned_to_name"], "filters": [{"field": "result","operator": "eq","value": "Won"}]},
        },
        {
            "report_type_key": "workorders",
            "name": "All Work Orders",
            "description": "Complete work orders listing",
            "config_json": {"fields": ["wo_number","project_title","customer_name","wo_type","wo_value","status","delivery_date","created_by_name"]},
        },
        {
            "report_type_key": "emdbg",
            "name": "All EMD / BG",
            "description": "All EMD and BG instruments",
            "config_json": {"fields": ["instrument_type","instrument_number","bank_name","amount","issue_date","expiry_date","status"]},
        },
        {
            "report_type_key": "customers",
            "name": "Active Customers",
            "description": "All active customers with key profile fields",
            "config_json": {
                "fields": ["customer_name","customer_vertical","billing_city","billing_state","account_status","account_potential","assigned_to_name","group_name"],
                "filters": [{"field": "account_status", "operator": "eq", "value": "Active"}],
            },
        },
        {
            "report_type_key": "customers",
            "name": "All Customers",
            "description": "Complete customer listing",
            "config_json": {"fields": ["customer_name","customer_vertical","billing_city","billing_state","account_status","account_potential","assigned_to_name","group_name","created_at"]},
        },
        {
            "report_type_key": "travel",
            "name": "All Travel Requests",
            "description": "Complete travel request listing",
            "config_json": {"fields": ["purpose","from_city","to_city","travel_date","return_date","status","created_by_name"]},
        },
        {
            "report_type_key": "quotations",
            "name": "All Quotations",
            "description": "Complete quotations listing",
            "config_json": {"fields": ["quotation_number","subject","customer_name","total_amount","status","valid_until","created_at"]},
        },
        {
            "report_type_key": "customer_leads",
            "name": "Customer → Leads",
            "description": "All leads with customer profile — account status, vertical, division from customers table",
            "config_json": {"fields": ["customer_name","customer_vertical","account_status","lead_ref_id","lead_title","status","est_value","assigned_to_name","created_at"]},
        },
        {
            "report_type_key": "customer_leads",
            "name": "Won Leads by Customer",
            "description": "Won leads with customer context, sorted by value",
            "config_json": {"fields": ["customer_name","customer_vertical","lead_ref_id","lead_title","est_value","converted_at","assigned_to_name"], "filters": [{"field": "status","operator": "eq","value": "Won"}], "sort": [{"field": "est_value","direction": "desc"}]},
        },
        {
            "report_type_key": "customer_pipeline",
            "name": "All Customer Pipeline",
            "description": "Customer-wise leads and linked quotations",
            "config_json": {"fields": ["customer_name","customer_region","customer_status","lead_title","lead_status","lead_value","quotation_number","quotation_status","quotation_amount","assigned_to_name"]},
        },
        {
            "report_type_key": "customer_pipeline",
            "name": "Customers with Won Leads",
            "description": "Customer pipeline rows where the linked lead is converted or won",
            "config_json": {
                "fields": ["customer_name","customer_region","lead_title","lead_status","lead_value","quotation_number","quotation_status","quotation_amount","assigned_to_name"],
                "filters": [{"field": "lead_status", "operator": "in", "value": ["Converted"]}],
            },
        },
        {
            "report_type_key": "customer_pipeline",
            "name": "Customers with Quotations",
            "description": "Customers with linked quotation pipeline rows",
            "config_json": {
                "fields": ["customer_name","customer_region","lead_title","quotation_number","quotation_status","quotation_amount","assigned_to_name"],
                "filters": [{"field": "quotation_status", "operator": "is_not_null", "value": None}],
            },
        },
        {
            "report_type_key": "lead_quotation",
            "name": "Leads with Quotations",
            "description": "Leads and their quotation details",
            "config_json": {"fields": ["lead_ref_id","lead_title","customer_name","lead_status","lead_value","quotation_number","quotation_status","quotation_amount","quotation_created_at","assigned_to_name"]},
        },
        {
            "report_type_key": "quotation_workorder",
            "name": "Accepted Quotations to Work Orders",
            "description": "Accepted quotations with linked work order status and value",
            "config_json": {
                "fields": ["lead_title","customer_name","quotation_status","quotation_amount","work_order_status","work_order_value","quotation_number","work_order_number","created_at"],
                "filters": [{"field": "quotation_status", "operator": "eq", "value": "Accepted"}],
            },
        },
        {
            "report_type_key": "tender_workorder",
            "name": "Won Tenders to Work Orders",
            "description": "Won tenders with linked work order status and value",
            "config_json": {
                "fields": ["tender_ref_id","tender_title","tender_result","bid_amount","customer_name","work_order_number","work_order_value","work_order_status","assigned_to_name"],
                "filters": [{"field": "tender_result", "operator": "eq", "value": "Won"}],
            },
        },
    ]

    db = MasterSessionLocal()
    try:
        tenants = db.query(Tenant).filter(Tenant.status.in_(["active", "trial"])).all()
    except Exception as e:
        logger.warning("Report engine seed: cannot read tenants -- %s", e)
        return
    finally:
        db.close()

    for tenant in tenants:
        try:
            db_name = build_tenant_db_name(tenant.slug)
            engine_url = tenant_db_url(db_name)
            engine = create_engine(engine_url)
            Session = sessionmaker(bind=engine)
            tdb = Session()
            try:
                # --- folders ---
                standard_folder_id = None
                for fd in SYSTEM_FOLDERS:
                    existing = tdb.query(ReportFolder).filter(ReportFolder.name == fd["name"]).first()
                    if not existing:
                        nf = ReportFolder(
                            name=fd["name"],
                            visibility=fd["visibility"],
                            is_system=fd["is_system"],
                        )
                        tdb.add(nf)
                        tdb.flush()
                        if fd["name"] == "Standard Reports":
                            standard_folder_id = nf.id
                    else:
                        if fd["name"] == "Standard Reports":
                            standard_folder_id = existing.id

                # --- report types + fields ---
                _UPDATABLE_FIELD_COLS = (
                    "expression", "join_key", "filter_expression", "source_table", "source_column",
                    "label", "data_type", "is_default_column", "is_filterable", "is_sortable",
                    "is_groupable", "is_aggregatable", "display_order", "enum_values", "allowed_operators",
                    "drilldown_kind", "drilldown_target", "drilldown_id_field", "drilldown_filter_field",
                )
                _UPDATABLE_REPORT_TYPE_COLS = (
                    "name", "description", "base_table", "module_permission_key",
                    "default_date_field", "supports_charts", "supports_grouping", "sort_order",
                )
                rt_id_map: dict[str, int] = {}
                for rt_data in REPORT_TYPES_SEED:
                    rt_key_for_log = rt_data["key"]
                    fields_data = rt_data.pop("fields", [])
                    # Enrich with SQL source mapping from REPORT_ENGINE_CONFIG
                    fields_data = _enrich_seed_fields(fields_data, rt_data["key"])
                    # Each report type gets its own SAVEPOINT: a failure seeding one
                    # report type's fields (e.g. one bad field definition) must not
                    # silently roll back every other report type already processed
                    # in this same run for this tenant — that produced exactly the
                    # kind of "some fields missing, no error visible" gap this fixes.
                    try:
                        with tdb.begin_nested():
                            existing_rt = tdb.query(ReportType).filter(ReportType.key == rt_data["key"]).first()
                            if not existing_rt:
                                rt = ReportType(**rt_data, is_active=True)
                                tdb.add(rt)
                                tdb.flush()
                                rt_id = rt.id
                                for fdata in fields_data:
                                    tdb.add(ReportTypeField(report_type_id=rt_id, **fdata))
                            else:
                                rt_id = existing_rt.id
                                for col in _UPDATABLE_REPORT_TYPE_COLS:
                                    if col in rt_data:
                                        setattr(existing_rt, col, rt_data[col])
                                existing_rt.is_active = True
                                # Upsert fields — patch source mapping on existing rows, add new ones
                                for fdata in fields_data:
                                    existing_f = tdb.query(ReportTypeField).filter(
                                        ReportTypeField.report_type_id == rt_id,
                                        ReportTypeField.field_key == fdata["field_key"],
                                    ).first()
                                    if existing_f:
                                        for col in _UPDATABLE_FIELD_COLS:
                                            if col in fdata:
                                                setattr(existing_f, col, fdata[col])
                                    else:
                                        tdb.add(ReportTypeField(report_type_id=rt_id, **fdata))
                                # Drop fields that no longer exist in REPORT_ENGINE_CONFIG — otherwise
                                # a removed column (e.g. avg_rating) keeps surfacing forever, since the
                                # loop above only adds/updates and never deletes.
                                current_keys = {fdata["field_key"] for fdata in fields_data}
                                if current_keys:
                                    tdb.query(ReportTypeField).filter(
                                        ReportTypeField.report_type_id == rt_id,
                                        ReportTypeField.field_key.notin_(current_keys),
                                    ).delete(synchronize_session=False)
                            tdb.flush()
                    except Exception as e:
                        logger.error(
                            "Report engine seed: report type '%s' failed for tenant %s -- %s",
                            rt_key_for_log, tenant.slug, e,
                        )
                        continue
                    rt_id_map[rt_data["key"]] = rt_id

                # --- standard saved reports ---
                for sr_data in STANDARD_SAVED_REPORTS:
                    rt_key = sr_data["report_type_key"]
                    rt_id  = rt_id_map.get(rt_key)
                    if not rt_id:
                        continue
                    existing_sr = tdb.query(SavedReport).filter(
                        SavedReport.name == sr_data["name"],
                        SavedReport.is_system == True,
                    ).first()
                    if not existing_sr:
                        tdb.add(SavedReport(
                            name=sr_data["name"],
                            description=sr_data.get("description"),
                            report_type_id=rt_id,
                            folder_id=standard_folder_id,
                            is_system=True,
                            visibility="org",   # system reports visible to all
                            config_json=sr_data.get("config_json"),
                            is_active=True,
                        ))

                tdb.commit()
                logger.info("Report engine seed done: %s", tenant.slug)
            except Exception as e:
                tdb.rollback()
                logger.warning("Report engine seed failed [%s]: %s", tenant.slug, e)
            finally:
                tdb.close()
            engine.dispose()
        except Exception as e:
            logger.warning("Report engine seed skipped [%s]: %s", tenant.slug, e)
