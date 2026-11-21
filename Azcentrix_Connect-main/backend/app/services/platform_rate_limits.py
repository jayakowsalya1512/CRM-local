"""Rate limits & API keys (Platform admin): KPIs, API version lifecycle and adoption, the tenant API key list.

KPIs (last 24 h unless noted):
  API calls          tenant API requests (usage meter ``api``); sparkline = daily totals of the last 7 days
  Throttled          requests refused with 429 by the API-key limiter (meter ``rate_limited``) as a share of API calls
  Active keys        keys that still authenticate (not revoked, rotation overlap not over)
  Older than 90 d    active keys created more than 90 days ago ("Rotate soon")
  p95 latency        95th percentile of every API request's response time (Monitoring histograms, all tenants)
API versions: the versions the backend serves are the ``/api/vN/`` prefixes of its routes. Each has a lifecycle row
(Current / Deprecated / Beta, sunset date); deprecating a version only adds Deprecation / Sunset response headers
(Control Center "Warn on deprecated endpoints") – it never stops serving it. Traffic = the version's share of API
requests over the last 7 days (Monitoring, per version).
"""

from __future__ import annotations

import calendar
import re
import time
from collections import Counter
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy import and_, case, func, or_
from sqlalchemy.orm import Session

from app.models.platform_api import PlatformApiKey, PlatformApiVersion
from app.models.platform_monitoring import PlatformMetricMinute, PlatformTenantUsageHour
from app.models.tenant import Tenant
from app.services import platform_api_keys as keys

STATUSES = ("Current", "Deprecated", "Beta")
PROTOTYPE_VERSIONS = [("v2", "Current"), ("v3 (beta)", "Beta")]   # shown greyed out: not served by this backend
_VERSION_RE = re.compile(r"^/api/(v\d+)/")
_versions_cache: dict = {}


class RateLimitError(Exception):
    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


def _slugs(db: Session, scope: Optional[set[int]]) -> Optional[list[str]]:
    return None if scope is None else [s for (s,) in db.query(Tenant.slug).filter(Tenant.id.in_(list(scope) or [0])).all()]


