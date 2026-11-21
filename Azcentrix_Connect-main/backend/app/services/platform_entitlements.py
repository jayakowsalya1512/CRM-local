"""Plans & entitlements: which tenant modules each plan includes, and staged feature-flag rollouts (platform_entitlements).

Modules and sub-modules come from the Services catalog; a plan's entitlements are its ``plan_features`` rows (the same
records the Feature Matrix edits). A module is entitled on a plan when its feature and all of its sub-module features are.

Plan changes reach tenants by difference: a tenant follows its plan for every feature where it still matched the plan
before the change, and keeps every feature where it differed (an explicit tenant override). The tenant database is
re-synced the same way the tenant feature editor does it.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Callable, Optional

from sqlalchemy import Column, DateTime, Integer, String, Text, func
from sqlalchemy.orm import Session

from app.database import Base, get_tenant_session, master_engine
from app.models.tenant import Feature, Plan, PlanFeature, ServiceDependency, Tenant, TenantFeature
from app.services.tenant_module_service import (
    ALWAYS_ENABLED_PERMISSION_MODULES,
    DEFAULT_TENANT_MODULES,
    FEATURE_MODULE_ALIASES,
    SECTION_SORT_ORDER,
    sync_tenant_runtime_catalog,
)

logger = logging.getLogger(__name__)


class PlatformFeatureFlag(Base):
    """Rollout percentage of a feature flag declared in code (see ``register``)."""
    __tablename__ = "platform_feature_flags"

    key = Column(String(100), primary_key=True)
    rollout_percent = Column(Integer, nullable=False, default=0)
    note = Column(Text, nullable=True)
    updated_by = Column(String(255), nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


_ready: dict[str, bool] = {}


def ensure_schema() -> None:
    if not _ready.get("schema"):
        PlatformFeatureFlag.__table__.create(bind=master_engine, checkfirst=True)
        _ready["schema"] = True


# ─── Feature flags ───────────────────────────────────────────────────────────
# Code that ships behind a flag declares it here and asks ``flag_enabled`` per tenant. Only declared flags are listed:
# a flag nothing checks would be a switch that does nothing.

FLAGS: dict[str, dict] = {}


def register(key: str, name: str, description: str = "", default_percent: int = 0) -> None:
    FLAGS[key] = {"key": key, "name": name, "description": description, "default_percent": max(0, min(100, int(default_percent)))}


def bucket(key: str, tenant_slug: str) -> int:
    """Stable 0–99 bucket for a tenant: raising the percentage only ever adds tenants."""
    return int(hashlib.sha256(f"{key}:{tenant_slug}".encode()).hexdigest()[:8], 16) % 100


def flag_enabled(db: Session, key: str, tenant_slug: str) -> bool:
    flag = FLAGS.get(key)
    if flag is None:
        return False
    ensure_schema()
    row = db.get(PlatformFeatureFlag, key)
    percent = row.rollout_percent if row else flag["default_percent"]
    return bucket(key, tenant_slug) < percent


def flags(db: Session, tenants: list[Tenant]) -> list[dict]:
    ensure_schema()
    rows = {r.key: r for r in db.query(PlatformFeatureFlag).filter(PlatformFeatureFlag.key.in_(list(FLAGS) or [""])).all()}
    out = []
    for key, flag in FLAGS.items():
        row = rows.get(key)
        percent = row.rollout_percent if row else flag["default_percent"]
        out.append({**flag, "rollout_percent": percent, "tenants_on": sum(1 for t in tenants if bucket(key, t.slug) < percent), "tenants": len(tenants),
                    "updated_by": row.updated_by if row else None, "updated_at": row.updated_at if row else None})
    return out


def set_flag(db: Session, key: str, percent: int, actor: str) -> tuple[int, int]:
    ensure_schema()
    flag = FLAGS[key]
    row = db.get(PlatformFeatureFlag, key)
    old = row.rollout_percent if row else flag["default_percent"]
    if row is None:
        row = PlatformFeatureFlag(key=key)
        db.add(row)
    row.rollout_percent, row.updated_by = percent, actor
    return old, percent


# ─── Module entitlements ─────────────────────────────────────────────────────

# Tenant sidebar sections (DEFAULT_TENANT_MODULES "section"), in sidebar order. Custom catalog modules come last.
SECTION_LABELS: dict[str, str] = {
    "home": "Home", "sales": "Sales", "finance": "Finance & Field", "intelligence": "Intelligence",
    "automation": "Automation & Control", "directory": "Directory", "admin": "Administration",
}
CUSTOM_SECTION = "custom"
# Rows the tenant sidebar never shows (Sidebar.tsx SIDEBAR_HIDDEN_MODULE_KEYS) – Team Chat lives in the footer widget.
SIDEBAR_HIDDEN_KEYS = {"team_chat"}


def _bundled_with() -> dict[str, str]:
    """Sidebar module → the module whose feature switches it on (FEATURE_MODULE_ALIASES, e.g. Forecasts ships with Leads)."""
    out: dict[str, str] = {}
    for parent, keys in FEATURE_MODULE_ALIASES.items():
        for key in keys:
            if key != parent:
                out.setdefault(key, parent)
    return out


def modules(db: Session, catalog: list[dict]) -> list[dict]:
    """Every tenant sidebar module plus custom catalog modules, in sidebar order, with the feature ids an entitlement covers.

    A sidebar module without its own platform feature is either always on, or ships with another module's feature
    (``bundled_with``) – its entitlement follows that module and can't be changed on its own.
    """
    features = db.query(Feature).all()
    by_name: dict[str, list[int]] = {}
    for f in features:
        if f.module:
            by_name.setdefault(f.module.strip().lower(), []).append(f.id)
    defaults = {str(m["key"]): m for m in DEFAULT_TENANT_MODULES}
    bundles = _bundled_with()
    out = []
    for item in catalog:
        if item.get("parent_id") is not None or item.get("parent_key") or item["key"] in SIDEBAR_HIDDEN_KEYS:
            continue
        default = defaults.get(item["key"])
        if item["id"] is None and default is None:
            continue
        always_on = item["key"] in ALWAYS_ENABLED_PERMISSION_MODULES or bool(default and default.get("is_system"))
        bundled = bundles.get(item["key"]) if item["id"] is None and not always_on else None
        if item["id"] is None:
            ids: set[int] = set()
            subs: list[dict] = []
        else:
            subs = [c for c in catalog if c["id"] is not None and c["id"] != item["id"] and (c.get("parent_id") == item["id"] or c.get("parent_key") == item["key"])]
            ids = {item["id"], *(c["id"] for c in subs)}
            # Sub-features recorded under the module's name (e.g. the individual Analytical Reports) belong to it as well.
            ids.update(by_name.get(item["name"].strip().lower(), []))
        section = str(default["section"]) if default else CUSTOM_SECTION
        out.append({"key": item["key"], "name": item["name"], "feature_id": item["id"], "feature_ids": sorted(ids),
                    "sub_modules": sorted({c["name"] for c in subs} | {f.name for f in features if f.id in ids and f.id != item["id"] and f.id not in {c["id"] for c in subs}}),
                    "always_on": always_on, "bundled_with": bundled, "is_active": item["is_active"],
                    "section": section, "section_label": SECTION_LABELS.get(section, "Custom modules"),
                    "custom": default is None, "dependencies": item.get("dependencies") or [],
                    "_sort": (SECTION_SORT_ORDER.get(section, 900), int(default["sort_order"]) if default else 0, item["name"].lower())})
    out.sort(key=lambda m: m.pop("_sort"))
    by_key = {m["key"]: m for m in out}
    for m in out:  # a bundle whose parent isn't listed can't follow it – treat it as always present
        if m["bundled_with"] and m["bundled_with"] not in by_key:
            m["bundled_with"], m["always_on"] = None, True
        if m["bundled_with"]:
            m["bundled_with_name"] = by_key[m["bundled_with"]]["name"]
    return out


def plan_feature_ids(db: Session, plan_id: int) -> set[int]:
    return {r.feature_id for r in db.query(PlanFeature).filter(PlanFeature.plan_id == plan_id, PlanFeature.enabled == True).all()}  # noqa: E712


def cell_state(mod: dict, enabled: set[int], mods_by_key: Optional[dict[str, dict]] = None) -> str:
    if mod["always_on"]:
        return "always"
    parent = (mods_by_key or {}).get(mod.get("bundled_with") or "")
    if parent is not None:
        return cell_state(parent, enabled, mods_by_key)
    if not mod["feature_ids"]:
        return "off"
    on = sum(1 for i in mod["feature_ids"] if i in enabled)
    return "on" if on == len(mod["feature_ids"]) else "partial" if on else "off"


class EntitlementError(Exception):
    pass


def check_dependencies(db: Session, mods: list[dict], enabled: set[int], changed: dict, turning_on: bool) -> None:
    """A module can't be added without the modules it depends on, nor removed while another entitled module needs it."""
    by_key = {m["key"]: m for m in mods}
    entitled = {m["key"] for m in mods if cell_state(m, enabled, by_key) in ("on", "always")}
    deps = db.query(ServiceDependency).all()
    if turning_on:
        missing = [by_key[d.dependency_key]["name"] for d in deps if d.service_key == changed["key"] and d.dependency_key in by_key and d.dependency_key not in entitled]
        if missing:
            raise EntitlementError(f"{changed['name']} needs {', '.join(missing)} on this plan first")
    else:
        needed_by = [by_key[d.service_key]["name"] for d in deps if d.dependency_key == changed["key"] and d.service_key in entitled and d.service_key in by_key]
        if needed_by:
            raise EntitlementError(f"{changed['name']} can't be removed: {', '.join(needed_by)} on this plan depends on it")


