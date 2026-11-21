"""Control Center: platform defaults and per-tenant overrides for every configurable platform control.

The control catalogue (``platform_controls_schema.json``) follows the Bidwise prototype's PSCH schema category by
category. Only values that differ from the schema default are stored (``platform_control_values``): tenant_id 0 is the
platform default; any other tenant_id is an override for that tenant. A tenant inherits the platform value of every
control it does not override.

Each control has a ``status``: ``live`` controls are read by the platform at runtime, ``saved`` ones are stored and
exported, ``planned`` ones configure a feature that is not built yet, ``fixed`` ones are determined by the
self-hosted MariaDB architecture (read-only) and ``unsupported`` ones have no equivalent and cannot be changed.
"""
import json
import logging
import re
import time
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

import pymysql
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.tenant import Plan
from app.models.tenant_hierarchy import PlatformControlValue
from app.services import platform_access

logger = logging.getLogger(__name__)

PLATFORM_SCOPE = 0
READ_ONLY_STATUSES = ("fixed", "unsupported")
BRIDGED = ("fourEyes", "mfaPlat")   # stored in an existing platform setting, not in platform_control_values
# Inclusive bounds for numeric controls the platform enforces.
BOUNDS = {"pwMin": (max(1, int(settings.PASSWORD_MIN_LENGTH or 8)), 72), "pwHist": (0, 24), "pwRot": (0, 365),
          "lockout": (1, 100), "lockMin": (1, 1440), "sbMax": (0, 20), "sbDays": (1, 365),
          "couponMax": (0, 100), "dcAnnual": (0, 90), "dcMulti2": (0, 90), "dcMulti3": (0, 90), "refPct": (0, 90), "npoPct": (0, 90),
          "refCredit": (0, 10_000_000), "apiKeyOverlap": (0, 720)}
VISIBILITY_BY_LABEL = {"Full data & workspace": "full", "Consolidated reports only": "reports", "None": "none"}
_SCHEMA_PATH = Path(__file__).with_name("platform_controls_schema.json")


class ControlError(ValueError):
    pass


@lru_cache(maxsize=1)
def _catalogue() -> list[dict]:
    return json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _controls() -> dict[str, dict]:
    return {c["key"]: {**c, "category": cat["name"], "group": g["name"]} for cat in _catalogue() for g in cat["groups"] for c in g["controls"]}


def control(key: str) -> dict:
    found = _controls().get(key)
    if not found:
        raise ControlError(f"Unknown control '{key}'")
    return found


_engine_cache: dict = {"at": 0.0, "value": None}


def _db_engine_version() -> Optional[str]:
    if _engine_cache["value"] and time.time() - _engine_cache["at"] < 600:
        return _engine_cache["value"]
    try:
        connection = pymysql.connect(host=settings.TENANT_DB_HOST, port=settings.TENANT_DB_PORT, user=settings.TENANT_DB_USER,
                                     password=settings.TENANT_DB_PASSWORD, connect_timeout=3)
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT VERSION()")
                raw = cursor.fetchone()[0]
        finally:
            connection.close()
    except Exception as exc:
        logger.warning("Could not read tenant database server version: %s", exc)
        return None
    number = raw.split("-")[0]
    _engine_cache.update(at=time.time(), value=f"MariaDB {number}" if "mariadb" in raw.lower() else f"MySQL {number}")
    return _engine_cache["value"]


def _regions() -> list[str]:
    from app.services import platform_infrastructure

    regions = [server.get("region") or platform_infrastructure.DEFAULT_REGION for server in platform_infrastructure.server_inventory()]
    return list(dict.fromkeys(regions)) or [platform_infrastructure.DEFAULT_REGION]


