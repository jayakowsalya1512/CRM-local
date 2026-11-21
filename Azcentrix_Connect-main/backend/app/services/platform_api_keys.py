"""Tenant API keys and per-plan API rate limits (Platform admin → API & webhooks, Rate limits & API keys).

* A key (``azx_…``) signs in to its tenant's API as one tenant user. Only HMAC-SHA256(SECRET_KEY, key) is stored, plus
  the first characters (lookup) and last four (masked display); the key is shown once, at creation or rotation.
  Comparison is constant-time. Scopes: ``read`` keys may only make GET / HEAD / OPTIONS requests; ``read,write`` keys
  may make any request their user is allowed to make.
* Rotation issues a new key with the same tenant, user, name and scopes; the old key keeps working for the rotation
  overlap (Control Center → Rate limiting & API, "API key rotation overlap", default 24 h), then stops. Revocation
  stops a key at once – every request re-reads the key row, so no cache can keep a revoked key alive.
* Requests made with an API key are rate-limited per tenant by the tenant's plan, in one atomic Redis script shared by
  every API worker and instance: a token bucket holding ``burst`` tokens refilling at ``per_minute`` per minute, and a
  daily cap counted per India Standard Time day (0 = no cap). Plan limits are cached for 30 s per worker, so a change
  applies everywhere within 30 s. The CRM's own web and mobile sign-ins (JWT) are never limited. Refused requests get
  HTTP 429 with Retry-After and are counted in the usage meters (``rate_limited``). "Enable rate limiting" off (Control
  Center) skips the limiter. If Redis can't be reached the request is allowed and the failure logged.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import time
from datetime import datetime, timedelta
from typing import Optional

import redis
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.database import get_tenant_session, master_engine
from app.models.platform_api import PlatformApiKey, PlatformApiVersion, PlatformPlanRateLimit
from app.models.tenant import Plan, Tenant

logger = logging.getLogger(__name__)

KEY_PREFIX = "azx_"
LOOKUP_CHARS = 14
SCOPES = ("read", "write")
READ_METHODS = ("GET", "HEAD", "OPTIONS")
ROTATE_AFTER_DAYS = 90
LIMIT_CACHE_SECONDS = 30
# Prototype tiers (requests / min, burst). Starting limits for this deployment's plans (as agreed); any other plan
# gets the tier of its price position. Stored once per plan, then the stored value is what applies.
TIERS = [(120, 200), (300, 500), (600, 1200), (1500, 3000)]
DAILY_CAPS = [20_000, 200_000, 1_000_000, 3_000_000]       # prototype daily caps of the same tiers
TIER_BY_SLUG = {"core": 0, "standard": 1, "test": 1, "premium": 2, "enterprise": 3}
MAX_PER_MINUTE, MAX_BURST, MAX_DAILY = 100_000, 1_000_000, 1_000_000_000
IST = timedelta(hours=5, minutes=30)
_ready: dict[str, bool] = {}
_limit_cache: dict = {}


def ensure_schema() -> None:
    if _ready.get("schema"):
        return
    for model in (PlatformApiKey, PlatformPlanRateLimit, PlatformApiVersion):
        model.__table__.create(bind=master_engine, checkfirst=True)
    ins = inspect(master_engine)
    key_cols = {c["name"] for c in ins.get_columns("platform_api_keys")}
    wanted = [("scopes", "ADD COLUMN scopes VARCHAR(40) NOT NULL DEFAULT 'read,write'"), ("last4", "ADD COLUMN last4 VARCHAR(4) NULL"),
              ("expires_at", "ADD COLUMN expires_at DATETIME NULL"), ("replaced_by_id", "ADD COLUMN replaced_by_id INT NULL"),
              ("revoked_by", "ADD COLUMN revoked_by VARCHAR(255) NULL")]
    missing = [sql for name, sql in wanted if name not in key_cols]
    if missing:   # existing keys keep full access (read,write), as before scopes existed
        if "ix_platform_api_keys_state" not in {i["name"] for i in ins.get_indexes("platform_api_keys")}:
            missing.append("ADD INDEX ix_platform_api_keys_state (revoked_at, expires_at, created_at)")
        with master_engine.begin() as conn:
            conn.execute(text("ALTER TABLE platform_api_keys " + ", ".join(missing)))
    if "daily_cap" not in {c["name"] for c in ins.get_columns("platform_plan_rate_limits")}:
        with master_engine.begin() as conn:
            conn.execute(text("ALTER TABLE platform_plan_rate_limits ADD COLUMN daily_cap INT NOT NULL DEFAULT 0"))
            conn.execute(text("UPDATE platform_plan_rate_limits l JOIN plans p ON p.id = l.plan_id SET l.daily_cap = CASE p.slug "
                              "WHEN 'core' THEN :a WHEN 'standard' THEN :b WHEN 'test' THEN :b WHEN 'premium' THEN :c WHEN 'enterprise' THEN :d ELSE :a END"),
                         dict(zip("abcd", DAILY_CAPS)))
    _ready["schema"] = True


class ApiKeyError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def _digest(raw: str) -> str:
    return hmac.new(settings.SECRET_KEY.encode(), raw.encode(), hashlib.sha256).hexdigest()


def _setting(db: Session, key: str, default):
    from app.services import platform_controls as controls
    try:
        v = controls.value(db, key)
    except Exception:  # noqa: BLE001 – an unreadable setting falls back to its default
        return default
    return default if v is None else v


# ─── Plan limits ─────────────────────────────────────────────────────────────

def _tier_for(rank: int, count: int) -> int:
    """Spread the prototype tiers over the plans by price: cheapest → first tier, most expensive → last tier."""
    return 0 if count <= 1 else round(rank * (len(TIERS) - 1) / (count - 1))


def plan_limits(db: Session) -> list[dict]:
    """Every active plan (by price) with its stored limit; plans without one get their price tier, stored once."""
    ensure_schema()
    plans = db.query(Plan).filter(Plan.is_active == True).order_by(Plan.price_monthly, Plan.id).all()  # noqa: E712
    stored = {r.plan_id: r for r in db.query(PlatformPlanRateLimit).filter(PlatformPlanRateLimit.plan_id.in_([p.id for p in plans] or [0])).all()}
    out, added = [], False
    for rank, plan in enumerate(plans):
        row = stored.get(plan.id)
        if row is None:
            tier = TIER_BY_SLUG.get(plan.slug, _tier_for(rank, len(plans)))
            row = PlatformPlanRateLimit(plan_id=plan.id, per_minute=TIERS[tier][0], burst=TIERS[tier][1], daily_cap=DAILY_CAPS[tier],
                                        updated_by="default (price tier)", updated_at=datetime.utcnow())
            db.add(row)
            added = True
        out.append({"plan_id": plan.id, "plan": plan.name, "per_minute": row.per_minute, "burst": row.burst, "daily_cap": row.daily_cap,
                    "updated_by": row.updated_by, "updated_at": f"{row.updated_at.replace(microsecond=0).isoformat()}Z" if row.updated_at else None})
    if added:
        db.flush()
    return out


def _whole(v, label: str, lo: int, hi: int) -> int:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or float(v) != int(v):
        raise ApiKeyError(f"{label} must be a whole number", 422)
    if not lo <= int(v) <= hi:
        raise ApiKeyError(f"{label} must be between {lo:,} and {hi:,}", 422)
    return int(v)


def update_plan_limit(db: Session, plan_id: int, changes: dict, actor: str) -> tuple[dict, dict]:
    """Validate and store a plan's limits; returns (before, after). The limiter picks it up within LIMIT_CACHE_SECONDS."""
    plan_limits(db)
    row = db.get(PlatformPlanRateLimit, plan_id)
    if row is None:
        raise ApiKeyError("Plan not found or inactive", 404)
    before = {"per_minute": row.per_minute, "burst": row.burst, "daily_cap": row.daily_cap}
    after = dict(before)
    if changes.get("per_minute") is not None:
        after["per_minute"] = _whole(changes["per_minute"], "Requests / min", 1, MAX_PER_MINUTE)
    if changes.get("burst") is not None:
        after["burst"] = _whole(changes["burst"], "Burst", 1, MAX_BURST)
    if changes.get("daily_cap") is not None:
        after["daily_cap"] = _whole(changes["daily_cap"], "Daily cap", 0, MAX_DAILY)
    if after != before:
        row.per_minute, row.burst, row.daily_cap = after["per_minute"], after["burst"], after["daily_cap"]
        row.updated_by, row.updated_at = actor, datetime.utcnow()
        _limit_cache.pop(plan_id, None)
    return before, after


