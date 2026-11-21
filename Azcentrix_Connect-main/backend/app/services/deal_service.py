"""Deals (prototype v17 · Sales → Deals): pipelines & stages, stage engine, list rows and the record drawer.

* A deal is a ``leads`` row in the opportunity part of the lifecycle (lead_router._opportunity_clause) – plus deals
  that were lost (status Lost with an opportunity reference). Permissions / data scope: opportunities.*.
* Pipelines & Stages: ``deal_pipelines`` + the shared tenant workflow tables (workflow_definitions, workflow_stages,
  workflow_record_stages). A tenant without deal pipelines gets the prototype defaults once (Tender / Quotation with
  their stages, SLAs, gates and win probabilities); after that the configured stages are always read from the DB.
* Lead status stays the source of truth for outcomes the rest of the app relies on: Converted (tender / quotation
  created) ⇒ the pipeline's won stage, Lost ⇒ its lost stage. Open stages, close date, EMD flag, SLA clock and lost
  reason are kept in deal_profiles / workflow_record_stages.
"""
from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import HTTPException, Request
from sqlalchemy import and_, bindparam, false, or_, text
from sqlalchemy.orm import Session

from app.core.timezone import now_ist, today_ist
from app.dependencies import get_request_ip, user_has_permission
from app.models.all_models import ActivityLog, FormField, Lead, LeadSource, User
from app.models.deals import DEAL_TABLES, DealPipeline, DealProfile
from app.models.lead360 import LeadNote

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()

# Prototype v17 WF.oppT / WF.oppQ: name | kind | SLA days | gate | owner | win %
DEFAULT_PIPELINES = [
    ("deal_tender", "Tender", "Tender", "tender", [
        ("Qualification", "open", 3, "None", None, 15), ("Tender Identified", "open", 2, "None", None, 30),
        ("Bidding", "open", 15, "None", None, 45), ("Evaluation", "open", 20, "None", None, 60),
        ("Negotiation", "open", 7, "Approval", "Sales Head", 75), ("Won", "won", 0, "None", None, 100), ("Lost", "lost", 0, "None", None, 0)]),
    ("deal_quotation", "Quotation", "Quote", "quotation", [
        ("Enquiry Received", "open", 1, "None", None, 15), ("Quotation Prepared", "open", 3, "None", None, 30),
        ("Quote Submitted", "open", 2, "None", None, 45), ("Negotiation", "open", 7, "None", None, 60),
        ("PO Awaited", "open", 10, "None", None, 75), ("Won", "won", 0, "None", None, 100), ("Lost", "lost", 0, "None", None, 0)]),
]
GATES = ("None", "Approval", "Checklist")
KINDS = ("open", "won", "lost")
DESTINATIONS = ("tender", "quotation")


# ─── schema + default pipelines ───────────────────────────────────────────────

def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        from app.services.platform_workflow_templates import TENANT_DDL
        from app.models.lead360 import LEAD360_TABLES
        for ddl in TENANT_DDL:
            db.execute(text(ddl))
        db.execute(text("ALTER TABLE workflow_stages ADD COLUMN IF NOT EXISTS probability INT NULL"))
        db.commit()
        bind = db.get_bind()
        for t in LEAD360_TABLES + DEAL_TABLES:
            t.create(bind=bind, checkfirst=True)
        db.commit()
        if not db.query(DealPipeline.workflow).first():
            for order, (key, name, label, dest, stages) in enumerate(DEFAULT_PIPELINES):
                if db.execute(text("SELECT 1 FROM workflow_definitions WHERE workflow = :w"), {"w": key}).first():
                    continue
                _write_stages(db, key, 1, [{"name": n, "kind": k, "sla_days": sla, "gate": g, "owner_role": o, "checklist": None, "probability": p}
                                           for n, k, sla, g, o, p in stages], label=name, insert_def=True)
                db.add(DealPipeline(workflow=key, name=name, label=label, destination=dest, sort_order=order, is_active=True))
            db.commit()
        _READY.add(slug)


def ensure_schema_all_tenants() -> None:
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant
    m = MasterSessionLocal()
    try:
        slugs = [t.slug for t in m.query(Tenant).all()]
    finally:
        m.close()
    for slug in slugs:
        try:
            db = get_tenant_session(slug)
        except Exception as exc:
            logger.warning("deals schema: tenant %s unavailable: %s", slug, exc)
            continue
        try:
            db.info["tenant_slug"] = slug
            ensure_schema(db)
        except Exception as exc:
            logger.warning("deals schema for %s failed: %s", slug, exc)
            db.rollback()
        finally:
            db.close()


