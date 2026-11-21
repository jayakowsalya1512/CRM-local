"""Infrastructure & releases: services, release pipeline and capacity forecast.

Under ``/infrastructure`` (Infrastructure & Releases permission: view to read, manage to start, promote or roll back a
release). Releases change the platform for every tenant, so actions also need all-tenant scope. Every action is written
to the platform audit log; the steps themselves run through the deployment service (platform_releases).
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.platform_release import PlatformRelease
from app.routers.platform_router import _get_platform_admin
from app.services import platform_capacity as capacity
from app.services import platform_releases as releases
from app.services import platform_service_status as service_status
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/platform/infrastructure", dependencies=[Depends(enforce_platform_access)])


@router.get("")
def overview(request: Request, refresh: bool = Query(False), db: Session = Depends(get_master_db_dep)):
    releases.ensure_schema()  # before this session's first read: a snapshot older than the table fails (1412)
    try:
        capacity.sample()  # no-op once this hour is stored
    except Exception:
        logger.exception("Capacity sample failed")
    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "services": service_status.services(db, force=refresh),
        "pipeline": releases.pipeline(db),
        "capacity": capacity.forecast(),
        "all_scope": scoped_tenant_ids(request) is None,
    }


def _authorize(request: Request) -> None:
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail="Releases change the platform for every tenant – this needs all-tenant scope.")


def _release(db: Session, release_id: int) -> PlatformRelease:
    releases.ensure_schema()
    release = db.get(PlatformRelease, release_id)
    if not release:
        raise HTTPException(status_code=404, detail="Release not found")
    return release


def _run(fn, *args):
    try:
        return fn(*args)
    except releases.ReleaseError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))


class ReleaseCreate(BaseModel):
    version: str = Field(min_length=5, max_length=40)
    notes: Optional[str] = Field(default=None, max_length=2000)


@router.post("/releases")
def create_release(data: ReleaseCreate, request: Request, db: Session = Depends(get_master_db_dep)):
    _authorize(request)
    release = _run(releases.create, db, data.version, data.notes, _get_platform_admin(request), get_request_ip(request))
    return releases.release_payload(db, release)


@router.post("/releases/{release_id}/promote")
def promote_release(release_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    _authorize(request)
    release = _release(db, release_id)
    target = _run(releases.promote, db, release, _get_platform_admin(request), get_request_ip(request))
    return {"ok": True, "target_percent": target, "release": releases.release_payload(db, release)}


@router.post("/releases/{release_id}/rollback")
def rollback_release(release_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    _authorize(request)
    release = _release(db, release_id)
    target = _run(releases.rollback, db, release, _get_platform_admin(request), get_request_ip(request))
    return {"ok": True, "target_version": target.version, "release": releases.release_payload(db, release)}


@router.get("/releases/{release_id}/steps")
def release_steps(release_id: int, db: Session = Depends(get_master_db_dep)):
    release = _release(db, release_id)
    return {"release": releases.release_payload(db, release), "steps": releases.steps(db, release.id)}
