"""Uptime and incident tracking for the platform Command Center.

A background loop probes every server once a minute and stores the minutes each
server was online in Redis. Uptime is online minutes / minutes elapsed since
tracking began (capped at 30 days), so minutes when the platform itself was down
count as downtime. Status changes and backend starts are kept as an event feed.
"""

from __future__ import annotations

import json
import logging
import socket
import time

import redis

from app.core.config import settings
from app.services import platform_infrastructure as infrastructure
from app.services import platform_monitoring

logger = logging.getLogger(__name__)

PREFIX = "platform:uptime"
WINDOW_MINUTES = 30 * 24 * 60
MAX_EVENTS = 50


def _client() -> redis.Redis:
    return redis.Redis.from_url(settings.REDIS_URL, socket_connect_timeout=2, socket_timeout=2, decode_responses=True)


def _push_event(client: redis.Redis, kind: str, text: str, **extra) -> None:
    client.lpush(f"{PREFIX}:events", json.dumps({"kind": kind, "text": text, "at": int(time.time()), **extra}))
    client.ltrim(f"{PREFIX}:events", 0, MAX_EVENTS - 1)


def record_start() -> None:
    try:
        _push_event(_client(), "deploy", f"{settings.APP_NAME} v{settings.APP_VERSION} started on {socket.gethostname()}")
    except Exception as exc:
        logger.warning("Uptime tracker could not record start: %s", exc)


def sample() -> None:
    """Probe all servers once for the current minute (one worker per minute wins the lock)."""
    minute = int(time.time() // 60)
    client = _client()
    if not client.set(f"{PREFIX}:lock:{minute}", "1", nx=True, ex=120):
        return
    client.set(f"{PREFIX}:since", minute, nx=True)
    for server in infrastructure.server_inventory():
        result = infrastructure.probe_server(server)
        platform_monitoring.record_server_sample(result)
        name = result["name"]
        db = result["database"]
        state = "Offline" if result["status"] != "Online" else ("Database " + db["status"].lower() if db and db["status"] != "Healthy" else "Online")
        key = f"{PREFIX}:online:{name}"
        if result["status"] == "Online":
            client.zadd(key, {str(minute): minute})
        client.zremrangebyscore(key, "-inf", minute - WINDOW_MINUTES)
        previous = client.hget(f"{PREFIX}:state", name)
        if previous is not None and previous != state:
            if state == "Online":
                _push_event(client, "resolved", f"{name} recovered ({previous.lower()})", server=name)
            else:
                _push_event(client, "incident", f"{name}: {state.lower()}", server=name)
        client.hset(f"{PREFIX}:state", name, state)


def uptime(server_names: list[str]) -> dict:
    """Uptime % per server over the tracked part of the last 30 days."""
    try:
        client = _client()
        since = client.get(f"{PREFIX}:since")
        if since is None:
            return {"tracked_minutes": 0, "servers": {}}
        now = int(time.time() // 60)
        start = max(int(since), now - WINDOW_MINUTES + 1)
        elapsed = now - start + 1
        servers = {name: round(min(100.0, client.zcount(f"{PREFIX}:online:{name}", start, now) / elapsed * 100), 2) for name in server_names}
        return {"tracked_minutes": elapsed, "tracked_since": start * 60, "servers": servers}
    except Exception as exc:
        logger.warning("Uptime tracker unavailable: %s", exc)
        return {"tracked_minutes": 0, "servers": {}, "error": "Uptime tracking unavailable (Redis)"}


def daily_availability(server_name: str, days: int = 30) -> list[dict]:
    """Per-day uptime % for one server; days before tracking began are None."""
    try:
        client = _client()
        since = client.get(f"{PREFIX}:since")
        now = int(time.time() // 60)
        today = now - now % 1440
        result = []
        for offset in range(days - 1, -1, -1):
            start = today - offset * 1440
            end = min(start + 1439, now)
            first = max(start, int(since)) if since is not None else None
            if first is None or first > end:
                result.append({"day_start": start * 60, "percent": None})
                continue
            online = client.zcount(f"{PREFIX}:online:{server_name}", first, end)
            result.append({"day_start": start * 60, "percent": round(min(100.0, online / (end - first + 1) * 100), 2)})
        return result
    except Exception:
        return []


def events(limit: int = 6) -> list[dict]:
    try:
        return [json.loads(item) for item in _client().lrange(f"{PREFIX}:events", 0, limit - 1)]
    except Exception:
        return []


def open_incidents() -> list[dict]:
    try:
        return [{"server": name, "state": state} for name, state in _client().hgetall(f"{PREFIX}:state").items() if state != "Online"]
    except Exception:
        return []
