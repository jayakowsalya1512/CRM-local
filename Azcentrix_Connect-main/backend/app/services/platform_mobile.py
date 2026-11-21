"""Mobile app control (Mobile & ecosystem): releases, devices, tenant mobile access, push, security policy, branding.

What the platform can and cannot do today (the app is a separate Flutter project; this backend serves it):
* Devices come from the app's push-token registrations in each tenant database (user_push_tokens) and from the
  device registration API (POST /api/v1/mobile/devices). The current app sends no model, OS, app version or integrity
  result, so those show as "not reported" until it does.
* Sign-in rules are enforced on the server for mobile sign-ins (login_from=mobile, quick-PIN, mobile OTP and the
  Flutter client): tenant mobile access, role access, users whose device was blocked, and – when the app sends
  X-App-Platform / X-App-Version – minimum supported and blocked versions.
* Lock / Block / Wipe revoke what the server controls (mobile sessions, quick-PIN, push tokens). A wipe is queued as a
  command and reported done only when the app acknowledges it (POST /api/v1/mobile/commands/{id}/ack).
* Push goes through Firebase Cloud Messaging; "delivered" means accepted by FCM. APNs, SMS (MSG91) and e-mail digest
  have no integration here and are reported as such. There is no build pipeline or store API access.
"""

from __future__ import annotations

import hashlib
import logging
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.database import MasterSessionLocal, get_tenant_session, master_engine
from app.models.platform_mobile import (PlatformMobileCommand, PlatformMobileDevice, PlatformMobilePush, PlatformMobileRelease,
                                        PlatformMobileSetting, PlatformMobileTenant)
from app.models.tenant import Plan, Tenant
from app.services.tenant_hierarchy import _existing_tables

logger = logging.getLogger(__name__)

PLATFORMS = ("iOS", "Android")
CHANNELS = ("Beta", "Production")
ROLE_GROUPS = {"admin": ["admin"], "ceo": ["ceo"], "manager": ["manager", "vp"], "kam": ["sales", "kam"]}   # column → tenant roles
TENANT_FLAGS = ("enabled", "offline", "gps", "voice", "biometric", "screenshots_blocked", "device_approval")
MOBILE_UA = "Dart/%"                                    # the Flutter client's User-Agent
# key, label, type, default, how it is enforced
POLICY = [
    ("jailbreak", "Detect jailbreak / root and block sign-in", "sw", True, "app"),
    ("pinning", "TLS certificate pinning", "sw", True, "app"),
    ("encrypt", "Encrypt data at rest on device (AES-256)", "sw", True, "app"),
    ("screenshots", "Block screenshots and screen recording by default", "sw", False, "app"),
    ("biometric", "Require biometric or passcode on every launch", "sw", True, "app"),
    ("wipe_after_fails", "Remote wipe on 5 failed unlock attempts", "sw", True, "app"),
    ("idle_minutes", "Auto-logout after inactivity (minutes)", "num", 30, "app"),
    ("offline_days", "Offline data retention (days)", "num", 7, "app"),
    ("offline_queue", "Maximum offline queue (changes)", "num", 500, "app"),
    ("min_os", "Minimum supported OS: iOS 15 / Android 11", "sw", True, "server_if_reported"),
]
MIN_OS = {"iOS": 15, "Android": 11}
AUDIENCES = {"all": "All mobile users", "kam": "All KAMs", "manager": "All managers", "ceo": "CEOs only"}
WHEN = ("Send now", "Tomorrow 09:00", "Quiet-hours aware")
IST = timezone(timedelta(hours=5, minutes=30))
_ready: dict[str, object] = {}


def ensure_schema() -> bool:
    """Create the tables if needed; True when this call checked / created them (callers then restart their transaction)."""
    if _ready.get("schema"):
        return False
    for model in (PlatformMobileSetting, PlatformMobileRelease, PlatformMobileTenant, PlatformMobileDevice, PlatformMobileCommand, PlatformMobilePush):
        model.__table__.create(bind=master_engine, checkfirst=True)
    _ready["schema"] = True
    return True


class MobileError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


# ─── Versions ────────────────────────────────────────────────────────────────

_SEMVER = re.compile(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,4})$")


def parse_version(v: str) -> tuple[int, int, int]:
    m = _SEMVER.match((v or "").strip())
    if not m:
        raise MobileError(f"“{v}” is not a version like 3.4.0", 422)
    return tuple(int(x) for x in m.groups())  # type: ignore[return-value]


def _ver(v: Optional[str]) -> Optional[tuple[int, int, int]]:
    try:
        return parse_version(v) if v else None
    except MobileError:
        return None


# ─── Platform settings ───────────────────────────────────────────────────────

DEFAULTS = {"min_supported": {"iOS": None, "Android": None}, "soft_prompt": True, "blocked": [],
            "policy": {k: d for k, _, _, d, _ in POLICY}}


