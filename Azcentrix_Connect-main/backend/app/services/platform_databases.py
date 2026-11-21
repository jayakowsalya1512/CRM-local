"""Databases module (Data & infrastructure → Databases).

Self-hosted adaptation of the prototype: a "cluster" is a MariaDB server / database instance from the
platform server inventory (PLATFORM_SERVERS, see platform_infrastructure), each tenant "schema" is the
tenant's own MariaDB database, and the "schema version" is the database migration version defined by
MIGRATIONS below. Every figure is read live from the servers; operations either run for real or are
refused with the reason (replication, failover and moves are only offered when the servers support them).
"""

from __future__ import annotations

import importlib
import logging
import re
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, time as dtime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Optional

import pymysql
from pymysql.cursors import DictCursor
from sqlalchemy import event
from sqlalchemy.engine import Engine

from app.core.config import settings
from app.database import validate_mysql_identifier
from app.services.platform_infrastructure import DEFAULT_REGION, _remote_node_metrics, local_node_metrics, server_inventory

try:
    import psutil
except ImportError:
    psutil = None

logger = logging.getLogger(__name__)

_TIMEOUT = 4
SYSTEM_SCHEMAS = {"information_schema", "mysql", "performance_schema", "sys"}


class DatabaseOperationError(RuntimeError):
    """An operation the server refused or that is not possible on this infrastructure."""


# ─── Server probing ──────────────────────────────────────────────────────────

def _connect(entry: dict, database: Optional[str] = None, **extra):
    options = {"connect_timeout": _TIMEOUT, "read_timeout": _TIMEOUT, "write_timeout": _TIMEOUT, **extra}
    return pymysql.connect(
        host=entry["db_host"],
        port=int(entry.get("db_port") or settings.TENANT_DB_PORT),
        user=entry.get("db_user") or settings.TENANT_DB_USER,
        password=entry.get("db_password") or settings.TENANT_DB_PASSWORD,
        database=database,
        charset="utf8mb4",
        **options,
    )


def database_servers() -> list[dict]:
    """Inventory entries that host a database."""
    return [entry for entry in server_inventory() if entry.get("db_host")]


def _server_entry(name: str) -> dict:
    entry = next((e for e in database_servers() if e["name"] == name), None)
    if entry is None:
        raise DatabaseOperationError(f"Database server '{name}' is not in the platform inventory")
    return entry


def _variables(cursor, names: tuple[str, ...]) -> dict:
    cursor.execute("SHOW GLOBAL VARIABLES WHERE Variable_name IN (" + ",".join(["%s"] * len(names)) + ")", names)
    return {row["Variable_name"].lower(): row["Value"] for row in cursor.fetchall()}


def _replication(cursor) -> dict:
    """Replication role from SHOW SLAVE STATUS / SHOW SLAVE HOSTS (needs REPLICATION CLIENT / SLAVE MONITOR)."""
    try:
        cursor.execute("SHOW SLAVE STATUS")
        rows = cursor.fetchall()
    except pymysql.MySQLError as exc:
        return {"role": "Unknown", "error": f"Replication status unavailable: {exc.args[-1]}", "source": None, "replicas": 0}
    if rows:
        row = rows[0]
        lag = row.get("Seconds_Behind_Master")
        return {
            "role": "Replica",
            "source": f"{row.get('Master_Host')}:{row.get('Master_Port')}",
            "source_host": row.get("Master_Host"),
            "io_running": row.get("Slave_IO_Running"),
            "sql_running": row.get("Slave_SQL_Running"),
            "lag_seconds": int(lag) if lag is not None else None,
            "last_error": row.get("Last_IO_Error") or row.get("Last_SQL_Error") or None,
            "replicas": 0,
            "error": None,
        }
    try:
        cursor.execute("SHOW SLAVE HOSTS")
        replicas = len(cursor.fetchall())
    except pymysql.MySQLError:
        replicas = 0
    return {"role": "Primary" if replicas else "Standalone", "source": None, "replicas": replicas, "error": None}


# Statement counters per server: name -> (monotonic time, {database: statements executed}).
_qps_samples: dict[str, tuple[float, dict[str, int]]] = {}
_QPS_SAMPLE_MAX_AGE = 600


