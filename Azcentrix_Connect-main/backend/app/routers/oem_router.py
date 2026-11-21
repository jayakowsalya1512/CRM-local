"""OEM router"""
import logging
from fastapi import APIRouter, Depends, HTTPException, Request, Query
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from decimal import Decimal
from datetime import date
from app.dependencies import get_tenant_db, get_current_user, require_manager_or_above, get_request_ip, require_permission
from app.models.user import User
from app.models.others import OEM
from app.models.all_models import ProductMaster
from app.core.logging import log_audit, log_module_action, model_snapshot

logger = logging.getLogger(__name__)
router = APIRouter()


class OEMCreate(BaseModel):
    name: str
    type: Optional[str] = "OEM"          # "OEM" | "Distributor"
    product_id: int
    contact_name: Optional[str] = None
    contact_phone: Optional[str] = None
    contact_email: Optional[str] = None
    contact_designation: Optional[str] = None
    auth_number: Optional[str] = None
    account_manager: Optional[str] = None
    auth_date: Optional[date] = None
    support_sla: Optional[str] = None
    credit_limit: float = 0
    payment_terms: Optional[str] = None
    brands_handled: Optional[str] = None  # Distributor-only
    notes: Optional[str] = None


class OEMResponse(BaseModel):
    id: int
    name: str
    type: Optional[str]
    product_id: str
    contact: Optional[str]
    account_manager: Optional[str]
    auth_date: Optional[date]
    support_sla: Optional[str]
    credit_limit: Optional[Decimal]
    payment_terms: Optional[str]
    brands_handled: Optional[str]
    notes: Optional[str]
    created_by: Optional[int]
    model_config = {"from_attributes": True}


# ── Helpers ──────────────────────────────────────────────────────────────────

def _check_duplicate(db: Session, name: str, exclude_id: Optional[int] = None):
    """Raise 409 if an active OEM/Distributor with the same name already exists."""
    q = db.query(OEM).filter(
        OEM.name.ilike(name.strip()),
        OEM.is_deleted == False,
    )
    if exclude_id:
        q = q.filter(OEM.id != exclude_id)
    existing = q.first()
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"An entry named \"{existing.name}\" already exists. Please use a different name."
        )


# ── Routes ───────────────────────────────────────────────────────────────────

@router.get("/categorys")
def get_category(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    category = (
        db.query(ProductMaster)
        .filter(ProductMaster.is_active == 1)
        .order_by(ProductMaster.category)
        .all()
    )
    return {
        "cat": [{"id": c.id, "category": c.category} for c in category]
    }


@router.get("")
def list_oems(
    search: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    type: Optional[str] = Query(None),      # filter by OEM | Distributor
    skip: int = 0,
    limit: int = 1000,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("oems.view")),
):
    q = db.query(OEM, ProductMaster.category).outerjoin(
        ProductMaster, OEM.product_id == ProductMaster.id
    ).filter(
        OEM.is_deleted == False        # exclude soft-deleted rows
    )

    if search:
        q = q.filter(OEM.name.ilike(f"%{search}%"))

    if category:
        q = q.filter(ProductMaster.category.ilike(f"%{category}%"))

    if type:
        q = q.filter(OEM.type == type)

    result = q.offset(skip).limit(limit).all()

    return [
        {
            "id": oem.id,
            "name": oem.name,
            "type": oem.type or "OEM",
            "category": cat,
            "contact_phone": oem.contact_phone,
            "contact_name": oem.contact_name,
            "account_manager": oem.account_manager,
            "credit_limit": oem.credit_limit,
            "auth_date": oem.auth_date,
            "payment_terms": oem.payment_terms,
            "support_sla": oem.support_sla,
            "brands_handled": oem.brands_handled,
            "notes": oem.notes,
            "auth_number": oem.auth_number,
            "contact_designation": oem.contact_designation,
            "contact_email": oem.contact_email,
            "product_id": oem.product_id,
        }
        for oem, cat in result
    ]


@router.post("", status_code=201)
def create_oem(
    data: OEMCreate,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("oems.create")),
):
    _check_duplicate(db, data.name)          # duplicate guard on create

    oem = OEM(**data.model_dump(), created_by=current_user.id)
    db.add(oem)
    db.flush()
    log_module_action(
        db=db, user_id=current_user.id, module="oems", action="create",
        record_id=oem.id, record_name=oem.name, ip=get_request_ip(request),
        new_data=model_snapshot(oem),
    )
    db.commit()
    db.refresh(oem)
    return oem


@router.put("/{oem_id}")
def update_oem(
    oem_id: int,
    data: OEMCreate,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("oems.update")),
):
    try:
        oem = db.query(OEM).filter(OEM.id == oem_id, OEM.is_deleted == False).first()
        if not oem:
            raise HTTPException(status_code=404, detail="OEM not found")

        # Duplicate check — exclude this record so renaming to the same name is allowed
        _check_duplicate(db, data.name, exclude_id=oem_id)

        before = model_snapshot(oem)
        update_data = data.model_dump(exclude_unset=True)
        for field, val in update_data.items():
            if hasattr(oem, field):
                setattr(oem, field, val)

        if hasattr(oem, "updated_by"):
            oem.updated_by = current_user.id

        log_module_action(
            db=db, user_id=current_user.id, module="oems", action="update",
            record_id=oem.id, record_name=oem.name, ip=get_request_ip(request),
            old_data=before, new_data=model_snapshot(oem),
        )
        db.commit()
        db.refresh(oem)
        return oem

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{oem_id}")
def delete_oem(
    oem_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("oems.delete")),
):
    """Soft-delete: sets is_deleted = 1 instead of removing the row."""
    oem = db.query(OEM).filter(OEM.id == oem_id, OEM.is_deleted == False).first()
    if not oem:
        raise HTTPException(status_code=404, detail="OEM not found")

    from app.models.all_models import AuditLog
    from app.core.timezone import now_ist
    from app.core.logging import model_snapshot
    before = model_snapshot(oem)
    oem.is_deleted = True
    db.add(AuditLog(user_id=current_user.id, module="oems", action="delete",
        record_id=oem.id, record_name=oem.name, old_data=before,
        description=f"Deleted {oem.name}", created_at=now_ist()))
    if hasattr(oem, "updated_by"):
        oem.updated_by = current_user.id

    db.commit()
    return {"message": f"{oem.name} deleted successfully"}