def _dynamic(db: Session) -> dict[str, dict]:
    """Options (and the default) for controls whose choices come from this deployment rather than the prototype."""
    plans = [p.name for p in db.query(Plan).filter(Plan.is_active.is_(True)).order_by(Plan.price_monthly, Plan.id).all()]
    engine = _db_engine_version()
    regions = _regions()
    out = {"plans": {"options": plans, "default": plans[0] if plans else None},
           "regions": {"options": regions, "default": regions[0]}}
    out["db_engine"] = {"options": [engine] if engine else [], "default": engine}
    # Sign-in lockout defaults to the deployment's configured values until changed here.
    out["login_attempts"] = {"options": [], "default": max(1, int(settings.MAX_LOGIN_ATTEMPTS or 5))}
    out["lockout_minutes"] = {"options": [], "default": max(1, int(settings.LOCKOUT_DURATION_MINUTES or 30))}
    return out


def schema(db: Session) -> list[dict]:
    dynamic = _dynamic(db)
    result = []
    for cat in _catalogue():
        groups = []
        for g in cat["groups"]:
            items = []
            for c in g["controls"]:
                item = dict(c)
                if c.get("dynamic"):
                    d = dynamic[c["dynamic"]]
                    item["options"] = d["options"]
                    if c["dynamic"] != "plans" or c["default"] not in d["options"]:
                        item["default"] = d["default"]
                items.append(item)
            groups.append({"name": g["name"], "controls": items})
        result.append({"id": cat["id"], "name": cat["name"], "icon": cat["icon"], "groups": groups})
    return result


def _defaults(db: Session) -> dict[str, Any]:
    return {c["key"]: c["default"] for cat in schema(db) for g in cat["groups"] for c in g["controls"]}


def _stored(db: Session, tenant_id: int) -> dict[str, Any]:
    rows = db.query(PlatformControlValue).filter(PlatformControlValue.tenant_id == tenant_id).all()
    return {r.control_key: r.value for r in rows if r.control_key in _controls()}


def _bridged(db: Session) -> dict[str, Any]:
    """Controls whose platform value lives in an existing platform setting (single source of truth)."""
    from app.services import platform_login_security
    return {"fourEyes": platform_access.four_eyes_enabled(db), "mfaPlat": platform_login_security.mfa_required(db)}


def platform_values(db: Session) -> dict[str, Any]:
    """Effective platform default of every control (schema default unless changed)."""
    values = _defaults(db)
    for key, value in _stored(db, PLATFORM_SCOPE).items():
        if control(key)["status"] not in READ_ONLY_STATUSES:
            values[key] = value
    values.update(_bridged(db))
    return values


def tenant_overrides(db: Session, tenant_id: int) -> dict[str, Any]:
    return {k: v for k, v in _stored(db, tenant_id).items() if not _read_only_for_tenant(control(k))}


def _read_only_for_tenant(c: dict) -> bool:
    return c["status"] in READ_ONLY_STATUSES or c.get("platform_only")


def value(db: Session, key: str, tenant_id: Optional[int] = None) -> Any:
    """Effective value of one control: the tenant's override, else the platform default, else the schema default."""
    c = control(key)
    if tenant_id and not _read_only_for_tenant(c):
        row = db.query(PlatformControlValue).filter(PlatformControlValue.tenant_id == tenant_id, PlatformControlValue.control_key == key).first()
        if row is not None:
            return row.value
    if key in BRIDGED:
        return _bridged(db)[key]
    if c["status"] not in READ_ONLY_STATUSES:
        row = db.query(PlatformControlValue).filter(PlatformControlValue.tenant_id == PLATFORM_SCOPE, PlatformControlValue.control_key == key).first()
        if row is not None:
            return row.value
    if c.get("dynamic"):
        return _defaults(db)[key]
    return c["default"]


def tenant_values(db: Session, key: str, tenant_ids: list[int]) -> dict[int, Any]:
    """Effective value of one control for many tenants at once."""
    base = value(db, key)
    if _read_only_for_tenant(control(key)):
        return {tid: base for tid in tenant_ids}
    rows = db.query(PlatformControlValue).filter(PlatformControlValue.control_key == key, PlatformControlValue.tenant_id.in_(tenant_ids or [0])).all()
    found = {r.tenant_id: r.value for r in rows}
    return {tid: found.get(tid, base) for tid in tenant_ids}


