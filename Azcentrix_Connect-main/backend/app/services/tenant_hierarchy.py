"""Tenants & Hierarchy: schema upgrade, tenant database metrics and MariaDB operations.

Every tenant keeps its own MariaDB database (database-per-tenant isolation). Parent
groups have no database; group figures are rolled up from the child tenants.
"""

from __future__ import annotations

import logging
import re
import time
from datetime import datetime
from pathlib import Path

import pymysql
from sqlalchemy import inspect, text

from app.core.config import settings
from app.database import get_tenant_engine, get_tenant_session, master_engine, validate_mysql_identifier

logger = logging.getLogger(__name__)

# Optional record counts used by Overview, Metering and group reporting (only tables that exist are counted).
RECORD_TABLES = [("customers", "Customers"), ("leads", "Leads"), ("tenders", "Tenders"), ("quotations", "Quotations")]
CONFIG_TABLES = [
    ("roles", "Roles"),
    ("approval_workflows", "Approval workflows"),
    ("form_fields", "Custom form fields"),
    ("saved_reports", "Saved reports"),
    ("modules", "Modules"),
]
SQL_CONSOLE_MAX_ROWS = 200
SQL_CONSOLE_ALLOWED = ("select", "show", "describe", "desc", "explain")


def ensure_schema() -> None:
    """Add the hierarchy columns to an existing master `tenants` table (create_all handles new tables)."""
    columns = {c["name"] for c in inspect(master_engine).get_columns("tenants")}
    wanted = [
        ("parent_group_id", "ALTER TABLE tenants ADD COLUMN parent_group_id INT NULL, ADD INDEX ix_tenants_parent_group_id (parent_group_id)"),
        ("parent_visibility", "ALTER TABLE tenants ADD COLUMN parent_visibility VARCHAR(20) NOT NULL DEFAULT 'full'"),
        ("shared_masters", "ALTER TABLE tenants ADD COLUMN shared_masters TINYINT(1) NOT NULL DEFAULT 1"),
        ("inherit_parent_policies", "ALTER TABLE tenants ADD COLUMN inherit_parent_policies TINYINT(1) NOT NULL DEFAULT 1"),
        ("industry", "ALTER TABLE tenants ADD COLUMN industry VARCHAR(150) NULL"),
        ("deletion_scheduled_at", "ALTER TABLE tenants ADD COLUMN deletion_scheduled_at DATETIME NULL"),
    ]
    statements = [sql for name, sql in wanted if name not in columns]
    if statements:
        with master_engine.begin() as conn:
            for sql in statements:
                conn.execute(text(sql))
        logger.info("Tenants & Hierarchy: added %d column(s) to tenants", len(statements))
    # Data Export & Migration columns on the export / migration tables (created by create_all when new).
    for table, column, sql in (("tenant_export_jobs", "options", "ALTER TABLE tenant_export_jobs ADD COLUMN options JSON NULL"),
                               ("tenant_migrations", "scheduled_at", "ALTER TABLE tenant_migrations ADD COLUMN scheduled_at DATETIME NULL")):
        if inspect(master_engine).has_table(table) and column not in {c["name"] for c in inspect(master_engine).get_columns(table)}:
            with master_engine.begin() as conn:
                conn.execute(text(sql))


def _existing_tables(db, names: list[str]) -> set[str]:
    present = {row[0] for row in db.execute(text("SHOW TABLES"))}
    return {name for name in names if name in present}


