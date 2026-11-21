"""Team Chat real-time layer: WebSocket fan-out + Redis pub/sub bridge.

No part of this backend used WebSockets or Redis pub/sub before this module —
everything else is poll-based (see app/services/cache_service.py, which only
uses Redis as a best-effort cache). This introduces the pattern:

- Each worker process keeps its own in-memory map of live WebSocket
  connections (ChatConnectionManager). Delivering to a user connected to
  *this* process is just a local dict lookup.
- To reach a user connected to a *different* worker/instance, every event is
  also published to a Redis channel scoped to the tenant
  ("chat:events:<tenant_slug>"); every process subscribes to the channels for
  tenants it currently has connections for and re-dispatches locally. This is
  the standard "local fan-out + pub/sub bridge" pattern for horizontal
  scaling, and degrades gracefully to single-instance-only delivery if Redis
  is unavailable (consistent with how cache_service.py already treats Redis
  as best-effort, never load-bearing for correctness within one process).

Presence ("online"/"last seen") is tracked the same way — a short-TTL Redis
key per user, refreshed on every WebSocket ping/message, with an in-process
fallback dict when Redis is down (accurate only for that process, but still
functional for a single-instance deployment).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import defaultdict
from typing import Any, Optional

from fastapi import WebSocket

from app.core.config import settings

logger = logging.getLogger(__name__)

try:
    import redis.asyncio as aioredis
except Exception:  # pragma: no cover - depends on deployment environment
    aioredis = None

PRESENCE_TTL_SECONDS = 75  # a bit more than the client's ping interval (see useChatSocket.ts, 30s)
ONLINE_WINDOW_SECONDS = 90


class ChatConnectionManager:
    """Per-process registry of live chat WebSocket connections, keyed by (tenant_slug, user_id)."""

    def __init__(self) -> None:
        self._conns: dict[str, dict[int, set[WebSocket]]] = defaultdict(lambda: defaultdict(set))
        self._lock = asyncio.Lock()
        self._local_presence: dict[str, dict[int, float]] = defaultdict(dict)
        self._local_status: dict[str, dict[int, str]] = defaultdict(dict)

    async def connect(self, tenant_slug: str, user_id: int, ws: WebSocket) -> None:
        async with self._lock:
            self._conns[tenant_slug][user_id].add(ws)

    async def disconnect(self, tenant_slug: str, user_id: int, ws: WebSocket) -> None:
        async with self._lock:
            conns = self._conns.get(tenant_slug, {}).get(user_id)
            if conns is not None:
                conns.discard(ws)
                if not conns:
                    self._conns[tenant_slug].pop(user_id, None)

    def connected_user_ids(self, tenant_slug: str) -> set[int]:
        return set(self._conns.get(tenant_slug, {}).keys())

    async def send_local(self, tenant_slug: str, user_id: int, payload: dict) -> None:
        sockets = list(self._conns.get(tenant_slug, {}).get(user_id, ()))
        if not sockets:
            return
        text = json.dumps(payload, default=str)
        for ws in sockets:
            try:
                await ws.send_text(text)
            except Exception:
                await self.disconnect(tenant_slug, user_id, ws)

    def touch_presence(self, tenant_slug: str, user_id: int) -> None:
        self._local_presence[tenant_slug][user_id] = time.time()

    def is_locally_online(self, tenant_slug: str, user_id: int) -> bool:
        seen = self._local_presence.get(tenant_slug, {}).get(user_id)
        return bool(seen and time.time() - seen < ONLINE_WINDOW_SECONDS)

    def set_local_status(self, tenant_slug: str, user_id: int, status: str) -> None:
        self._local_status[tenant_slug][user_id] = status

    def get_local_status(self, tenant_slug: str, user_id: int) -> str:
        return self._local_status.get(tenant_slug, {}).get(user_id, "online")


manager = ChatConnectionManager()

_redis_client = None
_redis_unavailable_logged = False
_pubsub_tasks: dict[str, asyncio.Task] = {}

# Every REST endpoint in chat_router.py is a plain `def` (FastAPI runs those in a worker
# thread via run_in_threadpool, same as every other router in this backend) — a worker
# thread has no running asyncio event loop, so `asyncio.create_task()` there always raises
# RuntimeError. schedule_publish() is the thread-safe way to fire publish_event() from one
# of those sync routes: it hands the coroutine to the real event loop (captured once at
# startup via bind_main_loop, see app/main.py's lifespan) instead of silently dropping it.
_main_loop: Optional[asyncio.AbstractEventLoop] = None


def bind_main_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _main_loop
    _main_loop = loop


def schedule_publish(tenant_slug: str, target_user_ids: list[int], event: dict[str, Any]) -> None:
    """Safe to call from any thread, sync or async. Prefer this over calling
    publish_event() directly from a sync (non-`async def`) FastAPI route."""
    try:
        asyncio.get_running_loop()
        asyncio.create_task(publish_event(tenant_slug, target_user_ids, event))
        return
    except RuntimeError:
        pass  # not on an event loop thread — fall through to the thread-safe path

    if _main_loop is None:
        logger.warning("Team Chat: schedule_publish called before bind_main_loop — event dropped")
        return
    asyncio.run_coroutine_threadsafe(publish_event(tenant_slug, target_user_ids, event), _main_loop)


def _get_async_redis():
    global _redis_client, _redis_unavailable_logged
    if aioredis is None:
        if not _redis_unavailable_logged:
            logger.warning("redis.asyncio not installed; Team Chat will only deliver within one process.")
            _redis_unavailable_logged = True
        return None
    if _redis_client is None:
        try:
            _redis_client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
        except Exception as exc:  # pragma: no cover - requires unavailable Redis
            logger.warning("Team Chat: could not create Redis client: %s", exc)
            return None
    return _redis_client


def _channel(tenant_slug: str) -> str:
    return f"chat:events:{tenant_slug}"


def _presence_key(tenant_slug: str, user_id: int) -> str:
    return f"chat:presence:{tenant_slug}:{user_id}"


def _status_key(tenant_slug: str, user_id: int) -> str:
    return f"chat:status:{tenant_slug}:{user_id}"


STATUS_TTL_SECONDS = 7 * 24 * 3600  # manual status survives reconnects; expires if truly abandoned


async def publish_event(tenant_slug: str, target_user_ids: list[int], event: dict[str, Any]) -> None:
    """Deliver `event` to every target user, locally and (best-effort) via Redis
    so other worker processes/instances can deliver to their own connections too."""
    target_user_ids = list({int(uid) for uid in target_user_ids if uid is not None})
    for uid in target_user_ids:
        await manager.send_local(tenant_slug, uid, event)

    client = _get_async_redis()
    if client is None:
        return
    try:
        await client.publish(_channel(tenant_slug), json.dumps(
            {"target_user_ids": target_user_ids, "event": event}, default=str,
        ))
    except Exception as exc:  # pragma: no cover
        logger.warning("Team Chat: Redis publish failed (local delivery still happened): %s", exc)


async def ensure_subscribed(tenant_slug: str) -> None:
    """Start a background subscriber for this tenant's Redis channel, once per process."""
    if tenant_slug in _pubsub_tasks and not _pubsub_tasks[tenant_slug].done():
        return
    client = _get_async_redis()
    if client is None:
        return
    _pubsub_tasks[tenant_slug] = asyncio.create_task(_subscribe_loop(tenant_slug))