def _write_stages(db: Session, workflow: str, revision: int, stages: list[dict], *, label: str, insert_def: bool) -> None:
    if insert_def:
        db.execute(text("INSERT INTO workflow_definitions (workflow, revision, template_key, template_name, applied_by, applied_at) "
                        "VALUES (:w, :r, 'deal-default', :n, 'Deals defaults', :now)"), {"w": workflow, "r": revision, "n": label, "now": now_ist()})
    for i, s in enumerate(stages):
        db.execute(text("INSERT INTO workflow_stages (workflow, revision, position, name, kind, sla_days, gate, owner_role, checklist, probability) "
                        "VALUES (:w, :r, :p, :n, :k, :sla, :g, :o, :c, :prob)"),
                   {"w": workflow, "r": revision, "p": i, "n": s["name"], "k": s["kind"], "sla": int(s.get("sla_days") or 0), "g": s.get("gate") or "None",
                    "o": s.get("owner_role") or None, "c": json.dumps(s["checklist"]) if s.get("checklist") else None, "prob": s.get("probability")})


# ─── pipelines ────────────────────────────────────────────────────────────────

def _prob(s: dict, opens: list[dict]) -> int:
    if s.get("probability") is not None:
        return int(s["probability"])
    if s["kind"] == "won":
        return 100
    if s["kind"] == "lost":
        return 0
    i = next((n for n, x in enumerate(opens) if x["id"] == s["id"]), 0)
    return round((i + 1) * 100 / (len(opens) + 1))


def pipelines(db: Session, include_inactive: bool = False) -> list[dict[str, Any]]:
    q = db.query(DealPipeline)
    if not include_inactive:
        q = q.filter(DealPipeline.is_active == True)
    rows = q.order_by(DealPipeline.sort_order, DealPipeline.workflow).all()
    if not rows:
        return []
    keys = [p.workflow for p in rows]
    revs = dict(db.execute(text("SELECT workflow, revision FROM workflow_definitions WHERE workflow IN :w").bindparams(
        bindparam("w", expanding=True)), {"w": keys}).all())
    stages = db.execute(text("SELECT s.id, s.workflow, s.revision, s.position, s.name, s.kind, s.sla_days, s.gate, s.owner_role, s.checklist, s.probability "
                             "FROM workflow_stages s WHERE s.workflow IN :w ORDER BY s.workflow, s.position").bindparams(
        bindparam("w", expanding=True)), {"w": keys}).mappings().all()
    by: dict[str, list[dict]] = {k: [] for k in keys}
    for s in stages:
        if revs.get(s["workflow"]) == s["revision"]:
            cl = s["checklist"]
            if isinstance(cl, str):
                try:
                    cl = json.loads(cl)
                except ValueError:
                    cl = None
            by[s["workflow"]].append({"id": s["id"], "name": s["name"], "kind": s["kind"], "sla": int(s["sla_days"] or 0), "gate": s["gate"] or "None",
                                      "owner_role": s["owner_role"], "checklist": cl or [], "probability": s["probability"], "position": s["position"]})
    out = []
    for p in rows:
        st = by.get(p.workflow, [])
        opens = [s for s in st if s["kind"] == "open"]
        ordered = opens + [s for s in st if s["kind"] == "won"] + [s for s in st if s["kind"] == "lost"]
        for s in ordered:
            s["prob"] = _prob(s, opens)
        out.append({"key": p.workflow, "name": p.name, "label": p.label, "destination": p.destination, "active": bool(p.is_active), "stages": ordered})
    return out


def pipeline_by_key(pipes: list[dict]) -> dict[str, dict]:
    return {p["key"]: p for p in pipes}


def default_pipeline(pipes: list[dict], destination: Optional[str]) -> Optional[dict]:
    return next((p for p in pipes if p["destination"] == destination), None) or (pipes[0] if pipes else None)


