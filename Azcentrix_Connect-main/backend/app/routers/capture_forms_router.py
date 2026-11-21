"""Lead capture forms – administration API (prototype v17 · Sales → Capture Forms).   /api/v1/capture-forms

Permissions: capture_forms.view (page), capture_forms.create (+ New form), capture_forms.update (fields, routing,
publish, test submissions). Every change is audit-logged. Public rendering / submissions live in
capture_public_router (/api/v1/public/capture).
"""
from __future__ import annotations

from typing import Any, Literal, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.logging import log_audit_db
from app.dependencies import get_current_user, get_request_ip, get_tenant_db, user_has_permission
from app.models.all_models import Lead, LeadSource, User
from app.models.capture_forms import CaptureForm, CaptureSubmission
from app.services import capture_form_service as S

router = APIRouter()


def capture_user(request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if not user_has_permission(db, cu, "capture_forms.view"):
        raise HTTPException(403, "You do not have access to Capture Forms")
    S.ensure_schema(db)
    return cu


def _need(db: Session, cu: User, key: str, what: str) -> None:
    if not user_has_permission(db, cu, key):
        raise HTTPException(403, f"You do not have permission to {what}")


def _form(db: Session, form_id: int) -> CaptureForm:
    f = db.query(CaptureForm).filter(CaptureForm.id == form_id).first()
    if not f:
        raise HTTPException(404, "Form not found")
    return f


def public_base(request: Request) -> str:
    """The Azcentrix Connect address users reach the app on (the browser's origin, which serves /api through the
    same proxy), falling back to FRONTEND_BASE_URL."""
    for cand in (request.headers.get("origin"), request.headers.get("referer"), settings.FRONTEND_BASE_URL):
        if cand:
            u = urlparse(cand)
            if u.scheme in ("http", "https") and u.netloc:
                return f"{u.scheme}://{u.netloc}"
    return ""


def embed(request: Request, slug: str, f: CaptureForm) -> dict[str, str]:
    base = public_base(request)
    url = f"{base}/api/v1/public/capture/f/{slug}/{f.public_key}"
    code = (f'<script src="{base}/api/v1/public/capture/embed.js" data-form="{slug}/{f.public_key}" async></script>\n'
            f"<!-- or share the hosted page -->\n{url}")
    return {"url": url, "script": f"{base}/api/v1/public/capture/embed.js", "code": code}


# ─── meta / KPIs ──────────────────────────────────────────────────────────────

@router.get("/meta")
def meta(request: Request, form_id: Optional[int] = None, db: Session = Depends(get_tenant_db), cu: User = Depends(capture_user)):
    cur = db.query(CaptureForm).filter(CaptureForm.id == form_id).first() if form_id else None
    st = S.stats(db)
    forms = db.query(CaptureForm.id, CaptureForm.is_published).all()
    return {
        "fields": [{"key": k, "label": l, "kind": t} for k, l, t in S.FIELDS],
        "spam_modes": S.SPAM_MODES,
        "routing": S.routing_options(db, cur.assign_mode if cur else None),
        "sources": S.sources(db, cur.source_id if cur else None),
        "products": S.products(db), "states": S.states(db),
        "kpis": {"forms": len(forms), "live": sum(1 for _, on in forms if on), "subs": st["subs"], "leads": st["leads"], "won": st["won"],
                 "spam": st["spam"], "spark": st["spark"]},
        "can": {"create": user_has_permission(db, cu, "capture_forms.create"), "update": user_has_permission(db, cu, "capture_forms.update"),
                "leads": user_has_permission(db, cu, "leads.view")},
        "me": {"id": cu.id, "name": cu.full_name, "email": cu.email, "phone": getattr(cu, "phone", None)},
    }


# ─── forms ────────────────────────────────────────────────────────────────────

@router.get("")
def list_forms(request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(capture_user)):
    st = S.stats(db)["per"]
    slug = db.info.get("tenant_slug") or getattr(request.state, "tenant_slug", "")
    rows = db.query(CaptureForm).order_by(CaptureForm.created_at.desc(), CaptureForm.id.desc()).all()
    return {"items": [{**S.form_dict(db, f, st), "embed": embed(request, slug, f)} for f in rows]}


@router.post("", status_code=201)
def create_form(request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(capture_user)):
    """Prototype capNew(): "New capture form", unpublished, default fields and routing."""
    _need(db, cu, "capture_forms.create", "create capture forms")
    f = CaptureForm(public_key=S.new_key(db), name="New capture form", is_published=False, fields=list(S.DEFAULT_FIELDS),
                    required=list(S.DEFAULT_REQUIRED), assign_mode=S.default_mode(db, cu), source_id=S.default_source_id(db),
                    thanks="Thank you!", spam="Honeypot", rr_cursor=0, created_by=cu.id, updated_by=cu.id)
    db.add(f)
    db.flush()
    log_audit_db(db, cu.id, "capture_forms", "create", f.id, get_request_ip(request), "Capture form created", new_data=S.form_dict(db, f), record_name=f.name)
    db.commit()
    slug = db.info.get("tenant_slug") or ""
    return {**S.form_dict(db, f), "embed": embed(request, slug, f)}


class FormIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    fields: Optional[list[str]] = None
    required: Optional[list[str]] = None
    assign: Optional[str] = Field(None, max_length=40)
    source_id: Optional[int] = None
    thanks: Optional[str] = Field(None, max_length=1000)
    spam: Optional[str] = None


@router.put("/{form_id}")
def update_form(form_id: int, body: FormIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(capture_user)):
    _need(db, cu, "capture_forms.update", "change capture forms")
    f = _form(db, form_id)
    old = S.form_dict(db, f)
    sent = body.model_dump(exclude_unset=True)
    if "name" in sent:
        if not (body.name or "").strip():
            raise HTTPException(422, "Give the form a name")
        f.name = body.name.strip()
    if "fields" in sent:
        fields = S.clean_fields(body.fields or [])
        if not fields:
            raise HTTPException(422, "Keep at least one field on the form")
        f.fields = fields
        f.required = [r for r in (f.required or []) if r in fields]
    if "required" in sent:
        bad = [r for r in body.required or [] if r not in (f.fields or [])]
        if bad:
            raise HTTPException(422, f"{S.LABEL.get(bad[0], bad[0])} is not on the form")
        f.required = S.clean_fields(body.required or [])
    if "assign" in sent:
        if body.assign != f.assign_mode and not S.valid_mode(db, body.assign or ""):
            raise HTTPException(422, "Choose a team, the state rule or an active user")
        f.assign_mode = body.assign
    if "source_id" in sent:
        if body.source_id != f.source_id:
            if body.source_id is not None and not db.query(LeadSource.id).filter(LeadSource.id == body.source_id, LeadSource.is_active == True).first():
                raise HTTPException(422, "Choose an active lead source")
        f.source_id = body.source_id
    if "thanks" in sent:
        f.thanks = (body.thanks or "").strip() or None
    if "spam" in sent:
        if body.spam not in S.SPAM_MODES:
            raise HTTPException(422, "Unknown spam protection")
        f.spam = body.spam
    f.updated_by = cu.id
    new = S.form_dict(db, f)
    changed = {k: new[k] for k in new if old.get(k) != new[k] and k not in ("updated_at",)}
    if changed:
        log_audit_db(db, cu.id, "capture_forms", "update", f.id, get_request_ip(request), "Capture form updated: " + ", ".join(changed),
                     old_data={k: old[k] for k in changed}, new_data=changed, record_name=f.name)
    db.commit()
    db.refresh(f)
    return {**S.form_dict(db, f, S.stats(db)["per"]), "embed": embed(request, db.info.get("tenant_slug") or "", f)}


class PublishIn(BaseModel):
    on: bool


@router.post("/{form_id}/publish")
def publish(form_id: int, body: PublishIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(capture_user)):
    _need(db, cu, "capture_forms.update", "publish capture forms")
    f = _form(db, form_id)
    if body.on:
        if not f.fields:
            raise HTTPException(422, "Add at least one field before publishing")
        if f.source_id is None:
            raise HTTPException(422, "Choose a lead source before publishing")
    f.is_published = bool(body.on)
    f.updated_by = cu.id
    log_audit_db(db, cu.id, "capture_forms", "publish" if body.on else "unpublish", f.id, get_request_ip(request),
                 f"Capture form {'published' if body.on else 'unpublished'}", record_name=f.name)
    db.commit()
    return {"id": f.id, "on": f.is_published}


# ─── submissions ──────────────────────────────────────────────────────────────

@router.get("/{form_id}/submissions")
def submissions(form_id: int, limit: int = Query(25, ge=1, le=200), db: Session = Depends(get_tenant_db), cu: User = Depends(capture_user)):
    _form(db, form_id)
    rows = (db.query(CaptureSubmission).filter(CaptureSubmission.form_id == form_id, CaptureSubmission.status != "spam")
            .order_by(CaptureSubmission.received_at.desc(), CaptureSubmission.id.desc()).limit(limit).all())
    leads = {l.id: l for l in db.query(Lead).filter(Lead.id.in_([r.lead_id for r in rows if r.lead_id] or [-1])).all()}
    users = {u.id: u.full_name for u in db.query(User.id, User.full_name).filter(User.id.in_([r.assigned_to for r in rows if r.assigned_to] or [-1])).all()}
    return {"items": [{
        "id": r.id, "ref": r.ref, "received_at": r.received_at.isoformat() if r.received_at else None, "test": bool(r.is_test), "status": r.status,
        "company": r.company, "contact": r.contact or r.email or r.phone, "interest": r.interest, "assigned_to": users.get(r.assigned_to),
        "lead_id": r.lead_id if r.lead_id in leads and not leads[r.lead_id].is_deleted else None,
        "lead_ref": leads[r.lead_id].lead_ref_id if r.lead_id in leads else None, "error": r.error,
        "routing": r.routing,
    } for r in rows]}


@router.get("/{form_id}/challenge")
def challenge(form_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(capture_user)):
    """Fresh render token (+ CAPTCHA question when configured) for the "Send a test submission" dialog."""
    f = _form(db, form_id)
    slug = db.info.get("tenant_slug") or ""
    return {"rt": S.render_token(slug, f.public_key), "captcha": S.captcha(slug, f.public_key) if "CAPTCHA" in (f.spam or "") else None}


class TestIn(BaseModel):
    values: dict[str, Any]
    rt: Optional[str] = None
    hp: Optional[str] = None
    ct: Optional[str] = None
    ca: Optional[str] = None


@router.post("/{form_id}/test")
def test_submission(form_id: int, body: TestIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(capture_user)):
    """Prototype capTest(): runs the real pipeline (validation, spam protection, duplicates, routing, lead) and flags the
    submission and the lead as test records, so KPIs and the form's counters leave them out."""
    _need(db, cu, "capture_forms.update", "send test submissions")
    f = _form(db, form_id)
    slug = db.info.get("tenant_slug") or ""
    return S.submit(db, slug, f, {**body.model_dump(), "page": "Capture Forms · test submission"}, request, test_user=cu)
