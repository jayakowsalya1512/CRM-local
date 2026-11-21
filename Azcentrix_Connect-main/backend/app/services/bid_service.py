"""Bids & Tenders (prototype v17 · Sales → Bids & Tenders): tender & bid flows and their stage engine, configuration,
list rows, the tender page (six tabs) and its calculations.

* A bid is a ``tenders`` row (data scope "tenders", permissions tenders.*). Fields the table already has are used as
  they are; the rest lives in the bid_* side tables (app.models.bids).
* Flows (prototype Process Designer → "Tender & bid flows"): a company runs several tender flows at once – by default
  the prototype's four: Tech → Commercial → RA → Award (default), Tech → Commercial → Award, Two-cover · QCBS and
  Single-cover · GeM / e-procurement. Each flow's stages live in workflow_definitions / workflow_stages under its own
  workflow key (the default flow keeps the key "tender", which the platform's template push writes) and every tender
  follows one flow (bid_profiles.flow); its current stage is its workflow_record_stages row. The board merges the
  stages of all active flows in their relative order (prototype WFS()).
* tenders.result stays the outcome the rest of the app reads: the won stage ⇔ result Won, the lost stage ⇔ Lost.
* Configuration (settings key "bids_config"): GST %, default overheads / contingency / margin / cut-off / PBG / bid
  validity, EMD default %, reminder days and the eligibility / document / technical-criteria templates.
"""
from __future__ import annotations

import json
import logging
import re
import threading
from datetime import date, datetime, timedelta
from typing import Any, Optional

from fastapi import HTTPException, Request
from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

from app.core.timezone import now_ist, today_ist
from app.dependencies import get_request_ip, user_has_permission
from app.models.all_models import (ActivityLog, Competitor, FormField, LeadCategory, LeadSource, OEM, Setting, Tender, TenderConsignee,
                                   TenderProduct, User)
from app.models.bids import (BID_TABLES, BidChecklistItem, BidCompetitorPrice, BidCorrigendum, BidFeeItem, BidFlow, BidNegotiationRound,
                             BidPaymentMilestone, BidPenaltyClause, BidProfile, BidTechScore)

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()

WORKFLOW = "tender"              # workflow key of the default flow (platform template pushes write it)
CONFIG_KEY = "bids_config"

# Prototype v17 STDFLOW / FLSEED – the tender & bid flows every company starts with: "name|SLA|gate|owner|checklist;items".
FLOW_SEED: list[tuple[str, str, bool, list[str]]] = [
    ("tender", "Tech → Commercial → RA → Award", True, [
        "Tender Published|1", "Go / No-Go|3|Approval|Sales Head", "Document Purchase|2", "Pre-bid Meeting|5", "Bid Preparation|10",
        "Technical Bid Submitted|1|Checklist|Bid Manager|EMD furnished;Tech bid uploaded;Power of attorney attached", "Technical Evaluation|15",
        "Commercial Bid Opened|5", "Reverse Auction|2", "Award / LOI|7"]),
    ("tender_tca", "Tech → Commercial → Award", False, [
        "Tender Published|1", "Go / No-Go|3|Approval|Sales Head", "Document Purchase|2", "Bid Preparation|10",
        "Technical Bid Submitted|1|Checklist|Bid Manager|EMD furnished;Tech bid uploaded", "Technical Evaluation|15", "Commercial Bid Opened|5",
        "Award / LOI|7"]),
    ("tender_qcbs", "Two-cover · QCBS", False, [
        "Tender Published|1", "Go / No-Go|3|Approval|Sales Head", "Bid Preparation|10", "Technical Bid Submitted|1",
        "Technical Evaluation (QCBS)|20", "Commercial Bid Opened|5", "Combined Scoring|5", "Award / LOI|7"]),
    ("tender_gem", "Single-cover · GeM / e-procurement", False, [
        "Tender Published|1", "Go / No-Go|2", "Bid Preparation|5", "Bid Submitted|1", "Evaluation|10", "Award / LOI|5"]),
    ("tender_zigma", "Zigma – Tender, Participation & Submission", False, [
        "Tender Creation|5", "Fee Approval|2|Approval|Finance Controller", "Pre-Qualification / Technical Documents|3|Checklist|Bid Manager|Technical compliance sheet;OEM authorisation;Experience certificate",
        "Commercial Documents|2|Checklist|Bid Manager|Price bid / BOQ schedule;Commercial terms acceptance", "Final Bid Documents Approval|2|Approval|Sales Head", "Submitted|1"]),
]
# "Start from" presets for a new flow: the four STDFLOW tender flows plus every WFD tender workflow of the prototype.
PRESETS: list[tuple[str, str, list[str]]] = [(f"std_{k}", n, specs) for k, n, _, specs in FLOW_SEED] + [
    ("t1", "Detailed tender workflow · 9 steps", [
        "Identified|2|None|Bid Manager", "Go / No-Go|3|Approval|Sales Head", "Document Purchase|2", "Pre-bid Meeting|5", "Bid Preparation|10",
        "Tech Bid Submitted|1|Checklist|Bid Manager|EMD furnished;Tech bid uploaded;Power of attorney attached", "Tech Evaluation|15",
        "Price Bid Opened|7", "Negotiation|5"]),
    ("t2", "EPC with site visit · 7 steps", [
        "Identified|2", "Go / No-Go|3|Approval|Sales Head", "Site Visit|7", "Bid Preparation|12",
        "Submitted|1|Checklist||EMD furnished;Site report attached", "Evaluation|20", "Negotiation|7"]),
    ("t3", "Defence & OEM-heavy · 11 steps", [
        "Identified|2", "Go / No-Go|3|Approval|Sales Head", "Eligibility Check|3|Checklist||Past performance;OEM authorisation;Turnover certificate",
        "OEM Quotation|7", "Pre-bid Query|5", "Bid Preparation|10", "Technical Submission|1", "Demo / Trial|10", "Tech Evaluation|15", "Price Bid|5",
        "Negotiation|7"]),
    ("t4", "Fabrication costing · 4 steps", ["Enquiry|1", "Costing|4", "Submitted|1|Approval|Sales Head", "Negotiation|7"]),
    ("t5", "Lean bidding · 6 steps", ["Identified|2", "Go / No-Go|3|Approval", "Bid Preparation|8", "Submitted|1", "Evaluation|14", "Negotiation|5"]),
    ("t6", "Quotation-first · 4 steps", ["Enquiry|1", "Quote Sent|2", "Technical Clarification|5", "Commercial Negotiation|7"]),
    ("t7", "Starter bidding · 4 steps", ["Identified|2", "Bid Preparation|7", "Submitted|1", "Evaluation|10"]),
]

# Prototype v17 tx(): defaults a new bid starts from (configurable under Pipelines & Stages → Bids & Tenders settings).
DEFAULT_CONFIG: dict[str, Any] = {
    "gst_pct": 18, "emd_default_pct": 2, "overhead_pct": 8, "contingency_pct": 2, "margin_pct": 12, "cutoff_pct": 70, "pbg_pct": 5,
    "bid_validity_days": 120, "reminder_days": [7, 3, 1], "emd_alert_days": 30, "auto_advance": True, "block_submission_on_gaps": True,
    "eligibility": ["Average annual turnover ≥ 30% of the estimate (last 3 FY)", "Similar work executed worth ≥ 40% of estimate",
                    "Valid OEM authorisation for main equipment", "No debarment / blacklisting declaration", "Valid GST and PAN registration"],
    "documents": ["Tender fee receipt", "EMD / BG", "Power of attorney", "Technical compliance sheet", "Price schedule (BoQ)", "Integrity pact"],
    "documents_commercial": [], "documents_final": [],
    "tech_criteria": [["Prior experience in similar works", 20], ["Financial turnover & net worth", 15], ["Technical compliance matrix", 25],
                      ["OEM authorisation & MAF", 10], ["Project team & methodology", 15], ["Delivery & commissioning schedule", 10],
                      ["Quality certifications (ISO / BIS)", 5]],
    "fee_items": [["Tender fee", "DD"], ["EMD", "Online"], ["Performance BG", "BG"]],
}


def _parse(spec: str) -> dict:
    name, sla, gate, owner, req = (spec.split("|") + [""] * 5)[:5]
    return {"name": name, "kind": "open", "sla_days": int(sla or 0), "gate": gate or "None", "owner_role": owner or None,
            "checklist": [r for r in req.split(";") if r] or None}


def _with_outcomes(specs: list[str]) -> list[dict]:
    return [_parse(x) for x in specs] + [{"name": n, "kind": n.lower(), "sla_days": 0, "gate": "None", "owner_role": None, "checklist": None}
                                         for n in ("Won", "Lost")]


def preset_stages(key: str) -> list[dict]:
    p = next((x for x in PRESETS if x[0] == key), None)
    if not p:
        raise HTTPException(404, "Unknown flow template")
    return _with_outcomes(p[2])


def _write_workflow(db: Session, key: str, name: str, stages: list[dict], template_key: Optional[str]) -> None:
    db.execute(text("INSERT INTO workflow_definitions (workflow, revision, template_key, template_name, applied_by, applied_at) "
                    "VALUES (:w, 1, :k, :n, 'Bids & Tenders defaults', :now)"), {"w": key, "k": template_key, "n": name, "now": now_ist()})
    for i, s in enumerate(stages):
        db.execute(text("INSERT INTO workflow_stages (workflow, revision, position, name, kind, sla_days, gate, owner_role, checklist) "
                        "VALUES (:w, 1, :p, :n, :k, :sla, :g, :o, :c)"),
                   {"w": key, "p": i, "n": s["name"], "k": s["kind"], "sla": s["sla_days"], "g": s["gate"], "o": s["owner_role"],
                    "c": json.dumps(s["checklist"]) if s["checklist"] else None})


