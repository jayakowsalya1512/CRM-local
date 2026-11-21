"""Bids & Tenders (prototype v17 · Sales → Bids & Tenders) – list & board, full-page form, tender page with six tabs
(Basic Info · Tender Details · Workings · Tech Bid Evaluation · Financial · PO & Consignee), stage engine, imports,
bulk actions and Pipelines & Stages configuration.   /api/v1/bids

Permissions: tenders.view / create / update / delete (+ data scope "tenders"); configuration needs settings.manage;
Create work order needs workorders.create (checked by Orders & Projects itself). The legacy /api/v1/tenders API stays
for the modules that read it (consignees, quotations, travel, KAM, reports, dashboards).
"""
from __future__ import annotations

import csv
import io
import json
import logging
import re
from datetime import date
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field, field_validator, model_validator
from app.core import validators as V
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.core.validators import detail_text
from app.core.logging import log_audit_db, log_module_action, model_snapshot
from app.core.timezone import now_ist, today_ist
from app.dependencies import get_current_user, get_request_ip, get_tenant_db, user_has_permission
from app.models.all_models import (ActivityLog, Competitor, LeadCategory, LeadSource, OEM, ProductMaster, Tender, TenderConsignee, TenderProduct,
                                   User)
from app.models.bids import (BidChecklistItem, BidCompetitorPrice, BidCorrigendum, BidFeeItem, BidNegotiationRound, BidPaymentMilestone, BidPenaltyClause,
                             BidProfile, BidTechScore)
from app.services import bid_service as S

logger = logging.getLogger(__name__)
router = APIRouter()

VIEWS = ["All", "My tenders", "Due ≤ 7 days", "Overdue"]
# prototype v17 rendered tenders grid: ID · Journey · Tender · Customer · Portal · Value · EMD · Flow · Stage · Submission · Vertical · Bid mgr
COLUMNS = ["ref", "jid", "title", "customer", "portal", "value", "emd", "flow", "stage", "submit", "vertical", "owner"]
SEARCH = [c for c in COLUMNS if c != "jid"] + ["nit"]


