"""Dashboard, Command Center and Billing & Metering KPIs."""

from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.tenant import Tenant
from app.services.platform_kpi import Col, Kpi, register
from app.services.platform_kpi_specs.common import TENANT_COLS, TENANT_LINK, TENANT_SEARCH, TENANTS_SQL, count_where, tenants_where

logger = logging.getLogger(__name__)

TENANT_BREAKDOWN = dict(columns=TENANT_COLS, search=TENANT_SEARCH, status="status", date="created_at", sort="created_at", link=TENANT_LINK)


def _tenants(db: Session, ctx: dict) -> list[Tenant]:
    query = db.query(Tenant)
    if ctx["scope"] is not None:
        query = query.filter(Tenant.id.in_(ctx["scope"] or [0]))
    if ctx.get("tenant_id") is not None:  # a tenant-filtered popup only needs that tenant's database
        query = query.filter(Tenant.id == ctx["tenant_id"])
    return query.order_by(Tenant.name).all()


def _per_tenant_db(db: Session, ctx: dict, fn) -> list[dict]:
    """Run ``fn(tenant_session, tenant)`` against every tenant database; unreachable ones are reported, not skipped."""
    from app.database import get_tenant_session

    rows = []
    for tenant in _tenants(db, ctx):
        base = {"tenant_id": tenant.id, "tenant": tenant.name, "slug": tenant.slug, "status": tenant.status}
        try:
            session = get_tenant_session(tenant.slug)
            try:
                rows.append({**base, **fn(session, tenant), "reachable": "Reachable"})
            finally:
                session.close()
        except Exception:
            logger.warning("KPI drill-down could not read tenant %s", tenant.slug)
            rows.append({**base, "reachable": "Not reachable"})
    return rows


# ── Dashboard ────────────────────────────────────────────────────────────────

def _subscriptions(db: Session, ctx: dict) -> list[dict]:
    from app.routers.platform_router import subscription_summary

    rows = subscription_summary(db)["tenants"]
    return [{"tenant_id": r["id"], "tenant": r["name"], "slug": r["slug"], "status": r["status"], "billing_status": r.get("billing_status"),
             "state": r["subscription_state"], "renewal_date": r["renewal_date"], "admin_email": r.get("admin_email"), "created_at": r.get("created_at")}
            for r in rows]


SUB_COLS = [Col("tenant", "Tenant"), Col("slug", "Slug", "code"), Col("state", "Subscription", "pill"), Col("status", "Status", "pill"),
            Col("billing_status", "Billing", "pill"), Col("renewal_date", "Renewal / end date", "date"), Col("admin_email", "Admin e-mail"),
            Col("tenant_id", "Tenant ID", "num", hidden=True), Col("created_at", "Created", "date", hidden=True)]


def _tenant_users(db: Session, ctx: dict) -> list[dict]:
    def read(session, tenant):
        r = session.execute(text("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END), 0) AS active FROM users")).first()
        return {"users": int(r.total), "active_users": int(r.active), "max_users": tenant.max_users}
    return _per_tenant_db(db, ctx, read)


def _db_health(db: Session, ctx: dict) -> list[dict]:
    from app.routers.platform_backup_router import tenant_database_health

    rows = []
    for tenant in _tenants(db, ctx):
        h = tenant_database_health(tenant.id, db)
        rows.append({"tenant_id": tenant.id, "tenant": tenant.name, "db_name": tenant.db_name, "health": h["health"],
                     "size_bytes": h["total_bytes"], "active_users": h["active_users"], "connections": h["connections"],
                     "max_connections": h["max_connections"], "running_queries": h["running_queries"], "slow_queries": h["slow_queries"],
                     "checked_at": h["checked_at"]})
    return rows