def tenant_metrics(tenant, *, records: bool = False) -> dict:
    """Users, weekly-active users, active sessions and optional record counts from a tenant DB."""
    result = {"available": False, "users": None, "active_users": None, "weekly_active": None, "active_sessions": None, "last_activity": None, "records": {}, "tender_stages": None}
    try:
        db = get_tenant_session(tenant.slug)
    except Exception:
        return result
    try:
        result["users"] = int(db.execute(text("SELECT COUNT(*) FROM users")).scalar_one())
        result["active_users"] = int(db.execute(text("SELECT COUNT(*) FROM users WHERE is_active = 1")).scalar_one())
        result["weekly_active"] = int(db.execute(text(
            "SELECT COUNT(DISTINCT user_id) FROM user_sessions WHERE last_active >= NOW() - INTERVAL 7 DAY"
        )).scalar_one())
        result["active_sessions"] = int(db.execute(text(
            "SELECT COUNT(*) FROM user_sessions WHERE is_active = 1 AND logout_time IS NULL AND revoked_at IS NULL "
            "AND last_active >= NOW() - INTERVAL :minutes MINUTE"
        ), {"minutes": int(tenant.inactivity_timeout_minutes or 30)}).scalar_one())
        result["last_activity"] = db.execute(text("SELECT MAX(last_active) FROM user_sessions")).scalar()
        result["tender_stages"] = tender_stages(db)
        if records:
            present = _existing_tables(db, [name for name, _ in RECORD_TABLES])
            result["records"] = {label: int(db.execute(text(f"SELECT COUNT(*) FROM `{name}`")).scalar_one()) for name, label in RECORD_TABLES if name in present}
        result["available"] = True
    except Exception:
        logger.warning("Tenant metrics unavailable for %s", tenant.slug, exc_info=True)
    finally:
        db.close()
    return result


TERMINAL_TENDER_STAGES = {"Closed"}


def tender_stages(db) -> list[str] | None:
    """Open tender workflow stages defined in this tenant's database (tenders.tender_status)."""
    column_type = db.execute(text(
        "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() "
        "AND TABLE_NAME = 'tenders' AND COLUMN_NAME = 'tender_status'"
    )).scalar()
    if not column_type or not column_type.lower().startswith("enum("):
        return None
    stages = re.findall(r"'((?:[^']|'')*)'", column_type)
    return [s.replace("''", "'") for s in stages if s not in TERMINAL_TENDER_STAGES]


PORTABLE_REQUESTERS = {None, "role", "group"}
PORTABLE_APPROVERS = {None, "reporting_manager", "role", "hierarchy_level"}


def workflow_rules(tenant) -> list[dict]:
    """Approval rules of a tenant. Rules that name specific users are not portable; org groups are matched by name."""
    db = get_tenant_session(tenant.slug)
    try:
        rules = db.execute(text(
            "SELECT r.id, r.module, r.action, r.name, r.approval_type, r.requester_type, r.requester_role, r.requester_group_id, "
            "n.group_name AS requester_group_name, r.approver_type, r.approver_role, r.notify_roles, r.escalation_hours, r.is_active "
            "FROM approval_rules r LEFT JOIN org_tree_nodes n ON n.id = r.requester_group_id ORDER BY r.module, r.action"
        )).mappings().all()
        steps = db.execute(text("SELECT approval_rule_id, step_no, approver_type, approver_role, approver_level, is_required FROM approval_rule_steps ORDER BY approval_rule_id, step_no")).mappings().all()
    finally:
        db.close()
    by_rule: dict[int, list[dict]] = {}
    for s in steps:
        by_rule.setdefault(s["approval_rule_id"], []).append(dict(s))
    result = []
    for r in rules:
        rule_steps = by_rule.get(r["id"], [])
        reason = None
        if r["requester_type"] not in PORTABLE_REQUESTERS:
            reason = "Requester is a specific user"
        elif r["requester_type"] == "group" and not r["requester_group_name"]:
            reason = "Requester group has no name"
        elif r["approver_type"] not in PORTABLE_APPROVERS or any(s["approver_type"] not in PORTABLE_APPROVERS for s in rule_steps):
            reason = "Approver is a specific user"
        result.append({**dict(r), "is_active": bool(r["is_active"]), "steps": rule_steps, "portable": reason is None, "not_portable_reason": reason})
    return result