def _statement_counts(cursor) -> dict[str, int]:
    cursor.execute(
        "SELECT SCHEMA_NAME AS db, SUM(COUNT_STAR) AS n FROM performance_schema.events_statements_summary_by_digest "
        "WHERE SCHEMA_NAME IS NOT NULL GROUP BY SCHEMA_NAME"
    )
    return {row["db"]: int(row["n"] or 0) for row in cursor.fetchall()}


def _queries_per_second(name: str, cursor) -> Optional[dict[str, float]]:
    """Per-database statements per second from performance_schema digests (None when it is switched off)."""
    try:
        now, counts = time.monotonic(), _statement_counts(cursor)
        previous = _qps_samples.get(name)
        if previous is None or now - previous[0] > _QPS_SAMPLE_MAX_AGE:
            time.sleep(1)
            previous = (now, counts)
            now, counts = time.monotonic(), _statement_counts(cursor)
    except pymysql.MySQLError as exc:
        logger.info("Per-database query rate unavailable on %s: %s", name, exc)
        return None
    _qps_samples[name] = (now, counts)
    elapsed = max(now - previous[0], 0.001)
    return {db: round(max(n - previous[1].get(db, 0), 0) / elapsed, 1) for db, n in counts.items()}


# Fallback when performance_schema is off: statements the platform itself sends to each tenant database,
# counted on every SQLAlchemy engine of this API worker over the last minute.
_STATEMENT_WINDOW = 60
_statement_lock = threading.Lock()
_statement_buckets: dict[int, dict[str, int]] = {}


@event.listens_for(Engine, "before_cursor_execute")
def _count_statement(conn, cursor, statement, parameters, context, executemany):
    name = conn.engine.url.database
    if not name or not name.startswith(settings.TENANT_DB_PREFIX):
        return
    second = int(time.time())
    with _statement_lock:
        bucket = _statement_buckets.get(second)
        if bucket is None:
            bucket = _statement_buckets[second] = {}
            for old in [key for key in _statement_buckets if key <= second - _STATEMENT_WINDOW]:
                del _statement_buckets[old]
        bucket[name] = bucket.get(name, 0) + 1


def platform_query_rates() -> dict[str, float]:
    """Statements per second issued by this API worker to each tenant database, averaged over the last minute."""
    since = int(time.time()) - _STATEMENT_WINDOW
    totals: dict[str, int] = {}
    with _statement_lock:
        for second, bucket in _statement_buckets.items():
            if second > since:
                for name, count in bucket.items():
                    totals[name] = totals.get(name, 0) + count
    return {name: round(count / _STATEMENT_WINDOW, 2) for name, count in totals.items()}


def _os_metrics(entry: dict, datadir: Optional[str]) -> dict:
    if entry.get("local"):
        node = local_node_metrics()
        if node.get("available") and datadir and psutil is not None:
            try:
                usage = psutil.disk_usage(datadir)
                node.update(disk_percent=usage.percent, disk_used_gb=round(usage.used / 1024 ** 3, 2),
                            disk_total_gb=round(usage.total / 1024 ** 3, 2), disk_mount=datadir)
            except OSError:
                pass
        return node
    if entry.get("agent_url"):
        return _remote_node_metrics(entry["agent_url"])
    return {"available": False, "error": "No metrics agent configured"}


