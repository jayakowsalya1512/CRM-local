"""Live server + database metrics for the platform Command Center.

The platform runs on self-hosted servers. The server inventory comes from the
PLATFORM_SERVERS setting (JSON list). When it is empty the inventory is derived
from the running deployment: this application host, plus the tenant database
host when it is a different machine. Each entry may define:

    name        display name (defaults to hostname / db host)
    ip          address shown in the UI
    region      site / data-centre label for the Region status table (default "On-premise")
    local       true when this process runs on that server (OS metrics via psutil)
    agent_url   base URL of the platform API on that server; OS metrics are read
                from its /api/v1/platform/infrastructure/node-metrics endpoint
    db_host     MySQL host on that server (omit when it hosts no tenant databases)
    db_port     MySQL port (default TENANT_DB_PORT)
    db_user / db_password   override TENANT_DB_USER / TENANT_DB_PASSWORD
    city        city of the site, residency  data-residency zone (e.g. "India", "EU"),
    monthly_cost  monthly running cost of the server in INR – shown in Regions & capacity when set
    planned     true for a server that is reserved for a new region but not yet set up: it is left out of the
                live inventory (never probed) and its region can be registered as Planned in Regions & capacity
"""

from __future__ import annotations

import json
import logging
import socket
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Optional

import pymysql
import requests

from app.core.config import settings

try:
    import psutil
except ImportError:  # metrics degrade to "unavailable" rather than failing the endpoint
    psutil = None

logger = logging.getLogger(__name__)

AGENT_TOKEN_HEADER = "X-Infra-Agent-Token"
DEFAULT_REGION = "On-premise"
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
_PROBE_TIMEOUT_SECONDS = 4


def _primary_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("10.255.255.255", 1))
            return sock.getsockname()[0]
    except OSError:
        try:
            return socket.gethostbyname(socket.gethostname())
        except OSError:
            return "127.0.0.1"


def _resolve(host: str) -> str:
    try:
        return socket.gethostbyname(host)
    except OSError:
        return host


def _is_local_host(host: str) -> bool:
    host = (host or "").strip().lower()
    if host in _LOCAL_HOSTS or host == socket.gethostname().lower():
        return True
    return _resolve(host) in {_primary_ip(), "127.0.0.1"}


def configured_servers() -> Optional[list[dict]]:
    """Every PLATFORM_SERVERS entry, planned ones included; None when the setting is empty or invalid."""
    raw = (settings.PLATFORM_SERVERS or "").strip()
    if raw:
        try:
            entries = json.loads(raw)
            if isinstance(entries, list) and entries:
                return [
                    {
                        **entry,
                        "name": entry.get("name") or entry.get("ip") or entry.get("db_host") or f"server-{index + 1}",
                        "ip": entry.get("ip") or (_resolve(entry["db_host"]) if entry.get("db_host") and not entry.get("planned") else ""),
                    }
                    for index, entry in enumerate(entries)
                    if isinstance(entry, dict)
                ]
        except (ValueError, KeyError):
            logger.exception("PLATFORM_SERVERS is not valid JSON; falling back to the detected inventory")
    return None


def server_inventory() -> list[dict]:
    configured = configured_servers()
    live = [entry for entry in configured or [] if not entry.get("planned")]
    if live:
        return live

    db_host = settings.TENANT_DB_HOST
    app_server = {"name": socket.gethostname(), "ip": _primary_ip(), "local": True}
    if _is_local_host(db_host):
        app_server.update({"db_host": db_host, "db_port": settings.TENANT_DB_PORT})
        return [app_server]
    return [app_server, {"name": db_host, "ip": _resolve(db_host), "db_host": db_host, "db_port": settings.TENANT_DB_PORT}]


def _disk_volumes() -> list[dict]:
    volumes = []
    for partition in psutil.disk_partitions(all=False):
        if "cdrom" in partition.opts or not partition.fstype:
            continue
        try:
            usage = psutil.disk_usage(partition.mountpoint)
        except (PermissionError, OSError):
            continue
        # Some virtual/network drives report free > total; their numbers are meaningless.
        if usage.total <= 0 or not 0 <= usage.used <= usage.total:
            continue
        volumes.append({
            "mount": partition.mountpoint,
            "percent": usage.percent,
            "used_gb": round(usage.used / 1024 ** 3, 2),
            "total_gb": round(usage.total / 1024 ** 3, 2),
        })
    return volumes


