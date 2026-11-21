"""Commitments (prototype v18) – /api/v1/commitments

One shared feature behind Dashboard → Commitments and Field Sales 360 → Commitments: both read the same records through
commitment_service. Reads need kam.view and only cover people inside the caller's KAM Data Visibility (re-checked on
every id the client sends). Submitting your own commitment needs kam.create; entering, editing, acknowledging or deleting
someone else's needs kam.update and that person in your team. Settings and teams are company-level (Sales Head / admin).
"""
from __future__ import annotations

from datetime import date
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.dependencies import get_tenant_db, require_permission
from app.models.all_models import User
from app.services import commitment_service as S

router = APIRouter(tags=["Commitments"])


def cm_user(db: Session = Depends(get_tenant_db), cu: User = Depends(require_permission("kam.view"))) -> User:
    S.ensure_schema(db)
    return cu


class EntryIn(BaseModel):
    type: str
    n: Optional[float] = 0
    value: Optional[float] = 0
    customer_id: Optional[int] = None
    tender_id: Optional[int] = None
    old_tender: Optional[str] = Field(None, max_length=300)
    work_order_id: Optional[int] = None
    deal_id: Optional[int] = None
    source: Optional[str] = Field(None, max_length=120)
    expected_on: Optional[str] = None
    note: Optional[str] = Field(None, max_length=500)


class CommitmentIn(BaseModel):
    owner_id: Optional[int] = None
    per: str = "Week"
    anchor: str
    entries: list[EntryIn] = []
    note: Optional[str] = Field(None, max_length=4000)
    replace: bool = False


class SettingsIn(BaseModel):
    types: Optional[dict[str, bool]] = None
    periods: Optional[list[str]] = None
    roles: Optional[list[str]] = None
    cutoff: Optional[str] = None
    pay_tender: Optional[bool] = None
    remind: Optional[bool] = None


class TeamIn(BaseModel):
    name: str = Field(..., max_length=120)


class MemberIn(BaseModel):
    team_id: Optional[int] = None


class RemindIn(BaseModel):
    user_ids: list[int]
    week: Optional[str] = None


class ReceiptIn(BaseModel):
    wo_id: int
    amount: float
    received_on: Optional[date] = None
    reference: str = Field(..., max_length=120)
    mode: Optional[str] = Field(None, max_length=40)
    remarks: Optional[str] = Field(None, max_length=500)
    milestone_id: Optional[int] = None
    collected_by: Optional[int] = None


class ReceiptAckIn(BaseModel):
    status: str = "Acknowledged"
    bank_date: Optional[date] = None
    credited_amount: Optional[float] = None


def _body(m: BaseModel) -> dict[str, Any]:
    return m.model_dump(exclude_unset=True)


@router.get("/meta")
def meta(db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    return S.meta(db, cu)


@router.get("/week")
def week(week: Optional[str] = None, team: Optional[str] = None, db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    """Field Sales 360 → Commitments → Overview: KPIs, team × person matrix, payment commitments, not submitted."""
    return S.week_view(db, cu, week, team)


@router.get("/dashboard")
def dashboard(week: Optional[str] = None, db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    """Dashboard → Commitments: the same rows and totals plus 8-week history, heat-map, at-risk and submission."""
    return S.dashboard(db, cu, week)


@router.get("/people/{user_id}")
def person(user_id: int, week: Optional[str] = None, db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    return S.person(db, cu, user_id, week)


@router.get("/report")
def report(weeks: int = 8, db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    return S.report(db, cu, weeks)


@router.get("/settings")
def get_settings(db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    return S.settings(db)


@router.put("/settings")
def put_settings(body: SettingsIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    return S.save_settings(db, cu, _body(body), request)


@router.post("/teams", status_code=201)
def add_team(body: TeamIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    return S.add_team(db, cu, body.name, request)


@router.put("/teams/members/{user_id}")
def set_member(user_id: int, body: MemberIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    return S.assign_team(db, cu, user_id, body.team_id, request)


@router.post("/remind")
def remind(body: RemindIn, db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    return S.remind(db, cu, body.user_ids, body.week)


@router.get("/form-meta")
def form_meta(owner_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    return S.form_meta(db, cu, owner_id)


@router.get("/period")
def period(per: str, anchor: str, db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    return S.period_info(db, per, anchor)


@router.get("/customer-refs/{customer_id}")
def customer_refs(customer_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    return S.customer_refs(db, cu, customer_id)


@router.get("/receipts")
def list_receipts(status: Optional[str] = None, db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    return {"items": S.receipts(db, cu, status)}


@router.post("/receipts", status_code=201)
def record_receipt(body: ReceiptIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    return S.record_receipt(db, cu, _body(body), request)


@router.post("/receipts/{receipt_id}/acknowledge")
def acknowledge_receipt(receipt_id: int, body: ReceiptAckIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    return S.acknowledge_receipt(db, cu, receipt_id, _body(body), request)


@router.get("")
def register(db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    """Commitments register – every commitment of the people in scope, kept as entered."""
    return S.register(db, cu)


@router.post("", status_code=201)
def create(body: CommitmentIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    d = body.model_dump()
    d["entries"] = [e.model_dump() for e in body.entries]
    return S.save(db, cu, d, request)


@router.get("/{commitment_id}")
def detail(commitment_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    return S.detail(db, cu, commitment_id)


@router.put("/{commitment_id}")
def update(commitment_id: int, body: CommitmentIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    d = body.model_dump()
    d["entries"] = [e.model_dump() for e in body.entries]
    return S.save(db, cu, d, request, commitment_id)


@router.post("/{commitment_id}/acknowledge")
def acknowledge(commitment_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    return S.acknowledge(db, cu, commitment_id, request)


@router.delete("/{commitment_id}", status_code=204)
def delete(commitment_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(cm_user)):
    S.delete(db, cu, commitment_id, request)