def save_pipeline(db: Session, key: str, stages: list[dict], name: Optional[str], label: Optional[str], destination: Optional[str], active: Optional[bool]) -> None:
    """Pipelines & Stages configuration: update a pipeline's stages in place (stage ids – and the deals on them – are
    kept), add new ones, and remove stages that hold no deals."""
    pipe = db.query(DealPipeline).filter(DealPipeline.workflow == key).first()
    if not pipe:
        raise HTTPException(404, "Pipeline not found")
    clean = []
    for s in stages:
        nm = str(s.get("name") or "").strip()
        if not nm:
            raise HTTPException(422, "Every stage needs a name")
        kind = s.get("kind") or "open"
        gate = s.get("gate") or "None"
        if kind not in KINDS or gate not in GATES:
            raise HTTPException(422, f"Invalid stage settings for {nm}")
        prob = s.get("probability")
        if prob is not None and not (0 <= int(prob) <= 100):
            raise HTTPException(422, f"Win % of {nm} must be 0–100")
        cl = [str(x).strip() for x in (s.get("checklist") or []) if str(x).strip()]
        if gate == "Checklist" and not cl:
            raise HTTPException(422, f"{nm}: a checklist gate needs at least one item")
        clean.append({**s, "name": nm, "kind": kind, "gate": gate, "checklist": cl or None, "probability": None if prob is None else int(prob)})
    names = [s["name"].lower() for s in clean]
    if len(set(names)) != len(names):
        raise HTTPException(422, "Stage names must be unique")
    kinds = [s["kind"] for s in clean]
    if kinds.count("won") != 1 or kinds.count("lost") != 1 or not kinds.count("open"):
        raise HTTPException(422, "A pipeline needs open stages plus exactly one Won and one Lost stage")
    clean = [s for s in clean if s["kind"] == "open"] + [s for s in clean if s["kind"] == "won"] + [s for s in clean if s["kind"] == "lost"]
    rev = db.execute(text("SELECT revision FROM workflow_definitions WHERE workflow = :w FOR UPDATE"), {"w": key}).scalar()
    current = {r[0] for r in db.execute(text("SELECT id FROM workflow_stages WHERE workflow = :w AND revision = :r"), {"w": key, "r": rev}).all()}
    keep = {int(s["id"]) for s in clean if s.get("id") and int(s["id"]) in current}
    gone = current - keep
    if gone:
        used = db.execute(text("SELECT COUNT(*) FROM workflow_record_stages WHERE workflow = :w AND stage_id IN :ids").bindparams(
            bindparam("ids", expanding=True)), {"w": key, "ids": list(gone)}).scalar()
        if used:
            raise HTTPException(409, f"{used} deal(s) are on stages you removed – move them first")
        db.execute(text("DELETE FROM workflow_stages WHERE id IN :ids").bindparams(bindparam("ids", expanding=True)), {"ids": list(gone)})
    db.execute(text("UPDATE workflow_stages SET position = position + 1000 WHERE workflow = :w AND revision = :r"), {"w": key, "r": rev})
    for i, s in enumerate(clean):
        params = {"w": key, "r": rev, "p": i, "n": s["name"], "k": s["kind"], "sla": int(s.get("sla") or s.get("sla_days") or 0), "g": s["gate"],
                  "o": s.get("owner_role") or None, "c": json.dumps(s["checklist"]) if s["checklist"] else None, "prob": s["probability"]}
        if s.get("id") and int(s["id"]) in keep:
            db.execute(text("UPDATE workflow_stages SET position=:p, name=:n, kind=:k, sla_days=:sla, gate=:g, owner_role=:o, checklist=:c, probability=:prob "
                            "WHERE id = :id"), {**params, "id": int(s["id"])})
        else:
            db.execute(text("INSERT INTO workflow_stages (workflow, revision, position, name, kind, sla_days, gate, owner_role, checklist, probability) "
                            "VALUES (:w, :r, :p, :n, :k, :sla, :g, :o, :c, :prob)"), params)
    if name is not None:
        pipe.name = name.strip() or pipe.name
    if label is not None:
        pipe.label = label.strip() or pipe.label
    if destination is not None:
        if destination not in DESTINATIONS:
            raise HTTPException(422, "Destination must be tender or quotation")
        pipe.destination = destination
    if active is not None:
        pipe.is_active = bool(active)


def create_pipeline(db: Session, key: str, name: str, label: str, destination: str, stages: list[dict]) -> None:
    if db.query(DealPipeline.workflow).filter(DealPipeline.workflow == key).first() or \
            db.execute(text("SELECT 1 FROM workflow_definitions WHERE workflow = :w"), {"w": key}).first():
        raise HTTPException(409, "A pipeline with this key already exists")
    if destination not in DESTINATIONS:
        raise HTTPException(422, "Destination must be tender or quotation")
    order = (db.execute(text("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM deal_pipelines")).scalar() or 1)
    db.add(DealPipeline(workflow=key, name=name, label=label, destination=destination, sort_order=order, is_active=True))
    db.flush()
    _write_stages(db, key, 1, [{"name": "_tmp", "kind": "open"}, {"name": "_won", "kind": "won"}, {"name": "_lost", "kind": "lost"}], label=name, insert_def=True)
    db.flush()
    rows = db.execute(text("SELECT id, kind FROM workflow_stages WHERE workflow = :w"), {"w": key}).all()
    ids = {k: i for i, k in rows}
    stages = [dict(s) for s in stages]
    for s in stages:   # reuse the placeholder rows for the first open / won / lost stage
        if s.get("kind", "open") in ids:
            s["id"] = ids.pop(s.get("kind", "open"))
    save_pipeline(db, key, stages, None, None, None, None)


# ─── deal records ─────────────────────────────────────────────────────────────

def deal_clause():
    from app.routers.lead_router import _opportunity_clause
    return or_(_opportunity_clause(), and_(Lead.status == "Lost", Lead.opportunity_ref_id.isnot(None)))


def deal_query(db: Session, cu: User):
    from app.routers.lead_router import _module_scope_clause
    q = db.query(Lead).filter(Lead.is_deleted == False, deal_clause())
    if not user_has_permission(db, cu, "opportunities.view"):
        return q.filter(false())
    return q.filter(_module_scope_clause(db, cu, "opportunity"))


def get_deal(db: Session, cu: User, deal_id: int) -> Lead:
    lead = deal_query(db, cu).filter(Lead.id == deal_id).first()
    if not lead:
        raise HTTPException(404, "Deal not found")
    return lead


