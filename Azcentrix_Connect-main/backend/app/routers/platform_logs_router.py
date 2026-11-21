"""Logs explorer: application log lines from every API / Celery worker (platform_logs).

Read-only, under ``/logs`` (Logs Explorer permission, view). Staff with assigned tenant scope see only the lines
of their tenants – platform-wide lines (no tenant) can mention any tenant, so they stay hidden from them.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.models.tenant import Tenant
from app.services import platform_logs
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/logs", dependencies=[Depends(enforce_platform_access)])


@router.get("")
def list_logs(request: Request, db: Session = Depends(get_master_db_dep), q: str = Query("", max_length=200),
              f_t: str = Query("", max_length=40), f_lv: str = Query("", max_length=10), f_svc: str = Query("", max_length=40),
              f_ten: str = Query("", max_length=100), f_msg: str = Query("", max_length=200),
              before_id: Optional[int] = None, after_id: Optional[int] = None, limit: int = Query(500, ge=1, le=1000)):
    allowed = scoped_tenant_ids(request)
    tenants = None if allowed is None else {s for (s,) in db.query(Tenant.slug).filter(Tenant.id.in_(allowed or [0])).all()}
    result = platform_logs.query(q=q, filters={"t": f_t, "lv": f_lv, "svc": f_svc, "ten": f_ten, "msg": f_msg}, tenants=tenants,
                                 before_id=before_id, after_id=after_id, limit=limit)
    return {**result, "status": platform_logs.status() if not after_id else None, "scoped": allowed is not None}