def tenant_limit(db: Session, tenant: Tenant) -> tuple[int, int, int]:
    """(per_minute, burst, daily_cap) of the tenant's plan, cached per worker for LIMIT_CACHE_SECONDS."""
    hit = _limit_cache.get(tenant.plan_id)
    if hit and time.time() - hit[0] < LIMIT_CACHE_SECONDS:
        return hit[1]
    ensure_schema()
    row = db.get(PlatformPlanRateLimit, tenant.plan_id) if tenant.plan_id else None
    if row is None:
        limits = {r["plan_id"]: r for r in plan_limits(db)}
        db.commit()
        d = limits.get(tenant.plan_id)
        value = (d["per_minute"], d["burst"], d["daily_cap"]) if d else (TIERS[0][0], TIERS[0][1], DAILY_CAPS[0])
    else:
        value = (row.per_minute, row.burst, row.daily_cap or 0)
    _limit_cache[tenant.plan_id] = (time.time(), value)
    return value


def limiting_enabled(db: Session) -> bool:
    hit = _limit_cache.get("rlOn")
    if hit and time.time() - hit[0] < LIMIT_CACHE_SECONDS:
        return hit[1]
    on = bool(_setting(db, "rlOn", True))
    _limit_cache["rlOn"] = (time.time(), on)
    return on