def sync(db: Session, leads: list[Lead], pipes: list[dict]) -> tuple[dict[int, DealProfile], dict[int, dict]]:
    """Every deal gets a profile and a stage on its pipeline; terminal lead statuses keep the stage in step."""
    if not leads or not pipes:
        return {}, {}
    pk = pipeline_by_key(pipes)
    ids = [l.id for l in leads]
    profiles = {p.lead_id: p for p in db.query(DealProfile).filter(DealProfile.lead_id.in_(ids)).all()}
    maps = {r[0]: (r[1], r[2]) for r in db.execute(text("SELECT record_id, workflow, stage_id FROM workflow_record_stages WHERE record_id IN :ids AND workflow LIKE 'deal%'")
                                                   .bindparams(bindparam("ids", expanding=True)), {"ids": ids}).all()}
    stage_by_id = {s["id"]: (p["key"], s) for p in pipes for s in p["stages"]}
    out: dict[int, dict] = {}
    changed = False
    for l in leads:
        prof = profiles.get(l.id)
        if prof is None:
            pipe = default_pipeline(pipes, l.conversion_target or "tender")
            prof = DealProfile(lead_id=l.id, pipeline=pipe["key"], emd_required=False, stage_entered_at=l.opportunity_created_at or l.created_at)
            db.add(prof)
            profiles[l.id] = prof
            changed = True
        pipe = pk.get(prof.pipeline)
        if pipe is None:                                 # pipeline switched off / removed: keep the deal readable
            pipe = default_pipeline(pipes, l.conversion_target or "tender")
        cur = maps.get(l.id)
        cur_stage = stage_by_id.get(cur[1])[1] if cur and cur[1] in stage_by_id and cur[0] == pipe["key"] else None
        want = cur_stage
        won = next(s for s in pipe["stages"] if s["kind"] == "won")
        lost = next(s for s in pipe["stages"] if s["kind"] == "lost")
        first = next(s for s in pipe["stages"] if s["kind"] == "open")
        if l.status == "Converted":
            want = won
        elif l.status == "Lost":
            want = lost
        elif cur_stage is None or cur_stage["kind"] == "lost":
            want = first
        if cur_stage is None or want["id"] != cur_stage["id"]:
            if cur and cur[0] != pipe["key"]:
                db.execute(text("DELETE FROM workflow_record_stages WHERE workflow = :w AND record_id = :r"), {"w": cur[0], "r": l.id})
            db.execute(text("INSERT INTO workflow_record_stages (workflow, record_id, stage_id, mapped_at) VALUES (:w, :r, :s, :now) "
                            "ON DUPLICATE KEY UPDATE stage_id = VALUES(stage_id), mapped_at = VALUES(mapped_at)"),
                       {"w": pipe["key"], "r": l.id, "s": want["id"], "now": now_ist()})
            if cur_stage is not None:
                prof.stage_entered_at = now_ist()
            changed = True
        if prof.pipeline != pipe["key"]:
            prof.pipeline = pipe["key"]
            changed = True
        out[l.id] = {"pipe": pipe, "stage": want}
    if changed:
        db.commit()
    return profiles, out


def names(db: Session, ids) -> dict[int, str]:
    ids = {i for i in ids if i}
    return {u.id: u.full_name for u in db.query(User.id, User.full_name).filter(User.id.in_(ids)).all()} if ids else {}


def sla_state(prof: Optional[DealProfile], stage: dict) -> Optional[dict]:
    if not prof or stage["kind"] != "open" or not stage["sla"] or not prof.stage_entered_at:
        return None
    days = (now_ist() - prof.stage_entered_at).days
    left = stage["sla"] - days
    return {"sla": stage["sla"], "days": days, "left": left, "state": "breached" if left < 0 else "due" if left <= 1 else "ok"}


def business_model_vertical(db: Session, ids) -> dict[int, tuple[Optional[str], Optional[str]]]:
    """leads.business_vertical_id → (business model = parent category, vertical = unit) from business_category_units
    (the Masters table the lead / deal forms pick from; same lookup as the EMD and dashboard reports)."""
    ids = sorted({int(i) for i in ids if i})
    if not ids:
        return {}
    rows = db.execute(text(
        "SELECT u.id, COALESCE(u.business_unit, u.business_vertical) AS v, COALESCE(c.business_vertical, c.business_unit) AS m "
        "FROM business_category_units u LEFT JOIN business_category_units c ON c.id = u.parent_category_id AND c.item_type = 'category' "
        "WHERE u.id IN :ids").bindparams(bindparam("ids", expanding=True)), {"ids": ids}).mappings().all()
    return {r["id"]: (r["m"], r["v"]) for r in rows}


