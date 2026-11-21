"""Databases module: database servers, tenant placement, migration versions, backup policy and the read-only SQL console.

Paths sit under ``/databases`` so the Databases permission of the caller's platform role applies (view to read,
manage to run anything). Server-wide operations also need all-tenant scope; the SQL console needs the tenant in scope.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.config import settings
from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.platform_backup import TenantBackup
from app.models.tenant import PlatformAuditLog, Tenant
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_controls as controls
from app.services import platform_databases as dbs
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids
from app.services.platform_backup_service import BACKUP_DIR

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/platform/databases", dependencies=[Depends(enforce_platform_access)])

SQL_EXAMPLES = [
    "select status, count(*) from leads group by status",
    "select id, wo_number, customer_name, wo_value, status from work_orders order by wo_value desc limit 8",
    "select id, customer_name, industry from customers order by id desc limit 10",
    "select count(*) from tenders",
]


def _require_platform_scope(request: Request) -> None:
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail="Only staff with all-tenant scope can run server-wide database operations.")


def _audit(db: Session, request: Request, action: str, description: str, entity_type: str = "database_server",
           entity_id: Optional[int] = None, entity_name: Optional[str] = None, new: Optional[dict] = None) -> None:
    _write_platform_audit(db, _get_platform_admin(request), action, entity_type, entity_id, entity_name, description,
                          get_request_ip(request), new_data=new)
    db.commit()


def _pct(value, total) -> Optional[float]:
    return round(value / total * 100, 1) if total else None


def _server_card(server: dict) -> dict:
    metrics = server.get("metrics") or {}
    repl = server.get("replication") or {}
    supported, reason = dbs.failover_supported(server)
    in_replication = bool(server.get("replica_of") or server.get("replica_names"))
    return {
        "name": server["name"],
        "ip": server["ip"],
        "host": f"{server['host']}:{server['port']}",
        "region": server["region"],
        "reachable": server["reachable"],
        "error": server.get("error"),
        "version": server.get("version"),
        "role": server.get("role", "Unknown"),
        "role_error": repl.get("error"),
        "replica_of": server.get("replica_of"),
        "replica_names": server.get("replica_names", []),
        "lag_seconds": repl.get("lag_seconds") if repl.get("role") == "Replica" else None,
        "replication_state": {k: repl.get(k) for k in ("io_running", "sql_running", "last_error", "source")} if repl.get("role") == "Replica" else None,
        "cpu_percent": metrics.get("cpu_percent") if metrics.get("available") else None,
        "memory_percent": metrics.get("memory_percent") if metrics.get("available") else None,
        "storage_percent": metrics.get("disk_percent") if metrics.get("available") else None,
        "storage_detail": f"{metrics.get('disk_mount')} · {metrics.get('disk_used_gb')} / {metrics.get('disk_total_gb')} GB" if metrics.get("available") and metrics.get("disk_mount") else None,
        "metrics_error": None if metrics.get("available") else metrics.get("error") or "OS metrics unavailable",
        "connections": server.get("connections"),
        "max_connections": server.get("max_connections"),
        "connections_percent": _pct(server.get("connections") or 0, server.get("max_connections")) if server["reachable"] else None,
        "buffer_pool_mb": server.get("buffer_pool_mb"),
        "latency_ms": server.get("latency_ms"),
        "read_only": server.get("read_only"),
        "log_bin": server.get("log_bin"),
        "query_rate_available": server.get("performance_schema", False),
        "failover": {"visible": in_replication, "enabled": supported, "reason": reason},
    }


def _backup_policy(db: Session, servers: list[dict]) -> dict:
    primary = next((s for s in servers if s["reachable"] and s.get("role") != "Replica"), None)
    snap, keep = controls.value(db, "bkSnap"), controls.value(db, "bkKeep")
    scheduled = db.query(TenantBackup.tenant_id).filter(TenantBackup.frequency.isnot(None)).distinct().count()
    latest = db.query(TenantBackup).filter(TenantBackup.status == "completed").order_by(TenantBackup.completed_at.desc()).first()
    last_backup = f"last backup {latest.completed_at:%d %b %Y %H:%M}" if latest and latest.completed_at else "no completed backup yet"
    if primary is None:
        pitr = {"value": "Unknown", "note": "No database server is reachable"}
    elif primary.get("log_bin"):
        expire = primary.get("binlog_expire_days")
        pitr = {"value": f"{expire:g} days (binary log)" if expire else "Binary log on · no expiry", "note": f"Binary logging on {primary['name']}"}
    else:
        pitr = {"value": "Not available", "note": f"Binary logging is off on {primary['name']}"}
    cross = ({"value": "Not configured", "note": f"Enabled in policy, but no second copy is made; backups are written only to {BACKUP_DIR}"}
             if controls.value(db, "bkXRegion") else {"value": "Off", "note": None})
    drills = {"value": "Monthly (policy) · run on demand", "note": "Drills are not scheduled automatically"} if controls.value(db, "bkDrill") else {"value": "Off", "note": None}
    last = db.query(PlatformAuditLog).filter(PlatformAuditLog.action == "database.restore_drill").order_by(PlatformAuditLog.id.desc()).first()
    return {
        "snapshots": {"value": f"{snap} · {keep} days", "note": f"{scheduled} tenant{'s' if scheduled != 1 else ''} on a backup schedule · {last_backup}"},
        "point_in_time": pitr,
        "cross_region_copy": cross,
        "restore_drills": drills,
        "last_drill": {"passed": bool((last.new_data or {}).get("passed")), "at": last.created_at.isoformat(), "detail": last.description} if last else None,
    }


def placement(db: Session) -> tuple[list[dict], dict[str, dict], dict[str, set], list[dict]]:
    """(probed servers, tenant db_name -> hosting server, migration markers, one placement row per tenant) – shared with the KPI drill-downs."""
    entries = {entry["name"]: entry for entry in dbs.database_servers()}
    servers = dbs.probe_all()
    dbs.link_replication(servers)

    tenants = db.query(Tenant).order_by(Tenant.name).all()
    tenant_dbs = {t.db_name for t in tenants}
    host_of: dict[str, dict] = {}
    for server in sorted(servers, key=lambda s: s.get("role") == "Replica"):  # primaries / standalone servers first
        for name in server["databases"]:
            if name in tenant_dbs:
                host_of.setdefault(name, server)
    markers: dict[str, set] = {}
    for server in servers:
        names = [name for name, host in host_of.items() if host is server]
        if names and server["reachable"]:
            try:
                markers.update(dbs.schema_markers(entries[server["name"]], names))
            except Exception:
                logger.warning("Migration markers unavailable on %s", server["name"], exc_info=True)

    platform_rates = dbs.platform_query_rates()
    all_rows = []
    for tenant in tenants:
        host = host_of.get(tenant.db_name)
        info = host["databases"][tenant.db_name] if host else {}
        measured = info.get("qps") is not None
        all_rows.append({
            "id": tenant.id, "name": tenant.name, "slug": tenant.slug, "status": tenant.status, "db_name": tenant.db_name,
            "server": host["name"] if host else None, "size_mb": info.get("size_mb"),
            "qps": info["qps"] if measured else platform_rates.get(tenant.db_name, 0.0) if host else None,
            "qps_source": "performance_schema" if measured else "platform" if host else None,
            "connections": info.get("connections"), "migration_version": dbs.migration_version(markers.get(tenant.db_name)),
        })
    return servers, host_of, markers, all_rows


@router.get("")
def databases_overview(request: Request, db: Session = Depends(get_master_db_dep)):
    servers, host_of, markers, all_rows = placement(db)
    allowed = scoped_tenant_ids(request)
    tenant_rows = [row for row in all_rows if allowed is None or row["id"] in allowed]

    counted = [s for s in servers if s["reachable"]]
    replicas = [s for s in counted if s.get("role") == "Replica"]
    lags = [s["replication"]["lag_seconds"] for s in replicas if s["replication"].get("lag_seconds") is not None]
    since = datetime.utcnow() - timedelta(days=90)
    failovers = db.query(PlatformAuditLog).filter(PlatformAuditLog.action == "database.failover", PlatformAuditLog.created_at >= since).count()
    behind = sum(1 for row in tenant_rows if row["server"] and row["migration_version"] != dbs.LATEST_VERSION)
    moves_possible = len([s for s in counted if s.get("role") != "Replica"]) > 1

    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "kpis": {
            "clusters": len(servers),
            # Tenant databases only, so the figure matches the Tenant placement total; server_size_mb adds the platform's own databases.
            "total_size_mb": round(sum(row["size_mb"] or 0 for row in tenant_rows), 2),
            "server_size_mb": round(sum(d["size_mb"] for s in counted if s.get("role") != "Replica" for d in s["databases"].values()), 2),
            "connections": sum(s.get("connections") or 0 for s in counted),
            "tenant_connections": sum(row["connections"] or 0 for row in tenant_rows),
            "max_connections": sum(s.get("max_connections") or 0 for s in counted),
            "replication_configured": bool(replicas),
            "max_replication_lag": max(lags) if lags else None,
            "failovers_90d": failovers,
            "schema_version": dbs.LATEST_VERSION,
            "tenants_behind": behind,
        },
        "servers": [_server_card(s) | {"tenant_count": sum(1 for host in host_of.values() if host is s)} for s in servers],
        "tenants": tenant_rows,
        "migrations": dbs.migration_rollout(markers),
        "backup_policy": _backup_policy(db, servers),
        "capabilities": {
            "move": False,
            "move_reason": ("Every tenant connects through the shared TENANT_DB_HOST, so a database moved to another server would not be "
                            "reachable by the application. Moves become available once per-tenant database hosts are supported."
                            if moves_possible else "Only one database server is in the platform inventory, so there is no target server. "
                            "Add servers in PLATFORM_SERVERS."),
            "failover_drill": bool(replicas),
            "sql_row_limit": dbs.SQL_ROW_LIMIT,
            "sql_timeout_seconds": dbs.SQL_TIMEOUT_SECONDS,
        },
        "sql_examples": SQL_EXAMPLES,
    }


@router.post("/migrations/{version}/continue")
def continue_migration(version: str, request: Request, db: Session = Depends(get_master_db_dep)):
    _require_platform_scope(request)
    try:
        dbs.continue_migration(version)
    except dbs.DatabaseOperationError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    _audit(db, request, "database.migration_continue", f"Rollout of database migration {version} resumed for every tenant database",
           entity_type="database_migration", entity_name=version)
    return {"version": version, "status": "Running"}


@router.post("/failover-drill")
def run_failover_drill(request: Request, db: Session = Depends(get_master_db_dep)):
    _require_platform_scope(request)
    servers = dbs.probe_all(with_qps=False)
    dbs.link_replication(servers)
    checks = dbs.failover_drill(servers, float(controls.value(db, "alertLag") or 10))
    if not checks:
        raise HTTPException(status_code=409, detail="No database server is replicating, so there is nothing to fail over to.")
    passed = all(c["passed"] for c in checks)
    _audit(db, request, "database.failover_drill", f"Failover drill {'passed' if passed else 'failed'} on {len(checks)} replica(s)",
           new={"passed": passed, "checks": checks})
    return {"passed": passed, "checks": checks}


class FailoverRequest(BaseModel):
    confirm: str


@router.post("/servers/{name}/failover")
def failover_server(name: str, data: FailoverRequest, request: Request, db: Session = Depends(get_master_db_dep)):
    _require_platform_scope(request)
    if data.confirm.strip() != name:
        raise HTTPException(status_code=400, detail="Type the server name to confirm")
    try:
        result = dbs.failover(name)
    except dbs.DatabaseOperationError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        logger.exception("Failover of %s failed", name)
        raise HTTPException(status_code=502, detail=f"Failover failed: {exc.args[-1] if exc.args else exc}")
    _audit(db, request, "database.failover", f"{result['promoted']} promoted to primary" + (f"; {result['demoted']} set read-only" if result["demoted"] else ""),
           entity_name=name, new=result)
    return result


class ResizeRequest(BaseModel):
    max_connections: Optional[int] = Field(default=None, ge=dbs.RESIZE_LIMITS["max_connections"][0], le=dbs.RESIZE_LIMITS["max_connections"][1])
    buffer_pool_mb: Optional[int] = Field(default=None, ge=dbs.RESIZE_LIMITS["buffer_pool_mb"][0], le=dbs.RESIZE_LIMITS["buffer_pool_mb"][1])


@router.post("/servers/{name}/resize")
def resize_server(name: str, data: ResizeRequest, request: Request, db: Session = Depends(get_master_db_dep)):
    _require_platform_scope(request)
    if data.max_connections is None and data.buffer_pool_mb is None:
        raise HTTPException(status_code=400, detail="Enter a new connection limit or buffer pool size")
    try:
        result = dbs.resize(name, data.max_connections, data.buffer_pool_mb)
    except dbs.DatabaseOperationError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Unable to reach {name}: {exc.args[-1] if exc.args else exc}")
    _audit(db, request, "database.resize", f"{name} resized: max_connections {result['before']['max_connections']} → {result['after']['max_connections']}, "
           f"buffer pool {result['before']['buffer_pool_mb']} → {result['after']['buffer_pool_mb']} MB", entity_name=name, new=result)
    return result


class ServerTestRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    region: str = Field(default="", max_length=100)
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=3306, ge=1, le=65535)
    user: str = Field(default="", max_length=100)
    password: str = Field(default="", max_length=200)


@router.post("/servers/test")
def test_database_server(data: ServerTestRequest, request: Request, db: Session = Depends(get_master_db_dep)):
    """Provision cluster: verify a new MariaDB instance and produce its PLATFORM_SERVERS entry."""
    _require_platform_scope(request)
    entry = {"name": data.name.strip(), "db_host": data.host.strip(), "db_port": data.port,
             "db_user": data.user.strip() or None, "db_password": data.password or None}
    try:
        result = dbs.test_server(entry)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Connection failed: {exc.args[-1] if exc.args else exc}")
    inventory = {"name": entry["name"], "region": data.region.strip() or None, "db_host": entry["db_host"], "db_port": data.port}
    if data.user.strip():
        inventory |= {"db_user": data.user.strip(), "db_password": "<password>"}
    registered = any(dbs._same_host(e["db_host"], entry["db_host"]) and int(e.get("db_port") or settings.TENANT_DB_PORT) == data.port for e in dbs.database_servers())
    _audit(db, request, "database.server_test", f"Connection test to {entry['db_host']}:{data.port} succeeded ({result['version']})", entity_name=entry["name"])
    return result | {"inventory_entry": {k: v for k, v in inventory.items() if v is not None}, "already_registered": registered}


@router.post("/restore-drill")
def run_restore_drill(request: Request, db: Session = Depends(get_master_db_dep)):
    _require_platform_scope(request)
    backup = next((b for b in db.query(TenantBackup).filter(TenantBackup.status == "completed", TenantBackup.file_name.isnot(None))
                   .order_by(TenantBackup.id.desc()).limit(20) if (BACKUP_DIR / b.file_name).is_file()), None)
    if backup is None:
        raise HTTPException(status_code=409, detail="No completed backup file is available to restore. Run a backup first.")
    tenant = db.get(Tenant, backup.tenant_id)
    label = f"{tenant.name if tenant else 'tenant ' + str(backup.tenant_id)} backup #{backup.id}"
    try:
        result = dbs.restore_drill(BACKUP_DIR / backup.file_name, f"{backup.id}_{datetime.utcnow():%Y%m%d%H%M%S}")
        description = (f"Restore drill {'passed' if result['passed'] else 'failed'} · {label} · "
                       f"{result['restored_tables']}/{result['expected_tables']} tables in {result['seconds']} s")
    except Exception as exc:
        logger.exception("Restore drill failed for backup %s", backup.id)
        result = {"passed": False, "error": str(exc.args[-1] if exc.args else exc)}
        description = f"Restore drill failed · {label} · {result['error']}"
    _audit(db, request, "database.restore_drill", description, entity_type="tenant", entity_id=backup.tenant_id,
           entity_name=tenant.name if tenant else None, new=result | {"backup_id": backup.id})
    return result | {"backup_id": backup.id, "tenant": tenant.name if tenant else None, "description": description}


class SqlRequest(BaseModel):
    sql: str = Field(max_length=dbs.SQL_MAX_LENGTH + 100)


@router.post("/tenants/{tenant_id}/sql")
def run_tenant_sql(tenant_id: int, data: SqlRequest, request: Request, db: Session = Depends(get_master_db_dep)):
    tenant = db.get(Tenant, tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    audit = lambda description, new: _audit(db, request, "database.sql_query", description, entity_type="tenant",
                                            entity_id=tenant.id, entity_name=tenant.name, new=new)
    try:
        entry, on_replica, names = dbs.locate_database(tenant.db_name)
        sql = dbs.validate_sql(data.sql, tenant.db_name, set(names))
        result = dbs.run_sql(entry, tenant.db_name, sql)
    except dbs.SqlRejected as exc:
        audit(f"SQL console statement rejected: {exc}", {"sql": data.sql[:2000], "rejected": str(exc)})
        raise HTTPException(status_code=400, detail=str(exc))
    except dbs.DatabaseOperationError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        logger.exception("SQL console failed for tenant %s", tenant.id)
        raise HTTPException(status_code=502, detail=f"Query failed: {exc.args[-1] if exc.args else exc}")
    audit(f"SQL console query on {tenant.db_name} ({entry['name']}) returned {result['row_count']} row(s)",
          {"sql": sql[:2000], "server": entry["name"], "replica": on_replica, "rows": result["row_count"]})
    return result | {"server": entry["name"], "replica": on_replica, "database": tenant.db_name}