# ─── Keys ────────────────────────────────────────────────────────────────────

def parse_scopes(scopes) -> str:
    s = {str(x).strip().lower() for x in (scopes or [])}
    if not s or not s <= set(SCOPES):
        raise ApiKeyError("Choose the key's scopes: read, or read and write", 422)
    return "read,write" if "write" in s else "read"


def _issue(db: Session, tenant_id: int, user_id: int, name: str, scopes: str, actor: str) -> tuple[PlatformApiKey, str]:
    raw = KEY_PREFIX + secrets.token_urlsafe(32)          # 256 bits from the OS CSPRNG
    row = PlatformApiKey(prefix=raw[:LOOKUP_CHARS], key_hash=_digest(raw), last4=raw[-4:], tenant_id=tenant_id, user_id=user_id, name=name[:120],
                         scopes=scopes, created_by=actor, created_at=datetime.utcnow())
    db.add(row)
    db.flush()
    return row, raw


def create_key(db: Session, tenant: Tenant, user_id: int, name: str, actor: str, scopes=("read", "write")) -> tuple[PlatformApiKey, str]:
    """Create a key for an active user of the tenant. Returns (record, the key) – the key is not stored and can't be shown again."""
    ensure_schema()
    name = (name or "").strip()
    if not name:
        raise ApiKeyError("Name the key", 422)
    scope = parse_scopes(scopes)
    session = get_tenant_session(tenant.slug)
    try:
        user = session.execute(text("SELECT id, is_active FROM users WHERE id = :id"), {"id": user_id}).first()
    finally:
        session.close()
    if user is None or not user[1]:
        raise ApiKeyError("The key must sign in as an active user of this tenant", 422)
    return _issue(db, tenant.id, user_id, name, scope, actor)


def is_usable(row: PlatformApiKey, now: Optional[datetime] = None) -> bool:
    now = now or datetime.utcnow()
    return row.revoked_at is None and (row.expires_at is None or row.expires_at > now)


def status(row: PlatformApiKey, now: Optional[datetime] = None) -> str:
    now = now or datetime.utcnow()
    if not is_usable(row, now):
        return "Revoked"
    if row.expires_at is not None or row.created_at < now - timedelta(days=ROTATE_AFTER_DAYS):
        return "Rotate soon"
    return "Active"


def verify(db: Session, raw: str) -> Optional[PlatformApiKey]:
    """The usable key for ``raw``, or None. Constant-time comparison of the stored HMAC."""
    if not raw.startswith(KEY_PREFIX) or len(raw) < 30:
        return None
    ensure_schema()
    row = db.query(PlatformApiKey).filter(PlatformApiKey.prefix == raw[:LOOKUP_CHARS]).first()
    if row is None or not hmac.compare_digest(row.key_hash, _digest(raw)) or not is_usable(row):
        return None
    return row


def allows(row: PlatformApiKey, method: str) -> bool:
    return method.upper() in READ_METHODS or "write" in (row.scopes or "").split(",")


def touch(db: Session, row: PlatformApiKey) -> None:
    now = datetime.utcnow()
    if row.last_used_at is None or now - row.last_used_at > timedelta(minutes=1):
        row.last_used_at = now
        db.commit()


def overlap_hours(db: Session) -> int:
    try:
        return max(0, min(720, int(_setting(db, "apiKeyOverlap", 24))))
    except (TypeError, ValueError):
        return 24


