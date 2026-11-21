"""Regions & capacity (platform_regions).

Under ``/api/v1/platform/regions`` – Infrastructure permission (view to read; manage to add a region or run a
failover test). Regions serve every tenant, so changes need all-tenant scope.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_controls as controls
from app.services import platform_regions as regions
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/regions", dependencies=[Depends(enforce_platform_access)])


def _schema(db: Session) -> None:
    if not regions._ready["schema"]:
        regions.ensure_schema()
        db.rollback()  # end the access check's snapshot so the new table is visible


def _all_scope(request: Request) -> None:
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail="Regions serve every tenant – this needs all-tenant scope.")


def _actor(request: Request) -> str:
    admin = _get_platform_admin(request)
    return (admin.full_name or admin.username) if admin else "platform admin"


@router.get("")
def overview(request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    return regions.overview(db, scoped_tenant_ids(request))


@router.post("", status_code=201)
def add_region(request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    _all_scope(request)
    try:
        row = regions.add_region(db, _actor(request))
    except regions.RegionError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    _write_platform_audit(db, _get_platform_admin(request), "region_added", "region", row.id, row.name,
                          f"Region {row.name} added to the plan (Planned) from the server registry – no server was provisioned", get_request_ip(request),
                          new_data={"status": "planned"})
    db.commit()
    return {"region": row.name, "status": "Planned"}


@router.post("/{name}/failover-test")
def failover_test(name: str, request: Request, db: Session = Depends(get_master_db_dep)):
    _schema(db)
    _all_scope(request)
    try:
        result = regions.failover_test(db, name, float(controls.value(db, "alertLag") or 10), _actor(request))
    except regions.RegionError as exc:
        db.rollback()
        _write_platform_audit(db, _get_platform_admin(request), "region_failover_test_unavailable", "region", None, name,
                              f"Failover test for {name} not run: {exc}", get_request_ip(request))
        db.commit()
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    _write_platform_audit(db, _get_platform_admin(request), "region_failover_test", "region", None, name,
                          f"{name}: {result['summary']} (readiness check only – nothing was failed over)", get_request_ip(request), new_data=result)
    db.commit()
    return result
