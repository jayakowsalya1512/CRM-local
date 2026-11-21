"""Tenants & Hierarchy (list, tenant detail, parent group), Onboarding, Customer success, Announcements and Subscriptions KPIs.

Tenant detail cards open these with a fixed ``tenant_id`` (``kpiQuery``), so every per-tenant source lists all tenants in
scope and the engine narrows it. Tenant databases are read over one connection to the tenant server (fully qualified
``db.table`` names) instead of one session per tenant.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta

import pymysql.cursors
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.database import get_tenant_session, validate_mysql_identifier
from app.services.platform_kpi import Col, Kpi, register
from app.services.platform_kpi_specs.common import TENANT_COLS, TENANT_LINK, TENANT_SEARCH, TENANTS_SQL, count_where
from app.services.platform_kpi_specs.core import SUB_COLS, _subscriptions, _tenants

logger = logging.getLogger(__name__)

RECORD_CAP = 5000  # rows read per tenant table; the card counts every row (deleted ones included)


# ── tenant server helpers ─────────────────────────────────────────────────────

def _connect():
    from app.services.tenant_hierarchy import _connect as connect
    return connect(cursorclass=pymysql.cursors.DictCursor)


def _by_schema(db: Session, ctx: dict) -> dict:
    out = {}
    for t in _tenants(db, ctx):
        try:
            out[validate_mysql_identifier(t.db_name, field_name="database name")] = t
        except Exception:
            logger.warning("KPI drill-down skipped tenant %s: invalid database name", t.slug)
    return out


def _base(t) -> dict:
    return {"tenant_id": t.id, "tenant": t.name, "slug": t.slug}


def _records(table: str, cols: list[str]):
    """Rows of one tenant-app table from every tenant database (missing columns read as NULL)."""
    def rows(db: Session, ctx: dict) -> list[dict]:
        schemas = _by_schema(db, ctx)
        if not schemas:
            return []
        out, conn = [], _connect()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT table_schema AS s, column_name AS c FROM information_schema.columns WHERE table_name = %s AND table_schema IN %s",
                            (table, tuple(schemas)))
                have = defaultdict(set)
                for r in cur.fetchall():
                    have[r["s"]].add(r["c"])
                for schema, t in schemas.items():
                    if schema not in have:
                        continue
                    sel = ", ".join(f"`{c}`" if c in have[schema] else f"NULL AS `{c}`" for c in cols)
                    try:
                        cur.execute(f"SELECT {sel} FROM `{schema}`.`{table}` ORDER BY id DESC LIMIT {RECORD_CAP}")
                        out += [{**r, **_base(t)} for r in cur.fetchall()]
                    except Exception:
                        logger.warning("KPI drill-down could not read %s.%s", schema, table)
        finally:
            conn.close()
        return out
    return rows


def _tables(db: Session, ctx: dict) -> list[dict]:
    schemas = _by_schema(db, ctx)
    if not schemas:
        return []
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT table_schema, table_name, table_rows, data_length, index_length, data_free, update_time, engine FROM information_schema.tables "
                        "WHERE table_schema IN %s AND table_type = 'BASE TABLE'", (tuple(schemas),))
            found = cur.fetchall()
    finally:
        conn.close()
    mb = lambda v: round((v or 0) / 1024 ** 2, 4)  # noqa: E731  (4 places so the summed size matches the database total)
    return [{**_base(schemas[r["table_schema"]]), "db_name": r["table_schema"], "table": r["table_name"], "rows": int(r["table_rows"] or 0),
             "data_mb": mb(r["data_length"]), "index_mb": mb(r["index_length"]), "size_mb": round(mb(r["data_length"]) + mb(r["index_length"]), 4),
             "free_mb": mb(r["data_free"]), "engine": r["engine"], "updated_at": r["update_time"]} for r in found]


def _databases(db: Session, ctx: dict) -> list[dict]:
    """One row per tenant database: the same facts as the tenant Database tab (tenant_hierarchy.database_details)."""
    from app.services import platform_infrastructure as infra

    schemas = _by_schema(db, ctx)
    if not schemas:
        return []
    placement = infra.database_placements()
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT VERSION() AS v")
            version = cur.fetchone()["v"]
            cur.execute("SHOW VARIABLES WHERE Variable_name IN ('have_ssl','innodb_encrypt_tables','max_connections','character_set_server','collation_server')")
            var = {r["Variable_name"]: r["Value"] for r in cur.fetchall()}
            cur.execute("SHOW SLAVE STATUS")
            replica = cur.fetchone()
            cur.execute("SELECT table_schema AS s, COUNT(*) AS n, SUM(data_length) AS d, SUM(index_length) AS i, SUM(data_free) AS f FROM information_schema.tables "
                        "WHERE table_schema IN %s AND table_type = 'BASE TABLE' GROUP BY table_schema", (tuple(schemas),))
            sizes = {r["s"]: r for r in cur.fetchall()}
            cur.execute("SELECT db, COUNT(*) AS n FROM information_schema.processlist WHERE db IN %s GROUP BY db", (tuple(schemas),))
            conns = {r["db"]: int(r["n"]) for r in cur.fetchall()}
            cur.execute("SELECT schema_name AS s FROM information_schema.schemata WHERE schema_name LIKE %s", ("%\\_restore\\_%",))
            restores = [r["s"] for r in cur.fetchall()]
    finally:
        conn.close()
    engine = f"MariaDB {version.split('-')[0]}" if "MariaDB" in version else f"MySQL {version}"
    rows = []
    for schema, t in schemas.items():
        s = sizes.get(schema) or {}
        data, index = round(float(s.get("d") or 0) / 1024 ** 2, 2), round(float(s.get("i") or 0) / 1024 ** 2, 2)
        server = placement["databases"].get(schema, {}).get("server")
        rows.append({**_base(t), "db_name": schema, "engine": engine, "server": server, "server_ip": placement["servers"].get(server, {}).get("ip") if server else None,
                     "size_mb": round(data + index, 2), "data_mb": data, "index_mb": index, "free_mb": round(float(s.get("f") or 0) / 1024 ** 2, 2),
                     "tables": int(s.get("n") or 0), "connections": conns.get(schema, 0), "max_connections": int(var.get("max_connections", 0) or 0),
                     "charset": f"{var.get('character_set_server', '')} / {var.get('collation_server', '')}", "ssl": var.get("have_ssl", "DISABLED"),
                     "encryption": var.get("innodb_encrypt_tables", "OFF"), "replication": "Replica" if replica else "None",
                     "restored": sum(1 for r in restores if r.startswith(schema + "_restore_")), "reachable": "Reachable" if s else "Not found"})
    return rows


def _connections(db: Session, ctx: dict) -> list[dict]:
    schemas = _by_schema(db, ctx)
    if not schemas:
        return []
    conn = _connect()
    try:
        with conn.cursor() as cur:  # statement text is left out: it can carry data or credentials
            cur.execute("SELECT id, user, host, db, command, time, state FROM information_schema.processlist WHERE db IN %s", (tuple(schemas),))
            found = cur.fetchall()
    finally:
        conn.close()
    return [{**_base(schemas[r["db"]]), "conn_id": r["id"], "user": r["user"], "host": r["host"], "db_name": r["db"], "command": r["command"],
             "seconds": int(r["time"] or 0), "state": r["state"] or None} for r in found]


def _restored(db: Session, ctx: dict) -> list[dict]:
    schemas = _by_schema(db, ctx)
    if not schemas:
        return []
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT s.schema_name AS s, COUNT(t.table_name) AS n, SUM(t.data_length + t.index_length) AS b, MIN(t.create_time) AS c "
                        "FROM information_schema.schemata s LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name "
                        "WHERE s.schema_name LIKE %s GROUP BY s.schema_name", ("%\\_restore\\_%",))
            found = cur.fetchall()
    finally:
        conn.close()
    rows = []
    for r in found:
        source = next((name for name in schemas if r["s"].startswith(name + "_restore_")), None)
        if source:
            rows.append({**_base(schemas[source]), "db_name": source, "restored_db": r["s"], "tables": int(r["n"] or 0),
                         "size_mb": round(float(r["b"] or 0) / 1024 ** 2, 2), "created_at": r["c"]})
    return rows


# ── backups, sessions, traffic, availability ──────────────────────────────────

def _backups(db: Session, ctx: dict) -> list[dict]:
    """Same rows as GET /tenants/{id}/backups (file presence and size read from the backup directory)."""
    from app.models.platform_backup import TenantBackup
    from app.models.tenant import Tenant
    from app.services.platform_backup_service import BACKUP_DIR

    q = db.query(TenantBackup, Tenant.name, Tenant.slug).join(Tenant, Tenant.id == TenantBackup.tenant_id)
    if ctx["scope"] is not None:
        q = q.filter(TenantBackup.tenant_id.in_(ctx["scope"] or [0]))
    rows = []
    for b, name, slug in q.order_by(TenantBackup.created_at.desc()).all():
        path = (BACKUP_DIR / b.file_name) if b.file_name else None
        exists = bool(path and path.is_file())
        rows.append({"id": b.id, "tenant_id": b.tenant_id, "tenant": name, "slug": slug, "name": b.name, "status": b.status,
                     "type": f"Scheduled · {b.frequency}" if b.frequency else "On demand", "frequency": b.frequency, "created_at": b.created_at,
                     "completed_at": b.completed_at, "next_run_at": b.next_run_at, "available": exists,
                     "size_mb": round(path.stat().st_size / 1024 ** 2, 2) if exists else None, "error": (b.error or "")[:300] or None})
    return rows


BACKUP_COLS = [Col("name", "Snapshot"), Col("tenant", "Tenant"), Col("completed_at", "Taken", "datetime"), Col("type", "Type"), Col("size_mb", "Size", "mb"),
               Col("status", "Status", "pill"), Col("available", "File present", "bool"),
               Col("created_at", "Started", "datetime", hidden=True), Col("next_run_at", "Next run", "datetime", hidden=True), Col("error", "Error", hidden=True),
               Col("frequency", "Frequency", hidden=True), Col("id", "Backup ID", "num", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True)]
BACKUPS = dict(columns=BACKUP_COLS, search=("name", "tenant", "type"), status="status", date="created_at", group="status", link=TENANT_LINK)


def _sessions(db: Session, ctx: dict) -> list[dict]:
    """Active sessions as the tenant Monitoring tab counts them (tenant_hierarchy.tenant_metrics)."""
    from sqlalchemy import text

    rows = []
    for t in _tenants(db, ctx):
        try:
            s = get_tenant_session(t.slug)
        except Exception:
            continue
        try:
            for r in s.execute(text(
                    "SELECT us.id, us.user_id, u.full_name, u.email, u.role, us.device, us.browser, us.os, us.ip_address, us.location, us.login_time, us.last_active "
                    "FROM user_sessions us LEFT JOIN users u ON u.id = us.user_id WHERE us.is_active = 1 AND us.logout_time IS NULL AND us.revoked_at IS NULL "
                    "AND us.last_active >= NOW() - INTERVAL :m MINUTE"), {"m": int(t.inactivity_timeout_minutes or 30)}):
                rows.append({**_base(t), **dict(r._mapping), "session_id": r.id})
        except Exception:
            logger.warning("KPI drill-down could not read sessions of %s", t.slug)
        finally:
            s.close()
    return rows


def _traffic(db: Session, ctx: dict) -> list[dict]:
    """Per-tenant API traffic of this worker in 30-second windows over the last 5 minutes (platform_traffic buckets)."""
    import time

    from app.services import platform_controls as controls
    from app.services import platform_traffic as traffic

    now = int(time.time())
    with traffic._lock:
        buckets = {sec: ({k: v for k, v in b["tenants"].items()}, {k: (d["errors"], list(d["latencies"])) for k, d in b["tenant_detail"].items()})
                   for sec, b in traffic._buckets.items() if sec > now - traffic._WINDOW_SECONDS}
    rows = []
    for t in _tenants(db, ctx):
        target = float(controls.value(db, "sloLat", t.id) or 0)
        for w in range(traffic._WINDOW_SECONDS // 30):
            end = now - w * 30
            secs = [s for s in range(end - 29, end + 1) if s in buckets]
            count = sum(buckets[s][0].get(t.slug, 0) for s in secs)
            if not count:
                continue
            errors = sum(buckets[s][1].get(t.slug, (0, []))[0] for s in secs)
            lat = [ms for s in secs for ms in buckets[s][1].get(t.slug, (0, []))[1]]
            ok = sum(1 for ms in lat if ms <= target)
            tol = sum(1 for ms in lat if target < ms <= target * 4)
            rows.append({**_base(t), "at": datetime.utcfromtimestamp(end), "requests": count, "per_min": count * 2, "errors": errors,
                         "error_rate": round(errors / count * 100, 2), "p95": traffic._p95(lat), "apdex": round((ok + tol / 2) / len(lat), 2) if lat else None,
                         "target_ms": target})
    return rows


TRAFFIC_COLS = [Col("at", "Window ending", "datetime"), Col("tenant", "Tenant"), Col("requests", "Requests", "num"), Col("per_min", "Req / min", "num"),
                Col("p95", "p95", "ms"), Col("errors", "Errors", "num"), Col("error_rate", "Error rate", "pct"), Col("apdex", "Apdex", "num"),
                Col("target_ms", "Apdex T", "ms", hidden=True), Col("slug", "Slug", "code", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True)]
TRAFFIC = dict(rows=_traffic, columns=TRAFFIC_COLS, search=("tenant", "slug"), date="at", link=TENANT_LINK,
               note="Requests handled by this server in 30-second windows over the last 5 minutes (windows without traffic are left out).",
               summary=[("Requests · 5 min", lambda rows: sum(r["requests"] for r in rows), "num"),
                        ("Req / min", lambda rows: round(sum(r["requests"] for r in rows) / 5, 1), "num"),
                        ("Errors", lambda rows: sum(r["errors"] for r in rows), "num"),
                        ("Worst p95", lambda rows: max((r["p95"] for r in rows if r["p95"] is not None), default=None), "ms")])


def _availability(db: Session, ctx: dict) -> list[dict]:
    from app.services import platform_controls as controls
    from app.services import platform_infrastructure as infra
    from app.services import platform_uptime as uptime

    placed = infra.database_placements()["databases"]
    days: dict[str, list] = {}
    rows = []
    for t in _tenants(db, ctx):
        server = placed.get(t.db_name, {}).get("server")
        if not server:
            continue
        if server not in days:
            days[server] = uptime.daily_availability(server)
        sla = float(controls.value(db, "sloAvail", t.id) or 0)
        for d in days[server]:
            p = d["percent"]
            rows.append({**_base(t), "day": date.fromtimestamp(d["day_start"]), "server": server, "uptime": p, "sla": sla,
                         "state": "Not tracked" if p is None else "Met" if p >= sla else "Degraded"})
    return rows


# ── tenant overview / database / monitoring / backups ─────────────────────────

REC = [Col("tenant", "Tenant"), Col("tenant_id", "Tenant ID", "num", hidden=True), Col("slug", "Slug", "code", hidden=True)]
RECORDS = dict(date="created_at", sort="created_at", link=TENANT_LINK,
               note=f"Every row counts towards the card, soft-deleted ones included; up to {RECORD_CAP:,} most recent rows are read per tenant.")
deleted = ("Soft-deleted", lambda rows: sum(1 for r in rows if r.get("is_deleted")), "num")

register(
    Kpi("tenant.customers", "Customers", "tenants", rows=_records("customers", ["id", "customer_name", "industry", "account_status", "billing_city", "billing_state", "gst_number", "is_active", "is_deleted", "created_at", "updated_at"]),
        columns=[Col("customer_name", "Customer"), Col("industry", "Industry"), Col("account_status", "Status", "pill"), Col("billing_city", "City"), *REC[:1],
                 Col("created_at", "Created", "datetime"), Col("is_deleted", "Deleted", "bool"), Col("billing_state", "State", hidden=True), Col("gst_number", "GSTIN", "code", hidden=True),
                 Col("is_active", "Active", "bool", hidden=True), Col("updated_at", "Updated", "datetime", hidden=True), Col("id", "Record ID", "num", hidden=True), *REC[1:]],
        search=("customer_name", "industry", "billing_city", "gst_number"), status="account_status", group="industry", summary=[deleted], **RECORDS),
    Kpi("tenant.leads", "Leads", "tenants", rows=_records("leads", ["id", "lead_ref_id", "lead_title", "customer_name", "status", "priority", "lead_source", "est_value", "region", "is_deleted", "created_at"]),
        columns=[Col("lead_ref_id", "Lead", "code"), Col("lead_title", "Title"), Col("customer_name", "Customer"), Col("status", "Status", "pill"), Col("priority", "Priority"),
                 Col("est_value", "Est. value", "inr"), *REC[:1], Col("created_at", "Created", "datetime"), Col("is_deleted", "Deleted", "bool"),
                 Col("lead_source", "Source", hidden=True), Col("region", "Region", hidden=True), Col("id", "Record ID", "num", hidden=True), *REC[1:]],
        search=("lead_ref_id", "lead_title", "customer_name"), status="status", group="status", amount="est_value",
        summary=[("Est. value", lambda rows: sum(float(r.get("est_value") or 0) for r in rows), "inr"), deleted], **RECORDS),
    Kpi("tenant.tenders", "Tenders", "tenants", rows=_records("tenders", ["id", "tender_num", "tender_title", "customer_name", "tender_status", "result", "est_value", "submission_deadline", "is_deleted", "created_at"]),
        columns=[Col("tender_num", "Tender", "code"), Col("tender_title", "Title"), Col("customer_name", "Customer"), Col("tender_status", "Stage", "pill"), Col("result", "Result", "pill"),
                 Col("est_value", "Est. value", "inr"), Col("submission_deadline", "Deadline", "date"), *REC[:1], Col("created_at", "Created", "datetime"),
                 Col("is_deleted", "Deleted", "bool"), Col("id", "Record ID", "num", hidden=True), *REC[1:]],
        search=("tender_num", "tender_title", "customer_name"), status="tender_status", group="tender_status", amount="est_value",
        summary=[("Est. value", lambda rows: sum(float(r.get("est_value") or 0) for r in rows), "inr"), deleted], **RECORDS),
    Kpi("tenant.quotations", "Quotations", "tenants", rows=_records("quotations", ["id", "quotation_number", "revision_number", "subject", "status", "approval_status", "total_amount", "valid_until", "created_at"]),
        columns=[Col("quotation_number", "Quotation", "code"), Col("subject", "Subject"), Col("status", "Status", "pill"), Col("approval_status", "Approval", "pill"),
                 Col("total_amount", "Total", "inr"), Col("valid_until", "Valid until", "date"), *REC[:1], Col("created_at", "Created", "datetime"),
                 Col("revision_number", "Revision", "num", hidden=True), Col("id", "Record ID", "num", hidden=True), *REC[1:]],
        search=("quotation_number", "subject"), status="status", group="status", amount="total_amount",
        summary=[("Quoted", lambda rows: sum(float(r.get("total_amount") or 0) for r in rows), "inr")], **RECORDS),
)

DB_COLS = [Col("tenant", "Tenant"), Col("db_name", "Database", "code"), Col("engine", "Engine"), Col("server", "Server"), Col("size_mb", "Size", "mb"),
           Col("tables", "Tables", "num"), Col("connections", "Connections", "num"), Col("replication", "Replicas", "pill"),
           Col("server_ip", "Server IP", hidden=True), Col("data_mb", "Data", "mb", hidden=True), Col("index_mb", "Indexes", "mb", hidden=True),
           Col("free_mb", "Reclaimable", "mb", hidden=True), Col("max_connections", "Max connections", "num", hidden=True), Col("charset", "Character set", hidden=True),
           Col("ssl", "TLS", hidden=True), Col("encryption", "Encryption at rest", hidden=True), Col("restored", "Restored copies", "num", hidden=True),
           Col("reachable", "Database", "pill", hidden=True), Col("slug", "Slug", "code", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True)]
DB = dict(rows=_databases, columns=DB_COLS, search=("tenant", "db_name", "server"), link=TENANT_LINK,
          summary=[("Size", lambda rows: round(sum(r["size_mb"] for r in rows), 2), "mb"), ("Tables", lambda rows: sum(r["tables"] for r in rows), "num"),
                   ("Connections", lambda rows: sum(r["connections"] for r in rows), "num")])

TABLE_COLS = [Col("table", "Table", "code"), Col("tenant", "Tenant"), Col("rows", "Rows", "num"), Col("data_mb", "Data", "mb"), Col("index_mb", "Indexes", "mb"),
              Col("size_mb", "Size", "mb"), Col("free_mb", "Reclaimable", "mb"), Col("engine", "Engine", hidden=True), Col("updated_at", "Last updated", "datetime"),
              Col("db_name", "Database", "code", hidden=True), Col("slug", "Slug", "code", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True)]

register(
    Kpi("tenant.db_size", "Database size", "tenants", rows=_tables, columns=TABLE_COLS, search=("table", "tenant", "db_name"), sort="size_mb", group="tenant", amount="size_mb",
        link=TENANT_LINK, note="Table sizes from information_schema (row counts are InnoDB estimates).",
        summary=[("Size", lambda rows: round(sum(r["size_mb"] for r in rows), 2), "mb"), ("Tables", lambda rows: len(rows), "num"),
                 ("Reclaimable", lambda rows: round(sum(r["free_mb"] for r in rows), 2), "mb")]),
    Kpi("tenant.db", "Tenant database", "tenants", sort="size_mb", group="server", **DB),
    Kpi("tenant.db_engine", "Engine", "tenants", sort="tenant", desc=False, group="engine", **DB),
    Kpi("tenant.db_server", "Database server", "tenants", sort="tenant", desc=False, group="server", **DB),
    Kpi("tenant.db_replicas", "Replicas", "tenants", sort="tenant", desc=False, group="replication", **DB),
    Kpi("tenant.db_connections", "Connections", "tenants", rows=_connections, search=("tenant", "user", "host", "command", "state"), status="command", group="command",
        sort="seconds", link=TENANT_LINK, note="Open connections to the tenant database right now (statement text is not shown).",
        columns=[Col("conn_id", "Connection", "num"), Col("tenant", "Tenant"), Col("user", "DB user", "code"), Col("host", "Client"), Col("command", "Command", "pill"),
                 Col("seconds", "Time (s)", "num"), Col("state", "State"), Col("db_name", "Database", "code", hidden=True), Col("slug", "Slug", "code", hidden=True),
                 Col("tenant_id", "Tenant ID", "num", hidden=True)],
        summary=[("Connections", lambda rows: len(rows), "num"), ("Busy", lambda rows: sum(1 for r in rows if r["command"] != "Sleep"), "num")]),
    Kpi("tenant.backups", "Snapshots", "tenants", rows=_backups, sort="created_at", **BACKUPS,
        summary=[("Completed", lambda rows: sum(1 for r in rows if r["status"] == "completed"), "num"), ("Failed", lambda rows: sum(1 for r in rows if r["status"] == "failed"), "num")]),
    Kpi("tenant.last_backup", "Last backup", "tenants", rows=lambda db, ctx: [r for r in _backups(db, ctx) if r["status"] == "completed"], sort="completed_at", **BACKUPS,
        summary=[("Last snapshot", lambda rows: max((r["completed_at"] for r in rows if r["completed_at"]), default=None), "datetime")]),
    Kpi("tenant.backup_schedule", "Backup schedule", "tenants", rows=lambda db, ctx: [r for r in _backups(db, ctx) if r["frequency"]], sort="next_run_at", desc=False,
        **{**BACKUPS, "group": "frequency"}, summary=[("Next run", lambda rows: min((r["next_run_at"] for r in rows if r["next_run_at"]), default=None), "datetime")]),
    Kpi("tenant.backup_size", "Backup size", "tenants", rows=lambda db, ctx: [r for r in _backups(db, ctx) if r["status"] == "completed"], sort="size_mb", **BACKUPS,
        summary=[("Total size", lambda rows: round(sum(r["size_mb"] or 0 for r in rows), 2), "mb"), ("Files missing", lambda rows: sum(1 for r in rows if not r["available"]), "num")]),
    Kpi("tenant.restored", "Restored copies", "tenants", rows=_restored, search=("restored_db", "tenant"), sort="created_at", date="created_at", link=TENANT_LINK,
        note="Databases created by Restore (<database>_restore_<time>) on the tenant server; the live database is never replaced automatically.",
        columns=[Col("restored_db", "Restored database", "code"), Col("tenant", "Tenant"), Col("db_name", "Source database", "code"), Col("tables", "Tables", "num"),
                 Col("size_mb", "Size", "mb"), Col("created_at", "Restored", "datetime"), Col("slug", "Slug", "code", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True)],
        summary=[("Copies", lambda rows: len(rows), "num"), ("Size", lambda rows: round(sum(r["size_mb"] for r in rows), 2), "mb")]),
    Kpi("tenant.sessions", "Active sessions", "tenants", rows=_sessions, search=("full_name", "email", "tenant", "ip_address", "browser"), group="role", sort="last_active",
        date="last_active", link=TENANT_LINK,
        columns=[Col("full_name", "User"), Col("email", "E-mail"), Col("role", "Role", "pill"), Col("tenant", "Tenant"), Col("device", "Device"), Col("browser", "Browser"),
                 Col("ip_address", "IP", "code"), Col("last_active", "Last active", "datetime"), Col("login_time", "Signed in", "datetime", hidden=True),
                 Col("os", "OS", hidden=True), Col("location", "Location", hidden=True), Col("user_id", "User ID", "num", hidden=True),
                 Col("session_id", "Session ID", "num", hidden=True), Col("slug", "Slug", "code", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True)],
        summary=[("Sessions", lambda rows: len(rows), "num"), ("Users", lambda rows: len({(r["tenant_id"], r["user_id"]) for r in rows}), "num")]),
    Kpi("tenant.requests", "Requests / min", "tenants", sort="at", **TRAFFIC),
    Kpi("tenant.p95", "p95 latency", "tenants", sort="p95", **TRAFFIC),
    Kpi("tenant.error_rate", "Error rate", "tenants", sort="error_rate", **TRAFFIC),
    Kpi("tenant.apdex", "Apdex", "tenants", sort="apdex", desc=False, **TRAFFIC),
    Kpi("tenant.uptime", "Uptime · 30d", "tenants", rows=_availability, sort="day", date="day", status="state", group="state", link=TENANT_LINK,
        columns=[Col("day", "Day", "date"), Col("tenant", "Tenant"), Col("server", "Server"), Col("uptime", "Uptime", "pct"), Col("sla", "SLA", "pct"),
                 Col("state", "Result", "pill"), Col("slug", "Slug", "code", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True)],
        summary=[("Tracked days", lambda rows: sum(1 for r in rows if r["uptime"] is not None), "num"),
                 ("Degraded days", lambda rows: sum(1 for r in rows if r["state"] == "Degraded"), "num"),
                 ("Lowest day", lambda rows: min((r["uptime"] for r in rows if r["uptime"] is not None), default=None), "pct")]),
)


# ── Tenants list & parent groups ─────────────────────────────────────────────

GROUP_SQL = f"""SELECT tt.*, g.id AS group_id, g.name AS parent_group FROM ({TENANTS_SQL}) tt
                JOIN tenants t2 ON t2.id = tt.tenant_id LEFT JOIN tenant_groups g ON g.id = t2.parent_group_id"""
GROUP_COLS = [Col("tenant", "Company"), Col("parent_group", "Parent group"), Col("plan", "Plan"), Col("status", "Status", "pill"),
              Col("group_id", "Group ID", "num", hidden=True)]


def _groups(db: Session, ctx: dict) -> list[dict]:
    """Parent groups as the Tenants page lists them: tenant-scoped staff see only groups with one of their companies."""
    from sqlalchemy import text

    rows = [dict(r._mapping) for r in db.execute(text(
        "SELECT g.id, g.name, g.slug, g.industry, g.status, g.default_visibility, p.name AS plan, g.created_at, "
        "COUNT(t.id) AS companies, GROUP_CONCAT(t.id) AS ids FROM tenant_groups g LEFT JOIN plans p ON p.id = g.plan_id "
        "LEFT JOIN tenants t ON t.parent_group_id = g.id GROUP BY g.id"))]
    scope = ctx["scope"]
    out = []
    for r in rows:
        ids = {int(i) for i in (r.pop("ids") or "").split(",") if i}
        if scope is not None:
            ids &= scope
            if not ids:
                continue
        out.append({**r, "companies": len(ids)})
    return out


def _group_users(db: Session, ctx: dict) -> list[dict]:
    from app.models.tenant_hierarchy import TenantGroup
    from app.services import tenant_hierarchy as hierarchy

    tenants = _tenants(db, ctx)
    groups = {g.id: g.name for g in db.query(TenantGroup).all()}
    with ThreadPoolExecutor(max_workers=8) as pool:
        metrics = list(pool.map(hierarchy.tenant_metrics, tenants))
    return [{**_base(t), "parent_group": groups.get(t.parent_group_id), "group_id": t.parent_group_id, "status": t.status, "users": m["users"],
             "active_users": m["active_users"], "weekly_active": m["weekly_active"], "max_users": t.max_users,
             "reachable": "Reachable" if m["available"] else "Not reachable"} for t, m in zip(tenants, metrics)]


register(
    Kpi("tenants.companies", "Companies", "tenants", sql=GROUP_SQL, columns=[*GROUP_COLS[:2], *[c for c in TENANT_COLS if c.key not in ("tenant", "plan", "status")], *GROUP_COLS[2:]],
        search=(*TENANT_SEARCH, "parent_group"), status="status", date="created_at", sort="created_at", group="parent_group", link=TENANT_LINK,
        summary=[("Active", count_where("q.status = 'active'"), "num"), ("Trial", count_where("q.status = 'trial'"), "num"),
                 ("In a group", count_where("q.group_id IS NOT NULL"), "num"), ("Standalone", count_where("q.group_id IS NULL"), "num")]),
    Kpi("tenants.groups", "Parent groups", "tenants", rows=_groups, tenant=None, tenant_name=None, search=("name", "slug", "industry"), status="status", date="created_at",
        sort="companies", group="plan", link="/platform/tenant-groups/{id}",
        columns=[Col("name", "Parent group"), Col("slug", "Slug", "code"), Col("industry", "Industry"), Col("plan", "Plan"), Col("companies", "Companies", "num"),
                 Col("default_visibility", "Default visibility", "pill"), Col("status", "Status", "pill"), Col("created_at", "Created", "date"), Col("id", "Group ID", "num", hidden=True)],
        summary=[("Companies", lambda rows: sum(r["companies"] for r in rows), "num")]),
    Kpi("group.users", "Users", "tenants", rows=_group_users, search=("tenant", "slug", "parent_group"), status="status", sort="users", group="parent_group", amount="users",
        link=TENANT_LINK, description="Users of each company; the card adds up the group's companies",
        columns=[Col("tenant", "Company"), Col("parent_group", "Parent group"), Col("users", "Users", "num"), Col("active_users", "Active users", "num"),
                 Col("weekly_active", "Weekly active", "num"), Col("max_users", "User limit", "num"), Col("status", "Status", "pill"), Col("reachable", "Database", "pill"),
                 Col("slug", "Slug", "code", hidden=True), Col("group_id", "Group ID", "num", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True)],
        summary=[("Users", lambda rows: sum(r["users"] or 0 for r in rows), "num"), ("Active users", lambda rows: sum(r["active_users"] or 0 for r in rows), "num")]),
    Kpi("group.storage", "Storage", "tenants", sql=GROUP_SQL, search=(*TENANT_SEARCH, "parent_group"), status="status", sort="storage_mb", group="parent_group", amount="storage_mb",
        link=TENANT_LINK, columns=[*GROUP_COLS[:2], Col("storage_mb", "Used", "mb"), Col("storage_limit_mb", "Limit", "mb"), *GROUP_COLS[2:],
                                   *[c for c in TENANT_COLS if c.key in ("tenant_id", "slug", "admin_email", "created_at")]],
        summary=[("Used", "ROUND(SUM(q.storage_mb), 2)", "mb"), ("Allocated", "SUM(q.storage_limit_mb)", "mb")]),
    Kpi("group.mrr", "MRR", ("tenants", "billing"), sql=f"""SELECT q0.*, CASE WHEN q0.status = 'active' THEN FLOOR(COALESCE(p.price_monthly, 0)) ELSE 0 END AS mrr, p.price_monthly
                                                         FROM ({GROUP_SQL}) q0 JOIN tenants t3 ON t3.id = q0.tenant_id LEFT JOIN plans p ON p.id = t3.plan_id""",
        search=("tenant", "slug", "plan", "parent_group"), status="status", sort="mrr", group="parent_group", amount="mrr", link=TENANT_LINK,
        description="Plan price of each active company (trial, suspended and cancelled companies count as 0)",
        columns=[*GROUP_COLS[:2], Col("mrr", "MRR", "inr"), Col("price_monthly", "Plan price", "inr"), *GROUP_COLS[2:],
                 *[c for c in TENANT_COLS if c.key in ("tenant_id", "slug", "billing_status", "created_at")]],
        summary=[("MRR", "SUM(q.mrr)", "inr"), ("Paying companies", count_where("q.mrr > 0"), "num")]),
)


# ── Onboarding & provisioning ────────────────────────────────────────────────

def _onboarding(db: Session, ctx: dict) -> list[dict]:
    """The pipeline the Onboarding page shows (tenant_onboarding.pipeline), one row per tenant."""
    from app.models.tenant import Tenant
    from app.routers.platform_tenant_hierarchy_router import _workspace_url
    from app.services import tenant_onboarding as onboarding

    q = db.query(Tenant)
    if ctx["scope"] is not None:
        q = q.filter(Tenant.id.in_(ctx["scope"] or [0]))
    data = onboarding.pipeline(db, q.order_by(Tenant.created_at.desc()).all(), _workspace_url)
    enabled = {s["key"] for s in data["steps"] if s["enabled"]}
    required = [k for k in ("database", "masters") if k in enabled]
    now = datetime.now()
    rows = []
    for r in data["tenants"]:
        steps = {s["key"]: s for s in r["steps"]}
        idle = (now - r["last_activity"]).total_seconds() / 3600 if r["last_activity"] else None
        onboarding_now = r["progress"] < r["total"]
        rows.append({"tenant_id": r["id"], "tenant": r["name"], "slug": r["slug"], "status": r["status"], "created_at": r["created_at"],
                     "progress": f"{r['progress']} / {r['total']}", "done": r["progress"], "pct": round(r["progress"] / r["total"] * 100, 1) if r["total"] else 100.0,
                     "next_step": r["next_step"] if onboarding_now else "Live", "stage": "Onboarding" if onboarding_now else "Live",
                     "last_activity": r["last_activity"], "idle_hours": round(idle, 1) if idle is not None else None,
                     "stuck": onboarding_now and idle is not None and timedelta(hours=idle) > onboarding.STUCK_AFTER,
                     "live_at": r["live_at"], "days_to_live": round((r["live_at"] - r["created_at"]).total_seconds() / 86400, 1) if r["live_at"] else None,
                     "provisioned": "Provisioned" if all(steps[k]["done"] for k in required) else "Not provisioned",
                     "missing": ", ".join(s["label"] for s in r["steps"] if s["enabled"] and not s["done"]) or None})
    return rows


ONB_COLS = [Col("tenant", "Tenant"), Col("progress", "Progress"), Col("pct", "Complete", "pct"), Col("next_step", "Next step", "pill"),
            Col("last_activity", "Last step", "datetime"), Col("idle_hours", "Idle (h)", "num"), Col("created_at", "Created", "date"),
            Col("live_at", "Went live", "datetime", hidden=True), Col("days_to_live", "Days to go-live", "num", hidden=True), Col("provisioned", "Provisioning", "pill", hidden=True),
            Col("missing", "Steps not done", hidden=True), Col("stuck", "Stuck > 48 h", "bool", hidden=True), Col("status", "Tenant status", "pill", hidden=True),
            Col("stage", "Stage", hidden=True), Col("slug", "Slug", "code", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True)]
ONB = dict(columns=ONB_COLS, search=("tenant", "slug", "next_step"), status="status", date="created_at", link=TENANT_LINK)

register(
    Kpi("onboarding.in_onboarding", "In onboarding", "tenants", rows=lambda db, ctx: [r for r in _onboarding(db, ctx) if r["stage"] == "Onboarding"],
        sort="pct", desc=False, group="next_step", **ONB, summary=[("Stuck > 48 h", lambda rows: sum(1 for r in rows if r["stuck"]), "num")]),
    Kpi("onboarding.go_live", "Avg. time to go-live", "tenants", rows=lambda db, ctx: [r for r in _onboarding(db, ctx) if r["live_at"]], sort="days_to_live", group="status",
        **{**ONB, "date": "live_at", "columns": [ONB_COLS[0], Col("created_at", "Created", "datetime"), Col("live_at", "Went live", "datetime"),
                                                 Col("days_to_live", "Days to go-live", "num"), *[c for c in ONB_COLS if c.key in ("progress", "next_step", "status", "slug", "tenant_id")]]},
        summary=[("Live tenants", lambda rows: len(rows), "num"),
                 ("Avg. days", lambda rows: round(sum(r["days_to_live"] for r in rows) / len(rows), 1) if rows else None, "num")]),
    Kpi("onboarding.provisioning", "Provisioning success", "tenants", rows=_onboarding, sort="created_at", group="provisioned",
        **{**ONB, "columns": [*ONB_COLS[:1], Col("provisioned", "Provisioning", "pill"), Col("missing", "Steps not done"), *ONB_COLS[1:3], Col("created_at", "Created", "date"),
                              *[c for c in ONB_COLS if c.key in ("next_step", "status", "slug", "tenant_id")]]},
        summary=[("Provisioned", lambda rows: sum(1 for r in rows if r["provisioned"] == "Provisioned"), "num"),
                 ("Success", lambda rows: round(sum(1 for r in rows if r["provisioned"] == "Provisioned") / len(rows) * 100, 1) if rows else None, "pct")]),
    Kpi("onboarding.stuck", "Stuck > 48 h", "tenants", rows=lambda db, ctx: [r for r in _onboarding(db, ctx) if r["stuck"]], sort="idle_hours", group="next_step", **ONB,
        description="Tenants still onboarding whose last completed step is more than 48 hours old"),
)


# ── Customer success ─────────────────────────────────────────────────────────

def _health(db: Session, ctx: dict) -> list[dict]:
    from app.services import platform_customer_success as cs

    if cs.ensure_schema():
        db.rollback()
    return [{"tenant_id": r["id"], "tenant": r["name"], "slug": r["slug"], "status": r["status"], "health": r["health"], "risk": r["risk"] or "Not scored",
             "usage": r["factors"].get("usage"), "adoption": r["factors"].get("adoption"), "support": r["factors"].get("support"), "billing": r["factors"].get("billing"),
             "nps": r["factors"].get("nps"), "nps_note": r["notes"].get("nps"), "arr": r["arr"], "renewal": r["renewal"], "renewal_kind": r["renewal_kind"],
             "days_since_signin": r["days_since_signin"], "seats": r["seats"], "max_users": r["max_users"], "missing": ", ".join(r["missing"]) or None,
             "data_error": r["data_error"]} for r in cs.health_rows(db, ctx["scope"])]


CS_COLS = [Col("tenant", "Tenant"), Col("health", "Health", "num"), Col("risk", "Churn risk", "pill"), Col("usage", "Usage", "num"), Col("adoption", "Adoption", "num"),
           Col("support", "Support", "num"), Col("arr", "ARR", "inr"), Col("renewal", "Renewal", "date"),
           Col("billing", "Billing", "num", hidden=True), Col("nps", "NPS", "num", hidden=True), Col("renewal_kind", "Renewal type", hidden=True),
           Col("days_since_signin", "Days since sign-in", "num", hidden=True), Col("seats", "Active users", "num", hidden=True), Col("max_users", "User limit", "num", hidden=True),
           Col("missing", "Factors not measured", hidden=True), Col("data_error", "Data issue", hidden=True), Col("status", "Tenant status", "pill", hidden=True),
           Col("slug", "Slug", "code", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True)]
CS = dict(columns=CS_COLS, search=("tenant", "slug"), status="risk", group="risk", link=TENANT_LINK)


def _within_90(r: dict) -> bool:
    today = date.today()
    return bool(r["renewal"]) and today <= date.fromisoformat(r["renewal"]) <= today + timedelta(days=90)


register(
    Kpi("cs.avg_health", "Avg health", "tenants", rows=_health, sort="health", desc=False, **CS,
        summary=[("Avg health", lambda rows: (lambda s: round(sum(s) / len(s)) if s else None)([r["health"] for r in rows if r["health"] is not None]), "num"),
                 ("Not scored", lambda rows: sum(1 for r in rows if r["health"] is None), "num")]),
    Kpi("cs.at_risk", "At-risk tenants", "tenants", rows=lambda db, ctx: [r for r in _health(db, ctx) if r["risk"] == "High"], sort="health", desc=False, **CS,
        description="Health below 65", summary=[("ARR", lambda rows: sum(float(r["arr"]) for r in rows), "inr")]),
    Kpi("cs.arr_at_risk", "ARR at risk", ("tenants", "billing"), rows=lambda db, ctx: [r for r in _health(db, ctx) if r["health"] is not None and r["risk"] != "Low"],
        sort="arr", amount="arr", **CS, description="ARR of scored tenants with medium or high churn risk (health below 78)",
        summary=[("ARR at risk", lambda rows: sum(float(r["arr"]) for r in rows), "inr")]),
    Kpi("cs.nps", "Net promoter score", "tenants", rows=_health, sort="nps", **{**CS, "columns": [*CS_COLS[:3], Col("nps", "NPS", "num"), Col("nps_note", "NPS source"), *CS_COLS[3:]]},
        note="No NPS survey data is collected yet, so every tenant shows no score."),
    Kpi("cs.renewals", "Renewals · 90 days", "tenants", rows=lambda db, ctx: [r for r in _health(db, ctx) if _within_90(r)], sort="renewal", desc=False,
        **{**CS, "group": "renewal_kind", "date": "renewal", "columns": [*CS_COLS[:1], Col("renewal", "Renewal", "date"), Col("renewal_kind", "Renewal type", "pill"),
                                                                         *[c for c in CS_COLS if c.key not in ("tenant", "renewal", "renewal_kind")]]},
        summary=[("Trial ends", lambda rows: sum(1 for r in rows if r["renewal_kind"] == "trial ends"), "num"), ("ARR", lambda rows: sum(float(r["arr"]) for r in rows), "inr")]),
)


# ── Announcements & maintenance ──────────────────────────────────────────────

def _announcements(db: Session, ctx: dict) -> list[dict]:
    from app.services import platform_announcements as ann

    return [{**a, "failed": len(a["failed"])} for a in ann.announcements_page(db, ctx["scope"], 0, 100000)["items"] if a["live"]]


def _reach(db: Session, ctx: dict) -> list[dict]:
    """Per tenant: live announcements it receives and its reach (the largest recipient count, as the KPI counts users)."""
    from sqlalchemy import func

    from app.models.platform_support import PlatformAnnouncement, PlatformAnnouncementRead, PlatformAnnouncementTenant
    from app.models.tenant import Tenant
    from app.services import platform_announcements as ann

    q = db.query(PlatformAnnouncement.id).filter(ann._live(date.today()))
    scope = ann._in_scope(ctx["scope"])
    if scope is not None:
        q = q.filter(scope)
    ids = [r[0] for r in q.all()]
    if not ids:
        return []
    reads = dict(db.query(PlatformAnnouncementRead.tenant_id, func.count(PlatformAnnouncementRead.id))
                 .filter(PlatformAnnouncementRead.announcement_id.in_(ids)).group_by(PlatformAnnouncementRead.tenant_id).all())
    rows = (db.query(PlatformAnnouncementTenant.tenant_id, Tenant.name, Tenant.slug, Tenant.status, func.max(PlatformAnnouncementTenant.recipients),
                     func.sum(PlatformAnnouncementTenant.recipients), func.count(PlatformAnnouncementTenant.id))
            .join(Tenant, Tenant.id == PlatformAnnouncementTenant.tenant_id).filter(PlatformAnnouncementTenant.announcement_id.in_(ids))
            .group_by(PlatformAnnouncementTenant.tenant_id, Tenant.name, Tenant.slug, Tenant.status).all())
    return [{"tenant_id": tid, "tenant": name, "slug": slug, "status": status, "users": int(users or 0), "deliveries": int(sent or 0), "announcements": int(n),
             "reads": int(reads.get(tid, 0)), "read_rate": round(min(100.0, reads.get(tid, 0) / sent * 100), 1) if sent else None}
            for tid, name, slug, status, users, sent, n in rows]


def _maintenance(db: Session, ctx: dict) -> list[dict]:
    from app.models.platform_change import PlatformChange
    from app.services import platform_announcements as ann
    from app.services import platform_changes as changes

    now = datetime.utcnow()
    q = ann._maintenance_query(db).filter(PlatformChange.status.in_(changes.ACTIVE), PlatformChange.executed_at.is_(None),
                                          or_(PlatformChange.ends_at > now, and_(PlatformChange.ends_at.is_(None), PlatformChange.window_start >= date.today())))
    return [{"id": c.id, "code": changes.code(c), "title": c.description, "when": ann._when(c), "scope": c.scope, "status": ann.maintenance_status(c, now),
             "window_start": c.window_start, "starts_at": c.starts_at, "ends_at": c.ends_at, "risk": c.risk, "owner": c.owner, "created_at": c.created_at}
            for c in q.order_by(PlatformChange.window_start).all()]


ANN_COLS = [Col("title", "Title"), Col("type", "Type", "pill"), Col("audience", "Audience"), Col("posted_at", "Posted", "datetime"), Col("until", "Until", "date"),
            Col("recipients", "Users", "num"), Col("reads", "Reads", "num"), Col("read_rate", "Read rate", "pct"),
            Col("message", "Message", hidden=True), Col("posted_by", "Posted by", hidden=True), Col("tenants", "Tenants", "num", hidden=True),
            Col("failed", "Unreachable tenants", "num", hidden=True), Col("id", "Announcement ID", "num", hidden=True)]
ANN = dict(rows=_announcements, columns=ANN_COLS, tenant=None, tenant_name=None, search=("title", "message", "audience", "posted_by"), status="type", date="posted_at",
           group="type", link="/platform/announcements")

register(
    Kpi("announcements.live", "Live announcements", "tenants", sort="posted_at", **ANN,
        summary=[("Users", lambda rows: sum(r["recipients"] for r in rows), "num"), ("Reads", lambda rows: sum(r["reads"] for r in rows), "num")]),
    Kpi("announcements.users_reached", "Users reached", "tenants", rows=_reach, search=("tenant", "slug"), status="status", sort="users", link=TENANT_LINK,
        description="Each targeted tenant's users counted once (the largest reach of its live announcements)",
        columns=[Col("tenant", "Tenant"), Col("users", "Users reached", "num"), Col("announcements", "Live announcements", "num"), Col("deliveries", "Deliveries", "num"),
                 Col("reads", "Reads", "num"), Col("read_rate", "Read rate", "pct"), Col("status", "Status", "pill"), Col("slug", "Slug", "code", hidden=True),
                 Col("tenant_id", "Tenant ID", "num", hidden=True)],
        summary=[("Users reached", lambda rows: sum(r["users"] for r in rows), "num"), ("Tenants", lambda rows: len(rows), "num")]),
    Kpi("announcements.read_rate", "Avg read rate", "tenants", sort="read_rate", desc=False, **ANN,
        summary=[("Avg read rate", lambda rows: (lambda s: round(sum(s) / len(s), 1) if s else None)([r["read_rate"] for r in rows if r["read_rate"] is not None]), "pct"),
                 ("Never read", lambda rows: sum(1 for r in rows if r["recipients"] and not r["reads"]), "num")]),
    Kpi("announcements.maintenance", "Upcoming maintenance", ("tenants", "changes"), rows=_maintenance, tenant=None, tenant_name=None, search=("code", "title", "scope", "owner"),
        status="status", date="window_start", sort="window_start", desc=False, group="scope", link="/platform/changes",
        columns=[Col("code", "Change", "code"), Col("title", "Window"), Col("when", "When"), Col("scope", "Scope"), Col("status", "Status", "pill"), Col("risk", "Risk", "pill"),
                 Col("window_start", "Date", "date", hidden=True), Col("starts_at", "Starts (UTC)", "datetime", hidden=True), Col("ends_at", "Ends (UTC)", "datetime", hidden=True),
                 Col("owner", "Owner", hidden=True), Col("created_at", "Requested", "datetime", hidden=True), Col("id", "Change ID", "num", hidden=True)]),
)


# ── Subscriptions ────────────────────────────────────────────────────────────

SUBS = dict(columns=SUB_COLS, search=("tenant", "slug", "admin_email"), status="billing_status", date="renewal_date", sort="renewal_date", desc=False,
            group="billing_status", link=TENANT_LINK)
register(*[Kpi(f"subscriptions.{state}", title, ("tenants", "billing"), rows=(lambda s: lambda db, ctx: [r for r in _subscriptions(db, ctx) if r["state"] == s])(state), **SUBS)
           for state, title in (("active", "Active subscriptions"), ("trial", "Trials"), ("expired", "Expired subscriptions"), ("renewing", "Renewals due"))])