def push_workflow_rules(source, target, rule_ids: list[int] | None) -> dict:
    """Copy portable approval rules from source to target.

    Org-group requesters are re-pointed to the target's org group with the same name. Rules are skipped when that
    group does not exist in the target or when the target already has the same rule (module, action, name, group).
    """
    rules = [r for r in workflow_rules(source) if r["portable"] and (rule_ids is None or r["id"] in rule_ids)]
    db = get_tenant_session(target.slug)
    copied, skipped = [], []
    try:
        groups: dict[str, int] = {}
        for node_id, name in db.execute(text("SELECT id, group_name FROM org_tree_nodes WHERE group_name IS NOT NULL ORDER BY id")).all():
            groups.setdefault(name.strip().lower(), node_id)
        existing = {(m, a, n or "", g) for m, a, n, g in db.execute(text("SELECT module, action, name, requester_group_id FROM approval_rules")).all()}
        for rule in rules:
            label = f"{rule['module']} · {rule['action']}" + (f" ({rule['requester_group_name']})" if rule["requester_group_name"] else "")
            group_id = None
            if rule["requester_type"] == "group":
                group_id = groups.get(rule["requester_group_name"].strip().lower())
                if group_id is None:
                    skipped.append(f"{label} – no '{rule['requester_group_name']}' group")
                    continue
            if (rule["module"], rule["action"], rule["name"] or "", group_id) in existing:
                skipped.append(f"{label} – already exists")
                continue
            new_id = db.execute(text(
                "INSERT INTO approval_rules (tenant_id, module, action, name, approval_type, requester_type, requester_role, requester_group_id, approver_type, approver_role, notify_roles, escalation_hours, is_active, created_at) "
                "VALUES (:tenant_id, :module, :action, :name, :approval_type, :requester_type, :requester_role, :group_id, :approver_type, :approver_role, :notify_roles, :escalation_hours, :is_active, NOW())"
            ), {**{k: rule[k] for k in ("module", "action", "name", "approval_type", "requester_type", "requester_role", "approver_type", "approver_role", "notify_roles", "escalation_hours", "is_active")}, "tenant_id": target.id, "group_id": group_id}).lastrowid
            for step in rule["steps"]:
                db.execute(text(
                    "INSERT INTO approval_rule_steps (approval_rule_id, step_no, approver_type, approver_role, approver_level, is_required) "
                    "VALUES (:rid, :step_no, :approver_type, :approver_role, :approver_level, :is_required)"
                ), {**step, "rid": new_id})
            copied.append(label)
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    return {"tenant_id": target.id, "tenant": target.name, "copied": copied, "skipped": skipped}


def send_announcement(tenant, title: str, message: str, roles: list[str] | None = None) -> int:
    """Create an in-app notification for every active user of a tenant (only users with one of ``roles``, if given)."""
    db = get_tenant_session(tenant.slug)
    try:
        params = {"title": title, "message": message}
        role_filter = ""
        if roles:
            role_filter = " AND role IN (" + ", ".join(f":r{i}" for i in range(len(roles))) + ")"
            params.update({f"r{i}": r for i, r in enumerate(roles)})
        created = db.execute(text(
            "INSERT INTO notifications (user_id, title, message, module, action, is_read, created_at) "
            "SELECT id, :title, :message, 'platform', 'announcement', 0, NOW() FROM users WHERE is_active = 1" + role_filter
        ), params).rowcount
        db.commit()
        return created
    finally:
        db.close()


def health_score(metrics: dict) -> int | None:
    """Weekly active users as a share of enabled users (0-100)."""
    if not metrics.get("available") or not metrics.get("active_users"):
        return None
    return round(min(100.0, metrics["weekly_active"] / metrics["active_users"] * 100))


def configuration_counts(tenant) -> dict:
    db = get_tenant_session(tenant.slug)
    try:
        present = _existing_tables(db, [name for name, _ in CONFIG_TABLES])
        return {label: int(db.execute(text(f"SELECT COUNT(*) FROM `{name}`")).scalar_one()) for name, label in CONFIG_TABLES if name in present}
    finally:
        db.close()


def _connect(database: str | None = None, **extra):
    return pymysql.connect(
        host=settings.TENANT_DB_HOST, port=settings.TENANT_DB_PORT,
        user=settings.TENANT_DB_USER, password=settings.TENANT_DB_PASSWORD,
        database=database, charset="utf8mb4", connect_timeout=10, **extra,
    )