register(
    Kpi("dashboard.total_tenants", "Total tenants", "tenants", sql=TENANTS_SQL, group="plan", **TENANT_BREAKDOWN,
        summary=[("Active", count_where("q.status = 'active'"), "num"), ("Trial", count_where("q.status = 'trial'"), "num"),
                 ("Suspended", count_where("q.status = 'suspended'"), "num"), ("Cancelled", count_where("q.status = 'cancelled'"), "num")]),
    Kpi("dashboard.active_tenants", "Active tenants", "tenants", sql=tenants_where("tt.status = 'active'"), group="plan", **TENANT_BREAKDOWN,
        summary=[("Created · 30 days", count_where("q.created_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY"), "num")]),
    Kpi("dashboard.trial_tenants", "Trial tenants", "tenants", sql=tenants_where("tt.status = 'trial'"), group="plan", **TENANT_BREAKDOWN,
        summary=[("Trial ending ≤ 7 days", count_where("q.trial_ends_at BETWEEN UTC_TIMESTAMP() AND UTC_TIMESTAMP() + INTERVAL 7 DAY"), "num"),
                 ("Trial already ended", count_where("q.trial_ends_at < UTC_TIMESTAMP()"), "num")]),
    Kpi("dashboard.suspended_tenants", "Suspended tenants", "tenants", sql=tenants_where("tt.status = 'suspended'"), group="plan", **TENANT_BREAKDOWN),
    Kpi("dashboard.expired_tenants", "Expired subscriptions", ("tenants", "billing"), columns=SUB_COLS,
        rows=lambda db, ctx: [r for r in _subscriptions(db, ctx) if r["state"] == "expired"],
        search=("tenant", "slug", "admin_email"), status="billing_status", date="renewal_date", sort="renewal_date", group="billing_status", link=TENANT_LINK,
        description="Cancelled or past-due billing, or a subscription / trial end date in the past"),
    Kpi("dashboard.subscriptions", "Subscriptions", ("tenants", "billing"), columns=SUB_COLS, rows=_subscriptions,
        search=("tenant", "slug", "admin_email"), status="state", date="renewal_date", sort="renewal_date", group="state", link=TENANT_LINK),
    Kpi("dashboard.tenant_users", "Tenant users", "tenants", rows=_tenant_users, sort="users", group="reachable", link=TENANT_LINK,
        columns=[Col("tenant", "Tenant"), Col("slug", "Slug", "code"), Col("status", "Status", "pill"), Col("users", "Users", "num"),
                 Col("active_users", "Active users", "num"), Col("max_users", "User limit", "num"), Col("reachable", "Database", "pill"),
                 Col("tenant_id", "Tenant ID", "num", hidden=True)],
        search=("tenant", "slug"), status="status",
        summary=[("Users", lambda rows: sum(r.get("users") or 0 for r in rows), "num"), ("Active users", lambda rows: sum(r.get("active_users") or 0 for r in rows), "num"),
                 ("Unreachable databases", lambda rows: sum(1 for r in rows if r["reachable"] != "Reachable"), "num")]),
    Kpi("dashboard.system_health", "System health", "tenants", rows=_db_health, sort="health", desc=False, group="health", link=TENANT_LINK,
        columns=[Col("tenant", "Tenant"), Col("db_name", "Database", "code"), Col("health", "Health", "pill"), Col("size_bytes", "Size", "bytes"),
                 Col("connections", "Connections", "num"), Col("running_queries", "Running queries", "num"), Col("slow_queries", "Slow queries", "num"),
                 Col("tenant_id", "Tenant ID", "num", hidden=True), Col("active_users", "Active users", "num", hidden=True),
                 Col("max_connections", "Max connections", "num", hidden=True), Col("checked_at", "Checked", "datetime", hidden=True)],
        search=("tenant", "db_name"), status="health",
        summary=[("Healthy", lambda rows: sum(1 for r in rows if r["health"] == "healthy"), "num"),
                 ("Unavailable", lambda rows: sum(1 for r in rows if r["health"] != "healthy"), "num")]),
    Kpi("dashboard.active_admins", "Active platform admins", "team", tenant=None, tenant_name=None, link="/platform/super-admins/{id}/edit",
        sql="""SELECT a.id, a.full_name AS name, a.username, a.email, a.is_active, r.name AS role, COALESCE(s.scope, 'all') AS scope, a.created_at,
                      (SELECT MAX(l.created_at) FROM platform_audit_logs l WHERE l.super_admin_id = a.id) AS last_action
               FROM super_admins a LEFT JOIN platform_staff_access s ON s.admin_id = a.id LEFT JOIN platform_roles r ON r.id = s.role_id
               WHERE a.is_active = 1""",
        columns=[Col("name", "Name"), Col("username", "Username", "code"), Col("email", "E-mail"), Col("role", "Role"), Col("scope", "Tenant scope", "pill"),
                 Col("last_action", "Last action", "datetime"), Col("created_at", "Created", "date"), Col("id", "Admin ID", "num", hidden=True)],
        search=("name", "username", "email", "role"), group="role", sort="last_action", date="created_at"),
)