def local_node_metrics() -> dict:
    """OS metrics for the machine this process runs on."""
    if psutil is None:
        return {"available": False, "error": "psutil is not installed on this server"}
    memory = psutil.virtual_memory()
    volumes = _disk_volumes()
    fullest = max(volumes, key=lambda volume: volume["percent"], default=None)
    return {
        "available": True,
        "hostname": socket.gethostname(),
        "cpu_percent": psutil.cpu_percent(interval=0.3),
        "cpu_count": psutil.cpu_count(),
        "memory_percent": memory.percent,
        "memory_used_gb": round(memory.used / 1024 ** 3, 2),
        "memory_total_gb": round(memory.total / 1024 ** 3, 2),
        "disk_percent": fullest["percent"] if fullest else None,
        "disk_used_gb": fullest["used_gb"] if fullest else None,
        "disk_total_gb": fullest["total_gb"] if fullest else None,
        "disk_mount": fullest["mount"] if fullest else None,
        "disk_volumes": volumes,
        "uptime_seconds": int(time.time() - psutil.boot_time()),
    }


def _remote_node_metrics(agent_url: str) -> dict:
    try:
        response = requests.get(
            agent_url.rstrip("/") + "/api/v1/platform/infrastructure/node-metrics",
            headers={AGENT_TOKEN_HEADER: settings.PLATFORM_AGENT_TOKEN},
            timeout=_PROBE_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        return {"reachable": True, **response.json()}
    except Exception as exc:
        logger.warning("Infrastructure agent %s unreachable: %s", agent_url, exc)
        return {"reachable": False, "available": False, "error": "Agent unreachable"}


def _database_health(server: dict) -> Optional[dict]:
    if not server.get("db_host"):
        return None
    started = time.perf_counter()
    try:
        connection = pymysql.connect(
            host=server["db_host"],
            port=int(server.get("db_port") or settings.TENANT_DB_PORT),
            user=server.get("db_user") or settings.TENANT_DB_USER,
            password=server.get("db_password") or settings.TENANT_DB_PASSWORD,
            connect_timeout=_PROBE_TIMEOUT_SECONDS,
            read_timeout=_PROBE_TIMEOUT_SECONDS,
        )
    except Exception as exc:
        logger.warning("Database on %s unreachable: %s", server["db_host"], exc)
        return {"status": "Down", "reachable": False, "error": str(exc.args[-1] if exc.args else exc), "databases": []}
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            latency_ms = round((time.perf_counter() - started) * 1000, 1)
            cursor.execute("SELECT VERSION()")
            version = cursor.fetchone()[0]
            cursor.execute("SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Uptime','Slow_queries')")
            status = {name: int(value) for name, value in cursor.fetchall()}
            cursor.execute("SHOW VARIABLES LIKE 'max_connections'")
            max_connections = int(cursor.fetchone()[1])
            cursor.execute("SHOW DATABASES")
            databases = [row[0] for row in cursor.fetchall()]
            cursor.execute(
                "SELECT table_schema, COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables "
                "WHERE table_schema LIKE %s GROUP BY table_schema",
                (settings.TENANT_DB_PREFIX + "%",),
            )
            sizes_mb = {name: round(float(size) / 1024 ** 2, 1) for name, size in cursor.fetchall()}
    except Exception as exc:
        logger.warning("Database health query failed on %s: %s", server["db_host"], exc)
        return {"status": "Degraded", "reachable": True, "error": str(exc), "databases": []}
    finally:
        connection.close()

    connections = status.get("Threads_connected", 0)
    load = connections / max_connections * 100 if max_connections else 0
    return {
        "status": "Degraded" if latency_ms > 250 or load > 85 else "Healthy",
        "reachable": True,
        "version": version,
        "latency_ms": latency_ms,
        "connections": connections,
        "max_connections": max_connections,
        "uptime_seconds": status.get("Uptime"),
        "slow_queries": status.get("Slow_queries"),
        "databases": databases,
        "database_sizes_mb": sizes_mb,
    }


def probe_server(server: dict) -> dict:
    if server.get("local"):
        node = {"reachable": True, **local_node_metrics()}
    elif server.get("agent_url"):
        node = _remote_node_metrics(server["agent_url"])
    else:
        node = {"reachable": None, "available": False, "error": "No metrics agent configured"}
    database = _database_health(server)
    online = bool(node.get("reachable")) or bool(database and database.get("reachable"))
    return {
        "name": server["name"],
        "ip": server.get("ip") or "",
        "region": server.get("region") or DEFAULT_REGION,
        "roles": [role for role, present in (("Application", server.get("local") or server.get("agent_url")), ("Database", server.get("db_host"))) if present],
        "status": "Online" if online else "Offline",
        "metrics": node,
        "database": database,
    }


def database_placements() -> dict:
    """Which database server holds each tenant database (no OS probing).

    Returns {"servers": {name: {ip, db_host, db_port, region, health}}, "databases": {db_name: {server, size_mb}}}.
    """
    entries = [entry for entry in server_inventory() if entry.get("db_host")]
    with ThreadPoolExecutor(max_workers=max(1, min(len(entries), 8))) as pool:
        healths = list(pool.map(_database_health, entries))
    servers, databases = {}, {}
    for entry, health in zip(entries, healths):
        servers[entry["name"]] = {
            "ip": entry.get("ip") or "",
            "db_host": entry["db_host"],
            "db_port": int(entry.get("db_port") or settings.TENANT_DB_PORT),
            "region": entry.get("region") or DEFAULT_REGION,
            "health": {k: v for k, v in (health or {}).items() if k not in ("databases", "database_sizes_mb")},
        }
        for db_name in (health or {}).get("databases", []):
            databases.setdefault(db_name, {"server": entry["name"], "size_mb": (health or {}).get("database_sizes_mb", {}).get(db_name)})
    return {"servers": servers, "databases": databases}


def infrastructure_snapshot(tenants: list) -> dict:
    inventory = server_inventory()
    with ThreadPoolExecutor(max_workers=min(len(inventory), 8)) as pool:
        servers = list(pool.map(probe_server, inventory))

    default_db_server = next(
        (server["name"] for server, entry in zip(servers, inventory) if entry.get("db_host") and _resolve(entry["db_host"]) == _resolve(settings.TENANT_DB_HOST)),
        None,
    )
    tenant_rows = []
    for tenant in tenants:
        hosts = [server for server in servers if server["database"] and tenant.db_name in server["database"]["databases"]]
        host = hosts[0] if hosts else None
        if host:
            db_state = "Available"
        elif any(server["database"] and not server["database"]["reachable"] for server in servers):
            db_state = "Unreachable"
        else:
            db_state = "Missing"
        tenant_rows.append({
            "id": tenant.id,
            "name": tenant.name,
            "slug": tenant.slug,
            "db_name": tenant.db_name,
            "server": host["name"] if host else (default_db_server if db_state == "Unreachable" else None),
            "db_status": db_state,
            "db_size_mb": host["database"]["database_sizes_mb"].get(tenant.db_name) if host else None,
            "status": tenant.status,
        })

    for server in servers:
        if server["database"]:
            server["tenant_count"] = sum(1 for row in tenant_rows if row["server"] == server["name"])
            server["database"].pop("databases", None)
            server["database"].pop("database_sizes_mb", None)
        else:
            server["tenant_count"] = 0

    from app.services import platform_uptime  # local import: platform_uptime imports this module

    uptime = platform_uptime.uptime([server["name"] for server in servers])
    for server in servers:
        server["uptime_30d"] = uptime["servers"].get(server["name"])

    regions = []
    for region in dict.fromkeys(server["region"] for server in servers):
        members = [server for server in servers if server["region"] == region]
        latencies = [s["database"]["latency_ms"] for s in members if s["database"] and s["database"].get("latency_ms") is not None]
        uptimes = [s["uptime_30d"] for s in members if s["uptime_30d"] is not None]
        if all(s["status"] != "Online" for s in members):
            status = "Down"
        elif any(s["status"] != "Online" or (s["database"] and s["database"]["status"] != "Healthy") for s in members):
            status = "Degraded"
        else:
            status = "Operational"
        regions.append({
            "region": region,
            "servers": [s["name"] for s in members],
            "status": status,
            "clusters": sum(1 for s in members if s["database"]),
            "tenants": sum(s["tenant_count"] for s in members),
            "latency_ms": round(sum(latencies) / len(latencies), 1) if latencies else None,
            "uptime_30d": round(sum(uptimes) / len(uptimes), 2) if uptimes else None,
        })

    return {
        "uptime_tracked_minutes": uptime["tracked_minutes"],
        "regions": regions,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": "multi" if len(servers) > 1 else "single",
        "servers": servers,
        "tenants": tenant_rows,
    }