def coerce(db: Session, key: str, raw: Any, tenant_id: Optional[int]) -> Any:
    """Validate a new value for ``key`` against its type, options and status; return the normalised value."""
    c = control(key)
    if c["status"] == "unsupported":
        raise ControlError(f"“{c['label']}” is not supported on this self-hosted deployment: {c['note']}")
    if c["status"] == "fixed":
        raise ControlError(f"“{c['label']}” is fixed by the platform architecture: {c['note']}")
    if tenant_id and c.get("platform_only"):
        raise ControlError(f"“{c['label']}” is a platform-wide setting and cannot be overridden per tenant")
    kind = c["type"]
    if kind == "sw":
        if not isinstance(raw, bool):
            raise ControlError(f"“{c['label']}” must be on or off")
        return raw
    if kind == "num":
        if isinstance(raw, bool):
            raise ControlError(f"“{c['label']}” must be a number")
        try:
            number = float(raw)
        except (TypeError, ValueError):
            raise ControlError(f"“{c['label']}” must be a number")
        if number < 0:
            raise ControlError(f"“{c['label']}” cannot be negative")
        if key in ("sloAvail", "alertErr", "alertCpu", "meterAlert", "relCanaryPct", "ffPct", "capHead") and number > 100:
            raise ControlError(f"“{c['label']}” is a percentage (0–100)")
        if key in BOUNDS:
            low, high = BOUNDS[key]
            if not number.is_integer() or not low <= number <= high:
                raise ControlError(f"“{c['label']}” must be a whole number from {low} to {high}")
        return int(number) if number.is_integer() else number
    if kind == "sel":
        options = next(x["options"] for cat in schema(db) for g in cat["groups"] for x in g["controls"] if x["key"] == key)
        if raw not in options:
            raise ControlError(f"“{raw}” is not an option for “{c['label']}”")
        return raw
    text = str(raw if raw is not None else "").strip()
    if len(text) > 500:
        raise ControlError(f"“{c['label']}” is too long")
    if key == "slugPattern":
        try:
            re.compile(text)
        except re.error as exc:
            raise ControlError(f"Invalid pattern: {exc}")
    if key == "relFreezeDates":
        from app.services.platform_changes import normalize_periods

        try:
            return normalize_periods(text)
        except ValueError as exc:
            raise ControlError(str(exc))
    return text


def store(db: Session, key: str, new_value: Any, tenant_id: int, actor: str) -> tuple[Any, Any]:
    """Save ``new_value`` for the scope (tenant_id 0 = platform). Values equal to what the scope would otherwise inherit
    are not stored, so the control reads as unchanged. Returns (old effective value, new effective value)."""
    old = value(db, key, tenant_id or None)
    inherited = _defaults(db)[key] if not tenant_id else value(db, key, None)
    row = db.query(PlatformControlValue).filter(PlatformControlValue.tenant_id == tenant_id, PlatformControlValue.control_key == key).first()
    if new_value == inherited:
        if row is not None:
            db.delete(row)
    elif row is None:
        db.add(PlatformControlValue(tenant_id=tenant_id, control_key=key, value=new_value, updated_by=actor))
    else:
        row.value = new_value
        row.updated_by = actor
    return old, new_value


def reset(db: Session, keys: list[str], tenant_id: int) -> dict[str, tuple[Any, Any]]:
    """Remove stored values for ``keys`` in the scope; returns {key: (old, new)} for the keys that changed."""
    changed = {}
    for key in keys:
        control(key)
        row = db.query(PlatformControlValue).filter(PlatformControlValue.tenant_id == tenant_id, PlatformControlValue.control_key == key).first()
        if row is None:
            continue
        old = value(db, key, tenant_id or None)
        db.delete(row)
        db.flush()
        changed[key] = (old, value(db, key, tenant_id or None))
    return changed


def visibility_code(db: Session, tenant_id: Optional[int] = None) -> str:
    return VISIBILITY_BY_LABEL.get(value(db, "grpVisible", tenant_id), "full")