def settings(db: Session) -> dict:
    ensure_schema()
    stored = {r.key: r.value for r in db.query(PlatformMobileSetting).all()}
    out = {k: stored.get(k, v) for k, v in DEFAULTS.items()}
    out["policy"] = {**DEFAULTS["policy"], **(stored.get("policy") or {})}
    return out


def save_setting(db: Session, key: str, value, actor: str):
    ensure_schema()
    row = db.get(PlatformMobileSetting, key)
    old = row.value if row else DEFAULTS.get(key)
    if row is None:
        row = PlatformMobileSetting(key=key)
        db.add(row)
    row.value, row.updated_by, row.updated_at = value, actor, datetime.utcnow()
    return old


def set_min_supported(db: Session, platform: str, version: str, actor: str):
    if platform not in PLATFORMS:
        raise MobileError("Unknown platform", 422)
    parse_version(version)
    current = settings(db)["min_supported"]
    return save_setting(db, "min_supported", {**current, platform: version.strip()}, actor), version.strip()


def set_policy(db: Session, key: str, value, actor: str):
    spec = next((p for p in POLICY if p[0] == key), None)
    if spec is None:
        raise MobileError("Unknown policy", 404)
    if spec[2] == "sw":
        if not isinstance(value, bool):
            raise MobileError(f"“{spec[1]}” must be on or off", 422)
    else:
        try:
            value = int(value)
        except (TypeError, ValueError):
            raise MobileError(f"“{spec[1]}” must be a whole number", 422)
        limits = {"idle_minutes": (1, 1440), "offline_days": (0, 365), "offline_queue": (0, 100000)}[key]
        if not limits[0] <= value <= limits[1]:
            raise MobileError(f"“{spec[1]}” must be between {limits[0]} and {limits[1]}", 422)
    policy = settings(db)["policy"]
    old = policy.get(key)
    save_setting(db, "policy", {**policy, key: value}, actor)
    return old, value


# ─── Releases ────────────────────────────────────────────────────────────────

def _iso(v: Optional[datetime]) -> Optional[str]:
    return f"{v.replace(microsecond=0).isoformat()}Z" if v else None


def release_dict(r: PlatformMobileRelease) -> dict:
    return {"id": r.id, "version": r.version, "platform": r.platform, "channel": r.channel, "rollout": r.rollout, "status": r.status,
            "min_supported": r.min_supported, "notes": r.notes, "created_at": _iso(r.created_at)}


def releases(db: Session) -> list[dict]:
    ensure_schema()
    rows = db.query(PlatformMobileRelease).all()
    rows.sort(key=lambda r: (_ver(r.version) or (0, 0, 0), r.platform), reverse=True)
    return [release_dict(r) for r in rows]


def create_release(db: Session, version: str, platform: str, channel: str, rollout, notes: str, actor: str) -> PlatformMobileRelease:
    ensure_schema()
    parse_version(version)
    if platform not in PLATFORMS or channel not in CHANNELS:
        raise MobileError("Unknown platform or channel", 422)
    try:
        rollout = int(rollout)
    except (TypeError, ValueError):
        raise MobileError("Rollout must be a whole number", 422)
    if not 0 <= rollout <= 100:
        raise MobileError("Rollout must be between 0 and 100 %", 422)
    if db.query(PlatformMobileRelease.id).filter(PlatformMobileRelease.version == version.strip(), PlatformMobileRelease.platform == platform).first():
        raise MobileError(f"{version} for {platform} already exists", 409)
    s = settings(db)
    row = PlatformMobileRelease(version=version.strip(), platform=platform, channel=channel, rollout=rollout,
                                status="Live" if rollout == 100 else "Rolling out", min_supported=s["min_supported"].get(platform),
                                notes=(notes or "").strip()[:500] or None, created_by=actor, created_at=datetime.utcnow())
    db.add(row)
    db.flush()
    return row


def release_action(db: Session, release: PlatformMobileRelease, action: str, actor: str) -> str:
    if release.status in ("Blocked", "Deprecated") and action in ("roll", "pause"):
        raise MobileError(f"{release.version} {release.platform} is {release.status.lower()}", 409)
    if action == "roll":
        if release.rollout >= 100:
            raise MobileError("Already rolled out to everyone", 409)
        release.rollout = min(100, release.rollout + 25)
        release.status = "Live" if release.rollout == 100 else "Rolling out"
        msg = f"{release.version} {release.platform} rollout at {release.rollout}%"
    elif action == "pause":
        if release.status == "Paused":
            raise MobileError("Already paused", 409)
        release.status = "Paused"
        msg = f"Rollout paused for {release.version} {release.platform}"
    elif action == "force":
        set_min_supported(db, release.platform, release.version, actor)
        msg = f"Forced update: minimum supported {release.platform} version is now {release.version}"
    elif action == "block":
        blocked = settings(db)["blocked"]
        if any(b["version"] == release.version and b["platform"] == release.platform for b in blocked):
            raise MobileError("This version is already blocked", 409)
        save_setting(db, "blocked", blocked + [{"version": release.version, "platform": release.platform}], actor)
        release.status = "Blocked"
        msg = f"{release.version} {release.platform} blocked – users are sent to the update screen"
    else:
        raise MobileError("Unknown action", 404)
    release.updated_at = datetime.utcnow()
    return msg