# ─── schema ───────────────────────────────────────────────────────────────────

def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        from app.services.platform_workflow_templates import TENANT_DDL
        for ddl in TENANT_DDL:
            db.execute(text(ddl))
        db.execute(text("ALTER TABLE tender_consignees ADD COLUMN IF NOT EXISTS qty_share VARCHAR(20) NULL"))
        db.execute(text("ALTER TABLE tenders ADD COLUMN IF NOT EXISTS financial_bid_date DATE NULL"))
        db.commit()
        bind = db.get_bind()
        for t in BID_TABLES:
            t.create(bind=bind, checkfirst=True)
        db.execute(text("ALTER TABLE bid_profiles ADD COLUMN IF NOT EXISTS flow VARCHAR(40) NULL"))
        db.execute(text("ALTER TABLE bid_profiles ADD COLUMN IF NOT EXISTS selection_method VARCHAR(40) NULL"))
        db.execute(text("ALTER TABLE bid_profiles ADD COLUMN IF NOT EXISTS jv_allowed TINYINT(1) NULL"))
        db.execute(text("ALTER TABLE bid_profiles ADD COLUMN IF NOT EXISTS jv_member_count INT NULL"))
        db.execute(text("ALTER TABLE bid_profiles ADD COLUMN IF NOT EXISTS gst_applicable TINYINT(1) NULL"))
        db.commit()
        if not db.query(BidFlow.workflow).first():
            _seed_flows(db)
        else:
            # a tenant provisioned before a new non-default FLOW_SEED preset (e.g. "tender_zigma") was added – back-fill
            # just that preset as a new, inactive-by-default flow; the tenant's active flow is untouched.
            have = {w for (w,) in db.query(BidFlow.workflow).all()}
            for i, (key, name, is_default, specs) in enumerate(FLOW_SEED):
                if is_default or key in have:
                    continue
                if not db.execute(text("SELECT 1 FROM workflow_definitions WHERE workflow = :w"), {"w": key}).first():
                    _write_workflow(db, key, name, _with_outcomes(specs), f"std_{key}")
                db.add(BidFlow(workflow=key, name=name, is_default=False, sort_order=i, is_active=True))
            db.commit()
        if not db.query(Setting.id).filter(Setting.key == CONFIG_KEY).first():
            db.add(Setting(key=CONFIG_KEY, value=json.dumps(DEFAULT_CONFIG), type="json", category="tenders", label="Bids & Tenders settings",
                           description="Defaults, checklists and evaluation criteria for Bids & Tenders"))
            db.commit()
        _READY.add(slug)


def _seed_flows(db: Session) -> None:
    """First run: the prototype's four tender flows. A "tender" workflow already pushed by the platform stays the default
    flow as it is; this module's earlier single-workflow default is remapped onto the default flow's stages
    (same-named stages keep their tenders, won / lost stay, the rest move to the nearest stage by position)."""
    key0, name0, _, specs0 = FLOW_SEED[0]
    cur = db.execute(text("SELECT template_key, template_name, applied_by FROM workflow_definitions WHERE workflow = :w"), {"w": WORKFLOW}).mappings().first()
    if cur is None:
        _write_workflow(db, WORKFLOW, name0, _with_outcomes(specs0), f"std_{key0}")
        db.commit()
    elif cur["applied_by"] == "Bids & Tenders defaults" and cur["template_key"] == "t1":
        from app.services.platform_workflow_templates import apply_to_tenant
        slug = db.info.get("tenant_slug")
        db.commit()
        if not slug:
            raise RuntimeError("tenant slug unknown – cannot remap the tender workflow")
        apply_to_tenant(slug, f"std_{key0}", name0, _with_outcomes(specs0), actor="Bids & Tenders defaults")
    else:
        name0 = cur["template_name"] or name0           # platform-pushed workflow: kept as the default flow
    db.add(BidFlow(workflow=WORKFLOW, name=name0, is_default=True, sort_order=0, is_active=True))
    for i, (key, name, _, specs) in enumerate(FLOW_SEED[1:], start=1):
        if not db.execute(text("SELECT 1 FROM workflow_definitions WHERE workflow = :w"), {"w": key}).first():
            _write_workflow(db, key, name, _with_outcomes(specs), f"std_{key}")
        db.add(BidFlow(workflow=key, name=name, is_default=False, sort_order=i, is_active=True))
    db.commit()


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
            logger.warning("bids schema: tenant %s unavailable: %s", slug, exc)
            continue
        try:
            db.info["tenant_slug"] = slug
            ensure_schema(db)
        except Exception as exc:
            logger.warning("bids schema for %s failed: %s", slug, exc)
            db.rollback()
        finally:
            db.close()


# ─── configuration ────────────────────────────────────────────────────────────

def config(db: Session) -> dict[str, Any]:
    row = db.query(Setting).filter(Setting.key == CONFIG_KEY).first()
    cfg = dict(DEFAULT_CONFIG)
    if row and row.value:
        try:
            stored = json.loads(row.value)
            if isinstance(stored, dict):
                cfg.update({k: v for k, v in stored.items() if k in DEFAULT_CONFIG})
        except ValueError:
            logger.warning("bids_config is not valid JSON – using defaults")
    return cfg


def save_config(db: Session, cu: User, data: dict[str, Any]) -> dict[str, Any]:
    cfg = config(db)
    for k in ("gst_pct", "emd_default_pct", "overhead_pct", "contingency_pct", "margin_pct", "cutoff_pct", "pbg_pct"):
        if k in data and data[k] is not None:
            v = float(data[k])
            if not 0 <= v <= 100:
                raise HTTPException(422, f"{k.replace('_pct', '').replace('_', ' ').capitalize()} must be 0–100 %")
            cfg[k] = v
    if "bid_validity_days" in data and data["bid_validity_days"] is not None:
        if not 0 < int(data["bid_validity_days"]) <= 1000:
            raise HTTPException(422, "Bid validity must be 1–1000 days")
        cfg["bid_validity_days"] = int(data["bid_validity_days"])
    if "emd_alert_days" in data and data["emd_alert_days"] is not None:
        cfg["emd_alert_days"] = max(1, min(365, int(data["emd_alert_days"])))
    if "reminder_days" in data and data["reminder_days"] is not None:
        days = sorted({int(x) for x in data["reminder_days"] if 0 <= int(x) <= 90}, reverse=True)
        cfg["reminder_days"] = days
    for k in ("auto_advance", "block_submission_on_gaps"):
        if k in data and data[k] is not None:
            cfg[k] = bool(data[k])
    for k in ("eligibility", "documents"):
        if k in data and data[k] is not None:
            items = [str(x).strip()[:300] for x in data[k] if str(x).strip()]
            if len(set(i.lower() for i in items)) != len(items):
                raise HTTPException(422, "Checklist items must be unique")
            cfg[k] = items
    if "tech_criteria" in data and data["tech_criteria"] is not None:
        crit = []
        for x in data["tech_criteria"]:
            name, mx = (x.get("criterion"), x.get("max_marks")) if isinstance(x, dict) else (x[0], x[1])
            if not str(name or "").strip() or float(mx or 0) <= 0:
                raise HTTPException(422, "Every criterion needs a name and max marks above 0")
            crit.append([str(name).strip()[:300], float(mx)])
        cfg["tech_criteria"] = crit
    row = db.query(Setting).filter(Setting.key == CONFIG_KEY).first()
    if not row:
        row = Setting(key=CONFIG_KEY, type="json", category="tenders", label="Bids & Tenders settings")
        db.add(row)
    row.value = json.dumps(cfg)
    row.updated_by = cu.id
    return cfg


# ─── flows & stages ───────────────────────────────────────────────────────────

def _stage_rows(db: Session, keys: list[str]) -> dict[str, list[dict]]:
    if not keys:
        return {}
    revs = dict(db.execute(text("SELECT workflow, revision FROM workflow_definitions WHERE workflow IN :w").bindparams(
        bindparam("w", expanding=True)), {"w": keys}).all())
    rows = db.execute(text("SELECT id, workflow, revision, position, name, kind, sla_days, gate, owner_role, checklist FROM workflow_stages "
                           "WHERE workflow IN :w ORDER BY workflow, position").bindparams(bindparam("w", expanding=True)), {"w": keys}).mappings().all()
    by: dict[str, list[dict]] = {k: [] for k in keys}
    for s in rows:
        if revs.get(s["workflow"]) != s["revision"]:
            continue
        cl = s["checklist"]
        if isinstance(cl, str):
            try:
                cl = json.loads(cl)
            except ValueError:
                cl = None
        by[s["workflow"]].append({"id": s["id"], "name": s["name"], "kind": s["kind"], "sla": int(s["sla_days"] or 0), "gate": s["gate"] or "None",
                                  "owner_role": s["owner_role"], "checklist": cl or [], "position": s["position"], "flow": s["workflow"]})
    for k, st in by.items():
        by[k] = [x for x in st if x["kind"] == "open"] + [x for x in st if x["kind"] == "won"] + [x for x in st if x["kind"] == "lost"]
    return by