def save_plan_features(db: Session, plan_id: int, feature_ids: set[int]) -> None:
    """Upsert the plan's rows so there is never more than one row per plan and feature."""
    rows = {r.feature_id: r for r in db.query(PlanFeature).filter(PlanFeature.plan_id == plan_id).all()}
    for fid, row in rows.items():
        row.enabled = fid in feature_ids
    for fid in feature_ids - set(rows):
        db.add(PlanFeature(plan_id=plan_id, feature_id=fid, enabled=True))


def tenant_feature_ids(db: Session, tenant: Tenant, plan_ids: set[int]) -> set[int]:
    """The tenant's effective features: its own rows, or its plan's (``plan_ids``) when it has none, as the tenant feature editor reads it."""
    ids = {r.feature_id for r in db.query(TenantFeature).filter(TenantFeature.tenant_id == tenant.id, TenantFeature.enabled == True).all()}  # noqa: E712
    return ids or set(plan_ids)


def follow_plan(current: set[int], old_plan: set[int], new_plan: set[int]) -> set[int]:
    """Apply a plan change to a tenant, leaving its explicit overrides (where it differed from the old plan) alone."""
    return (current | (new_plan - old_plan)) - (old_plan - new_plan)


def apply_tenant_features(db: Session, tenant: Tenant, feature_ids: set[int], sync: Callable[[str, list[str]], None] | None = None) -> None:
    """Sync the tenant database first, then record the tenant's features; raises if the tenant database can't be updated."""
    keys = [f.key for f in db.query(Feature).filter(Feature.id.in_(feature_ids or [0])).all()]
    (sync or sync_tenant_db)(tenant.slug, keys)
    rows = {r.feature_id: r for r in db.query(TenantFeature).filter(TenantFeature.tenant_id == tenant.id).all()}
    for fid, row in rows.items():
        if fid not in feature_ids:
            db.delete(row)
        elif not row.enabled:
            row.enabled = True
    for fid in feature_ids - set(rows):
        db.add(TenantFeature(tenant_id=tenant.id, feature_id=fid, enabled=True, source="plan"))


