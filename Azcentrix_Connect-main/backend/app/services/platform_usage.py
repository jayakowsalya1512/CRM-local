"""Usage monitoring (Data & infrastructure → Usage monitoring).

Metered hourly into platform_tenant_usage_hours (master DB):
  api          every API request of a tenant            (platform_traffic.record → record_request)
  ai           AI Smart Search questions (/search/ask)   (same hook; the only endpoint that calls the AI model)
  auth_failed  401 responses from /api/v1/auth           (same hook)
  egress_kb    response bytes of those requests (Content-Length; streamed downloads carry none) – Cost & margin egress
  email        every e-mail sent with tenant SMTP        (tenant_email_service.send_tenant_email → record_email)
  storage_mb   hourly snapshot of the tenant's document storage (Tenant.used_storage, as on Usage & Limits)
Read live from each tenant's own database (one tenant session at a time, counts only):
  active users, DAU / sign-ins (user_sessions) and records created (customers, leads, tenders, quotations);
  notification e-mails sent before metering began (notification_delivery_logs) – there is no earlier API or AI history.
OCR pages are not metered: the platform has no OCR service.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import func, text

from app.database import MasterSessionLocal, get_tenant_session, master_engine
from app.models.platform_monitoring import PlatformTenantUsageHour
from app.services.platform_monitoring import _Quiet

logger = logging.getLogger(__name__)

COUNTERS = ("api", "ai", "auth_failed", "email")
PERIOD_DAYS = {"24h": 1, "7d": 7, "30d": 30, "90d": 90}
RETENTION_HOURS = 100 * 24
TREND_DAYS, TREND_POINTS = 30, 15
IDLE_DAYS = 14
RECORD_TABLES = ("customers", "leads", "tenders", "quotations")
_TENANT_CACHE_SECONDS = 300

# ─── Collection ──────────────────────────────────────────────────────────────
_SLUG_RE = re.compile(r"^[a-z0-9_]{1,100}$")
_lock = threading.Lock()
_buffer: dict[tuple[int, str, str], float] = {}
_schema_ready = False
_last_snapshot_hour = None

_UPSERT_ADD = text("INSERT INTO platform_tenant_usage_hours (hour, tenant_slug, meter, value) VALUES (:hour, :slug, :meter, :value) "
                   "ON DUPLICATE KEY UPDATE value = value + VALUES(value)")
_UPSERT_SET = text("INSERT INTO platform_tenant_usage_hours (hour, tenant_slug, meter, value) VALUES (:hour, :slug, :meter, :value) "
                   "ON DUPLICATE KEY UPDATE value = VALUES(value)")


def ensure_schema() -> None:
    global _schema_ready
    if not _schema_ready:
        with _Quiet():
            PlatformTenantUsageHour.__table__.create(bind=master_engine, checkfirst=True)
        _schema_ready = True


def _add(slug: str, meter: str, amount: float = 1) -> None:
    key = (int(time.time() // 3600), slug[:100], meter)
    with _lock:
        _buffer[key] = _buffer.get(key, 0) + amount


def record_request(tenant_slug: Optional[str], path: str, status_code: int, bytes_out: int = 0) -> None:
    # Platform-console calls are not tenant usage, even when the host name yields a slug.
    if not tenant_slug or path.startswith("/api/v1/platform") or not _SLUG_RE.match(tenant_slug):
        return
    _add(tenant_slug, "api")
    if bytes_out > 0:
        _add(tenant_slug, "egress_kb", bytes_out / 1024)
    if path.startswith("/api/v1/search/ask"):
        _add(tenant_slug, "ai")
    if status_code == 401 and path.startswith("/api/v1/auth"):
        _add(tenant_slug, "auth_failed")


def record_email(tenant_slug: Optional[str]) -> None:
    """Count one sent e-mail. Written straight away because e-mails are also sent from Celery workers."""
    if not tenant_slug:
        return
    try:
        ensure_schema()
        with _Quiet(), master_engine.begin() as conn:
            conn.execute(_UPSERT_ADD, {"hour": int(time.time() // 3600), "slug": tenant_slug[:100], "meter": "email", "value": 1})
    except Exception:
        logger.warning("E-mail meter update failed for %s", tenant_slug, exc_info=True)


def flush() -> None:
    """Write this worker's counters; once an hour also snapshot document storage and prune old rows."""
    global _last_snapshot_hour
    with _lock:
        rows = [{"hour": h, "slug": s, "meter": m, "value": v} for (h, s, m), v in _buffer.items()]
        _buffer.clear()
    hour = int(time.time() // 3600)
    snapshot = _last_snapshot_hour != hour
    if not rows and not snapshot:
        return
    ensure_schema()
    from app.models.tenant import Tenant

    with _Quiet():
        try:
            with master_engine.begin() as conn:
                tenants = conn.execute(text("SELECT slug, used_storage FROM tenants")).fetchall()
                known = {slug for slug, _ in tenants}
                rows = [row for row in rows if row["slug"] in known]  # host names can yield slugs that are not tenants
                if rows:
                    conn.execute(_UPSERT_ADD, rows)
                if snapshot:
                    if tenants:
                        conn.execute(_UPSERT_SET, [{"hour": hour, "slug": slug, "meter": "storage_mb", "value": float(used or 0)} for slug, used in tenants])
                    conn.execute(text("DELETE FROM platform_tenant_usage_hours WHERE hour < :h"), {"h": hour - RETENTION_HOURS})
            if snapshot:
                _last_snapshot_hour = hour
        except Exception:
            logger.exception("Usage meter flush failed; %d counter(s) dropped", len(rows))


# ─── Reading meters ──────────────────────────────────────────────────────────

def _meter_rows(slugs: list[str], since_hour: int) -> list[tuple[int, str, str, float]]:
    ensure_schema()
    if not slugs:
        return []
    with _Quiet():
        db = MasterSessionLocal()
        try:
            rows = db.query(PlatformTenantUsageHour.hour, PlatformTenantUsageHour.tenant_slug, PlatformTenantUsageHour.meter, PlatformTenantUsageHour.value).filter(
                PlatformTenantUsageHour.hour >= since_hour, PlatformTenantUsageHour.tenant_slug.in_(slugs)).all()
        finally:
            db.close()
    with _lock:  # this worker's counters that are not flushed yet
        local = [(h, s, m, v) for (h, s, m), v in _buffer.items() if h >= since_hour and s in slugs]
    return [tuple(r) for r in rows] + local


def collecting_since() -> Optional[int]:
    """Unix time of the first metered hour (None before the first flush)."""
    ensure_schema()
    with _Quiet():
        db = MasterSessionLocal()
        try:
            first = db.query(func.min(PlatformTenantUsageHour.hour)).scalar()
        finally:
            db.close()
    return first * 3600 if first is not None else None


# ─── Tenant database reads ───────────────────────────────────────────────────
_tenant_cache: dict[str, tuple[float, dict]] = {}
_tenant_cache_lock = threading.Lock()


def _tenant_usage(tenant) -> dict:
    """Counts from the tenant's own database. Only aggregates leave this function."""
    result = {"available": False, "error": None, "active_users": None, "dau": None, "active_by_days": {}, "last_sign_in": None,
              "records": None, "records_by_day": {}, "emails_logged": [], "dau_buckets": None, "measured_at": None}
    try:
        session = get_tenant_session(tenant.slug)
    except Exception as exc:
        result["error"] = f"Tenant database unavailable: {type(exc).__name__}"
        return result
    try:
        with _Quiet():
            db_now = session.execute(text("SELECT NOW()")).scalar()
            result["active_users"] = int(session.execute(text("SELECT COUNT(*) FROM users WHERE is_active = 1")).scalar_one())
            sessions = session.execute(text(
                "SELECT user_id, login_time, COALESCE(logout_time, last_active) FROM user_sessions "
                "WHERE COALESCE(logout_time, last_active) >= :since"), {"since": db_now - timedelta(days=max(PERIOD_DAYS.values()))}).fetchall()
            # E-mails sent before metering began: the notification delivery log is the only record of them.
            # Seconds ago (not timestamps) so the meter start can be compared whatever the database time zone.
            if session.execute(text("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() "
                                    "AND TABLE_NAME = 'notification_delivery_logs'")).scalar_one():
                result["emails_logged"] = [int(r[0]) for r in session.execute(text(
                    "SELECT TIMESTAMPDIFF(SECOND, sent_at, :now) FROM notification_delivery_logs "
                    "WHERE channel = 'email' AND status = 'sent' AND sent_at >= :since"),
                    {"now": db_now, "since": db_now - timedelta(days=max(PERIOD_DAYS.values()))}).fetchall()]
            result["last_sign_in"] = session.execute(text("SELECT MAX(login_time) FROM user_sessions")).scalar()
            present = {r[0] for r in session.execute(text(
                "SELECT TABLE_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'created_at' "
                "AND TABLE_NAME IN ('customers', 'leads', 'tenders', 'quotations')")).fetchall()}
            records: dict[int, dict[str, int]] = {}  # days ago -> counts; plus exact 24h counts
            last_day = 0
            for table in RECORD_TABLES:
                if table not in present:
                    continue
                last_day += int(session.execute(text(f"SELECT COUNT(*) FROM `{table}` WHERE created_at >= :since"), {"since": db_now - timedelta(days=1)}).scalar_one())
                for days_ago, count in session.execute(text(
                        f"SELECT DATEDIFF(:now, created_at), COUNT(*) FROM `{table}` WHERE created_at >= :since GROUP BY DATEDIFF(:now, created_at)"),
                        {"now": db_now, "since": db_now - timedelta(days=max(PERIOD_DAYS.values()))}).fetchall():
                    records.setdefault(int(days_ago), {})[table] = int(count)
        result["records_by_day"] = {d: sum(c.values()) for d, c in records.items()}
        result["records_24h"] = last_day
        # DAU: distinct users with a session active in the last 24 h; trend buckets of 2 days over 30 days.
        bucket_days = TREND_DAYS / TREND_POINTS
        buckets: list[set] = [set() for _ in range(TREND_POINTS)]
        dau = set()
        active: dict[int, set] = {d: set() for d in PERIOD_DAYS.values()}  # distinct users active within each period
        for user_id, start, end in sessions:
            if end is None:
                continue
            if end >= db_now - timedelta(days=1):
                dau.add(user_id)
            for d, users in active.items():
                if end >= db_now - timedelta(days=d):
                    users.add(user_id)
            for b in range(TREND_POINTS):
                b_start = db_now - timedelta(days=TREND_DAYS - b * bucket_days)
                b_end = b_start + timedelta(days=bucket_days)
                if (start or end) < b_end and end >= b_start:
                    buckets[b].add(user_id)
        result.update(dau=len(dau), active_by_days={d: len(u) for d, u in active.items()}, dau_buckets=[len(b) for b in buckets], available=True,
                      measured_at=datetime.utcnow().isoformat() + "Z", last_sign_in=result["last_sign_in"].isoformat() if result["last_sign_in"] else None)
    except Exception as exc:
        logger.warning("Usage read failed for tenant %s", tenant.slug, exc_info=True)
        result["error"] = f"Usage could not be read: {type(exc).__name__}"
    finally:
        session.close()
    return result


def tenant_usage(tenant, db=None, refresh: bool = False) -> dict:
    """Cached tenant-database counts; when they are re-read, document storage is re-measured too (as Usage & Limits did)."""
    with _tenant_cache_lock:
        cached = _tenant_cache.get(tenant.slug)
    if cached and not refresh and time.time() - cached[0] < _TENANT_CACHE_SECONDS:
        return cached[1]
    value = _tenant_usage(tenant)
    if db is not None:
        from app.services.storage_usage_service import refresh_tenant_storage_usage

        try:
            refresh_tenant_storage_usage(db, tenant)
            value["storage_measured_at"] = datetime.utcnow().isoformat() + "Z"
        except Exception:
            logger.warning("Storage refresh failed for tenant %s", tenant.slug, exc_info=True)
    with _tenant_cache_lock:
        _tenant_cache[tenant.slug] = (time.time(), value)
    return value


# ─── Overview ────────────────────────────────────────────────────────────────

def _ratio(used, limit) -> Optional[float]:
    return round(used / limit * 100, 1) if used is not None and limit else None


def _limit(used, limit, source) -> dict:
    return {"used": used, "limit": limit, "remaining": max(0, limit - used) if used is not None and limit else None,
            "percent": _ratio(used, limit), "source": source}


def overview(db, tenants: list, period: str, refresh: bool = False) -> dict:
    from app.models.tenant import Plan
    from app.services import platform_controls as controls

    days = PERIOD_DAYS[period]
    now_hour = int(time.time() // 3600)
    since_period = now_hour - days * 24 + 1
    since_prev = since_period - days * 24
    since_trend = now_hour - TREND_DAYS * 24 + 1
    slugs = [t.slug for t in tenants]
    rows = _meter_rows(slugs, min(since_prev, since_trend, now_hour - 8 * 24))
    plans = {p.id: p for p in db.query(Plan).all()}
    warn = float(controls.value(db, "meterAlert") or 80)
    started = collecting_since()

    trend_span = TREND_DAYS * 24 / TREND_POINTS
    trend_bucket = lambda h: int((h - since_trend) // trend_span)

    def sums(slug: str, meter: str, start: int, end: int = now_hour) -> float:
        return sum(v for h, s, m, v in rows if s == slug and m == meter and start <= h <= end)

    def counter_trend(slug: str, meter: str) -> list[float]:
        points = [0.0] * TREND_POINTS
        for h, s, m, v in rows:
            if s == slug and m == meter and h >= since_trend:
                points[min(trend_bucket(h), TREND_POINTS - 1)] += v
        return points

    def gauge_trend(slug: str) -> list[Optional[float]]:
        latest: dict[int, tuple[int, float]] = {}
        for h, s, m, v in rows:
            if s == slug and m == "storage_mb" and h >= since_trend:
                b = min(trend_bucket(h), TREND_POINTS - 1)
                if b not in latest or h > latest[b][0]:
                    latest[b] = (h, v)
        return [round(latest[b][1] / 1024, 3) if b in latest else None for b in range(TREND_POINTS)]

    # Logged e-mails count only before the meter took over, so none is counted twice.
    metered_for = time.time() - started if started is not None else 0

    def logged_emails(live: dict, max_age: float) -> list[int]:
        return [age for age in live["emails_logged"] if metered_for < age <= max_age]

    def email_trend(live: dict, slug: str) -> list[float]:
        points = counter_trend(slug, "email")
        span = TREND_DAYS * 86400 / TREND_POINTS
        for age in logged_emails(live, TREND_DAYS * 86400):
            points[max(0, TREND_POINTS - 1 - int(age // span))] += 1
        return points

    out = []
    for tenant in tenants:
        live = tenant_usage(tenant, db, refresh)
        plan = plans.get(tenant.plan_id)
        seat_limit = tenant.max_users or (plan.max_users if plan else None)
        seat_source = "plan" if plan and seat_limit == plan.max_users else "tenant override"
        ai_overridden = "aiQuota" in (controls.tenant_overrides(db, tenant.id) or {})
        ai_quota = controls.value(db, "aiQuota", tenant.id)
        ai_30d = sums(tenant.slug, "ai", now_hour - 30 * 24 + 1)
        storage_mb = round(float(tenant.used_storage or 0), 2)
        records = None if not live["available"] else (live.get("records_24h") if days == 1 else sum(c for d, c in live["records_by_day"].items() if d < days))
        limits = {
            "users": _limit(live["active_users"], seat_limit, seat_source),
            "storage": _limit(storage_mb, tenant.storage_limit_mb or None, "tenant"),
            "ai": _limit(ai_30d, float(ai_quota) if ai_quota else None, "tenant override" if ai_overridden else "platform default"),
        }
        percents = [l["percent"] for l in limits.values() if l["percent"] is not None]
        ratio = max(percents) if percents else None
        status = None if ratio is None else "Over limit" if ratio > 100 else "Near limit" if ratio >= warn else "Healthy"
        records_trend = [0] * TREND_POINTS
        for days_ago, count in live["records_by_day"].items():
            if days_ago < TREND_DAYS:
                records_trend[min(int((TREND_DAYS - 1 - days_ago) / (TREND_DAYS / TREND_POINTS)), TREND_POINTS - 1)] += count
        out.append({
            "id": tenant.id, "name": tenant.name, "slug": tenant.slug, "status": tenant.status,
            "plan": plan.name if plan else None, "admin_email": tenant.admin_email,
            "available": live["available"], "error": live["error"], "measured_at": live["measured_at"],
            "storage_measured_at": live.get("storage_measured_at"),
            "values": {
                "api": sums(tenant.slug, "api", since_period), "dau": live["active_by_days"].get(days) if live["available"] else None, "rec": records,
                "em": sums(tenant.slug, "email", since_period) + len(logged_emails(live, days * 86400)), "ai": sums(tenant.slug, "ai", since_period),
                "gb": round(storage_mb / 1024, 3), "ocr": None,
            },
            "api_previous": sums(tenant.slug, "api", since_prev, since_period - 1),
            "auth_failed_1h": sums(tenant.slug, "auth_failed", now_hour - 1),
            "api_24h": sums(tenant.slug, "api", now_hour - 23), "api_prior_7d": sums(tenant.slug, "api", now_hour - 8 * 24 + 1, now_hour - 24),
            "limits": limits, "ratio": ratio, "usage_status": status,
            "last_sign_in": live["last_sign_in"],
            "trend": {
                "api": counter_trend(tenant.slug, "api"), "ai": counter_trend(tenant.slug, "ai"), "em": email_trend(live, tenant.slug),
                "dau": live["dau_buckets"], "rec": records_trend if live["available"] else None, "gb": gauge_trend(tenant.slug), "ocr": None,
            },
        })
    return {"tenants": out, "warn_percent": warn, "collecting_since": started,
            "previous_complete": started is not None and started <= since_prev * 3600}


def anomalies(rows: list[dict], warn: float) -> list[dict]:
    """Conditions worth a look, derived only from measured values."""
    found = []
    for r in rows:
        prior_avg = r["api_prior_7d"] / 7
        if prior_avg > 0 and r["api_24h"] >= 100 and r["api_24h"] > prior_avg * 3:
            found.append({"tenant_id": r["id"], "kind": "investigate", "text": f"{r['name']} API calls +{round((r['api_24h'] / prior_avg - 1) * 100)}% vs 7-day average"})
        seats = r["limits"]["users"]["percent"]
        if seats is not None and seats >= warn:
            found.append({"tenant_id": r["id"], "kind": "notify", "text": f"{r['name']} at {round(seats)}% of user seats"})
        storage = r["limits"]["storage"]["percent"]
        if storage is not None and storage >= warn:
            found.append({"tenant_id": r["id"], "kind": "files", "text": f"{r['name']} storage at {round(storage)}% of its limit"})
        if r["available"] and r["status"] in ("active", "trial"):
            last = datetime.fromisoformat(r["last_sign_in"]) if r["last_sign_in"] else None
            idle = (datetime.now() - last).days if last else None
            if last is None or idle >= IDLE_DAYS:
                found.append({"tenant_id": r["id"], "kind": "contact", "text": f"{r['name']} – " + (f"no sign-ins for {idle} days (churn risk)" if last else "no sign-ins yet (churn risk)")})
        if r["auth_failed_1h"] >= 50:
            found.append({"tenant_id": r["id"], "kind": "case", "text": f"Burst of {int(r['auth_failed_1h']):,} failed sign-ins in the last hour at {r['name']}"})
    return found
