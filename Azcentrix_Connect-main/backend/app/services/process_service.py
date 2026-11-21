"""Process Designer (prototype v17 R.workflow + flow manager) – queries and writes.

One screen = one GET /overview: every workflow of the company with its stages, the per-stage record counts (five
GROUP BY queries, no per-row lookups), the designer extras (one SELECT), config (one SELECT) and lifecycles (one SELECT).

Where stages live
  deal_*   deal pipelines – workflow_definitions / workflow_stages via deal_service (boards follow at once)
  tender   the tender workflow – via bid_service (templates via the platform's apply_to_tenant)
  lead     fixed – leads.status enum (lead360_service.STAGES): names / order fixed, SLA·gate·owner·checklist in extras
  quote    fixed – quotations.status enum
  wo       fixed – work_orders.status enum
  lc_*     order lifecycles (AMC, warranty …) – process_lifecycles (stages as JSON)
Exit criteria, "on entering", forecast category and the approval policy of every stage live in process_stage_extras.
"""
from __future__ import annotations

import logging
import re
import threading
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.core.timezone import now_ist
from app.models.all_models import Lead, Quotation, Role, User, WorkOrder
from app.models.process import PROCESS_TABLES, ProcessConfig, ProcessLifecycle, ProcessStageExtra
from app.services import bid_service, deal_service
from app.services.lead360_service import STAGES as LEAD_STAGES

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()

GATES = ("None", "Approval", "Checklist")
KINDS = ("open", "won", "lost")
FORECASTS = ("Pipeline", "Best case", "Commit", "Closed", "Omitted")
OBJECTS = [("customers", "Customers & Contacts"), ("leads", "Leads"), ("opps", "Deals"), ("tenders", "Bids & Tenders"), ("quotes", "Quotes"), ("wo", "Orders & Projects")]
BIZ = ["B2B", "B2C", "B2G / Institutional", "Channel / Partner"]
CREATES = ("tenders", "quotes", "wo", "none")
LC_TRIGGERS = ("manual", "closure", "won")
# prototype TPL – "Apply bid template…" (labels → bid_service preset keys)
TEMPLATES = [("EPC tender-led · 9 steps", "t1"), ("Defence & OEM-heavy · 11 steps", "t3"), ("Lean bidding · 6 steps", "t5"), ("Quotation-first · 4 steps", "t6")]
# prototype OLTPL – "New order lifecycle · Start from"
LC_TEMPLATES: dict[str, Optional[list[str]]] = {
    "AMC / service contract": ["Contract Signed|3", "Visit Schedule|10", "Preventive Maintenance|90", "Breakdown Support|30", "Renewal Due|30"],
    "Warranty & support": ["Handover|3", "Warranty Period|365", "Extended Support|90"],
    "Rental / lease": ["Agreement|5", "Delivered|10", "In Use|180", "Return & Inspection|10"],
    "Copy of project lifecycle": None,
}
# Fixed flows (status enums of the record tables): name | kind | default SLA days
QUOTE_STAGES = [("Draft", "open", 2), ("Sent", "open", 1), ("Approved", "open", 7), ("Accepted", "won", 0), ("Rejected", "lost", 0)]
WO_STAGES = [("Draft", "open", 3), ("Confirmed", "open", 5), ("In Progress", "open", 30), ("On Hold", "open", 15), ("Delayed", "open", 10), ("Completed", "open", 5),
             ("Closed", "won", 0), ("Cancelled", "lost", 0)]
LEAD_TARGETS = ("opps", "tenders", "quotes", "wo")
DEFAULT_CONV = {"lead": {"stage": "", "auto": False, "type": "Tender", "acct": True, "to": "opps",
                         "map": {"Company → Deal name": True, "Contact → Primary contact": True, "Expected value → Amount": True, "Source → Source": True, "Interest → Description": True}},
                "quote": {"auto": False}, "tender": {"auto": False}}
_KEY_RE = re.compile(r"^[a-z0-9_]{2,40}$")


# ─── schema ───────────────────────────────────────────────────────────────────

def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        deal_service.ensure_schema(db)
        bid_service.ensure_schema(db)
        bind = db.get_bind()
        for t in PROCESS_TABLES:
            t.create(bind=bind, checkfirst=True)
        db.commit()
        _READY.add(slug)