def flows(db: Session, include_inactive: bool = False) -> list[dict[str, Any]]:
    """Tender & bid flows with their stages (open stages in order, then Won, then Lost); the default flow first."""
    q = db.query(BidFlow)
    if not include_inactive:
        q = q.filter(BidFlow.is_active == True)  # noqa: E712
    rows = q.order_by(BidFlow.is_default.desc(), BidFlow.sort_order, BidFlow.workflow).all()
    st = _stage_rows(db, [f.workflow for f in rows])
    return [{"key": f.workflow, "name": f.name, "default": bool(f.is_default), "active": bool(f.is_active), "stages": st.get(f.workflow, [])}
            for f in rows if st.get(f.workflow)]


def flow_map(fl: list[dict]) -> dict[str, dict]:
    return {f["key"]: f for f in fl}


def default_flow(fl: list[dict]) -> Optional[dict]:
    return next((f for f in fl if f["default"] and f["active"]), None) or next((f for f in fl if f["active"]), None) or (fl[0] if fl else None)


def board_stages(fl: list[dict]) -> list[dict[str, Any]]:
    """Prototype WFS(): the board shows the open stages of every active flow, merged by name and ordered by their average
    relative position within their flows, followed by the outcome stages. Each column lists its stage id per flow."""
    act = [f for f in fl if f["active"]]
    pos: dict[str, list[float]] = {}
    first: dict[str, dict] = {}
    ids: dict[str, dict[str, int]] = {}
    for f in act:
        opens = [s for s in f["stages"] if s["kind"] == "open"]
        for i, s in enumerate(opens):
            pos.setdefault(s["name"], []).append(i / (len(opens) - 1) if len(opens) > 1 else 0)
            first.setdefault(s["name"], s)
            ids.setdefault(s["name"], {})[f["key"]] = s["id"]
    out = [{**{k: first[n][k] for k in ("name", "kind", "sla", "gate", "checklist")}, "ids": ids[n]}
           for n in sorted(pos, key=lambda n: sum(pos[n]) / len(pos[n]))]
    for kind in ("won", "lost"):
        names_ = []
        for f in act:
            for s in f["stages"]:
                if s["kind"] == kind and s["name"] not in names_:
                    names_.append(s["name"])
        for n in names_:
            out.append({"name": n, "kind": kind, "sla": 0, "gate": "None", "checklist": [],
                        "ids": {f["key"]: s["id"] for f in act for s in f["stages"] if s["kind"] == kind and s["name"] == n}})
    return out


def workflow_info(db: Session, key: str = WORKFLOW) -> dict[str, Any]:
    row = db.execute(text("SELECT revision, template_key, template_name, applied_by, applied_at FROM workflow_definitions WHERE workflow = :w"),
                     {"w": key}).mappings().first()
    return dict(row) if row else {}


def save_stages(db: Session, key: str, new: list[dict]) -> None:
    """Process Designer: edit a flow's stages in place – stage ids (and the bids on them) are kept, new stages are added
    and stages without bids can be removed."""
    from app.services.platform_workflow_templates import WorkflowTemplateError, validate_stages
    clean = []
    for s in new:
        cl = [str(x).strip() for x in (s.get("checklist") or []) if str(x).strip()]
        clean.append({"id": s.get("id"), "name": str(s.get("name") or "").strip(), "kind": s.get("kind") or "open", "sla_days": int(s.get("sla") or 0),
                      "gate": s.get("gate") or "None", "owner_role": (s.get("owner_role") or None), "checklist": cl or None})
    try:
        validate_stages(clean)
    except WorkflowTemplateError as exc:
        raise HTTPException(422, str(exc))
    rev = db.execute(text("SELECT revision FROM workflow_definitions WHERE workflow = :w FOR UPDATE"), {"w": key}).scalar()
    if rev is None:
        raise HTTPException(404, "Flow not found")
    current = {r[0] for r in db.execute(text("SELECT id FROM workflow_stages WHERE workflow = :w AND revision = :r"), {"w": key, "r": rev}).all()}
    keep = {int(s["id"]) for s in clean if s.get("id") and int(s["id"]) in current}
    gone = current - keep
    if gone:
        used = db.execute(text("SELECT COUNT(*) FROM workflow_record_stages WHERE workflow = :w AND stage_id IN :ids").bindparams(
            bindparam("ids", expanding=True)), {"w": key, "ids": list(gone)}).scalar()
        if used:
            raise HTTPException(409, f"{used} bid(s) are on stages you removed – move them first")
        db.execute(text("DELETE FROM workflow_stages WHERE id IN :ids").bindparams(bindparam("ids", expanding=True)), {"ids": list(gone)})
    db.execute(text("UPDATE workflow_stages SET position = position + 1000 WHERE workflow = :w AND revision = :r"), {"w": key, "r": rev})
    for i, s in enumerate(clean):
        prm = {"w": key, "r": rev, "p": i, "n": s["name"], "k": s["kind"], "sla": s["sla_days"], "g": s["gate"], "o": s["owner_role"],
               "c": json.dumps(s["checklist"]) if s["checklist"] else None}
        if s.get("id") and int(s["id"]) in keep:
            db.execute(text("UPDATE workflow_stages SET position=:p, name=:n, kind=:k, sla_days=:sla, gate=:g, owner_role=:o, checklist=:c WHERE id = :id"),
                       {**prm, "id": int(s["id"])})
        else:
            db.execute(text("INSERT INTO workflow_stages (workflow, revision, position, name, kind, sla_days, gate, owner_role, checklist) "
                            "VALUES (:w, :r, :p, :n, :k, :sla, :g, :o, :c)"), prm)


def create_flow(db: Session, name: str, stages_: list[dict], make_default: bool) -> str:
    import secrets
    key = f"tender_{secrets.token_hex(4)}"
    order = (db.execute(text("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM bid_flows")).scalar() or 1)
    from app.services.platform_workflow_templates import WorkflowTemplateError, validate_stages
    try:
        validate_stages(stages_)
    except WorkflowTemplateError as exc:
        raise HTTPException(422, str(exc))
    _write_workflow(db, key, name, stages_, None)
    if make_default:
        db.query(BidFlow).update({BidFlow.is_default: False})
    db.add(BidFlow(workflow=key, name=name, is_default=bool(make_default), sort_order=order, is_active=True))
    return key


def place_in_flow(cur: Optional[dict], new_flow: dict) -> dict:
    """Stage a tender lands on when it changes flow: same-named stage, same outcome, else the first open stage."""
    st = new_flow["stages"]
    if cur:
        same = next((s for s in st if s["name"].lower() == cur["name"].lower() and s["kind"] == cur["kind"]), None)
        if same:
            return same
        if cur["kind"] != "open":
            return next(s for s in st if s["kind"] == cur["kind"])
    return next(s for s in st if s["kind"] == "open")


def _find(opens: list[dict], pattern: str) -> Optional[dict]:
    rx = re.compile(pattern, re.I)
    return next((s for s in opens if rx.search(s["name"])), None)


def _legacy_stage(t: Tender, st: list[dict]) -> dict:
    """Where a tender that has no stage yet belongs, read from its legacy status / step (initial mapping only)."""
    opens = [s for s in st if s["kind"] == "open"]
    won = next(s for s in st if s["kind"] == "won")
    lost = next(s for s in st if s["kind"] == "lost")
    if t.result == "Won":
        return won
    if t.result in ("Lost", "Cancelled") or t.tender_status == "Closed":
        return lost
    status, step = t.tender_status or "", int(t.current_step or 1)
    pick = None
    if status == "Reverse Auction":
        pick = _find(opens, r"auction|negotiat|commercial|price")
    elif status == "Evaluation":
        pick = _find(opens, r"evaluat")
    elif status == "Submitted":
        pick = _find(opens, r"submi")
    elif status == "Pre-Bid":
        pick = _find(opens, r"pre-?bid")
    elif step >= 4:
        pick = _find(opens, r"evaluat")
    elif step == 3:
        pick = _find(opens, r"prepar|costing")
    elif step == 2:
        pick = _find(opens, r"go\s*/\s*no|eligib|document")
    return pick or opens[0]


def sync(db: Session, tenders: list[Tender], fl: list[dict]) -> tuple[dict[int, BidProfile], dict[int, dict]]:
    """Every bid gets a profile, a flow and a stage of that flow; tenders.result keeps the won / lost stage in step.
    Returns the profiles and, per tender, its current stage (stage["flow"] = flow key)."""
    if not tenders or not fl:
        return {}, {}
    fm = flow_map(fl)
    dflt = default_flow(fl)
    ids = [t.id for t in tenders]
    keys = list(fm)
    profiles = {p.tender_id: p for p in db.query(BidProfile).filter(BidProfile.tender_id.in_(ids)).all()}
    maps: dict[int, list[tuple[str, int]]] = {}
    for rid, wf, sid in db.execute(text("SELECT record_id, workflow, stage_id FROM workflow_record_stages WHERE workflow IN :w AND record_id IN :ids")
                                   .bindparams(bindparam("ids", expanding=True), bindparam("w", expanding=True)), {"w": keys, "ids": ids}).all():
        maps.setdefault(rid, []).append((wf, sid))
    by_id = {s["id"]: s for f in fl for s in f["stages"]}
    out: dict[int, dict] = {}
    changed = False
    now = now_ist()
    for t in tenders:
        prof = profiles.get(t.id)
        if prof is None:
            prof = BidProfile(tender_id=t.id, po_ack=False, stage_entered_at=t.updated_at or t.created_at or now)
            db.add(prof)
            profiles[t.id] = prof
            changed = True
        mapped = maps.get(t.id, [])
        flow = fm.get(prof.flow or "")
        if flow is None:                                     # no flow yet: the one it is mapped in, else the default flow
            flow = next((fm[wf] for wf, _ in mapped if wf in fm), None) or dflt
        if prof.flow != flow["key"]:
            prof.flow = flow["key"]
            changed = True
        cur = next((by_id.get(sid) for wf, sid in mapped if wf == flow["key"] and sid in by_id), None)
        stale = [wf for wf, _ in mapped if wf != flow["key"]]
        if cur is None and stale:                            # mapped in another flow (flow changed elsewhere): carry the stage over
            prev = next((by_id.get(sid) for wf, sid in mapped if sid in by_id), None)
            cur_new = place_in_flow(prev, flow)
        else:
            cur_new = None
        want = cur
        if cur is None:
            want = cur_new or _legacy_stage(t, flow["stages"])
        if t.result == "Won" and want["kind"] != "won":
            want = next(s for s in flow["stages"] if s["kind"] == "won")
        elif t.result in ("Lost", "Cancelled") and want["kind"] != "lost":
            want = next(s for s in flow["stages"] if s["kind"] == "lost")
        if stale:
            db.execute(text("DELETE FROM workflow_record_stages WHERE record_id = :r AND workflow IN :w").bindparams(bindparam("w", expanding=True)),
                       {"r": t.id, "w": stale})
            changed = True
        if cur is None or want["id"] != cur["id"]:
            db.execute(text("INSERT INTO workflow_record_stages (workflow, record_id, stage_id, mapped_at) VALUES (:w, :r, :s, :now) "
                            "ON DUPLICATE KEY UPDATE stage_id = VALUES(stage_id), mapped_at = VALUES(mapped_at)"),
                       {"w": flow["key"], "r": t.id, "s": want["id"], "now": now})
            if cur is not None:
                prof.stage_entered_at = now
            changed = True
        out[t.id] = want
    if changed:
        db.commit()
    return profiles, out


