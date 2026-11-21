"""Plans & entitlements: module entitlement by plan and feature-flag rollouts (platform_entitlements).

Under ``/entitlements`` (Feature matrix permission: view to read, manage to change). A plan change reaches every tenant on
the plan and a flag rollout reaches every tenant, so changing either needs all-tenant scope.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.tenant import Feature, Plan, Tenant
from app.routers.platform_router import _build_service_catalog, _get_platform_admin, _write_platform_audit
from app.services import platform_entitlements as ent
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/entitlements", dependencies=[Depends(enforce_platform_access)])


def _require_all_scope(request: Request, what: str) -> None:
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail=f"{what} applies to every tenant – it needs all-tenant scope.")


def _actor(request: Request) -> str:
    return getattr(_get_platform_admin(request), "email", None) or "platform admin"


_PUBLIC_KEYS = ("key", "name", "sub_modules", "always_on", "bundled_with", "bundled_with_name", "is_active",
                "section", "section_label", "custom", "dependencies")


def _public(m: dict) -> dict:
    return {k: m.get(k) for k in _PUBLIC_KEYS}


@router.get("/modules")
def module_catalog(db: Session = Depends(get_master_db_dep)):
    """The tenant modules exactly as Plans & Entitlements lists them (names, sidebar order, feature ids).

    Reference data for every screen that picks modules – tenant onboarding uses it so names and mappings match the
    entitlement grid and the tenant sidebar.
    """
    mods = ent.modules(db, _build_service_catalog(db))
    db.commit()
    return [{**_public(m), "feature_ids": m["feature_ids"]} for m in mods]


@router.get("")
def overview(request: Request, db: Session = Depends(get_master_db_dep)):
    plans = db.query(Plan).order_by(Plan.price_monthly, Plan.name).all()
    mods = ent.modules(db, _build_service_catalog(db))
    by_key = {m["key"]: m for m in mods}
    enabled = {p.id: ent.plan_feature_ids(db, p.id) for p in plans}
    tenants = db.query(Tenant).all()
    allowed = scoped_tenant_ids(request)
    visible = tenants if allowed is None else [t for t in tenants if t.id in set(allowed)]
    db.commit()

    def cell(m: dict, ids: set[int]) -> dict:
        src = by_key.get(m.get("bundled_with") or "") or m  # a bundled module counts its parent's features
        return {"state": ent.cell_state(m, ids, by_key), "on": sum(1 for i in src["feature_ids"] if i in ids), "of": len(src["feature_ids"])}

    return {
        "plans": [{"id": p.id, "name": p.name, "is_active": p.is_active, "price_monthly": p.price_monthly,
                   "tenants": sum(1 for t in tenants if t.plan_id == p.id)} for p in plans],
        "modules": [{**_public(m), "plans": {str(p.id): cell(m, enabled[p.id]) for p in plans}} for m in mods],
        "flags": ent.flags(db, visible),
        "all_scope": allowed is None,
    }


class ModuleEntitlement(BaseModel):
    enabled: bool


@router.put("/plans/{plan_id}/modules/{module_key}")
def set_module(plan_id: int, module_key: str, body: ModuleEntitlement, request: Request, db: Session = Depends(get_master_db_dep)):
    _require_all_scope(request, "A plan's entitlements change")
    plan = db.get(Plan, plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    mods = ent.modules(db, _build_service_catalog(db))
    mod = next((m for m in mods if m["key"] == module_key), None)
    if mod is None:
        raise HTTPException(status_code=404, detail="Module not found in the Services catalog")
    if mod["always_on"]:
        raise HTTPException(status_code=400, detail=f"{mod['name']} is always included in every workspace")
    if mod.get("bundled_with"):
        raise HTTPException(status_code=400, detail=f"{mod['name']} ships with {mod.get('bundled_with_name') or mod['bundled_with']} – change that module instead")
    old = ent.plan_feature_ids(db, plan.id)
    new = old | set(mod["feature_ids"]) if body.enabled else old - set(mod["feature_ids"])
    if new == old:
        return {"changed": False, "state": ent.cell_state(mod, new), "applied": [], "unchanged": [], "failed": []}
    try:
        ent.check_dependencies(db, mods, old, mod, body.enabled)
    except ent.EntitlementError as exc:
        raise HTTPException(status_code=409, detail=str(exc))

    ent.save_plan_features(db, plan.id, new)
    db.flush()
    result = ent.propagate(db, plan, old, new)
    admin, ip = _get_platform_admin(request), get_request_ip(request)
    names = {f.id: f.name for f in db.query(Feature).filter(Feature.id.in_(list(old ^ new) or [0])).all()}
    _write_platform_audit(db, admin, "update_plan_entitlement", "plan", plan.id, plan.name,
                          f"{mod['name']} {'added to' if body.enabled else 'removed from'} plan '{plan.name}'"
                          f" · {len(result['applied'])} tenant(s) updated, {len(result['failed'])} failed", ip,
                          old_data={"feature_ids": sorted(old)}, new_data={"feature_ids": sorted(new), "module": mod["key"], "enabled": body.enabled,
                                                                            "features": sorted(names.values())})
    for t in result["applied"]:
        _write_platform_audit(db, admin, "update_tenant_features", "tenant", t["id"], t["name"],
                              f"Entitlements follow plan '{plan.name}': {mod['name']} {'enabled' if body.enabled else 'disabled'}", ip,
                              new_data={"added": t["added"], "removed": t["removed"], "source": "plan"})
    for t in result["failed"]:
        _write_platform_audit(db, admin, "tenant_entitlement_sync_failed", "tenant", t["id"], t["name"],
                              f"Could not apply plan '{plan.name}' change ({mod['name']}): {t['error']}", ip)
    db.commit()
    return {"changed": True, "state": ent.cell_state(mod, new), **result}


class FlagRollout(BaseModel):
    rollout_percent: int = Field(..., ge=0, le=100)


@router.put("/flags/{key}")
def set_flag(key: str, body: FlagRollout, request: Request, db: Session = Depends(get_master_db_dep)):
    _require_all_scope(request, "A feature-flag rollout")
    if key not in ent.FLAGS:
        raise HTTPException(status_code=404, detail="Feature flag not found")
    old, new = ent.set_flag(db, key, body.rollout_percent, _actor(request))
    if old != new:
        _write_platform_audit(db, _get_platform_admin(request), "update_feature_flag", "feature_flag", None, key,
                              f"{ent.FLAGS[key]['name']} rollout {old}% → {new}%", get_request_ip(request),
                              old_data={"rollout_percent": old}, new_data={"rollout_percent": new})
    db.commit()
    tenants = db.query(Tenant).all()
    return next(f for f in ent.flags(db, tenants) if f["key"] == key)