def probe(entry: dict, with_qps: bool = True) -> dict:
    """Live state of one database server."""
    server = {
        "name": entry["name"],
        "ip": entry.get("ip") or "",
        "host": entry["db_host"],
        "port": int(entry.get("db_port") or settings.TENANT_DB_PORT),
        "region": entry.get("region") or DEFAULT_REGION,
        "reachable": False,
        "error": None,
        "databases": {},
    }
    started = time.perf_counter()
    try:
        connection = _connect(entry, cursorclass=DictCursor)
    except Exception as exc:
        logger.warning("Database server %s unreachable: %s", entry["name"], exc)
        server.update(error=str(exc.args[-1] if exc.args else exc), role="Unknown", replication=None, metrics=_os_metrics(entry, None))
        return server
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT VERSION() AS v")
            version = cursor.fetchone()["v"]
            latency_ms = round((time.perf_counter() - started) * 1000, 1)
            variables = _variables(cursor, ("max_connections", "read_only", "log_bin", "datadir", "expire_logs_days",
                                            "binlog_expire_logs_seconds", "innodb_buffer_pool_size", "performance_schema"))
            cursor.execute("SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected', 'Uptime')")
            status = {row["Variable_name"].lower(): int(row["Value"]) for row in cursor.fetchall()}
            cursor.execute("SHOW DATABASES")
            names = [row["Database"] for row in cursor.fetchall()]
            cursor.execute(
                "SELECT table_schema AS db, COALESCE(SUM(data_length + index_length), 0) AS size FROM information_schema.tables "
                "WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') GROUP BY table_schema"
            )
            sizes = {row["db"]: round(float(row["size"]) / 1024 ** 2, 2) for row in cursor.fetchall()}
            try:
                cursor.execute("SELECT DB AS db, COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE DB IS NOT NULL GROUP BY DB")
                connections = {row["db"]: int(row["n"]) for row in cursor.fetchall()}
            except pymysql.MySQLError:
                connections = {}
            replication = _replication(cursor)
            qps = _queries_per_second(entry["name"], cursor) if with_qps and str(variables.get("performance_schema", "")).upper() == "ON" else None
    except Exception as exc:
        logger.warning("Database probe failed on %s: %s", entry["name"], exc)
        server.update(reachable=True, error=str(exc), role="Unknown", replication=None, metrics=_os_metrics(entry, None))
        return server
    finally:
        connection.close()

    expire_days = None
    if variables.get("binlog_expire_logs_seconds") not in (None, "", "0"):
        expire_days = round(int(variables["binlog_expire_logs_seconds"]) / 86400, 1)
    elif variables.get("expire_logs_days") not in (None, ""):
        expire_days = float(variables["expire_logs_days"])
    server.update(
        reachable=True,
        version=version,
        latency_ms=latency_ms,
        connections=status.get("threads_connected", 0),
        max_connections=int(variables.get("max_connections") or 0),
        uptime_seconds=status.get("uptime"),
        read_only=str(variables.get("read_only", "")).upper() == "ON",
        log_bin=str(variables.get("log_bin", "")).upper() == "ON",
        binlog_expire_days=expire_days,
        buffer_pool_mb=round(int(variables.get("innodb_buffer_pool_size") or 0) / 1024 ** 2),
        performance_schema=qps is not None,
        role=replication["role"],
        replication=replication,
        metrics=_os_metrics(entry, variables.get("datadir")),
        databases={
            name: {"size_mb": sizes.get(name, 0.0), "connections": connections.get(name, 0), "qps": qps.get(name, 0.0) if qps is not None else None}
            for name in names if name not in SYSTEM_SCHEMAS
        },
    )
    return server


def probe_all(with_qps: bool = True) -> list[dict]:
    entries = database_servers()
    if not entries:
        return []
    with ThreadPoolExecutor(max_workers=min(len(entries), 8)) as pool:
        return list(pool.map(lambda e: probe(e, with_qps), entries))


def _same_host(a: Optional[str], b: Optional[str]) -> bool:
    if not a or not b:
        return False
    try:
        return a.lower() == b.lower() or socket.gethostbyname(a) == socket.gethostbyname(b)
    except OSError:
        return False


def link_replication(servers: list[dict]) -> None:
    """Point each replica at its primary in the inventory and list each primary's replicas."""
    for server in servers:
        server["replica_of"] = None
        server["replica_names"] = []
    for replica in servers:
        repl = replica.get("replication") or {}
        if repl.get("role") != "Replica":
            continue
        primary = next((s for s in servers if s is not replica and (_same_host(s["host"], repl.get("source_host")) or _same_host(s["ip"], repl.get("source_host")))), None)
        if primary:
            replica["replica_of"] = primary["name"]
            primary["replica_names"].append(replica["name"])


def failover_supported(server: dict) -> tuple[bool, str]:
    if not (server.get("replica_of") or server.get("replica_names")):
        return False, "This server is not part of a replication pair in the platform inventory"
    if not settings.PLATFORM_DB_FAILOVER_ENABLED:
        return False, ("Replication is configured, but failover is switched off: set PLATFORM_DB_FAILOVER_ENABLED=true once "
                       "TENANT_DB_HOST points at a virtual IP or proxy that follows the promoted server")
    return True, ""