def database_details(tenant) -> dict:
    """MariaDB facts for one tenant database (engine, size, tables, connections, encryption, replication)."""
    db_name = validate_mysql_identifier(tenant.db_name, field_name="database name")
    connection = _connect()
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT VERSION()")
            version = cursor.fetchone()[0]
            cursor.execute(
                "SELECT table_name, table_rows, data_length, index_length, data_free, update_time, engine "
                "FROM information_schema.tables WHERE table_schema = %s AND table_type = 'BASE TABLE' ORDER BY data_length + index_length DESC",
                (db_name,),
            )
            tables = [
                {"name": r[0], "rows": int(r[1] or 0), "data_mb": round((r[2] or 0) / 1024 ** 2, 2), "index_mb": round((r[3] or 0) / 1024 ** 2, 2),
                 "free_mb": round((r[4] or 0) / 1024 ** 2, 2), "updated_at": r[5].isoformat() if r[5] else None, "engine": r[6]}
                for r in cursor.fetchall()
            ]
            cursor.execute("SELECT COUNT(*) FROM information_schema.processlist WHERE db = %s", (db_name,))
            connections = int(cursor.fetchone()[0])
            cursor.execute("SHOW VARIABLES WHERE Variable_name IN ('have_ssl','innodb_encrypt_tables','max_connections','character_set_server','collation_server')")
            variables = dict(cursor.fetchall())
            cursor.execute("SHOW SLAVE STATUS")
            replica = cursor.fetchone()
            cursor.execute("SHOW DATABASES LIKE %s", (db_name.replace("_", "\\_") + "\\_restore\\_%",))
            restores = [row[0] for row in cursor.fetchall()]
    finally:
        connection.close()
    data_mb = sum(t["data_mb"] for t in tables)
    index_mb = sum(t["index_mb"] for t in tables)
    return {
        "engine": f"MariaDB {version.split('-')[0]}" if "MariaDB" in version else f"MySQL {version}",
        "version": version,
        "database": db_name,
        "host": settings.TENANT_DB_HOST,
        "port": settings.TENANT_DB_PORT,
        "size_mb": round(data_mb + index_mb, 2),
        "data_mb": round(data_mb, 2),
        "index_mb": round(index_mb, 2),
        "free_mb": round(sum(t["free_mb"] for t in tables), 2),
        "table_count": len(tables),
        "connections": connections,
        "max_connections": int(variables.get("max_connections", 0) or 0),
        "pool": "SQLAlchemy pool · 5 connections + 10 overflow per worker",
        "isolation": "Database-per-tenant (separate MariaDB database)",
        "ssl": variables.get("have_ssl", "DISABLED"),
        "encryption_at_rest": variables.get("innodb_encrypt_tables", "OFF"),
        "charset": f"{variables.get('character_set_server', '')} / {variables.get('collation_server', '')}",
        "replication": "Replica of another server" if replica else "No replication configured",
        "restored_databases": restores,
        "tables": tables,
    }


def run_maintenance(tenant, action: str) -> dict:
    """MariaDB equivalents of the prototype maintenance buttons."""
    db_name = validate_mysql_identifier(tenant.db_name, field_name="database name")
    if action == "schema_sync":
        from app.database import TenantBase
        import app.models.all_models  # noqa: F401  (register tenant tables)
        engine = get_tenant_engine(tenant.slug)
        before = set(inspect(engine).get_table_names())
        TenantBase.metadata.create_all(bind=engine)
        created = sorted(set(inspect(engine).get_table_names()) - before)
        from app.services.schema_integrity import repair_engine, summary
        ai = repair_engine(engine, tenant.slug)       # every integer id: PRIMARY KEY + AUTO_INCREMENT
        extra = summary(ai)
        return {"action": action, "message": f"Schema in sync · {len(created)} missing table(s) created" + (f" · {extra}" if extra else ""),
                "tables": created, "auto_increment_fixed": [x["table"] for x in ai["fixed"]],
                "auto_increment_review": [f"{x['table']}: {x['reason']}" for x in ai["skipped"]] + ai["errors"]}
    if action not in ("analyze", "optimize"):
        raise ValueError("Unknown maintenance action")
    statement = "ANALYZE TABLE" if action == "analyze" else "OPTIMIZE TABLE"
    started = time.perf_counter()
    connection = _connect(db_name, read_timeout=600)
    try:
        with connection.cursor() as cursor:
            cursor.execute("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'")
            tables = [row[0] for row in cursor.fetchall()]
            failures = []
            for table in tables:
                cursor.execute(f"{statement} `{validate_mysql_identifier(table, field_name='table name')}`")
                for row in cursor.fetchall():
                    if row[2] == "error":
                        failures.append(f"{table}: {row[3]}")
    finally:
        connection.close()
    seconds = round(time.perf_counter() - started, 1)
    return {"action": action, "message": f"{statement} completed on {len(tables)} tables in {seconds}s", "errors": failures}


