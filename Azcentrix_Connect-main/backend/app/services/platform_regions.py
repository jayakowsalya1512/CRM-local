"""Regions & capacity (Data & infrastructure → Regions & capacity).

Regions are the ``region`` labels of the self-hosted server registry (PLATFORM_SERVERS, see platform_infrastructure);
nothing here invents a cloud region. How the prototype's labels map onto real resources:

    Regions live          regions whose servers are in the live inventory and probe healthy
    DB shards / Shards    MariaDB servers that host tenant databases (each tenant has its own database on one of them)
    Utilisation           used ÷ total of each server's fullest disk volume, from the hourly capacity samples
                          (platform_capacity_samples, Infrastructure & releases); live probe when no sample yet
    Shards above 80%      database servers whose own utilisation is above 80 %
    Tenants               tenant databases found on the region's database servers (Tenants & Hierarchy placement)
    Latency               MariaDB round trip from this application server, measured when the page loads
    Cost / month          ``monthly_cost`` (INR) configured on the region's PLATFORM_SERVERS entries; "—" when not set
    Capacity forecast     least-squares trend of the region's utilisation history, projected monthly (dashed)

Add region registers a region whose servers are all ``planned`` in PLATFORM_SERVERS (Planned). Provisioning servers is
not automated on this deployment, so Provision stays unavailable; a region becomes Healthy only when its servers are
in the live inventory and answer the probe. Test failover runs the Databases failover drill (non-destructive replica
readiness check) for the region's servers plus a backup-readiness check of its tenants; nothing is failed over.
"""

from __future__ import annotations

import calendar
import time
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import master_engine
from app.models.platform_backup import TenantBackup
from app.models.platform_region import PlatformRegion
from app.models.platform_release import PlatformCapacitySample
from app.models.tenant import Tenant
from app.services import platform_infrastructure as infra

HIGH = 80.0                 # "Shards above 80%" and red bars
WARN = 65.0                 # amber bars (prototype)
MIN_HISTORY_HOURS = 14 * 24 # a 5-month projection needs at least two weeks of measurements
HISTORY_DAYS = 90
FORECAST_MONTHS = 5         # prototype: Now + 5 months
BACKUP_MAX_AGE_HOURS = {"Hourly": 2, "Daily": 26, "Weekly": 8 * 24, "Monthly": 32 * 24}
STATUS = {"Operational": "Healthy", "Degraded": "Degraded", "Down": "Down"}
_ready = {"schema": False}


class RegionError(Exception):
    def __init__(self, message: str, status_code: int = 409):
        super().__init__(message)
        self.status_code = status_code


def ensure_schema() -> None:
    if not _ready["schema"]:
        PlatformRegion.__table__.create(bind=master_engine, checkfirst=True)
        _ready["schema"] = True


def _utc(value: Optional[datetime]) -> Optional[str]:
    return f"{value.replace(microsecond=0).isoformat()}Z" if value else None


def _first(entries: list[dict], key: str):
    return next((e[key] for e in entries if e.get(key) not in (None, "")), None)


def _cost(entries: list[dict]) -> Optional[float]:
    values = [e["monthly_cost"] for e in entries if isinstance(e.get("monthly_cost"), (int, float)) and not isinstance(e.get("monthly_cost"), bool)]
    return float(sum(values)) if values else None


def _configured_regions() -> tuple[dict[str, list[dict]], dict[str, list[dict]]]:
    """(live region -> live entries, planned-only region -> planned entries) from the registry."""
    live: dict[str, list[dict]] = {}
    for entry in infra.server_inventory():
        live.setdefault(entry.get("region") or infra.DEFAULT_REGION, []).append(entry)
    planned: dict[str, list[dict]] = {}
    for entry in infra.configured_servers() or []:
        region = entry.get("region") or infra.DEFAULT_REGION
        if entry.get("planned") and region not in live:
            planned.setdefault(region, []).append(entry)
    return live, planned


# ─── Utilisation history ─────────────────────────────────────────────────────