def ensure_schema_all_tenants() -> None:
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant
    master = MasterSessionLocal()
    try:
        slugs = [t.slug for t in master.query(Tenant.slug).all()]
    except Exception as exc:  # pragma: no cover
        logger.warning("Process schema sync: unable to list tenants: %s", exc)
        return
    finally:
        master.close()
    for slug in slugs:
        try:
            db = get_tenant_session(slug)
            try:
                db.info["tenant_slug"] = slug
                ensure_schema(db)
            finally:
                db.close()
        except Exception as exc:
            logger.warning("Process schema sync failed for %s: %s", slug, exc)


# ─── config ───────────────────────────────────────────────────────────────────

def _config(db: Session) -> dict[str, Any]:
    rows = db.query(ProcessConfig.key, ProcessConfig.value).all()
    cfg = {k: v for k, v in rows if v is not None}
    conv = cfg.get("conv") or {}
    cfg["conv"] = {"lead": {**DEFAULT_CONV["lead"], **(conv.get("lead") or {}), "map": {**DEFAULT_CONV["lead"]["map"], **((conv.get("lead") or {}).get("map") or {})}},
                   "quote": {**DEFAULT_CONV["quote"], **(conv.get("quote") or {})}, "tender": {**DEFAULT_CONV["tender"], **(conv.get("tender") or {})}}
    cfg.setdefault("names", {})
    cfg.setdefault("objects", {})
    cfg.setdefault("pipelines", {})
    cfg.setdefault("published", {"version": 3, "at": None, "by": None})
    return cfg


def set_config(db: Session, cu: User, key: str, value: Any) -> None:
    row = db.get(ProcessConfig, key)
    if row is None:
        db.add(ProcessConfig(key=key, value=value, updated_by=cu.id))
    else:
        row.value, row.updated_by = value, cu.id
    db.commit()


def save_names(db: Session, cu: User, names: dict) -> dict:
    keys = {k for k, _ in OBJECTS}
    clean = {}
    for k, v in (names or {}).items():
        if k in keys and isinstance(v, list):
            pair = [str(v[0] if len(v) > 0 else "").strip()[:60], str(v[1] if len(v) > 1 else "").strip()[:60]]
            if pair[0] or pair[1]:
                clean[k] = pair
    set_config(db, cu, "names", clean)
    return clean


def save_objects(db: Session, cu: User, objects: dict) -> dict:
    keys = {k for k, _ in OBJECTS}
    clean = {k: bool(v) for k, v in (objects or {}).items() if k in keys}
    set_config(db, cu, "objects", clean)
    return clean


def save_conv(db: Session, cu: User, conv: dict) -> dict:
    cur = _config(db)["conv"]
    lead = conv.get("lead") or {}
    if "stage" in lead:
        cur["lead"]["stage"] = str(lead["stage"] or "")[:100]
    if "type" in lead:
        cur["lead"]["type"] = str(lead["type"] or "")[:60]
    if "to" in lead:
        if lead["to"] not in LEAD_TARGETS:
            raise HTTPException(422, "Unknown lead conversion target")
        cur["lead"]["to"] = lead["to"]
    for k in ("auto", "acct"):
        if k in lead:
            cur["lead"][k] = bool(lead[k])
    if isinstance(lead.get("map"), dict):
        cur["lead"]["map"] = {k: bool(v) for k, v in lead["map"].items() if k in cur["lead"]["map"]}
    for obj in ("quote", "tender"):
        if isinstance(conv.get(obj), dict) and "auto" in conv[obj]:
            cur[obj]["auto"] = bool(conv[obj]["auto"])
    set_config(db, cu, "conv", cur)
    return cur