# ─── Database migration versions ─────────────────────────────────────────────
# Each version is one of the platform's idempotent tenant schema syncs. A tenant database is at a version when
# every marker (table, column) of that version and of all earlier versions exists; column None = the table itself.
MIGRATIONS: list[dict] = [
    {"version": "0001", "description": "User password-reset & reporting-manager columns", "runner": "app.database:sync_tenant_user_auth_columns",
     "markers": [("users", "last_password_changed_at"), ("users", "reporting_manager_ids"), ("alerts", "email_sent_at")]},
    {"version": "0002", "description": "Competitor profile fields", "runner": "app.database:sync_tenant_competitor_columns",
     "markers": [("competitors", "registration_type"), ("competitors", "internal_notes")]},
    {"version": "0003", "description": "Document management folders", "runner": "app.database:sync_tenant_document_folder_columns",
     "markers": [("document_management_files", "folder_id")]},
    {"version": "0004", "description": "Quotation approval & letter-pad fields", "runner": "app.database:sync_tenant_quotation_approval_columns",
     "markers": [("quotations", "approval_status"), ("quotations", "company_address_override"), ("quotation_line_items", "gst_value")]},
    {"version": "0005", "description": "Approval escalation & auto-approve settings", "runner": "app.database:sync_tenant_approval_escalation_schema",
     "markers": [("approval_escalation_settings", "default_escalation_minutes"), ("approval_escalation_rules", "escalation_minutes"), ("approval_auto_approve_settings", "is_enabled")]},
    {"version": "0006", "description": "Custom data, document approvals & audit record names", "runner": "app.database:sync_tenant_misc_columns",
     "markers": [("customers", "custom_data"), ("document_management_files", "approval_comment"), ("document_trash", None), ("audit_logs", "record_name")]},
    {"version": "0007", "description": "Letter management tables", "runner": "app.database:sync_tenant_letter_management_tables",
     "markers": [("letter_types", None), ("letter_templates", None), ("letters", None), ("letter_documents", None), ("letter_history", None)]},
    {"version": "0008", "description": "Letter soft-delete & folder columns", "runner": "app.database:sync_tenant_letter_management_columns",
     "markers": [("letter_templates", "is_deleted"), ("letter_templates", "folder"), ("letters", "deleted_by")]},
    {"version": "0009", "description": "TA/DA claims, tender PO & report drill-down columns", "runner": "app.main:_run_tada_migrations",
     "markers": [("tada_claims", "payment_mode"), ("tada_attachments", None), ("leads", "lead_type"), ("report_type_fields", "drilldown_kind")]},
]
LATEST_VERSION = MIGRATIONS[-1]["version"]
_running: dict[str, str] = {}  # version -> started at (ISO)
_running_lock = threading.Lock()


def schema_markers(entry: dict, db_names: list[str]) -> dict[str, set]:
    """{database: {(table, column), (table, None), ...}} for the marker tables of every migration."""
    if not db_names:
        return {}
    tables = sorted({table for m in MIGRATIONS for table, _ in m["markers"]})
    connection = _connect(entry, read_timeout=15)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA IN ("
                + ",".join(["%s"] * len(db_names)) + ") AND TABLE_NAME IN (" + ",".join(["%s"] * len(tables)) + ")",
                (*db_names, *tables),
            )
            found: dict[str, set] = {name: set() for name in db_names}
            for schema, table, column in cursor.fetchall():
                found[schema].update({(table, column), (table, None)})
            return found
    finally:
        connection.close()


def migration_version(markers: Optional[set]) -> Optional[str]:
    """Highest version whose markers, and those of every earlier version, are all present."""
    if markers is None:
        return None
    version = None
    for migration in MIGRATIONS:
        if not all(marker in markers for marker in migration["markers"]):
            break
        version = migration["version"]
    return version