def _bucket(key: str) -> int:
    return int(hashlib.sha256(key.encode()).hexdigest()[:8], 16) % 100


def version_check(db: Session, platform: str, version: str, device_key: str = "") -> dict:
    """What the app must do: none | soft (update available) | force (below minimum) | blocked (kill switch)."""
    if platform not in PLATFORMS:
        raise MobileError("platform must be iOS or Android", 422)
    current = parse_version(version)
    s = settings(db)
    blocked = any(b["platform"] == platform and b["version"] == version.strip() for b in s["blocked"])
    minimum = s["min_supported"].get(platform)
    offered = [r for r in db.query(PlatformMobileRelease).filter(PlatformMobileRelease.platform == platform,
                                                                 PlatformMobileRelease.status.in_(("Rolling out", "Live"))).all()
               if _ver(r.version) and _ver(r.version) > current and (r.rollout >= 100 or _bucket(f"{r.id}:{device_key}") < r.rollout)]
    latest = max(offered, key=lambda r: _ver(r.version), default=None)
    action = "blocked" if blocked else "force" if minimum and current < parse_version(minimum) else "soft" if latest and s["soft_prompt"] else "none"
    return {"action": action, "min_supported": minimum, "latest": latest.version if latest else None, "blocked": blocked}


# ─── Tenant settings ─────────────────────────────────────────────────────────

def _default_tenant(t) -> dict:
    return {"tenant_id": t.id, "enabled": True, "roles": {k: True for k in ROLE_GROUPS}, "offline": True, "gps": True, "voice": True, "biometric": True,
            "screenshots_blocked": False, "device_approval": False, "max_devices": 3, "app_name": f"{t.name} CRM", "distribution": None}


def tenant_settings(db: Session, tenants: list) -> dict[int, dict]:
    """Settings for many tenants in one query (unsaved tenants get the defaults – everything allowed, as today)."""
    ensure_schema()
    stored = {r.tenant_id: r for r in db.query(PlatformMobileTenant).filter(PlatformMobileTenant.tenant_id.in_([t.id for t in tenants] or [0])).all()}
    enterprise = {p.id for p in db.query(Plan.id).filter(Plan.slug == "enterprise").all()}
    out = {}
    for t in tenants:
        d = _default_tenant(t)
        r = stored.get(t.id)
        if r is not None:
            d.update({k: getattr(r, k) for k in (*TENANT_FLAGS, "max_devices", "app_name", "distribution")}, roles={**d["roles"], **(r.roles or {})})
            d["app_name"] = r.app_name or d["app_name"]
        if not d["distribution"]:
            d["distribution"] = "Branded app" if t.plan_id in enterprise else "Shared app"
        d["bundle_id"] = f"in.{re.sub(r'[^a-z0-9]', '', (t.subdomain or t.slug).lower()) or 'tenant'}.crm"
        d["colour"] = t.primary_color
        d["enterprise"] = t.plan_id in enterprise
        out[t.id] = d
    return out


def update_tenant(db: Session, tenant, changes: dict, actor: str) -> tuple[dict, dict]:
    ensure_schema()
    row = db.get(PlatformMobileTenant, tenant.id)
    current = tenant_settings(db, [tenant])[tenant.id]
    if row is None:
        row = PlatformMobileTenant(tenant_id=tenant.id, roles=current["roles"], max_devices=current["max_devices"], distribution=current["distribution"])
        db.add(row)
    old, new = {}, {}
    for key, value in changes.items():
        if key in TENANT_FLAGS:
            if not isinstance(value, bool):
                raise MobileError(f"{key} must be on or off", 422)
            old[key], new[key] = current[key], value
            setattr(row, key, value)
        elif key == "roles":
            if not isinstance(value, dict) or set(value) - set(ROLE_GROUPS) or not all(isinstance(v, bool) for v in value.values()):
                raise MobileError("Unknown role setting", 422)
            old[key], new[key] = dict(current["roles"]), {**current["roles"], **value}
            row.roles = new[key]
        elif key == "max_devices":
            try:
                value = int(value)
            except (TypeError, ValueError):
                raise MobileError("Max devices must be a whole number", 422)
            if not 1 <= value <= 50:
                raise MobileError("Max devices must be between 1 and 50", 422)
            old[key], new[key] = current["max_devices"], value
            row.max_devices = value
        elif key == "app_name":
            name = (value or "").strip()
            if not name or len(name) > 120:
                raise MobileError("App name must be 1–120 characters", 422)
            old[key], new[key] = current["app_name"], name
            row.app_name = name
        elif key == "distribution":
            if value not in ("Shared app", "Branded app"):
                raise MobileError("Unknown distribution", 422)
            if value == "Branded app" and not current["enterprise"]:
                raise MobileError("A branded app needs the Enterprise plan", 409)
            old[key], new[key] = current["distribution"], value
            row.distribution = value
        else:
            raise MobileError(f"Unknown setting {key}", 422)
    for k in TENANT_FLAGS:
        if getattr(row, k) is None:
            setattr(row, k, current[k])
    row.app_name = row.app_name or current["app_name"]
    row.updated_by, row.updated_at = actor, datetime.utcnow()
    return old, new