def _row_extras(db: Session, leads: list[Lead]) -> dict[int, dict[str, Any]]:
    """Per deal: business model + vertical (from its business vertical) and the journey track Lead → Deal →
    Tender / Quote → Order (prototype jTrack), read in a few batched queries."""
    from app.models.all_models import Quotation, Tender, WorkOrder
    ids = [l.id for l in leads]
    out: dict[int, dict[str, Any]] = {i: {"model": None, "vertical": None, "tq": None, "order": None} for i in ids}
    if not ids:
        return out
    try:
        mv = business_model_vertical(db, {l.business_vertical_id for l in leads if getattr(l, "business_vertical_id", None)})
        for l in leads:
            m = mv.get(getattr(l, "business_vertical_id", None))
            if m:
                out[l.id]["model"], out[l.id]["vertical"] = m
    except Exception:
        db.rollback()
        logger.warning("Deals: business model / vertical lookup failed", exc_info=True)
    try:
        conv = {l.converted_tender_id: l.id for l in leads if getattr(l, "converted_tender_id", None)}
        tq = or_(Tender.lead_id.in_(ids), Tender.id.in_(list(conv))) if conv else Tender.lead_id.in_(ids)
        for t in db.query(Tender.id, Tender.lead_id, Tender.tender_status, Tender.result, Tender.tender_num).filter(Tender.is_deleted == False, tq).order_by(Tender.id).all():
            lid = conv.get(t.id) or t.lead_id
            if lid in out:
                out[lid]["tq"] = {"k": "T", "ref": t.tender_num or f"TND-{t.id}", "stage": t.result if t.result in ("Won", "Lost") else (t.tender_status or "Open")}
                if t.result == "Won":
                    out[lid]["order"] = {"ref": t.tender_num or f"TND-{t.id}", "stage": "Won"}
        for q in db.query(Quotation.lead_id, Quotation.quotation_number, Quotation.status).filter(Quotation.lead_id.in_(ids)).order_by(Quotation.id).all():
            if q.lead_id in out and not out[q.lead_id]["tq"]:
                out[q.lead_id]["tq"] = {"k": "Q", "ref": q.quotation_number, "stage": q.status or "Draft"}
        for w in db.query(WorkOrder.lead_id, WorkOrder.wo_number, WorkOrder.status).filter(WorkOrder.lead_id.in_(ids)).all():
            if w.lead_id in out:
                out[w.lead_id]["order"] = {"ref": w.wo_number, "stage": w.status or "Open"}
    except Exception:
        db.rollback()
        logger.warning("Deals: journey lookup failed", exc_info=True)
    return out


def journey_track(l: Lead, p: dict, s: dict, ex: dict) -> dict[str, Any]:
    """Prototype jSteps(): L · D · T|Q · O – each step done / not started, the last done step is current."""
    tq_k = "Q" if p["destination"] == "quotation" else "T"
    lead_done = (l.lead_type or "lead") != "direct_opportunity"
    tq = ex.get("tq")
    steps = [
        {"k": "L", "label": "Lead", "done": lead_done, "stage": "Converted" if lead_done else None},
        {"k": "D", "label": "Deal", "done": True, "stage": s["name"], "me": True},
        {"k": tq_k, "label": "Quote" if tq_k == "Q" else "Tender", "done": bool(tq), "stage": tq["stage"] if tq else None, "ref": tq["ref"] if tq else None},
        {"k": "O", "label": "Order", "done": bool(ex.get("order")), "stage": ex["order"]["stage"] if ex.get("order") else None},
    ]
    return {"id": f"J-{l.id:04d}", "steps": steps}


def list_rows(db: Session, cu: User) -> tuple[list[dict], list[dict]]:
    pipes = pipelines(db)
    leads = deal_query(db, cu).all()
    profiles, st = sync(db, leads, pipes)
    own = names(db, [l.assigned_to for l in leads])
    extras = _row_extras(db, leads)
    rows = []
    for l in leads:
        info = st.get(l.id)
        if not info:
            continue
        p, s = info["pipe"], info["stage"]
        prof = profiles.get(l.id)
        sla = sla_state(prof, s)
        rows.append({
            "id": l.id, "ref": l.opportunity_ref_id or l.lead_ref_id or f"OPP-{l.id}", "name": l.lead_title, "customer": l.customer_name or "",
            "customer_id": l.customer_id, "workflow": "Quotation" if p["destination"] == "quotation" else "Tender",
            "pipeline": p["key"], "destination": p["destination"],
            "value": float(l.est_value or 0), "prob": s["prob"], "stage": s["name"], "stage_id": s["id"], "stage_kind": s["kind"],
            "owner": own.get(l.assigned_to, ""), "owner_id": l.assigned_to, "close": prof.close_date.isoformat() if prof and prof.close_date else None,
            "pending": bool(prof and prof.pending_stage_id) or l.approval_status == "pending", "converted": l.status == "Converted",
            "sla": sla["state"] if sla else None,
            "flow": p["name"], "model": extras[l.id]["model"] or "", "vertical": extras[l.id]["vertical"] or "",
            "jid": f"J-{l.id:04d}", "journey": journey_track(l, p, s, extras[l.id]),
        })
    return rows, pipes


# ─── stage engine ─────────────────────────────────────────────────────────────

def required_custom(db: Session) -> list[FormField]:
    return db.query(FormField).filter(FormField.module == "opportunities", FormField.is_custom == True, FormField.is_visible == True,
                                      FormField.is_required == True).all()


def _missing_fields(db: Session, lead: Lead) -> list[str]:
    miss = []
    if not (lead.customer_id or (lead.customer_name or "").strip()):
        miss.append("Customer")
    cd = lead.custom_data if isinstance(lead.custom_data, dict) else {}
    for f in required_custom(db):
        v = cd.get(f.field_key)
        if v in (None, "", False):
            miss.append(f.label)
    return miss


