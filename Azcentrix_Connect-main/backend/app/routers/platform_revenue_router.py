"""Revenue analytics (Command) – platform console API (platform_revenue).

Under ``/revenue`` (Plans & billing permission, view). Staff with assigned-tenant scope see only their tenants.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.services import platform_revenue as rev
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/revenue", dependencies=[Depends(enforce_platform_access)])


def _utc(v):
    """Ledger times are naive UTC – mark them so the browser shows local time."""
    if isinstance(v, datetime):
        return v.isoformat() + "Z"
    if isinstance(v, dict):
        return {k: _utc(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_utc(x) for x in v]
    return v


@router.get("")
def overview(request: Request, db: Session = Depends(get_master_db_dep)):
    rev.ensure_schema()
    rev.record(None, "reconcile")     # bring the ledger up to date before reading it (own transaction)
    db.rollback()                     # start this request's read after that commit
    scope = scoped_tenant_ids(request)
    return _utc({**rev.overview(db, scope), "all_scope": scope is None})