# ─── Devices ─────────────────────────────────────────────────────────────────

def _tenant_tokens(tenant) -> list[dict]:
    s = get_tenant_session(tenant.slug)
    try:
        if not _existing_tables(s, ["user_push_tokens"]):
            return []
        return [dict(r) for r in s.execute(text(
            "SELECT p.id, p.user_id, p.platform, p.device_name, p.is_active, COALESCE(p.last_seen_at, p.updated_at, p.created_at) AS seen, u.full_name "
            "FROM user_push_tokens p JOIN users u ON u.id = p.user_id")).mappings()]
    finally:
        s.close()


def _safe(fn, *a):
    try:
        return fn(*a)
    except Exception:  # noqa: BLE001 - an unreachable tenant database is skipped and reported
        logger.warning("Mobile: tenant database unavailable", exc_info=True)
        return None


def sync_devices(db: Session, tenants: list, force: bool = False) -> list[str]:
    """Bring push-token registrations into the registry (at most once a minute). Returns tenants that couldn't be read."""
    ensure_schema()
    last = _ready.get("synced_at")
    if not force and isinstance(last, datetime) and datetime.utcnow() - last < timedelta(minutes=1):
        return list(_ready.get("sync_unreachable") or [])
    with ThreadPoolExecutor(max_workers=min(8, max(1, len(tenants)))) as pool:
        results = list(pool.map(lambda t: (t, _safe(_tenant_tokens, t)), tenants))
    existing = {(d.tenant_id, d.source_ref): d for d in db.query(PlatformMobileDevice).filter(PlatformMobileDevice.source == "push_token",
                                                                                             PlatformMobileDevice.tenant_id.in_([t.id for t in tenants] or [0])).all()}
    unreachable = []
    for tenant, rows in results:
        if rows is None:
            unreachable.append(tenant.name)
            continue
        for r in rows:
            d = existing.get((tenant.id, str(r["id"])))
            if d is None:
                if not r["is_active"]:
                    continue
                db.add(PlatformMobileDevice(tenant_id=tenant.id, user_id=r["user_id"], source="push_token", source_ref=str(r["id"]), user_name=r["full_name"],
                                            model=r["device_name"] or None, platform=r["platform"] if r["platform"] in PLATFORMS else None,
                                            last_seen=r["seen"], status="Active"))
            else:
                d.user_name, d.last_seen = r["full_name"], max(filter(None, (d.last_seen, r["seen"])), default=None)
                if r["device_name"]:
                    d.model = r["device_name"]
    db.commit()
    _ready["synced_at"], _ready["sync_unreachable"] = datetime.utcnow(), unreachable
    return unreachable


def device_dict(d: PlatformMobileDevice, tenant_name: str) -> dict:
    return {"id": d.id, "tenant_id": d.tenant_id, "tenant": tenant_name, "user_id": d.user_id, "user": d.user_name, "model": d.model, "os": d.os,
            "platform": d.platform, "app_version": d.app_version, "integrity": d.integrity, "last_seen": d.last_seen, "status": d.status, "source": d.source}


def devices_page(db: Session, allowed: Optional[list[int]], q: str, offset: int, limit: int) -> dict:
    ensure_schema()
    query = db.query(PlatformMobileDevice, Tenant.name).join(Tenant, Tenant.id == PlatformMobileDevice.tenant_id)
    if allowed is not None:
        query = query.filter(PlatformMobileDevice.tenant_id.in_(allowed or [0]))
    if q:
        like = f"%{q.lower()}%"
        query = query.filter(func.lower(func.concat_ws(" ", PlatformMobileDevice.user_name, Tenant.name, PlatformMobileDevice.model,
                                                       PlatformMobileDevice.os, PlatformMobileDevice.app_version, PlatformMobileDevice.status)).like(like))
    total = query.order_by(None).count()
    rows = query.order_by(PlatformMobileDevice.last_seen.desc(), PlatformMobileDevice.id.desc()).offset(offset).limit(limit).all()
    return {"items": [device_dict(d, n) for d, n in rows], "total": total, "offset": offset, "limit": limit}


