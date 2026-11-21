"""Data & infrastructure KPIs: Databases, Monitoring, Documents & Storage, Environments & Sandboxes, Jobs & Queues,
Regions & Capacity, Data Export & Migration and Usage Monitoring."""

from __future__ import annotations

import json
import logging
import time
from collections import Counter
from datetime import datetime, timedelta

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.services.platform_kpi import Col, Kpi, register
from app.services.platform_kpi_specs.common import TENANT_COLS, TENANT_LINK, TENANT_SEARCH, TENANTS_SQL, count_where
from app.services.platform_kpi_specs.core import _incidents_sql, _tenants

logger = logging.getLogger(__name__)
NOT_TENANT = dict(tenant=None, tenant_name=None)
_sum = lambda key: lambda rows: round(sum(r.get(key) or 0 for r in rows), 2)
_count = lambda cond: lambda rows: sum(1 for r in rows if cond(r))


# ── Databases ────────────────────────────────────────────────────────────────
# Same probe + placement as GET /databases (platform_database_router.placement), so the popups match the cards.

def _placement(db: Session, ctx: dict) -> tuple[list[dict], list[dict]]:
    from app.routers.platform_database_router import placement
    from app.services import platform_databases as dbs

    servers, host_of, _, rows = placement(db)
    by_name = {s["name"]: s for s in servers}
    out = []
    for r in rows:
        if ctx["scope"] is not None and r["id"] not in ctx["scope"]:
            continue
        s = by_name.get(r["server"]) or {}
        version = r["migration_version"]
        out.append({"tenant_id": r["id"], "tenant": r["name"], "slug": r["slug"], "status": r["status"], "db_name": r["db_name"],
                    "server": r["server"], "host": f"{s['host']}:{s['port']}" if s else None, "region": s.get("region"),
                    "health": "Not found" if not s else "Healthy" if s.get("reachable") else "Server unreachable",
                    "size_mb": r["size_mb"], "connections": r["connections"], "qps": r["qps"], "migration_version": version,
                    "schema": "Not found" if not s else "Current" if version == dbs.LATEST_VERSION else "Behind",
                    "server_connections": s.get("connections"), "server_max_connections": s.get("max_connections"), "latency_ms": s.get("latency_ms")})
    return servers, out


def _db_tenants(db: Session, ctx: dict) -> list[dict]:
    return _placement(db, ctx)[1]


def _db_servers(db: Session, ctx: dict) -> list[dict]:
    servers, tenants = _placement(db, ctx)
    out = []
    for s in servers:
        m = s.get("metrics") or {}
        repl = s.get("replication") or {}
        out.append({"server": s["name"], "host": f"{s['host']}:{s['port']}", "region": s.get("region"), "role": s.get("role") or "Unknown",
                    "health": "Healthy" if s["reachable"] else "Unreachable", "version": s.get("version"), "error": s.get("error"),
                    "connections": s.get("connections"), "max_connections": s.get("max_connections"),
                    "connections_pct": round(s["connections"] / s["max_connections"] * 100, 1) if s.get("connections") is not None and s.get("max_connections") else None,
                    "latency_ms": s.get("latency_ms"), "tenants": sum(1 for t in tenants if t["server"] == s["name"]),
                    "size_mb": round(sum(d.get("size_mb") or 0 for d in (s.get("databases") or {}).values()), 2),
                    "cpu": m.get("cpu_percent") if m.get("available") else None, "memory": m.get("memory_percent") if m.get("available") else None,
                    "disk": m.get("disk_percent") if m.get("available") else None, "replica_of": s.get("replica_of"),
                    "replicas": ", ".join(s.get("replica_names") or []) or None,
                    "lag_seconds": repl.get("lag_seconds") if repl.get("role") == "Replica" else None,
                    "replication_error": repl.get("error") or repl.get("last_error"), "read_only": s.get("read_only"), "log_bin": s.get("log_bin"),
                    "buffer_pool_mb": s.get("buffer_pool_mb"), "uptime_seconds": s.get("uptime_seconds")})
    return out


DB_TENANT_COLS = [Col("tenant", "Tenant"), Col("db_name", "Database", "code"), Col("server", "Server"), Col("health", "Health", "pill"),
                  Col("size_mb", "Size", "mb"), Col("connections", "Connections", "num"), Col("qps", "Queries / s", "num"),
                  Col("migration_version", "Schema version", "code"), Col("schema", "Schema", "pill"),
                  Col("host", "Host", "code", hidden=True), Col("region", "Region", hidden=True), Col("status", "Tenant status", "pill", hidden=True),
                  Col("slug", "Slug", "code", hidden=True), Col("server_connections", "Server connections", "num", hidden=True),
                  Col("server_max_connections", "Server max connections", "num", hidden=True), Col("latency_ms", "Server latency", "ms", hidden=True),
                  Col("tenant_id", "Tenant ID", "num", hidden=True)]
DB_TENANTS = dict(rows=_db_tenants, columns=DB_TENANT_COLS, search=("tenant", "db_name", "server", "slug"), status="health", group="server", link=TENANT_LINK)


def _server_totals(rows: list[dict], key: str) -> int:
    return sum({r["server"]: r.get(key) or 0 for r in rows if r.get("server")}.values())


DB_SERVER_COLS = [Col("server", "Server"), Col("host", "Host", "code"), Col("region", "Region"), Col("role", "Role", "pill"), Col("health", "Health", "pill"),
                  Col("connections", "Connections", "num"), Col("max_connections", "Max", "num"), Col("tenants", "Tenant DBs", "num"),
                  Col("size_mb", "Size", "mb"), Col("lag_seconds", "Lag (s)", "num"),
                  Col("version", "Engine", hidden=True), Col("connections_pct", "Connections used", "pct", hidden=True), Col("latency_ms", "Latency", "ms", hidden=True),
                  Col("cpu", "CPU", "pct", hidden=True), Col("memory", "RAM", "pct", hidden=True), Col("disk", "Disk", "pct", hidden=True),
                  Col("replica_of", "Replicating from", hidden=True), Col("replicas", "Replicas", hidden=True), Col("replication_error", "Replication error", hidden=True),
                  Col("read_only", "Read-only", "bool", hidden=True), Col("log_bin", "Binary log", "bool", hidden=True),
                  Col("buffer_pool_mb", "Buffer pool", "mb", hidden=True), Col("uptime_seconds", "Uptime (s)", "num", hidden=True), Col("error", "Error", hidden=True)]
DB_SERVERS = dict(rows=_db_servers, columns=DB_SERVER_COLS, **NOT_TENANT, search=("server", "host", "region"), status="health", group="role", link="/platform/databases")