def save_pipeline_rule(db: Session, cu: User, key: str, patch: dict) -> dict:
    pipes = deal_service.pipeline_by_key(deal_service.pipelines(db, include_inactive=True))
    if key not in pipes:
        raise HTTPException(404, "Pipeline not found")
    rules = _config(db)["pipelines"]
    r = dict(rules.get(key) or {})
    if "creates" in patch:
        if patch["creates"] not in CREATES:
            raise HTTPException(422, "Unknown conversion target")
        r["creates"] = patch["creates"]
        if patch["creates"] in ("tenders", "quotes"):          # keep the engine's destination in step
            deal_service.save_pipeline(db, key, pipes[key]["stages"], None, None, "tender" if patch["creates"] == "tenders" else "quotation", None)
    if "auto" in patch:
        r["auto"] = bool(patch["auto"])
    if "biz" in patch:
        r["biz"] = str(patch["biz"] or "")[:40] if patch["biz"] in BIZ or not patch["biz"] else r.get("biz", "")
    if patch.get("default"):
        dtype = "Quotation" if pipes[key]["destination"] == "quotation" else "Tender"
        for k2, p2 in pipes.items():
            d2 = "Quotation" if p2["destination"] == "quotation" else "Tender"
            if d2 == dtype and (rules.get(k2) or {}).get("biz", "") == r.get("biz", ""):
                rules[k2] = {**(rules.get(k2) or {}), "default": False}
        r["default"] = True
    rules[key] = r
    set_config(db, cu, "pipelines", rules)
    return r


def publish(db: Session, cu: User) -> dict:
    pub = _config(db)["published"]
    pub = {"version": int(pub.get("version") or 3) + 1, "at": now_ist().isoformat(), "by": cu.full_name or cu.email}
    set_config(db, cu, "published", pub)
    return pub


# ─── extras ───────────────────────────────────────────────────────────────────

def _extras(db: Session) -> dict[tuple[str, str], ProcessStageExtra]:
    return {(e.workflow, e.stage_ref): e for e in db.query(ProcessStageExtra).all()}


def _appr(v) -> Optional[dict]:
    if not isinstance(v, dict) or not v.get("chain"):
        return None
    chain = [str(x).strip()[:100] for x in v.get("chain") or [] if str(x).strip()]
    if not chain:
        return None
    try:
        mn = max(0, int(float(v.get("min") or 0)))
        sla = max(1, int(float(v.get("sla") or 24)))
    except (TypeError, ValueError):
        raise HTTPException(422, "Approval threshold and SLA must be numbers")
    return {"chain": chain[:8], "min": mn, "sla": sla, "auto": v.get("auto", True) is not False}


def _upsert_extras(db: Session, cu: User, workflow: str, stages: list[dict], refs: list[str], *, fixed: bool) -> None:
    """One SELECT for the workflow's extras, then an UPDATE / INSERT per stage (bounded by the stage count) and a DELETE
    of extras whose stage is gone."""
    have = {e.stage_ref: e for e in db.query(ProcessStageExtra).filter(ProcessStageExtra.workflow == workflow).all()}
    keep: set[str] = set()
    for s, ref in zip(stages, refs):
        keep.add(ref)
        vals = {"exit_criteria": (str(s.get("exit") or "").strip() or None), "automation": (str(s.get("auto") or "").strip() or None),
                "forecast": s.get("forecast") if s.get("forecast") in FORECASTS else None, "approval": s.get("appr") if s.get("gate") == "Approval" else None,
                "updated_by": cu.id}
        if fixed:
            vals.update({"sla_days": int(s.get("sla") or 0), "gate": s.get("gate") or "None", "owner_role": (s.get("owner_role") or None),
                         "checklist": s.get("checklist") or None})
        row = have.get(ref)
        if row is None:
            if any(v for k, v in vals.items() if k != "updated_by"):
                db.add(ProcessStageExtra(workflow=workflow, stage_ref=ref, **vals))
        else:
            for k, v in vals.items():
                setattr(row, k, v)
    gone = [e.id for ref, e in have.items() if ref not in keep]
    if gone:
        db.query(ProcessStageExtra).filter(ProcessStageExtra.id.in_(gone)).delete(synchronize_session=False)


# ─── stage rows ───────────────────────────────────────────────────────────────

def _stage(ref: str, name: str, kind: str, sla: int, gate: str, owner: Optional[str], checklist, extra: Optional[ProcessStageExtra], n: int,
           prob: Optional[int] = None, *, fixed: bool = False) -> dict:
    if fixed and extra is not None:
        sla = extra.sla_days if extra.sla_days is not None else sla
        gate = extra.gate or gate
        owner = extra.owner_role or owner
        checklist = extra.checklist or checklist
    appr = _appr(extra.approval) if extra is not None else None
    return {"id": ref, "name": name, "kind": kind, "sla": int(sla or 0), "gate": gate if gate in GATES else "None", "owner_role": owner or "",
            "checklist": list(checklist or []), "exit": (extra.exit_criteria if extra else "") or "", "auto": (extra.automation if extra else "") or "",
            "forecast": (extra.forecast if extra else None), "appr": appr, "n": int(n), "prob": prob}