# ── Command Center ───────────────────────────────────────────────────────────

def _traffic(db: Session, ctx: dict) -> list[dict]:
    from app.services import platform_monitoring as monitor

    now = time.time()
    return [{"at": datetime.utcfromtimestamp(now - p["minutes_ago"] * 60), "minutes_ago": p["minutes_ago"], "requests": p["requests"], "rps": p["rps"],
             "p50": p["p50"], "p95": p["p95"], "p99": p["p99"], "error_rate": p["error_rate"],
             "errors": round((p["error_rate"] or 0) * p["requests"] / 100)} for p in monitor.series("api", "1h") if p["requests"]]


TRAFFIC_COLS = [Col("at", "Window ending", "datetime"), Col("requests", "Requests", "num"), Col("rps", "Req / s", "num"), Col("p50", "p50", "ms"),
                Col("p95", "p95", "ms"), Col("p99", "p99", "ms"), Col("errors", "Errors", "num"), Col("error_rate", "Error rate", "pct"),
                Col("minutes_ago", "Minutes ago", "num", hidden=True)]
TRAFFIC = dict(rows=_traffic, columns=TRAFFIC_COLS, tenant=None, tenant_name=None, date="at", link=None,
               note="API traffic measured by this server, in 1-hour windows of per-minute histograms (only windows with traffic are listed).",
               summary=[("Requests · 1 h", lambda rows: sum(r["requests"] for r in rows), "num"), ("Errors · 1 h", lambda rows: sum(r["errors"] for r in rows), "num"),
                        ("Worst p95", lambda rows: max((r["p95"] for r in rows if r["p95"] is not None), default=None), "ms")])


def _servers(db: Session, ctx: dict) -> list[dict]:
    from app.services import platform_infrastructure as infra

    snap = infra.infrastructure_snapshot(_tenants(db, ctx))
    rows = []
    for s in snap["servers"]:
        d = s.get("database") or {}
        m = s.get("metrics") or {}
        rows.append({"server": s["name"], "region": s.get("region"), "role": s.get("role") or ", ".join(s.get("roles") or []), "status": s.get("status"),
                     "db_status": d.get("status"), "connections": d.get("connections"), "max_connections": d.get("max_connections"),
                     "latency_ms": d.get("latency_ms"), "tenants": s.get("tenant_count"), "uptime_30d": s.get("uptime_30d"),
                     "cpu": m.get("cpu_percent"), "memory": m.get("memory_percent"), "disk": m.get("disk_percent")})
    return rows


SERVER_COLS = [Col("server", "Server"), Col("region", "Region"), Col("status", "Status", "pill"), Col("db_status", "Database", "pill"),
               Col("connections", "Connections", "num"), Col("max_connections", "Max", "num"), Col("tenants", "Tenants", "num"),
               Col("uptime_30d", "Uptime · 30d", "pct"), Col("cpu", "CPU", "pct"), Col("memory", "RAM", "pct"), Col("disk", "Disk", "pct"),
               Col("role", "Role", hidden=True), Col("latency_ms", "DB latency", "ms", hidden=True)]
