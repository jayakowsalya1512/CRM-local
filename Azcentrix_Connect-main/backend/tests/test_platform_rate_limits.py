import multiprocessing as mp
import os
import random
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from types import SimpleNamespace as NS

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

os.environ.setdefault("DEBUG", "false")

from app import dependencies
from app.database import get_master_db_dep
from app.models.platform_api import PlatformApiKey, PlatformApiVersion, PlatformPlanRateLimit
from app.models.platform_monitoring import PlatformMetricMinute, PlatformTenantUsageHour
from app.models.tenant import Plan, PlatformAuditLog, SuperAdmin, Tenant
from app.routers import platform_rate_limits_router
from app.services import platform_api_keys as keys
from app.services import platform_monitoring as mon
from app.services import platform_rate_limits as rl
from app.services.platform_access import enforce_platform_access


# ─── Redis limiter (real Redis shared by threads and processes) ──────────────

def _redis_up() -> bool:
    try:
        return keys._client().registered_client.ping()
    except Exception:
        return False


redis_only = pytest.mark.skipif(not _redis_up(), reason="Redis is not reachable")


@pytest.fixture
def tid():
    t = random.randint(10**8, 10**9)
    yield t
    c = keys._redis["client"]
    for k in c.scan_iter(f"azx:rl:*:{t}*"):
        c.delete(k)


@redis_only
def test_burst_then_refill(tid):
    now = time.time()
    results = [keys.take(tid, 60, 5, 0, now=now)[0] for _ in range(7)]
    assert results == [True] * 5 + [False] * 2                       # burst of 5, then refused
    allowed, wait, reason, _ = keys.take(tid, 60, 5, 0, now=now)
    assert not allowed and reason == "minute" and wait == 1            # 60/min → one token per second
    assert keys.take(tid, 60, 5, 0, now=now + 1.01)[0]                 # refilled after a second


@redis_only
def test_daily_cap_and_retry_after_until_ist_midnight(tid):
    now = datetime(2026, 11, 4, 18, 0).timestamp()                     # utcfromtimestamp(now) + 5:30 → IST
    local = datetime.utcfromtimestamp(now) + timedelta(hours=5, minutes=30)
    to_midnight = ((datetime(local.year, local.month, local.day) + timedelta(days=1)) - local).total_seconds()
    got = [keys.take(tid, 6000, 100, 3, now=now) for _ in range(4)]
    assert [g[0] for g in got] == [True, True, True, False]
    assert [g[3] for g in got[:3]] == [2, 1, 0]
    assert got[3][2] == "daily" and abs(got[3][1] - to_midnight) <= 1
    assert keys.take(tid, 6000, 100, 3, now=now + to_midnight + 1)[0]   # a new IST day


@redis_only
def test_concurrent_threads_never_exceed_burst(tid):
    now = time.time()
    with ThreadPoolExecutor(max_workers=16) as pool:
        out = list(pool.map(lambda _: keys.take(tid, 1, 25, 0, now=now)[0], range(200)))
    assert sum(out) == 25


def _worker(args):
    tenant, now, n = args
    from app.services import platform_api_keys as k
    k._redis.clear()
    return sum(k.take(tenant, 1, 40, 0, now=now)[0] for _ in range(n))


@redis_only
def test_concurrent_processes_share_one_limit(tid):
    now = time.time()
    with mp.get_context("spawn").Pool(4) as pool:                      # separate interpreters = separate API workers
        allowed = sum(pool.map(_worker, [(tid, now, 30)] * 4))
    assert allowed == 40


def test_limiter_fails_open_when_redis_is_down(monkeypatch):
    def broken(**_):
        raise ConnectionError("down")
    monkeypatch.setitem(keys._redis, "script", broken)
    monkeypatch.setitem(keys._redis, "client", object())
    assert keys.take(1, 1, 1, 1) == (True, 0, "", None)


# ─── Database fixtures ───────────────────────────────────────────────────────