def migration_rollout(markers_by_db: dict[str, set]) -> list[dict]:
    total = len(markers_by_db)
    rows = []
    for migration in MIGRATIONS:
        applied = sum(1 for found in markers_by_db.values() if all(marker in found for marker in migration["markers"]))
        percent = round(applied / total * 100) if total else 0
        running = _running.get(migration["version"])
        status = "Running" if running else "Done" if total and applied == total else "In Progress" if applied else "Pending"
        rows.append({"version": migration["version"], "description": migration["description"], "applied": applied, "total": total,
                     "rolled_out": percent, "status": status, "started_at": running})
    return rows


def _run_migration(version: str, runner: str) -> None:
    try:
        module_name, func_name = runner.split(":")
        getattr(importlib.import_module(module_name), func_name)()
        logger.info("Database migration %s rolled out", version)
    except Exception:
        logger.exception("Database migration %s failed", version)
    finally:
        with _running_lock:
            _running.pop(version, None)


def continue_migration(version: str) -> None:
    """Re-run one version's idempotent schema sync for every tenant database in the background."""
    migration = next((m for m in MIGRATIONS if m["version"] == version), None)
    if migration is None:
        raise DatabaseOperationError("Unknown migration version")
    with _running_lock:
        if version in _running:
            raise DatabaseOperationError(f"Migration {version} is already running")
        _running[version] = datetime.now(timezone.utc).isoformat()
    threading.Thread(target=_run_migration, args=(version, migration["runner"]), name=f"db-migration-{version}", daemon=True).start()


# ─── Operations ──────────────────────────────────────────────────────────────

def failover_drill(servers: list[dict], max_lag: float) -> list[dict]:
    """Non-destructive readiness check of every replica: threads running, lag within the alert, read-only."""
    checks = []
    for server in servers:
        repl = server.get("replication") or {}
        if repl.get("role") != "Replica":
            continue
        problems = []
        if repl.get("io_running") != "Yes":
            problems.append(f"IO thread {repl.get('io_running') or 'stopped'}")
        if repl.get("sql_running") != "Yes":
            problems.append(f"SQL thread {repl.get('sql_running') or 'stopped'}")
        if repl.get("lag_seconds") is None:
            problems.append("lag unknown")
        elif repl["lag_seconds"] > max_lag:
            problems.append(f"lag {repl['lag_seconds']} s above the {max_lag:g} s alert")
        if not server.get("read_only"):
            problems.append("replica is writable (read_only is OFF)")
        if repl.get("last_error"):
            problems.append(repl["last_error"])
        checks.append({"server": server["name"], "primary": server.get("replica_of") or repl.get("source"), "lag_seconds": repl.get("lag_seconds"),
                       "passed": not problems, "problems": problems})
    return checks


def failover(server_name: str) -> dict:
    """Promote the replica of a primary (or the replica itself): stop writes on the primary, wait for the replica
    to catch up, then detach and open the replica for writes. Raises DatabaseOperationError on any refusal."""
    servers = probe_all(with_qps=False)
    link_replication(servers)
    server = next((s for s in servers if s["name"] == server_name), None)
    if server is None:
        raise DatabaseOperationError("Server not found")
    supported, reason = failover_supported(server)
    if not supported:
        raise DatabaseOperationError(reason)
    if server.get("replica_of"):
        replica_name, primary_name = server["name"], server["replica_of"]
    else:
        replica_name, primary_name = server["replica_names"][0], server["name"]
    replica = next(s for s in servers if s["name"] == replica_name)
    if not replica["reachable"]:
        raise DatabaseOperationError(f"Replica {replica_name} is unreachable")
    primary = next(s for s in servers if s["name"] == primary_name)

    primary_conn = None
    position = None
    if primary["reachable"]:
        primary_conn = _connect(_server_entry(primary_name), cursorclass=DictCursor, autocommit=True)
        with primary_conn.cursor() as cursor:
            cursor.execute("SET GLOBAL read_only = ON")
            cursor.execute("SHOW MASTER STATUS")
            position = cursor.fetchone()
    try:
        replica_conn = _connect(_server_entry(replica_name), cursorclass=DictCursor, autocommit=True, read_timeout=60)
        try:
            with replica_conn.cursor() as cursor:
                if position:
                    cursor.execute("SELECT MASTER_POS_WAIT(%s, %s, 30) AS caught_up", (position["File"], position["Position"]))
                    caught_up = cursor.fetchone()["caught_up"]
                    if caught_up is None or caught_up < 0:
                        raise DatabaseOperationError(f"{replica_name} did not catch up with {primary_name} within 30 s; failover aborted")
                cursor.execute("STOP SLAVE")
                cursor.execute("RESET SLAVE ALL")
                cursor.execute("SET GLOBAL read_only = OFF")
        finally:
            replica_conn.close()
    except Exception:
        if primary_conn is not None:
            with primary_conn.cursor() as cursor:
                cursor.execute("SET GLOBAL read_only = OFF")
        raise
    finally:
        if primary_conn is not None:
            primary_conn.close()
    return {"promoted": replica_name, "demoted": primary_name if primary["reachable"] else None}