async def _subscribe_loop(tenant_slug: str) -> None:
    backoff = 1.0
    while True:
        client = _get_async_redis()
        if client is None:
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)
            continue
        try:
            pubsub = client.pubsub()
            await pubsub.subscribe(_channel(tenant_slug))
            backoff = 1.0
            async for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                try:
                    data = json.loads(message["data"])
                except Exception:
                    continue
                event = data.get("event") or {}
                for uid in data.get("target_user_ids") or []:
                    if manager.is_locally_online(tenant_slug, int(uid)) or True:
                        # `or True`: still attempt delivery — send_local is a no-op if the
                        # user has no local socket, so this never leaks across processes.
                        await manager.send_local(tenant_slug, int(uid), event)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover
            logger.warning("Team Chat: Redis subscriber for %s dropped, retrying: %s", tenant_slug, exc)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


async def mark_online(tenant_slug: str, user_id: int) -> None:
    manager.touch_presence(tenant_slug, user_id)
    client = _get_async_redis()
    if client is None:
        return
    try:
        await client.set(_presence_key(tenant_slug, user_id), str(time.time()), ex=PRESENCE_TTL_SECONDS)
    except Exception:  # pragma: no cover
        pass


async def is_online(tenant_slug: str, user_id: int) -> bool:
    client = _get_async_redis()
    if client is None:
        return manager.is_locally_online(tenant_slug, user_id)
    try:
        value = await client.get(_presence_key(tenant_slug, user_id))
        return bool(value)
    except Exception:  # pragma: no cover
        return manager.is_locally_online(tenant_slug, user_id)


async def online_user_ids(tenant_slug: str, user_ids: list[int]) -> set[int]:
    client = _get_async_redis()
    if client is None or not user_ids:
        return {uid for uid in user_ids if manager.is_locally_online(tenant_slug, uid)}
    try:
        pipe = client.pipeline()
        for uid in user_ids:
            pipe.exists(_presence_key(tenant_slug, uid))
        results = await pipe.execute()
        return {uid for uid, present in zip(user_ids, results) if present}
    except Exception:  # pragma: no cover
        return {uid for uid in user_ids if manager.is_locally_online(tenant_slug, uid)}


VALID_STATUSES = {"online", "away", "dnd"}


async def set_status(tenant_slug: str, user_id: int, status: str) -> None:
    """Manual override ("Online"/"Away"/"Do not disturb"). Connection state
    (mark_online/online_user_ids) is tracked separately — a user who closes every
    tab always shows as Offline to others regardless of what they last manually set."""
    if status not in VALID_STATUSES:
        raise ValueError(f"Invalid status: {status}")
    manager.set_local_status(tenant_slug, user_id, status)
    client = _get_async_redis()
    if client is None:
        return
    try:
        if status == "online":
            await client.delete(_status_key(tenant_slug, user_id))
        else:
            await client.set(_status_key(tenant_slug, user_id), status, ex=STATUS_TTL_SECONDS)
    except Exception:  # pragma: no cover
        pass


async def get_statuses(tenant_slug: str, user_ids: list[int]) -> dict[int, str]:
    """Effective status per user: 'offline' always wins over any stale manual
    override — only a currently-connected user can show as online/away/dnd."""
    if not user_ids:
        return {}
    online_ids = await online_user_ids(tenant_slug, user_ids)
    manual: dict[int, str] = {}
    client = _get_async_redis()
    if client is not None:
        try:
            pipe = client.pipeline()
            for uid in user_ids:
                pipe.get(_status_key(tenant_slug, uid))
            values = await pipe.execute()
            manual = {uid: v for uid, v in zip(user_ids, values) if v}
        except Exception:  # pragma: no cover
            manual = {}
    else:
        manual = {
            uid: manager.get_local_status(tenant_slug, uid)
            for uid in user_ids
            if manager.get_local_status(tenant_slug, uid) != "online"
        }
    return {uid: (manual.get(uid, "online") if uid in online_ids else "offline") for uid in user_ids}
