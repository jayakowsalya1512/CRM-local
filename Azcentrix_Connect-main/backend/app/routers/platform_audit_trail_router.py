"""Audit trail (Governance): server-side list, entry detail and signed CSV export of the platform audit log.

Under ``/audit-logs`` (Audit logs permission, view). Reads ``platform_audit_logs`` – the same records the existing
audit endpoints use; nothing is written except the audit entry for an export.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_audit_trail as trail
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/audit-logs", dependencies=[Depends(enforce_platform_access)])


def _json(value: str, what: str):
    try:
        return json.loads(value) if value else None
    except ValueError:
        raise HTTPException(status_code=422, detail=f"Invalid {what}")


def _filters(q: str, quick: str, conds: str, logic: str, tenant_id: Optional[int], date_from: Optional[str], date_to: Optional[str]) -> dict:
    quick_v, conds_v = _json(quick, "quick filters") or {}, _json(conds, "filter conditions") or []
    if not isinstance(quick_v, dict) or not isinstance(conds_v, list):
        raise HTTPException(status_code=422, detail="Invalid filters")
    return {"q": q, "quick": {str(k): str(v) for k, v in quick_v.items()}, "conds": [c for c in conds_v if isinstance(c, dict)][:20],
            "logic": logic, "tenant_id": tenant_id, "date_from": date_from, "date_to": date_to}


def _sort(sort: str):
    value = _json(sort, "sort") or []
    if not isinstance(value, list) or any(not isinstance(s, list) or len(s) != 2 for s in value):
        raise HTTPException(status_code=422, detail="Invalid sort")
    return value[:3]


@router.get("/trail")
def list_trail(request: Request, offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=250), q: str = Query("", max_length=200),
               quick: str = Query("", max_length=2000), conds: str = Query("", max_length=4000), logic: str = Query("AND", pattern="^(AND|OR)$"),
               sort: str = Query("", max_length=300), tenant_id: Optional[int] = None, date_from: Optional[str] = None, date_to: Optional[str] = None,
               db: Session = Depends(get_master_db_dep)):
    try:
        return trail.page(db, scoped_tenant_ids(request), offset=offset, limit=limit, sort=_sort(sort),
                          **_filters(q, quick, conds, logic, tenant_id, date_from, date_to))
    except trail.AuditQueryError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.get("/export")
def export_trail(request: Request, q: str = Query("", max_length=200), quick: str = Query("", max_length=2000), conds: str = Query("", max_length=4000),
                 logic: str = Query("AND", pattern="^(AND|OR)$"), sort: str = Query("", max_length=300), tenant_id: Optional[int] = None,
                 date_from: Optional[str] = None, date_to: Optional[str] = None, db: Session = Depends(get_master_db_dep)):
    filters = _filters(q, quick, conds, logic, tenant_id, date_from, date_to)
    try:
        body, rows, signature = trail.export_csv(db, scoped_tenant_ids(request), sort=_sort(sort), **filters)
    except trail.AuditQueryError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    used = {k: v for k, v in filters.items() if v not in (None, "", {}, [], "AND")}
    _write_platform_audit(db, _get_platform_admin(request), "export_audit_trail", "audit_trail", None, "Audit trail",
                          f"Audit trail exported: {rows} entries (signed CSV)", get_request_ip(request),
                          new_data={"rows": rows, "filters": used, "signature": signature})
    db.commit()
    name = f"audit-trail-{datetime.utcnow():%Y%m%d-%H%M%S}.csv"
    return Response(content=body, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"', "X-Audit-Signature": f"hmac-sha256={signature}",
                             "X-Audit-Rows": str(rows), "Access-Control-Expose-Headers": "X-Audit-Signature, X-Audit-Rows, Content-Disposition"})


@router.get("/{entry_id}")
def entry(entry_id: int, request: Request, db: Session = Depends(get_master_db_dep)):
    found = trail.detail(db, scoped_tenant_ids(request), entry_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Audit entry not found")
    return found