def _split_sql(script: str):
    """Yield statements from a SQL dump, honouring quotes and comments (no DELIMITER blocks)."""
    statement, quote, escape = [], None, False
    i, length = 0, len(script)
    while i < length:
        ch = script[i]
        if quote:
            statement.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == quote:
                quote = None
        elif ch in ("'", '"', "`"):
            quote = ch
            statement.append(ch)
        elif (script.startswith("--", i) and (i + 2 >= length or script[i + 2] in " \t\r\n")) or ch == "#":
            i = script.find("\n", i)
            if i == -1:
                break
            continue
        elif ch == "/" and script.startswith("/*", i) and not script.startswith("/*!", i):
            end = script.find("*/", i + 2)
            i = length if end == -1 else end + 2
            continue
        elif ch == ";":
            sql = "".join(statement).strip()
            if sql:
                yield sql
            statement = []
        else:
            statement.append(ch)
        i += 1
    tail = "".join(statement).strip()
    if tail:
        yield tail


def restore_backup(tenant, backup_path: Path) -> str:
    """Restore a backup dump into a NEW database; the live tenant database is never touched."""
    if not backup_path.is_file():
        raise FileNotFoundError("Backup file not found on this server")
    target = validate_mysql_identifier(f"{tenant.db_name}_restore_{datetime.now():%Y%m%d%H%M%S}", field_name="database name")
    connection = _connect(autocommit=True, read_timeout=600)
    try:
        with connection.cursor() as cursor:
            cursor.execute(f"CREATE DATABASE `{target}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
            cursor.execute(f"USE `{target}`")
            cursor.execute("SET FOREIGN_KEY_CHECKS=0")
            for sql in _split_sql(backup_path.read_text(encoding="utf-8", errors="replace")):
                if re.match(r"^\s*(USE|CREATE\s+DATABASE|DELIMITER)\b", sql, re.I):
                    continue
                cursor.execute(sql)
            cursor.execute("SET FOREIGN_KEY_CHECKS=1")
    except Exception:
        try:
            with connection.cursor() as cursor:
                cursor.execute(f"DROP DATABASE IF EXISTS `{target}`")
        finally:
            connection.close()
        raise
    connection.close()
    try:   # a dump made from a database without AUTO_INCREMENT would bring the problem back – repair the restored copy
        from app.services.schema_integrity import repair_db_name
        repair_db_name(target)
    except Exception as exc:
        logger.error("AUTO_INCREMENT check on restored database %s failed: %s", target, exc)
    return target


def run_readonly_query(tenant, sql: str) -> dict:
    """Run one read-only statement against a tenant database (row-capped, 10 s limit)."""
    statement = sql.strip().rstrip(";").strip()
    if not statement or ";" in statement:
        raise ValueError("Enter a single statement")
    if statement.split(None, 1)[0].lower() not in SQL_CONSOLE_ALLOWED:
        raise ValueError("Only SELECT, SHOW, DESCRIBE and EXPLAIN statements are allowed")
    connection = _connect(validate_mysql_identifier(tenant.db_name, field_name="database name"), read_timeout=15)
    started = time.perf_counter()
    try:
        with connection.cursor() as cursor:
            cursor.execute("SET SESSION max_statement_time = 10")
            cursor.execute("SET SESSION TRANSACTION READ ONLY")
            cursor.execute("START TRANSACTION READ ONLY")
            cursor.execute(statement)
            columns = [d[0] for d in cursor.description or []]
            rows = cursor.fetchmany(SQL_CONSOLE_MAX_ROWS + 1)
            connection.rollback()
    finally:
        connection.close()
    truncated = len(rows) > SQL_CONSOLE_MAX_ROWS
    return {
        "columns": columns,
        "rows": [[None if v is None else str(v) for v in row] for row in rows[:SQL_CONSOLE_MAX_ROWS]],
        "truncated": truncated,
        "ms": round((time.perf_counter() - started) * 1000, 1),
    }