def _log(db: Session, cu: User, request: Optional[Request], lead: Lead, description: str, data: dict) -> None:
    from app.core.logging import log_module_action
    db.add(ActivityLog(user_id=cu.id, module="leads", record_id=lead.id, action="status_changed", description=description, icon="🔄", color="#EFF6FF"))
    log_module_action(db=db, user_id=cu.id, module="opportunities", action="stage_change", record_id=lead.id, record_name=lead.lead_title,
                      ip=get_request_ip(request) if request else "", new_data=data)


def apply_stage(db: Session, cu: User, request: Optional[Request], lead: Lead, prof: DealProfile, pipe: dict, target: dict,
                reason: Optional[str] = None, comment: Optional[str] = None) -> None:
    from app.routers.lead_router import _dispatch_lead_event
    old = db.execute(text("SELECT s.name FROM workflow_record_stages m JOIN workflow_stages s ON s.id = m.stage_id WHERE m.workflow = :w AND m.record_id = :r"),
                     {"w": pipe["key"], "r": lead.id}).scalar()
    now = now_ist()
    db.execute(text("INSERT INTO workflow_record_stages (workflow, record_id, stage_id, mapped_at) VALUES (:w, :r, :s, :now) "
                    "ON DUPLICATE KEY UPDATE stage_id = VALUES(stage_id), mapped_at = VALUES(mapped_at)"),
               {"w": pipe["key"], "r": lead.id, "s": target["id"], "now": now})
    prof.stage_entered_at = now
    prof.pending_stage_id = None
    prof.approval_request_id = None
    if target["kind"] == "lost":
        lead.status = "Lost"
        lead.lost_at = now
        prof.lost_reason = reason
        prof.lost_note = (comment or "").strip() or None
        if reason or prof.lost_note:
            db.add(LeadNote(lead_id=lead.id, body=f"Deal marked {target['name']}" + (f" · Reason: {reason}" if reason else "") +
                            (f" – {prof.lost_note}" if prof.lost_note else ""), created_by=cu.id))
        _dispatch_lead_event(db, lead=lead, event_key="status_lost", title="Deal Lost", message=f"Deal '{lead.lead_title}' was marked {target['name']} by {cu.full_name}.",
                             actor_user_id=cu.id)
    elif lead.status == "Lost":
        lead.status = "Opportunity Created"          # reopened
        if not lead.opportunity_created_at:
            lead.opportunity_created_at = now
    if target["kind"] == "won":
        # Orders & Projects: order lifecycles created "automatically when a deal is won" (one per deal + lifecycle)
        from app.services.order_service import on_deal_won
        on_deal_won(db, cu, lead)
    _log(db, cu, request, lead, f"Deal stage changed: {old or '—'} → {target['name']}",
         {"pipeline": pipe["key"], "from": old, "to": target["name"], "reason": reason, "comment": (comment or "").strip() or None})


def move(db: Session, cu: User, request: Request, lead: Lead, stage_id: int, *, reason: Optional[str] = None, comment: Optional[str] = None,
         checklist: Optional[list[str]] = None) -> dict[str, Any]:
    pipes = pipelines(db, include_inactive=True)
    profiles, st = sync(db, [lead], pipes)
    info, prof = st.get(lead.id), profiles.get(lead.id)
    if not info:
        raise HTTPException(409, "No pipeline is configured for deals")
    pipe, cur = info["pipe"], info["stage"]
    target = next((s for s in pipe["stages"] if s["id"] == stage_id), None)
    if not target:
        raise HTTPException(422, "That stage is not part of this deal's pipeline")
    if target["id"] == cur["id"]:
        return {"status": "unchanged", "stage": cur["name"]}
    if lead.status == "Converted":
        raise HTTPException(400, "This deal is already converted – its stage can no longer change")
    if prof.pending_stage_id:
        raise HTTPException(409, "A stage change is waiting for approval")
    if lead.approval_status == "pending":
        raise HTTPException(409, "A conversion approval is pending for this deal")
    if cur["kind"] == "won" and target["kind"] != "lost" and not _can_manage(db, cu):
        raise HTTPException(403, "Only managers can move a won deal back")
    order = [s["id"] for s in pipe["stages"]]
    forward = order.index(target["id"]) > order.index(cur["id"]) and target["kind"] != "lost"
    if target["kind"] == "lost":
        from app.services.lead360_service import lost_reasons
        cfg = lost_reasons(db)
        reason = (reason or "").strip() or None
        if reason and reason not in cfg["reasons"]:
            raise HTTPException(422, "Choose a lost reason from the list")
        if cfg["required"] and not reason:
            raise HTTPException(422, {"message": "Choose why this deal was lost", "lost": True})
    if forward:
        miss = _missing_fields(db, lead)
        if miss:
            raise HTTPException(422, {"message": "Fill the mandatory fields before moving forward: " + ", ".join(miss), "missing": miss})
        if target["gate"] == "Checklist":
            done = {str(x).strip() for x in checklist or []}
            todo = [i for i in target["checklist"] if i not in done]
            if todo:
                raise HTTPException(422, {"message": f"Complete the checklist for {target['name']}", "checklist": target["checklist"], "missing_items": todo})
            prof.checklist = {**(prof.checklist or {}), target["name"]: list(target["checklist"])}
        if target["gate"] == "Approval":
            from app.services.generic_approval_engine import create_generic_approval_request
            req = create_generic_approval_request(db, tenant_id=getattr(getattr(request.state, "tenant", None), "id", None), requester=cu,
                                                  module_key="deal", action_key="stage", record_id=lead.id)
            from app.services.approvals360_service import apply_stage_policy   # Process Designer stage approval policy (chain · threshold · SLA)
            req = apply_stage_policy(db, req, (pipe or {}).get("key") if isinstance(pipe, dict) else None, target["name"], cur["name"], float(lead.est_value or 0))
            if (req.status or "").strip().lower() != "approved":
                prof.pending_stage_id, prof.approval_request_id = target["id"], req.id
                step = next((s for s in sorted(req.steps or [], key=lambda x: x.step_no) if s.step_no == req.current_step_no), None)
                approver = step.approver.full_name if step is not None and getattr(step, "approver", None) else None
                _log(db, cu, request, lead, f"Stage change to {target['name']} sent for approval" + (f" ({approver})" if approver else ""),
                     {"pipeline": pipe["key"], "to": target["name"], "approval_request_id": req.id})
                db.commit()
                return {"status": "pending", "stage": cur["name"], "pending_stage": target["name"], "approver": approver,
                        "message": f"“{target['name']}” needs approval – sent to {approver or 'the approver'}"}
    apply_stage(db, cu, request, lead, prof, pipe, target, reason, comment)
    db.commit()
    res = {"status": "moved", "stage": target["name"], "prob": target["prob"]}
    if target["kind"] == "won" and lead.status == "Opportunity Created":
        res["next"] = {"destination": pipe["destination"], "label": "Create tender record" if pipe["destination"] == "tender" else "Create quotation"}
    return res