def set_flow(db: Session, t: Tender, prof: BidProfile, fl: list[dict], cur: dict, key: str) -> Optional[dict]:
    """Move a tender to another flow, keeping its place (same-named stage / outcome, else the first open stage)."""
    fm = flow_map(fl)
    new = fm.get(key)
    if not new or not new["active"]:
        raise HTTPException(422, "Choose an active tender flow")
    if new["key"] == cur["flow"]:
        return None
    target = place_in_flow(cur, new)
    db.execute(text("DELETE FROM workflow_record_stages WHERE record_id = :r AND workflow IN :w").bindparams(bindparam("w", expanding=True)),
               {"r": t.id, "w": list(fm)})
    db.execute(text("INSERT INTO workflow_record_stages (workflow, record_id, stage_id, mapped_at) VALUES (:w, :r, :s, :now)"),
               {"w": new["key"], "r": t.id, "s": target["id"], "now": now_ist()})
    prof.flow = new["key"]
    if target["name"] != cur["name"]:
        prof.stage_entered_at = now_ist()
    return target


# ─── records ──────────────────────────────────────────────────────────────────

def bid_query(db: Session, cu: User):
    from app.utils.data_scope import apply_data_scope
    q = db.query(Tender).filter(Tender.is_deleted == False)  # noqa: E712
    return apply_data_scope(db, q, cu, "tenders", Tender.created_by, Tender.assigned_to)


def get_bid(db: Session, cu: User, tender_id: int) -> Tender:
    t = bid_query(db, cu).filter(Tender.id == tender_id).first()
    if not t:
        raise HTTPException(404, "Tender not found")
    return t


def names(db: Session, ids) -> dict[int, str]:
    ids = {int(i) for i in ids if i}
    return {u.id: u.full_name for u in db.query(User.id, User.full_name).filter(User.id.in_(ids)).all()} if ids else {}


def sla_state(prof: Optional[BidProfile], stage: dict) -> Optional[dict]:
    if not prof or stage["kind"] != "open" or not stage["sla"] or not prof.stage_entered_at:
        return None
    days = (now_ist() - prof.stage_entered_at).days
    left = stage["sla"] - days
    return {"sla": stage["sla"], "days": days, "left": left, "state": "breached" if left < 0 else "due" if left <= 1 else "ok"}


def ref_of(t: Tender) -> str:
    return t.tender_num or f"TND-{t.id}"


def verticals(db: Session, tenders: list[Tender]) -> dict[int, Optional[str]]:
    """Business vertical (Masters → business units) of each tender, read like the Leads / Deals grids."""
    from app.services.deal_service import business_model_vertical
    ids = {t.id: getattr(t, "business_vertical_id", None) for t in tenders}
    try:
        mv = business_model_vertical(db, {v for v in ids.values() if v})
    except Exception:
        db.rollback()
        logger.warning("Bids: business vertical lookup failed", exc_info=True)
        return {}
    return {tid: (mv.get(v) or (None, None))[1] for tid, v in ids.items() if v}


def journeys(db: Session, tenders: list[Tender], cur: dict[int, dict]) -> dict[int, dict]:
    """Prototype jTrack() per tender: L · D · T · O (lead, deal, this tender, work order), read in two batched queries."""
    from app.models.all_models import Lead, WorkOrder
    lead_ids = {t.lead_id for t in tenders if t.lead_id}
    leads = {l.id: l for l in db.query(Lead.id, Lead.lead_type, Lead.status, Lead.opportunity_ref_id, Lead.lead_ref_id).filter(Lead.id.in_(lead_ids)).all()} if lead_ids else {}
    tids = [t.id for t in tenders]
    wos = {w.tender_id: w for w in db.query(WorkOrder.tender_id, WorkOrder.wo_number, WorkOrder.status).filter(WorkOrder.tender_id.in_(tids)).all()} if tids else {}
    out = {}
    for t in tenders:
        l, w, s = leads.get(t.lead_id), wos.get(t.id), cur.get(t.id)
        is_lead = bool(l) and l.lead_type != "direct_opportunity"
        is_deal = bool(l) and (l.lead_type == "direct_opportunity" or bool(l.opportunity_ref_id))
        out[t.id] = {"id": f"J-{(l.id if l else t.id):04d}", "steps": [
            {"k": "L", "label": "Lead", "done": is_lead, "stage": "Converted" if is_lead else None},
            {"k": "D", "label": "Deal", "done": is_deal, "stage": ("Won" if l.status == "Converted" else l.status) if is_deal else None, "ref": l.opportunity_ref_id if is_deal else None},
            {"k": "T", "label": "Tender", "done": True, "stage": s["name"] if s else None, "ref": ref_of(t), "me": True},
            {"k": "O", "label": "Order", "done": bool(w or t.wrk_order_id), "stage": (w.status if w else "Created") if (w or t.wrk_order_id) else None,
             "ref": w.wo_number if w else t.wrk_order_id},
        ]}
    return out


def list_rows(db: Session, cu: User) -> tuple[list[dict], list[dict]]:
    fl = flows(db, include_inactive=True)
    tenders = bid_query(db, cu).all()
    profiles, cur = sync(db, tenders, fl)
    fm = flow_map(fl)
    own = names(db, [t.assigned_to for t in tenders])
    portals = dict(db.query(LeadSource.id, LeadSource.name).all())
    vert = verticals(db, tenders)
    jr = journeys(db, tenders, cur)
    rows = []
    for t in tenders:
        s = cur.get(t.id)
        if not s:
            continue
        prof = profiles.get(t.id)
        sla = sla_state(prof, s)
        rows.append({
            "id": t.id, "ref": ref_of(t), "title": t.tender_title or "", "nit": t.portal_ref_number or "", "customer": t.customer_name or "",
            "customer_id": t.customer_id, "portal": portals.get(t.source_id, "") if t.source_id else "", "portal_id": t.source_id,
            "value": float(t.est_value or 0), "emd": float(t.emd_amount or 0), "stage": s["name"], "stage_id": s["id"], "stage_kind": s["kind"],
            "flow_key": s["flow"], "flow": fm[s["flow"]]["name"] if s["flow"] in fm else "", "vertical": vert.get(t.id) or "",
            "jid": jr[t.id]["id"], "journey": jr[t.id],
            "submit": t.submission_date.isoformat() if t.submission_date else None, "owner": own.get(t.assigned_to, ""), "owner_id": t.assigned_to,
            "pending": bool(prof and prof.pending_stage_id), "sla": sla["state"] if sla else None,
        })
    return rows, fl


def send_reminders(db: Session, rows: list[dict]) -> int:
    """Deadline reminders (prototype: "Deadline drives alerts at 7, 3 and 1 day"): one in-app notification to the bid
    manager per configured day before submission, plus the pre-bid meeting the day before. Idempotent per day."""
    cfg = config(db)
    days = set(int(d) for d in cfg.get("reminder_days") or [])
    today = today_ist()
    due = [r for r in rows if r["stage_kind"] == "open" and r["owner_id"] and r["submit"] and (date.fromisoformat(r["submit"]) - today).days in days]
    if not due:
        return 0
    from app.services.notification_service import upsert_notification
    profiles = {p.tender_id: p for p in db.query(BidProfile).filter(BidProfile.tender_id.in_([r["id"] for r in due])).all()}
    sent = 0
    for r in due:
        n = (date.fromisoformat(r["submit"]) - today).days
        prof = profiles.get(r["id"])
        if not prof:
            continue
        mark = f"{today.isoformat()}:{n}"
        rem = dict(prof.reminders or {})
        if rem.get("submit") == mark:
            continue
        try:
            upsert_notification(db, r["owner_id"], "Bid submission due" if n else "Bid submission due today",
                                f"{r['ref']} · {r['title'][:80]} – submission {'today' if n == 0 else f'in {n} day' + ('s' if n > 1 else '')} ({r['customer']}).",
                                module="tenders", record_id=r["id"], action="deadline_reminder", send_email=False)
            rem["submit"] = mark
            prof.reminders = rem
            sent += 1
        except Exception as exc:
            logger.warning("bid reminder failed: %s", exc)
    if sent:
        db.commit()
    return sent