def rotate(db: Session, row: PlatformApiKey, actor: str, now: Optional[datetime] = None) -> tuple[PlatformApiKey, str, int]:
    """Issue the replacement; the old key works until the overlap ends (at once with 0 h). Returns (new, raw key, overlap h)."""
    now = now or datetime.utcnow()
    if not is_usable(row, now):
        raise ApiKeyError("This key is revoked – create a new key instead", 409)
    if row.replaced_by_id is not None:
        raise ApiKeyError("This key was already rotated – rotate its replacement", 409)
    hours = overlap_hours(db)
    new, raw = _issue(db, row.tenant_id, row.user_id, row.name, row.scopes or "read,write", actor)
    row.replaced_by_id = new.id
    if hours:
        row.expires_at = now + timedelta(hours=hours)
    else:
        row.revoked_at, row.revoked_by = now, f"{actor} (rotated)"
    return new, raw, hours


def revoke(db: Session, row: PlatformApiKey, actor: str) -> None:
    if row.revoked_at is not None:
        raise ApiKeyError("This key is already revoked", 409)
    row.revoked_at, row.revoked_by = datetime.utcnow(), actor


def masked(row: PlatformApiKey) -> str:
    return f"{row.prefix}••••••••{row.last4 or '••••'}"


# ─── Rate limiting (Redis token bucket + daily cap, one atomic script) ───────

# KEYS[1] bucket, KEYS[2] today's counter; ARGV: capacity, refill per ms, now ms, daily cap (0 = none), ms to midnight.
# Returns {code, wait ms, remaining today}: code 1 allowed, 0 over the per-minute / burst limit, 2 over the daily cap.
_BUCKET = """
local cap = tonumber(ARGV[1]); local rate = tonumber(ARGV[2]); local now = tonumber(ARGV[3])
local daily = tonumber(ARGV[4]); local midnight = tonumber(ARGV[5])
local used = tonumber(redis.call('GET', KEYS[2]) or '0')
if daily > 0 and used >= daily then return {2, midnight, 0} end
local s = redis.call('HMGET', KEYS[1], 't', 'ts')
local tokens = tonumber(s[1]); local ts = tonumber(s[2])
if tokens == nil then tokens = cap; ts = now end
tokens = math.min(cap, tokens + math.max(0, now - ts) * rate)
local allowed = 0; local wait = 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1 else wait = math.ceil((1 - tokens) / rate) end
redis.call('HSET', KEYS[1], 't', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / rate) + 1000)
if allowed == 1 then
  used = redis.call('INCR', KEYS[2])
  if used == 1 then redis.call('PEXPIRE', KEYS[2], midnight + 3600000) end
end
local left = -1
if daily > 0 then left = daily - used end
return {allowed, wait, left}
"""
_redis: dict[str, object] = {}


def _client():
    if "client" not in _redis:
        _redis["client"] = redis.Redis.from_url(settings.REDIS_URL, socket_connect_timeout=1, socket_timeout=1)
        _redis["script"] = _redis["client"].register_script(_BUCKET)
    return _redis["script"]


def take(tenant_id: int, per_minute: int, burst: int, daily_cap: int = 0, now: Optional[float] = None) -> tuple[bool, int, str, Optional[int]]:
    """(allowed, seconds to wait, "minute" | "daily" | "", requests left today or None)."""
    now = time.time() if now is None else now
    local = datetime.utcfromtimestamp(now) + IST
    midnight_ms = int(((datetime(local.year, local.month, local.day) + timedelta(days=1)) - local).total_seconds() * 1000)
    try:
        code, wait_ms, left = _client()(keys=[f"azx:rl:tenant:{tenant_id}", f"azx:rl:day:{tenant_id}:{local:%Y%m%d}"],
                                        args=[max(1, burst), max(1, per_minute) / 60000.0, int(now * 1000), max(0, daily_cap), midnight_ms])
    except Exception:  # noqa: BLE001 - an unavailable limiter must not take the API down
        logger.exception("API rate limiter unavailable; request allowed")
        return True, 0, "", None
    code, left = int(code), int(left)
    if code == 1:
        return True, 0, "", (left if left >= 0 else None)
    return False, max(1, -(-int(wait_ms) // 1000)), "daily" if code == 2 else "minute", 0 if code == 2 else (left if left >= 0 else None)


def record_limited(tenant_slug: str) -> None:
    from app.services import platform_usage
    platform_usage._add(tenant_slug, "rate_limited")