SERVERS = dict(rows=_servers, columns=SERVER_COLS, tenant=None, tenant_name=None, search=("server", "region"), status="status", group="region", link="/platform/infrastructure")


def _sessions(db: Session, ctx: dict) -> list[dict]:
    def read(session, tenant):
        minutes = int(tenant.inactivity_timeout_minutes or 30)
        r = session.execute(text(
            "SELECT COUNT(*) AS active, MAX(last_active) AS last_active FROM user_sessions WHERE is_active = 1 AND logout_time IS NULL AND revoked_at IS NULL "
            "AND last_active >= NOW() - INTERVAL :m MINUTE"), {"m": minutes}).first()
        users = session.execute(text("SELECT COUNT(*) FROM users")).scalar_one()
        return {"sessions": int(r.active or 0), "last_active": r.last_active, "users": int(users), "timeout_min": minutes}
    return _per_tenant_db(db, ctx, read)


def _incidents_sql(where: str = "1=1") -> str:
    return f"""SELECT i.id, CONCAT('INC-', LPAD(i.id, 3, '0')) AS code, i.title, i.severity, i.status, i.source, i.started_at, i.resolved_at,
                      TIMESTAMPDIFF(MINUTE, i.started_at, COALESCE(i.resolved_at, UTC_TIMESTAMP())) AS duration_min, i.detail
               FROM platform_incidents i WHERE {where}"""


INCIDENT_COLS = [Col("code", "ID", "code"), Col("title", "Title"), Col("severity", "Severity", "pill"), Col("status", "Status", "pill"),
                 Col("started_at", "Started", "datetime"), Col("resolved_at", "Resolved", "datetime"), Col("duration_min", "Duration (min)", "num"),
                 Col("source", "Source", hidden=True), Col("detail", "Detail", hidden=True), Col("id", "Incident ID", "num", hidden=True)]
INCIDENTS = dict(columns=INCIDENT_COLS, tenant=None, tenant_name=None, search=("code", "title", "source"), status="status", date="started_at",
                 sort="started_at", group="severity", link="/platform/monitoring")

register(
    Kpi("command.requests", "Requests / sec", "monitoring", sort="at", **TRAFFIC),
    Kpi("command.p95", "API p95 latency", "monitoring", sort="p95", **TRAFFIC),
    Kpi("command.error_rate", "Error rate", "monitoring", sort="error_rate", **TRAFFIC),
    Kpi("command.sessions", "Active sessions", "tenants", rows=_sessions, sort="sessions", group="reachable", link=TENANT_LINK, search=("tenant", "slug"), status="status",
        columns=[Col("tenant", "Tenant"), Col("slug", "Slug", "code"), Col("status", "Status", "pill"), Col("sessions", "Active sessions", "num"),
                 Col("users", "Provisioned users", "num"), Col("last_active", "Last activity", "datetime"), Col("timeout_min", "Idle timeout (min)", "num"),
                 Col("reachable", "Database", "pill"), Col("tenant_id", "Tenant ID", "num", hidden=True)],
        summary=[("Active sessions", lambda rows: sum(r.get("sessions") or 0 for r in rows), "num"), ("Provisioned users", lambda rows: sum(r.get("users") or 0 for r in rows), "num")]),
    Kpi("command.db_connections", "DB connections", ("databases", "infrastructure"), sort="connections", **SERVERS,
        summary=[("Connections", lambda rows: sum(r.get("connections") or 0 for r in rows), "num"), ("Max connections", lambda rows: sum(r.get("max_connections") or 0 for r in rows), "num")]),
    Kpi("command.uptime", "Uptime · 30d", ("infrastructure", "monitoring"), sort="uptime_30d", desc=False, **SERVERS),
    Kpi("command.incidents", "Open incidents", "monitoring", sql=_incidents_sql("i.status <> 'Resolved'"), **INCIDENTS),
    Kpi("command.tenants", "Tenants", "tenants", sql=TENANTS_SQL, group="status", **{**TENANT_BREAKDOWN}),
    Kpi("command.active", "Active tenants", "tenants", sql=tenants_where("tt.status IN ('active', 'trial')"), group="status", **TENANT_BREAKDOWN),
    Kpi("command.storage", "Storage", "tenants", sql=TENANTS_SQL, group="plan", **{**TENANT_BREAKDOWN, "sort": "storage_mb", "columns": [
        Col("tenant", "Tenant"), Col("plan", "Plan"), Col("status", "Status", "pill"), Col("storage_mb", "Used", "mb"), Col("storage_limit_mb", "Limit", "mb"),
        *[c for c in TENANT_COLS if c.key in ("tenant_id", "slug", "admin_email", "created_at")]]},
        summary=[("Used", "SUM(q.storage_mb)", "mb"), ("Allocated", "SUM(q.storage_limit_mb)", "mb")]),
)