def _forecast(s: dict) -> str:
    if s["forecast"]:
        return s["forecast"]
    if s["kind"] == "won":
        return "Closed"
    if s["kind"] == "lost":
        return "Omitted"
    p = s.get("prob") or 0
    return "Commit" if p >= 70 else "Best case" if p >= 40 else "Pipeline"


def _counts(db: Session) -> dict[str, dict[str, int]]:
    from app.routers.lead_router import _opportunity_clause
    out: dict[str, dict[str, int]] = {"lead": {}, "engine": {}, "quote": {}, "wo": {}, "wo_type": {}}
    for st, n in db.query(Lead.status, func.count(Lead.id)).filter(~_opportunity_clause()).group_by(Lead.status).all():
        out["lead"][str(st or "")] = int(n)
    for sid, n in db.execute(text("SELECT stage_id, COUNT(*) FROM workflow_record_stages GROUP BY stage_id")).all():
        out["engine"][str(sid)] = int(n)
    for st, n in db.query(Quotation.status, func.count(Quotation.id)).group_by(Quotation.status).all():
        out["quote"][str(st or "")] = int(n)
    for st, n in db.query(WorkOrder.status, func.count(WorkOrder.id)).group_by(WorkOrder.status).all():
        out["wo"][str(st or "")] = int(n)
    for t, n in db.query(WorkOrder.wo_type, func.count(WorkOrder.id)).group_by(WorkOrder.wo_type).all():
        out["wo_type"][str(t or "")] = int(n)
    return out


def _lead_flow(ex: dict, cnt: dict) -> list[dict]:
    rows = []
    for s in LEAD_STAGES:
        n = sum(cnt.get(v, 0) for v in s["values"])
        rows.append(_stage(s["key"], s["label"], s["kind"], {"open": 3}.get(s["kind"], 0), "None", None, [], ex.get(("lead", s["key"])), n, fixed=True))
    return rows


def _fixed_flow(key: str, spec: list[tuple[str, str, int]], ex: dict, cnt: dict) -> list[dict]:
    return [_stage(name, name, kind, sla, "None", None, [], ex.get((key, name)), cnt.get(name, 0), fixed=True) for name, kind, sla in spec]


def _engine_flow(key: str, stages: list[dict], ex: dict, cnt: dict, *, deals: bool) -> list[dict]:
    rows = []
    for s in stages:
        ref = str(s["id"])
        rows.append(_stage(ref, s["name"], s["kind"], s["sla"], s["gate"], s.get("owner_role"), s.get("checklist"), ex.get((key, ref)), cnt.get(ref, 0),
                           prob=s.get("prob") if deals else None))
    return rows


def _lifecycle_flow(lc: ProcessLifecycle, ex: dict, cnt_type: dict) -> list[dict]:
    rows = []
    for s in lc.stages or []:
        name = str(s.get("name") or "")
        rows.append(_stage(name, name, s.get("kind") or "open", int(s.get("sla") or 0), s.get("gate") or "None", s.get("owner_role"), s.get("checklist") or [],
                           ex.get((lc.key, name)), 0, fixed=False))
    return rows


# ─── overview ─────────────────────────────────────────────────────────────────