def _revoke_mobile(tenant, user_id: int, push_token_id: Optional[str], deactivate_token: bool) -> dict:
    """Server-side effects in the tenant database: the user's mobile sessions, quick-PIN, and (optionally) the push token."""
    s = get_tenant_session(tenant.slug)
    try:
        present = _existing_tables(s, ["user_sessions", "quick_pin_credentials", "user_push_tokens"])
        out = {"mobile_sessions": 0, "quick_pins": 0, "push_tokens": 0}
        if "user_sessions" in present:
            out["mobile_sessions"] = s.execute(text(
                "UPDATE user_sessions SET is_active = 0, revoked_at = NOW(), revoke_reason = 'Mobile device action by platform', revoke_scope = 'platform' "
                "WHERE user_id = :u AND is_active = 1 AND revoked_at IS NULL AND browser LIKE :ua"), {"u": user_id, "ua": MOBILE_UA}).rowcount
        if "quick_pin_credentials" in present:
            out["quick_pins"] = s.execute(text("UPDATE quick_pin_credentials SET is_active = 0 WHERE user_id = :u AND is_active = 1"), {"u": user_id}).rowcount
        if deactivate_token and push_token_id and "user_push_tokens" in present:
            out["push_tokens"] = s.execute(text("UPDATE user_push_tokens SET is_active = 0 WHERE id = :i AND user_id = :u"), {"i": int(push_token_id), "u": user_id}).rowcount
        s.commit()
        return out
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


def device_action(db: Session, device: PlatformMobileDevice, tenant, action: str, actor: str) -> dict:
    """Lock: sign out of the app (server sessions + quick-PIN) and queue a lock. Block: also stop app sign-in for the user and
    remove the push token. Wipe: lock + queue a wipe, done only when the app acknowledges. Restore: back to Active."""
    if action not in ("lock", "wipe", "block", "restore"):
        raise MobileError("Unknown action", 404)
    if action == "restore":
        if device.status == "Active":
            raise MobileError("The device is already active", 409)
        db.query(PlatformMobileCommand).filter(PlatformMobileCommand.device_id == device.id, PlatformMobileCommand.status == "pending") \
            .update({"status": "cancelled"}, synchronize_session=False)
        old, device.status = device.status, "Active"
        return {"status": "Active", "previous": old, "effects": {}}
    if device.status == "Wiped":
        raise MobileError("The device has already been wiped", 409)
    effects = _revoke_mobile(tenant, device.user_id, device.source_ref if device.source == "push_token" else None, action in ("block", "wipe"))
    if action in ("lock", "wipe"):
        db.add(PlatformMobileCommand(device_id=device.id, command=action, status="pending", requested_by=actor, requested_at=datetime.utcnow()))
    device.status = {"lock": "Locked", "block": "Blocked", "wipe": "Wipe pending"}[action]
    return {"status": device.status, "effects": effects}


def mobile_block_reason(db: Session, tenant, user, platform: Optional[str], version: Optional[str], os_version: Optional[str]) -> Optional[tuple[int, str]]:
    """Server-side mobile sign-in rules. None when allowed, else (HTTP status, message)."""
    ensure_schema()
    ts = tenant_settings(db, [tenant])[tenant.id]
    if not ts["enabled"]:
        return 403, "The mobile app is not enabled for your organisation."
    role = (getattr(user, "role", "") or "").lower()
    for column, roles in ROLE_GROUPS.items():
        if role in roles and not ts["roles"].get(column, True):
            return 403, "Your role can't use the mobile app in this organisation."
    if db.query(PlatformMobileDevice.id).filter(PlatformMobileDevice.tenant_id == tenant.id, PlatformMobileDevice.user_id == user.id,
                                                PlatformMobileDevice.status == "Blocked").first():
        return 403, "Mobile access for this account has been blocked. Contact your administrator."
    if platform in PLATFORMS and version:
        try:
            check = version_check(db, platform, version)
        except MobileError:
            check = None
        if check and check["action"] in ("blocked", "force"):
            return 426, f"This app version ({version}) is no longer supported – update the app to continue."
    if platform in PLATFORMS and os_version and settings(db)["policy"].get("min_os"):
        major = re.match(r"(\d+)", os_version.strip())
        if major and int(major.group(1)) < MIN_OS[platform]:
            return 426, f"{platform} {MIN_OS[platform]} or later is required."
    return None


# ─── Overview ────────────────────────────────────────────────────────────────