# ── Billing & Metering ──────────────────────────────────────────────────────

def _recurring(db: Session, ctx: dict) -> list[dict]:
    from app.services import platform_billing as billing

    tenants = _tenants(db, ctx)
    plans = billing.tenant_prices(db, tenants)
    names = {t.id: t for t in tenants}
    return [{"tenant_id": r["tenant_id"], "tenant": r["name"], "slug": r["slug"], "plan": plans[r["tenant_id"]]["plan"].name if plans[r["tenant_id"]]["plan"] else None,
             "mrr": r["mrr"], "arr": r["mrr"] * 12, "list_mrr": r["list_mrr"], "discount": r["list_mrr"] - r["mrr"], "addon_mrr": r["addon_mrr"],
             "price_source": r["source"], "billing_status": names[r["tenant_id"]].billing_status} for r in billing.recurring(db, tenants)["by_tenant"]]


MRR_COLS = [Col("tenant", "Tenant"), Col("plan", "Plan"), Col("mrr", "MRR", "inr"), Col("arr", "ARR", "inr"), Col("list_mrr", "List MRR", "inr"),
            Col("discount", "Discount", "inr"), Col("addon_mrr", "Add-ons", "inr"), Col("price_source", "Price from"),
            Col("billing_status", "Billing", "pill", hidden=True), Col("slug", "Slug", "code", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True)]
MRR = dict(rows=_recurring, columns=MRR_COLS, search=("tenant", "slug", "plan"), status="billing_status", group="plan", amount="mrr", link=TENANT_LINK,
           summary=[("Paying tenants", lambda rows: len(rows), "num"), ("MRR", lambda rows: sum(r["mrr"] for r in rows), "inr"),
                    ("Discounts", lambda rows: sum(r["discount"] for r in rows), "inr"), ("Add-on MRR", lambda rows: sum(r["addon_mrr"] for r in rows), "inr")])

INVOICES_SQL = """
SELECT i.id, i.number, i.tenant_id, t.name AS tenant, i.plan_name AS plan, i.cycle, i.period_start, i.period_end, i.issued_on, i.due_on,
       i.total, i.amount_paid, i.amount_credited, (i.total - i.amount_paid - i.amount_credited) AS balance,
       CASE WHEN i.status <> 'Pending' THEN i.status WHEN i.last_failure_at IS NOT NULL THEN 'Failed' WHEN i.due_on < CURDATE() THEN 'Overdue' ELSE 'Due' END AS status,
       i.paid_on, i.payment_ref, i.gateway, i.last_failure_reason, DATEDIFF(CURDATE(), i.due_on) AS days_overdue
FROM platform_invoices i JOIN tenants t ON t.id = i.tenant_id
"""
INVOICE_COLS = [Col("number", "Invoice", "code"), Col("tenant", "Tenant"), Col("issued_on", "Issued", "date"), Col("due_on", "Due", "date"),
                Col("total", "Total", "inr"), Col("balance", "Balance", "inr"), Col("status", "Status", "pill"),
                Col("plan", "Plan", hidden=True), Col("cycle", "Cycle", hidden=True), Col("period_start", "Period start", "date", hidden=True),
                Col("period_end", "Period end", "date", hidden=True), Col("amount_paid", "Paid", "inr", hidden=True), Col("amount_credited", "Credited", "inr", hidden=True),
                Col("paid_on", "Paid on", "date", hidden=True), Col("payment_ref", "Payment ref", hidden=True), Col("gateway", "Gateway", hidden=True),
                Col("last_failure_reason", "Failure reason", hidden=True), Col("days_overdue", "Days past due", "num", hidden=True),
                Col("tenant_id", "Tenant ID", "num", hidden=True), Col("id", "Invoice ID", "num", hidden=True)]