def _can_manage(db: Session, cu: User) -> bool:
    from app.routers.lead_router import MANAGER_ROLES
    return (cu.role or "") in MANAGER_ROLES or user_has_permission(db, cu, "settings.manage")


def on_stage_decision(db: Session, request_row, actor: User, remarks: str = "") -> None:
    """Approval engine callback (module "deal", action "stage"): approved ⇒ apply the held stage; rejected ⇒ release it."""
    prof = db.query(DealProfile).filter(DealProfile.approval_request_id == request_row.id).first()
    if not prof or not prof.pending_stage_id:
        return
    status = (request_row.status or "").strip().lower()
    lead = db.query(Lead).filter(Lead.id == prof.lead_id).first()
    if not lead:
        return
    pipes = pipelines(db, include_inactive=True)
    pipe = pipeline_by_key(pipes).get(prof.pipeline)
    target = next((s for s in (pipe or {}).get("stages", []) if s["id"] == prof.pending_stage_id), None)
    if status == "approved" and pipe and target:
        apply_stage(db, actor, None, lead, prof, pipe, target)
        try:
            from app.services.notification_service import upsert_notification
            if lead.assigned_to:
                upsert_notification(db, lead.assigned_to, "Stage change approved", f"Deal '{lead.lead_title}' moved to {target['name']} after approval.",
                                    module="opportunities", record_id=lead.id, action="stage_approved", send_email=False)
        except Exception as exc:
            logger.warning("deal stage approval notification failed: %s", exc)
    elif status == "rejected":
        name = target["name"] if target else "the requested stage"
        prof.pending_stage_id = None
        prof.approval_request_id = None
        _log(db, actor, None, lead, f"Stage change to {name} rejected" + (f" – {remarks}" if remarks else ""), {"to": name, "rejected": True, "remarks": remarks or None})
        try:
            from app.services.notification_service import upsert_notification
            if lead.assigned_to:
                upsert_notification(db, lead.assigned_to, "Stage change rejected", f"Moving deal '{lead.lead_title}' to {name} was rejected" +
                                    (f": {remarks}" if remarks else "."), module="opportunities", record_id=lead.id, action="stage_rejected", send_email=False)
        except Exception as exc:
            logger.warning("deal stage rejection notification failed: %s", exc)


# ─── drawer ───────────────────────────────────────────────────────────────────

