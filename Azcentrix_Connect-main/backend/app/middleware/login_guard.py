"""
Redis-backed login attempt tracking.

Handles rate limiting, lockout, and CAPTCHA triggers per tenant/user.
"""
import logging
import time
from typing import Any

from app.core.config import settings

try:
    import redis
except Exception:  # pragma: no cover - depends on deployment environment
    redis = None


logger = logging.getLogger(__name__)

DEFAULT_STATE = {"attempts": 0, "lockout_until": 0.0, "captcha_required": False}
REDIS_RETRY_SECONDS = 30

_redis_client = None
_redis_retry_after = 0.0
_redis_import_logged = False


def _normalize_username(username: str) -> str:
    return str(username or "").strip().lower()


def _normalize_tenant_slug(tenant_slug: str) -> str:
    return str(tenant_slug or "").strip().lower()


def _login_key(tenant_slug: str, username: str) -> str | None:
    tenant = _normalize_tenant_slug(tenant_slug)
    normalized_username = _normalize_username(username)
    if not tenant or not normalized_username:
        return None
    return f"login_guard:{tenant}:{normalized_username}"


def _default_state() -> dict:
    return dict(DEFAULT_STATE)


def _state_ttl(ttl: int | None = None) -> int:
    if ttl is not None and ttl > 0:
        return int(ttl)
    lockout_ttl = int(settings.LOCKOUT_DURATION_MINUTES or 30) * 60
    return max(60, lockout_ttl)


def _parse_state(raw: dict[str, Any]) -> dict:
    state = _default_state()
    try:
        state["attempts"] = max(0, int(raw.get("attempts") or 0))
    except (TypeError, ValueError):
        state["attempts"] = 0
    try:
        state["lockout_until"] = float(raw.get("lockout_until") or 0.0)
    except (TypeError, ValueError):
        state["lockout_until"] = 0.0

    captcha_value = raw.get("captcha_required")
    state["captcha_required"] = str(captcha_value).strip().lower() in {"1", "true", "yes"}
    return state


def _redis_unavailable(exc: Exception | None = None) -> None:
    global _redis_client, _redis_retry_after
    _redis_client = None
    _redis_retry_after = time.time() + REDIS_RETRY_SECONDS
    if exc is not None:
        logger.warning("Login guard Redis unavailable; continuing without lockout cache: %s", exc)


def _get_redis_client():
    global _redis_client, _redis_import_logged

    if redis is None:
        if not _redis_import_logged:
            logger.warning("Redis package is not installed; login guard cache is disabled.")
            _redis_import_logged = True
        return None

    if time.time() < _redis_retry_after:
        return None

    if _redis_client is not None:
        return _redis_client

    try:
        client = redis.Redis.from_url(
            settings.REDIS_URL,
            decode_responses=True,
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        client.ping()
        _redis_client = client
        return _redis_client
    except Exception as exc:  # pragma: no cover - requires unavailable Redis
        _redis_unavailable(exc)
        return None


def get_login_state(tenant_slug: str, username: str) -> dict:
    key = _login_key(tenant_slug, username)
    if not key:
        return _default_state()

    client = _get_redis_client()
    if client is None:
        return _default_state()

    try:
        raw = client.hgetall(key)
    except Exception as exc:  # pragma: no cover - requires Redis fault
        _redis_unavailable(exc)
        return _default_state()

    if not raw:
        return _default_state()

    state = _parse_state(raw)
    if state["lockout_until"] and state["lockout_until"] <= time.time():
        clear_login_state(tenant_slug, username)
        return _default_state()
    return state


def set_login_state(
    tenant_slug: str,
    username: str,
    state: dict,
    ttl: int | None = None,
) -> bool:
    key = _login_key(tenant_slug, username)
    if not key:
        return False

    client = _get_redis_client()
    if client is None:
        return False

    try:
        client.hset(
            key,
            mapping={
                "attempts": int(state.get("attempts") or 0),
                "lockout_until": float(state.get("lockout_until") or 0.0),
                "captcha_required": "1" if bool(state.get("captcha_required")) else "0",
            },
        )
        client.expire(key, _state_ttl(ttl))
        return True
    except Exception as exc:  # pragma: no cover - requires Redis fault
        _redis_unavailable(exc)
        return False


def clear_login_state(tenant_slug: str, username: str) -> bool:
    key = _login_key(tenant_slug, username)
    if not key:
        return False

    client = _get_redis_client()
    if client is None:
        return False

    try:
        client.delete(key)
        return True
    except Exception as exc:  # pragma: no cover - requires Redis fault
        _redis_unavailable(exc)
        return False


def record_failed_attempt(tenant_slug: str, username: str, captcha_mode: str = "after_failed") -> dict:
    key = _login_key(tenant_slug, username)
    fallback_state = _default_state()
    fallback_state["attempts"] = 1
    if captcha_mode == "after_failed" and fallback_state["attempts"] >= settings.CAPTCHA_AFTER_ATTEMPTS:
        fallback_state["captcha_required"] = True

    client = _get_redis_client()
    if not key or client is None:
        return fallback_state

    try:
        get_login_state(tenant_slug, username)
        attempts = int(client.hincrby(key, "attempts", 1))
        client.expire(key, _state_ttl())
        state = get_login_state(tenant_slug, username)
        state["attempts"] = attempts

        if captcha_mode == "after_failed" and attempts >= settings.CAPTCHA_AFTER_ATTEMPTS:
            state["captcha_required"] = True

        if attempts >= settings.MAX_LOGIN_ATTEMPTS:
            state["lockout_until"] = time.time() + _state_ttl()
            logger.warning(
                "Account locked: tenant=%s username=%s after %s failed attempts",
                _normalize_tenant_slug(tenant_slug),
                _normalize_username(username),
                attempts,
            )

        set_login_state(tenant_slug, username, state)
        return state
    except Exception as exc:  # pragma: no cover - requires Redis fault
        _redis_unavailable(exc)
        return fallback_state


def is_locked_out(tenant_slug: str, username: str) -> bool:
    return get_login_state(tenant_slug, username)["lockout_until"] > time.time()


def requires_captcha(tenant_slug: str, username: str) -> bool:
    return bool(get_login_state(tenant_slug, username)["captcha_required"])


def get_remaining_lockout(tenant_slug: str, username: str) -> int:
    remaining = get_login_state(tenant_slug, username)["lockout_until"] - time.time()
    return max(0, int(remaining))


def reset_attempts(tenant_slug: str, username: str) -> None:
    clear_login_state(tenant_slug, username)


def get_attempt_count(tenant_slug: str, username: str) -> int:
    return int(get_login_state(tenant_slug, username)["attempts"])
