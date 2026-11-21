"""Approvals (prototype v18 · Automation & Control → Approvals) over the existing approval stores.  /api/v1/approvals360

GET  /meta                    views, purposes (label · icon · colour), sorts, people, my preferences, quick remarks
GET  /kpis                    Pending on me · All pending · Value awaiting · Overdue (SLA) · Approved 30d · Rejected 30d · Avg. turnaround
POST /query                   {view, q, purpose, status, priority, requester, approver, date_from, date_to, sla, decided_days, sort, offset, limit}
                              → rows + purpose distribution of the view
GET  /prefs · PUT /prefs · POST /prefs/reset      My approval preferences (the signed-in user only)
GET  /{key}                   drawer detail; key = a<id> (legacy approval) | r<id> (approval engine request)
POST /{key}/decide · /delegate · /escalate · /ask-info · /answer

Decisions go through the existing /approvals and /approval-workflows handlers, so routing, audit, notifications and
every module callback (stage moves, Finance desk, product approvals …) are unchanged.
"""
from __future__ import annotations

import csv
import io
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.dependencies import get_current_user, get_tenant_db, user_has_permission
from app.models.all_models import User
from app.services import approvals360_service as S

router = APIRouter(tags=["Approvals"])


def ap_user(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if not user_has_permission(db, cu, "approvals.view"):
        raise HTTPException(403, "You do not have access to Approvals")
    S.ensure_schema(db)
    return cu


class QueryIn(BaseModel):
    view: str = "Pending on me"
    q: str = Field("", max_length=120)
    purpose: str = Field("", max_length=20)
    status: str = Field("", max_length=20)
    priority: str = Field("", max_length=10)
    requester: Optional[int] = None
    approver: Optional[int] = None
    date_from: Optional[str] = Field(None, max_length=10)
    date_to: Optional[str] = Field(None, max_length=10)
    sla: str = Field("", max_length=10)
    decided_days: Optional[int] = Field(None, ge=1, le=3650)
    sort: str = "sla"
    offset: int = Field(0, ge=0)
    limit: int = Field(25, ge=1, le=500)


class DecideIn(BaseModel):
    decision: Literal["approved", "rejected"]
    remarks: str = Field("", max_length=2000)


class DelegateIn(BaseModel):
    user_id: int
    remarks: str = Field("", max_length=1000)
    until: Optional[str] = Field(None, max_length=10)


class TextIn(BaseModel):
    text: str = Field("", max_length=2000)


class NotifyIn(BaseModel):
    app: bool = True
    email: bool = True
    digest: Optional[bool] = None


class PrefsIn(BaseModel):
    tab: str = "Pending on me"
    sort: str = "sla"
    cat: str = "all"
    next: str = "next"
    hide: list[str] = Field(default_factory=list, max_length=20)
    away: bool = False
    away_to: Optional[int] = None
    away_till: Optional[str] = None
    remarks: list[str] = Field(default_factory=list, max_length=12)
    notify: Optional[NotifyIn] = None


@router.get("/meta")
def meta(db: Session = Depends(get_tenant_db), cu: User = Depends(ap_user)):
    return {"views": S.VIEWS, "purposes": [{"k": k, "l": l, "i": i, "c": c} for k, l, i, c, _, _ in S.PURPOSES], "sorts": S.SORTS, "people": S.people(db),
            "me": {"id": cu.id, "name": cu.full_name, "role": cu.role}, "prefs": S.prefs(db, cu), "notify": S.notify_prefs(db, cu), "quick_remarks": S.QUICK_REMARKS,
            "can": {"policies": user_has_permission(db, cu, "workflow.view"), "export": user_has_permission(db, cu, "approvals.view")}}


@router.get("/kpis")
def kpis(db: Session = Depends(get_tenant_db), cu: User = Depends(ap_user)):
    return S.kpis(db, cu, S.prefs(db, cu).get("hide"))


def _query(db: Session, cu: User, b: QueryIn, offset: int, limit: int) -> dict:
    view = b.view if b.view in S.VIEWS else "Pending on me"
    return S.rows(db, cu, view=view, q=b.q.strip(), purpose=b.purpose, status=b.status, priority=b.priority, requester=b.requester, approver=b.approver,
                  date_from=b.date_from, date_to=b.date_to, sla=b.sla, decided_days=b.decided_days, sort=b.sort if b.sort in S.SORTS else "sla",
                  offset=offset, limit=limit, hide=S.prefs(db, cu).get("hide"))


@router.post("/query")
def query(body: QueryIn, db: Session = Depends(get_tenant_db), cu: User = Depends(ap_user)):
    return _query(db, cu, body, body.offset, body.limit)


@router.post("/export")
def export(body: QueryIn, db: Session = Depends(get_tenant_db), cu: User = Depends(ap_user)):
    rows = _query(db, cu, body, 0, 5000)["items"]
    purposes = {p[0]: p[1] for p in S.PURPOSES}
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Request", "Purpose", "What is being requested", "Record", "Customer", "Value", "Requested by", "Requested on", "Waiting for", "Approval chain", "SLA", "Priority", "Status"])
    for r in rows:
        w.writerow([r["id"], purposes.get(r["pp"], ""), r["title"], r["ref"], r["cust"], r["value"] or "", r["by"], r["req"] or "", r["cur"],
                    " > ".join(f"{c['role'] or c['user']} ({c['state']})" for c in r["chain"]), r["sla"]["txt"], r["priority"], r["status"]])
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="approvals.csv"'})


@router.get("/prefs")
def get_prefs(db: Session = Depends(get_tenant_db), cu: User = Depends(ap_user)):
    return {**S.prefs(db, cu), "notify": S.notify_prefs(db, cu)}


@router.put("/prefs")
def put_prefs(body: PrefsIn, db: Session = Depends(get_tenant_db), cu: User = Depends(ap_user)):
    return S.save_prefs(db, cu, body.model_dump())


@router.post("/prefs/reset")
def reset_prefs(db: Session = Depends(get_tenant_db), cu: User = Depends(ap_user)):
    return S.reset_prefs(db, cu)


@router.get("/{key}")
def detail(key: str, db: Session = Depends(get_tenant_db), cu: User = Depends(ap_user)):
    return S.detail(db, cu, key)


@router.post("/{key}/decide")
def decide(key: str, body: DecideIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(ap_user)):
    S.decide(db, cu, request, key, body.decision, body.remarks)
    return {"ok": True}


@router.post("/{key}/delegate")
def delegate(key: str, body: DelegateIn, db: Session = Depends(get_tenant_db), cu: User = Depends(ap_user)):
    return S.delegate(db, cu, key, body.user_id, body.remarks.strip(), body.until)


@router.post("/{key}/escalate")
def escalate(key: str, body: TextIn, db: Session = Depends(get_tenant_db), cu: User = Depends(ap_user)):
    return S.escalate(db, cu, key, body.text.strip())


@router.post("/{key}/ask-info")
def ask_info(key: str, body: TextIn, db: Session = Depends(get_tenant_db), cu: User = Depends(ap_user)):
    return S.ask_info(db, cu, key, body.text)


@router.post("/{key}/answer")
def answer(key: str, body: TextIn, db: Session = Depends(get_tenant_db), cu: User = Depends(ap_user)):
    return S.answer_info(db, cu, key, body.text)
