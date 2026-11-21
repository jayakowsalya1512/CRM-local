"""Resellers & partners (Command): reseller accounts, tenant assignment and commission (platform_resellers).

Under ``/resellers`` (Plans & billing permission: view to read, manage to change). Resellers span tenants, so changes
need all-tenant scope; tenant-scoped staff only see their own tenants in the tenant list.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.dependencies import get_request_ip
from app.models.platform_reseller import PlatformReseller
from app.models.tenant import Tenant
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_resellers as rs
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/resellers", dependencies=[Depends(enforce_platform_access)])


def _all_scope(request: Request) -> None:
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail="Resellers span tenants – changing them needs all-tenant scope.")


def _actor(request: Request) -> str:
    return getattr(_get_platform_admin(request), "email", None) or "platform admin"


def _audit(db: Session, request: Request, action: str, entity_type: str, entity_id, name, description: str, old=None, new=None) -> None:
    _write_platform_audit(db, _get_platform_admin(request), action, entity_type, entity_id, name, description, get_request_ip(request),
                          old_data=old, new_data=new)


def _reseller(db: Session, reseller_id: int) -> PlatformReseller:
    rs.ensure_schema()
    row = db.get(PlatformReseller, reseller_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Reseller not found")
    return row


@router.get("")
def overview(request: Request, db: Session = Depends(get_master_db_dep)):
    data = rs.overview(db)
    allowed = scoped_tenant_ids(request)
    if allowed is not None:
        data["tenants"] = [t for t in data["tenants"] if t["id"] in set(allowed)]
    return {**data, "all_scope": allowed is None}


class ResellerBody(BaseModel):
    name: str = Field(..., max_length=200)
    region: str = Field("", max_length=120)
    commission: Optional[float] = None


@router.post("", status_code=201)
def create(body: ResellerBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _all_scope(request)
    try:
        row = rs.create(db, body.name, body.region, body.commission, _actor(request))
    except rs.ResellerError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    _audit(db, request, "create_reseller", "reseller", row.id, row.name,
           f"Reseller '{row.name}' created ({row.region or 'no region'}, {row.tier}, {row.commission_pct}% commission, domain {row.domain})",
           new={"region": row.region, "tier": row.tier, "commission_pct": float(row.commission_pct), "domain": row.domain})
    try:
        db.commit()
    except IntegrityError:   # a reseller with this name / domain was created at the same moment
        db.rollback()
        raise HTTPException(status_code=409, detail=f"A reseller named “{body.name.strip()}” already exists")
    return {"id": row.id, "name": row.name, "tier": row.tier, "commission": float(row.commission_pct), "domain": row.domain}


class CommissionBody(BaseModel):
    commission: float


@router.put("/{reseller_id}/commission")
def commission(reseller_id: int, body: CommissionBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _all_scope(request)
    row = _reseller(db, reseller_id)
    try:
        old, new = rs.set_commission(db, row, body.commission)
    except rs.ResellerError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    if old != new:
        _audit(db, request, "update_reseller_commission", "reseller", row.id, row.name, f"Reseller '{row.name}' commission {old}% → {new}%",
               {"commission_pct": float(old)}, {"commission_pct": float(new)})
    db.commit()
    return {"id": row.id, "commission": float(new)}


class AssignBody(BaseModel):
    tenant_id: int


@router.post("/{reseller_id}/tenants", status_code=201)
def assign(reseller_id: int, body: AssignBody, request: Request, db: Session = Depends(get_master_db_dep)):
    _all_scope(request)
    row = _reseller(db, reseller_id)
    tenant = db.get(Tenant, body.tenant_id)
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    try:
        link = rs.assign(db, row, tenant, _actor(request))
    except rs.ResellerError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    _audit(db, request, "assign_reseller_tenant", "tenant", tenant.id, tenant.name, f"Tenant '{tenant.name}' assigned to reseller '{row.name}'",
           new={"reseller_id": row.id, "reseller": row.name, "assignment_id": link.id})
    try:
        db.commit()
    except IntegrityError:   # the tenant was assigned by someone else at the same moment
        db.rollback()
        raise HTTPException(status_code=409, detail=f"{tenant.name} was just assigned to a reseller – refresh and try again")
    return {"reseller": row.name, "tenant": tenant.name}