def overview(db: Session, company: str) -> dict[str, Any]:
    cfg = _config(db)
    ex = _extras(db)
    cnt = _counts(db)
    pipes = deal_service.pipelines(db, include_inactive=True)
    rules = cfg["pipelines"]
    flows: list[dict] = []
    flows.append({"key": "lead", "label": "Lead pipeline", "obj": "leads", "fixed": True, "stages": _lead_flow(ex, cnt["lead"])})
    for p in pipes:
        if not p["active"]:
            continue
        r = rules.get(p["key"]) or {}
        st = _engine_flow(p["key"], p["stages"], ex, cnt["engine"], deals=True)
        for s in st:
            s["forecast"] = _forecast(s)
        flows.append({"key": p["key"], "label": f"Deal · {p['label']}", "obj": "opps", "fixed": False, "name": p["name"], "pipe_label": p["label"],
                      "dtype": "Quotation" if p["destination"] == "quotation" else "Tender",
                      "creates": r.get("creates") or ("quotes" if p["destination"] == "quotation" else "tenders"), "auto": bool(r.get("auto")),
                      "biz": r.get("biz") or "", "default": bool(r.get("default")), "stages": st})
    for bf in bid_service.flows(db, include_inactive=False):
        flows.append({"key": bf["key"], "label": f"Tender flow · {bf['name']}", "obj": "tenders", "fixed": False, "name": bf["name"],
                      "default": bool(bf["default"]), "stages": _engine_flow(bf["key"], bf["stages"], ex, cnt["engine"], deals=False)})
    flows.append({"key": "quote", "label": "Quote lifecycle", "obj": "quotes", "fixed": True, "stages": _fixed_flow("quote", QUOTE_STAGES, ex, cnt["quote"])})
    flows.append({"key": "wo", "label": "Order & project lifecycle", "obj": "wo", "fixed": True, "stages": _fixed_flow("wo", WO_STAGES, ex, cnt["wo"])})
    for lc in db.query(ProcessLifecycle).filter(ProcessLifecycle.is_active.is_(True)).order_by(ProcessLifecycle.id).all():
        st = _lifecycle_flow(lc, ex, cnt["wo_type"])
        if st:
            st[0]["n"] = cnt["wo_type"].get(lc.name, 0)
        flows.append({"key": lc.key, "label": f"Contracts · {lc.name}", "obj": "wo", "fixed": False, "lifecycle": True, "id": lc.id, "name": lc.name,
                      "trigger": lc.trigger, "stages": st})
    # defaults for the flow manager: the first pipeline of each deal type is the default unless one is flagged
    for dtype in ("Tender", "Quotation"):
        group = [f for f in flows if f["obj"] == "opps" and f["dtype"] == dtype]
        if group and not any(f["default"] for f in group):
            group[0]["default"] = True
    roles = [r.display_name or r.name for r in db.query(Role).filter(Role.is_active.is_(True)).order_by(Role.level).all()]
    return {"company": company, "published": cfg["published"], "names": cfg["names"], "objects": {k: cfg["objects"].get(k, True) for k, _ in OBJECTS},
            "object_labels": OBJECTS, "conv": cfg["conv"], "flows": flows, "roles": roles, "gates": list(GATES), "forecasts": list(FORECASTS), "biz": BIZ,
            "templates": [{"l": l, "k": k} for l, k in TEMPLATES], "lc_templates": list(LC_TEMPLATES.keys()),
            "records": {"leads": sum(cnt["lead"].values()), "opps": sum(s["n"] for f in flows if f["obj"] == "opps" for s in f["stages"]),
                        "tenders": sum(s["n"] for f in flows if f["obj"] == "tenders" for s in f["stages"]), "quotes": sum(cnt["quote"].values()), "wo": sum(cnt["wo"].values())}}


# ─── saving stages ────────────────────────────────────────────────────────────

def _clean_stages(stages: list[dict], *, fixed: bool, deals: bool) -> list[dict]:
    clean = []
    for s in stages:
        name = str(s.get("name") or "").strip()[:150]
        if not name:
            raise HTTPException(422, "Every stage needs a name")
        kind = s.get("kind") or "open"
        gate = s.get("gate") or "None"
        if kind not in KINDS or gate not in GATES:
            raise HTTPException(422, f"Invalid stage settings for {name}")
        try:
            sla = max(0, min(365, int(s.get("sla") or 0)))
        except (TypeError, ValueError):
            raise HTTPException(422, f"SLA of {name} must be a number of days")
        cl = [str(x).strip()[:150] for x in (s.get("checklist") or []) if str(x).strip()]
        if gate == "Checklist" and not cl:
            raise HTTPException(422, f"{name}: a checklist gate needs at least one item")
        appr = _appr(s.get("appr")) if gate == "Approval" else None
        row = {"id": s.get("id"), "name": name, "kind": kind, "sla": sla, "gate": gate, "owner_role": str(s.get("owner_role") or "").strip()[:100] or None,
               "checklist": cl, "exit": str(s.get("exit") or "")[:300], "auto": str(s.get("auto") or "")[:300], "appr": appr,
               "forecast": s.get("forecast") if s.get("forecast") in FORECASTS else None}
        if appr and not row["owner_role"]:
            row["owner_role"] = appr["chain"][0]
        if deals:
            p = s.get("prob")
            if p is not None:
                try:
                    p = int(p)
                except (TypeError, ValueError):
                    raise HTTPException(422, f"Win % of {name} must be 0–100")
                if not 0 <= p <= 100:
                    raise HTTPException(422, f"Win % of {name} must be 0–100")
            row["probability"] = p
        clean.append(row)
    names = [s["name"].lower() for s in clean]
    if len(set(names)) != len(names):
        raise HTTPException(422, "Stage names must be unique")
    if not fixed and len([s for s in clean if s["kind"] == "open"]) < 2:
        raise HTTPException(422, "A pipeline needs at least two open stages")
    return clean


