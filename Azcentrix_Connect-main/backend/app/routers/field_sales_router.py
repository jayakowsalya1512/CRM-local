"""Field Sales 360 (prototype v17 · Finance & Field → Field Sales 360) – /api/v1/field-sales

Read endpoints need kam.view and return only KAMs inside the caller's KAM Data Visibility (any KAM id sent by the
client is re-checked here). Logging activities needs kam.create (the KAM module's create endpoint is reused, so its
validation, execution cycle, audit log and travel rules apply). Targets need kam.update and a KAM in the caller's
hierarchy. Check-in / check-out location is captured only by the employee on the visit, only when they press the
button, and raw coordinates are purged after the retention period (Settings field_sales_location_retention_days).
"""
from __future__ import annotations

from datetime import date
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.dependencies import get_tenant_db, require_permission
from app.models.all_models import User
from app.services import field_sales_service as S

router = APIRouter(tags=["Field Sales 360"])


def fs_user(db: Session = Depends(get_tenant_db), cu: User = Depends(require_permission("kam.view"))) -> User:
    S.ensure_schema(db)
    return cu


class GpsFix(BaseModel):
    lat: float
    lng: float
    accuracy: Optional[float] = None


class ActivityIn(BaseModel):
    action: str = "log"                       # log (completed) | check_in (start visit now) | plan (planned visit)
    type: str
    customer_id: int
    kam_id: Optional[int] = None
    contact_id: Optional[int] = None
    link_kind: Optional[str] = None           # lead | tender
    link_id: Optional[int] = None
    date: date
    time: Optional[str] = None
    duration: Optional[int] = Field(None, ge=0, le=1440)
    where: Optional[str] = Field(None, max_length=200)
    notes: Optional[str] = Field(None, max_length=20000)
    topics: list[str] = []
    competitor: Optional[str] = None
    attendees: list[str] = []
    outcome: Optional[str] = None
    sentiment: Optional[int] = Field(None, ge=1, le=5)
    planned: Optional[bool] = None
    gps: Optional[GpsFix] = None
    gps_permission: Optional[str] = None      # granted | denied | unavailable
    next_title: Optional[str] = Field(None, max_length=300)
    next_due: Optional[date] = None
    expense: Optional[float] = Field(None, ge=0, le=10_000_000)
    expense_category: Optional[str] = Field(None, max_length=50)
    distance_km: Optional[float] = Field(None, ge=0, le=5000)


class CheckIn(BaseModel):
    gps: Optional[GpsFix] = None
    gps_permission: Optional[str] = None


class CheckOut(CheckIn):
    outcome: str
    notes: Optional[str] = Field(None, max_length=5000)
    distance_km: Optional[float] = Field(None, ge=0, le=5000)


class TargetIn(BaseModel):
    annual_target_lakh: float


def _dump(m: Optional[BaseModel]) -> Optional[dict[str, Any]]:
    return m.model_dump() if m else None


@router.get("/meta")
def meta(db: Session = Depends(get_tenant_db), cu: User = Depends(fs_user)):
    return S.meta(db, cu)


@router.get("/team")
def team(db: Session = Depends(get_tenant_db), cu: User = Depends(fs_user)):
    return S.team(db, cu)


@router.get("/kams/{user_id}")
def kam360(user_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(fs_user)):
    return S.kam360(db, cu, user_id)


@router.get("/visits")
def visits(db: Session = Depends(get_tenant_db), cu: User = Depends(fs_user)):
    return S.visits(db, cu)


@router.get("/coverage")
def coverage(db: Session = Depends(get_tenant_db), cu: User = Depends(fs_user)):
    return S.coverage(db, cu)


@router.get("/analytics")
def analytics(db: Session = Depends(get_tenant_db), cu: User = Depends(fs_user)):
    return S.analytics(db, cu)


@router.get("/targets")
def targets(db: Session = Depends(get_tenant_db), cu: User = Depends(fs_user)):
    return S.target_rows(db, cu)


@router.put("/targets/{user_id}")
def set_target(user_id: int, body: TargetIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(fs_user)):
    return S.set_target(db, cu, user_id, body.annual_target_lakh, request)


@router.get("/targets/{user_id}/history")
def target_history(user_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(fs_user)):
    return {"items": S.target_history(db, cu, user_id)}


@router.get("/territories")
def territories(db: Session = Depends(get_tenant_db), cu: User = Depends(fs_user)):
    return S.territories(db, cu)


@router.get("/form-meta")
def form_meta(customer_id: Optional[int] = None, db: Session = Depends(get_tenant_db), cu: User = Depends(fs_user)):
    return S.form_meta(db, cu, customer_id)


@router.post("/activities", status_code=201)
def log_activity(body: ActivityIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(require_permission("kam.create"))):
    S.ensure_schema(db)
    body.gps = _dump(body.gps)  # type: ignore[assignment]
    return S.log_activity(db, cu, body, request)


@router.post("/visits/{activity_id}/check-in")
def check_in(activity_id: int, body: CheckIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(require_permission("kam.update"))):
    S.ensure_schema(db)
    body.gps = _dump(body.gps)  # type: ignore[assignment]
    return S.check_in(db, cu, activity_id, body, request)


@router.post("/visits/{activity_id}/check-out")
def check_out(activity_id: int, body: CheckOut, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(require_permission("kam.update"))):
    S.ensure_schema(db)
    body.gps = _dump(body.gps)  # type: ignore[assignment]
    return S.check_out(db, cu, activity_id, body, request)


@router.post("/activities/{activity_id}/attachment")
async def attach(activity_id: int, request: Request, file: UploadFile = File(...), db: Session = Depends(get_tenant_db),
                 cu: User = Depends(require_permission("kam.create"))):
    """Attach the file chosen in the Log activity form to the activity it just created (KAM document storage)."""
    from datetime import timedelta
    from app.core.timezone import now_ist
    from app.models.all_models import KAMActivity
    from app.routers.kam_router import _save_kam_document
    act = db.query(KAMActivity).filter(KAMActivity.id == activity_id).first()
    if not act or act.created_by != cu.id or not act.created_at or act.created_at < now_ist() - timedelta(minutes=30):
        raise HTTPException(404, "Activity not found")
    contents = await file.read()
    if not contents:
        raise HTTPException(400, "Uploaded file is empty")
    url, size_kb = _save_kam_document(request, file, contents)
    name = (file.filename or url.rsplit("/", 1)[-1])[:255]
    from app.services.kam_activity_audit_service import log_kam_activity
    log_kam_activity(db, activity_id=act.id, event_type="DOCUMENT_ATTACHED", cycle_no=act.current_cycle_no or 1, actor=cu, source="web",
                     request=request, new_values={"document_name": name}, metadata={"document_url": url, "document_name": name, "document_size_kb": size_kb})
    db.commit()
    return {"document_url": url, "document_name": name, "document_size_kb": size_kb}