DB_AUDIT_SQL = """SELECT l.id, l.action, l.entity_name AS server, l.description, l.created_at, l.ip_address, a.full_name AS admin,
                         CASE l.action WHEN 'database.failover' THEN 'Failover' WHEN 'database.failover_drill' THEN 'Failover drill' ELSE 'Restore drill' END AS kind
                  FROM platform_audit_logs l LEFT JOIN super_admins a ON a.id = l.super_admin_id
                  WHERE l.action IN ('database.failover', 'database.failover_drill', 'database.restore_drill') AND l.created_at >= UTC_TIMESTAMP() - INTERVAL 90 DAY"""

register(
    Kpi("databases.clusters", "Clusters", "databases", sort="tenants", **DB_SERVERS,
        summary=[("Reachable", _count(lambda r: r["health"] == "Healthy"), "num"), ("Tenant databases", _sum("tenants"), "num")]),
    Kpi("databases.total_size", "Total size", "databases", sort="size_mb", amount="size_mb", **DB_TENANTS,
        summary=[("Tenant databases", _sum("size_mb"), "mb"), ("Not found on a server", _count(lambda r: r["health"] == "Not found"), "num")]),
    Kpi("databases.connections", "Connections", "databases", sort="connections", **DB_TENANTS,
        summary=[("Server connections", lambda rows: _server_totals(rows, "server_connections"), "num"),
                 ("Max connections", lambda rows: _server_totals(rows, "server_max_connections"), "num"),
                 ("Tenant connections", _sum("connections"), "num")],
        description="Every tenant database with its server, health and open connections; server-wide totals in the summary"),
    Kpi("databases.replication_lag", "Max replication lag", "databases", sort="lag_seconds", **DB_SERVERS,
        note="Lag is measured on replica servers only. “—” means no server in the inventory is replicating – every server is listed with its replication role.",
        summary=[("Replicas", _count(lambda r: r["role"] == "Replica"), "num"),
                 ("Max lag (s)", lambda rows: max((r["lag_seconds"] for r in rows if r["lag_seconds"] is not None), default=None), "num")]),
    Kpi("databases.failovers", "Failovers · 90d", "databases", sql=DB_AUDIT_SQL, **NOT_TENANT, link="/platform/databases",
        columns=[Col("created_at", "When", "datetime"), Col("kind", "Event", "pill"), Col("server", "Server"), Col("admin", "By"), Col("description", "Detail"),
                 Col("action", "Action", "code", hidden=True), Col("ip_address", "IP", "code", hidden=True), Col("id", "Audit ID", "num", hidden=True)],
        search=("server", "description", "admin"), status="kind", date="created_at", sort="created_at", group="kind",
        summary=[("Failovers", count_where("q.action = 'database.failover'"), "num"), ("Drills", count_where("q.action <> 'database.failover'"), "num")],
        note="The card counts failovers; failover and restore drills of the same period are listed alongside them."),
    Kpi("databases.schema_version", "Schema version", "databases", sort="schema", desc=False, **{**DB_TENANTS, "status": "schema", "group": "schema"},
        summary=[("Behind", _count(lambda r: r["schema"] == "Behind"), "num"), ("Current", _count(lambda r: r["schema"] == "Current"), "num")]),
)


# ── Monitoring ───────────────────────────────────────────────────────────────
# The page's defaults (All services, 1 h): API request histograms, every inventory server, all roles for saturation.

