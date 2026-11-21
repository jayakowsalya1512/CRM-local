"""Best-effort Redis cache helpers for fast-read API responses.

Redis is used only as a temporary cache. All callers must keep MySQL as the
source of truth and treat any cache failure as a miss.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.core.config import settings

try:
    import redis
except Exception:  # pragma: no cover - depends on deployment environment
    redis = None


logger = logging.getLogger(__name__)

CACHE_TTL_SECONDS = {
    "permissions": 300,
    "sidebar": 300,
    "theme": 300,
    "badges": 20,
    "notifications": 30,
    "questionnaire_config": 1800,
}

_redis_client = None
_redis_retry_after = 0.0
_redis_import_logged = False
_REDIS_RETRY_SECONDS = 30


def tenant_slug_from_db(db: Session) -> str:
    return str(getattr(db, "info", {}).get("tenant_slug") or "").strip().lower()


def _get_redis_client():
    global _redis_client, _redis_import_logged, _redis_retry_after

    if redis is None:
        if not _redis_import_logged:
            logger.warning("Redis package is not installed; API response cache is disabled.")
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
        _redis_client = None
        _redis_retry_after = time.time() + _REDIS_RETRY_SECONDS
        logger.warning("Redis API response cache unavailable; using DB fallback: %s", exc)
        return None


def cache_get_json(key: str, label: str) -> Optional[Any]:
    client = _get_redis_client()
    if client is None:
        logger.info("Redis cache miss: %s key=%s", label, key)
        return None

    try:
        raw = client.get(key)
        if raw is None:
            logger.info("Redis cache miss: %s key=%s", label, key)
            return None
        logger.info("Redis cache hit: %s key=%s", label, key)
        return json.loads(raw)
    except Exception as exc:  # pragma: no cover - requires Redis fault/bad payload
        logger.warning("Redis cache read failed: %s key=%s error=%s", label, key, exc)
        return None


def cache_set_json(key: str, value: Any, ttl_seconds: int) -> None:
    client = _get_redis_client()
    if client is None:
        return

    try:
        client.setex(key, max(1, int(ttl_seconds)), json.dumps(value, default=str))
    except Exception as exc:  # pragma: no cover - requires Redis fault
        logger.warning("Redis cache write failed: key=%s error=%s", key, exc)


def cache_delete(key: str) -> None:
    client = _get_redis_client()
    if client is None:
        return

    try:
        client.delete(key)
    except Exception as exc:  # pragma: no cover - requires Redis fault
        logger.warning("Redis cache delete failed: key=%s error=%s", key, exc)


def cache_delete_pattern(pattern: str) -> None:
    client = _get_redis_client()
    if client is None:
        return

    try:
        batch: list[str] = []
        for key in client.scan_iter(match=pattern, count=100):
            batch.append(key)
            if len(batch) >= 100:
                client.delete(*batch)
                batch.clear()
        if batch:
            client.delete(*batch)
    except Exception as exc:  # pragma: no cover - requires Redis fault
        logger.warning("Redis cache pattern delete failed: pattern=%s error=%s", pattern, exc)


def permissions_cache_key(tenant_slug: str, user_id: int | str) -> str:
    return f"permissions:{tenant_slug}:{user_id}"


def sidebar_cache_key(tenant_slug: str, user_id: int | str, part: str) -> str:
    return f"sidebar:{tenant_slug}:{user_id}:{part}"


def theme_cache_key(tenant_slug: str, part: str) -> str:
    return f"theme:{tenant_slug}:{part}"


def badges_cache_key(tenant_slug: str, user_id: int | str) -> str:
    return f"badges:{tenant_slug}:{user_id}"


def notifications_cache_key(tenant_slug: str, user_id: int | str) -> str:
    return f"notifications:{tenant_slug}:{user_id}"


def questionnaire_config_cache_key(tenant_slug: str, questionnaire_id: int) -> str:
    return f"qconfig:{tenant_slug}:{questionnaire_id}"


def invalidate_questionnaire_config_cache(db: Session, questionnaire_id: int) -> None:
    tenant_slug = tenant_slug_from_db(db)
    if not tenant_slug:
        return
    cache_delete(questionnaire_config_cache_key(tenant_slug, questionnaire_id))


def invalidate_permissions_cache(db: Session) -> None:
    tenant_slug = tenant_slug_from_db(db)
    if not tenant_slug:
        return
    cache_delete_pattern(f"permissions:{tenant_slug}:*")
    cache_delete_pattern(f"sidebar:{tenant_slug}:*")


def invalidate_sidebar_cache(db: Session, user_id: int | str | None = None) -> None:
    tenant_slug = tenant_slug_from_db(db)
    if not tenant_slug:
        return
    if user_id is None:
        cache_delete_pattern(f"sidebar:{tenant_slug}:*")
    else:
        cache_delete_pattern(f"sidebar:{tenant_slug}:{user_id}:*")


def invalidate_theme_cache(db: Session) -> None:
    tenant_slug = tenant_slug_from_db(db)
    if tenant_slug:
        cache_delete_pattern(f"theme:{tenant_slug}:*")


def invalidate_badges_cache(db: Session, user_id: int | str | None = None) -> None:
    tenant_slug = tenant_slug_from_db(db)
    if not tenant_slug:
        return
    if user_id is None:
        cache_delete_pattern(f"badges:{tenant_slug}:*")
    else:
        cache_delete(badges_cache_key(tenant_slug, user_id))


def invalidate_notifications_cache(db: Session, user_id: int | str | None = None) -> None:
    tenant_slug = tenant_slug_from_db(db)
    if not tenant_slug:
        return
    if user_id is None:
        cache_delete_pattern(f"notifications:{tenant_slug}:*")
    else:
        cache_delete(notifications_cache_key(tenant_slug, user_id))
        cache_delete(badges_cache_key(tenant_slug, user_id))