# ─── stage engine ─────────────────────────────────────────────────────────────

def required_custom(db: Session) -> list[FormField]:
    return db.query(FormField).filter(FormField.module == "tenders", FormField.is_custom == True, FormField.is_visible == True,  # noqa: E712
                                      FormField.is_required == True).all()  # noqa: E712


def _items(db: Session, t: Tender, kind: str) -> list[BidChecklistItem]:
    return db.query(BidChecklistItem).filter(BidChecklistItem.tender_id == t.id, BidChecklistItem.kind == kind).order_by(BidChecklistItem.position).all()


def tech_totals(rows: list[BidTechScore], cutoff: float) -> dict[str, Any]:
    mx = sum(float(r.max_marks or 0) for r in rows)
    s = sum(float(r.awarded or 0) for r in rows)
    scored = bool(rows) and all(r.awarded is not None for r in rows)
    pct = round(s / mx * 100) if mx else 0
    return {"score": s, "max": mx, "pct": pct, "cutoff": cutoff, "scored": scored, "any": any(r.awarded is not None for r in rows),
            "result": ("Qualified" if pct >= cutoff else "Not qualified") if scored else "Not evaluated"}


def _forward_checks(db: Session, t: Tender, prof: BidProfile, target: dict) -> None:
    miss = []
    if not (t.customer_id or (t.customer_name or "").strip()):
        miss.append("Customer")
    if not (t.portal_ref_number or "").strip():
        miss.append("Tender / NIT number")
    if not t.submission_date:
        miss.append("Bid submission date")
    cd = t.custom_data if isinstance(t.custom_data, dict) else {}
    miss += [f.label for f in required_custom(db) if cd.get(f.field_key) in (None, "", False)]
    if miss:
        raise HTTPException(422, {"message": "Fill the mandatory fields before moving forward: " + ", ".join(miss), "missing": miss})
    name = target["name"]
    if re.search(r"submi", name, re.I):
        ensure_checklists(db, t)
        docs = [i.label for i in _items(db, t, "document") if not i.ok]
        if docs:
            raise HTTPException(422, {"message": "Complete the mandatory documents before submission: " + ", ".join(docs), "documents": docs})
        if config(db).get("block_submission_on_gaps"):
            gaps = [i.label for i in _items(db, t, "eligibility") if not i.ok]
            if gaps:
                raise HTTPException(422, {"message": "Eligibility gaps must be closed before submission: " + "; ".join(gaps), "gaps": gaps})
    if re.search(r"price|negotiat|commercial|auction|combined", name, re.I):
        rows = db.query(BidTechScore).filter(BidTechScore.tender_id == t.id).all()
        tt = tech_totals(rows, float(prof.tech_cutoff_pct if prof.tech_cutoff_pct is not None else config(db)["cutoff_pct"]))
        if tt["scored"] and tt["result"] == "Not qualified":
            raise HTTPException(422, f"Technical score {tt['pct']}% is below the {tt['cutoff']:g}% cut-off – the bid did not qualify for {name}")


def _log(db: Session, cu: User, request: Optional[Request], t: Tender, description: str, data: dict, action: str = "stage_change") -> None:
    from app.core.logging import log_module_action
    db.add(ActivityLog(user_id=cu.id, module="tenders", record_id=t.id, action="status_changed" if action == "stage_change" else action,
                       description=description, icon="🔄", color="#EFF6FF"))
    log_module_action(db=db, user_id=cu.id, module="tenders", action=action, record_id=t.id, record_name=t.tender_title,
                      ip=get_request_ip(request) if request else "", new_data=data)


def _legacy_status(name: str, kind: str, first: bool) -> Optional[str]:
    if kind == "lost":
        return "Closed"
    if kind == "won":
        return None
    if re.search(r"submi", name, re.I):
        return "Submitted"
    if re.search(r"evaluat|price bid|commercial|scoring", name, re.I):
        return "Evaluation"
    if re.search(r"pre-?bid", name, re.I):
        return "Pre-Bid"
    if re.search(r"auction", name, re.I):
        return "Reverse Auction"
    return "Aligned" if first else None


def apply_stage(db: Session, cu: User, request: Optional[Request], t: Tender, prof: BidProfile, st: list[dict], target: dict,
                reason: Optional[str] = None, comment: Optional[str] = None) -> None:
    wf = target["flow"]
    old = db.execute(text("SELECT s.name FROM workflow_record_stages m JOIN workflow_stages s ON s.id = m.stage_id WHERE m.workflow = :w AND m.record_id = :r"),
                     {"w": wf, "r": t.id}).scalar()
    now = now_ist()
    db.execute(text("INSERT INTO workflow_record_stages (workflow, record_id, stage_id, mapped_at) VALUES (:w, :r, :s, :now) "
                    "ON DUPLICATE KEY UPDATE stage_id = VALUES(stage_id), mapped_at = VALUES(mapped_at)"), {"w": wf, "r": t.id, "s": target["id"], "now": now})
    prof.stage_entered_at = now
    prof.pending_stage_id = None
    prof.approval_request_id = None
    opens = [s for s in st if s["kind"] == "open"]
    legacy = _legacy_status(target["name"], target["kind"], bool(opens) and target["id"] == opens[0]["id"])
    if legacy:
        t.tender_status = legacy
    if target["kind"] == "won":
        t.result, t.result_date = "Won", today_ist()
        prof.lost_reason = prof.lost_note = None
    elif target["kind"] == "lost":
        t.result, t.result_date = "Lost", today_ist()
        prof.lost_reason = reason
        prof.lost_note = (comment or "").strip() or None
    elif t.result in ("Won", "Lost", "Cancelled"):
        t.result, t.result_date = "Pending", None             # reopened
        prof.lost_reason = prof.lost_note = None
    t.updated_at = now
    _log(db, cu, request, t, f"Tender stage changed: {old or '—'} → {target['name']}" + (f" · Reason: {reason}" if reason else ""),
         {"from": old, "to": target["name"], "reason": reason, "comment": (comment or "").strip() or None})
    if t.assigned_to and t.assigned_to != cu.id and target["kind"] != "open":
        try:
            from app.services.notification_service import upsert_notification
            upsert_notification(db, t.assigned_to, f"Tender {target['name'].lower()}", f"{ref_of(t)} · {t.tender_title} was marked {target['name']} by {cu.full_name}.",
                                module="tenders", record_id=t.id, action=f"tender_{target['kind']}", send_email=False)
        except Exception as exc:
            logger.warning("tender outcome notification failed: %s", exc)


def can_manage(db: Session, cu: User) -> bool:
    from app.routers.lead_router import MANAGER_ROLES
    return (cu.role or "") in MANAGER_ROLES or user_has_permission(db, cu, "settings.manage")


def move(db: Session, cu: User, request: Request, t: Tender, stage_id: int, *, reason: Optional[str] = None, comment: Optional[str] = None,
         checklist: Optional[list[str]] = None, auto: bool = False) -> dict[str, Any]:
    fl = flows(db, include_inactive=True)
    if not fl:
        raise HTTPException(409, "No tender flow is configured")
    profiles, cur_map = sync(db, [t], fl)
    prof, cur = profiles[t.id], cur_map[t.id]
    flow = flow_map(fl)[cur["flow"]]
    st = flow["stages"]
    target = next((s for s in st if s["id"] == stage_id), None)
    if not target:
        raise HTTPException(422, f"That stage is not part of this tender's flow ({flow['name']})")
    if target["id"] == cur["id"]:
        return {"status": "unchanged", "stage": cur["name"]}
    if prof.pending_stage_id:
        raise HTTPException(409, "A stage change is waiting for approval")
    if cur["kind"] == "won" and t.wrk_order_id:
        raise HTTPException(400, f"Work order {t.wrk_order_id} was created from this tender – its stage can no longer change")
    if cur["kind"] == "won" and target["kind"] != "lost" and not can_manage(db, cu):
        raise HTTPException(403, "Only managers can move a won tender back")
    order = [s["id"] for s in st]
    forward = order.index(target["id"]) > order.index(cur["id"]) and target["kind"] != "lost"
    if target["kind"] == "lost":
        from app.services.lead360_service import lost_reasons
        cfg = lost_reasons(db)
        reason = (reason or "").strip() or None
        if reason and reason not in cfg["reasons"]:
            raise HTTPException(422, "Choose a lost reason from the list")
        if cfg["required"] and not reason:
            raise HTTPException(422, {"message": "Choose why this tender was lost", "lost": True})
    if forward:
        _forward_checks(db, t, prof, target)
        # Guarantees & Deposits v18: bid work (submission stage onwards) stays locked until the required EMD / tender
        # fee / bid-security instruments are entered and approved.
        from app.services.instrument_service import check_bid_gate
        check_bid_gate(db, t, target, st)
        if target["gate"] == "Checklist":
            done = {str(x).strip() for x in checklist or []}
            todo = [i for i in target["checklist"] if i not in done]
            if todo:
                raise HTTPException(422, {"message": f"Complete the checklist for {target['name']}", "checklist": target["checklist"], "missing_items": todo})
            prof.checklist = {**(prof.checklist or {}), target["name"]: list(target["checklist"])}
        if target["gate"] == "Approval":
            if auto:
                return {"status": "unchanged", "stage": cur["name"]}
            from app.services.generic_approval_engine import create_generic_approval_request
            req = create_generic_approval_request(db, tenant_id=getattr(getattr(request.state, "tenant", None), "id", None), requester=cu,
                                                  module_key="tender", action_key="stage", record_id=t.id)
            from app.services.approvals360_service import apply_stage_policy   # Process Designer stage approval policy (chain · threshold · SLA)
            req = apply_stage_policy(db, req, cur.get("flow"), target["name"], cur["name"], float(t.est_value or 0))
            if (req.status or "").strip().lower() != "approved":
                prof.pending_stage_id, prof.approval_request_id = target["id"], req.id
                step = next((s for s in sorted(req.steps or [], key=lambda x: x.step_no) if s.step_no == req.current_step_no), None)
                approver = step.approver.full_name if step is not None and getattr(step, "approver", None) else None
                _log(db, cu, request, t, f"Stage change to {target['name']} sent for approval" + (f" ({approver})" if approver else ""),
                     {"to": target["name"], "approval_request_id": req.id})
                db.commit()
                return {"status": "pending", "stage": cur["name"], "pending_stage": target["name"], "approver": approver,
                        "message": f"“{target['name']}” needs approval – sent to {approver or 'the approver'}"}
    apply_stage(db, cu, request, t, prof, st, target, reason, comment)
    db.commit()
    return {"status": "moved", "stage": target["name"]}