def save_flow(db: Session, cu: User, key: str, stages: list[dict]) -> None:
    if key == "lead":
        clean = _clean_stages(stages, fixed=True, deals=False)
        allowed = [s["key"] for s in LEAD_STAGES]
        if [s["id"] for s in clean] != allowed:
            raise HTTPException(422, "Lead stages are fixed in this release – only their SLA, gate, owner and checklist can change")
        _upsert_extras(db, cu, "lead", clean, allowed, fixed=True)
    elif key in ("quote", "wo"):
        spec = QUOTE_STAGES if key == "quote" else WO_STAGES
        clean = _clean_stages(stages, fixed=True, deals=False)
        allowed = [n for n, _, _ in spec]
        if [s["id"] for s in clean] != allowed:
            raise HTTPException(422, "These stages are fixed in this release – only their SLA, gate, owner and checklist can change")
        _upsert_extras(db, cu, key, clean, allowed, fixed=True)
    elif key.startswith("deal_"):
        clean = _clean_stages(stages, fixed=False, deals=True)
        deal_service.save_pipeline(db, key, [{"id": _int(s["id"]), "name": s["name"], "kind": s["kind"], "sla": s["sla"], "gate": s["gate"], "owner_role": s["owner_role"],
                                              "checklist": s["checklist"], "probability": s["probability"]} for s in clean], None, None, None, None)
        db.flush()
        refs = _refs_by_name(db, key, clean)
        _upsert_extras(db, cu, key, clean, refs, fixed=False)
    elif key == "tender" or key.startswith("tender_"):
        clean = _clean_stages(stages, fixed=False, deals=False)
        bid_service.save_stages(db, key, [{"id": _int(s["id"]), "name": s["name"], "kind": s["kind"], "sla": s["sla"], "gate": s["gate"], "owner_role": s["owner_role"],
                                           "checklist": s["checklist"]} for s in clean])
        db.flush()
        refs = _refs_by_name(db, key, clean)
        _upsert_extras(db, cu, key, clean, refs, fixed=False)
    elif key.startswith("lc_"):
        lc = db.query(ProcessLifecycle).filter(ProcessLifecycle.key == key, ProcessLifecycle.is_active.is_(True)).first()
        if lc is None:
            raise HTTPException(404, "Lifecycle not found")
        clean = _clean_stages(stages, fixed=False, deals=False)
        if not any(s["kind"] == "won" for s in clean):
            raise HTTPException(422, "A lifecycle needs a closing stage")
        lc.stages = [{"name": s["name"], "kind": s["kind"], "sla": s["sla"], "gate": s["gate"], "owner_role": s["owner_role"], "checklist": s["checklist"]} for s in clean]
        _upsert_extras(db, cu, key, clean, [s["name"] for s in clean], fixed=False)
    else:
        raise HTTPException(404, "Unknown workflow")
    db.commit()


def _int(v) -> Optional[int]:
    try:
        return int(v) if v is not None and str(v).strip() != "" else None
    except (TypeError, ValueError):
        return None


def _refs_by_name(db: Session, workflow: str, clean: list[dict]) -> list[str]:
    rev = db.execute(text("SELECT revision FROM workflow_definitions WHERE workflow = :w"), {"w": workflow}).scalar()
    ids = {str(n).strip().lower(): str(i) for i, n in db.execute(text("SELECT id, name FROM workflow_stages WHERE workflow = :w AND revision = :r"),
                                                                 {"w": workflow, "r": rev}).all()}
    return [ids.get(s["name"].lower(), s["name"]) for s in clean]