INVOICES = dict(columns=INVOICE_COLS, search=("number", "tenant", "plan", "payment_ref"), status="status", date="issued_on", sort="issued_on",
                group="status", amount="balance", link=TENANT_LINK,
                summary=[("Invoiced", "SUM(q.total)", "inr"), ("Collected", "SUM(q.amount_paid)", "inr"), ("Balance", "SUM(q.balance)", "inr")])

register(
    Kpi("billing.mrr", "MRR", "billing", sort="mrr", **MRR),
    Kpi("billing.arr", "ARR", "billing", sort="arr", **MRR),
    Kpi("command.mrr", "MRR", "billing", sort="mrr", **MRR),
    Kpi("billing.outstanding", "Outstanding", "billing", sql=f"SELECT * FROM ({INVOICES_SQL}) ii WHERE ii.status IN ('Due', 'Overdue', 'Failed')", **{**INVOICES, "sort": "due_on", "desc": False}),
    Kpi("billing.trials", "Trials", ("billing", "tenants"), sql=tenants_where("tt.status = 'trial' OR tt.billing_status = 'trial'"), group="plan", **TENANT_BREAKDOWN,
        summary=[("Ending ≤ 7 days", count_where("q.trial_ends_at BETWEEN UTC_TIMESTAMP() AND UTC_TIMESTAMP() + INTERVAL 7 DAY"), "num")]),
)

# Dashboard "Backup coverage": each tenant's latest backup, classified as on the dashboard.
register(
    Kpi("dashboard.backups", "Backup coverage", ("backups", "tenants"), link=TENANT_LINK, group="coverage", status="status", date="taken_at", sort="taken_at",
        sql="""SELECT t.id AS tenant_id, t.name AS tenant, t.slug, b.id AS backup_id, b.name AS backup, b.status, b.frequency, b.file_name, b.error,
                      COALESCE(b.completed_at, b.created_at) AS taken_at, b.next_run_at,
                      CASE WHEN b.id IS NULL THEN 'No backup' WHEN LOWER(b.status) = 'completed' THEN 'Protected' WHEN LOWER(b.status) = 'failed' THEN 'Failed'
                           WHEN LOWER(b.status) IN ('pending', 'running', 'in_progress') THEN 'In progress' ELSE 'No backup' END AS coverage
               FROM tenants t LEFT JOIN tenant_backups b ON b.id = (SELECT b2.id FROM tenant_backups b2 WHERE b2.tenant_id = t.id
                                                                     ORDER BY COALESCE(b2.completed_at, b2.created_at) DESC, b2.id DESC LIMIT 1)""",
        columns=[Col("tenant", "Tenant"), Col("coverage", "Coverage", "pill"), Col("backup", "Latest backup"), Col("status", "Status", "pill"),
                 Col("taken_at", "Taken", "datetime"), Col("frequency", "Schedule"), Col("next_run_at", "Next run", "datetime"),
                 Col("file_name", "File", "code", hidden=True), Col("error", "Error", hidden=True), Col("slug", "Slug", "code", hidden=True),
                 Col("tenant_id", "Tenant ID", "num", hidden=True), Col("backup_id", "Backup ID", "num", hidden=True)],
        search=("tenant", "slug", "backup"),
        summary=[("Protected", count_where("q.coverage = 'Protected'"), "num"), ("Failed", count_where("q.coverage = 'Failed'"), "num"),
                 ("No backup", count_where("q.coverage = 'No backup'"), "num")]),
)