def sync_tenant_db(slug: str, feature_keys: list[str]) -> None:
    tenant_db = get_tenant_session(slug)
    tenant_db.info["tenant_slug"] = slug
    try:
        sync_tenant_runtime_catalog(tenant_db, enabled_feature_keys=feature_keys, assign_permissions_to_admin_role=True)
        tenant_db.commit()
    except Exception:
        tenant_db.rollback()
        raise
    finally:
        tenant_db.close()


def propagate(db: Session, plan: Plan, old_plan: set[int], new_plan: set[int], sync=None) -> dict:
    """Push a plan's entitlement change to its tenants; tenants whose database can't be reached are reported, not hidden."""
    applied, unchanged, failed = [], [], []
    for tenant in db.query(Tenant).filter(Tenant.plan_id == plan.id).order_by(Tenant.name).all():
        current = tenant_feature_ids(db, tenant, old_plan)
        target = follow_plan(current, old_plan, new_plan)
        if target == current:
            unchanged.append(tenant.name)
            continue
        try:
            with db.begin_nested():
                apply_tenant_features(db, tenant, target, sync)
            applied.append({"id": tenant.id, "name": tenant.name, "added": sorted(target - current), "removed": sorted(current - target)})
        except Exception as exc:  # noqa: BLE001 - one unreachable tenant database must not block the others
            logger.warning("Entitlement sync failed for tenant %s: %s", tenant.slug, exc)
            failed.append({"id": tenant.id, "name": tenant.name, "error": str(exc)[:200]})
    return {"applied": applied, "unchanged": unchanged, "failed": failed}


def tenant_plan_change(db: Session, tenant: Tenant, old_plan_id: Optional[int], new_plan_id: Optional[int], sync=None) -> dict:
    """Move a tenant's features from its old plan's entitlements to the new plan's, keeping its explicit overrides."""
    old_plan = plan_feature_ids(db, old_plan_id) if old_plan_id else set()
    new_plan = plan_feature_ids(db, new_plan_id) if new_plan_id else set()
    current = tenant_feature_ids(db, tenant, old_plan)
    target = follow_plan(current, old_plan, new_plan)
    if target != current:
        apply_tenant_features(db, tenant, target, sync)
    return {"added": sorted(target - current), "removed": sorted(current - target)}