# ─── pipelines / lifecycles / templates ───────────────────────────────────────

def create_pipeline(db: Session, cu: User, name: str, copy_from: str, creates: str, biz: str = "", default: bool = False) -> str:
    name = (name or "").strip()[:60]
    if not name:
        raise HTTPException(422, "Name the pipeline")
    if creates not in CREATES:
        raise HTTPException(422, "Unknown conversion target")
    pipes = deal_service.pipeline_by_key(deal_service.pipelines(db, include_inactive=True))
    src = pipes.get(copy_from)
    if src is None:
        raise HTTPException(404, "Pipeline to copy from not found")
    if any(p["name"].lower() == name.lower() or p["label"].lower() == name.lower() for p in pipes.values()):
        raise HTTPException(409, "A pipeline with this name already exists")
    base = "deal_" + (re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:20] or "pipeline")
    key, n = base, 1
    while key in pipes:
        n += 1
        key = f"{base}_{n}"
    dest = "tender" if creates == "tenders" else "quotation" if creates == "quotes" else src["destination"]
    deal_service.create_pipeline(db, key, name, name, dest, [{"name": s["name"], "kind": s["kind"], "sla": s["sla"], "gate": s["gate"], "owner_role": s.get("owner_role"),
                                                              "checklist": s.get("checklist") or None, "probability": s.get("probability")} for s in src["stages"]])
    db.flush()
    # copy the designer extras of the source stages (same names)
    src_ex = {e.stage_ref: e for e in db.query(ProcessStageExtra).filter(ProcessStageExtra.workflow == copy_from).all()}
    if src_ex:
        src_names = {str(s["id"]): s["name"] for s in src["stages"]}
        new_ids = _refs_by_name(db, key, [{"name": n2} for n2 in src_names.values()])
        for (sid, nm), ref in zip(src_names.items(), new_ids):
            e = src_ex.get(sid)
            if e is not None and ref != nm:
                db.add(ProcessStageExtra(workflow=key, stage_ref=ref, exit_criteria=e.exit_criteria, automation=e.automation, forecast=e.forecast, approval=e.approval,
                                         updated_by=cu.id))
    rules = _config(db)["pipelines"]
    rules[key] = {"creates": creates, "auto": False, "biz": biz if biz in BIZ else "", "default": False}
    row = db.get(ProcessConfig, "pipelines")
    if row is None:
        db.add(ProcessConfig(key="pipelines", value=rules, updated_by=cu.id))
    else:
        row.value, row.updated_by = rules, cu.id
    db.commit()
    if default:
        save_pipeline_rule(db, cu, key, {"default": True})
    return key


def rename_pipeline(db: Session, cu: User, key: str, name: str) -> None:
    name = (name or "").strip()[:60]
    if not name:
        raise HTTPException(422, "Name the pipeline")
    pipes = deal_service.pipeline_by_key(deal_service.pipelines(db, include_inactive=True))
    if key not in pipes:
        raise HTTPException(404, "Pipeline not found")
    deal_service.save_pipeline(db, key, pipes[key]["stages"], name, name, None, None)
    db.commit()


def delete_pipeline(db: Session, cu: User, key: str) -> None:
    pipes = deal_service.pipeline_by_key(deal_service.pipelines(db, include_inactive=True))
    p = pipes.get(key)
    if p is None or not p["active"]:
        raise HTTPException(404, "Pipeline not found")
    if len([x for x in pipes.values() if x["active"]]) <= 1:
        raise HTTPException(409, "Keep at least one deal pipeline")
    ids = [s["id"] for s in p["stages"]]
    used = db.execute(text("SELECT COUNT(*) FROM workflow_record_stages WHERE workflow = :w"), {"w": key}).scalar() if ids else 0
    if used:
        raise HTTPException(409, f"{used} deal(s) use this pipeline – move them to another pipeline first")
    deal_service.save_pipeline(db, key, p["stages"], None, None, None, False)
    rules = _config(db)["pipelines"]
    rules.pop(key, None)
    row = db.get(ProcessConfig, "pipelines")
    if row is not None:
        row.value = rules
    db.query(ProcessStageExtra).filter(ProcessStageExtra.workflow == key).delete(synchronize_session=False)
    db.commit()