def on_stage_decision(db: Session, request_row, actor: User, remarks: str = "") -> None:
    """Approval engine callback (module "tender", action "stage"): approved ⇒ apply the held stage; rejected ⇒ release it."""
    prof = db.query(BidProfile).filter(BidProfile.approval_request_id == request_row.id).first()
    if not prof or not prof.pending_stage_id:
        return
    t = db.query(Tender).filter(Tender.id == prof.tender_id).first()
    if not t:
        return
    status = (request_row.status or "").strip().lower()
    fl = flows(db, include_inactive=True)
    flow = flow_map(fl).get(prof.flow or "") or default_flow(fl)
    st = flow["stages"] if flow else []
    target = next((s for s in st if s["id"] == prof.pending_stage_id), None)
    from app.services.notification_service import upsert_notification
    if status == "approved" and target:
        apply_stage(db, actor, None, t, prof, st, target)
        try:
            if t.assigned_to:
                upsert_notification(db, t.assigned_to, "Stage change approved", f"Tender {ref_of(t)} moved to {target['name']} after approval.",
                                    module="tenders", record_id=t.id, action="stage_approved", send_email=False)
        except Exception as exc:
            logger.warning("tender stage approval notification failed: %s", exc)
    elif status == "rejected":
        name = target["name"] if target else "the requested stage"
        prof.pending_stage_id = None
        prof.approval_request_id = None
        _log(db, actor, None, t, f"Stage change to {name} rejected" + (f" – {remarks}" if remarks else ""), {"to": name, "rejected": True, "remarks": remarks or None})
        try:
            if t.assigned_to:
                upsert_notification(db, t.assigned_to, "Stage change rejected", f"Moving tender {ref_of(t)} to {name} was rejected" + (f": {remarks}" if remarks else "."),
                                    module="tenders", record_id=t.id, action="stage_rejected", send_email=False)
        except Exception as exc:
            logger.warning("tender stage rejection notification failed: %s", exc)


def on_price_decision(db: Session, request_row, actor: User, remarks: str = "") -> None:
    """Approval engine callback (module "tender", action "price_bid"): Freeze & send for approval."""
    prof = db.query(BidProfile).filter(BidProfile.price_request_id == request_row.id).first()
    if not prof:
        return
    t = db.query(Tender).filter(Tender.id == prof.tender_id).first()
    status = (request_row.status or "").strip().lower()
    if status not in ("approved", "rejected") or not t:
        return
    prof.price_status = status
    _log(db, actor, None, t, f"Price bid {status}" + (f" – {remarks}" if remarks else ""), {"price_bid": status, "remarks": remarks or None}, action="price_bid")
    try:
        from app.services.notification_service import upsert_notification
        if t.assigned_to:
            upsert_notification(db, t.assigned_to, f"Price bid {status}", f"The frozen price bid of tender {ref_of(t)} was {status}" + (f": {remarks}" if remarks else "."),
                                module="tenders", record_id=t.id, action=f"price_{status}", send_email=False)
    except Exception as exc:
        logger.warning("price bid notification failed: %s", exc)


def maybe_auto_advance(db: Session, cu: User, request: Request, t: Tender) -> Optional[str]:
    """Prototype: qualifying bids move to the next (price bid) stage automatically if the auto-advance rule is on.
    Only from a technical-evaluation stage, only when every criterion is scored and only into an ungated stage."""
    cfg = config(db)
    if not cfg.get("auto_advance"):
        return None
    fl = flows(db, include_inactive=True)
    profiles, cur_map = sync(db, [t], fl)
    prof, cur = profiles[t.id], cur_map[t.id]
    st = flow_map(fl)[cur["flow"]]["stages"]
    if cur["kind"] != "open" or not re.search(r"evaluat", cur["name"], re.I) or prof.pending_stage_id:
        return None
    rows = db.query(BidTechScore).filter(BidTechScore.tender_id == t.id).all()
    tt = tech_totals(rows, float(prof.tech_cutoff_pct if prof.tech_cutoff_pct is not None else cfg["cutoff_pct"]))
    if not tt["scored"] or tt["result"] != "Qualified":
        return None
    opens = [s for s in st if s["kind"] == "open"]
    i = next(i for i, s in enumerate(opens) if s["id"] == cur["id"])
    nxt = opens[i + 1] if i + 1 < len(opens) else None
    if not nxt or nxt["gate"] != "None":
        return None
    try:
        res = move(db, cu, request, t, nxt["id"], auto=True)
    except HTTPException:
        db.rollback()
        return None
    return nxt["name"] if res.get("status") == "moved" else None


# ─── per-bid lists seeded from configuration ─────────────────────────────────

def ensure_checklists(db: Session, t: Tender) -> None:
    have = {k for (k,) in db.query(BidChecklistItem.kind).filter(BidChecklistItem.tender_id == t.id).distinct().all()}
    cfg = None
    for kind, key in (("eligibility", "eligibility"), ("document", "documents"), ("document_commercial", "documents_commercial"), ("document_final", "documents_final")):
        if kind in have:
            continue
        cfg = cfg or config(db)
        for i, label in enumerate(cfg.get(key) or []):
            db.add(BidChecklistItem(tender_id=t.id, kind=kind, label=label, position=i, ok=False))
    if not db.query(BidTechScore.id).filter(BidTechScore.tender_id == t.id).first():
        cfg = cfg or config(db)
        for i, (crit, mx) in enumerate(cfg.get("tech_criteria") or []):
            db.add(BidTechScore(tender_id=t.id, criterion=crit, max_marks=mx, awarded=None, position=i))
    if not db.query(BidFeeItem.id).filter(BidFeeItem.tender_id == t.id).first():
        cfg = cfg or config(db)
        prefill = {"Tender fee": t.tender_fee_amount, "EMD": t.emd_amount, "Performance BG": t.pbg_amount}
        for i, (label, mode) in enumerate(cfg.get("fee_items") or []):
            amt = prefill.get(label)
            db.add(BidFeeItem(tender_id=t.id, label=label, amount=amt, payment_mode=mode, status="pending" if amt else "not_due", position=i))
    db.flush()


# ─── calculations ─────────────────────────────────────────────────────────────

def boq_lines(db: Session, t: Tender) -> list[TenderProduct]:
    return db.query(TenderProduct).filter(TenderProduct.tender_id == t.id, TenderProduct.is_final_boq == True).order_by(  # noqa: E712
        TenderProduct.sort_order, TenderProduct.id).all()


def pct_of(prof: BidProfile, cfg: dict) -> tuple[float, float, float]:
    oh = float(prof.overhead_pct) if prof.overhead_pct is not None else float(cfg["overhead_pct"])
    cg = float(prof.contingency_pct) if prof.contingency_pct is not None else float(cfg["contingency_pct"])
    mg = float(prof.margin_pct) if prof.margin_pct is not None else float(cfg["margin_pct"])
    return oh, cg, mg


def wk_tot(lines: list[TenderProduct], oh: float, cg: float, mg: float) -> dict[str, float]:
    """Prototype wkTot(): base = Σ qty × rate; overheads / contingency on base; quoted price = total cost × (1 + margin)."""
    base = sum(float(l.quantity or 0) * float(l.unit_price or 0) for l in lines)
    o, c = base * oh / 100, base * cg / 100
    cost = base + o + c
    price = cost * (1 + mg / 100)
    return {"base": round(base, 2), "oh": round(o, 2), "cg": round(c, 2), "cost": round(cost, 2), "price": round(price, 2), "margin": round(price - cost, 2)}


def our_price(db: Session, t: Tender, prof: BidProfile, cfg: dict) -> tuple[float, bool]:
    """Financial tab price: the last synced quoted price (falls back to the live Workings price until synced)."""
    if prof.quoted_price is not None:
        return float(prof.quoted_price), True
    return wk_tot(boq_lines(db, t), *pct_of(prof, cfg))["price"], False


def ranking(db: Session, t: Tender, our: float) -> tuple[list[dict], int]:
    rows = db.query(BidCompetitorPrice, Competitor.name).join(Competitor, Competitor.id == BidCompetitorPrice.competitor_id).filter(
        BidCompetitorPrice.tender_id == t.id).all()
    bd = [{"n": "Our bid", "p": our, "me": True, "id": None, "competitor_id": None}] + [
        {"n": nm, "p": float(c.amount), "me": False, "id": c.id, "competitor_id": c.competitor_id} for c, nm in rows]
    bd.sort(key=lambda b: (b["p"], not b["me"]))
    rank = next(i for i, b in enumerate(bd) if b["me"]) + 1
    return bd, rank