def _samples(db: Session) -> list[tuple[int, str, float, float]]:
    """(hour, server, used GB, total GB) of the last HISTORY_DAYS – one indexed range query on hour."""
    since = int(time.time() // 3600) - HISTORY_DAYS * 24
    return db.query(PlatformCapacitySample.hour, PlatformCapacitySample.server, PlatformCapacitySample.disk_used_gb, PlatformCapacitySample.disk_total_gb).filter(
        PlatformCapacitySample.hour > since, PlatformCapacitySample.disk_total_gb.isnot(None), PlatformCapacitySample.disk_total_gb > 0,
        PlatformCapacitySample.disk_used_gb.isnot(None)).order_by(PlatformCapacitySample.hour).all()


def _pct(used: float, total: float) -> Optional[float]:
    return round(used / total * 100, 1) if total else None


def _fit(points: list[tuple[float, float]]) -> Optional[tuple[float, float]]:
    """Least-squares (slope per hour, intercept)."""
    if len(points) < 2:
        return None
    n = len(points)
    mx, my = sum(x for x, _ in points) / n, sum(y for _, y in points) / n
    den = sum((x - mx) ** 2 for x, _ in points)
    if not den:
        return None
    slope = sum((x - mx) * (y - my) for x, y in points) / den
    return slope, my - slope * mx


def _month_label(dt: datetime) -> str:
    return calendar.month_abbr[dt.month]


def forecast(region_servers: dict[str, list[str]], samples: list[tuple]) -> dict:
    """Prototype "Capacity forecast": measured monthly averages up to Now, then a dashed projection for 5 months."""
    now = datetime.utcnow()
    now_hour = int(time.time() // 3600)
    future = [now + timedelta(days=30.44 * k) for k in range(1, FORECAST_MONTHS + 1)]
    # Region utilisation per hour (sum of used ÷ sum of total over the region's servers sampled that hour).
    per_region: dict[str, dict[int, list[float]]] = {}
    server_region = {s: r for r, names in region_servers.items() for s in names}
    for hour, server, used, total in samples:
        region = server_region.get(server)
        if region:
            acc = per_region.setdefault(region, {}).setdefault(hour, [0.0, 0.0])
            acc[0] += used
            acc[1] += total
    past_months: list[tuple[int, int]] = []
    series, notes = [], []
    for region in region_servers:
        hours = {h: v[0] / v[1] * 100 for h, v in per_region.get(region, {}).items() if v[1]}
        if not hours:
            notes.append(f"{region}: no utilisation samples yet")
            continue
        span = max(hours) - min(hours)
        for h in hours:
            d = datetime.utcfromtimestamp(h * 3600)
            if (d.year, d.month) != (now.year, now.month) and (d.year, d.month) not in past_months:
                past_months.append((d.year, d.month))
        latest = hours[max(hours)]
        if span < MIN_HISTORY_HOURS:
            fit = None
            notes.append(f"{region}: the forecast needs {MIN_HISTORY_HOURS // 24} days of measurements – {(span + 1) / 24:.1f} days so far")
        else:
            points = list(hours.items())
            if span >= 72:  # daily averages once there are 3 days, like the Infrastructure forecast
                days: dict[int, list[float]] = {}
                for h, v in hours.items():
                    days.setdefault(h // 24, []).append(v)
                points = [(d * 24 + 12, sum(v) / len(v)) for d, v in days.items()]
            fit = _fit(points)
        series.append({"region": region, "hours": hours, "latest": latest, "fit": fit, "history_hours": span + 1})
    past_months.sort()
    past_months = past_months[-3:]
    labels = [calendar.month_abbr[m] for _, m in past_months] + ["Now"] + [_month_label(d) for d in future]
    out = []
    for s in series:
        measured: list[Optional[float]] = []
        for y, m in past_months:
            vals = [v for h, v in s["hours"].items() if (datetime.utcfromtimestamp(h * 3600).year, datetime.utcfromtimestamp(h * 3600).month) == (y, m)]
            measured.append(round(sum(vals) / len(vals), 1) if vals else None)
        measured.append(round(s["latest"], 1))
        projected: list[Optional[float]] = [None] * len(past_months)
        if s["fit"]:
            slope, _intercept = s["fit"]
            projected.append(round(s["latest"], 1))   # the projection starts from the latest measurement
            for d in future:
                ahead = (d - now).total_seconds() / 3600
                projected.append(round(max(0.0, min(100.0, s["latest"] + slope * ahead)), 1))
        out.append({"region": s["region"], "measured": measured + [None] * FORECAST_MONTHS, "projected": projected if s["fit"] else None,
                    "growth_pct_per_month": round(s["fit"][0] * 24 * 30.44, 2) if s["fit"] else None, "history_hours": s["history_hours"]})
    return {"labels": labels, "series": out, "notes": notes, "now_index": len(past_months)}


# ─── Page data ───────────────────────────────────────────────────────────────

def overview(db: Session, allowed: Optional[set[int]]) -> dict:
    ensure_schema()
    tenants = db.query(Tenant)
    if allowed is not None:
        tenants = tenants.filter(Tenant.id.in_(allowed or {0}))
    snapshot = infra.infrastructure_snapshot(tenants.order_by(Tenant.name).all())
    live, planned = _configured_regions()
    registered = {r.name: r for r in db.query(PlatformRegion).all()}
    samples = _samples(db)

    # Latest sample per server (from the same range query – no extra round trip per server).
    latest: dict[str, tuple[float, float]] = {}
    fresh_after = int(time.time() // 3600) - 3          # older samples (sampling stopped) give way to the live probe
    for hour, server, used, total in samples:
        if hour >= fresh_after:
            latest[server] = (used, total)
    servers = {s["name"]: s for s in snapshot["servers"]}

    def server_util(name: str) -> tuple[Optional[float], Optional[str]]:
        if name in latest:
            used, total = latest[name]
            return _pct(used, total), "hourly capacity sample"
        m = (servers.get(name) or {}).get("metrics") or {}
        if m.get("available") and m.get("disk_total_gb"):
            return _pct(m.get("disk_used_gb") or 0, m["disk_total_gb"]), "live probe"
        return None, None

    rows, region_servers = [], {}
    snap_regions = {r["region"]: r for r in snapshot["regions"]}
    for name, entries in live.items():
        snap = snap_regions.get(name) or {}
        names = [e["name"] for e in entries]
        region_servers[name] = names
        db_servers = [e["name"] for e in entries if e.get("db_host")]
        used = total = 0.0
        sources = set()
        per_server = []
        for n in names:
            pct, src = server_util(n)
            if n in latest:
                used += latest[n][0]; total += latest[n][1]
            elif pct is not None:
                m = servers[n]["metrics"]
                used += m.get("disk_used_gb") or 0; total += m["disk_total_gb"]
            if src:
                sources.add(src)
            per_server.append({"server": n, "utilisation": pct, "database": n in db_servers})
        status = STATUS.get(snap.get("status"), "Down")
        rows.append({
            "region": name, "city": _first(entries, "city"), "residency": _first(entries, "residency"),
            "shards": len(db_servers), "servers": names, "utilisation": _pct(used, total) if total else None,
            "utilisation_source": ", ".join(sorted(sources)) or None, "per_server": per_server,
            "tenants": snap.get("tenants", 0), "latency_ms": snap.get("latency_ms"),
            "latency_source": f"MariaDB round trip from {infra.socket.gethostname()} (measured now)" if snap.get("latency_ms") is not None else "No database server answered",
            "cost": _cost(entries), "status": status, "planned": False,
            "failover": _failover_state(len(db_servers), status),
            "last_failover": _last_failover(registered.get(name)),
        })
    for name, row in registered.items():
        if row.status == "planned" and name not in live:
            entries = planned.get(name, [])
            rows.append({
                "region": name, "city": _first(entries, "city"), "residency": _first(entries, "residency"),
                "shards": sum(1 for e in entries if e.get("db_host")), "servers": [e["name"] for e in entries], "utilisation": None, "utilisation_source": None,
                "per_server": [], "tenants": 0, "latency_ms": None, "latency_source": None, "cost": _cost(entries),
                "status": "Planned", "planned": True, "in_config": bool(entries),
                "provision": {"available": False, "reason": "Server provisioning is not automated on this self-hosted deployment. Set up the region's "
                              "servers, verify each with Databases → Provision cluster, then remove \"planned\": true from their PLATFORM_SERVERS "
                              "entries – the region turns Healthy once its servers answer the probe."},
                "failover": {"available": False, "reason": "The region has no live servers yet"}, "last_failover": None,
            })
        elif row.status == "planned" and name in live:
            row.status, row.updated_at = "active", datetime.utcnow()   # its servers are live now (seen by the probe)
    db.commit()

    live_rows = [r for r in rows if not r["planned"]]
    utils = [r["utilisation"] for r in live_rows if r["utilisation"] is not None]
    costs = [r["cost"] for r in live_rows if r["cost"] is not None]
    hot = sum(1 for r in live_rows for s in r["per_server"] if s["database"] and s["utilisation"] is not None and s["utilisation"] > HIGH)
    candidates = sorted(set(planned) - set(registered))
    return {
        "kpis": {"regions_live": sum(1 for r in live_rows if r["status"] == "Healthy"), "db_shards": sum(r["shards"] for r in live_rows),
                 "avg_utilisation": round(sum(utils) / len(utils), 1) if utils else None, "monthly_cost": sum(costs) if costs else None,
                 "shards_above_80": hot},
        "regions": rows,
        "forecast": forecast(region_servers, samples),
        "add_region": {"available": bool(candidates), "next": candidates[0] if candidates else None,
                       "reason": None if candidates else "No unregistered region in the server registry. Add the new site's servers to PLATFORM_SERVERS "
                       "with \"region\", \"city\", \"residency\", \"monthly_cost\" and \"planned\": true, then add it here."},
        "generated_at": snapshot["generated_at"],
    }


def _failover_state(db_servers: int, status: str) -> dict:
    if status == "Down":
        return {"available": False, "reason": "No server in this region answers the probe"}
    if db_servers < 2:
        return {"available": False, "reason": "This region has one database server and no replica, so there is nothing to fail over to. "
                "Add a replica in PLATFORM_SERVERS to enable failover tests."}
    return {"available": True, "reason": None}


def _last_failover(row: Optional[PlatformRegion]) -> Optional[dict]:
    if not row or not row.last_failover_at:
        return None
    return {"at": _utc(row.last_failover_at), "passed": bool((row.last_failover or {}).get("passed")), "summary": (row.last_failover or {}).get("summary")}


# ─── Actions ─────────────────────────────────────────────────────────────────

def add_region(db: Session, actor: str) -> PlatformRegion:
    """Register the next region whose servers are all planned in the registry (prototype: adds it without a form)."""
    ensure_schema()
    live, planned = _configured_regions()
    registered = {name for (name,) in db.query(PlatformRegion.name).all()}
    candidates = sorted(set(planned) - registered)
    if not candidates:
        raise RegionError("No unregistered region in the server registry – add the site's servers to PLATFORM_SERVERS with \"planned\": true first")
    name = candidates[0]
    if name in live:
        raise RegionError(f"{name} already has live servers", 409)
    row = PlatformRegion(name=name[:80], status="planned", registered_by=actor, registered_at=datetime.utcnow())
    db.add(row)
    db.flush()
    return row


def failover_test(db: Session, region: str, max_lag: float, actor: str) -> dict:
    """Non-destructive: replica readiness (Databases failover drill) + latest-backup readiness of the region's tenants."""
    from app.services import platform_controls as controls
    from app.services import platform_databases as dbs

    ensure_schema()
    live, _planned = _configured_regions()
    if region not in live:
        raise RegionError("This region has no live servers", 404 if region not in _planned else 409)
    names = {e["name"] for e in live[region]}
    db_entries = [e for e in live[region] if e.get("db_host")]
    if len(db_entries) < 2:
        raise RegionError(_failover_state(len(db_entries), "Healthy")["reason"])
    servers = dbs.probe_all(with_qps=False)
    dbs.link_replication(servers)
    checks = [c for c in dbs.failover_drill(servers, max_lag) if c["server"] in names]
    if not checks:
        raise RegionError("No database server in this region is replicating, so there is nothing to fail over to", 409)
    # Backups: every tenant whose database lives on this region's servers needs a recent, available backup.
    placements = infra.database_placements()["databases"]
    tenant_rows = db.query(Tenant.id, Tenant.name, Tenant.db_name).filter(Tenant.status != "cancelled").all()
    in_region = {t.id: t.name for t in tenant_rows if (placements.get(t.db_name) or {}).get("server") in names}
    latest_ids = (db.query(func.max(TenantBackup.id)).filter(TenantBackup.tenant_id.in_(in_region or {0}), TenantBackup.status == "completed")
                  .group_by(TenantBackup.tenant_id).subquery())
    latest = {b.tenant_id: b for b in db.query(TenantBackup).filter(TenantBackup.id.in_(latest_ids)).all()}
    from app.services.platform_backup_service import BACKUP_DIR
    max_age = timedelta(hours=BACKUP_MAX_AGE_HOURS.get(str(controls.value(db, "bkSnap", None)), 26))
    backup_problems = []
    for tid, tname in in_region.items():
        b = latest.get(tid)
        if b is None:
            backup_problems.append(f"{tname}: no completed backup")
        elif not (b.file_name and (BACKUP_DIR / b.file_name).is_file()):
            backup_problems.append(f"{tname}: latest backup file is missing")
        elif b.completed_at and datetime.utcnow() - b.completed_at > max_age:
            backup_problems.append(f"{tname}: latest backup is older than {int(max_age.total_seconds() // 3600)} h")
    passed = all(c["passed"] for c in checks) and not backup_problems
    summary = (f"Failover readiness {'passed' if passed else 'failed'}: {sum(c['passed'] for c in checks)}/{len(checks)} replica(s) ready, "
               f"{len(in_region) - len(backup_problems)}/{len(in_region)} tenant backup(s) ready")
    result = {"passed": passed, "summary": summary, "checks": checks, "backups": {"tenants": len(in_region), "problems": backup_problems}, "by": actor}
    row = db.query(PlatformRegion).filter(PlatformRegion.name == region).first()
    if row is None:
        row = PlatformRegion(name=region[:80], status="active", registered_by=actor, registered_at=datetime.utcnow())
        db.add(row)
    row.last_failover_at, row.last_failover, row.updated_at = datetime.utcnow(), result, datetime.utcnow()
    db.flush()
    return result
