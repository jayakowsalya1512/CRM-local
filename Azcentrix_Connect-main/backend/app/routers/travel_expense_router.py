"""Travel & Expense (prototype v17 · Finance & Field → Travel & Expense) – /api/v1/travel-expense

Requests list (views All / Upcoming / Mine, status Pending / Approved / Completed), trip drawer (Itinerary & expenses, Activity,
Documents, Notes), Expense claims (KPIs + table + Submit claim) and the Upcoming & ongoing trips calendar. Every record id is
re-checked against the caller's travel data scope (or their role on the record's approval chain). Claim / trip approvals,
rejections and resubmissions run through the existing travel / TA-DA approval chain (Automation & Control → Approvals).
"""
from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.dependencies import get_tenant_db, require_permission
from app.models.all_models import User
from app.services import travel_expense_service as S

router = APIRouter(tags=["Travel & Expense"])


def te_user(db: Session = Depends(get_tenant_db), cu: User = Depends(require_permission("travel.view"))) -> User:
    S.ensure_schema(db)
    return cu


class TripIn(BaseModel):
    traveller_id: Optional[int] = None
    purpose: str = Field(..., max_length=500)
    from_: str = Field("", alias="from", max_length=100)
    to: str = Field(..., max_length=100)
    start: Optional[date] = None
    end: Optional[date] = None
    mode: str = "Train"
    cost: Optional[str] = "0"          # strings: validated as exact decimals in the service
    advance: Optional[str] = "0"
    model_config = {"populate_by_name": True}


class ExpenseIn(BaseModel):
    head: str
    amount: str
    date: Optional[date] = None
    description: Optional[str] = Field(None, max_length=500)
    allow_duplicate: bool = False


class AdvanceIn(BaseModel):
    kind: str
    amount: str
    date: Optional[date] = None
    reference: Optional[str] = Field(None, max_length=120)
    mode: Optional[str] = Field(None, max_length=30)


class NoteIn(BaseModel):
    body: str = Field(..., max_length=5000)


@router.get("/meta")
def meta(db: Session = Depends(get_tenant_db), cu: User = Depends(te_user)):
    return S.meta(db, cu)


@router.get("/trips")
def trips(view: str = "All", status: str = "", db: Session = Depends(get_tenant_db), cu: User = Depends(te_user)):
    return S.list_trips(db, cu, view, status)


@router.get("/trips/{trip_id}")
def trip(trip_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(te_user)):
    return S.detail(db, cu, trip_id)


@router.post("/trips", status_code=201)
def create_trip(body: TripIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(require_permission("travel.create"))):
    S.ensure_schema(db)
    return S.create_trip(db, cu, body, request)


@router.put("/trips/{trip_id}")
def update_trip(trip_id: int, body: TripIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(require_permission("travel.update"))):
    return S.update_trip(db, cu, trip_id, body, request)


@router.post("/trips/{trip_id}/complete")
def complete(trip_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(require_permission("travel.update"))):
    return S.complete_trip(db, cu, trip_id)


@router.delete("/trips/{trip_id}")
def delete(trip_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(require_permission("travel.view"))):
    return S.delete_trip(db, cu, trip_id)


@router.post("/trips/{trip_id}/expenses", status_code=201)
def add_expense(trip_id: int, body: ExpenseIn, db: Session = Depends(get_tenant_db), cu: User = Depends(require_permission("travel.create"))):
    S.ensure_schema(db)
    return S.add_expense(db, cu, trip_id, body)


@router.delete("/trips/{trip_id}/expenses/{item_id}")
def delete_expense(trip_id: int, item_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(require_permission("travel.update"))):
    return S.delete_expense(db, cu, trip_id, item_id)


@router.post("/trips/{trip_id}/expenses/{item_id}/receipts", status_code=201)
async def add_receipt(trip_id: int, item_id: int, request: Request, doc_type: str = Query("Receipt"), file: UploadFile = File(...),
                      db: Session = Depends(get_tenant_db), cu: User = Depends(require_permission("travel.update"))):
    """Checks ownership / claim state / size, then stores the file with the existing TA/DA receipt upload (Document Hub source)."""
    from app.routers.travel_router import upload_line_item_attachment
    if doc_type not in ("Receipt", "Invoice", "Ticket", "Hotel Bill", "Other"):
        raise HTTPException(422, "Unknown document type")
    claim = S.receipt_target(db, cu, trip_id, item_id)
    data = await file.read()
    if len(data) > S.MAX_RECEIPT_MB * 1024 * 1024:
        raise HTTPException(413, f"File is larger than {S.MAX_RECEIPT_MB} MB")
    await file.seek(0)
    return await upload_line_item_attachment(claim.id, item_id, request, doc_type, file, db, cu)


@router.post("/trips/{trip_id}/claim/submit")
def submit_claim(trip_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(require_permission("travel.update"))):
    return S.submit_claim(db, cu, trip_id)


@router.post("/trips/{trip_id}/advance", status_code=201)
def advance(trip_id: int, body: AdvanceIn, db: Session = Depends(get_tenant_db), cu: User = Depends(require_permission("travel.update"))):
    S.ensure_schema(db)
    return S.add_advance_txn(db, cu, trip_id, body)


@router.post("/trips/{trip_id}/notes", status_code=201)
def note(trip_id: int, body: NoteIn, db: Session = Depends(get_tenant_db), cu: User = Depends(te_user)):
    return S.add_note(db, cu, trip_id, body.body)


@router.get("/claims")
def claims(db: Session = Depends(get_tenant_db), cu: User = Depends(te_user)):
    return S.claims(db, cu)


@router.get("/calendar")
def calendar(db: Session = Depends(get_tenant_db), cu: User = Depends(te_user)):
    return {"items": S.calendar(db, cu)}