def store_ranking(db: Session, t: Tender, our: float) -> None:
    """Keep the legacy L-position fields (reports, loss analysis) in step with the price comparison."""
    bd, rank = ranking(db, t, our)
    if len(bd) < 2 or not our:
        return
    top = (bd + [{"n": None, "p": None}] * 3)[:3]
    db.execute(text("UPDATE tenders SET our_bid_amount = :our, l_position = :lp, l1_company = :c1, l1_amount = :a1, l2_company = :c2, l2_amount = :a2, "
                    "l3_company = :c3, l3_amount = :a3 WHERE id = :id"),
               {"our": our, "lp": f"L{rank}" if rank <= 3 else None, "id": t.id,
                **{f"c{i + 1}": (None if b.get("me") else b["n"]) if b["n"] else None for i, b in enumerate(top)},
                **{f"a{i + 1}": b["p"] for i, b in enumerate(top)}})


# ─── tender page ──────────────────────────────────────────────────────────────

def _d(v) -> Optional[str]:
    return v.isoformat() if v else None


def _location(db: Session, loc_id: Optional[int]) -> Optional[dict]:
    if not loc_id:
        return None
    r = db.execute(text("SELECT l.id, l.name, l.item_type, p.name AS parent FROM location_masters l LEFT JOIN location_masters p ON p.id = l.parent_id "
                        "WHERE l.id = :i"), {"i": loc_id}).mappings().first()
    return {"id": r["id"], "name": r["name"] + (f", {r['parent']}" if r["parent"] and r["item_type"] == "district" else "")} if r else None


def _journey(db: Session, t: Tender, stage: dict) -> dict[str, Any]:
    from app.models.all_models import Lead, WorkOrder
    lead = db.query(Lead).filter(Lead.id == t.lead_id).first() if t.lead_id else None
    wo = db.query(WorkOrder).filter(WorkOrder.tender_id == t.id).order_by(WorkOrder.id.desc()).first()
    if not wo and t.wrk_order_id:
        wo = db.query(WorkOrder).filter(WorkOrder.wo_number == t.wrk_order_id).first()
    steps = []
    is_lead = bool(lead) and lead.lead_type != "direct_opportunity"
    is_opp = bool(lead) and (lead.lead_type == "direct_opportunity" or bool(lead.opportunity_ref_id))
    steps.append({"k": "lead", "label": "Lead", "icon": "funnel", "ref": lead.lead_ref_id if is_lead else None,
                  "stage": ("Converted" if lead.status in ("Converted", "Opportunity Created") else lead.status) if is_lead else None,
                  "value": float(lead.est_value or 0) if is_lead else None, "date": _d(lead.created_at.date()) if is_lead and lead.created_at else None,
                  "route": f"/leads?open={lead.id}" if is_lead else None, "note": "not started"})
    steps.append({"k": "deal", "label": "Deal", "icon": "target", "ref": lead.opportunity_ref_id if is_opp else None,
                  "stage": ("Won" if lead.status == "Converted" else lead.status) if is_opp else None, "value": float(lead.est_value or 0) if is_opp else None,
                  "date": _d((lead.opportunity_created_at or lead.created_at).date()) if is_opp and (lead.opportunity_created_at or lead.created_at) else None,
                  "route": f"/opportunities?open={lead.id}" if is_opp else None, "note": "skipped – converted directly" if is_lead or not lead else "not started"})
    steps.append({"k": "tender", "label": "Tender / bid", "icon": "file", "ref": ref_of(t), "stage": stage["name"], "value": float(t.est_value or 0), "me": True,
                  "date": _d(t.created_at.date()) if t.created_at else None, "route": None, "note": None})
    steps.append({"k": "order", "label": "Work order", "icon": "brief", "ref": wo.wo_number if wo else (t.wrk_order_id or None), "stage": wo.status if wo else None,
                  "value": float(wo.wo_value or wo.po_value or 0) if wo else None, "date": _d(wo.created_at.date()) if wo and wo.created_at else None,
                  "route": f"/workorders/{t.id}/edit" if (wo or t.wrk_order_id) else None, "note": "not started"})
    for s in steps:
        s["done"] = bool(s["ref"])
    return {"id": f"J-{(lead.id if lead else t.id):04d}", "steps": steps}