def _tenant_mobile_activity(tenant) -> dict:
    """Daily distinct users of the Flutter app over 14 days, and mobile sessions over 30 days (one tenant DB)."""
    s = get_tenant_session(tenant.slug)
    try:
        if not _existing_tables(s, ["user_sessions"]):
            return {"days": {}, "sessions_30d": 0}
        days = {str(d): int(n) for d, n in s.execute(text(
            "SELECT DATE(last_active), COUNT(DISTINCT user_id) FROM user_sessions WHERE browser LIKE :ua AND last_active >= CURDATE() - INTERVAL 13 DAY "
            "GROUP BY DATE(last_active)"), {"ua": MOBILE_UA}).all()}
        total = int(s.execute(text("SELECT COUNT(*) FROM user_sessions WHERE browser LIKE :ua AND login_time >= NOW() - INTERVAL 30 DAY"),
                              {"ua": MOBILE_UA}).scalar() or 0)
        return {"days": days, "sessions_30d": total}
    finally:
        s.close()


def overview(db: Session, tenants: list, allowed: Optional[list[int]]) -> dict:
    ensure_schema()
    ids = [t.id for t in tenants]
    base = db.query(PlatformMobileDevice).filter(PlatformMobileDevice.tenant_id.in_(ids or [0]))
    week = datetime.utcnow() - timedelta(days=7)
    agg = base.with_entities(func.count(PlatformMobileDevice.id),
                             func.sum(func.if_((PlatformMobileDevice.status == "Active") & (PlatformMobileDevice.last_seen >= week), 1, 0)),
                             func.sum(func.if_((PlatformMobileDevice.integrity == "compromised") | (PlatformMobileDevice.status != "Active"), 1, 0))).one()
    versions = dict(base.with_entities(func.coalesce(PlatformMobileDevice.app_version, "Not reported"), func.count()).group_by(func.coalesce(PlatformMobileDevice.app_version, "Not reported")).all())
    platforms = dict(base.with_entities(func.coalesce(func.concat_ws(" ", PlatformMobileDevice.platform, PlatformMobileDevice.os), "Not reported"), func.count())
                     .group_by(func.coalesce(func.concat_ws(" ", PlatformMobileDevice.platform, PlatformMobileDevice.os), "Not reported")).all())
    live = [r for r in db.query(PlatformMobileRelease).filter(PlatformMobileRelease.status == "Live").all() if _ver(r.version)]
    latest = max((r.version for r in live), key=_ver, default=None)
    reported = {v: n for v, n in versions.items() if _ver(v)}
    on_latest = round(100 * sum(n for v, n in reported.items() if _ver(v) >= _ver(latest)) / sum(reported.values())) if latest and reported else None
    since = datetime.utcnow() - timedelta(hours=24)
    pushes = db.query(func.coalesce(func.sum(PlatformMobilePush.targeted), 0), func.coalesce(func.sum(PlatformMobilePush.accepted), 0)) \
        .filter(PlatformMobilePush.sent_at >= since, PlatformMobilePush.status == "sent").one()
    with ThreadPoolExecutor(max_workers=min(8, max(1, len(tenants)))) as pool:
        activity = list(pool.map(lambda t: (t, _safe(_tenant_mobile_activity, t)), tenants))
    today = datetime.now(IST).date()
    days = [str(today - timedelta(days=13 - i)) for i in range(14)]
    dau = [sum((a or {}).get("days", {}).get(d, 0) for _, a in activity) for d in days]
    by_tenant = sorted(((t.name, (a or {}).get("sessions_30d", 0)) for t, a in activity if a is not None), key=lambda x: -x[1])
    return {
        "kpis": {"registered": int(agg[0] or 0), "active_7d": int(agg[1] or 0), "crash_free": None, "latest_version": latest, "on_latest": on_latest,
                 "versions_reported": sum(reported.values()), "push_24h": int(pushes[1]), "push_rate": round(100 * pushes[1] / pushes[0]) if pushes[0] else None,
                 "flagged": int(agg[2] or 0)},
        "versions": [{"l": k, "v": int(v)} for k, v in sorted(versions.items(), key=lambda x: -x[1])],
        "platforms": [{"l": k or "Not reported", "v": int(v)} for k, v in sorted(platforms.items(), key=lambda x: -x[1])],
        "dau": {"labels": days, "values": dau},
        "usage": [{"l": n, "v": v} for n, v in by_tenant],
        "unreachable": [t.name for t, a in activity if a is None],
    }


# ─── Push ────────────────────────────────────────────────────────────────────