def p95_ms(db: Session, minutes: int = 1440, service: str = "api", now: Optional[float] = None) -> Optional[float]:
    from app.services import platform_monitoring as mon
    start = int((now or time.time()) // 60) - minutes
    hist: Counter = Counter()
    for (h,) in db.query(PlatformMetricMinute.hist).filter(PlatformMetricMinute.service == service, PlatformMetricMinute.minute > start).all():
        for b, n in (h or {}).items():
            hist[int(b)] += int(n)
    v = mon.percentile(hist, 0.95) if hist else None
    return round(v) if v is not None else None


def kpis(db: Session, scope: Optional[set[int]], now: Optional[datetime] = None) -> dict:
    keys.ensure_schema()
    now = now or datetime.utcnow()
    now_hour = calendar.timegm(now.timetuple()) // 3600       # ``now`` is naive UTC; .timestamp() would read it as local time
    U = PlatformTenantUsageHour
    q = db.query(U.hour, U.meter, func.sum(U.value)).filter(U.hour > now_hour - 7 * 24, U.meter.in_(("api", "rate_limited")))
    slugs = _slugs(db, scope)
    if slugs is not None:
        q = q.filter(U.tenant_slug.in_(slugs or [""]))
    api24 = limited24 = 0.0
    days = [0.0] * 7
    for hour, meter, v in q.group_by(U.hour, U.meter).all():
        age = max(0, now_hour - hour)
        if meter == "api":
            days[6 - min(6, age // 24)] += float(v or 0)
            if age < 24:
                api24 += float(v or 0)
        elif age < 24:
            limited24 += float(v or 0)
    K = PlatformApiKey
    usable = and_(K.revoked_at.is_(None), or_(K.expires_at.is_(None), K.expires_at > now))
    kq = db.query(func.coalesce(func.sum(case((usable, 1), else_=0)), 0),
                  func.coalesce(func.sum(case((and_(usable, K.created_at < now - timedelta(days=keys.ROTATE_AFTER_DAYS)), 1), else_=0)), 0))
    if scope is not None:
        kq = kq.filter(K.tenant_id.in_(list(scope) or [0]))
    active, old = kq.one()
    return {"api_calls_24h": int(api24), "api_spark": [int(d) for d in days], "throttled_requests": int(limited24),
            "throttled_pct": round(100 * limited24 / api24, 2) if api24 else None, "active_keys": int(active), "keys_older_90d": int(old),
            "p95_ms": p95_ms(db), "p95_scope": "all tenants"}


# ─── API versions ────────────────────────────────────────────────────────────

def served_versions() -> list[str]:
    """``/api/vN/`` prefixes of the routes this backend actually serves."""
    from app.main import app
    found = set()
    for path in app.openapi().get("paths", {}):
        m = _VERSION_RE.match(path)
        if m:
            found.add(m.group(1))
    return sorted(found, key=lambda v: int(v[1:]))


def versions(db: Session, served: Optional[list[str]] = None, days: int = 7) -> list[dict]:
    keys.ensure_schema()
    served = served if served is not None else served_versions()
    rows = {r.version: r for r in db.query(PlatformApiVersion).all()}
    added = False
    for v in served:
        if v not in rows:
            rows[v] = PlatformApiVersion(version=v, status="Current", updated_by="detected", updated_at=datetime.utcnow())
            db.add(rows[v])
            added = True
    if added:
        db.flush()
    start = int(time.time() // 60) - days * 1440
    traffic = {svc[4:]: int(n or 0) for svc, n in db.query(PlatformMetricMinute.service, func.sum(PlatformMetricMinute.requests))
               .filter(PlatformMetricMinute.service.like("ver:%"), PlatformMetricMinute.minute > start).group_by(PlatformMetricMinute.service).all()}
    total = sum(traffic.get(v, 0) for v in served)
    out = [{"version": v, "status": rows[v].status, "sunset": rows[v].sunset.isoformat() if rows[v].sunset else None, "implemented": True,
            "requests": traffic.get(v, 0), "traffic": round(100 * traffic.get(v, 0) / total, 1) if total else None,
            "updated_by": rows[v].updated_by} for v in served]
    out += [{"version": v, "status": st, "sunset": None, "implemented": False, "requests": None, "traffic": None, "updated_by": None}
            for v, st in PROTOTYPE_VERSIONS if v.split()[0] not in served]
    return out


def update_version(db: Session, version: str, status: Optional[str], sunset: Optional[str], clear_sunset: bool, actor: str,
                   served: Optional[list[str]] = None) -> tuple[dict, dict]:
    served = served if served is not None else served_versions()
    if version not in served:
        raise RateLimitError(f"{version} is not served by this backend", 404)
    versions(db, served)
    row = db.get(PlatformApiVersion, version)
    before = {"status": row.status, "sunset": row.sunset.isoformat() if row.sunset else None}
    if status is not None:
        if status not in STATUSES:
            raise RateLimitError("Status must be Current, Deprecated or Beta")
        row.status = status
    if clear_sunset:
        row.sunset = None
    elif sunset:
        try:
            d = date.fromisoformat(sunset)
        except ValueError:
            raise RateLimitError(f"“{sunset}” is not a date")
        if d < date.today():
            raise RateLimitError("The sunset date can't be in the past")
        row.sunset = d
    if row.status != "Deprecated" and row.sunset is not None and status is not None:
        row.sunset = None    # only a deprecated version has a sunset
    after = {"status": row.status, "sunset": row.sunset.isoformat() if row.sunset else None}
    if after != before:
        row.updated_by, row.updated_at = actor, datetime.utcnow()
        _versions_cache.clear()
    return before, after


def deprecation_headers(path: str) -> dict[str, str]:
    """Deprecation / Sunset headers for a deprecated version's responses (cached 60 s per worker; never blocks)."""
    m = _VERSION_RE.match(path)
    if not m:
        return {}
    hit = _versions_cache.get("map")
    if not hit or time.time() - hit[0] > 60:
        from app.database import MasterSessionLocal
        from app.services import platform_controls as controls
        db = MasterSessionLocal()
        try:
            warn = bool(controls.value(db, "apiDeprecate"))
            rows = {r.version: (r.status, r.sunset) for r in db.query(PlatformApiVersion).all()} if warn else {}
        except Exception:  # noqa: BLE001 – headers are advisory
            rows = {}
        finally:
            db.close()
        hit = (time.time(), rows)
        _versions_cache["map"] = hit
    st = hit[1].get(m.group(1))
    if not st or st[0] != "Deprecated":
        return {}
    out = {"Deprecation": "true"}
    if st[1]:
        out["Sunset"] = datetime.combine(st[1], datetime.min.time()).strftime("%a, %d %b %Y 00:00:00 GMT")
    return out


# ─── Keys ────────────────────────────────────────────────────────────────────

KEY_SORTS = {"t": Tenant.name, "cr": PlatformApiKey.created_at, "last": PlatformApiKey.last_used_at}


def key_page(db: Session, scope: Optional[set[int]], q: str, status: str, sort: str, offset: int, limit: int, now: Optional[datetime] = None) -> dict:
    keys.ensure_schema()
    now = now or datetime.utcnow()
    K = PlatformApiKey
    query = db.query(K, Tenant.name).join(Tenant, Tenant.id == K.tenant_id)
    if scope is not None:
        query = query.filter(K.tenant_id.in_(list(scope) or [0]))
    if q.strip():
        like = f"%{q.strip()}%"
        query = query.filter(or_(Tenant.name.like(like), K.name.like(like), K.prefix.like(like)))
    usable = and_(K.revoked_at.is_(None), or_(K.expires_at.is_(None), K.expires_at > now))
    old = K.created_at < now - timedelta(days=keys.ROTATE_AFTER_DAYS)
    if status == "Revoked":
        query = query.filter(~usable)
    elif status == "Rotate soon":
        query = query.filter(usable, or_(K.expires_at.isnot(None), old))
    elif status == "Active":
        query = query.filter(usable, K.expires_at.is_(None), ~old)
    total = query.order_by(None).count()
    order = []
    for part in [p for p in (sort or "").split(",") if ":" in p]:
        k, d = part.split(":", 1)
        col = KEY_SORTS.get(k)
        if col is not None:
            order.append(col.desc() if d.strip() == "-1" else col.asc())
    rows = query.order_by(*(order or [K.created_at.desc()]), K.id.desc()).offset(offset).limit(limit).all()
    return {"items": [key_dict(k, name, now) for k, name in rows], "total": total, "offset": offset, "limit": limit}


def _iso(v: Optional[datetime]) -> Optional[str]:
    return f"{v.replace(microsecond=0).isoformat()}Z" if v else None


def key_dict(k: PlatformApiKey, tenant_name: Optional[str], now: Optional[datetime] = None) -> dict:
    """Metadata only – never the key or its hash."""
    return {"id": k.id, "tenant_id": k.tenant_id, "tenant": tenant_name, "name": k.name, "key": keys.masked(k), "scopes": (k.scopes or "read,write").split(","),
            "user_id": k.user_id, "created": _iso(k.created_at), "created_by": k.created_by, "last_used": _iso(k.last_used_at),
            "status": keys.status(k, now), "expires_at": _iso(k.expires_at), "revoked_at": _iso(k.revoked_at), "revoked_by": k.revoked_by,
            "replaced_by_id": k.replaced_by_id}