RESIZE_LIMITS = {"max_connections": (10, 100000), "buffer_pool_mb": (128, 1024 * 1024)}


def resize(server_name: str, max_connections: Optional[int], buffer_pool_mb: Optional[int]) -> dict:
    """Resize the instance's connection limit and InnoDB buffer pool online (SET GLOBAL, needs SUPER)."""
    entry = _server_entry(server_name)
    connection = _connect(entry, cursorclass=DictCursor, autocommit=True, read_timeout=30)
    try:
        with connection.cursor() as cursor:
            before = _variables(cursor, ("max_connections", "innodb_buffer_pool_size"))
            if max_connections is not None:
                cursor.execute("SET GLOBAL max_connections = %s", (max_connections,))
            if buffer_pool_mb is not None:
                cursor.execute("SET GLOBAL innodb_buffer_pool_size = %s", (buffer_pool_mb * 1024 * 1024,))
            after = _variables(cursor, ("max_connections", "innodb_buffer_pool_size"))
    except pymysql.MySQLError as exc:
        raise DatabaseOperationError(f"The server refused the change: {exc.args[-1]}") from exc
    finally:
        connection.close()
    shape = lambda v: {"max_connections": int(v["max_connections"]), "buffer_pool_mb": round(int(v["innodb_buffer_pool_size"]) / 1024 ** 2)}
    return {"before": shape(before), "after": shape(after)}


def test_server(entry: dict) -> dict:
    """Connect to a candidate database instance and report what the platform would see."""
    connection = _connect(entry, cursorclass=DictCursor)
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT VERSION() AS v")
            version = cursor.fetchone()["v"]
            cursor.execute("SHOW DATABASES")
            names = [row["Database"] for row in cursor.fetchall()]
            replication = _replication(cursor)
            cursor.execute("SHOW GRANTS")
            grants = [list(row.values())[0] for row in cursor.fetchall()]
    finally:
        connection.close()
    return {"version": version, "role": replication["role"], "tenant_databases": sum(1 for n in names if n.startswith(settings.TENANT_DB_PREFIX)),
            "grants": grants}


# ─── Restore drill ───────────────────────────────────────────────────────────

_UNSAFE_RESTORE = re.compile(r"^\s*(USE|CREATE\s+DATABASE|DROP\s+DATABASE|DELIMITER|GRANT|REVOKE|CREATE\s+USER|SET\s+GLOBAL|LOAD\s+DATA|SELECT\s.+\sINTO\s+OUTFILE)\b", re.I | re.S)