def _audience_targets(db: Session, audience: str, allowed: Optional[list[int]]) -> tuple[list, Optional[list[str]], str]:
    q = db.query(Tenant).filter(Tenant.status != "cancelled")
    if allowed is not None:
        q = q.filter(Tenant.id.in_(allowed or [0]))
    if audience in AUDIENCES:
        roles = None if audience == "all" else ROLE_GROUPS[audience]
        return q.order_by(Tenant.name).all(), roles, AUDIENCES[audience]
    if audience.startswith("tenant:"):
        try:
            tid = int(audience.split(":", 1)[1])
        except ValueError:
            raise MobileError("Unknown audience", 422)
        tenant = q.filter(Tenant.id == tid).first()
        if tenant is None:
            raise MobileError("Tenant not found", 404)
        return [tenant], None, tenant.name
    raise MobileError("Unknown audience", 422)


def _schedule_for(when: str) -> Optional[datetime]:
    now = datetime.now(IST)
    if when == "Send now":
        return None
    if when == "Tomorrow 09:00":
        target = (now + timedelta(days=1)).replace(hour=9, minute=0, second=0, microsecond=0)
    elif when == "Quiet-hours aware":   # 08:00–21:00 IST
        if 8 <= now.hour < 21:
            return None
        target = (now if now.hour < 8 else now + timedelta(days=1)).replace(hour=8, minute=0, second=0, microsecond=0)
    else:
        raise MobileError("Unknown schedule", 422)
    return target.astimezone(timezone.utc).replace(tzinfo=None)


def _tokens_for(tenant, roles: Optional[list[str]]) -> list[tuple[int, str]]:
    s = get_tenant_session(tenant.slug)
    try:
        if not _existing_tables(s, ["user_push_tokens"]):
            return []
        sql = "SELECT p.id, p.token FROM user_push_tokens p JOIN users u ON u.id = p.user_id WHERE p.is_active = 1 AND u.is_active = 1"
        params = {}
        if roles:
            sql += " AND u.role IN (" + ", ".join(f":r{i}" for i in range(len(roles))) + ")"
            params = {f"r{i}": r for i, r in enumerate(roles)}
        return [(int(i), t) for i, t in s.execute(text(sql), params).all()]
    finally:
        s.close()


def _fcm_send(tokens: list[str], title: str, body: str):
    """Real FCM send (batches of 500). Returns a list of (ok, permanent_error) per token."""
    from app.core.firebase import get_firebase_app
    from firebase_admin import messaging
    get_firebase_app()
    out = []
    for i in range(0, len(tokens), 500):
        batch = [messaging.Message(notification=messaging.Notification(title=title, body=body), data={"type": "platform_announcement"}, token=t) for t in tokens[i:i + 500]]
        resp = messaging.send_each(batch)
        for r in resp.responses:
            name = type(r.exception).__name__ if r.exception else ""
            out.append((r.success, name in ("UnregisteredError", "SenderIdMismatchError", "InvalidArgumentError")))
    return out


def _deactivate_tokens(tenant, token_ids: list[int]) -> None:
    if not token_ids:
        return
    s = get_tenant_session(tenant.slug)
    try:
        s.execute(text("UPDATE user_push_tokens SET is_active = 0, last_error = 'Unregistered (platform push)' WHERE id IN (" +
                       ", ".join(str(int(i)) for i in token_ids) + ")"))
        s.commit()
    finally:
        s.close()


def deliver_push(db: Session, push: PlatformMobilePush, allowed: Optional[list[int]], sender=None) -> PlatformMobilePush:
    tenants, roles, _ = _audience_targets(db, push.audience, allowed)
    targeted = accepted = failed = 0
    errors = []
    for tenant in tenants:
        try:
            tokens = _tokens_for(tenant, roles)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{tenant.name}: database unreachable")
            logger.warning("Push: %s unreachable: %s", tenant.slug, exc)
            continue
        if not tokens:
            continue
        targeted += len(tokens)
        try:
            results = (sender or _fcm_send)([t for _, t in tokens], push.title, push.message)
        except Exception as exc:  # noqa: BLE001 - FCM not configured / unreachable: reported, not hidden
            failed += len(tokens)
            errors.append(f"FCM: {type(exc).__name__}: {str(exc)[:120]}")
            continue
        dead = [tokens[i][0] for i, (ok_, permanent) in enumerate(results) if not ok_ and permanent]
        accepted += sum(1 for ok_, _ in results if ok_)
        failed += sum(1 for ok_, _ in results if not ok_)
        _safe(_deactivate_tokens, tenant, dead)
    push.targeted, push.accepted, push.failed = targeted, accepted, failed
    push.status = "sent" if accepted or not targeted else "failed"
    push.error = ("; ".join(errors))[:300] or (None if targeted else "No registered devices in this audience")
    push.sent_at = datetime.utcnow()
    return push