def bid_user(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if not user_has_permission(db, cu, "tenders.view"):
        raise HTTPException(403, "You do not have access to Bids & Tenders")
    from app.services import lead360_service
    lead360_service.ensure_schema(db)      # shared lost-reason setting
    S.ensure_schema(db)
    return cu


def _need(db: Session, cu: User, key: str, what: str) -> None:
    if not user_has_permission(db, cu, key):
        raise HTTPException(403, f"You do not have permission to {what}")


def _authorized_customers(db: Session, cu: User) -> list[dict[str, Any]]:
    from app.routers.deals_router import authorized_customers
    return authorized_customers(db, cu)


def _company(db: Session) -> Optional[str]:
    try:
        from app.database import MasterSessionLocal
        from app.models.tenant import Tenant
        m = MasterSessionLocal()
        try:
            t = m.query(Tenant).filter(Tenant.slug == db.info.get("tenant_slug")).first()
            return t.name if t else None
        finally:
            m.close()
    except Exception:
        return None


# ─── meta & masters ───────────────────────────────────────────────────────────

@router.get("/meta")
def meta(db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    from app.services.lead360_service import lost_reasons
    cfg = S.config(db)
    return {
        "company": _company(db), "views": VIEWS, **_flow_meta(db), "me": {"id": cu.id, "name": cu.full_name},
        "lost": lost_reasons(db), "config": {k: cfg[k] for k in ("gst_pct", "emd_default_pct", "reminder_days")},
        "can": {"create": user_has_permission(db, cu, "tenders.create"), "update": user_has_permission(db, cu, "tenders.update"),
                "delete": user_has_permission(db, cu, "tenders.delete"), "export": user_has_permission(db, cu, "tenders.export"),
                "documents": user_has_permission(db, cu, "document_management.create"), "workorders": user_has_permission(db, cu, "workorders.create"),
                "configure": user_has_permission(db, cu, "settings.manage")},
    }


def _flow_meta(db: Session) -> dict[str, Any]:
    """Tender & bid flows (each with its stages) and the merged board columns (prototype WFS())."""
    fl = S.flows(db, include_inactive=True)
    board = S.board_stages(fl)
    return {"flows": [{k: f[k] for k in ("key", "name", "default", "active", "stages")} for f in fl], "board": board,
            "stages": [{"name": b["name"], "kind": b["kind"], "gate": b["gate"]} for b in board]}


@router.get("/customers")
def customers(q: str = "", limit: int = Query(50, ge=1, le=500), db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    rows = _authorized_customers(db, cu)
    term = q.strip().lower()
    if term:
        rows = [c for c in rows if term in c["customer_name"].lower()]
    return {"items": [{"id": c["id"], "name": c["customer_name"]} for c in rows[:limit]], "total": len(rows)}


@router.get("/masters")
def masters(db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    """Portals (Lead sources master), categories (Lead categories master), OEMs (Partners & OEM), competitors
    (Competitive Intel) and products (Products & Price Books) – active rows only."""
    act = lambda m: m.is_active == True  # noqa: E731,E712
    return {
        "portals": [{"id": i, "name": n} for i, n in db.query(LeadSource.id, LeadSource.name).filter(act(LeadSource)).order_by(LeadSource.name).all()],
        "categories": [{"id": i, "name": n} for i, n in db.query(LeadCategory.id, LeadCategory.name).filter(act(LeadCategory)).order_by(LeadCategory.name).all()],
        "oems": [{"id": i, "name": n, "sub": ty or ""} for i, n, ty in db.query(OEM.id, OEM.name, OEM.type).filter(act(OEM), OEM.is_deleted == False).order_by(OEM.name).all()],  # noqa: E712
        "competitors": [{"id": i, "name": n} for i, n in db.query(Competitor.id, Competitor.name).filter(act(Competitor)).order_by(Competitor.name).all()],
        "products": [{"id": i, "name": n, "sub": c or ""} for i, n, c in db.query(ProductMaster.id, ProductMaster.name, ProductMaster.category).filter(act(ProductMaster)).order_by(ProductMaster.name).all()],
        "verticals": _verticals(db),
    }


def _verticals(db: Session) -> list[dict[str, Any]]:
    """Business verticals = the business units of Masters → Business categories (same list the lead / deal forms use)."""
    rows = db.execute(text("SELECT u.id, COALESCE(u.business_unit, u.business_vertical) AS n, COALESCE(c.business_vertical, c.business_unit) AS m "
                           "FROM business_category_units u LEFT JOIN business_category_units c ON c.id = u.parent_category_id "
                           "WHERE u.item_type = 'unit' AND COALESCE(u.is_active, 1) = 1 ORDER BY n")).mappings().all()
    return [{"id": r["id"], "name": r["n"], "sub": r["m"] or ""} for r in rows if r["n"]]


def _check_vertical(db: Session, vid: Optional[int]) -> None:
    if vid is None:
        return
    if not db.execute(text("SELECT 1 FROM business_category_units WHERE id = :i AND item_type = 'unit' AND COALESCE(is_active, 1) = 1"), {"i": vid}).first():
        raise HTTPException(422, "Choose an active business vertical from the master")


@router.get("/locations")
def locations(q: str = "", limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    """Locations master (location_masters): districts with their state, and states."""
    like = f"%{q.strip()}%"
    rows = db.execute(text("SELECT l.id, l.name, l.item_type, p.name AS parent FROM location_masters l LEFT JOIN location_masters p ON p.id = l.parent_id "
                           "WHERE l.is_active = 1 AND l.item_type IN ('district','state') AND (l.name LIKE :q OR p.name LIKE :q) "
                           "ORDER BY l.item_type = 'state' DESC, l.name LIMIT :n"), {"q": like, "n": limit}).mappings().all()
    return {"items": [{"id": r["id"], "name": r["name"] + (f", {r['parent']}" if r["item_type"] == "district" and r["parent"] else ""),
                       "sub": "State" if r["item_type"] == "state" else "District"} for r in rows]}


def _location_row(db: Session, loc_id: int) -> dict:
    r = db.execute(text("SELECT l.id, l.name, l.item_type, p.name AS parent FROM location_masters l LEFT JOIN location_masters p ON p.id = l.parent_id "
                        "WHERE l.id = :i AND l.is_active = 1 AND l.item_type IN ('district','state')"), {"i": loc_id}).mappings().first()
    if not r:
        raise HTTPException(422, "Choose a location from the Locations master")
    return dict(r)


@router.get("/duplicates")
def duplicates(customer_id: Optional[int] = None, title: str = "", nit: str = "", exclude_id: Optional[int] = None,
               db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    """Form "Possible duplicate" note: same Tender / NIT number anywhere, or the same customer + title."""
    q = db.query(Tender).filter(Tender.is_deleted == False)  # noqa: E712
    if exclude_id:
        q = q.filter(Tender.id != exclude_id)
    out = []
    if nit.strip():
        out += [{"id": t.id, "ref": S.ref_of(t), "title": t.tender_title or "", "why": "same NIT number"}
                for t in q.filter(func.lower(Tender.portal_ref_number) == nit.strip().lower()).limit(3).all()]
    if customer_id and title.strip():
        out += [{"id": t.id, "ref": S.ref_of(t), "title": t.tender_title or "", "why": "same customer and title"}
                for t in q.filter(Tender.customer_id == customer_id, func.lower(Tender.tender_title) == title.strip().lower()).limit(3).all()
                if t.id not in {x["id"] for x in out}]
    return {"items": out[:3]}


# ─── list / board ─────────────────────────────────────────────────────────────

def _txt(r: dict, k: str) -> str:
    v = r.get(k)
    return "" if v is None else str(v)


def _cond(r: dict, k: str, op: str, v: str) -> bool:
    t, tl, vl = _txt(r, k), _txt(r, k).lower(), (v or "").lower()
    try:
        n, vn = float(r.get(k) or 0), float(v)
    except (TypeError, ValueError):
        n = vn = None
    return {
        "contains": vl in tl, "ncontains": vl not in tl, "eq": tl == vl or (n is not None and n == vn), "ne": not (tl == vl or (n is not None and n == vn)),
        "starts": tl.startswith(vl), "gt": n is not None and n > vn, "lt": n is not None and n < vn, "gte": n is not None and n >= vn,
        "lte": n is not None and n <= vn, "empty": t.strip() in ("", "—"), "nempty": t.strip() not in ("", "—"), "before": t < v, "after": t > v,
    }.get(op, True)


def _in_view(r: dict, view: str, me: int, today: date) -> bool:
    """prototype views: My tenders · Due ≤ 7 days (0 ≤ days to submission ≤ 7) · Overdue (past submission, not won / lost)."""
    if view == "My tenders":
        return r["owner_id"] == me
    if view.startswith("Due"):
        return bool(r["submit"]) and 0 <= (date.fromisoformat(r["submit"]) - today).days <= 7
    if view == "Overdue":
        return bool(r["submit"]) and (date.fromisoformat(r["submit"]) - today).days < 0 and r["stage_kind"] == "open"
    return True


@router.get("/list")
def list_bids(view: str = "All", stage: str = "", q: str = "", f: str = "", adv: str = "", sorts: str = "",
              offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=1000),
              db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    try:
        quick, advf, order = (json.loads(f) if f else {}), (json.loads(adv) if adv else {}), (json.loads(sorts) if sorts else [])
    except ValueError:
        raise HTTPException(422, "Invalid filter or sort")
    rows, _ = S.list_rows(db, cu)
    try:
        S.send_reminders(db, rows)
    except Exception:
        db.rollback()
        logger.warning("bid reminders failed", exc_info=True)
    today = today_ist()
    counts = {v: sum(1 for r in rows if _in_view(r, v, cu.id, today)) for v in VIEWS}
    sel = [r for r in rows if _in_view(r, view, cu.id, today)]
    if stage:
        sel = [r for r in sel if r["stage"] == stage]
    if q.strip():
        ql = q.strip().lower()
        sel = [r for r in sel if any(ql in _txt(r, k).lower() for k in SEARCH)]
    for k, v in (quick or {}).items():
        if k in COLUMNS and str(v or "").strip():
            sel = [r for r in sel if str(v).lower() in _txt(r, k).lower() or (k == "title" and str(v).lower() in r["nit"].lower())]
    conds = [c for c in (advf.get("conds") or []) if isinstance(c, dict) and c.get("k") in COLUMNS]
    if conds:
        test = all if advf.get("logic") != "OR" else any
        sel = [r for r in sel if test(_cond(r, c["k"], str(c.get("op") or "contains"), str(c.get("v") or "")) for c in conds)]
    sort_items = [x for x in order if isinstance(x, (list, tuple)) and len(x) == 2 and x[0] in COLUMNS]
    for k, d in reversed(sort_items):
        num = k in ("value", "emd")
        sel.sort(key=lambda r: (r[k] or 0) if num else (r["id"] if k == "ref" else _txt(r, k).lower()), reverse=int(d) < 0)
    if not sort_items:
        sel.sort(key=lambda r: -r["id"])
    return {"items": sel[offset:offset + limit], "total": len(sel), "total_all": len(rows), "counts": counts, "value_total": sum(r["value"] for r in sel)}


# ─── create / edit (prototype FD.tenders – ten default fields + Form Builder fields) ───

class BidIn(BaseModel):
    title: str = Field(..., min_length=1, max_length=500)
    nit: str = Field(..., min_length=1, max_length=200)
    customer_id: int
    portal_id: Optional[int] = None
    value: Optional[float] = Field(None, ge=0)
    emd: Optional[float] = Field(None, ge=0)
    submit: date
    owner_id: Optional[int] = None
    category_id: Optional[int] = None
    location_id: Optional[int] = None
    vertical_id: Optional[int] = None
    flow: Optional[str] = Field(None, max_length=40)      # None = automatic (the default flow)
    custom_data: Optional[dict[str, Any]] = None

    @field_validator("title")
    @classmethod
    def _txt2(cls, v):
        return V.check_text(v, "Tender title", 3, 500, required=True)

    @field_validator("nit")
    @classmethod
    def _txt3(cls, v):
        return V.check_text(v, "Tender / NIT number", 2, 200, required=True)

    @field_validator("submit")
    @classmethod
    def _dates(cls, v, info):
        return V.check_date_range(v, info.field_name.replace("_", " ").capitalize())

    @field_validator("value", "emd")
    @classmethod
    def _money(cls, v, info):
        return V.check_amount(v, "EMD" if info.field_name == "emd" else "Tender value")

    @model_validator(mode="after")
    def _emd_le_value(self):
        if self.emd is not None and self.value is not None and self.emd > self.value:
            raise V.field_error("emd", "EMD cannot be more than the tender value.")
        return self


def _check_master(db: Session, model, rid: Optional[int], what: str, extra=None) -> None:
    if rid is None:
        return
    q = db.query(model.id).filter(model.id == rid, model.is_active == True)  # noqa: E712
    if extra is not None:
        q = q.filter(extra)
    if not q.first():
        raise HTTPException(422, f"Choose an active {what} from the master")


def _validate(db: Session, cu: User, body: BidIn, current: Optional[Tender] = None, prof: Optional[BidProfile] = None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    body.custom_data = V.validate_module_custom_data(db, "tenders", body.custom_data)
    if current and current.customer_id == body.customer_id:
        out["customer_name"] = current.customer_name
    else:
        c = next((x for x in _authorized_customers(db, cu) if x["id"] == body.customer_id), None)
        if not c:
            raise V.field_error("customer_id", "Choose a customer you can work with.")
        out["customer_name"] = c["customer_name"]
    if not (current and current.source_id == body.portal_id):
        _check_master(db, LeadSource, body.portal_id, "portal")
    if not (prof and prof.category_id == body.category_id):
        _check_master(db, LeadCategory, body.category_id, "category")
    if body.location_id is not None and not (prof and prof.location_id == body.location_id):
        _location_row(db, body.location_id)
    if not (current and getattr(current, "business_vertical_id", None) == body.vertical_id):
        _check_vertical(db, body.vertical_id)
    fl = S.flows(db, include_inactive=True)
    flow = S.flow_map(fl).get(body.flow) if body.flow else S.default_flow(fl)
    if not flow or (not flow["active"] and not (prof and prof.flow == flow["key"])):
        raise HTTPException(422, "Choose an active tender flow")
    out["flow"], out["flows"] = flow, fl
    if body.owner_id is not None and not (current and current.assigned_to == body.owner_id):
        if not db.query(User.id).filter(User.id == body.owner_id, User.is_active == True).first():  # noqa: E712
            raise HTTPException(422, "Choose an active user as bid manager")
    nit = body.nit.strip()
    dup = db.query(Tender).filter(Tender.is_deleted == False, func.lower(Tender.portal_ref_number) == nit.lower())  # noqa: E712
    if current:
        dup = dup.filter(Tender.id != current.id)
    d = dup.first()
    if d:
        raise V.field_error("nit", f"Tender / NIT number {nit} is already used by {S.ref_of(d)}.", 409)
    cd = body.custom_data or {}
    miss = [f.label for f in S.required_custom(db) if cd.get(f.field_key) in (None, "", False)]
    if miss:
        raise HTTPException(422, "Required: " + ", ".join(miss))
    return out


def _emd_default(db: Session, body: BidIn) -> Optional[float]:
    if body.emd is not None:
        return body.emd
    if body.value:
        return round(body.value * float(S.config(db)["emd_default_pct"]) / 100, 2)   # tip: EMD defaults to the configured % of value
    return None


@router.post("", status_code=201)
def create(body: BidIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    from app.routers.tender_router import _next_tender_num
    _need(db, cu, "tenders.create", "create tenders")
    v = _validate(db, cu, body)
    flow = v["flow"]
    emd = _emd_default(db, body)
    t = Tender(tender_num=_next_tender_num(db), customer_id=body.customer_id, customer_name=v["customer_name"], tender_title=body.title.strip(),
               portal_ref_number=body.nit.strip(), est_value=body.value, source_id=body.portal_id, source_portal="Other", tender_status="Aligned",
               submission_date=body.submit, assigned_to=body.owner_id or cu.id, created_by=cu.id, workflow_status="draft", current_step=1,
               listed_in_accounts=False, emd_amount=emd, emd_required=bool(emd), result="Pending", custom_data=body.custom_data or None,
               business_vertical_id=body.vertical_id)
    db.add(t)
    db.flush()
    db.execute(text("UPDATE tenders SET submission_deadline = :d WHERE id = :i"), {"d": body.submit, "i": t.id})
    first = next(s for s in flow["stages"] if s["kind"] == "open")
    db.add(BidProfile(tender_id=t.id, flow=flow["key"], category_id=body.category_id, location_id=body.location_id, po_ack=False, stage_entered_at=now_ist()))
    db.execute(text("INSERT INTO workflow_record_stages (workflow, record_id, stage_id, mapped_at) VALUES (:w, :r, :s, :now)"),
               {"w": flow["key"], "r": t.id, "s": first["id"], "now": now_ist()})
    db.add(ActivityLog(user_id=cu.id, module="tenders", record_id=t.id, action="created", description=f"Tender '{t.tender_title}' created", icon="🏗️", color="#EFF6FF"))
    from app.services.instrument_service import on_tender_emd   # Guarantees & Deposits: auto-create the EMD instrument (setting)
    on_tender_emd(db, cu, t)
    log_module_action(db=db, user_id=cu.id, module="tenders", action="create", record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request),
                      new_data={**model_snapshot(t), "flow": flow["name"], "stage": first["name"], "category_id": body.category_id, "location_id": body.location_id})
    if t.assigned_to and t.assigned_to != cu.id:
        try:
            from app.services.notification_service import upsert_notification
            upsert_notification(db, t.assigned_to, "Tender assigned", f"{t.tender_num} · {t.tender_title} was assigned to you by {cu.full_name}.",
                                module="tenders", record_id=t.id, action="assigned", send_email=False)
        except Exception as exc:
            logger.warning("tender assignment notification failed: %s", exc)
    db.commit()
    try:
        from app.services.platform_webhooks import emit_safe
        emit_safe(getattr(request.state, "tenant_slug", None), "tender.created",
                  {"id": t.id, "tender_title": t.tender_title, "tender_status": t.tender_status, "created_at": t.created_at})
    except Exception:
        logger.warning("tender webhook failed", exc_info=True)
    return {"id": t.id, "ref": t.tender_num}


def _snapshot(t: Tender, prof: BidProfile) -> dict[str, Any]:
    return {"title": t.tender_title, "nit": t.portal_ref_number, "customer_id": t.customer_id, "portal_id": t.source_id, "value": float(t.est_value or 0),
            "emd": float(t.emd_amount or 0), "submit": t.submission_date.isoformat() if t.submission_date else None, "owner_id": t.assigned_to,
            "category_id": prof.category_id, "location_id": prof.location_id, "vertical_id": getattr(t, "business_vertical_id", None), "flow": prof.flow,
            "custom_data": t.custom_data}


def _notify_owner(db: Session, cu: User, t: Tender, old_owner: Optional[int]) -> None:
    if t.assigned_to and t.assigned_to != old_owner and t.assigned_to != cu.id:
        try:
            from app.services.notification_service import upsert_notification
            upsert_notification(db, t.assigned_to, "Tender assigned", f"{S.ref_of(t)} · {t.tender_title} was assigned to you by {cu.full_name}.",
                                module="tenders", record_id=t.id, action="assigned", send_email=False)
        except Exception as exc:
            logger.warning("tender assignment notification failed: %s", exc)


@router.put("/{tender_id}")
def update(tender_id: int, body: BidIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    profiles, cur = S.sync(db, [t], S.flows(db, include_inactive=True))
    prof = profiles[t.id]
    v = _validate(db, cu, body, t, prof)
    old = _snapshot(t, prof)
    if body.flow and body.flow != prof.flow:
        if prof.pending_stage_id:
            raise HTTPException(409, "A stage change is waiting for approval – decide it before changing the flow")
        S.set_flow(db, t, prof, v["flows"], cur[t.id], body.flow)
    old_owner = t.assigned_to
    t.tender_title, t.portal_ref_number = body.title.strip(), body.nit.strip()
    t.customer_id, t.customer_name = body.customer_id, v["customer_name"]
    t.source_id, t.est_value = body.portal_id, body.value
    t.emd_amount = body.emd if body.emd is not None else t.emd_amount
    t.emd_required = bool(t.emd_amount)
    t.submission_date = body.submit
    t.assigned_to = body.owner_id or t.assigned_to
    prof.category_id, prof.location_id = body.category_id, body.location_id
    t.business_vertical_id = body.vertical_id
    if body.custom_data is not None:
        t.custom_data = body.custom_data
    t.updated_at = now_ist()
    db.execute(text("UPDATE tenders SET submission_deadline = :d WHERE id = :i"), {"d": body.submit, "i": t.id})
    new = _snapshot(t, prof)
    changed = {k: new[k] for k in new if old[k] != new[k]}
    if changed:
        log_module_action(db=db, user_id=cu.id, module="tenders", action="update", record_id=t.id, record_name=t.tender_title,
                          ip=get_request_ip(request), old_data={k: old[k] for k in changed}, new_data=changed)
    _notify_owner(db, cu, t, old_owner)
    from app.services.instrument_service import on_tender_emd   # Guarantees & Deposits: EMD added later → instrument (idempotent)
    on_tender_emd(db, cu, t)
    db.commit()
    return {"id": t.id}


# ─── field edits from the tender page tabs and the grid (one validated whitelist) ───

class FieldsIn(BaseModel):
    values: dict[str, Any]


_DATE_FIELDS = {"published": "published_date", "prebid": "pre_bid_date", "submit": "submission_date", "opening": "tech_bid_date", "opening2": "financial_bid_date", "po_date": "po_date"}
_PRICE_LOCKED = {"oh", "cg", "mg"}


def _num(v, what: str, lo: float = 0, hi: Optional[float] = None, allow_none: bool = True) -> Optional[float]:
    if v in (None, ""):
        if allow_none:
            return None
        raise HTTPException(422, f"{what} is required")
    try:
        n = float(v)
    except (TypeError, ValueError):
        raise HTTPException(422, f"{what} must be a number")
    if n < lo or (hi is not None and n > hi):
        raise HTTPException(422, f"{what} must be between {lo:g} and {hi:g}" if hi is not None else f"{what} must be {lo:g} or more")
    return n


def _date(v, what: str) -> Optional[date]:
    if v in (None, ""):
        return None
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        raise HTTPException(422, f"{what}: enter a valid date")


@router.patch("/{tender_id}")
def patch_fields(tender_id: int, body: FieldsIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    """Basic Info, Tender Details (key dates, bid validity, scope), Workings (overheads / contingency / margin), Tech
    (cut-off), Financial (PBG %, payment terms), PO (number, date, value, delivery, LD, acknowledged) and the grid's
    inline edits (Submission, Portal). Every value is validated against its master / range before it is saved."""
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    fl = S.flows(db, include_inactive=True)
    profiles, cur = S.sync(db, [t], fl)
    prof = profiles[t.id]
    vals = body.values or {}
    if not vals:
        return {"id": t.id}
    allowed = {"title", "nit", "customer_id", "portal_id", "category_id", "location_id", "owner_id", "oem_id", "value", "emd", "fee", "published", "prebid",
               "submit", "opening", "validity", "scope", "oh", "cg", "mg", "cutoff", "pbg_pct", "pay", "po_no", "po_date", "po_value", "deliv", "ld", "ack", "custom_data",
               "vertical_id", "flow", "selMethod", "jv", "jvCount", "gst", "opening2"}
    bad = set(vals) - allowed
    if bad:
        raise HTTPException(422, f"Unknown field: {', '.join(sorted(bad))}")
    if _PRICE_LOCKED & set(vals) and prof.price_status in ("pending", "approved"):
        raise HTTPException(409, "The price bid is frozen – it can't be changed while it is " + ("awaiting approval" if prof.price_status == "pending" else "approved"))
    extra = db.execute(text("SELECT tech_bid_date, financial_bid_date FROM tenders WHERE id = :i"), {"i": t.id}).mappings().first() or {}
    old: dict[str, Any] = {}
    new: dict[str, Any] = {}

    def put(key: str, before, after):
        if before != after:
            old[key], new[key] = before, after

    old_owner = t.assigned_to
    for k, v in vals.items():
        if k == "title":
            s = str(v or "").strip()
            if not s or len(s) > 500:
                raise HTTPException(422, "Tender title is required (max 500 characters)")
            put(k, t.tender_title, s); t.tender_title = s
        elif k == "nit":
            s = str(v or "").strip()
            if not s or len(s) > 200:
                raise HTTPException(422, "Tender / NIT number is required")
            d = db.query(Tender).filter(Tender.is_deleted == False, Tender.id != t.id, func.lower(Tender.portal_ref_number) == s.lower()).first()  # noqa: E712
            if d:
                raise HTTPException(409, f"Tender / NIT number {s} is already used by {S.ref_of(d)}")
            put(k, t.portal_ref_number, s); t.portal_ref_number = s
        elif k == "customer_id":
            cid = int(v or 0)
            if cid != t.customer_id:
                c = next((x for x in _authorized_customers(db, cu) if x["id"] == cid), None)
                if not c:
                    raise HTTPException(422, "Choose a customer you can work with")
                put(k, t.customer_id, cid); t.customer_id, t.customer_name = cid, c["customer_name"]
        elif k == "portal_id":
            pid = int(v) if v not in (None, "") else None
            _check_master(db, LeadSource, pid, "portal")
            put(k, t.source_id, pid); t.source_id = pid
        elif k == "category_id":
            cid = int(v) if v not in (None, "") else None
            _check_master(db, LeadCategory, cid, "category")
            put(k, prof.category_id, cid); prof.category_id = cid
        elif k == "location_id":
            lid = int(v) if v not in (None, "") else None
            if lid is not None:
                _location_row(db, lid)
            put(k, prof.location_id, lid); prof.location_id = lid
        elif k == "vertical_id":
            vid = int(v) if v not in (None, "") else None
            _check_vertical(db, vid)
            put(k, getattr(t, "business_vertical_id", None), vid); t.business_vertical_id = vid
        elif k == "flow":
            if prof.pending_stage_id:
                raise HTTPException(409, "A stage change is waiting for approval – decide it before changing the flow")
            before = prof.flow
            moved = S.set_flow(db, t, prof, fl, cur[t.id], str(v or ""))
            if moved is not None:
                put(k, before, prof.flow)
                S._log(db, cu, request, t, f"Flow changed to {S.flow_map(fl)[prof.flow]['name']} · stage {moved['name']}", {"flow": prof.flow, "stage": moved["name"]},
                       action="flow_change")
        elif k == "oem_id":
            oid = int(v) if v not in (None, "") else None
            _check_master(db, OEM, oid, "OEM", OEM.is_deleted == False)  # noqa: E712
            put(k, prof.oem_id, oid); prof.oem_id = oid
        elif k == "owner_id":
            uid = int(v or 0)
            if not db.query(User.id).filter(User.id == uid, User.is_active == True).first():  # noqa: E712
                raise HTTPException(422, "Choose an active user as bid manager")
            put(k, t.assigned_to, uid); t.assigned_to = uid
        elif k in ("value", "emd", "fee"):
            n = _num(v, {"value": "Estimated value", "emd": "EMD", "fee": "Tender fee"}[k])
            col = {"value": "est_value", "emd": "emd_amount", "fee": "tender_fee_amount"}[k]
            put(k, float(getattr(t, col) or 0) if getattr(t, col) is not None else None, n)
            setattr(t, col, n)
            if k == "emd":
                t.emd_required = bool(n)
            if k == "fee":
                t.tender_fee_required = bool(n)
        elif k in _DATE_FIELDS:
            d = _date(v, {"published": "Published", "prebid": "Pre-bid meeting", "submit": "Bid submission", "opening": "Technical bid opening",
                          "opening2": "Financial bid opening", "po_date": "PO date"}[k])
            if k == "submit" and d is None:
                raise HTTPException(422, "Bid submission date is required")
            if k == "opening":
                put(k, extra.get("tech_bid_date"), d)
                db.execute(text("UPDATE tenders SET tech_bid_date = :d WHERE id = :i"), {"d": d, "i": t.id})
                extra = {**extra, "tech_bid_date": d}
            elif k == "opening2":
                put(k, extra.get("financial_bid_date"), d)
                db.execute(text("UPDATE tenders SET financial_bid_date = :d WHERE id = :i"), {"d": d, "i": t.id})
                extra = {**extra, "financial_bid_date": d}
            else:
                put(k, getattr(t, _DATE_FIELDS[k]), d)
                setattr(t, _DATE_FIELDS[k], d)
                if k == "submit":
                    db.execute(text("UPDATE tenders SET submission_deadline = :d WHERE id = :i"), {"d": d, "i": t.id})
        elif k == "validity":
            n = _num(v, "Bid validity", 1, 1000)
            put(k, prof.bid_validity_days, int(n) if n is not None else None); prof.bid_validity_days = int(n) if n is not None else None
        elif k == "selMethod":
            s = str(v or "").strip()
            if s and s not in ("L1", "QCBS", "Single bid"):
                raise HTTPException(422, "Method of selection must be L1, QCBS or Single bid")
            put(k, prof.selection_method, s or None); prof.selection_method = s or None
        elif k == "jv":
            put(k, bool(prof.jv_allowed), bool(v)); prof.jv_allowed = bool(v)
            if not v:
                put("jvCount", prof.jv_member_count, None); prof.jv_member_count = None
        elif k == "jvCount":
            n = _num(v, "No. of consortium members", 1, 20) if v not in (None, "") else None
            put(k, prof.jv_member_count, int(n) if n is not None else None); prof.jv_member_count = int(n) if n is not None else None
        elif k == "gst":
            put(k, True if prof.gst_applicable is None else bool(prof.gst_applicable), bool(v)); prof.gst_applicable = bool(v)
        elif k == "scope":
            s = str(v or "")
            if len(s) > 20000:
                raise HTTPException(422, "Scope of work is too long")
            put(k, t.sow, s); t.sow = s
        elif k in ("oh", "cg", "mg", "cutoff", "pbg_pct"):
            n = _num(v, {"oh": "Overheads %", "cg": "Contingency %", "mg": "Margin %", "cutoff": "Cut-off %", "pbg_pct": "Performance BG %"}[k], 0, 100)
            col = {"oh": "overhead_pct", "cg": "contingency_pct", "mg": "margin_pct", "cutoff": "tech_cutoff_pct", "pbg_pct": "pbg_pct"}[k]
            before = getattr(prof, col)
            put(k, float(before) if before is not None else None, n)
            setattr(prof, col, n)
        elif k == "pay":
            s = str(v or "").strip()
            put(k, t.pmnt_terms, s); t.pmnt_terms = s
        elif k == "po_no":
            s = str(v or "").strip()
            if len(s) > 50:
                raise HTTPException(422, "PO number is too long (max 50)")
            put(k, t.po_num, s or None); t.po_num = s or None
        elif k == "po_value":
            n = _num(v, "PO value")
            put(k, float(t.po_value) if t.po_value is not None else None, n); t.po_value = n
        elif k == "deliv":
            s = str(v or "").strip()[:200]
            put(k, prof.delivery_period, s or None); prof.delivery_period = s or None
        elif k == "ld":
            s = str(v or "").strip()[:300]
            put(k, prof.ld_terms, s or None); prof.ld_terms = s or None
        elif k == "ack":
            put(k, bool(prof.po_ack), bool(v)); prof.po_ack = bool(v)
        elif k == "custom_data":
            if not isinstance(v, dict):
                raise HTTPException(422, "Custom fields must be an object")
            miss = [f.label for f in S.required_custom(db) if v.get(f.field_key) in (None, "", False)]
            if miss:
                raise HTTPException(422, "Required: " + ", ".join(miss))
            put(k, t.custom_data, v); t.custom_data = v
    # key dates must stay in order (Published ≤ Pre-bid ≤ Bid submission ≤ Technical bid opening)
    seq = [("Published", t.published_date), ("Pre-bid meeting", t.pre_bid_date), ("Bid submission", t.submission_date), ("Technical bid opening", extra.get("tech_bid_date")),
           ("Financial bid opening", extra.get("financial_bid_date"))]
    dated = [(n, d) for n, d in seq if d]
    for (n1, d1), (n2, d2) in zip(dated, dated[1:]):
        if d2 < d1:
            raise HTTPException(422, f"{n2} can't be before {n1}")
    if "pbg_pct" in new:
        cfg = S.config(db)
        our, _ = S.our_price(db, t, prof, cfg)
        pbg = float(prof.pbg_pct or 0)
        t.pbg_required = bool(pbg)
        t.pbg_amount = round(our * pbg / 100, 2) if our else None
    if new:
        t.updated_at = now_ist()
        log_module_action(db=db, user_id=cu.id, module="tenders", action="update", record_id=t.id, record_name=t.tender_title,
                          ip=get_request_ip(request), old_data={k: (x.isoformat() if isinstance(x, date) else x) for k, x in old.items()},
                          new_data={k: (x.isoformat() if isinstance(x, date) else x) for k, x in new.items()})
        _notify_owner(db, cu, t, old_owner)
    db.commit()
    return {"id": t.id, "changed": sorted(new)}


def _delete(db: Session, cu: User, request: Request, t: Tender) -> None:
    if t.wrk_order_id:
        raise HTTPException(409, f"Work order {t.wrk_order_id} was created from this tender")
    before = model_snapshot(t)
    t.is_deleted = True
    t.updated_at = now_ist()
    db.add(ActivityLog(user_id=cu.id, module="tenders", record_id=t.id, action="deleted", description=f"Tender '{t.tender_title}' deleted", icon="🗑️", color="#FFF5F5"))
    log_module_action(db=db, user_id=cu.id, module="tenders", action="delete", record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request), old_data=before)


@router.delete("/{tender_id}")
def delete(tender_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    _need(db, cu, "tenders.delete", "delete tenders")
    t = S.get_bid(db, cu, tender_id)
    _delete(db, cu, request, t)
    db.commit()
    return {"ok": True}


class BulkIn(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=500)
    action: Literal["reassign", "delete"]
    value: Optional[str] = None


@router.post("/bulk")
def bulk(body: BulkIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    _need(db, cu, "tenders.delete" if body.action == "delete" else "tenders.update", "change these tenders")
    uid = None
    if body.action == "reassign":
        uid = int(body.value or 0)
        if not db.query(User.id).filter(User.id == uid, User.is_active == True).first():  # noqa: E712
            raise HTTPException(422, "Choose an active user")
    done, failed = 0, []
    for tid in dict.fromkeys(body.ids):
        try:
            t = S.get_bid(db, cu, tid)
            if body.action == "delete":
                _delete(db, cu, request, t)
            elif t.assigned_to != uid:
                old = t.assigned_to
                t.assigned_to = uid
                log_module_action(db=db, user_id=cu.id, module="tenders", action="reassign", record_id=t.id, record_name=t.tender_title,
                                  ip=get_request_ip(request), old_data={"assigned_to": old}, new_data={"assigned_to": uid})
                _notify_owner(db, cu, t, old)
            db.commit()
            done += 1
        except HTTPException as exc:
            db.rollback()
            failed.append({"id": tid, "error": detail_text(exc.detail, "Not allowed")})
    return {"done": done, "failed": failed}


IMPORT_COLUMNS = ["Tender title", "Tender / NIT number", "Customer", "Portal", "Estimated value", "EMD amount", "Bid submission date (YYYY-MM-DD)",
                  "Bid manager email", "Category", "Location", "Business vertical", "Sales flow"]


@router.get("/import/template")
def import_template(cu: User = Depends(bid_user)):
    from fastapi.responses import Response
    return Response(",".join(IMPORT_COLUMNS) + "\n", media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="tenders-import-template.csv"'})


@router.post("/import")
async def import_bids(request: Request, file: UploadFile = File(...), dry_run: bool = Query(False), db: Session = Depends(get_tenant_db),
                      cu: User = Depends(bid_user)):
    """Rows are matched to the masters by name (customer, portal, category, location, bid manager e-mail) and created
    through the same validated path as the form; a NIT number already used (or repeated in the file) is reported as a
    duplicate. dry_run=true validates without creating."""
    _need(db, cu, "tenders.create", "import tenders")
    raw = (await file.read()).decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(raw))
    if not reader.fieldnames or "Tender title" not in reader.fieldnames or "Tender / NIT number" not in reader.fieldnames:
        raise HTTPException(422, "Use the import template (Tender title, Tender / NIT number, Customer, …)")
    custs = {c["customer_name"].strip().lower(): c["id"] for c in _authorized_customers(db, cu)}
    portals = {s.name.strip().lower(): s.id for s in db.query(LeadSource).filter(LeadSource.is_active == True).all()}  # noqa: E712
    cats = {c.name.strip().lower(): c.id for c in db.query(LeadCategory).filter(LeadCategory.is_active == True).all()}  # noqa: E712
    users = {(u.email or "").strip().lower(): u.id for u in db.query(User).filter(User.is_active == True).all() if u.email}  # noqa: E712
    existing = {(n or "").strip().lower() for (n,) in db.query(Tender.portal_ref_number).filter(Tender.is_deleted == False).all() if n}  # noqa: E712
    verts = {x["name"].strip().lower(): x["id"] for x in _verticals(db)}
    flows_by = {f["name"].strip().lower(): f["key"] for f in S.flows(db) if f["active"]}
    created, errors, dups, seen = 0, [], [], set()
    for i, row in enumerate(reader, start=2):
        g = lambda k: str(row.get(k) or "").strip()  # noqa: E731
        title = g("Tender title")
        try:
            if not title:
                raise ValueError("Tender title is empty")
            nit = g("Tender / NIT number")
            if not nit:
                raise ValueError("Tender / NIT number is empty")
            if nit.lower() in existing or nit.lower() in seen:
                dups.append({"row": i, "name": title, "error": f"Duplicate – NIT number {nit} already exists"})
                continue
            seen.add(nit.lower())
            cid = custs.get(g("Customer").lower())
            if not cid:
                raise ValueError(f"Customer '{g('Customer')}' is not in your customers")
            pid = portals.get(g("Portal").lower()) if g("Portal") else None
            if g("Portal") and not pid:
                raise ValueError(f"Portal '{g('Portal')}' is not in the master")
            cat = cats.get(g("Category").lower()) if g("Category") else None
            if g("Category") and not cat:
                raise ValueError(f"Category '{g('Category')}' is not in the master")
            loc = None
            if g("Location"):
                hit = db.execute(text("SELECT id FROM location_masters WHERE is_active = 1 AND item_type IN ('district','state') AND LOWER(name) = :n "
                                      "ORDER BY item_type = 'district' DESC LIMIT 1"), {"n": g("Location").split(",")[0].strip().lower()}).scalar()
                if not hit:
                    raise ValueError(f"Location '{g('Location')}' is not in the Locations master")
                loc = int(hit)
            val = float(g("Estimated value").replace(",", "")) if g("Estimated value") else None
            emd = float(g("EMD amount").replace(",", "")) if g("EMD amount") else None
            sub = g("Bid submission date (YYYY-MM-DD)")
            if not sub:
                raise ValueError("Bid submission date is required")
            owner = users.get(g("Bid manager email").lower()) if g("Bid manager email") else None
            if g("Bid manager email") and not owner:
                raise ValueError(f"No active user with e-mail {g('Bid manager email')}")
            vid = verts.get(g("Business vertical").lower()) if g("Business vertical") else None
            if g("Business vertical") and not vid:
                raise ValueError(f"Business vertical '{g('Business vertical')}' is not in the master")
            fk = flows_by.get(g("Sales flow").lower()) if g("Sales flow") else None
            if g("Sales flow") and not fk:
                raise ValueError(f"Sales flow '{g('Sales flow')}' is not configured")
            body = BidIn(title=title, nit=nit, customer_id=cid, portal_id=pid, value=val, emd=emd, submit=date.fromisoformat(sub), owner_id=owner,
                         category_id=cat, location_id=loc, vertical_id=vid, flow=fk)
            if dry_run:
                _validate(db, cu, body)
            else:
                create(body, request, db=db, cu=cu)
            created += 1
        except (ValueError, HTTPException) as exc:
            db.rollback()
            errors.append({"row": i, "name": title, "error": exc.detail if isinstance(exc, HTTPException) else str(exc)})
        except Exception as exc:   # pydantic validation of numbers / dates
            db.rollback()
            errors.append({"row": i, "name": title, "error": str(exc).splitlines()[0][:200]})
    log_audit_db(db, cu.id, "tenders", "import", None, get_request_ip(request), f"Tenders import: {created} {'valid' if dry_run else 'created'}, "
                 f"{len(dups)} duplicates, {len(errors)} errors", new_data={"file": file.filename, "dry_run": dry_run}, record_name=file.filename)
    db.commit()
    return {"created": created, "dry_run": dry_run, "duplicates": dups, "errors": errors[:200], "error_count": len(errors), "duplicate_count": len(dups)}


# ─── workflow ─────────────────────────────────────────────────────────────────

class StageIn(BaseModel):
    stage_id: int
    reason: Optional[str] = Field(None, max_length=120)
    comment: Optional[str] = Field(None, max_length=1000)
    checklist: Optional[list[str]] = None


@router.post("/{tender_id}/stage")
def change_stage(tender_id: int, body: StageIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    _need(db, cu, "tenders.update", "move tenders")
    t = S.get_bid(db, cu, tender_id)
    return S.move(db, cu, request, t, body.stage_id, reason=body.reason, comment=body.comment, checklist=body.checklist)


# ─── tender page ──────────────────────────────────────────────────────────────

@router.get("/{tender_id}")
def get_detail(tender_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    d = S.detail(db, cu, S.get_bid(db, cu, tender_id))
    d["company"] = _company(db)
    d["can"] = {"update": user_has_permission(db, cu, "tenders.update"), "delete": user_has_permission(db, cu, "tenders.delete"),
                "documents": user_has_permission(db, cu, "document_management.create"), "workorders": user_has_permission(db, cu, "workorders.create"),
                "manage": S.can_manage(db, cu)}
    return d


@router.get("/{tender_id}/documents")
def documents(tender_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    """Document Hub files linked to this tender (uploads to Document Hub with source Tenders + the tender's own files)."""
    S.get_bid(db, cu, tender_id)
    return {"items": _documents(db, cu, tender_id), "allowed": user_has_permission(db, cu, "document_management.view")}


def _documents(db: Session, cu: User, tender_id: int) -> list[dict[str, Any]]:
    if not user_has_permission(db, cu, "document_management.view"):
        return []
    from app.models.all_models import DocumentFolder
    from app.routers.document_management_router import DOCUMENT_SOURCE_LABELS, _collect_documents, _filter_documents_by_trash_state, _prepare_document_payload
    docs, _ = _collect_documents(db, cu, source_filter="tenders", limit=1000)
    docs = [d for d in docs if int(d.get("record_id") or 0) == tender_id]
    docs = _filter_documents_by_trash_state(db, docs, trash_view=False)
    folders = {f.id: f.name for f in db.query(DocumentFolder).filter(DocumentFolder.id.in_([d.get("folder_id") for d in docs if d.get("folder_id")] or [-1])).all()}
    folder_of = {str(d.get("id")): folders.get(d.get("folder_id")) or DOCUMENT_SOURCE_LABELS.get("tenders", "Tenders") for d in docs}
    cleaned, _ = _prepare_document_payload(db, cu, docs, 500)
    return [{"id": str(d["id"]), "name": d["name"], "folder": folder_of.get(str(d["id"])) or "Tenders", "updated_at": d.get("updated_at"), "url": d.get("url"),
             "type": d.get("doc_type"), "size_kb": d.get("size_kb"), "owner": d.get("owner")} for d in cleaned]


class CorrIn(BaseModel):
    number: Optional[str] = Field(None, max_length=80)
    description: str = Field(..., min_length=1, max_length=5000)
    date: date


@router.post("/{tender_id}/corrigenda", status_code=201)
def add_corrigendum(tender_id: int, body: CorrIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    n = db.query(func.count(BidCorrigendum.id)).filter(BidCorrigendum.tender_id == t.id).scalar() or 0
    number = (body.number or "").strip() or f"Corrigendum {n + 1}"
    if db.query(BidCorrigendum.id).filter(BidCorrigendum.tender_id == t.id, func.lower(BidCorrigendum.number) == number.lower()).first():
        raise HTTPException(409, f"{number} is already recorded")
    c = BidCorrigendum(tender_id=t.id, number=number, description=body.description.strip(), corr_date=body.date, created_by=cu.id)
    db.add(c)
    db.flush()
    S._log(db, cu, request, t, f"{number} recorded: {body.description.strip()[:120]}", {"corrigendum": number, "date": body.date.isoformat()}, action="corrigendum")
    if t.assigned_to and t.assigned_to != cu.id:
        try:
            from app.services.notification_service import upsert_notification
            upsert_notification(db, t.assigned_to, "Corrigendum published", f"{S.ref_of(t)} · {number}: {body.description.strip()[:140]}",
                                module="tenders", record_id=t.id, action="corrigendum", send_email=False)
        except Exception as exc:
            logger.warning("corrigendum notification failed: %s", exc)
    db.commit()
    return {"id": c.id, "number": number}


class CheckIn(BaseModel):
    ok: Optional[bool] = None
    document_id: Optional[str] = Field(None, max_length=40)


@router.patch("/{tender_id}/checklist/{item_id}")
def patch_checklist(tender_id: int, item_id: int, body: CheckIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    """Eligibility (Met / Gap) and mandatory documents (done + linked Document Hub record)."""
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    it = db.query(BidChecklistItem).filter(BidChecklistItem.id == item_id, BidChecklistItem.tender_id == t.id).first()
    if not it:
        raise HTTPException(404, "Checklist item not found")
    before = {"ok": bool(it.ok), "document_id": it.document_id}
    if body.document_id is not None:
        if body.document_id == "":
            it.document_id = it.document_name = None
        else:
            doc = next((d for d in _documents(db, cu, t.id) if d["id"] == body.document_id), None)
            if not doc:
                raise HTTPException(422, "Choose a document linked to this tender in the Document Hub")
            it.document_id, it.document_name = doc["id"], doc["name"][:300]
            if body.ok is None:
                it.ok = True
    if body.ok is not None:
        it.ok = bool(body.ok)
    it.updated_by = cu.id
    after = {"ok": bool(it.ok), "document_id": it.document_id}
    if before != after:
        log_module_action(db=db, user_id=cu.id, module="tenders", action="checklist", record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request),
                          old_data={"item": it.label, **before}, new_data={"item": it.label, **after})
    db.commit()
    return {"id": it.id, "ok": bool(it.ok), "document_id": it.document_id, "document_name": it.document_name}


# ─── Workings (Cost working / BoQ) ────────────────────────────────────────────

class LineIn(BaseModel):
    item: Optional[str] = Field(None, max_length=300)
    product_id: Optional[int] = None
    oem_id: Optional[int] = None
    qty: Optional[float] = None
    rate: Optional[float] = None


def _locked(prof: BidProfile) -> None:
    if prof.price_status in ("pending", "approved"):
        raise HTTPException(409, "The price bid is frozen – " + ("it is awaiting approval" if prof.price_status == "pending" else "it was approved; log a negotiation round to revise it"))


def _prof(db: Session, t: Tender) -> BidProfile:
    profiles, _ = S.sync(db, [t], S.flows(db, include_inactive=True))
    return profiles[t.id]


def _apply_line(db: Session, ln: TenderProduct, body: LineIn, fields: set[str]) -> None:
    if "item" in fields:
        s = (body.item or "").strip()
        if not s:
            raise HTTPException(422, "Item is required")
        ln.product_name = s
    if "product_id" in fields:
        if body.product_id is not None:
            p = db.query(ProductMaster).filter(ProductMaster.id == body.product_id, ProductMaster.is_active == True).first()  # noqa: E712
            if not p:
                raise HTTPException(422, "Choose an active product from Products & Price Books")
            ln.product_id = p.id
            if "item" not in fields or not (body.item or "").strip():
                ln.product_name = p.name
            # Product & Price Books: a catalogue product brings its standard cost (cost working rate) and its
            # Principal / OEM when the line does not set them itself.
            try:
                from sqlalchemy import text as _t
                with db.begin_nested():          # savepoint: a tenant without the catalogue columns only skips the prefill
                    cat = db.execute(_t("SELECT p.std_cost, p.oem_id, o.name AS oem FROM products_master p LEFT JOIN oems o ON o.id = p.oem_id WHERE p.id = :i"),
                                     {"i": p.id}).mappings().first()
            except Exception:
                cat = None
            if cat:
                if "rate" not in fields and not float(ln.unit_price or 0) and cat["std_cost"] is not None:
                    ln.unit_price = float(cat["std_cost"])
                if "oem_id" not in fields and not ln.oem_id and cat["oem_id"]:
                    ln.oem_id, ln.oem_name = cat["oem_id"], cat["oem"]
        else:
            ln.product_id = None
    if "oem_id" in fields:
        if body.oem_id is not None:
            o = db.query(OEM).filter(OEM.id == body.oem_id, OEM.is_active == True, OEM.is_deleted == False).first()  # noqa: E712
            if not o:
                raise HTTPException(422, "Choose an active OEM from Partners & OEM")
            ln.oem_id, ln.oem_name = o.id, o.name
        else:
            ln.oem_id = ln.oem_name = None
    if "qty" in fields:
        q = _num(body.qty, "Qty", 1, 10_000_000, allow_none=False)
        if q != int(q):
            raise HTTPException(422, "Qty must be a whole number")
        ln.quantity = int(q)
    if "rate" in fields:
        ln.unit_price = _num(body.rate, "Rate", 0, None, allow_none=False)
    ln.total_price = round(float(ln.quantity or 0) * float(ln.unit_price or 0) * (1 + float(ln.gst_percent or 0) / 100), 2)


@router.post("/{tender_id}/boq", status_code=201)
def add_line(tender_id: int, body: LineIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    _locked(_prof(db, t))
    order = (db.query(func.max(TenderProduct.sort_order)).filter(TenderProduct.tender_id == t.id, TenderProduct.is_final_boq == True).scalar() or 0) + 1  # noqa: E712
    ln = TenderProduct(tender_id=t.id, product_name="", quantity=1, unit_price=0, gst_percent=0, is_final_boq=True, sort_order=order)
    fields = {k for k, v in body.model_dump(exclude_unset=True).items()}
    if "item" not in fields and "product_id" not in fields:
        raise HTTPException(422, "Item is required")
    _apply_line(db, ln, body, fields | ({"qty"} if body.qty is not None else set()) | ({"rate"} if body.rate is not None else set()))
    if not ln.product_name:
        raise HTTPException(422, "Item is required")
    db.add(ln)
    db.flush()
    log_module_action(db=db, user_id=cu.id, module="tenders", action="boq_add", record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request),
                      new_data={"line": ln.id, "item": ln.product_name, "qty": ln.quantity, "rate": float(ln.unit_price or 0)})
    db.commit()
    return {"id": ln.id}


@router.patch("/{tender_id}/boq/{line_id}")
def patch_line(tender_id: int, line_id: int, body: LineIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    _locked(_prof(db, t))
    ln = db.query(TenderProduct).filter(TenderProduct.id == line_id, TenderProduct.tender_id == t.id, TenderProduct.is_final_boq == True).first()  # noqa: E712
    if not ln:
        raise HTTPException(404, "BoQ line not found")
    before = {"item": ln.product_name, "oem": ln.oem_name, "qty": ln.quantity, "rate": float(ln.unit_price or 0)}
    _apply_line(db, ln, body, set(body.model_dump(exclude_unset=True)))
    after = {"item": ln.product_name, "oem": ln.oem_name, "qty": ln.quantity, "rate": float(ln.unit_price or 0)}
    if before != after:
        log_module_action(db=db, user_id=cu.id, module="tenders", action="boq_update", record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request),
                          old_data={"line": ln.id, **before}, new_data={"line": ln.id, **after})
    db.commit()
    return {"id": ln.id, "amount": round(float(ln.quantity or 0) * float(ln.unit_price or 0), 2)}


@router.delete("/{tender_id}/boq/{line_id}")
def delete_line(tender_id: int, line_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    _locked(_prof(db, t))
    ln = db.query(TenderProduct).filter(TenderProduct.id == line_id, TenderProduct.tender_id == t.id, TenderProduct.is_final_boq == True).first()  # noqa: E712
    if not ln:
        raise HTTPException(404, "BoQ line not found")
    db.execute(text("DELETE FROM tender_product_oems WHERE tender_product_id = :i"), {"i": ln.id})
    db.execute(text("DELETE FROM tender_consignee_items WHERE tender_product_id = :i"), {"i": ln.id})
    log_module_action(db=db, user_id=cu.id, module="tenders", action="boq_delete", record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request),
                      old_data={"line": ln.id, "item": ln.product_name, "qty": ln.quantity, "rate": float(ln.unit_price or 0)})
    db.delete(ln)
    db.commit()
    return {"ok": True}


@router.post("/{tender_id}/boq/copy-products")
def copy_products(tender_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    """Start the cost working from the tender's own product list (the requirement lines captured on the tender)."""
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    _locked(_prof(db, t))
    if S.boq_lines(db, t):
        raise HTTPException(409, "The BoQ already has lines")
    src = db.query(TenderProduct).filter(TenderProduct.tender_id == t.id, TenderProduct.is_final_boq == False).order_by(TenderProduct.sort_order, TenderProduct.id).all()  # noqa: E712
    if not src:
        raise HTTPException(404, "This tender has no product lines to copy")
    for i, p in enumerate(src):
        db.add(TenderProduct(tender_id=t.id, product_id=p.product_id, product_name=p.product_name or (p.work_description or "Item")[:300],
                             quantity=p.quantity or 1, unit_price=p.unit_price if p.unit_price is not None else (p.work_unit_rate or 0),
                             gst_percent=p.gst_percent or 0, oem_id=p.oem_id, oem_name=p.oem_name, is_final_boq=True, sort_order=i + 1,
                             total_price=p.total_price))
    log_module_action(db=db, user_id=cu.id, module="tenders", action="boq_copy", record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request),
                      new_data={"lines": len(src)})
    db.commit()
    return {"copied": len(src)}


@router.post("/{tender_id}/sync-price")
def sync_price(tender_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    """Prototype "Sync to financial bid": store the quoted price (excl. GST) of the saved BoQ and build-up."""
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    prof = _prof(db, t)
    _locked(prof)
    cfg = S.config(db)
    wk = S.wk_tot(S.boq_lines(db, t), *S.pct_of(prof, cfg))
    if wk["price"] <= 0:
        raise HTTPException(422, "Add BoQ lines with quantities and rates first")
    old = float(prof.quoted_price) if prof.quoted_price is not None else None
    prof.quoted_price, prof.synced_at, prof.synced_by = wk["price"], now_ist(), cu.id
    t.bid_amount = wk["price"]
    if prof.pbg_pct is not None or cfg.get("pbg_pct"):
        pbg = float(prof.pbg_pct if prof.pbg_pct is not None else cfg["pbg_pct"])
        t.pbg_amount, t.pbg_required = round(wk["price"] * pbg / 100, 2), bool(pbg)
    S.store_ranking(db, t, wk["price"])
    db.execute(text("UPDATE tenders SET our_bid_amount = :p WHERE id = :i"), {"p": wk["price"], "i": t.id})
    S._log(db, cu, request, t, f"Price synced to financial bid: ₹{wk['price']:,.0f} (excl. GST)", {"old": old, "new": wk["price"], **wk}, action="price_sync")
    db.commit()
    return {"price": wk["price"], "synced_at": prof.synced_at.isoformat()}


# ─── Tech Bid Evaluation ──────────────────────────────────────────────────────

class ScoreIn(BaseModel):
    awarded: Optional[float] = None
    remark: Optional[str] = Field(None, max_length=500)
    clear: bool = False


@router.patch("/{tender_id}/tech/{row_id}")
def patch_score(tender_id: int, row_id: int, body: ScoreIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    r = db.query(BidTechScore).filter(BidTechScore.id == row_id, BidTechScore.tender_id == t.id).first()
    if not r:
        raise HTTPException(404, "Criterion not found")
    before = {"awarded": float(r.awarded) if r.awarded is not None else None, "remark": r.remark}
    sent = body.model_dump(exclude_unset=True)
    if body.clear:
        r.awarded = None
    elif "awarded" in sent:
        r.awarded = _num(body.awarded, f"Awarded marks for {r.criterion}", 0, float(r.max_marks))
    if "remark" in sent:
        r.remark = (body.remark or "").strip() or None
    r.updated_by = cu.id
    after = {"awarded": float(r.awarded) if r.awarded is not None else None, "remark": r.remark}
    if before != after:
        log_module_action(db=db, user_id=cu.id, module="tenders", action="tech_score", record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request),
                          old_data={"criterion": r.criterion, **before}, new_data={"criterion": r.criterion, **after})
    db.commit()
    advanced = S.maybe_auto_advance(db, cu, request, t) if "awarded" in sent else None
    return {"id": r.id, "advanced": advanced}


# ─── Financial ────────────────────────────────────────────────────────────────

class CompIn(BaseModel):
    competitor_id: int
    amount: float = Field(..., gt=0)


@router.post("/{tender_id}/competitors")
def put_competitor(tender_id: int, body: CompIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    """Opened price bid of a competitor (Competitive Intel master) – added or updated."""
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    _check_master(db, Competitor, body.competitor_id, "competitor")
    row = db.query(BidCompetitorPrice).filter(BidCompetitorPrice.tender_id == t.id, BidCompetitorPrice.competitor_id == body.competitor_id).first()
    old = float(row.amount) if row else None
    if row:
        row.amount = body.amount
    else:
        row = BidCompetitorPrice(tender_id=t.id, competitor_id=body.competitor_id, amount=body.amount, created_by=cu.id)
        db.add(row)
    db.flush()
    our, _ = S.our_price(db, t, _prof(db, t), S.config(db))
    S.store_ranking(db, t, our)
    name = db.query(Competitor.name).filter(Competitor.id == body.competitor_id).scalar()
    log_module_action(db=db, user_id=cu.id, module="tenders", action="competitor_price", record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request),
                      old_data={"competitor": name, "amount": old}, new_data={"competitor": name, "amount": body.amount})
    db.commit()
    return {"id": row.id}


@router.delete("/{tender_id}/competitors/{row_id}")
def delete_competitor(tender_id: int, row_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    row = db.query(BidCompetitorPrice).filter(BidCompetitorPrice.id == row_id, BidCompetitorPrice.tender_id == t.id).first()
    if not row:
        raise HTTPException(404, "Competitor bid not found")
    name = db.query(Competitor.name).filter(Competitor.id == row.competitor_id).scalar()
    log_module_action(db=db, user_id=cu.id, module="tenders", action="competitor_price_delete", record_id=t.id, record_name=t.tender_title,
                      ip=get_request_ip(request), old_data={"competitor": name, "amount": float(row.amount)})
    db.delete(row)
    db.flush()
    our, _ = S.our_price(db, t, _prof(db, t), S.config(db))
    S.store_ranking(db, t, our)
    db.commit()
    return {"ok": True}


class RoundIn(BaseModel):
    our_price: float = Field(..., gt=0)
    note: Optional[str] = Field(None, max_length=2000)


@router.post("/{tender_id}/negotiation", status_code=201)
def log_round(tender_id: int, body: RoundIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    n = (db.query(func.max(BidNegotiationRound.round_no)).filter(BidNegotiationRound.tender_id == t.id).scalar() or 0) + 1
    r = BidNegotiationRound(tender_id=t.id, round_no=n, our_price=body.our_price, note=(body.note or "").strip() or None, created_by=cu.id)
    db.add(r)
    db.execute(text("UPDATE tenders SET final_bid_amount = :p WHERE id = :i"), {"p": body.our_price, "i": t.id})
    S._log(db, cu, request, t, f"Negotiation round {n} logged: ₹{body.our_price:,.0f}" + (f" – {r.note[:100]}" if r.note else ""),
           {"round": n, "our_price": body.our_price, "note": r.note}, action="negotiation")
    db.commit()
    return {"round": n}


@router.post("/{tender_id}/freeze")
def freeze(tender_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    """Freeze & send for approval: the synced price bid goes through Approvals (module Tender, action Price bid)."""
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    prof = _prof(db, t)
    if prof.price_status == "pending":
        raise HTTPException(409, "The price bid is already awaiting approval")
    if prof.price_status == "approved":
        raise HTTPException(409, "The price bid is already approved")
    if prof.quoted_price is None or float(prof.quoted_price) <= 0:
        raise HTTPException(422, "Sync the Workings price to the financial bid first")
    from app.services.generic_approval_engine import create_generic_approval_request
    req = create_generic_approval_request(db, tenant_id=getattr(getattr(request.state, "tenant", None), "id", None), requester=cu,
                                          module_key="tender", action_key="price_bid", record_id=t.id)
    approved = (req.status or "").strip().lower() == "approved"
    prof.price_status, prof.price_request_id = ("approved" if approved else "pending"), req.id
    step = next((s for s in sorted(req.steps or [], key=lambda x: x.step_no) if s.step_no == req.current_step_no), None)
    approver = step.approver.full_name if step is not None and getattr(step, "approver", None) else None
    S._log(db, cu, request, t, "Price bid frozen" + (" and approved" if approved else f" – sent for approval{f' ({approver})' if approver else ''}"),
           {"price": float(prof.quoted_price), "approval_request_id": req.id, "status": prof.price_status}, action="price_bid")
    db.commit()
    return {"status": prof.price_status, "approver": approver,
            "message": "Price bid frozen and approved" if approved else f"Price bid frozen and sent for approval to {approver or 'the approver'}"}


# ─── PO & Consignee ───────────────────────────────────────────────────────────

class ConsIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    location_id: Optional[int] = None
    qty: Optional[str] = Field(None, max_length=20)
    contact: Optional[str] = Field(None, max_length=255)
    delivery: Optional[date] = None


_QTY = re.compile(r"^\s*(\d{1,3}(?:\.\d{1,2})?)\s*%?\s*$")


@router.post("/{tender_id}/consignees", status_code=201)
def add_consignee(tender_id: int, body: ConsIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    qty = (body.qty or "").strip()
    if qty:
        m = _QTY.match(qty)
        if not m or not 0 < float(m.group(1)) <= 100:
            raise HTTPException(422, "Qty share must be a percentage between 0 and 100 (e.g. 25%)")
        shares = [r for (r,) in db.execute(text("SELECT qty_share FROM tender_consignees WHERE tender_id = :t"), {"t": t.id}).all()]
        used = sum(float(_QTY.match(s).group(1)) for s in shares if s and _QTY.match(s))
        if used + float(m.group(1)) > 100.0001:
            raise HTTPException(422, f"Qty shares would total {used + float(m.group(1)):g}% – keep them within 100%")
        qty = f"{float(m.group(1)):g}%"
    city = state = None
    if body.location_id is not None:
        r = _location_row(db, body.location_id)
        city, state = (r["name"], r["parent"]) if r["item_type"] == "district" else (None, r["name"])
    c = TenderConsignee(tender_id=t.id, consignee_name=body.name.strip(), city=city, state=state, contact_person=(body.contact or "").strip() or None,
                        delivery_date=body.delivery, created_by=cu.id)
    db.add(c)
    db.flush()
    db.execute(text("UPDATE tender_consignees SET qty_share = :q WHERE id = :i"), {"q": qty or None, "i": c.id})
    t.no_of_consignee = db.query(func.count(TenderConsignee.id)).filter(TenderConsignee.tender_id == t.id).scalar()
    log_module_action(db=db, user_id=cu.id, module="tenders", action="consignee_add", record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request),
                      new_data={"consignee": c.consignee_name, "location": ", ".join(x for x in (city, state) if x), "qty": qty, "delivery": body.delivery.isoformat() if body.delivery else None})
    db.commit()
    return {"id": c.id}


@router.delete("/{tender_id}/consignees/{cons_id}")
def delete_consignee(tender_id: int, cons_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    c = db.query(TenderConsignee).filter(TenderConsignee.id == cons_id, TenderConsignee.tender_id == t.id).first()
    if not c:
        raise HTTPException(404, "Consignee not found")
    db.execute(text("DELETE FROM tender_consignee_items WHERE consignee_id = :i"), {"i": c.id})
    log_module_action(db=db, user_id=cu.id, module="tenders", action="consignee_delete", record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request),
                      old_data={"consignee": c.consignee_name})
    db.delete(c)
    db.flush()
    t.no_of_consignee = db.query(func.count(TenderConsignee.id)).filter(TenderConsignee.tender_id == t.id).scalar()
    db.commit()
    return {"ok": True}


class FeeItemIn(BaseModel):
    label: Optional[str] = None
    amount: Optional[float] = None
    mode: Optional[str] = None
    stakeholder: Optional[str] = None
    cutoff: Optional[date] = None
    status: Optional[str] = None
    document_id: Optional[str] = Field(None, max_length=40)


@router.post("/{tender_id}/fee-items", status_code=201)
def add_fee_item(tender_id: int, body: FeeItemIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    """Tender Details → Fee & document checklist: a free-form row for tender fee / EMD / PBG / any other collection,
    with its own amount, payment mode, stakeholder, cut-off date and status. Bookkeeping only – it never creates or
    links a Guarantees & Deposits (EMDBG) instrument."""
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    label = (body.label or "").strip()
    if not label:
        raise HTTPException(422, "Type / label is required")
    if body.mode and body.mode not in ("DD", "BG", "Online", "NEFT"):
        raise HTTPException(422, "Payment mode must be DD, BG, Online or NEFT")
    if body.status and body.status not in ("pending", "paid", "not_due"):
        raise HTTPException(422, "Status must be pending, paid or not_due")
    order = (db.query(func.max(BidFeeItem.position)).filter(BidFeeItem.tender_id == t.id).scalar() or 0) + 1
    f = BidFeeItem(tender_id=t.id, label=label[:200], amount=body.amount, payment_mode=body.mode, stakeholder=(body.stakeholder or "").strip()[:200] or None,
                   cutoff_date=body.cutoff, status=body.status or "pending", position=order, updated_by=cu.id)
    db.add(f)
    db.flush()
    log_module_action(db=db, user_id=cu.id, module="tenders", action="fee_item_add", record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request),
                      new_data={"label": f.label, "amount": float(f.amount) if f.amount is not None else None})
    db.commit()
    return {"id": f.id}


@router.patch("/{tender_id}/fee-items/{item_id}")
def patch_fee_item(tender_id: int, item_id: int, body: FeeItemIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    f = db.query(BidFeeItem).filter(BidFeeItem.id == item_id, BidFeeItem.tender_id == t.id).first()
    if not f:
        raise HTTPException(404, "Fee / document row not found")
    fields = body.model_dump(exclude_unset=True)
    before = {"label": f.label, "amount": float(f.amount) if f.amount is not None else None, "status": f.status}
    if "label" in fields:
        s = (fields["label"] or "").strip()
        if not s:
            raise HTTPException(422, "Type / label is required")
        f.label = s[:200]
    if "amount" in fields:
        f.amount = fields["amount"]
    if "mode" in fields:
        if fields["mode"] and fields["mode"] not in ("DD", "BG", "Online", "NEFT"):
            raise HTTPException(422, "Payment mode must be DD, BG, Online or NEFT")
        f.payment_mode = fields["mode"]
    if "stakeholder" in fields:
        f.stakeholder = (fields["stakeholder"] or "").strip()[:200] or None
    if "cutoff" in fields:
        f.cutoff_date = fields["cutoff"]
    if "status" in fields:
        if fields["status"] and fields["status"] not in ("pending", "paid", "not_due"):
            raise HTTPException(422, "Status must be pending, paid or not_due")
        f.status = fields["status"] or "pending"
    if "document_id" in fields:
        if not fields["document_id"]:
            f.document_id = f.document_name = None
        else:
            doc = next((d for d in _documents(db, cu, t.id) if d["id"] == fields["document_id"]), None)
            if not doc:
                raise HTTPException(422, "Choose a document linked to this tender in the Document Hub")
            f.document_id, f.document_name = doc["id"], doc["name"][:300]
            if "status" not in fields and f.status == "pending":
                f.status = "paid"
    f.updated_by = cu.id
    after = {"label": f.label, "amount": float(f.amount) if f.amount is not None else None, "status": f.status}
    if before != after:
        log_module_action(db=db, user_id=cu.id, module="tenders", action="fee_item_update", record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request),
                          old_data=before, new_data=after)
    db.commit()
    return {"id": f.id}


@router.delete("/{tender_id}/fee-items/{item_id}")
def delete_fee_item(tender_id: int, item_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    f = db.query(BidFeeItem).filter(BidFeeItem.id == item_id, BidFeeItem.tender_id == t.id).first()
    if not f:
        raise HTTPException(404, "Fee / document row not found")
    log_module_action(db=db, user_id=cu.id, module="tenders", action="fee_item_delete", record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request),
                      old_data={"label": f.label})
    db.delete(f)
    db.commit()
    return {"ok": True}


class PenaltyIn(BaseModel):
    description: Optional[str] = None
    amount: Optional[str] = None
    remarks: Optional[str] = None


@router.post("/{tender_id}/penalty", status_code=201)
def add_penalty(tender_id: int, body: PenaltyIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    """Specific Tender Details → Penalty Clause: free-form rows, each with a clause description and penalty figure
    kept as text (e.g. "0.5% per week, max 10%")."""
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    desc = (body.description or "").strip()
    if not desc:
        raise HTTPException(422, "Description is required")
    order = (db.query(func.max(BidPenaltyClause.position)).filter(BidPenaltyClause.tender_id == t.id).scalar() or 0) + 1
    p = BidPenaltyClause(tender_id=t.id, description=desc, penalty_amount=(body.amount or "").strip()[:200] or None,
                         remarks=(body.remarks or "").strip()[:500] or None, position=order, updated_by=cu.id)
    db.add(p)
    db.flush()
    log_module_action(db=db, user_id=cu.id, module="tenders", action="penalty_add", record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request), new_data={"description": p.description})
    db.commit()
    return {"id": p.id}


@router.patch("/{tender_id}/penalty/{item_id}")
def patch_penalty(tender_id: int, item_id: int, body: PenaltyIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    p = db.query(BidPenaltyClause).filter(BidPenaltyClause.id == item_id, BidPenaltyClause.tender_id == t.id).first()
    if not p:
        raise HTTPException(404, "Penalty clause not found")
    fields = body.model_dump(exclude_unset=True)
    if "description" in fields:
        s = (fields["description"] or "").strip()
        if not s:
            raise HTTPException(422, "Description is required")
        p.description = s
    if "amount" in fields:
        p.penalty_amount = (fields["amount"] or "").strip()[:200] or None
    if "remarks" in fields:
        p.remarks = (fields["remarks"] or "").strip()[:500] or None
    p.updated_by = cu.id
    db.commit()
    return {"id": p.id}


@router.delete("/{tender_id}/penalty/{item_id}")
def delete_penalty(tender_id: int, item_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    p = db.query(BidPenaltyClause).filter(BidPenaltyClause.id == item_id, BidPenaltyClause.tender_id == t.id).first()
    if not p:
        raise HTTPException(404, "Penalty clause not found")
    log_module_action(db=db, user_id=cu.id, module="tenders", action="penalty_delete", record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request), old_data={"description": p.description})
    db.delete(p)
    db.commit()
    return {"ok": True}


class MilestoneIn(BaseModel):
    milestone: Optional[str] = None
    description: Optional[str] = None
    remarks: Optional[str] = None


@router.post("/{tender_id}/milestones", status_code=201)
def add_milestone(tender_id: int, body: MilestoneIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    """Specific Tender Details → Payment Milestone: free-form rows."""
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    ms = (body.milestone or "").strip()
    if not ms:
        raise HTTPException(422, "Milestone is required")
    order = (db.query(func.max(BidPaymentMilestone.position)).filter(BidPaymentMilestone.tender_id == t.id).scalar() or 0) + 1
    m = BidPaymentMilestone(tender_id=t.id, milestone=ms[:300], description=(body.description or "").strip() or None,
                            remarks=(body.remarks or "").strip()[:500] or None, position=order, updated_by=cu.id)
    db.add(m)
    db.flush()
    log_module_action(db=db, user_id=cu.id, module="tenders", action="milestone_add", record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request), new_data={"milestone": m.milestone})
    db.commit()
    return {"id": m.id}


@router.patch("/{tender_id}/milestones/{item_id}")
def patch_milestone(tender_id: int, item_id: int, body: MilestoneIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    m = db.query(BidPaymentMilestone).filter(BidPaymentMilestone.id == item_id, BidPaymentMilestone.tender_id == t.id).first()
    if not m:
        raise HTTPException(404, "Payment milestone not found")
    fields = body.model_dump(exclude_unset=True)
    if "milestone" in fields:
        s = (fields["milestone"] or "").strip()
        if not s:
            raise HTTPException(422, "Milestone is required")
        m.milestone = s[:300]
    if "description" in fields:
        m.description = (fields["description"] or "").strip() or None
    if "remarks" in fields:
        m.remarks = (fields["remarks"] or "").strip()[:500] or None
    m.updated_by = cu.id
    db.commit()
    return {"id": m.id}


@router.delete("/{tender_id}/milestones/{item_id}")
def delete_milestone(tender_id: int, item_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    m = db.query(BidPaymentMilestone).filter(BidPaymentMilestone.id == item_id, BidPaymentMilestone.tender_id == t.id).first()
    if not m:
        raise HTTPException(404, "Payment milestone not found")
    log_module_action(db=db, user_id=cu.id, module="tenders", action="milestone_delete", record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request), old_data={"milestone": m.milestone})
    db.delete(m)
    db.commit()
    return {"ok": True}


@router.post("/{tender_id}/work-order", status_code=201)
async def create_work_order(tender_id: int, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    """Prototype tenderWO(): Won-stage tenders become a work order in Orders & Projects (its own create path –
    numbering, permissions, events and the tender back-link)."""
    from app.routers.workorder_router import create_workorder
    _need(db, cu, "tenders.update", "edit tenders")
    t = S.get_bid(db, cu, tender_id)
    _, cur = S.sync(db, [t], S.flows(db, include_inactive=True))
    if cur[t.id]["kind"] != "won":
        raise HTTPException(400, "A work order can be created once the tender reaches the Won stage")
    if t.wrk_order_id:
        raise HTTPException(409, f"Work order {t.wrk_order_id} already exists for this tender")
    if not (t.po_num or "").strip():
        raise HTTPException(422, "Enter the PO number first")
    prof = _prof(db, t)
    cons = db.query(func.count(TenderConsignee.id)).filter(TenderConsignee.tender_id == t.id).scalar() or None
    po_value = float(t.po_value) if t.po_value is not None else float(t.est_value or 0)
    res = await create_workorder(
        request, po_doc_file=None, wrk_order_id=None, wo_type="Supply", customer_name=t.customer_name, tender_id=t.id, lead_id=None,
        po_number=t.po_num, po_date=t.po_date.isoformat() if t.po_date else None, po_value=po_value, wo_value=po_value,
        project_title=(t.tender_title or "")[:300], scope_of_work=t.sow, delivery_date=None, installation_date=None, site_location=None,
        site_engineer=None, site_engineer_phone=None, advance_percent=0, retention_percent=0, payment_terms=t.pmnt_terms or None, warranty_months=12,
        no_of_consignee=cons, custom_data=json.dumps({"delivery_period": prof.delivery_period, "liquidated_damages": prof.ld_terms}) if (prof.delivery_period or prof.ld_terms) else None,
        db=db, cu=cu)
    db.refresh(t)
    log_module_action(db=db, user_id=cu.id, module="tenders", action="work_order", record_id=t.id, record_name=t.tender_title, ip=get_request_ip(request),
                      new_data={"wo_number": res.get("wo_number"), "po_number": t.po_num, "po_value": po_value})
    db.commit()
    return {"wo_number": res.get("wo_number"), "wo_id": res.get("wo_id")}


# ─── configuration (Pipelines & Stages · Bids & Tenders settings) ─────────────

@router.get("/config/settings")
def get_config(db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    """Bids & Tenders settings and the tender & bid flows (Process Designer) with stage usage counts."""
    fl = S.flows(db, include_inactive=True)
    counts = dict(db.execute(text("SELECT stage_id, COUNT(*) FROM workflow_record_stages GROUP BY stage_id")).all())
    for f in fl:
        for st in f["stages"]:
            st["tenders"] = int(counts.get(st["id"], 0))
        f["tenders"] = sum(st["tenders"] for st in f["stages"])
    return {"settings": S.config(db), "flows": fl, "board": S.board_stages(fl),
            "presets": [{"key": k, "name": n, "stages": [x.split("|")[0] for x in specs]} for k, n, specs in S.PRESETS],
            "can_configure": user_has_permission(db, cu, "settings.manage")}


@router.put("/config/settings")
def put_config(body: dict[str, Any], request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    _need(db, cu, "settings.manage", "configure Bids & Tenders")
    before = S.config(db)
    cfg = S.save_config(db, cu, body or {})
    log_audit_db(db, cu.id, "tenders", "settings_update", None, get_request_ip(request), "Bids & Tenders settings updated", old_data=before, new_data=cfg,
                 record_name=S.CONFIG_KEY)
    db.commit()
    return cfg


class StageCfg(BaseModel):
    id: Optional[int] = None
    name: str = Field(..., min_length=1, max_length=150)
    kind: Literal["open", "won", "lost"] = "open"
    sla: int = Field(0, ge=0, le=365)
    gate: Literal["None", "Approval", "Checklist"] = "None"
    owner_role: Optional[str] = Field(None, max_length=100)
    checklist: Optional[list[str]] = None


class FlowCfg(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    default: Optional[bool] = None
    active: Optional[bool] = None
    stages: Optional[list[StageCfg]] = None


def _flow_row(db: Session, key: str):
    from app.models.bids import BidFlow
    f = db.query(BidFlow).filter(BidFlow.workflow == key).first()
    if not f:
        raise HTTPException(404, "Flow not found")
    return f


@router.put("/config/flows/{key}")
def put_flow(key: str, body: FlowCfg, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    """Edit a flow: stages (in place – SLA, gates, owner roles, checklists), name, default, active."""
    from app.models.bids import BidFlow
    _need(db, cu, "settings.manage", "configure tender flows")
    f = _flow_row(db, key)
    before = S.flow_map(S.flows(db, include_inactive=True)).get(key)
    if body.stages is not None:
        S.save_stages(db, key, [x.model_dump() for x in body.stages])
    if body.name is not None:
        f.name = body.name.strip()
    if body.active is not None:
        if not body.active and f.is_default:
            raise HTTPException(409, "The default flow can't be switched off – make another flow the default first")
        f.is_active = bool(body.active)
    if body.default:
        db.query(BidFlow).filter(BidFlow.workflow != key).update({BidFlow.is_default: False})
        f.is_default, f.is_active = True, True
    log_audit_db(db, cu.id, "tenders", "flow_update", None, get_request_ip(request), f"Tender flow {f.name} updated",
                 old_data={"name": before["name"] if before else None, "stages": [x["name"] for x in (before or {}).get("stages", [])]},
                 new_data=body.model_dump(exclude_none=True), record_name=key)
    db.commit()
    return S.flow_map(S.flows(db, include_inactive=True)).get(key)


class NewFlowCfg(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    preset: Optional[str] = None          # a preset key (prototype STDFLOW / WFD) …
    copy_of: Optional[str] = None         # … or an existing flow to copy
    default: bool = False


@router.post("/config/flows", status_code=201)
def post_flow(body: NewFlowCfg, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    """Prototype "Add flow": start from a preset, a copy of another flow or a blank three-stage flow."""
    _need(db, cu, "settings.manage", "configure tender flows")
    if body.preset:
        st = S.preset_stages(body.preset)
    elif body.copy_of:
        src = S.flow_map(S.flows(db, include_inactive=True)).get(body.copy_of)
        if not src:
            raise HTTPException(404, "Flow to copy not found")
        st = [{"name": x["name"], "kind": x["kind"], "sla_days": x["sla"], "gate": x["gate"], "owner_role": x["owner_role"], "checklist": x["checklist"] or None}
              for x in src["stages"]]
    else:
        st = S._with_outcomes(["Stage 1|3", "Stage 2|5", "Stage 3|7"])
    key = S.create_flow(db, body.name.strip(), st, body.default)
    log_audit_db(db, cu.id, "tenders", "flow_create", None, get_request_ip(request), f"Tender flow {body.name} created", new_data=body.model_dump(), record_name=key)
    db.commit()
    return S.flow_map(S.flows(db, include_inactive=True)).get(key)


@router.delete("/config/flows/{key}")
def delete_flow(key: str, request: Request, move_to: Optional[str] = None, db: Session = Depends(get_tenant_db), cu: User = Depends(bid_user)):
    """Delete a flow; its tenders move to another flow (same-named stage, else the first stage / same outcome)."""
    _need(db, cu, "settings.manage", "configure tender flows")
    f = _flow_row(db, key)
    if f.is_default:
        raise HTTPException(409, "The default flow can't be deleted – make another flow the default first")
    fl = S.flows(db, include_inactive=True)
    target = S.flow_map(fl).get(move_to or "") or S.default_flow([x for x in fl if x["key"] != key])
    if not target or target["key"] == key:
        raise HTTPException(422, "Choose the flow its tenders move to")
    if db.query(BidProfile.tender_id).filter(BidProfile.flow == key, BidProfile.pending_stage_id.isnot(None)).first():
        raise HTTPException(409, "A tender on this flow is waiting for a stage approval – decide it first")
    tids = [r[0] for r in db.execute(text("SELECT record_id FROM workflow_record_stages WHERE workflow = :w"), {"w": key}).all()]
    tenders = db.query(Tender).filter(Tender.id.in_(tids)).all() if tids else []
    profiles, cur = S.sync(db, tenders, fl)
    for t in tenders:
        S.set_flow(db, t, profiles[t.id], fl, cur[t.id], target["key"])
    db.execute(text("DELETE FROM workflow_stages WHERE workflow = :w"), {"w": key})
    db.execute(text("DELETE FROM workflow_definitions WHERE workflow = :w"), {"w": key})
    db.delete(f)
    log_audit_db(db, cu.id, "tenders", "flow_delete", None, get_request_ip(request), f"Tender flow {f.name} deleted – {len(tenders)} tender(s) moved to {target['name']}",
                 old_data={"flow": key}, new_data={"moved_to": target["key"], "tenders": len(tenders)}, record_name=key)
    db.commit()
    return {"ok": True, "moved": len(tenders), "to": target["key"]}
