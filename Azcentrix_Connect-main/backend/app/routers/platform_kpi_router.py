"""KPI drill-down for every platform page: GET /api/v1/platform/kpi/{key}.

The route guard lets any platform session through (``/kpi`` is OPEN there); each KPI then requires "view" on the
module(s) its spec names, and records are limited to the caller's tenant scope. ``format=csv`` exports the filtered
records and is written to the platform audit trail.
"""

from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_kpi as engine
from app.services import platform_kpi_specs  # noqa: F401  (registers every KPI)
from app.services.platform_access import MODULE_LABELS, can, enforce_platform_access, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/kpi", dependencies=[Depends(enforce_platform_access)])


def _spec(key: str, request: Request) -> engine.Kpi:
    kpi = engine.REGISTRY.get(key)
    if kpi is None:
        raise HTTPException(status_code=404, detail="Unknown KPI")
    access = request.state.platform_access
    modules = engine.modules_of(kpi)
    if not any(can(access, m, "view") for m in modules):
        raise HTTPException(status_code=403, detail=f"Your platform role ({access['role_name']}) can't view {MODULE_LABELS.get(modules[0], 'this area')}.")
    return kpi


@router.get("/{key}")
def kpi_detail(
    key: str,
    request: Request,
    q: str = Query("", max_length=120),
    status: str = Query("", max_length=80),
    tenant_id: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    facet: Optional[str] = Query(None, max_length=200),
    sort: Optional[str] = Query(None, max_length=60),
    dir: Optional[str] = Query(None, pattern="^(asc|desc)$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=engine.MAX_PAGE_SIZE),
    format: str = Query("json", pattern="^(json|csv)$"),
    db: Session = Depends(get_master_db_dep),
):
    kpi = _spec(key, request)
    query = engine.Query(q=q, status=status, tenant_id=tenant_id, date_from=date_from, date_to=date_to, facet=facet, sort=sort,
                         desc=None if dir is None else dir == "desc", page=page, page_size=page_size, scope=scoped_tenant_ids(request))
    if format == "csv":
        body, count = engine.export_csv(db, kpi, query)
        _write_platform_audit(db, _get_platform_admin(request), "kpi.export", "kpi", None, kpi.title,
                              f"Exported {count} record(s) behind “{kpi.title}”", get_request_ip(request),
                              new_data={"kpi": key, "q": q or None, "status": status or None, "tenant_id": tenant_id,
                                        "date_from": str(date_from) if date_from else None, "date_to": str(date_to) if date_to else None, "facet": facet})
        db.commit()
        name = key.replace(".", "-")
        return Response(content=body, media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{name}-{date.today().isoformat()}.csv"'})
    return engine.run(db, kpi, query)