def restore_drill(dump: Path, label: str) -> dict:
    """Restore a backup file into a scratch database, compare its tables with the dump, then drop it."""
    from app.services.tenant_data_transfer import _connect as tenant_connect
    from app.services.tenant_hierarchy import _split_sql

    script = dump.read_text(encoding="utf-8", errors="replace")
    expected = len(set(re.findall(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z0-9_$]+)`?", script, re.I)))
    target = validate_mysql_identifier(f"{settings.TENANT_DB_PREFIX}restore_drill_{label}", field_name="database name")
    started = time.perf_counter()
    connection = tenant_connect(autocommit=True, read_timeout=600)
    try:
        with connection.cursor() as cursor:
            cursor.execute(f"DROP DATABASE IF EXISTS `{target}`")
            cursor.execute(f"CREATE DATABASE `{target}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
            cursor.execute(f"USE `{target}`")
            cursor.execute("SET FOREIGN_KEY_CHECKS=0")
            for sql in _split_sql(script):
                if not _UNSAFE_RESTORE.match(sql):
                    cursor.execute(sql)
            cursor.execute("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = %s", (target,))
            restored = int(cursor.fetchone()[0])
    finally:
        try:
            with connection.cursor() as cursor:
                cursor.execute(f"DROP DATABASE IF EXISTS `{target}`")
        finally:
            connection.close()
    return {"expected_tables": expected, "restored_tables": restored, "seconds": round(time.perf_counter() - started, 1),
            "passed": restored > 0 and restored == expected}


# ─── Read-only SQL console ───────────────────────────────────────────────────

SQL_ROW_LIMIT = 200
SQL_TIMEOUT_SECONDS = 5
SQL_MAX_LENGTH = 5000
_SQL_START = {"select", "with", "show", "describe", "desc", "explain"}
_SQL_BLOCKED = {
    "into", "outfile", "dumpfile", "load_file", "sleep", "benchmark", "get_lock", "release_lock", "release_all_locks",
    "master_pos_wait", "master_gtid_wait", "lock", "update", "delete", "insert", "replace", "drop", "alter", "create",
    "truncate", "grant", "revoke", "call", "handler", "rename", "kill", "shutdown", "execute", "prepare", "procedure",
    "set", "do", "flush", "install", "uninstall", "optimize", "repair", "analyze", "purge", "reset", "load", "begin", "commit",
}
_SHOW_ALLOWED = re.compile(r"^show\s+(full\s+)?(tables|columns|fields|index|indexes|keys|table\s+status)\b|^show\s+create\s+(table|view)\b", re.I)


class SqlRejected(ValueError):
    pass


def _lex(sql: str) -> tuple[str, list[str], list[str]]:
    """Strip comments and literals: returns (skeleton text, bare words, backtick identifiers)."""
    out, words, quoted = [], [], []
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch == "/" and sql.startswith("/*", i):
            if sql.startswith("/*!", i) or sql.startswith("/*M!", i):
                raise SqlRejected("Executable comments are not allowed")
            end = sql.find("*/", i + 2)
            if end < 0:
                raise SqlRejected("Unterminated comment")
            out.append(" ")
            i = end + 2
        elif ch == "#" or (ch == "-" and sql.startswith("--", i) and (i + 2 == n or sql[i + 2] in " \t\r\n")):
            end = sql.find("\n", i)
            out.append(" ")
            i = n if end < 0 else end
        elif ch in ("'", '"'):
            j = i + 1
            while j < n:
                if sql[j] == "\\":
                    j += 2
                    continue
                if sql[j] == ch:
                    if j + 1 < n and sql[j + 1] == ch:
                        j += 2
                        continue
                    break
                j += 1
            if j >= n:
                raise SqlRejected("Unterminated string literal")
            if ch == '"':  # an identifier when the server runs with ANSI_QUOTES
                quoted.append(sql[i + 1:j].lower())
            out.append(" '' ")
            i = j + 1
        elif ch == "`":
            end = sql.find("`", i + 1)
            if end < 0:
                raise SqlRejected("Unterminated identifier")
            quoted.append(sql[i + 1:end].lower())
            out.append(" `x` ")
            i = end + 1
        else:
            out.append(ch)
            i += 1
    skeleton = "".join(out)
    words = [w.lower() for w in re.findall(r"[A-Za-z0-9_$]+", skeleton)]
    return skeleton, words, quoted


def validate_sql(sql: str, own_db: str, other_dbs: set[str]) -> str:
    """Accept one read-only statement that only touches the tenant's own database."""
    sql = (sql or "").strip()
    if not sql:
        raise SqlRejected("Enter a query")
    if len(sql) > SQL_MAX_LENGTH:
        raise SqlRejected(f"Queries are limited to {SQL_MAX_LENGTH} characters")
    skeleton, words, quoted = _lex(sql)
    skeleton = skeleton.strip().rstrip(";").strip()
    if ";" in skeleton:
        raise SqlRejected("Run one statement at a time")
    if "@" in skeleton:
        raise SqlRejected("Server and user variables are not allowed on the read-only console")
    if not words or words[0] not in _SQL_START:
        raise SqlRejected("Only SELECT, WITH, SHOW, DESCRIBE and EXPLAIN statements can run on the read-only console")
    is_show_create = False
    if words[0] == "show":
        if not _SHOW_ALLOWED.match(skeleton):
            raise SqlRejected("Only SHOW TABLES / COLUMNS / INDEX / TABLE STATUS / CREATE TABLE are allowed")
        is_show_create = len(words) > 1 and words[1] == "create"
    blocked = sorted({w for w in words if w in _SQL_BLOCKED and not (is_show_create and w == "create")})
    if blocked:
        raise SqlRejected(f"Not allowed on the read-only console: {', '.join(w.upper() for w in blocked)}")
    own = own_db.lower()
    forbidden = (SYSTEM_SCHEMAS | {d.lower() for d in other_dbs}) - {own}
    crossing = sorted({name for name in (*words, *quoted) if name in forbidden})
    if crossing:
        raise SqlRejected(f"Queries are limited to this tenant's database ({own_db}); {', '.join(crossing)} is not accessible")
    return sql.rstrip().rstrip(";")


def locate_database(db_name: str) -> tuple[dict, bool, list[str]]:
    """The server to query a tenant database on: a reachable replica holding it, else the server that hosts it.
    Returns (inventory entry, is replica, every database name on that server)."""
    found = []
    for entry in database_servers():
        try:
            connection = _connect(entry, cursorclass=DictCursor)
        except Exception:
            continue
        try:
            with connection.cursor() as cursor:
                cursor.execute("SHOW DATABASES")
                names = [row["Database"] for row in cursor.fetchall()]
                if db_name in names:
                    found.append((entry, _replication(cursor)["role"] == "Replica", names))
        except pymysql.MySQLError:
            continue
        finally:
            connection.close()
    if not found:
        raise DatabaseOperationError(f"Database {db_name} was not found on any reachable server")
    return sorted(found, key=lambda item: not item[1])[0]


def _cell(column: str, value):
    from app.services.tenant_data_transfer import SECRET_COLUMN

    if value is None:
        return None
    if SECRET_COLUMN.search(column):
        return "••••••"
    if isinstance(value, (bytes, bytearray)):
        return f"<binary {len(value)} bytes>"
    if isinstance(value, (datetime, date, dtime)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (int, float, bool)):
        return value
    text_value = str(value)
    return text_value if len(text_value) <= 500 else text_value[:500] + "…"


def run_sql(entry: dict, db_name: str, sql: str) -> dict:
    """Run a validated statement in a read-only transaction with a statement timeout and a row cap."""
    started = time.perf_counter()
    connection = _connect(entry, database=validate_mysql_identifier(db_name, field_name="database name"),
                          read_timeout=SQL_TIMEOUT_SECONDS + 3)
    try:
        with connection.cursor() as cursor:
            try:
                cursor.execute(f"SET SESSION max_statement_time = {SQL_TIMEOUT_SECONDS}")
            except pymysql.MySQLError:
                cursor.execute(f"SET SESSION MAX_EXECUTION_TIME = {SQL_TIMEOUT_SECONDS * 1000}")
            cursor.execute("SET SESSION TRANSACTION READ ONLY")
            cursor.execute("START TRANSACTION READ ONLY")
            try:
                cursor.execute(sql)
                columns = [d[0] for d in cursor.description or []]
                fetched = cursor.fetchmany(SQL_ROW_LIMIT + 1) if columns else []
            finally:
                connection.rollback()
    except pymysql.MySQLError as exc:
        message = str(exc.args[-1] if exc.args else exc)
        if exc.args and exc.args[0] in (1969, 3024) or "max_statement_time" in message.lower():
            message = f"Query exceeded the {SQL_TIMEOUT_SECONDS} s limit and was stopped"
        raise SqlRejected(message) from exc
    finally:
        connection.close()
    rows = [[_cell(columns[i], v) for i, v in enumerate(row)] for row in fetched[:SQL_ROW_LIMIT]]
    return {"columns": columns, "rows": rows, "row_count": len(rows), "truncated": len(fetched) > SQL_ROW_LIMIT,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 1), "row_limit": SQL_ROW_LIMIT, "timeout_seconds": SQL_TIMEOUT_SECONDS}