def _windows(db: Session, ctx: dict) -> list[dict]:
    from app.services import platform_controls as controls
    from app.services import platform_monitoring as monitor

    target = float(controls.value(db, "sloLat") or 300)
    minutes = monitor.RANGES["1h"]
    end = int(time.time() // 60)
    start = end - minutes + 1
    data = monitor._minutes("api", start, end)
    rows = []
    for p in range(monitor.POINTS):
        first, last = start + p * minutes // monitor.POINTS, start + (p + 1) * minutes // monitor.POINTS - 1
        hist, total, errors = Counter(), 0, 0
        for m in range(first, last + 1):
            if m in data:
                hist.update(data[m]["hist"]); total += data[m]["requests"]; errors += data[m]["errors"]
        if total:
            rows.append({"at": datetime.utcfromtimestamp((last + 1) * 60), "requests": total, "errors": errors,
                         "error_rate": round(errors / total * 100, 2), "p50": monitor.percentile(hist, .5), "p95": monitor.percentile(hist, .95),
                         "p99": monitor.percentile(hist, .99), "apdex": monitor.apdex(hist, target), "target_ms": target,
                         "band": "Satisfied" if (monitor.percentile(hist, .95) or 0) <= target else "Tolerating" if (monitor.percentile(hist, .95) or 0) <= 4 * target else "Frustrated"})
    return rows


WINDOW_COLS = [Col("at", "Window ending", "datetime"), Col("requests", "Requests", "num"), Col("p50", "p50", "ms"), Col("p95", "p95", "ms"),
               Col("p99", "p99", "ms"), Col("apdex", "Apdex", "num"), Col("errors", "Errors", "num"), Col("error_rate", "Error rate", "pct"),
               Col("band", "p95 vs target", "pill", hidden=True), Col("target_ms", "Apdex target", "ms", hidden=True)]
WINDOWS = dict(rows=_windows, columns=WINDOW_COLS, **NOT_TENANT, date="at", status="band", group="band", link="/platform/monitoring",
               note="API requests of the last hour in per-minute histograms, grouped into windows (windows without traffic are left out).",
               summary=[("Requests · 1 h", _sum("requests"), "num"), ("Worst p95", lambda rows: max((r["p95"] for r in rows if r["p95"] is not None), default=None), "ms"),
                        ("Lowest Apdex", lambda rows: min((r["apdex"] for r in rows if r["apdex"] is not None), default=None), "num")])


def _uptime_rows(db: Session, ctx: dict) -> list[dict]:
    from app.services import platform_controls as controls
    from app.services import platform_infrastructure as infrastructure
    from app.services import platform_uptime

    inventory = infrastructure.server_inventory()
    uptime = platform_uptime.uptime([s["name"] for s in inventory])
    states = {i["server"]: i["state"] for i in platform_uptime.open_incidents()}
    tracked = uptime.get("tracked_minutes") or 0
    slo = float(controls.value(db, "sloAvail") or 99.9)
    rows = []
    for s in inventory:
        pct = uptime["servers"].get(s["name"])
        roles = ", ".join(r for r, on in (("Application", s.get("local") or s.get("agent_url")), ("Database", s.get("db_host"))) if on)
        rows.append({"server": s["name"], "region": s.get("region") or infrastructure.DEFAULT_REGION, "roles": roles or "—", "uptime_30d": pct,
                     "tracked_min": tracked, "downtime_min": round((100 - pct) / 100 * tracked) if pct is not None else None,
                     "allowed_min": round((100 - slo) / 100 * tracked, 1), "slo": slo, "state": states.get(s["name"], "Online" if pct is not None else "Not tracked")})
    return rows


UPTIME_COLS = [Col("server", "Server"), Col("region", "Region"), Col("roles", "Roles"), Col("uptime_30d", "Uptime · 30d", "pct"),
               Col("downtime_min", "Downtime (min)", "num"), Col("allowed_min", "Budget (min)", "num"), Col("state", "Now", "pill"),
               Col("tracked_min", "Tracked (min)", "num", hidden=True), Col("slo", "SLO", "pct", hidden=True)]


def _error_budget(db: Session, ctx: dict) -> list[dict]:
    rows = [{"kind": "Server downtime", "at": None, "item": u["server"], "status": u["state"], "severity": None, "requests": None, "errors": None,
             "error_rate": None, "minutes": u["downtime_min"], "detail": f"{u['uptime_30d']}% up · budget {u['allowed_min']} min" if u["uptime_30d"] is not None else "Not tracked"}
            for u in _uptime_rows(db, ctx)]
    rows += [{"kind": "Error window", "at": w["at"], "item": f"{w['errors']} failed of {w['requests']} requests", "status": None, "severity": None,
              "requests": w["requests"], "errors": w["errors"], "error_rate": w["error_rate"], "minutes": None, "detail": None}
             for w in _windows(db, ctx) if w["errors"]]
    for i in db.execute(text(_incidents_sql("i.started_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY"))).mappings():
        rows.append({"kind": "Incident", "at": i["started_at"], "item": f"{i['code']} · {i['title']}", "status": i["status"], "severity": i["severity"],
                     "requests": None, "errors": None, "error_rate": None, "minutes": i["duration_min"], "detail": i["detail"]})
    return rows


register(
    Kpi("monitoring.availability", "Availability · 30d", "monitoring", rows=_uptime_rows, columns=UPTIME_COLS, **NOT_TENANT, search=("server", "region"),
        status="state", group="region", sort="uptime_30d", desc=False, link="/platform/infrastructure",
        note="Every server of the inventory, measured by the per-minute uptime probe over the tracked part of the last 30 days. The card averages them.",
        summary=[("Average uptime", lambda rows: round(sum(r["uptime_30d"] for r in rows if r["uptime_30d"] is not None) / max(1, sum(1 for r in rows if r["uptime_30d"] is not None)), 2) if any(r["uptime_30d"] is not None for r in rows) else None, "pct"),
                 ("Downtime (min)", _sum("downtime_min"), "num")]),
    Kpi("monitoring.p95", "p95 latency", "monitoring", sort="p95", **WINDOWS),
    Kpi("monitoring.apdex", "Apdex", "monitoring", sort="apdex", desc=False, **WINDOWS),
    Kpi("monitoring.error_budget", "Error budget left", "monitoring", rows=_error_budget, **NOT_TENANT, link="/platform/monitoring",
        columns=[Col("kind", "Type", "pill"), Col("at", "When", "datetime"), Col("item", "Item"), Col("minutes", "Minutes", "num"), Col("errors", "Errors", "num"),
                 Col("error_rate", "Error rate", "pct"), Col("severity", "Severity", "pill"), Col("status", "Status", "pill"),
                 Col("requests", "Requests", "num", hidden=True), Col("detail", "Detail", hidden=True)],
        search=("item", "detail"), status="kind", date="at", group="kind", sort="at",
        note="The budget is spent by server downtime against the availability SLO; failed-request windows of the last hour and incidents of the last 30 days are listed with it.",
        summary=[("Downtime (min)", lambda rows: sum(r["minutes"] or 0 for r in rows if r["kind"] == "Server downtime"), "num"),
                 ("Failed requests · 1 h", _sum("errors"), "num"), ("Incidents · 30 d", _count(lambda r: r["kind"] == "Incident"), "num")]),
    Kpi("monitoring.saturation", "Saturation", "monitoring", **NOT_TENANT, link="/platform/infrastructure",
        sql="""SELECT s.server, s.roles, ROUND(AVG(s.cpu), 1) AS avg_cpu, ROUND(MAX(s.cpu), 1) AS peak_cpu, ROUND(AVG(s.memory), 1) AS avg_memory,
                      ROUND(AVG(s.disk), 1) AS avg_disk, COUNT(*) AS samples, FROM_UNIXTIME(MAX(s.minute) * 60) AS last_sample
               FROM platform_resource_samples s WHERE s.minute > FLOOR(UNIX_TIMESTAMP() / 60) - 60 AND s.cpu IS NOT NULL GROUP BY s.server, s.roles""",
        columns=[Col("server", "Server"), Col("roles", "Roles"), Col("avg_cpu", "Avg CPU", "pct"), Col("peak_cpu", "Peak CPU", "pct"), Col("avg_memory", "Avg RAM", "pct"),
                 Col("avg_disk", "Avg disk", "pct"), Col("samples", "Samples", "num"), Col("last_sample", "Last sample", "datetime")],
        search=("server", "roles"), group="roles", sort="avg_cpu", date="last_sample",
        summary=[("Busiest server CPU", "MAX(q.avg_cpu)", "pct"), ("Peak CPU", "MAX(q.peak_cpu)", "pct")],
        note="Average CPU per server over the last hour from the uptime probe samples; the card shows the busiest. With no samples yet the card reads this server live."),
)


# ── Documents & Storage ──────────────────────────────────────────────────────

def _files_sql(where: str = "1=1") -> str:
    from app.services.platform_storage import HOT_DAYS

    return f"""SELECT * FROM (SELECT f.id, f.tenant_slug AS slug, t.id AS tenant_id, t.name AS tenant, f.name, UPPER(COALESCE(NULLIF(f.ext, ''), 'none')) AS ext,
                      f.root, f.rel_path, f.size_bytes, f.original_bytes, f.shared_bytes, f.sha256, f.uploaded_at, f.last_accessed_at, f.owner,
                      CASE WHEN f.cold THEN 'Cold' WHEN GREATEST(COALESCE(f.last_accessed_at, '1000-01-01'), COALESCE(f.uploaded_at, '1000-01-01'))
                           >= UTC_TIMESTAMP() - INTERVAL {int(HOT_DAYS)} DAY THEN 'Hot' ELSE 'Warm' END AS tier,
                      CASE WHEN f.quarantined THEN 'Quarantined' WHEN f.scan_status = 'clean' THEN 'Verified' WHEN f.scan_status = 'released' THEN 'Released'
                           WHEN f.scan_status = 'infected' THEN 'Infected' WHEN f.scan_status = 'error' THEN 'Scan error' ELSE 'Not scanned' END AS scan,
                      f.scan_detail, f.scanned_at, f.quarantined, f.quarantine_reason, f.quarantined_at, f.links, f.deleted_links,
                      CASE WHEN f.links > 0 THEN 'Linked' WHEN f.deleted_links > 0 THEN 'In recycle bin' ELSE 'Orphan' END AS linkage
               FROM platform_storage_files f JOIN tenants t ON t.slug = f.tenant_slug) ff WHERE {where}"""


FILE_COLS = [Col("name", "File"), Col("tenant", "Tenant"), Col("ext", "Type", "code"), Col("size_bytes", "Size", "bytes"), Col("tier", "Tier", "pill"),
             Col("scan", "Scan", "pill"), Col("linkage", "Links", "pill"), Col("uploaded_at", "Uploaded", "datetime"),
             Col("last_accessed_at", "Last opened", "datetime", hidden=True), Col("owner", "Owner", hidden=True), Col("root", "Root", hidden=True),
             Col("rel_path", "Path", "code", hidden=True), Col("original_bytes", "Uploaded size", "bytes", hidden=True), Col("shared_bytes", "Shared on disk", "bytes", hidden=True),
             Col("sha256", "SHA-256", "code", hidden=True), Col("scan_detail", "Scan detail", hidden=True), Col("scanned_at", "Scanned", "datetime", hidden=True),
             Col("quarantine_reason", "Quarantine reason", hidden=True), Col("quarantined_at", "Quarantined", "datetime", hidden=True),
             Col("links", "Live references", "num", hidden=True), Col("deleted_links", "Deleted references", "num", hidden=True),
             Col("slug", "Tenant slug", "code", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True), Col("id", "File ID", "num", hidden=True)]
FILES = dict(columns=FILE_COLS, search=("name", "tenant", "slug", "owner", "ext"), status="scan", date="uploaded_at", link=TENANT_LINK)
LIVE = "ff.quarantined = 0"
SIZE = [("Files", "COUNT(*)", "num"), ("Size", "SUM(q.size_bytes)", "bytes")]

register(
    Kpi("storage.total", "Total stored", "storage", sql=_files_sql(LIVE), sort="size_bytes", group="tier", amount="size_bytes", **FILES, summary=SIZE),
    Kpi("storage.files", "Files", "storage", sql=_files_sql(LIVE), sort="uploaded_at", group="ext", **FILES, summary=SIZE),
    Kpi("storage.growth", "Growth · 30d", "storage", sql=_files_sql(f"{LIVE} AND (ff.uploaded_at IS NULL OR ff.uploaded_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY)"),
        sort="uploaded_at", group="tenant", amount="size_bytes", **FILES, summary=[("Files added", "COUNT(*)", "num"), ("Bytes added", "SUM(q.size_bytes)", "bytes")],
        description="Files uploaded in the last 30 days – the growth against what was stored before"),
    Kpi("storage.dedup", "Dedup savings", "storage", sort="shared_bytes", **{**FILES, "status": "dedup", "columns": [Col("dedup", "Dedup", "pill"), Col("copies", "Copies", "num"), *FILE_COLS]},
        sql=f"""SELECT * FROM (SELECT d.*, CASE WHEN d.shared_bytes > 0 THEN 'Shared on disk' ELSE 'Identical upload' END AS dedup FROM (
                    SELECT x.*, CASE WHEN x.sha256 IS NULL THEN 1 ELSE COUNT(*) OVER (PARTITION BY x.slug, x.sha256) END AS copies FROM ({_files_sql(LIVE)}) x) d) dd
                WHERE dd.shared_bytes > 0 OR dd.copies > 1""",
        group="dedup", summary=[("Saved on disk", "SUM(q.shared_bytes)", "bytes"), ("Files", "COUNT(*)", "num")],
        note="Files whose content is shared on disk with another copy (the saving), and identical uploads not yet shared (possible savings)."),
    Kpi("storage.quarantined", "Quarantined", "storage", sql=_files_sql("ff.quarantined = 1"), sort="quarantined_at", group="tenant", **FILES,
        summary=[("Files", "COUNT(*)", "num"), ("Size", "SUM(q.size_bytes)", "bytes")]),
    Kpi("storage.orphaned", "Orphaned files", "storage", sql=_files_sql(f"{LIVE} AND ff.links = 0 AND ff.deleted_links = 0"), sort="size_bytes", group="tenant",
        amount="size_bytes", **FILES, summary=SIZE,
        note="Files no live or deleted tenant record refers to, as of the last Scan for orphans (the card shows “—” until a scan has run)."),
    Kpi("storage.cold", "Cold tier", "storage", sql=_files_sql(LIVE), sort="last_accessed_at", desc=False, group="tier", amount="size_bytes", **FILES,
        summary=[("Cold files", count_where("q.tier = 'Cold'"), "num"), ("Cold bytes", "SUM(CASE WHEN q.tier = 'Cold' THEN q.size_bytes ELSE 0 END)", "bytes"),
                 ("Cold %", "ROUND(SUM(q.tier = 'Cold') / NULLIF(COUNT(*), 0) * 100, 1)", "pct")],
        note="Every stored file with its tier. Hot = opened or uploaded in the last 30 days, Warm = older, Cold = moved to cold storage (needs STORAGE_COLD_DIR)."),
)


# ── Environments & Sandboxes ─────────────────────────────────────────────────

def _sandbox_sql(where: str) -> str:
    from app.services.platform_sandboxes import SOURCES, STATUS_LABEL

    label = " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in STATUS_LABEL.items())
    source = " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in SOURCES.items())
    return f"""SELECT * FROM (SELECT s.id, s.name, s.tenant_id, t.name AS tenant, CASE s.source {source} ELSE s.source END AS source, s.db_name,
                      s.status AS status_key, CASE s.status {label} ELSE s.status END AS status, s.size_mb, s.created_at, s.ready_at, s.refreshed_at,
                      s.expires_at, DATEDIFF(s.expires_at, UTC_TIMESTAMP()) AS days_left, s.created_by, s.progress, s.error, s.masking_verified_at
               FROM platform_sandboxes s LEFT JOIN tenants t ON t.id = s.tenant_id) sb WHERE {where}"""


def _in(values) -> str:
    return ", ".join(f"'{v}'" for v in values)


def _live_sandboxes(extra: str = "1=1") -> str:
    from app.services.platform_sandboxes import LIVE as SB_LIVE

    return _sandbox_sql(f"sb.status_key IN ({_in(SB_LIVE)}) AND {extra}")


SANDBOX_COLS = [Col("name", "Sandbox"), Col("tenant", "Tenant"), Col("source", "Source"), Col("size_mb", "Size", "mb"), Col("created_at", "Created", "date"),
                Col("expires_at", "Expires", "date"), Col("days_left", "Days left", "num"), Col("status", "Status", "pill"),
                Col("db_name", "Database", "code", hidden=True), Col("created_by", "Created by", hidden=True), Col("ready_at", "Ready", "datetime", hidden=True),
                Col("refreshed_at", "Refreshed", "datetime", hidden=True), Col("masking_verified_at", "Masking verified", "datetime", hidden=True),
                Col("progress", "Progress", hidden=True), Col("error", "Error", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True),
                Col("id", "Sandbox ID", "num", hidden=True)]
SANDBOXES = dict(columns=SANDBOX_COLS, search=("name", "tenant", "db_name", "created_by"), status="status", date="created_at", link=TENANT_LINK)


def _change_sets_sql() -> str:
    from app.services.platform_sandboxes import OPEN_SETS, SET_LABEL

    label = " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in SET_LABEL.items())
    return f"""SELECT c.id, CONCAT('CS-', c.id) AS code, c.contents, c.tenant_id, t.name AS tenant, c.sandbox_name, c.items,
                      CASE c.status {label} ELSE c.status END AS status, c.approval_request_id, c.error, c.created_at, c.updated_at
               FROM platform_sandbox_change_sets c LEFT JOIN tenants t ON t.id = c.tenant_id WHERE c.status IN ({_in(OPEN_SETS)})"""


register(
    Kpi("environments.sandboxes", "Sandboxes", "databases", sql=_live_sandboxes(), sort="created_at", group="status", **SANDBOXES,
        summary=[("Sandboxes", "COUNT(*)", "num"), ("Storage", "SUM(q.size_mb)", "mb")]),
    Kpi("environments.storage", "Storage used", "databases", sql=_live_sandboxes(), sort="size_mb", group="tenant", amount="size_mb", **SANDBOXES,
        summary=[("Storage", "SUM(q.size_mb)", "mb")]),
    Kpi("environments.pending_change_sets", "Pending change sets", "databases", sql=_change_sets_sql(), link=TENANT_LINK,
        columns=[Col("code", "Change set", "code"), Col("contents", "Contents"), Col("tenant", "Tenant"), Col("sandbox_name", "From sandbox"),
                 Col("items", "Items", "num"), Col("status", "Status", "pill"), Col("created_at", "Detected", "datetime"),
                 Col("approval_request_id", "Approval request", "num", hidden=True), Col("error", "Error", hidden=True), Col("updated_at", "Updated", "datetime", hidden=True),
                 Col("tenant_id", "Tenant ID", "num", hidden=True), Col("id", "Change set ID", "num", hidden=True)],
        search=("code", "contents", "tenant", "sandbox_name"), status="status", date="created_at", sort="created_at", group="status",
        summary=[("Change sets", "COUNT(*)", "num"), ("Items", "SUM(q.items)", "num")]),
    Kpi("environments.expiring", "Expiring ≤ 14 days", "databases", sql=_sandbox_sql("sb.status_key = 'active' AND sb.expires_at <= UTC_TIMESTAMP() + INTERVAL 14 DAY"),
        **{**SANDBOXES, "date": "expires_at"}, sort="expires_at", desc=False, group="tenant",
        summary=[("Already expired", count_where("q.days_left < 0"), "num")]),
)


# ── Jobs & Queues ────────────────────────────────────────────────────────────

def _job_name(key: str) -> str:
    from app.services import platform_jobs as jobs

    return (jobs.JOBS.get(key) or {}).get("name") or key


def _queues(db: Session, ctx: dict) -> list[dict]:
    from app.services import platform_jobs as jobs

    q = jobs.queues_overview()
    if not q["broker"]["ok"]:
        return [{"queue": q["broker"]["url"], "state": "Broker unreachable", "depth": None, "workers": None, "rate_per_min": None, "failed_24h": None,
                 "retries_24h": None, "dead_letter": None, "oldest_seconds": None, "detail": q["broker"]["error"]}]
    return [{"queue": r["name"], "state": "Paused" if r["paused"] else "Consuming" if r["workers"] else "No worker", "depth": r["depth"], "workers": r["workers"],
             "rate_per_min": r["rate_per_min"], "failed_24h": r["failed_24h"], "retries_24h": r["retries_24h"], "dead_letter": r["dead_letter"],
             "oldest_seconds": r["oldest_seconds"], "detail": q["workers"]["error"]} for r in q["queues"]]


QUEUE_COLS = [Col("queue", "Queue", "code"), Col("state", "State", "pill"), Col("depth", "Depth", "num"), Col("workers", "Workers", "num"),
              Col("rate_per_min", "Rate / min", "num"), Col("failed_24h", "Failed · 24h", "num"), Col("dead_letter", "Dead-letter", "num"),
              Col("oldest_seconds", "Oldest (s)", "num"), Col("retries_24h", "Retries · 24h", "num", hidden=True), Col("detail", "Detail", hidden=True)]
QUEUES = dict(rows=_queues, columns=QUEUE_COLS, **NOT_TENANT, search=("queue",), status="state", group="state", link="/platform/jobs")


def _activity(db: Session, ctx: dict, where: str, params: dict) -> list[dict]:
    return [{"kind": "Scheduled job", "name": _job_name(r["job"]), "job": r["job"], "queue": None, "at": r["started_at"], "finished_at": r["finished_at"],
             "status": r["status"], "count": 1, "duration_ms": r["duration_ms"], "trigger": r["trigger"], "detail": r["error"] or r["result"], "actor": r["actor"],
             "worker": r["worker"], "id": r["id"]}
            for r in db.execute(text("SELECT id, job, `trigger`, started_at, finished_at, status, duration_ms, result, error, worker, actor "
                                     f"FROM platform_job_runs WHERE {where} ORDER BY id DESC LIMIT 5000"), params).mappings()]


def _queue_activity(key: str, kind: str, status: str) -> list[dict]:
    return [{"kind": "Queue task", "name": q["queue"], "job": None, "queue": q["queue"], "at": None, "finished_at": None, "status": status, "count": q[key],
             "duration_ms": None, "trigger": None, "detail": q["detail"], "actor": None, "worker": None, "id": None}
            for q in _queues(None, {}) if q[key]]


def _running(db: Session, ctx: dict) -> list[dict]:
    from app.services import platform_jobs as jobs

    # Same rule as scheduled_overview(): a job is running when its newest run is still open and started within 6 h.
    rows = _activity(db, ctx, "id IN (SELECT MAX(id) FROM platform_job_runs GROUP BY job) AND status = 'running' AND started_at > :s",
                     {"s": datetime.now() - timedelta(hours=6)})
    active = jobs.queues_overview().get("running")
    if active:
        rows.append({"kind": "Queue task", "name": "Active Celery tasks", "job": None, "queue": None, "at": None, "finished_at": None, "status": "running",
                     "count": active, "duration_ms": None, "trigger": None, "detail": None, "actor": None, "worker": None, "id": None})
    return rows


def _failed(db: Session, ctx: dict) -> list[dict]:
    return _activity(db, ctx, "status = 'failed' AND started_at >= :s", {"s": datetime.now() - timedelta(hours=24)}) + _queue_activity("failed_24h", "Queue task", "failed")


def _throughput(db: Session, ctx: dict) -> list[dict]:
    rows = _activity(db, ctx, "finished_at >= :s", {"s": datetime.now() - timedelta(minutes=15)})
    return rows + [{**r, "count": round(r["count"] * 15)} for r in _queue_activity("rate_per_min", "Queue task", "done")]


def _dead_letter(db: Session, ctx: dict) -> list[dict]:
    from app.services import platform_jobs as jobs

    rows = []
    try:
        client = jobs._redis()
        for q in _queues(db, ctx):
            if not q["dead_letter"]:
                continue
            for raw in client.lrange(f"{jobs.PREFIX}:dead:{q['queue']}", 0, 999):
                e = json.loads(raw)
                rows.append({"queue": q["queue"], "task": e.get("task"), "task_id": e.get("id"), "error": e.get("error"),
                             "at": datetime.utcfromtimestamp(e["at"]) if e.get("at") else None})
    except Exception:
        logger.warning("Dead-letter lists unavailable", exc_info=True)
    return rows


RUN_COLS = [Col("kind", "Type", "pill"), Col("name", "Job / queue"), Col("at", "Started", "datetime"), Col("status", "Status", "pill"), Col("count", "Count", "num"),
            Col("duration_ms", "Duration", "ms"), Col("detail", "Result / error"),
            Col("trigger", "Trigger", hidden=True), Col("finished_at", "Finished", "datetime", hidden=True), Col("actor", "Started by", hidden=True),
            Col("worker", "Worker", "code", hidden=True), Col("job", "Job key", "code", hidden=True), Col("id", "Run ID", "num", hidden=True)]
RUNS = dict(columns=RUN_COLS, **NOT_TENANT, search=("name", "detail", "job"), status="kind", date="at", sort="at", group="name", link="/platform/jobs")

register(
    Kpi("jobs.queued", "Queued", "jobs", sort="depth", **QUEUES, summary=[("Waiting messages", _sum("depth"), "num"), ("Queues", lambda rows: len(rows), "num")],
        note="Messages waiting on each Celery queue of the Redis broker."),
    Kpi("jobs.running", "Running", "jobs", rows=_running, **RUNS, summary=[("Running", _sum("count"), "num")],
        note="Scheduled platform jobs whose latest run is still open, plus the tasks Celery workers report as active."),
    Kpi("jobs.failed", "Failed · 24h", "jobs", rows=_failed, **RUNS, summary=[("Failures", _sum("count"), "num")],
        note="Failed scheduled-job runs of the last 24 h, and per-queue counts of Celery tasks that failed (see Dead-letter for the parked tasks)."),
    Kpi("jobs.dead_letter", "Dead-letter", "jobs", rows=_dead_letter, **NOT_TENANT, link="/platform/jobs",
        columns=[Col("at", "Failed at", "datetime"), Col("queue", "Queue", "code"), Col("task", "Task", "code"), Col("error", "Error"), Col("task_id", "Task ID", "code", hidden=True)],
        search=("queue", "task", "error", "task_id"), date="at", sort="at", group="queue",
        note="Tasks that failed for good and are parked for Retry failed (newest 1,000 per queue)."),
    Kpi("jobs.throughput", "Throughput", "jobs", rows=_throughput, **RUNS,
        summary=[("Completed · 15 min", _sum("count"), "num"), ("Per minute", lambda rows: round(sum(r["count"] or 0 for r in rows) / 15, 1), "num")],
        note="Scheduled-job runs that finished in the last 15 minutes, and Celery tasks completed per queue over the same 15 minutes."),
)


# ── Regions & Capacity ───────────────────────────────────────────────────────

def _regions(db: Session, ctx: dict) -> dict:
    from app.services import platform_regions as regions

    return regions.overview(db, ctx["scope"])


def _region_rows(db: Session, ctx: dict) -> list[dict]:
    return [{"region": r["region"], "city": r["city"], "residency": r["residency"], "status": r["status"], "shards": r["shards"], "servers": ", ".join(r["servers"]),
             "utilisation": r["utilisation"], "utilisation_source": r["utilisation_source"], "tenants": r["tenants"], "latency_ms": r["latency_ms"], "cost": r["cost"],
             "last_failover": (r.get("last_failover") or {}).get("summary")} for r in _regions(db, ctx)["regions"] if not r["planned"]]


def _server_rows(db: Session, ctx: dict) -> list[dict]:
    latest = {r["server"]: r for r in db.execute(text(
        "SELECT c.server, c.disk_used_gb, c.disk_total_gb, c.db_size_gb, FROM_UNIXTIME(c.hour * 3600) AS sampled_at FROM platform_capacity_samples c "
        "JOIN (SELECT server, MAX(hour) hour FROM platform_capacity_samples GROUP BY server) m ON m.server = c.server AND m.hour = c.hour")).mappings()}
    rows = []
    for r in _regions(db, ctx)["regions"]:
        if r["planned"]:
            continue
        for s in r["per_server"]:
            c = latest.get(s["server"]) or {}
            u = s["utilisation"]
            rows.append({"server": s["server"], "region": r["region"], "role": "Database" if s["database"] else "Application", "utilisation": u,
                         "band": "Unknown" if u is None else "Above 80%" if u > 80 else "65–80%" if u > 65 else "Below 65%",
                         "disk_used_gb": c.get("disk_used_gb"), "disk_total_gb": c.get("disk_total_gb"), "db_size_gb": c.get("db_size_gb"),
                         "sampled_at": c.get("sampled_at"), "region_status": r["status"]})
    return rows


REGION_COLS = [Col("region", "Region"), Col("city", "City"), Col("residency", "Residency"), Col("shards", "Shards", "num"), Col("utilisation", "Utilisation", "pct"),
               Col("tenants", "Tenants", "num"), Col("latency_ms", "Latency", "ms"), Col("cost", "Cost / month", "inr"), Col("status", "Status", "pill"),
               Col("servers", "Servers", hidden=True), Col("utilisation_source", "Measured by", hidden=True), Col("last_failover", "Last failover test", hidden=True)]
REGIONS = dict(rows=_region_rows, columns=REGION_COLS, **NOT_TENANT, search=("region", "city", "servers"), status="status", group="status", link="/platform/regions")
SERVER_UTIL_COLS = [Col("server", "Server"), Col("region", "Region"), Col("role", "Role", "pill"), Col("utilisation", "Utilisation", "pct"),
                    Col("disk_used_gb", "Used (GB)", "num"), Col("disk_total_gb", "Total (GB)", "num"), Col("db_size_gb", "Tenant DBs (GB)", "num"),
                    Col("sampled_at", "Sampled", "datetime"), Col("band", "Band", "pill", hidden=True), Col("region_status", "Region status", "pill", hidden=True)]
SERVER_UTIL = dict(columns=SERVER_UTIL_COLS, **NOT_TENANT, search=("server", "region"), status="band", sort="utilisation", link="/platform/regions",
                   note="Utilisation is the used share of the server's fullest disk volume (latest hourly capacity sample; live probe before the first sample).")

register(
    Kpi("regions.live", "Regions live", "infrastructure", sort="tenants", **REGIONS,
        summary=[("Healthy", _count(lambda r: r["status"] == "Healthy"), "num"), ("Tenants", _sum("tenants"), "num")]),
    Kpi("regions.db_shards", "DB shards", "infrastructure", rows=lambda db, ctx: [r for r in _server_rows(db, ctx) if r["role"] == "Database"], group="region", **SERVER_UTIL,
        summary=[("Shards", lambda rows: len(rows), "num"), ("Tenant DBs (GB)", _sum("db_size_gb"), "num")]),
    Kpi("regions.avg_utilisation", "Avg utilisation", "infrastructure", rows=_server_rows, group="region", **SERVER_UTIL,
        summary=[("Used (GB)", _sum("disk_used_gb"), "num"), ("Total (GB)", _sum("disk_total_gb"), "num")]),
    Kpi("regions.monthly_cost", "Monthly infra cost", "infrastructure", amount="cost", **{**REGIONS, "group": "region"}, sort="cost",
        summary=[("Cost / month", _sum("cost"), "inr")], note="Cost is the monthly_cost (INR) set on each region's PLATFORM_SERVERS entries; regions without it show “—”."),
    Kpi("regions.shards_above_80", "Shards above 80%", "infrastructure", rows=lambda db, ctx: [r for r in _server_rows(db, ctx) if r["role"] == "Database" and (r["utilisation"] or 0) > 80],
        group="region", **{**SERVER_UTIL, "note": "Database servers whose disk utilisation is above 80 % (see DB shards for every database server)."}),
)


# ── Data Export & Migration ──────────────────────────────────────────────────
# The strips show the outcome of one migration's dry run / import; the page passes its project code as the search.

def _migrations(db: Session, ctx: dict) -> list:
    from app.models.tenant_hierarchy import TenantMigration

    names = {t.id: t.name for t in _tenants(db, ctx)}
    return [(m, names[m.tenant_id]) for m in db.query(TenantMigration).order_by(TenantMigration.id.desc()).limit(2000).all() if m.tenant_id in names]


def _dry_runs(db: Session, ctx: dict) -> list[dict]:
    rows = []
    for m, tenant in _migrations(db, ctx):
        d = m.dry_run if isinstance(m.dry_run, dict) else json.loads(m.dry_run or "{}")
        for o in d.get("objects") or []:
            rows.append({"project": f"MIG-{m.id}", "tenant_id": m.tenant_id, "tenant": tenant, "source": m.source, "status": m.status,
                         "dataset": o.get("dataset"), "target": o.get("target"), "records": o.get("records"), "ready": (o.get("records") or 0) - (o.get("errors") or 0),
                         "warnings": o.get("warnings"), "errors": o.get("errors"), "duplicates": o.get("duplicates"), "top_issue": o.get("top_issue"),
                         "at": d.get("at"), "id": m.id})
    return rows


def _imports(db: Session, ctx: dict) -> list[dict]:
    from app.services.tenant_migration import TARGETS

    rows = []
    for m, tenant in _migrations(db, ctx):
        r = m.result if isinstance(m.result, dict) else json.loads(m.result or "{}")
        if "created" not in r:
            continue
        rows.append({"project": f"MIG-{m.id}", "tenant_id": m.tenant_id, "tenant": tenant, "source": m.source, "status": m.status, "records": m.records,
                     "imported": sum(len(v) for v in (r.get("created") or {}).values()), "updated": sum((r.get("updated") or {}).values()),
                     "skipped": r.get("skipped") or 0, "errors": r.get("errors") or 0,
                     "objects": ", ".join(f"{TARGETS.get(t, {}).get('label', t)} {len(v)}" for t, v in (r.get("created") or {}).items() if v) or None,
                     "created_by": m.created_by, "created_at": m.created_at, "completed_at": m.completed_at, "error": m.error, "id": m.id})
    return rows


register(
    Kpi("transfer.dry_run", "Dry run", ("tenants", "data_transfer"), rows=_dry_runs, link=TENANT_LINK,
        columns=[Col("project", "Project", "code"), Col("tenant", "Tenant"), Col("dataset", "Object"), Col("target", "Imports as"), Col("records", "Records", "num"),
                 Col("ready", "Ready", "num"), Col("warnings", "Warnings", "num"), Col("errors", "Errors", "num"), Col("duplicates", "Duplicates", "num"),
                 Col("top_issue", "Top issue"), Col("source", "Source", hidden=True), Col("status", "Status", "pill", hidden=True), Col("at", "Validated", "datetime", hidden=True),
                 Col("tenant_id", "Tenant ID", "num", hidden=True), Col("id", "Migration ID", "num", hidden=True)],
        search=("project", "tenant", "dataset", "top_issue"), status="status", date="at", sort="records", group="target",
        summary=[("Records", _sum("records"), "num"), ("Ready", _sum("ready"), "num"), ("Warnings", _sum("warnings"), "num"), ("Errors", _sum("errors"), "num"),
                 ("Duplicates", _sum("duplicates"), "num")],
        note="Validated objects of each migration's latest dry run (tenant_migrations); nothing is written by a dry run."),
    Kpi("transfer.import", "Migration import", ("tenants", "data_transfer"), rows=_imports, link=TENANT_LINK,
        columns=[Col("project", "Project", "code"), Col("tenant", "Tenant"), Col("source", "Source"), Col("status", "Status", "pill"), Col("imported", "Imported", "num"),
                 Col("updated", "Updated", "num"), Col("skipped", "Duplicates skipped", "num"), Col("errors", "Rows with errors", "num"),
                 Col("completed_at", "Finished", "datetime"), Col("objects", "Imported objects", hidden=True), Col("records", "Records", "num", hidden=True),
                 Col("created_by", "By", hidden=True), Col("created_at", "Started", "datetime", hidden=True), Col("error", "Error", hidden=True),
                 Col("tenant_id", "Tenant ID", "num", hidden=True), Col("id", "Migration ID", "num", hidden=True)],
        search=("project", "tenant", "source", "objects"), status="status", date="created_at", sort="created_at", group="status",
        summary=[("Imported", _sum("imported"), "num"), ("Updated", _sum("updated"), "num"), ("Skipped", _sum("skipped"), "num"), ("Errors", _sum("errors"), "num")]),
)


# ── Usage Monitoring ─────────────────────────────────────────────────────────
# Default period of the page (30 days). Hourly meters come straight from platform_tenant_usage_hours; per-tenant
# figures read from tenant databases come from the same overview the page uses (cached 5 min per tenant).

def _meter_sql(meter: str) -> str:
    return f"""SELECT u.id, FROM_UNIXTIME(u.hour * 3600) AS hour_start, t.id AS tenant_id, t.name AS tenant, u.tenant_slug AS slug, u.value
               FROM platform_tenant_usage_hours u JOIN tenants t ON t.slug = u.tenant_slug
               WHERE u.meter = '{meter}' AND u.hour >= FLOOR(UNIX_TIMESTAMP() / 3600) - 30 * 24 + 1"""


METER_COLS = [Col("hour_start", "Hour", "datetime"), Col("tenant", "Tenant"), Col("value", "Count", "num"), Col("slug", "Slug", "code", hidden=True),
              Col("tenant_id", "Tenant ID", "num", hidden=True), Col("id", "Meter row", "num", hidden=True)]
METER = dict(columns=METER_COLS, search=("tenant", "slug"), date="hour_start", sort="hour_start", group="tenant", amount="value", link=TENANT_LINK,
             summary=[("Total · 30 d", "SUM(q.value)", "num"), ("Busiest hour", "MAX(q.value)", "num")])


def _usage(db: Session, ctx: dict) -> list[dict]:
    from app.services import platform_usage as usage

    rows = []
    for r in usage.overview(db, _tenants(db, ctx), "30d")["tenants"]:
        lim = r["limits"]
        rows.append({"tenant_id": r["id"], "tenant": r["name"], "slug": r["slug"], "plan": r["plan"], "status": r["status"], "usage_status": r["usage_status"] or "Unknown",
                     "api": r["values"]["api"], "dau": r["values"]["dau"], "rec": r["values"]["rec"], "em": r["values"]["em"], "ai": r["values"]["ai"],
                     "storage_mb": lim["storage"]["used"], "storage_limit": lim["storage"]["limit"], "storage_pct": lim["storage"]["percent"],
                     "seats": lim["users"]["used"], "seat_limit": lim["users"]["limit"], "seats_pct": lim["users"]["percent"],
                     "ai_limit": lim["ai"]["limit"], "ai_pct": lim["ai"]["percent"], "ratio": r["ratio"], "last_sign_in": r["last_sign_in"],
                     "measured_at": r["measured_at"], "database": "Reachable" if r["available"] else "Not reachable", "error": r["error"], "admin_email": r["admin_email"]})
    return rows


def _usage_cols(*first: Col) -> list[Col]:
    rest = [Col("tenant", "Tenant"), Col("plan", "Plan"), Col("usage_status", "Usage", "pill"), Col("database", "Database", "pill"),
            Col("api", "API calls", "num", hidden=True), Col("dau", "Active users", "num", hidden=True), Col("rec", "Records created", "num", hidden=True),
            Col("em", "E-mails", "num", hidden=True), Col("ai", "AI queries", "num", hidden=True), Col("seats", "Seats used", "num", hidden=True),
            Col("seat_limit", "Seat limit", "num", hidden=True), Col("seats_pct", "Seats %", "pct", hidden=True), Col("storage_mb", "Storage", "mb", hidden=True),
            Col("storage_limit", "Storage limit", "mb", hidden=True), Col("storage_pct", "Storage %", "pct", hidden=True), Col("ai_limit", "AI quota · 30 d", "num", hidden=True),
            Col("ai_pct", "AI %", "pct", hidden=True), Col("ratio", "Highest limit %", "pct", hidden=True), Col("last_sign_in", "Last sign-in", "datetime", hidden=True),
            Col("measured_at", "Measured", "datetime", hidden=True), Col("status", "Tenant status", "pill", hidden=True), Col("admin_email", "Admin e-mail", hidden=True),
            Col("error", "Error", hidden=True), Col("slug", "Slug", "code", hidden=True), Col("tenant_id", "Tenant ID", "num", hidden=True)]
    keys = {c.key for c in first}
    return [rest[0], *first, *[c for c in rest[1:] if c.key not in keys]]


USAGE = dict(rows=_usage, search=("tenant", "slug", "plan"), status="usage_status", group="usage_status", link=TENANT_LINK,
             note="Last 30 days (the page's default period).")

register(
    Kpi("usage.api_calls", "API calls", "tenants", sql=_meter_sql("api"), **METER, note="Hourly API-call meter per tenant, last 30 days."),
    Kpi("usage.ai_queries", "AI queries", "tenants", sql=_meter_sql("ai"), **METER, note="Hourly AI-query meter per tenant, last 30 days."),
    Kpi("usage.dau", "Active users (DAU)", "tenants", columns=_usage_cols(Col("dau", "Active users", "num"), Col("seats", "Seats used", "num"), Col("seat_limit", "Seat limit", "num"),
                                                                            Col("last_sign_in", "Last sign-in", "datetime")),
        sort="dau", **USAGE, summary=[("Active users", _sum("dau"), "num")]),
    Kpi("usage.records", "Records created", "tenants", columns=_usage_cols(Col("rec", "Records created", "num")), sort="rec", **USAGE,
        summary=[("Records created", _sum("rec"), "num")]),
    Kpi("usage.emails", "Emails sent", "tenants", columns=_usage_cols(Col("em", "E-mails", "num")), sort="em", **USAGE, summary=[("E-mails", _sum("em"), "num")]),
    Kpi("usage.storage", "Storage", "tenants", sql=f"SELECT tt.*, ROUND(tt.storage_mb / NULLIF(tt.storage_limit_mb, 0) * 100, 1) AS storage_pct FROM ({TENANTS_SQL}) tt",
        columns=[Col("tenant", "Tenant"), Col("plan", "Plan"), Col("storage_mb", "Storage", "mb"), Col("storage_limit_mb", "Limit", "mb"), Col("storage_pct", "Used %", "pct"),
                 Col("status", "Status", "pill"), *[c for c in TENANT_COLS if c.key in ("slug", "admin_email", "tenant_id")]],
        search=TENANT_SEARCH, status="status", group="plan", amount="storage_mb", sort="storage_mb", link=TENANT_LINK,
        summary=[("Storage", "SUM(q.storage_mb)", "mb"), ("Allocated", "SUM(q.storage_limit_mb)", "mb")],
        note="Document storage measured per tenant (tenants.used_storage), the figure the card adds up."),
    Kpi("usage.near_limit", "Near / over limit", "tenants", **{**USAGE, "rows": lambda db, ctx: [r for r in _usage(db, ctx) if r["usage_status"] in ("Near limit", "Over limit")],
                                                               "note": "Tenants at or above the usage alert threshold of a seat, storage or AI limit (last 30 days)."}, columns=_usage_cols(Col("ratio", "Highest limit %", "pct"), Col("seats_pct", "Seats %", "pct"),
                                                                              Col("storage_pct", "Storage %", "pct"), Col("ai_pct", "AI %", "pct")),
        sort="ratio", summary=[("Near limit", _count(lambda r: r["usage_status"] == "Near limit"), "num"), ("Over limit", _count(lambda r: r["usage_status"] == "Over limit"), "num")],
        description="Tenants near or over a seat, storage or AI limit"),
)