@pytest.fixture
def env(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    for m in (Plan, Tenant, SuperAdmin, PlatformAuditLog, PlatformApiKey, PlatformPlanRateLimit, PlatformApiVersion, PlatformTenantUsageHour, PlatformMetricMinute):
        m.__table__.create(bind=engine)
    monkeypatch.setattr(keys, "master_engine", engine)
    monkeypatch.setitem(keys._ready, "schema", True)
    keys._limit_cache.clear()
    settings = {"apiKeyOverlap": 24, "rlOn": True}
    monkeypatch.setattr(keys, "_setting", lambda db, key, default: settings.get(key, default))
    Session = sessionmaker(bind=engine)
    db = Session()
    for i, (name, slug, price) in enumerate([("Core", "core", 100), ("Standard", "standard", 200), ("Premium", "premium", 300), ("Enterprise", "enterprise", 400)], 1):
        db.add(Plan(id=i, name=name, slug=slug, price_monthly=price, price_yearly=0, max_users=5, is_active=True))
    for t, plan in ((1, 1), (2, 4)):
        db.add(Tenant(id=t, name=f"Tenant {t}", slug=f"t{t}", subdomain=f"t{t}", plan_id=plan, status="active", admin_email="a@x.in", admin_name="A", db_name=f"d{t}"))
    db.commit()
    yield NS(db=db, Session=Session, engine=engine, settings=settings)
    db.close()


def test_indexes(env):
    ix = {i["name"]: i["column_names"] for i in inspect(env.engine).get_indexes("platform_api_keys")}
    assert ix["ix_platform_api_keys_state"] == ["revoked_at", "expires_at", "created_at"]
    assert ix["ix_platform_api_keys_tenant_id"] == ["tenant_id"]
    assert any(u["column_names"] == ["prefix"] for u in inspect(env.engine).get_unique_constraints("platform_api_keys")) or \
        any(i["column_names"] == ["prefix"] and i["unique"] for i in inspect(env.engine).get_indexes("platform_api_keys"))


# ─── Plan limits ─────────────────────────────────────────────────────────────

def test_plan_limits_seeded_and_updated(env):
    p = {x["plan"]: x for x in keys.plan_limits(env.db)}
    assert [p[n]["daily_cap"] for n in ("Core", "Standard", "Premium", "Enterprise")] == [20_000, 200_000, 1_000_000, 3_000_000]
    before, after = keys.update_plan_limit(env.db, 1, {"per_minute": 90, "burst": 180}, "ops")
    assert before["per_minute"] == 120 and after == {"per_minute": 90, "burst": 180, "daily_cap": 20_000}
    for bad in ({"per_minute": 0}, {"per_minute": 100_001}, {"burst": -1}, {"burst": 1.5}, {"daily_cap": -5}, {"per_minute": True}):
        with pytest.raises(keys.ApiKeyError):
            keys.update_plan_limit(env.db, 1, bad, "ops")
    with pytest.raises(keys.ApiKeyError) as e:
        keys.update_plan_limit(env.db, 99, {"per_minute": 5}, "ops")
    assert e.value.status_code == 404


def test_tenant_limit_cache_is_invalidated_on_update(env):
    t = env.db.get(Tenant, 1)
    keys.plan_limits(env.db)
    assert keys.tenant_limit(env.db, t) == (120, 200, 20_000)
    keys.update_plan_limit(env.db, 1, {"per_minute": 10}, "ops")
    assert keys.tenant_limit(env.db, t)[0] == 10


# ─── Keys ────────────────────────────────────────────────────────────────────

def issue(env, tenant=1, scopes="read,write", created=None):
    row, raw = keys._issue(env.db, tenant, 7, "ERP", scopes, "ops")
    if created:
        row.created_at = created
    env.db.commit()
    return row, raw


def test_secure_generation_and_hash_only_storage(env):
    rows = [issue(env) for _ in range(20)]
    raws = {raw for _, raw in rows}
    assert len(raws) == 20 and all(r.startswith("azx_") and len(r) >= 46 for r in raws)   # 32 random bytes, url-safe
    row, raw = rows[0]
    stored = [str(getattr(row, c.name)) for c in PlatformApiKey.__table__.columns]
    assert raw not in stored and raw[14:-4] not in "".join(stored)
    assert row.key_hash == keys._digest(raw) and len(row.key_hash) == 64
    assert keys.masked(row) == f"{raw[:14]}••••••••{raw[-4:]}"
    assert keys.verify(env.db, raw).id == row.id and keys.verify(env.db, raw[:-1] + ("A" if raw[-1] != "A" else "B")) is None


def test_scopes(env):
    assert keys.parse_scopes(["read"]) == "read" and keys.parse_scopes(["write", "read"]) == "read,write" and keys.parse_scopes(["write"]) == "read,write"
    for bad in ([], ["admin"], None):
        with pytest.raises(keys.ApiKeyError):
            keys.parse_scopes(bad)
    ro, _ = issue(env, scopes="read")
    assert keys.allows(ro, "GET") and keys.allows(ro, "head") and not keys.allows(ro, "POST") and not keys.allows(ro, "DELETE")
    rw, _ = issue(env)
    assert keys.allows(rw, "POST")


def test_rotation_overlap_then_expiry(env):
    row, raw = issue(env)
    now = datetime.utcnow()
    new, new_raw, hours = keys.rotate(env.db, row, "ops", now=now)
    env.db.commit()
    assert hours == 24 and row.expires_at == now + timedelta(hours=24) and row.replaced_by_id == new.id
    assert (new.tenant_id, new.user_id, new.name, new.scopes) == (row.tenant_id, row.user_id, row.name, row.scopes)
    assert keys.verify(env.db, raw) is not None and keys.verify(env.db, new_raw) is not None    # both work during the overlap
    assert keys.status(row) == "Rotate soon" and keys.status(new) == "Active"
    with pytest.raises(keys.ApiKeyError):
        keys.rotate(env.db, row, "ops")                                                         # rotate the replacement instead
    row.expires_at = datetime.utcnow() - timedelta(seconds=1)
    env.db.commit()
    assert keys.verify(env.db, raw) is None and keys.status(row) == "Revoked"


def test_rotation_without_overlap(env):
    env.settings["apiKeyOverlap"] = 0
    row, raw = issue(env)
    keys.rotate(env.db, row, "ops")
    env.db.commit()
    assert keys.verify(env.db, raw) is None and row.revoked_at is not None


def test_revocation_is_immediate(env):
    row, raw = issue(env)
    assert keys.verify(env.db, raw) is not None
    keys.revoke(env.db, row, "ops")
    env.db.commit()
    assert keys.verify(env.db, raw) is None and keys.status(row) == "Revoked"
    with pytest.raises(keys.ApiKeyError):
        keys.revoke(env.db, row, "ops")
    with pytest.raises(keys.ApiKeyError):
        keys.rotate(env.db, row, "ops")


def test_rotate_soon_after_90_days(env):
    row, _ = issue(env, created=datetime.utcnow() - timedelta(days=91))
    assert keys.status(row) == "Rotate soon"


# ─── Request pipeline (get_current_user → _api_key_user) ────────────────────

class _UserQuery:
    def __init__(self, user):
        self.user = user

    def filter(self, *_):
        return self

    def first(self):
        return self.user


def call(env, raw, method="GET", slug="t1"):
    req = NS(method=method, state=NS(tenant_slug=slug), headers={}, query_params={})
    user = NS(id=7, email="api@x.in", is_active=True)
    tenant_db = NS(query=lambda _m: _UserQuery(user))
    return dependencies._api_key_user(req, raw, tenant_db, env.db), req


@pytest.fixture
def pipeline(env, monkeypatch):
    monkeypatch.setattr("app.services.platform_trust_safety.blocked_sign_in", lambda *a: False)
    taken = {"allow": True, "reason": "minute", "wait": 7}
    monkeypatch.setattr(keys, "take", lambda tid, pm, b, d=0: (True, 0, "", None) if taken["allow"] else (False, taken["wait"], taken["reason"], 0))
    limited = []
    monkeypatch.setattr(keys, "record_limited", lambda slug: limited.append(slug))
    return NS(taken=taken, limited=limited)


def test_pipeline_authenticates_and_tracks_last_used(env, pipeline):
    row, raw = issue(env)
    assert row.last_used_at is None
    user, req = call(env, raw)
    assert user.id == 7 and req.state.api_key_id == row.id
    env.db.refresh(row)
    assert row.last_used_at is not None and datetime.utcnow() - row.last_used_at < timedelta(seconds=5)


def test_pipeline_tenant_isolation_revocation_and_scope(env, pipeline):
    row, raw = issue(env)
    with pytest.raises(HTTPException) as e:
        call(env, raw, slug="t2")                                           # key of tenant 1 used on tenant 2
    assert e.value.status_code == 401
    ro, ro_raw = issue(env, scopes="read")
    with pytest.raises(HTTPException) as e:
        call(env, ro_raw, method="POST")
    assert e.value.status_code == 403
    assert call(env, ro_raw, method="GET")[0].id == 7
    keys.revoke(env.db, row, "ops")
    env.db.commit()
    with pytest.raises(HTTPException) as e:
        call(env, raw)
    assert e.value.status_code == 401


def test_pipeline_returns_429_with_retry_after(env, pipeline):
    _, raw = issue(env)
    keys.plan_limits(env.db)
    pipeline.taken.update(allow=False, reason="minute", wait=7)
    with pytest.raises(HTTPException) as e:
        call(env, raw)
    assert e.value.status_code == 429 and e.value.headers["Retry-After"] == "7" and e.value.headers["X-RateLimit-Limit"] == "120"
    assert e.value.headers["X-RateLimit-Daily-Limit"] == "20000" and pipeline.limited == ["t1"]
    pipeline.taken.update(reason="daily", wait=3600)
    with pytest.raises(HTTPException) as e:
        call(env, raw)
    assert e.value.status_code == 429 and "Daily API cap" in e.value.detail and e.value.headers["Retry-After"] == "3600"
    env.settings["rlOn"] = False                                            # "Enable rate limiting" off
    keys._limit_cache.clear()
    assert call(env, raw)[0].id == 7


# ─── KPIs, versions, list ────────────────────────────────────────────────────

def test_kpis_and_p95(env):
    h = int(time.time() // 3600)                                           # meter hours are real unix hours
    now = datetime.utcfromtimestamp(h * 3600 + 1800)                       # naive UTC, as the API passes it
    db = env.db
    for hour, slug, meter, v in [(h, "t1", "api", 900), (h - 5, "t2", "api", 100), (h, "t1", "rate_limited", 4), (h - 30, "t1", "api", 500), (h - 30, "t1", "rate_limited", 50)]:
        db.add(PlatformTenantUsageHour(hour=hour, tenant_slug=slug, meter=meter, value=v))
    minute = int(time.time() // 60)
    db.add(PlatformMetricMinute(minute=minute - 1, service="api", worker="w1", requests=100, errors=0, hist={str(mon.bucket(50)): 90, str(mon.bucket(400)): 10}))
    db.add(PlatformMetricMinute(minute=minute - 2, service="api", worker="w2", requests=100, errors=0, hist={str(mon.bucket(50)): 100}))
    issue(env)
    issue(env, created=now - timedelta(days=100))
    r, _ = issue(env, tenant=2)
    keys.revoke(db, r, "ops")
    db.commit()
    k = rl.kpis(db, None, now)
    assert k["api_calls_24h"] == 1000 and k["throttled_requests"] == 4 and k["throttled_pct"] == 0.4
    assert k["api_spark"][-1] == 1000 and k["api_spark"][-2] == 500
    assert k["active_keys"] == 2 and k["keys_older_90d"] == 1
    # 200 requests: 190 at ~50 ms, 10 at ~400 ms → the 95th percentile is in the 50 ms bucket (±5 %)
    assert k["p95_ms"] == round(mon.percentile(__import__("collections").Counter({mon.bucket(50): 190, mon.bucket(400): 10}), 0.95))
    assert abs(k["p95_ms"] - 50) <= 3
    scoped = rl.kpis(db, {2}, now)
    assert scoped["api_calls_24h"] == 100 and scoped["active_keys"] == 0


def test_versions_real_and_prototype(env):
    m = int(time.time() // 60)
    env.db.add(PlatformMetricMinute(minute=m - 3, service="ver:v1", worker="w", requests=40, errors=0, hist={}))
    env.db.commit()
    v = rl.versions(env.db, served=["v1"])
    assert v[0] == {**v[0], "version": "v1", "status": "Current", "implemented": True, "requests": 40, "traffic": 100.0}
    assert [(x["version"], x["implemented"], x["traffic"]) for x in v[1:]] == [("v2", False, None), ("v3 (beta)", False, None)]
    before, after = rl.update_version(env.db, "v1", "Deprecated", (datetime.utcnow() + timedelta(days=60)).date().isoformat(), False, "ops", served=["v1"])
    assert before["status"] == "Current" and after["status"] == "Deprecated" and after["sunset"]
    with pytest.raises(rl.RateLimitError):
        rl.update_version(env.db, "v2", "Current", None, False, "ops", served=["v1"])        # not served → can't be configured
    with pytest.raises(rl.RateLimitError):
        rl.update_version(env.db, "v1", None, "2020-01-01", False, "ops", served=["v1"])


def test_deprecation_headers_never_block(env, monkeypatch):
    rl._versions_cache["map"] = (time.time(), {"v1": ("Deprecated", datetime(2027, 1, 31).date())})
    assert rl.deprecation_headers("/api/v1/leads") == {"Deprecation": "true", "Sunset": "Sun, 31 Jan 2027 00:00:00 GMT"}
    rl._versions_cache["map"] = (time.time(), {"v1": ("Current", None)})
    assert rl.deprecation_headers("/api/v1/leads") == {} and rl.deprecation_headers("/health") == {}
    rl._versions_cache.clear()


def test_key_page_filters_and_never_returns_secrets(env):
    a, raw = issue(env)
    issue(env, tenant=2)
    issue(env, created=datetime.utcnow() - timedelta(days=95))
    p = rl.key_page(env.db, None, "", "", "", 0, 25)
    assert p["total"] == 3
    blob = str(p)
    assert raw not in blob and a.key_hash not in blob and "key_hash" not in blob
    assert rl.key_page(env.db, {2}, "", "", "", 0, 25)["total"] == 1
    assert rl.key_page(env.db, None, "", "Rotate soon", "", 0, 25)["total"] == 1
    assert rl.key_page(env.db, None, "", "Active", "", 0, 25)["total"] == 2
    assert rl.key_page(env.db, None, "Tenant 2", "", "", 0, 25)["total"] == 1


# ─── API ─────────────────────────────────────────────────────────────────────

@pytest.fixture
def client(env, monkeypatch):
    app = FastAPI()
    app.include_router(platform_rate_limits_router.router)
    app.dependency_overrides[enforce_platform_access] = lambda: None

    def db_dep():
        s = env.Session()
        try:
            yield s
        finally:
            s.close()
    app.dependency_overrides[get_master_db_dep] = db_dep
    scope = {"ids": None}
    monkeypatch.setattr(platform_rate_limits_router, "scoped_tenant_ids", lambda request: scope["ids"])
    monkeypatch.setattr(platform_rate_limits_router, "_get_platform_admin", lambda request: NS(id=None, email="ops@platform.in"))
    monkeypatch.setattr(rl, "served_versions", lambda: ["v1"])
    return NS(c=TestClient(app), scope=scope)


def audits(env, action):
    s = env.Session()
    try:
        return s.query(PlatformAuditLog).filter(PlatformAuditLog.action == action).all()
    finally:
        s.close()


def test_api_overview_limits_versions(env, client):
    r = client.c.get("/api/v1/platform/api-webhooks/rate-limits")
    assert r.status_code == 200
    j = r.json()
    assert set(j["kpis"]) >= {"api_calls_24h", "throttled_pct", "active_keys", "keys_older_90d", "p95_ms"} and j["overlap_hours"] == 24
    assert [p["plan"] for p in j["plans"]] == ["Core", "Standard", "Premium", "Enterprise"] and len(j["versions"]) == 3
    r = client.c.put("/api/v1/platform/api-webhooks/rate-limits/plans/1", json={"per_minute": 60, "burst": 120})
    assert r.status_code == 200 and r.json()["plan"]["per_minute"] == 60 and r.json()["changed"]
    assert client.c.put("/api/v1/platform/api-webhooks/rate-limits/plans/1", json={"burst": 0}).status_code == 422
    a = audits(env, "rate_limit_updated")
    assert len(a) == 1 and a[0].old_data["per_minute"] == 120 and a[0].new_data["burst"] == 120
    r = client.c.put("/api/v1/platform/api-webhooks/versions/v1", json={"status": "Deprecated"})
    assert r.status_code == 200 and r.json()["status"] == "Deprecated" and len(audits(env, "api_version_updated")) == 1
    client.scope["ids"] = {1}
    assert client.c.put("/api/v1/platform/api-webhooks/rate-limits/plans/1", json={"per_minute": 5}).status_code == 403
    assert client.c.put("/api/v1/platform/api-webhooks/versions/v1", json={"status": "Current"}).status_code == 403
    for path in ("rate-limits/kpis", "rate-limits/plans", "versions", "api-keys"):
        assert client.c.get(f"/api/v1/platform/api-webhooks/{path}").status_code == 200, path


def test_api_rotate_and_revoke(env, client):
    row, raw = issue(env)
    other, _ = issue(env, tenant=2)
    r = client.c.post(f"/api/v1/platform/api-webhooks/api-keys/{row.id}/rotate")
    assert r.status_code == 200
    j = r.json()
    new_raw = j["key"]
    assert new_raw.startswith("azx_") and new_raw != raw and j["overlap_hours"] == 24 and j["old"]["status"] == "Rotate soon"
    listing = client.c.get("/api/v1/platform/api-webhooks/api-keys").text
    assert new_raw not in listing and raw not in listing                       # shown once, never listed
    a = audits(env, "rotate_api_key")
    assert len(a) == 1 and a[0].new_data["overlap_hours"] == 24 and new_raw not in str(a[0].new_data) and new_raw not in a[0].description
    assert client.c.post(f"/api/v1/platform/api-webhooks/api-keys/{row.id}/revoke", json={}).status_code == 428   # confirmation required
    r = client.c.post(f"/api/v1/platform/api-webhooks/api-keys/{j['new']['id']}/revoke", json={"confirm": True, "reason": "leaked"})
    assert r.status_code == 200 and r.json()["status"] == "Revoked"
    s = env.Session()
    assert keys.verify(s, new_raw) is None
    s.close()
    assert len(audits(env, "revoke_api_key")) == 1
    client.scope["ids"] = {1}
    assert client.c.post(f"/api/v1/platform/api-webhooks/api-keys/{other.id}/revoke", json={"confirm": True}).status_code == 404   # other tenant
    assert client.c.get("/api/v1/platform/api-webhooks/api-keys").json()["total"] == 2