def detail(db: Session, cu: User, lead: Lead) -> dict[str, Any]:
    from app.services import lead360_service as L
    pipes = pipelines(db, include_inactive=True)
    profiles, st = sync(db, [lead], pipes)
    info, prof = st[lead.id], profiles[lead.id]
    pipe, cur = info["pipe"], info["stage"]
    base = L.detail(db, cu, lead)
    today = today_ist()
    opens = [s for s in pipe["stages"] if s["kind"] == "open"]
    idx = next((i for i, s in enumerate(opens) if s["id"] == cur["id"]), len(opens) - 1 if cur["kind"] != "open" else 0)
    value = float(lead.est_value or 0)
    created = (lead.opportunity_created_at or lead.created_at)
    age = (now_ist() - created).days if created else 0
    close = prof.close_date
    src = db.query(LeadSource.name).filter(LeadSource.id == lead.source_id).scalar() if lead.source_id else None
    own = names(db, [lead.assigned_to])
    sla = sla_state(prof, cur)
    pending = None
    if prof.pending_stage_id:
        ps = next((s for s in pipe["stages"] if s["id"] == prof.pending_stage_id), None)
        pending = {"kind": "stage", "stage": ps["name"] if ps else None, "approval_request_id": prof.approval_request_id}
    elif lead.approval_status == "pending":
        pending = {"kind": "conversion", "target": lead.conversion_target}
    signals = [x for x in base["signals"] if not x["s"].startswith("Follow-up")]
    if sla:
        signals.append({"t": "ba" if sla["state"] == "breached" else "wa" if sla["state"] == "due" else "ok",
                        "s": f"SLA breached by {-sla['left']} d" if sla["left"] < 0 else f"SLA: {sla['left']} d left in {cur['name']}"})
    if pending:
        signals.append({"t": "wa", "s": f"Awaiting approval → {pending['stage']}" if pending["kind"] == "stage" else "Conversion awaiting approval"})
    journey = base["journey"]
    for j in journey:
        if j["k"] == "lead" and (lead.lead_type or "lead") == "direct_opportunity":
            j.update({"ref": None, "stage": None, "done": False, "date": None, "value": None})
        if j["k"] == "deal":
            j.update({"ref": lead.opportunity_ref_id, "stage": cur["name"], "done": True, "value": value,
                      "date": (lead.opportunity_created_at or lead.created_at).date().isoformat() if (lead.opportunity_created_at or lead.created_at) else None})
        if j["k"] == "tq":
            j["label"] = "Tender / bid" if pipe["destination"] == "tender" else "Quote"
    custom = lead.custom_data if isinstance(lead.custom_data, dict) else {}
    labels = {f.field_key: f.label for f in db.query(FormField).filter(FormField.module == "opportunities").all()}
    model, vertical = base["kpis"].get("model"), base["kpis"].get("vertical")
    panels = [
        {"t": "Contact & source", "i": "users", "f": [["Source", src]]},
        {"t": "Commercials", "i": "tag", "f": [["Workflow type", pipe["name"]], ["Value", value or None, "inr"], ["EMD required", "Yes" if prof.emd_required else None]]
         + ([["Business model", model], ["Business vertical", vertical]] if (model or vertical) else [])},
        {"t": "Ownership & timeline", "i": "cal", "f": [["Expected close", close.isoformat() if close else None, "due"], ["Owner", own.get(lead.assigned_to), "user"], ["Stage", cur["name"], "pill"]]},
        {"t": "Additional information", "i": "layout", "f": [["Opportunity name", lead.lead_title], ["Customer", lead.customer_name]]
         + [[labels.get(k, k.replace("_", " ").capitalize()), v if not isinstance(v, (dict, list)) else json.dumps(v)] for k, v in custom.items()
            if not str(k).startswith("capture_") and k != "test_submission"]},
    ]
    if prof.lost_reason and cur["kind"] == "lost":
        panels[1]["f"].append(["Lost reason", prof.lost_reason + (f" – {prof.lost_note}" if prof.lost_note else "")])
    can_convert = lead.status == "Opportunity Created" and not pending and cur["kind"] != "lost"
    return {
        "id": lead.id, "ref": lead.opportunity_ref_id or lead.lead_ref_id, "name": lead.lead_title, "customer": lead.customer_name, "customer_id": lead.customer_id,
        "lead_status": lead.status, "pipeline": {k: pipe[k] for k in ("key", "name", "label", "destination")}, "stages": pipe["stages"], "stage": cur,
        "kpis": {"value": value, "prob": cur["prob"], "weighted": round(value * cur["prob"] / 100, 2), "close": close.isoformat() if close else None,
                 "close_in": (close - today).days if close else None, "type": "Tender-led" if pipe["destination"] == "tender" else "Quote-led",
                 "model": model, "vertical": vertical, "age": age, "created": created.date().isoformat() if created else None},
        "progress": {"index": idx + 1, "of": len(opens), "kind": cur["kind"]}, "sla": sla, "pending": pending, "signals": signals, "journey": journey,
        "panels": panels, "timeline": base["timeline"], "notes": base["notes"], "can_convert": can_convert,
        "convert_label": "Create tender" if pipe["destination"] == "tender" else "Create quotation",
        "form": {"name": lead.lead_title, "customer_id": lead.customer_id, "customer_name": lead.customer_name, "pipeline": pipe["key"], "value": value,
                 "close": close.isoformat() if close else None, "owner_id": lead.assigned_to, "owner_name": own.get(lead.assigned_to), "source_id": lead.source_id,
                 "source_name": src, "emd_required": bool(prof.emd_required), "custom_data": custom},
        "lost": {"reason": prof.lost_reason, "note": prof.lost_note} if cur["kind"] == "lost" else None,
    }
