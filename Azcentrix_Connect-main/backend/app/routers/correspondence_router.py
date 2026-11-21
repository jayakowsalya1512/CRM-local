"""Correspondence (prototype v17 R.letters).  Mounted at /api/v1/correspondence

GET  /register?q&status&offset&limit     letters register (paginated)
GET  /tenders?q · GET /merge-data?tender_id   compose helpers (live preview merge fields)
GET  /campaigns · POST /campaigns · POST /campaigns/{id}/send · GET /audiences
GET  /sequences · POST /sequences · POST /sequences/{id}/enrol
GET  /mailbox · PUT /mailbox/{key}

Mail = /api/v1/inbox, letters & templates = /api/v1/letters (reused by the page).
Reads need letter_management.view; writes letter_management.create / update (admin / ceo always pass).
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.core.validators import NonBlank, check_text

from app.database import get_master_db_dep
from app.dependencies import get_current_user, get_tenant_db, user_has_permission
from app.models.all_models import User
from app.models.tenant import Tenant
from app.services import correspondence_service as S

router = APIRouter(tags=["Correspondence"])
ADMIN = ("admin", "ceo")


def _guard(perm: str, what: str):
    def dep(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
        if (cu.role or "") not in ADMIN and not user_has_permission(db, cu, perm):
            raise HTTPException(403, f"You don't have permission to {what}")
        S.ensure_schema(db)
        return cu
    return dep


viewer = _guard("letter_management.view", "view Correspondence")
creator = _guard("letter_management.create", "create correspondence")
editor = _guard("letter_management.update", "change correspondence settings")


class CampaignIn(BaseModel):
    name: NonBlank("Campaign name", 2, 200)  # type: ignore[valid-type]
    audience: NonBlank("Audience", 1, 120)  # type: ignore[valid-type]
    template_id: Optional[int] = None
    send: str = "now"
    subject_a: str = Field("", max_length=200)
    subject_b: str = Field("", max_length=200)
    create_lead: bool = True

    @field_validator("send")
    @classmethod
    def _send(cls, v: str) -> str:
        if v not in ("now", "tomorrow", "monday"):
            raise ValueError("Please select when to send.")
        return v

    @field_validator("subject_a", "subject_b", mode="before")
    @classmethod
    def _subject(cls, v: Any) -> str:
        return check_text(v, "Subject", 0, 200) or ""


class SequenceIn(BaseModel):
    name: NonBlank("Sequence name", 2, 200)  # type: ignore[valid-type]
    steps: list[dict[str, Any]] = Field(default_factory=list, max_length=30)

    @field_validator("steps")
    @classmethod
    def _steps(cls, v: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not v:
            raise ValueError("Add at least one step.")
        out = []
        for i, st in enumerate(v, 1):
            try:
                day = int(st.get("day", 0))
            except (TypeError, ValueError):
                raise ValueError(f"Step {i}: day must be a whole number.")
            if not 0 <= day <= 365:
                raise ValueError(f"Step {i}: day must be between 0 and 365.")
            kind = st.get("kind") or "Email"
            if kind not in ("Email", "Task"):
                raise ValueError(f"Step {i}: please select Email or Task.")
            text = check_text(st.get("text"), f"Step {i} description", 0, 200, required=True)
            out.append({**st, "day": day, "kind": kind, "text": text})
        return out


class EnrolIn(BaseModel):
    module: str = "leads"
    scope: str = "open"


class FlagIn(BaseModel):
    value: bool


@router.get("/register")
def register(q: str = "", status: str = "", offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=200), db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return S.register(db, q=q.strip()[:120], status=status, offset=offset, limit=limit)


@router.get("/tenders")
def tenders(q: str = "", db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return {"items": S.tenders(db, q.strip()[:120])}


@router.get("/merge-data")
def merge_data(tender_id: Optional[int] = None, db: Session = Depends(get_tenant_db), cu: User = Depends(viewer)):
    return S.merge_data(db, cu, tender_id)


@router.get("/audiences")
def audiences(db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return {"items": S.audiences(db)}


@router.get("/campaigns")
def campaigns(db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return {"items": S.campaigns(db)}


@router.post("/campaigns", status_code=201)
def create_campaign(body: CampaignIn, db: Session = Depends(get_tenant_db), cu: User = Depends(creator)):
    return {"id": S.create_campaign(db, cu, body.model_dump())}


@router.post("/campaigns/{cid}/send")
def send_campaign(cid: int, db: Session = Depends(get_tenant_db), cu: User = Depends(creator)):
    return S.send_campaign(db, cu, cid)


@router.get("/sequences")
def sequences(db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return {"items": S.sequences(db)}


@router.post("/sequences", status_code=201)
def create_sequence(body: SequenceIn, db: Session = Depends(get_tenant_db), cu: User = Depends(creator)):
    return {"id": S.create_sequence(db, cu, body.name, body.steps)}


@router.post("/sequences/{sid}/enrol")
def enrol(sid: int, body: EnrolIn, db: Session = Depends(get_tenant_db), cu: User = Depends(creator)):
    return {"enrolled": S.enrol(db, cu, sid, body.module, body.scope)}


def _domain(request: Request, master_db: Session) -> str:
    slug = getattr(request.state, "tenant_slug", None)
    if slug:
        t = master_db.query(Tenant).filter(Tenant.slug == slug).first()
        for attr in ("domain", "email_domain", "custom_domain"):
            v = getattr(t, attr, None) if t else None
            if v:
                return str(v)
    return ""


@router.get("/mailbox")
def mailbox(request: Request, db: Session = Depends(get_tenant_db), master_db: Session = Depends(get_master_db_dep), _: User = Depends(viewer)):
    return {"flags": S.mailbox_flags(db), "domain": _domain(request, master_db)}


@router.put("/mailbox/{key}")
def set_flag(key: str, body: FlagIn, request: Request, db: Session = Depends(get_tenant_db), master_db: Session = Depends(get_master_db_dep), cu: User = Depends(editor)):
    return S.set_mailbox_flag(db, cu, key, body.value, _domain(request, master_db))