def create_push(db: Session, audience: str, when: str, title: str, message: str, allowed: Optional[list[int]], actor: str, sender=None) -> PlatformMobilePush:
    ensure_schema()
    title, message = (title or "").strip(), (message or "").strip()
    if not title or not message:
        raise MobileError("Add a title and a message", 422)
    if when not in WHEN:
        raise MobileError("Unknown schedule", 422)
    _, _, label = _audience_targets(db, audience, allowed)
    push = PlatformMobilePush(title=title[:200], message=message[:2000], audience=audience, audience_label=label, when=when,
                              scheduled_for=_schedule_for(when), status="scheduled", sent_by=actor, created_at=datetime.utcnow())
    db.add(push)
    db.flush()
    if push.scheduled_for is None:
        push.status = "sending"
        deliver_push(db, push, allowed, sender)
    return push


def push_dict(p: PlatformMobilePush) -> dict:
    return {"id": p.id, "title": p.title, "audience": p.audience_label, "when": p.when, "status": p.status, "sent": p.targeted, "accepted": p.accepted,
            "failed": p.failed, "delivered_pct": round(100 * p.accepted / p.targeted) if p.targeted else None, "error": p.error,
            "date": _iso(p.sent_at or p.scheduled_for or p.created_at), "scheduled_for": _iso(p.scheduled_for)}


def run_due_pushes(sender=None) -> int:
    ensure_schema()
    db = MasterSessionLocal()
    try:
        due = db.query(PlatformMobilePush).filter(PlatformMobilePush.status == "scheduled", PlatformMobilePush.scheduled_for <= datetime.utcnow()).all()
        for p in due:
            claimed = db.query(PlatformMobilePush).filter(PlatformMobilePush.id == p.id, PlatformMobilePush.status == "scheduled") \
                .update({"status": "sending"}, synchronize_session=False)
            db.commit()
            if claimed:
                deliver_push(db, db.get(PlatformMobilePush, p.id), None, sender)
                db.commit()
        return len(due)
    finally:
        db.close()


def start_push_worker() -> None:
    if _ready.get("push_worker"):
        return
    stop = threading.Event()

    def loop():
        while not stop.wait(60):
            try:
                run_due_pushes()
            except Exception:  # noqa: BLE001
                logger.exception("Scheduled push pass failed")
    threading.Thread(target=loop, daemon=True, name="mobile-push").start()
    _ready["push_worker"] = stop


def providers(db: Session, tenants: list) -> list[dict]:
    """Connection status – 'Connected' only when verified now."""
    from app.core.config import settings as cfg
    fcm = {"name": "Firebase Cloud Messaging", "status": "Not connected", "detail": ""}
    try:
        from app.core.firebase import get_firebase_app
        from firebase_admin import messaging
        get_firebase_app()
        token = None
        for t in tenants:
            rows = _safe(_tokens_for, t, None) or []
            if rows:
                token = rows[0][1]
                break
        if token:
            try:
                messaging.send(messaging.Message(token=token, data={"type": "connection_check"}), dry_run=True)
                fcm.update(status="Connected", detail="Credentials verified with a dry-run send (nothing delivered)")
            except Exception as exc:  # noqa: BLE001
                # FCM only judges the token after accepting our credentials, so a token error still proves the connection.
                if type(exc).__name__ in ("UnregisteredError", "InvalidArgumentError", "SenderIdMismatchError"):
                    fcm.update(status="Connected", detail="Credentials verified by FCM (the device token used for the check is no longer registered)")
                else:
                    raise
        else:
            fcm.update(status="Not verified", detail="Credentials load; no registered device to verify against")
    except Exception as exc:  # noqa: BLE001
        fcm.update(status="Not connected", detail=f"{type(exc).__name__}: {str(exc)[:120]}")
    return [
        {"name": "Apple Push (APNs)", "status": "Not verified", "detail": "iOS pushes go through FCM; the APNs key is held in the Firebase console and can't be checked from here"},
        fcm,
        {"name": "SMS fallback (MSG91)", "status": "Not configured", "detail": "No SMS provider is integrated"},
        {"name": "Email digest", "status": "Not available", "detail": "No mobile e-mail digest exists" + ("" if cfg.SMTP_HOST else "; platform e-mail is not configured")},
    ]


def app_config(db: Session, tenant) -> dict:
    """What the app receives (GET /api/v1/mobile/config): platform policy merged with the tenant's (stricter-only) rules."""
    s = settings(db)
    ts = tenant_settings(db, [tenant])[tenant.id]
    policy = dict(s["policy"])
    policy["screenshots"] = bool(policy["screenshots"] or ts["screenshots_blocked"])   # a tenant can only tighten
    policy["biometric"] = bool(policy["biometric"] or ts["biometric"])
    return {"enabled": ts["enabled"], "features": {"offline": ts["offline"], "gps_check_in": ts["gps"], "voice_notes": ts["voice"]},
            "device_approval": ts["device_approval"], "max_devices": ts["max_devices"], "policy": policy, "min_supported": s["min_supported"],
            "app_name": ts["app_name"], "branding": {"colour": ts["colour"], "distribution": ts["distribution"]}}
