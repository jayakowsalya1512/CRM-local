"""Customer success (Command) – platform console API (platform_customer_success).

Under ``/customer-success`` (Tenants permission: view to read, manage to run playbooks). Assigned-tenant staff see and run
playbooks only for their tenants; switching playbooks on or off needs all-tenant scope.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_customer_success as cs
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids


def _schema(db: Session = Depends(get_master_db_dep)) -> None:
    if cs.ensure_schema():   # a transaction older than the tables can't read them (MariaDB 1412)
        db.rollback()


router = APIRouter(prefix="/api/v1/platform/customer-success", dependencies=[Depends(enforce_platform_access), Depends(_schema)])
PAGE = 25


def _actor(request: Request) -> str:
    return getattr(_get_platform_admin(request), "email", None) or "platform admin"


def _sorts(sort: str) -> list[tuple[str, int]]:
    """``h:-1,t:1`` → [("h", -1), ("t", 1)]."""
    out = []
    for part in (sort or "").split(","):
        k, _, d = part.partition(":")
        if k in cs.SORT:
            out.append((k, -1 if d.strip() == "-1" else 1))
    return out[:3]


@router.get("")
def overview(request: Request, sort: str = Query("", max_length=60), db: Session = Depends(get_master_db_dep)):
    scope = scoped_tenant_ids(request)
    rows = cs.health_rows(db, scope)
    return {"kpis": cs.kpis(rows), "tenants": cs.page(rows, "", _sorts(sort), 0, PAGE),
            "model": [{"key": k, "label": n, "weight": w} for k, n, w in cs.WEIGHTS], "min_weight": cs.MIN_WEIGHT, "targets": cs.TARGET_DAYS,
            "modules": [m[0] for m in cs.MODULES], "playbooks": cs.playbooks(db), "email_enabled": cs.PLAYBOOK_EMAIL,
            "cache_seconds": cs.CACHE_SECONDS, "all_scope": scope is None}


@router.get("/tenants")
def tenants(request: Request, q: str = Query("", max_length=100), sort: str = Query("", max_length=60), offset: int = Query(0, ge=0),
            limit: int = Query(PAGE, ge=1, le=200), db: Session = Depends(get_master_db_dep)):
    return cs.page(cs.health_rows(db, scoped_tenant_ids(request)), q.strip(), _sorts(sort), offset, limit)


class PlaybookBody(BaseModel):
    enabled: bool


@router.put("/playbooks/{key}")
def set_playbook(key: str, body: PlaybookBody, request: Request, db: Session = Depends(get_master_db_dep)):
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail="Playbooks apply to every tenant – changing them needs all-tenant scope.")
    try:
        old, new = cs.set_playbook(db, key, body.enabled, _actor(request))
    except KeyError:
        raise HTTPException(status_code=404, detail="Unknown playbook")
    if old != new:
        title = next(t for k, t, _ in cs.PLAYBOOKS if k == key)
        _write_platform_audit(db, _get_platform_admin(request), "update_cs_playbook", "platform_setting", None, "Customer success playbooks",
                              f"Playbook “{title}” {'on' if new else 'off'}", get_request_ip(request), old_data={key: old}, new_data={key: new})
    db.commit()
    return {"key": key, "enabled": new}


@router.post("/run")
def run_playbooks(request: Request, db: Session = Depends(get_master_db_dep)):
    admin, ip = _get_platform_admin(request), get_request_ip(request)

    def audit(action, tenant, description, data):
        _write_platform_audit(db, admin, action, "tenant" if tenant else "platform_setting", tenant.id if tenant else None,
                              tenant.name if tenant else "Customer success playbooks", description, ip, new_data=data)
    try:
        return cs.run(db, scoped_tenant_ids(request), _actor(request), audit)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