def detail(db: Session, cu: User, t: Tender) -> dict[str, Any]:
    cfg = config(db)
    fl = flows(db, include_inactive=True)
    profiles, cur_map = sync(db, [t], fl)
    prof, cur = profiles[t.id], cur_map[t.id]
    flow = flow_map(fl)[cur["flow"]]
    st = flow["stages"]
    ensure_checklists(db, t)
    db.commit()
    own = names(db, [t.assigned_to])
    portal = db.query(LeadSource.name).filter(LeadSource.id == t.source_id).scalar() if t.source_id else None
    category = db.query(LeadCategory.name).filter(LeadCategory.id == prof.category_id).scalar() if prof.category_id else None
    oem = db.query(OEM.name).filter(OEM.id == prof.oem_id).scalar() if prof.oem_id else None
    extra = db.execute(text("SELECT tech_bid_date, final_bid_amount, financial_bid_date FROM tenders WHERE id = :i"), {"i": t.id}).mappings().first() or {}
    opens = [s for s in st if s["kind"] == "open"]
    ci = next((i for i, s in enumerate(st) if s["id"] == cur["id"]), 0)
    nxt = next((s for s in st[ci + 1:] if s["kind"] == "open"), None)
    pending = None
    if prof.pending_stage_id:
        ps = next((s for s in st if s["id"] == prof.pending_stage_id), None)
        pending = {"stage": ps["name"] if ps else None, "approval_request_id": prof.approval_request_id}
    # Workings
    oh, cg, mg = pct_of(prof, cfg)
    lines = boq_lines(db, t)
    wk = wk_tot(lines, oh, cg, mg)
    est = float(t.est_value or 0)
    initial = db.query(TenderProduct.id).filter(TenderProduct.tender_id == t.id, TenderProduct.is_final_boq == False).count()  # noqa: E712
    # Tech
    cutoff = float(prof.tech_cutoff_pct) if prof.tech_cutoff_pct is not None else float(cfg["cutoff_pct"])
    tech_rows = db.query(BidTechScore).filter(BidTechScore.tender_id == t.id).order_by(BidTechScore.position, BidTechScore.id).all()
    # Financial
    our, synced = our_price(db, t, prof, cfg)
    bd, rank = ranking(db, t, our)
    pbg = float(prof.pbg_pct) if prof.pbg_pct is not None else float(cfg["pbg_pct"])
    gst = float(cfg["gst_pct"])
    rounds = db.query(BidNegotiationRound).filter(BidNegotiationRound.tender_id == t.id).order_by(BidNegotiationRound.round_no.desc()).all()
    rnames = names(db, [r.created_by for r in rounds])
    from app.models.all_models import EMDBG
    instruments = db.query(EMDBG).filter(EMDBG.tender_id == t.id).order_by(EMDBG.id).all()
    today = today_ist()
    # PO & consignee
    cons = db.query(TenderConsignee).filter(TenderConsignee.tender_id == t.id).order_by(TenderConsignee.id).all()
    qty = dict(db.execute(text("SELECT id, qty_share FROM tender_consignees WHERE tender_id = :t"), {"t": t.id}).all())
    corr = db.query(BidCorrigendum).filter(BidCorrigendum.tender_id == t.id).order_by(BidCorrigendum.corr_date, BidCorrigendum.id).all()
    fee_items = db.query(BidFeeItem).filter(BidFeeItem.tender_id == t.id).order_by(BidFeeItem.position, BidFeeItem.id).all()
    penalty = db.query(BidPenaltyClause).filter(BidPenaltyClause.tender_id == t.id).order_by(BidPenaltyClause.position, BidPenaltyClause.id).all()
    milestones = db.query(BidPaymentMilestone).filter(BidPaymentMilestone.tender_id == t.id).order_by(BidPaymentMilestone.position, BidPaymentMilestone.id).all()
    labels = {f.field_key: f.label for f in db.query(FormField).filter(FormField.module == "tenders").all()}
    custom = t.custom_data if isinstance(t.custom_data, dict) else {}
    loc = _location(db, prof.location_id)
    sla = sla_state(prof, cur)
    from app.services.lead360_service import lost_reasons
    hero = _hero(db, t, prof, cur, st, flow, instruments, oem, portal, sla, today)
    vert_id = getattr(t, "business_vertical_id", None)
    vert = (verticals(db, [t]).get(t.id) if vert_id else None)
    return {
        "id": t.id, "ref": ref_of(t), "title": t.tender_title or "", "nit": t.portal_ref_number or "", "customer": t.customer_name or "", "customer_id": t.customer_id,
        "value": est, "submit": _d(t.submission_date), "owner": own.get(t.assigned_to), "owner_id": t.assigned_to,
        "stages": st, "stage": cur, "next": nxt, "pending": pending, "sla": sla, "progress": {"index": next((i + 1 for i, s in enumerate(opens) if s["id"] == cur["id"]), len(opens)), "of": len(opens)},
        "flow": {"key": flow["key"], "name": flow["name"]}, "flows": [{"key": f["key"], "name": f["name"]} for f in fl if f["active"] or f["key"] == flow["key"]],
        "hero": hero, "created": _d(t.created_at.date()) if t.created_at else None,
        "lost": {"reason": prof.lost_reason, "note": prof.lost_note} if cur["kind"] == "lost" else None,
        "journey": _journey(db, t, cur),
        "basic": {
            "title": t.tender_title or "", "nit": t.portal_ref_number or "", "customer": {"id": t.customer_id, "name": t.customer_name} if t.customer_id else None,
            "portal": {"id": t.source_id, "name": portal} if t.source_id else None, "category": {"id": prof.category_id, "name": category} if prof.category_id else None,
            "location": loc, "owner": {"id": t.assigned_to, "name": own.get(t.assigned_to)} if t.assigned_to else None,
            "oem": {"id": prof.oem_id, "name": oem} if prof.oem_id else None, "value": est, "emd": float(t.emd_amount or 0), "fee": float(t.tender_fee_amount or 0),
            "custom": [[labels.get(k, k.replace("_", " ").capitalize()), v if not isinstance(v, (dict, list)) else json.dumps(v)] for k, v in custom.items()],
            "custom_data": custom, "vertical": {"id": vert_id, "name": vert} if vert_id else None, "flow": {"id": flow["key"], "name": flow["name"]},
        },
        "details": {
            "published": _d(t.published_date), "prebid": _d(t.pre_bid_date), "submit": _d(t.submission_date), "opening": _d(extra.get("tech_bid_date")),
            "opening2": _d(extra.get("financial_bid_date")),
            "validity": prof.bid_validity_days if prof.bid_validity_days is not None else cfg["bid_validity_days"], "scope": t.sow or "",
            "selection_method": prof.selection_method or "", "jv_allowed": bool(prof.jv_allowed), "jv_member_count": prof.jv_member_count,
            "gst_applicable": True if prof.gst_applicable is None else bool(prof.gst_applicable),
            "corrigenda": [{"id": c.id, "n": c.number, "t": c.description, "d": _d(c.corr_date)} for c in corr],
            "eligibility": [{"id": i.id, "t": i.label, "ok": bool(i.ok)} for i in _items(db, t, "eligibility")],
            "documents": [{"id": i.id, "t": i.label, "ok": bool(i.ok), "document_id": i.document_id, "document_name": i.document_name} for i in _items(db, t, "document")],
            "documents_commercial": [{"id": i.id, "t": i.label, "ok": bool(i.ok), "document_id": i.document_id, "document_name": i.document_name} for i in _items(db, t, "document_commercial")],
            "documents_final": [{"id": i.id, "t": i.label, "ok": bool(i.ok), "document_id": i.document_id, "document_name": i.document_name} for i in _items(db, t, "document_final")],
            "fee_items": [{"id": f.id, "label": f.label, "amount": float(f.amount) if f.amount is not None else None, "mode": f.payment_mode or "",
                          "stakeholder": f.stakeholder or "", "cutoff": _d(f.cutoff_date), "document_id": f.document_id, "document_name": f.document_name,
                          "status": f.status} for f in fee_items],
            "penalty": [{"id": p.id, "desc": p.description, "amount": p.penalty_amount or "", "remarks": p.remarks or ""} for p in penalty],
            "milestones": [{"id": m.id, "milestone": m.milestone, "desc": m.description or "", "remarks": m.remarks or ""} for m in milestones],
        },
        "workings": {
            "lines": [{"id": l.id, "item": l.product_name or "", "product_id": l.product_id, "oem_id": l.oem_id, "oem": l.oem_name or "",
                       "qty": float(l.quantity or 0), "rate": float(l.unit_price or 0), "amount": round(float(l.quantity or 0) * float(l.unit_price or 0), 2)} for l in lines],
            "oh_pct": oh, "cg_pct": cg, "mg_pct": mg, **wk, "vs": round((wk["price"] / est - 1) * 100, 1) if est and wk["price"] else None,
            "synced": float(prof.quoted_price) if prof.quoted_price is not None else None, "synced_at": prof.synced_at.isoformat() if prof.synced_at else None,
            "initial_products": initial, "locked": prof.price_status in ("pending", "approved"),
        },
        "tech": {"rows": [{"id": r.id, "c": r.criterion, "w": float(r.max_marks), "s": None if r.awarded is None else float(r.awarded), "rm": r.remark or ""} for r in tech_rows],
                 **tech_totals(tech_rows, cutoff), "auto_advance": bool(cfg.get("auto_advance"))},
        "financial": {
            "our": our, "synced": synced, "rank": rank, "l1": bd[0]["p"] if bd else our, "bids": bd, "gst_pct": gst, "gst": round(our * gst / 100, 2),
            "total": round(our * (1 + gst / 100), 2), "pbg_pct": pbg, "pbg": round(our * pbg / 100, 2), "emd": float(t.emd_amount or 0), "pay": t.pmnt_terms or "",
            "final": float(extra.get("final_bid_amount")) if extra.get("final_bid_amount") is not None else None,
            "price_status": prof.price_status, "rounds": [{"n": r.round_no, "p": float(r.our_price), "note": r.note or "", "by": rnames.get(r.created_by, ""),
                                                          "at": r.created_at.isoformat() if r.created_at else None} for r in rounds],
            "instruments": [{"id": e.id, "ref": e.reference_num, "type": e.instrument_type, "amount": float(e.amount or 0), "bank": e.bank_name,
                             "expiry": _d(e.expiry_date), "status": e.status, "days": (e.expiry_date - today).days if e.expiry_date else None} for e in instruments],
            "emd_alert_days": cfg["emd_alert_days"],
        },
        "po": {
            "no": t.po_num or "", "date": _d(t.po_date), "value": float(t.po_value or 0) if t.po_value is not None else None, "deliv": prof.delivery_period or "",
            "ld": prof.ld_terms or "", "ack": bool(prof.po_ack), "won": cur["kind"] == "won", "wo": t.wrk_order_id,
            "consignees": [{"id": c.id, "name": c.consignee_name, "loc": ", ".join(x for x in (c.city, c.state) if x), "qty": qty.get(c.id) or "",
                            "contact": c.contact_person or "", "del": _d(c.delivery_date)} for c in cons],
        },
        "lost_reasons": lost_reasons(db),
        "history": _history(db, t),
    }


def _hero(db: Session, t: Tender, prof: BidProfile, cur: dict, st: list[dict], flow: dict, instruments, oem: Optional[str], portal: Optional[str],
          sla: Optional[dict], today: date) -> dict[str, Any]:
    """Prototype recHero('tenders'): tiles Bid value · EMD · Submission · Portal · OEM · Published, the stage progress of
    the tender's flow and the signal chips (customer health, EMD furnished, SLA, deadline, approvals)."""
    opens = [s for s in st if s["kind"] == "open"]
    i = next((n for n, s in enumerate(opens) if s["id"] == cur["id"]), -1)
    pct = 100 if cur["kind"] != "open" else round((i + 1) / (len(opens) + 1) * 100)
    emd = float(t.emd_amount or 0)
    furnished = any("emd" in (e.instrument_type or "").lower() for e in instruments) or bool(getattr(t, "emd_emdbg_id", None))
    sub_in = (t.submission_date - today).days if t.submission_date else None
    pub_ago = (today - t.published_date).days if t.published_date else None
    sig: list[dict] = []
    if t.customer_id:
        try:
            from app.services.customer360_service import account_metrics
            h = (account_metrics(db, {t.customer_id}).get(t.customer_id) or {}).get("health")
            if h is not None:
                sig.append({"t": "ok" if h >= 70 else "wa" if h >= 50 else "ba", "s": f"Customer health {h}"})
        except Exception:
            db.rollback()
            logger.warning("customer health for tender %s failed", t.id, exc_info=True)
    if emd and not furnished and cur["kind"] == "open":
        sig.append({"t": "wa", "s": "EMD not yet furnished"})
    if cur["kind"] == "open" and sub_in is not None and sub_in < 0:
        sig.append({"t": "ba", "s": f"Submission overdue by {-sub_in} d"})
    elif cur["kind"] == "open" and sub_in is not None and sub_in <= 7:
        sig.append({"t": "wa", "s": f"Submission in {sub_in} d" if sub_in else "Submission today"})
    if sla and sla["state"] == "breached":
        sig.append({"t": "ba", "s": f"SLA breached by {-sla['left']} d in {cur['name']}"})
    if prof.pending_stage_id:
        sig.append({"t": "wa", "s": "Stage change awaiting approval"})
    if prof.price_status == "pending":
        sig.append({"t": "wa", "s": "Price bid awaiting approval"})
    return {"value": float(t.est_value or 0), "emd": emd, "emd_furnished": furnished, "submit": _d(t.submission_date), "submit_in": sub_in,
            "portal": portal, "oem": oem, "published": _d(t.published_date), "published_ago": pub_ago,
            "stage_no": i + 1 if i >= 0 else None, "stages_of": len(opens), "pct": pct, "kind": cur["kind"], "flow": flow["name"], "signals": sig}


def _history(db: Session, t: Tender) -> list[dict[str, Any]]:
    """Workflow audit history shown in the journey's Full timeline (stage changes, approvals, price, corrigenda, WO)."""
    rows = db.query(ActivityLog).filter(ActivityLog.module == "tenders", ActivityLog.record_id == t.id).order_by(ActivityLog.created_at.desc(), ActivityLog.id.desc()).limit(200).all()
    who = names(db, [r.user_id for r in rows])
    return [{"t": r.description, "a": r.action, "by": who.get(r.user_id, ""), "d": r.created_at.isoformat() if r.created_at else None} for r in rows]
