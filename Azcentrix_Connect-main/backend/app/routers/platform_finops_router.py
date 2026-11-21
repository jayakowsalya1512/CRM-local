"""Cost & margin (Business) – platform console API (platform_finops).

Under ``/finops`` (Plans & billing permission). Staff with assigned-tenant scope see only their tenants; shared costs are
still allocated across every tenant first, so a scoped view shows the same per-tenant figures.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_finops as fo
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/finops", dependencies=[Depends(enforce_platform_access)])


def _json(v):
    """Money as numbers; naive UTC times marked so the browser shows local time."""
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, datetime):
        return v.isoformat() + "Z"
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, dict):
        return {k: _json(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_json(x) for x in v]
    return v


@router.get("")
def overview(request: Request, refresh: bool = False, db: Session = Depends(get_master_db_dep)):
    fo.ensure_schema()
    data = fo.cached(refresh)
    db.rollback()   # read the snapshot rows written after this session started
    scope = scoped_tenant_ids(request)
    return _json({**fo.summary(db, data, scope), "savings": fo.savings(db, data, scope), "all_scope": scope is None})


@router.get("/tenants")
def tenants(request: Request, q: str = "", sort: str = "tt:-1", offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=500)):
    data = fo.cached()
    return _json(fo.page(fo.scoped(data, scoped_tenant_ids(request)), q, sort, offset, limit))


@router.get("/export")
def export(request: Request, db: Session = Depends(get_master_db_dep)):
    fo.ensure_schema()
    admin = _get_platform_admin(request)
    actor = getattr(admin, "email", None) or "platform admin"
    data = fo.cached()
    db.rollback()
    scope = scoped_tenant_ids(request)
    body = fo.workbook(db, data, scope, actor)
    _write_platform_audit(db, admin, "finops_export", "platform_setting", None, "Cost & margin",
                          f"Exported the cost & margin report for {data['month']:%B %Y} ({len(fo.scoped(data, scope))} tenant(s))", get_request_ip(request))
    db.commit()
    name = f"cost-margin-{data['month']:%Y-%m}.xlsx"
    return Response(body, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})
