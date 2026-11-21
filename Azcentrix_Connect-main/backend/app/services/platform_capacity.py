"""Capacity forecast (Infrastructure & releases → Capacity forecast).

Once an hour the platform stores, for every server of the inventory, the used and total size of its fullest disk volume
and the size of the tenant databases it holds (platform_capacity_samples, kept 400 days). Until a day of those samples
exists, the uptime probe's per-minute disk samples (platform_resource_samples, 8 days, % of the same volume) fill in
the history. The forecast is a least-squares line through the history (daily averages once it spans 3 days), projected
FORECAST_DAYS ahead and capped at the volume size. Servers without a metrics agent are measured by their database size.
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from sqlalchemy.exc import IntegrityError

from app.database import MasterSessionLocal, master_engine
from app.models.platform_monitoring import PlatformResourceSample
from app.models.platform_release import PlatformCapacitySample
from app.services import platform_infrastructure as infrastructure
from app.services.platform_monitoring import _Quiet

logger = logging.getLogger(__name__)

FORECAST_DAYS = 90
MIN_HISTORY_HOURS = 24
HISTORY_DAYS = 90
RETENTION_HOURS = 400 * 24
_schema_ready = False


def ensure_schema() -> None:
    global _schema_ready
    if not _schema_ready:
        PlatformCapacitySample.__table__.create(bind=master_engine, checkfirst=True)
        _schema_ready = True


def _measure(server: dict) -> PlatformCapacitySample:
    result = infrastructure.probe_server(server)
    metrics = result.get("metrics") or {}
    sizes = (result.get("database") or {}).get("database_sizes_mb") or {}
    return PlatformCapacitySample(server=result["name"], disk_used_gb=metrics.get("disk_used_gb") if metrics.get("available") else None,
                                  disk_total_gb=metrics.get("disk_total_gb") if metrics.get("available") else None,
                                  db_size_gb=round(sum(sizes.values()) / 1024, 3) if result.get("database") and result["database"].get("reachable") else None)


def sample(force: bool = False) -> Optional[dict]:
    """Store this hour's measurement of every server (once per hour across workers)."""
    ensure_schema()
    hour = int(time.time() // 3600)
    inventory = infrastructure.server_inventory()
    with _Quiet():
        db = MasterSessionLocal()
        try:
            done = {name for (name,) in db.query(PlatformCapacitySample.server).filter(PlatformCapacitySample.hour == hour).all()}
            todo = [s for s in inventory if s["name"] not in done]
            if not todo and not force:
                return None
            with ThreadPoolExecutor(max_workers=max(1, min(len(todo), 8))) as pool:
                rows = list(pool.map(_measure, todo))
            for row in rows:
                row.hour = hour
                db.add(row)
            if hour % 24 == 0:
                db.query(PlatformCapacitySample).filter(PlatformCapacitySample.hour < hour - RETENTION_HOURS).delete(synchronize_session=False)
            db.commit()
            return {"servers_sampled": len(rows)}
        except IntegrityError:
            db.rollback()  # another worker stored this hour first
            return None
        finally:
            db.close()


def _fit(points: list[tuple[float, float]]) -> Optional[float]:
    """Least-squares slope (GB per hour) of (hour, GB) points."""
    if len(points) < 2:
        return None
    n = len(points)
    mx = sum(x for x, _ in points) / n
    my = sum(y for _, y in points) / n
    den = sum((x - mx) ** 2 for x, _ in points)
    return sum((x - mx) * (y - my) for x, y in points) / den if den else None


def forecast() -> dict:
    ensure_schema()
    now_hour = int(time.time() // 3600)
    with _Quiet():
        db = MasterSessionLocal()
        try:
            rows = db.query(PlatformCapacitySample).filter(PlatformCapacitySample.hour > now_hour - HISTORY_DAYS * 24).order_by(PlatformCapacitySample.hour).all()
            probe_rows = db.query(PlatformResourceSample.minute, PlatformResourceSample.server, PlatformResourceSample.disk).filter(
                PlatformResourceSample.disk.isnot(None)).all()
        finally:
            db.close()

    by_server: dict[str, list[PlatformCapacitySample]] = {}
    for row in rows:
        by_server.setdefault(row.server, []).append(row)
    probe_hours: dict[str, dict[int, list[float]]] = {}
    for minute, server, disk in probe_rows:
        probe_hours.setdefault(server, {}).setdefault(minute // 60, []).append(disk)

    result = []
    for server in [s["name"] for s in infrastructure.server_inventory()]:
        samples = by_server.get(server, [])
        latest = samples[-1] if samples else None
        if latest is None:
            result.append({"server": server, "kind": None, "used_gb": None, "total_gb": None, "db_size_gb": None, "projected_gb": None,
                           "growth_gb_per_day": None, "days_to_full": None, "history_hours": 0, "reason": "Not measured yet"})
            continue
        kind = "disk" if latest.disk_used_gb is not None else "database" if latest.db_size_gb is not None else None
        if kind is None:
            result.append({"server": server, "kind": None, "used_gb": None, "total_gb": None, "db_size_gb": None, "projected_gb": None,
                           "growth_gb_per_day": None, "days_to_full": None, "history_hours": 0,
                           "reason": "No metrics agent and no reachable database on this server"})
            continue
        used, total = (latest.disk_used_gb, latest.disk_total_gb) if kind == "disk" else (latest.db_size_gb, None)
        history = {s.hour: (s.disk_used_gb if kind == "disk" else s.db_size_gb) for s in samples}
        history = {h: v for h, v in history.items() if v is not None}
        if kind == "disk" and total and min(history) > now_hour - MIN_HISTORY_HOURS:
            # Young sample table: fill in from the probe's disk % of the same volume.
            for hour, values in probe_hours.get(server, {}).items():
                history.setdefault(hour, sum(values) / len(values) / 100 * total)
        span = max(history) - min(history)
        if span >= 72:
            days: dict[int, list[float]] = {}
            for hour, value in history.items():
                days.setdefault(hour // 24, []).append(value)
            points = [(day * 24 + 12, sum(v) / len(v)) for day, v in days.items()]
        else:
            points = list(history.items())
        slope = _fit(points) if span >= MIN_HISTORY_HOURS else None
        growth = slope * 24 if slope is not None else None
        projected = None
        if growth is not None:
            projected = max(0.0, used + growth * FORECAST_DAYS)
            if total:
                projected = min(projected, total)
        days_to_full = round((total - used) / growth) if growth and growth > 0 and total else None
        result.append({
            "server": server, "kind": kind, "used_gb": round(used, 2), "total_gb": round(total, 2) if total else None,
            "db_size_gb": latest.db_size_gb, "projected_gb": round(projected, 2) if projected is not None else None,
            "growth_gb_per_day": round(growth, 3) if growth is not None else None, "days_to_full": days_to_full, "history_hours": span,
            "reason": None if growth is not None else f"Collecting history – {span} h of {MIN_HISTORY_HOURS} h needed for a forecast",
        })
    return {"forecast_days": FORECAST_DAYS, "servers": result}