def _parse_spec(spec: str) -> dict:
    name, sla, gate, owner, req = (spec.split("|") + [""] * 5)[:5]
    return {"name": name, "kind": "open", "sla": int(sla or 0), "gate": gate or "None", "owner_role": owner or None, "checklist": [r for r in req.split(";") if r]}


def create_lifecycle(db: Session, cu: User, name: str, template: str, trigger: str) -> ProcessLifecycle:
    name = (name or "").strip()[:100]
    if not name:
        raise HTTPException(422, "Name the lifecycle")
    if template not in LC_TEMPLATES:
        raise HTTPException(422, "Unknown lifecycle template")
    if trigger not in LC_TRIGGERS:
        raise HTTPException(422, "Unknown trigger")
    if db.query(ProcessLifecycle.id).filter(func.lower(ProcessLifecycle.name) == name.lower(), ProcessLifecycle.is_active.is_(True)).first():
        raise HTTPException(409, "A lifecycle with this name already exists")
    base = "lc_" + (re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:30] or "lifecycle")
    key, n = base, 1
    taken = {k for (k,) in db.query(ProcessLifecycle.key).all()}
    while key in taken:
        n += 1
        key = f"{base}_{n}"
    spec = LC_TEMPLATES[template]
    if spec is None:
        stages = [{"name": nm, "kind": k, "sla": sla, "gate": "None", "owner_role": None, "checklist": []} for nm, k, sla in WO_STAGES if k != "lost"]
    else:
        stages = [_parse_spec(s) for s in spec] + [{"name": "Closed", "kind": "won", "sla": 0, "gate": "None", "owner_role": None, "checklist": []}]
    lc = ProcessLifecycle(key=key, name=name, trigger=trigger, stages=stages, is_active=True, created_by=cu.id)
    db.add(lc)
    db.commit()
    return lc


def delete_lifecycle(db: Session, cu: User, key: str) -> None:
    lc = db.query(ProcessLifecycle).filter(ProcessLifecycle.key == key, ProcessLifecycle.is_active.is_(True)).first()
    if lc is None:
        raise HTTPException(404, "Lifecycle not found")
    lc.is_active = False
    db.query(ProcessStageExtra).filter(ProcessStageExtra.workflow == key).delete(synchronize_session=False)
    db.commit()


def apply_template(db: Session, cu: User, template: str) -> dict:
    from app.models.bids import BidProfile
    from app.services.platform_workflow_templates import WorkflowTemplateError, apply_to_tenant
    key = next((k for l, k in TEMPLATES if k == template or l == template), None)
    if key is None:
        raise HTTPException(404, "Unknown bid template")
    stages = bid_service.preset_stages(key)
    name = next(p[1] for p in bid_service.PRESETS if p[0] == key)
    slug = db.info.get("tenant_slug")
    if not slug:
        raise HTTPException(500, "Tenant not resolved")
    pending = db.query(func.count(BidProfile.tender_id)).filter(BidProfile.pending_stage_id.isnot(None)).scalar()
    if pending:
        raise HTTPException(409, f"{pending} tender stage change(s) are waiting for approval – decide them first")
    db.commit()
    try:
        res = apply_to_tenant(slug, key, name, stages, actor=cu.full_name or cu.email or str(cu.id))
    except WorkflowTemplateError as exc:
        raise HTTPException(422, str(exc))
    db.query(ProcessStageExtra).filter(ProcessStageExtra.workflow == "tender").delete(synchronize_session=False)   # stage ids changed
    db.commit()
    return {"template": key, "name": name, **{k: res.get(k) for k in ("revision", "records", "records_moved")}}


def approval_policies(db: Session, flows: list[dict]) -> list[dict]:
    rows = []
    for f in flows:
        for s in f["stages"]:
            if s["kind"] == "open" and s["gate"] == "Approval":
                a = s["appr"] or {"chain": [s["owner_role"] or "Sales Head"], "min": 0, "sla": 24, "auto": True}
                rows.append({"p": f["label"], "s": s["name"], "c": a["chain"], "w": a["min"], "l": a["sla"], "k": f["key"]})
    return rows
