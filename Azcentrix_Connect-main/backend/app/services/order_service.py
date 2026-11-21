"""Orders & Projects (prototype v17 · Sales → Orders & Projects): order lifecycles (Process Designer), numbering,
list rows, stage engine + approvals, milestones & billing, follow-on contracts, journey and the record drawer.

* An order is a ``work_orders`` row. Data scope: workorders.* (created_by / project_manager_id), as the legacy API.
* Lifecycles: ``order_lifecycles`` + the shared tenant workflow tables. The default lifecycle "Project / Supply"
  (workflow ``wo``) is created once with the prototype stages Kick-off → Procurement → Execution → Dispatch →
  Installation → Commissioning → Closed; after that the configured stages are always read from the DB.
* Progress % – the configured measurement: Closed orders are 100 %; with Milestone tracking on and milestones present,
  the share of completed milestones weighted by their billing amount (by count when no amounts are set); otherwise the
  order's recorded progress (work_orders.progress_percent).
* Billed % = invoiced total (wo_invoices.total_amount) / order value × 100 – a done milestone is never "billed" unless
  an invoice record exists. Billing gap = Progress % − Billed %.
* Follow-on lifecycles (AMC / warranty / rental …) are created manually ("Create follow-on"), when a project order
  closes, or when a deal is won – in the same transaction, idempotent through order_profiles.auto_key.
"""
from __future__ import annotations

import json
import logging
import re
import threading
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Optional

from fastapi import HTTPException, Request
from sqlalchemy import bindparam, false, func, or_, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.timezone import now_ist, today_ist
from app.dependencies import get_request_ip, user_has_permission
from app.models.all_models import ActivityLog, FormField, Lead, Quotation, Setting, Tender, User, WOInvoice, WOMilestone, WorkOrder
from app.models.orders import ORDER_TABLES, OrderLifecycle, OrderNote, OrderProfile

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()

MODULE = "workorders"                      # permissions, data scope, audit log, Document Hub source, notifications
FORM_MODULE = "work_orders"                # Form Builder module key
DEFAULT_KEY, DEFAULT_TYPE = "wo", "Project / Supply"
# prototype v17 WF.wo: name | SLA days, then the terminal stage Closed
DEFAULT_STAGES = [("Kick-off", 3), ("Procurement", 15), ("Execution", 30), ("Dispatch", 7), ("Installation", 14), ("Commissioning", 7)]
TERMINAL = "Closed"
# prototype OLTPL – "Start from" templates of a new order lifecycle (None = copy of the project lifecycle)
TEMPLATES: dict[str, Optional[list[tuple[str, int]]]] = {
    "AMC / service contract": [("Contract Signed", 3), ("Visit Schedule", 10), ("Preventive Maintenance", 90), ("Breakdown Support", 30), ("Renewal Due", 30)],
    "Warranty & support": [("Handover", 3), ("Warranty Period", 365), ("Extended Support", 90)],
    "Rental / lease": [("Agreement", 5), ("Delivered", 10), ("In Use", 180), ("Return & Inspection", 10)],
    "Copy of project lifecycle": None,
}
TRIGGERS = {"manual": "Manually – “Create follow-on” on an order", "closure": "Automatically when a project order closes",
            "won": "Automatically when a deal is won"}
GATES = ("None", "Approval", "Checklist")
VIEWS = ["All", "Running", "Delayed", "Billing gap"]
GAP = 15                                   # Billing gap view: Progress − Billed ≥ 15 points

# Settings → Orders & projects (tenant ``settings`` table, category "orders"): key, label, type, default
CONFIG_KEYS: dict[str, tuple[str, str, str, Any]] = {
    "milestones": ("order_milestone_tracking", "Milestone tracking", "boolean", True),
    "billing_model": ("order_billing_model", "Billing model", "string", "Milestone"),
    "retention": ("order_track_retention", "Track retention money", "boolean", False),
    "retention_pct": ("order_retention_percent", "Retention (%)", "number", 5),
    "auto_pm": ("order_auto_assign_pm", "Auto-assign project manager", "boolean", False),
    "slip_alert": ("order_milestone_slip_alert", "Alert when a milestone slips", "boolean", True),
    "number_format": ("order_number_format", "Order number format", "string", "WO-YY-####"),
    "number_custom": ("order_number_custom", "Custom order number pattern", "string", "WO-{YYYY}-{####}"),
}
BILLING_MODELS = ("Milestone", "Time & material", "Fixed monthly", "On delivery")
NUMBER_FORMATS = ("WO-YY-####", "PO-based", "Custom")
CENT = Decimal("0.01")


def dec(v: Any) -> Decimal:
    try:
        return v if isinstance(v, Decimal) else Decimal(str(v if v is not None else 0))
    except Exception:
        return Decimal(0)


def q2(v: Decimal) -> Decimal:
    return v.quantize(CENT, rounding=ROUND_HALF_UP)


# ─── schema + default lifecycle ───────────────────────────────────────────────

def _write_stages(db: Session, key: str, revision: int, stages: list[dict]) -> None:
    for i, s in enumerate(stages):
        db.execute(text("INSERT INTO workflow_stages (workflow, revision, position, name, kind, sla_days, gate, owner_role, checklist) "
                        "VALUES (:w, :r, :p, :n, :k, :sla, :g, :o, :c)"),
                   {"w": key, "r": revision, "p": i, "n": s["name"], "k": s["kind"], "sla": int(s.get("sla_days") or 0), "g": s.get("gate") or "None",
                    "o": s.get("owner_role") or None, "c": json.dumps(s["checklist"]) if s.get("checklist") else None})


def _template_stages(names: list[tuple[str, int]]) -> list[dict]:
    return [{"name": n, "kind": "open", "sla_days": sla} for n, sla in names] + [{"name": TERMINAL, "kind": "won", "sla_days": 0}]


def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        from app.routers.workorder_router import _ensure_work_order_runtime_schema
        from app.services.platform_workflow_templates import TENANT_DDL
        _ensure_work_order_runtime_schema(db)
        for ddl in TENANT_DDL:
            db.execute(text(ddl))
        db.commit()
        WorkOrder.__table__.metadata.tables["wo_milestones"].create(bind=db.get_bind(), checkfirst=True)
        WorkOrder.__table__.metadata.tables["wo_invoices"].create(bind=db.get_bind(), checkfirst=True)
        try:
            db.execute(text("ALTER TABLE wo_milestones ADD COLUMN IF NOT EXISTS `invoice_id` INT NULL"))
            db.commit()
        except Exception as exc:
            db.rollback()
            logger.warning("orders schema: wo_milestones.invoice_id skipped: %s", exc)
        for t in ORDER_TABLES:
            t.create(bind=db.get_bind(), checkfirst=True)
        db.commit()
        from app.services.order_payment_service import ensure_receipt_schema   # v18 payment collection tables
        ensure_receipt_schema(db)
        if not db.query(OrderLifecycle.workflow).filter(OrderLifecycle.workflow == DEFAULT_KEY).first():
            db.add(OrderLifecycle(workflow=DEFAULT_KEY, type_name=DEFAULT_TYPE, label="Project / Supply order", trigger="manual", sort_order=0, is_active=True))
            db.flush()
        if not db.execute(text("SELECT 1 FROM workflow_definitions WHERE workflow = :w"), {"w": DEFAULT_KEY}).first():
            db.execute(text("INSERT INTO workflow_definitions (workflow, revision, template_key, template_name, applied_by, applied_at) "
                            "VALUES (:w, 1, 'order-default', 'Order & project lifecycle', 'Orders & Projects defaults', :now)"), {"w": DEFAULT_KEY, "now": now_ist()})
            _write_stages(db, DEFAULT_KEY, 1, _template_stages(DEFAULT_STAGES))
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
            logger.warning("orders schema: tenant %s unavailable: %s", slug, exc)
            continue
        try:
            db.info["tenant_slug"] = slug
            ensure_schema(db)
        except Exception as exc:
            logger.warning("orders schema for %s failed: %s", slug, exc)
            db.rollback()
        finally:
            db.close()


# ─── settings ─────────────────────────────────────────────────────────────────

def config(db: Session) -> dict[str, Any]:
    rows = {s.key: (s.value or "").strip() for s in db.query(Setting.key, Setting.value).filter(Setting.key.in_([k for k, _, _, _ in CONFIG_KEYS.values()])).all()}
    out: dict[str, Any] = {}
    for name, (key, _, typ, default) in CONFIG_KEYS.items():
        v = rows.get(key, "")
        if v == "":
            out[name] = default
        elif typ == "boolean":
            out[name] = v.lower() in ("1", "true", "yes", "on")
        elif typ == "number":
            try:
                out[name] = max(0.0, min(100.0, float(v)))
            except ValueError:
                out[name] = default
        else:
            out[name] = v
    if out["billing_model"] not in BILLING_MODELS:
        out["billing_model"] = "Milestone"
    if out["number_format"] not in NUMBER_FORMATS:
        out["number_format"] = "WO-YY-####"
    return out


def save_config(db: Session, cu: User, values: dict[str, Any]) -> dict[str, Any]:
    cur = config(db)
    nxt = dict(cur)
    for name, raw in values.items():
        if name not in CONFIG_KEYS or raw is None:
            continue
        _, label, typ, _ = CONFIG_KEYS[name]
        if typ == "boolean":
            nxt[name] = raw if isinstance(raw, bool) else str(raw).lower() in ("1", "true", "yes", "on")
        elif typ == "number":
            try:
                n = float(raw)
            except (TypeError, ValueError):
                raise HTTPException(422, f"{label} must be a number")
            if not 0 <= n <= 100:
                raise HTTPException(422, f"{label} must be between 0 and 100")
            nxt[name] = n
        else:
            nxt[name] = str(raw).strip()
    if nxt["billing_model"] not in BILLING_MODELS:
        raise HTTPException(422, f"Billing model must be one of {', '.join(BILLING_MODELS)}")
    if nxt["number_format"] not in NUMBER_FORMATS:
        raise HTTPException(422, f"Order number format must be one of {', '.join(NUMBER_FORMATS)}")
    if nxt["number_format"] == "Custom":
        pat = nxt["number_custom"] or ""
        if not re.search(r"\{#+\}", pat) or len(pat) > 60:
            raise HTTPException(422, "A custom order number needs a sequence such as {####} (at most 60 characters)")
    existing = {s.key: s for s in db.query(Setting).filter(Setting.key.in_([k for k, _, _, _ in CONFIG_KEYS.values()])).all()}
    for name, (key, label, typ, _) in CONFIG_KEYS.items():
        v = nxt[name]
        sv = ("true" if v else "false") if typ == "boolean" else (f"{v:g}" if typ == "number" else str(v))
        row = existing.get(key)
        if row is None:
            db.add(Setting(key=key, value=sv, type={"number": "number", "boolean": "boolean"}.get(typ, "string"), category="orders", label=label, updated_by=cu.id))
        elif row.value != sv:
            row.value, row.updated_by = sv, cu.id
    from app.core.logging import log_audit_db
    log_audit_db(db, cu.id, MODULE, "settings_update", None, "", description="Orders & projects settings updated",
                 old_data={k: cur[k] for k in CONFIG_KEYS}, new_data={k: nxt[k] for k in CONFIG_KEYS})
    db.commit()
    return config(db)


# ─── numbering (Settings → Order number format) ───────────────────────────────

def _pattern(cfg: dict[str, Any]) -> str:
    if cfg["number_format"] == "Custom":
        return cfg["number_custom"] or "WO-{YYYY}-{####}"
    return "WO-{YY}-{####}"


def next_number(db: Session, po_number: Optional[str] = None, cfg: Optional[dict[str, Any]] = None) -> str:
    """WO-YY-#### (sequence per year) · PO-based (the customer's PO number, made unique) · Custom ({YYYY} {YY} {MM} {####})."""
    cfg = cfg or config(db)
    taken = lambda n: db.execute(text("SELECT 1 FROM work_orders WHERE wo_number = :n"), {"n": n}).first() is not None  # noqa: E731
    if cfg["number_format"] == "PO-based" and (po_number or "").strip():
        base = re.sub(r"\s+", "-", po_number.strip())[:90]
        n, i = base, 2
        while taken(n):
            n, i = f"{base}-{i}", i + 1
        return n
    now = now_ist()
    pat = _pattern(cfg).replace("{YYYY}", now.strftime("%Y")).replace("{YY}", now.strftime("%y")).replace("{MM}", now.strftime("%m"))
    m = re.search(r"\{(#+)\}", pat)
    width = len(m.group(1)) if m else 4
    pre, post = (pat[:m.start()], pat[m.end():]) if m else (pat + "-", "")
    rows = db.execute(text("SELECT wo_number FROM work_orders WHERE wo_number LIKE :p"), {"p": f"{pre}%{post}"}).scalars().all()
    seq = 0
    rx = re.compile("^" + re.escape(pre) + r"(\d+)" + re.escape(post) + "$")
    for r in rows:
        mm = rx.match(r or "")
        if mm:
            seq = max(seq, int(mm.group(1)))
    n = f"{pre}{seq + 1:0{width}d}{post}"
    while taken(n):
        seq += 1
        n = f"{pre}{seq + 1:0{width}d}{post}"
    return n


# ─── lifecycles (Process Designer) ────────────────────────────────────────────

def lifecycles(db: Session, include_inactive: bool = False) -> list[dict[str, Any]]:
    q = db.query(OrderLifecycle)
    if not include_inactive:
        q = q.filter(OrderLifecycle.is_active == True)  # noqa: E712
    rows = q.order_by(OrderLifecycle.sort_order, OrderLifecycle.workflow).all()
    if not rows:
        return []
    keys = [r.workflow for r in rows]
    revs = dict(db.execute(text("SELECT workflow, revision FROM workflow_definitions WHERE workflow IN :w").bindparams(bindparam("w", expanding=True)), {"w": keys}).all())
    stages = db.execute(text("SELECT id, workflow, revision, position, name, kind, sla_days, gate, owner_role, checklist FROM workflow_stages "
                             "WHERE workflow IN :w ORDER BY workflow, position").bindparams(bindparam("w", expanding=True)), {"w": keys}).mappings().all()
    by: dict[str, list[dict]] = {k: [] for k in keys}
    for s in stages:
        if revs.get(s["workflow"]) != s["revision"]:
            continue
        cl = s["checklist"]
        if isinstance(cl, str):
            try:
                cl = json.loads(cl)
            except ValueError:
                cl = None
        by[s["workflow"]].append({"id": s["id"], "name": s["name"], "kind": s["kind"], "sla": int(s["sla_days"] or 0), "gate": s["gate"] or "None",
                                  "owner_role": s["owner_role"], "checklist": cl or [], "position": s["position"]})
    out = []
    for r in rows:
        st = by.get(r.workflow, [])
        st = [s for s in st if s["kind"] == "open"] + [s for s in st if s["kind"] != "open"]
        if not any(s["kind"] == "open" for s in st) or not any(s["kind"] == "won" for s in st):
            continue
        out.append({"key": r.workflow, "type": r.type_name, "label": r.label, "trigger": r.trigger, "template": r.template, "active": bool(r.is_active), "stages": st})
    return out


def create_lifecycle(db: Session, cu: User, name: str, template: str, trigger: str) -> dict[str, Any]:
    """Prototype olSave(): a follow-on lifecycle listed under Orders & Projects, stages from the chosen template."""
    name = (name or "").strip()
    if not name:
        raise HTTPException(422, "Name the lifecycle")
    if len(name) > 80:
        raise HTTPException(422, "The name can have at most 80 characters")
    if template not in TEMPLATES:
        raise HTTPException(422, "Choose a template to start from")
    if trigger not in TRIGGERS:
        raise HTTPException(422, "Choose how the lifecycle is created")
    if db.query(OrderLifecycle.workflow).filter(func.lower(OrderLifecycle.type_name) == name.lower()).first():
        raise HTTPException(409, f"A lifecycle called “{name}” already exists")
    n = (db.execute(text("SELECT COUNT(*) FROM order_lifecycles")).scalar() or 0) + 1
    key = f"wo_x{n}"
    while db.query(OrderLifecycle.workflow).filter(OrderLifecycle.workflow == key).first() or \
            db.execute(text("SELECT 1 FROM workflow_definitions WHERE workflow = :w"), {"w": key}).first():
        n += 1
        key = f"wo_x{n}"
    tpl = TEMPLATES[template]
    if tpl is None:
        base = next((l for l in lifecycles(db) if l["key"] == DEFAULT_KEY), None)
        stages = [{"name": s["name"], "kind": s["kind"], "sla_days": s["sla"], "gate": s["gate"], "owner_role": s["owner_role"], "checklist": s["checklist"]}
                  for s in (base["stages"] if base else [])] or _template_stages(DEFAULT_STAGES)
    else:
        stages = _template_stages(tpl)
    order = (db.execute(text("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM order_lifecycles")).scalar() or 1)
    db.add(OrderLifecycle(workflow=key, type_name=name, label=name, trigger=trigger, template=template, sort_order=order, is_active=True, created_by=cu.id))
    db.execute(text("INSERT INTO workflow_definitions (workflow, revision, template_key, template_name, applied_by, applied_at) VALUES (:w, 1, :t, :n, :by, :now)"),
               {"w": key, "t": "order-" + re.sub(r"[^a-z0-9]+", "-", template.lower()).strip("-")[:30], "n": name[:150], "by": cu.full_name, "now": now_ist()})
    _write_stages(db, key, 1, stages)
    from app.core.logging import log_audit_db
    log_audit_db(db, cu.id, MODULE, "lifecycle_create", None, "", description=f"Order lifecycle “{name}” created from {template}",
                 new_data={"key": key, "name": name, "template": template, "trigger": trigger})
    db.commit()
    return next(l for l in lifecycles(db) if l["key"] == key)


def delete_lifecycle(db: Session, cu: User, key: str) -> int:
    """Prototype olDel(): its contracts move to Project / Supply (first stage); the lifecycle is switched off."""
    if key == DEFAULT_KEY:
        raise HTTPException(400, "The Project / Supply lifecycle cannot be deleted")
    lc = db.query(OrderLifecycle).filter(OrderLifecycle.workflow == key).first()
    if not lc:
        raise HTTPException(404, "Lifecycle not found")
    base = next((l for l in lifecycles(db) if l["key"] == DEFAULT_KEY), None)
    if not base:
        raise HTTPException(409, "The Project / Supply lifecycle is not configured")
    first = next(s for s in base["stages"] if s["kind"] == "open")
    ids = [p.wo_id for p in db.query(OrderProfile.wo_id).filter(OrderProfile.lifecycle == key).all()]
    if ids:
        db.execute(text("DELETE FROM workflow_record_stages WHERE workflow = :w AND record_id IN :ids").bindparams(bindparam("ids", expanding=True)), {"w": key, "ids": ids})
        for i in ids:
            db.execute(text("INSERT INTO workflow_record_stages (workflow, record_id, stage_id, mapped_at) VALUES (:w, :r, :s, :now) "
                            "ON DUPLICATE KEY UPDATE stage_id = VALUES(stage_id), mapped_at = VALUES(mapped_at)"), {"w": DEFAULT_KEY, "r": i, "s": first["id"], "now": now_ist()})
        db.query(OrderProfile).filter(OrderProfile.lifecycle == key).update({OrderProfile.lifecycle: DEFAULT_KEY, OrderProfile.stage_entered_at: now_ist(),
                                                                             OrderProfile.pending_stage_id: None, OrderProfile.approval_request_id: None},
                                                                            synchronize_session=False)
    lc.is_active = False
    from app.core.logging import log_audit_db
    log_audit_db(db, cu.id, MODULE, "lifecycle_delete", None, "", description=f"Order lifecycle “{lc.type_name}” deleted – {len(ids)} contracts moved to {DEFAULT_TYPE}",
                 old_data={"key": key, "name": lc.type_name, "orders": len(ids)})
    db.commit()
    return len(ids)


def save_stages(db: Session, cu: User, key: str, stages: list[dict]) -> None:
    """Process Designer: rename / reorder / add open stages, SLA, gate, owner role, checklist. Stages in use are kept
    (their ids – and the orders on them – survive); unused removed stages are deleted. One terminal stage (Closed)."""
    lc = db.query(OrderLifecycle).filter(OrderLifecycle.workflow == key, OrderLifecycle.is_active == True).first()  # noqa: E712
    if not lc:
        raise HTTPException(404, "Lifecycle not found")
    clean, seen = [], set()
    for s in stages:
        nm = str(s.get("name") or "").strip()
        kind = s.get("kind") or "open"
        if not nm or len(nm) > 150:
            raise HTTPException(422, "Every stage needs a name (at most 150 characters)")
        if nm.lower() in seen:
            raise HTTPException(422, f"Stage “{nm}” is listed twice")
        seen.add(nm.lower())
        if kind not in ("open", "won"):
            raise HTTPException(422, "Stages are open stages plus one closing stage")
        gate = s.get("gate") or "None"
        if gate not in GATES:
            raise HTTPException(422, "Gate must be None, Approval or Checklist")
        cl = [str(x).strip() for x in (s.get("checklist") or []) if str(x).strip()]
        if gate == "Checklist" and not cl:
            raise HTTPException(422, f"Add at least one checklist item for “{nm}”")
        clean.append({"id": s.get("id"), "name": nm, "kind": kind, "sla_days": max(0, int(s.get("sla_days") or 0)), "gate": gate if kind == "open" else "None",
                      "owner_role": (s.get("owner_role") or None), "checklist": cl or None})
    if not any(s["kind"] == "open" for s in clean) or sum(1 for s in clean if s["kind"] == "won") != 1:
        raise HTTPException(422, "A lifecycle needs at least one open stage and exactly one closing stage")
    clean = [s for s in clean if s["kind"] == "open"] + [s for s in clean if s["kind"] == "won"]
    rev = db.execute(text("SELECT revision FROM workflow_definitions WHERE workflow = :w FOR UPDATE"), {"w": key}).scalar()
    cur = {r[0]: r for r in db.execute(text("SELECT id, name FROM workflow_stages WHERE workflow = :w AND revision = :r"), {"w": key, "r": rev}).all()}
    keep = {int(s["id"]) for s in clean if s.get("id") and int(s["id"]) in cur}
    used = dict(db.execute(text("SELECT stage_id, COUNT(*) FROM workflow_record_stages WHERE workflow = :w GROUP BY stage_id"), {"w": key}).all())
    for sid in set(cur) - keep:
        if used.get(sid):
            raise HTTPException(409, f"Stage “{cur[sid][1]}” still holds {used[sid]} orders – move them first")
    db.execute(text("UPDATE workflow_stages SET position = position + 1000 WHERE workflow = :w AND revision = :r"), {"w": key, "r": rev})
    for sid in set(cur) - keep:
        db.execute(text("DELETE FROM workflow_stages WHERE id = :i"), {"i": sid})
    for i, s in enumerate(clean):
        p = {"w": key, "r": rev, "p": i, "n": s["name"], "k": s["kind"], "sla": s["sla_days"], "g": s["gate"], "o": s["owner_role"],
             "c": json.dumps(s["checklist"]) if s["checklist"] else None}
        if s.get("id") and int(s["id"]) in keep:
            db.execute(text("UPDATE workflow_stages SET position=:p, name=:n, kind=:k, sla_days=:sla, gate=:g, owner_role=:o, checklist=:c WHERE id=:i"), {**p, "i": int(s["id"])})
        else:
            db.execute(text("INSERT INTO workflow_stages (workflow, revision, position, name, kind, sla_days, gate, owner_role, checklist) "
                            "VALUES (:w, :r, :p, :n, :k, :sla, :g, :o, :c)"), p)
    from app.core.logging import log_audit_db
    log_audit_db(db, cu.id, MODULE, "lifecycle_stages", None, "", description=f"Stages of “{lc.type_name}” updated",
                 new_data={"key": key, "stages": [s["name"] for s in clean]})
    db.commit()


# ─── records, scope, stage sync ───────────────────────────────────────────────

def order_query(db: Session, cu: User):
    from app.utils.data_scope import apply_data_scope
    q = db.query(WorkOrder)
    if not user_has_permission(db, cu, "workorders.view"):
        return q.filter(false())
    return apply_data_scope(db, q, cu, MODULE, WorkOrder.created_by, WorkOrder.project_manager_id)


def get_order(db: Session, cu: User, wo_id: int) -> WorkOrder:
    wo = order_query(db, cu).filter(WorkOrder.id == wo_id).first()
    if not wo:
        raise HTTPException(404, "Order not found")
    return wo


def _legacy_closed(wo: WorkOrder) -> bool:
    return (wo.status or "") in ("Completed", "Closed", "Cancelled", "Lost")


def sync(db: Session, orders: list[WorkOrder], lcs: list[dict]) -> tuple[dict[int, OrderProfile], dict[int, dict]]:
    """Every order gets a profile and a stage on its lifecycle (batched). Orders created by the legacy paths start in the
    first stage – or the closing stage when their legacy status is already Completed / Closed."""
    if not orders or not lcs:
        return {}, {}
    by_key = {l["key"]: l for l in lcs}
    default = by_key.get(DEFAULT_KEY) or lcs[0]
    ids = [o.id for o in orders]
    profiles = {p.wo_id: p for p in db.query(OrderProfile).filter(OrderProfile.wo_id.in_(ids)).all()}
    maps = {r[0]: (r[1], r[2]) for r in db.execute(text("SELECT record_id, workflow, stage_id FROM workflow_record_stages "
                                                        "WHERE record_id IN :ids AND (workflow = 'wo' OR workflow LIKE 'wo\\_x%')")
                                                   .bindparams(bindparam("ids", expanding=True)), {"ids": ids}).all()}
    stage_by_id = {s["id"]: (l["key"], s) for l in lcs for s in l["stages"]}
    out: dict[int, dict] = {}
    changed = False
    for o in orders:
        prof = profiles.get(o.id)
        if prof is None:
            start = o.po_date or (o.created_at.date() if o.created_at else None)
            prof = OrderProfile(wo_id=o.id, lifecycle=DEFAULT_KEY, start_date=start, stage_entered_at=o.created_at or now_ist())
            db.add(prof)
            profiles[o.id] = prof
            changed = True
        lc = by_key.get(prof.lifecycle) or default
        if prof.lifecycle != lc["key"]:
            prof.lifecycle = lc["key"]
            changed = True
        cur = maps.get(o.id)
        stage = stage_by_id[cur[1]][1] if cur and cur[1] in stage_by_id and cur[0] == lc["key"] else None
        if stage is None:
            stage = next(s for s in lc["stages"] if s["kind"] == ("won" if _legacy_closed(o) else "open"))
            if cur and cur[0] != lc["key"]:
                db.execute(text("DELETE FROM workflow_record_stages WHERE workflow = :w AND record_id = :r"), {"w": cur[0], "r": o.id})
            db.execute(text("INSERT INTO workflow_record_stages (workflow, record_id, stage_id, mapped_at) VALUES (:w, :r, :s, :now) "
                            "ON DUPLICATE KEY UPDATE stage_id = VALUES(stage_id), mapped_at = VALUES(mapped_at)"),
                       {"w": lc["key"], "r": o.id, "s": stage["id"], "now": now_ist()})
            changed = True
        out[o.id] = {"lc": lc, "stage": stage}
    if changed:
        db.commit()
    return profiles, out


def names(db: Session, ids) -> dict[int, str]:
    ids = {i for i in ids if i}
    return {u.id: u.full_name for u in db.query(User.id, User.full_name).filter(User.id.in_(ids)).all()} if ids else {}


def value_of(o: WorkOrder) -> Decimal:
    v = dec(o.wo_value)
    return v if v > 0 else dec(o.po_value)


def due_of(o: WorkOrder) -> Optional[date]:
    return o.completion_date or o.delivery_date


def metrics(db: Session, ids: list[int]) -> tuple[dict[int, list], dict[int, Decimal]]:
    """Milestones per order and invoiced totals per order – two queries for any number of orders."""
    if not ids:
        return {}, {}
    ms: dict[int, list] = {i: [] for i in ids}
    for m in db.query(WOMilestone).filter(WOMilestone.wo_id.in_(ids)).order_by(WOMilestone.due_date.is_(None), WOMilestone.due_date, WOMilestone.id).all():
        ms[m.wo_id].append(m)
    inv = {r[0]: dec(r[1]) for r in db.query(WOInvoice.wo_id, func.sum(WOInvoice.total_amount)).filter(WOInvoice.wo_id.in_(ids)).group_by(WOInvoice.wo_id).all()}
    return ms, inv


def progress_of(o: WorkOrder, ms: list, stage: dict, cfg: dict[str, Any]) -> int:
    if stage["kind"] == "won":
        return 100
    if cfg["milestones"] and ms:
        total = sum((dec(m.amount) for m in ms), Decimal(0))
        if total > 0:
            done = sum((dec(m.amount) for m in ms if m.status == "Completed"), Decimal(0))
            return int((done / total * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))
        return round(sum(1 for m in ms if m.status == "Completed") * 100 / len(ms))
    return max(0, min(100, int(o.progress_percent or 0)))


def billed_of(o: WorkOrder, invoiced: Decimal) -> int:
    v = value_of(o)
    if v <= 0:
        return 0
    return int((invoiced / v * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def journey_id(db: Session, orders: list[WorkOrder]) -> dict[int, Optional[str]]:
    """J-<lead id> of the order's source lead / deal (directly, through its tender or quote, or its parent order)."""
    out: dict[int, Optional[int]] = {o.id: o.lead_id for o in orders}
    tids = {o.tender_id for o in orders if not o.lead_id and o.tender_id}
    qids = {o.quotation_id for o in orders if not o.lead_id and o.quotation_id}
    t_lead = {r[0]: r[1] for r in db.query(Tender.id, Tender.lead_id).filter(Tender.id.in_(tids)).all()} if tids else {}
    q_lead = {r[0]: r[1] for r in db.query(Quotation.id, Quotation.lead_id).filter(Quotation.id.in_(qids)).all()} if qids else {}
    for o in orders:
        if not out[o.id]:
            out[o.id] = t_lead.get(o.tender_id) or q_lead.get(o.quotation_id)
    missing = [o.id for o in orders if not out[o.id]]
    if missing:
        par = {r[0]: r[1] for r in db.query(OrderProfile.wo_id, OrderProfile.parent_wo_id).filter(OrderProfile.wo_id.in_(missing), OrderProfile.parent_wo_id.isnot(None)).all()}
        if par:
            pl = {r[0]: r[1] for r in db.query(WorkOrder.id, WorkOrder.lead_id).filter(WorkOrder.id.in_(set(par.values()))).all()}
            for i, p in par.items():
                out[i] = pl.get(p)
    return {i: (f"J-{l:04d}" if l else None) for i, l in out.items()}


def journey_tracks(db: Session, orders: list[WorkOrder], stage_of: dict[int, dict]) -> dict[int, Optional[dict]]:
    """Prototype jTrack() for the grid's Journey column: J-id + L · D · T|Q · O (deal type decides Tender or Quote).
    None when the order belongs to no lead / deal journey (the cell shows "—", like the prototype)."""
    jids = journey_id(db, orders)
    lids = {int(j[2:]) for j in jids.values() if j}
    leads = {l.id: l for l in db.query(Lead.id, Lead.lead_type, Lead.status, Lead.opportunity_ref_id, Lead.lead_ref_id, Lead.conversion_target,
                                       Lead.converted_tender_id).filter(Lead.id.in_(lids)).all()} if lids else {}
    out: dict[int, Optional[dict]] = {}
    for o in orders:
        jid = jids.get(o.id)
        if not jid:
            out[o.id] = None
            continue
        l = leads.get(int(jid[2:]))
        is_lead = bool(l) and l.lead_type != "direct_opportunity"
        is_deal = bool(l) and (l.lead_type == "direct_opportunity" or bool(l.opportunity_ref_id))
        quote_led = bool(o.quotation_id) or (bool(l) and (l.conversion_target or "") == "quotation" and not o.tender_id)
        tq_done = bool(o.quotation_id) if quote_led else bool(o.tender_id or (l and l.converted_tender_id))
        st = stage_of.get(o.id) or {}
        out[o.id] = {"id": jid, "steps": [
            {"k": "L", "label": "Lead", "done": is_lead, "stage": "Converted" if is_lead else None, "ref": l.lead_ref_id if is_lead else None},
            {"k": "D", "label": "Deal", "done": is_deal, "stage": ("Won" if l.status == "Converted" else l.status) if is_deal else None,
             "ref": l.opportunity_ref_id if is_deal else None},
            {"k": "Q" if quote_led else "T", "label": "Quote" if quote_led else "Tender", "done": tq_done, "stage": "Won" if tq_done else None},
            {"k": "O", "label": "Order", "done": True, "stage": st.get("name"), "ref": o.wo_number, "me": True},
        ]}
    return out


def list_rows(db: Session, cu: User) -> tuple[list[dict], list[dict]]:
    lcs = lifecycles(db, include_inactive=True)
    orders = order_query(db, cu).order_by(WorkOrder.id.desc()).all()
    profiles, st = sync(db, orders, lcs)
    cfg = config(db)
    ms, inv = metrics(db, [o.id for o in orders])
    from app.services.order_payment_service import receipt_totals
    paid = receipt_totals(db, [o.id for o in orders])          # v18: Received (Finance-acknowledged) · Awaiting finance
    who = names(db, [o.project_manager_id for o in orders])
    tracks = journey_tracks(db, orders, {o.id: st[o.id]["stage"] for o in orders if o.id in st})
    from app.services.quote_service import tenant_info
    company = tenant_info(db)["name"] or ""      # prototype colsOf(): Company column (this tenant's company)
    today = today_ist()
    rows = []
    for o in orders:
        info = st.get(o.id)
        if not info:
            continue
        s, lc, prof = info["stage"], info["lc"], profiles[o.id]
        pr, bl = progress_of(o, ms[o.id], s, cfg), billed_of(o, inv.get(o.id, Decimal(0)))
        due = due_of(o)
        rows.append({
            "id": o.id, "ref": o.wo_number, "title": o.project_title or o.wo_number, "customer": o.customer_name or "", "customer_id": o.customer_id,
            "po": o.po_number or "", "value": float(value_of(o)), "progress": pr, "billed": bl, "gap": pr - bl,
            "stage": s["name"], "stage_id": s["id"], "stage_kind": s["kind"], "pm": who.get(o.project_manager_id, ""), "pm_id": o.project_manager_id,
            "due": due.isoformat() if due else None, "start": prof.start_date.isoformat() if prof.start_date else None,
            "delayed": bool(due and due < today and s["kind"] != "won"), "lifecycle": lc["key"], "type": lc["type"],
            "pending": bool(prof.pending_stage_id), "parent_id": prof.parent_wo_id,
            "jid": tracks[o.id]["id"] if tracks.get(o.id) else None, "journey": tracks.get(o.id), "company": company,
            "received": paid.get(o.id, {}).get("received", 0.0), "awaiting": paid.get(o.id, {}).get("awaiting", 0.0),
            "pending_receipts": paid.get(o.id, {}).get("pending_count", 0),
        })
    return rows, lcs


def in_view(r: dict, view: str) -> bool:
    if view == "Running":
        return r["stage_kind"] != "won"
    if view == "Delayed":
        return r["delayed"]
    if view == "Billing gap":
        return r["progress"] - r["billed"] >= GAP
    return True


# ─── create / edit / delete ───────────────────────────────────────────────────

def authorized_customer(db: Session, cu: User, customer_id: int) -> dict:
    from app.routers.deals_router import authorized_customers
    c = next((x for x in authorized_customers(db, cu) if x["id"] == customer_id), None)
    if not c:
        raise HTTPException(422, "Choose a customer you can work with")
    return c


def required_custom(db: Session) -> list[FormField]:
    return db.query(FormField).filter(FormField.module == FORM_MODULE, FormField.is_custom == True, FormField.is_visible == True,  # noqa: E712
                                      FormField.is_required == True).all()  # noqa: E712


def validate(db: Session, cu: User, body: dict[str, Any], current: Optional[WorkOrder] = None) -> dict[str, Any]:
    title = (body.get("title") or "").strip()
    if not title:
        raise HTTPException(422, "Enter the work order title")
    if len(title) > 300:
        raise HTTPException(422, "The title can have at most 300 characters")
    if not body.get("customer_id"):
        raise HTTPException(422, "Choose a customer")
    cust = authorized_customer(db, cu, int(body["customer_id"])) if not current or current.customer_id != int(body["customer_id"]) \
        else {"id": current.customer_id, "customer_name": current.customer_name}
    po = (body.get("po") or "").strip() or None
    if po and len(po) > 100:
        raise HTTPException(422, "The PO number can have at most 100 characters")
    value = body.get("value")
    if value is not None:
        value = dec(value)
        if value < 0 or value > Decimal("9999999999999.99"):
            raise HTTPException(422, "Order value must be zero or more")
        value = q2(value)
    start, due = body.get("start"), body.get("due")
    if start and due and due < start:
        raise HTTPException(422, "The due date cannot be before the start date")
    pm = body.get("pm_id")
    if pm and not db.query(User.id).filter(User.id == int(pm), User.is_active == True).first():  # noqa: E712
        raise HTTPException(422, "Choose an active project manager")
    custom = body.get("custom_data") if isinstance(body.get("custom_data"), dict) else None
    merged = {**((current.custom_data if current and isinstance(current.custom_data, dict) else {}) or {}), **(custom or {})}
    miss = [f.label for f in required_custom(db) if merged.get(f.field_key) in (None, "", False)]
    if miss:
        raise HTTPException(422, {"message": "Fill the required fields: " + ", ".join(miss), "missing": miss})
    if po:
        q = db.query(WorkOrder.id, WorkOrder.wo_number).filter(WorkOrder.customer_id == cust["id"], func.lower(WorkOrder.po_number) == po.lower())
        if current:
            q = q.filter(WorkOrder.id != current.id)
        dup = q.first()
        if dup:
            raise HTTPException(409, {"message": f"Order {dup.wo_number} already uses PO {po} for this customer", "duplicate_id": dup.id, "field": "po"})
    return {"title": title, "customer": cust, "po": po, "value": value, "start": start, "due": due, "pm": int(pm) if pm else None, "custom": custom}


def duplicates(db: Session, cu: User, customer_id: int, title: str, po: str, exclude: Optional[int]) -> list[dict]:
    q = order_query(db, cu).filter(WorkOrder.customer_id == customer_id)
    if exclude:
        q = q.filter(WorkOrder.id != exclude)
    t, p = (title or "").strip().lower(), (po or "").strip().lower()
    out = []
    for o in q.order_by(WorkOrder.id.desc()).limit(200).all():
        same_po = bool(p) and (o.po_number or "").strip().lower() == p
        same_title = bool(t) and (o.project_title or "").strip().lower() == t
        if same_po or same_title:
            out.append({"id": o.id, "ref": o.wo_number, "title": o.project_title or "", "same_po": same_po, "same_title": same_title})
    return out[:10]


def _wo_type(lc_type: str) -> str:
    t = lc_type.lower()
    return "AMC" if "amc" in t or "maintenance" in t else "Service" if "warranty" in t or "service" in t or "support" in t else "Supply"


def _log(db: Session, cu: Optional[User], request: Optional[Request], wo: WorkOrder, action: str, description: str,
         old: Optional[dict] = None, new: Optional[dict] = None, icon: str = "📋") -> None:
    from app.core.logging import log_module_action        # writes the audit_logs row and the activity_logs row (Activity tab)
    uid = cu.id if cu else None
    log_module_action(db=db, user_id=uid, module=MODULE, action=action, record_id=wo.id, record_name=wo.wo_number,
                      ip=get_request_ip(request) if request else "", old_data=old, new_data=new, description=description)


def notify(db: Session, uid: Optional[int], title: str, msg: str, rid: int, action: str) -> None:
    if not uid:
        return
    try:
        from app.services.notification_service import upsert_notification
        upsert_notification(db, uid, title, msg, module=MODULE, record_id=rid, action=action, action_url=f"/workorders?open={rid}", send_email=False)
    except Exception as exc:
        logger.warning("order notification failed: %s", exc)


def emit(db: Session, wo: WorkOrder, event: str, actor: Optional[User], extra: Optional[dict] = None) -> None:
    from app.routers.workorder_router import _emit_workorder_event
    _emit_workorder_event(db, work_order=wo, event_key=event, actor=actor, extra_context=extra)


def create_order(db: Session, cu: User, request: Optional[Request], v: dict[str, Any], *, lifecycle: str = DEFAULT_KEY, source: Optional[dict] = None,
                 parent: Optional[WorkOrder] = None, deal_id: Optional[int] = None, auto_key: Optional[str] = None, commit: bool = True) -> WorkOrder:
    cfg = config(db)
    lcs = lifecycles(db)
    lc = next((l for l in lcs if l["key"] == lifecycle), None)
    if not lc:
        raise HTTPException(422, "That order lifecycle is not configured")
    pm = v.get("pm") or (cu.id if cfg["auto_pm"] else None)
    src = source or {}
    for attempt in range(3):
        number = next_number(db, v.get("po"), cfg)
        wo = WorkOrder(wo_number=number, wo_type=_wo_type(lc["type"]), customer_id=v["customer"]["id"], customer_name=v["customer"]["customer_name"] or "—",
                       po_number=v.get("po"), po_value=v.get("value") or 0, wo_value=v.get("value") or 0, project_title=v["title"], completion_date=v.get("due"),
                       project_manager_id=pm, status="Draft", progress_percent=0, created_by=cu.id,
                       retention_percent=Decimal(str(cfg["retention_pct"])) if cfg["retention"] else 0,
                       tender_id=src.get("tender_id"), lead_id=src.get("lead_id"), quotation_id=src.get("quotation_id"),
                       custom_data=v.get("custom") or None, payment_terms=src.get("payment_terms"))
        db.add(wo)
        try:
            db.flush()
            break
        except IntegrityError:
            db.rollback()
            if attempt == 2:
                raise HTTPException(409, "Could not allocate an order number – try again")
    first = next(s for s in lc["stages"] if s["kind"] == "open")
    db.add(OrderProfile(wo_id=wo.id, lifecycle=lc["key"], start_date=v.get("start") or today_ist(), stage_entered_at=now_ist(),
                        parent_wo_id=parent.id if parent else None, deal_id=deal_id, auto_key=auto_key))
    db.execute(text("INSERT INTO workflow_record_stages (workflow, record_id, stage_id, mapped_at) VALUES (:w, :r, :s, :now)"),
               {"w": lc["key"], "r": wo.id, "s": first["id"], "now": now_ist()})
    what = f"{lc['type']} order {wo.wo_number} created" + (f" from {parent.wo_number}" if parent else "") + (f" ({src['label']})" if src.get("label") else "")
    _log(db, cu, request, wo, "create", what, new={"wo_number": wo.wo_number, "title": wo.project_title, "customer": wo.customer_name, "po": wo.po_number,
                                                     "value": float(v.get("value") or 0), "lifecycle": lc["key"], "parent": parent.wo_number if parent else None})
    emit(db, wo, "created", cu)
    if pm and pm != cu.id:
        notify(db, pm, "Order assigned", f"{cu.full_name} made you project manager of {wo.wo_number} – {wo.project_title}.", wo.id, "assigned")
    if commit:
        db.commit()
    return wo


def update_order(db: Session, cu: User, request: Request, wo: WorkOrder, v: dict[str, Any]) -> None:
    prof = db.query(OrderProfile).filter(OrderProfile.wo_id == wo.id).first()
    old = {"title": wo.project_title, "customer": wo.customer_name, "po": wo.po_number, "value": float(value_of(wo)),
           "start": prof.start_date.isoformat() if prof and prof.start_date else None, "due": due_of(wo).isoformat() if due_of(wo) else None,
           "pm": wo.project_manager_id}
    wo.project_title, wo.customer_id, wo.customer_name, wo.po_number = v["title"], v["customer"]["id"], v["customer"]["customer_name"], v["po"]
    if v["value"] is not None:
        wo.wo_value = wo.po_value = v["value"]
    wo.completion_date = v["due"]
    prev_pm = wo.project_manager_id
    wo.project_manager_id = v["pm"]
    if prof:
        prof.start_date = v["start"]
    if v.get("custom") is not None:
        wo.custom_data = {**(wo.custom_data if isinstance(wo.custom_data, dict) else {}), **v["custom"]}
    new = {"title": wo.project_title, "customer": wo.customer_name, "po": wo.po_number, "value": float(value_of(wo)),
           "start": v["start"].isoformat() if v["start"] else None, "due": v["due"].isoformat() if v["due"] else None, "pm": wo.project_manager_id}
    diff = {k: {"old": old[k], "new": new[k]} for k in new if old[k] != new[k]}
    if diff:
        _log(db, cu, request, wo, "update", "Order updated: " + ", ".join(diff), old={k: d["old"] for k, d in diff.items()}, new={k: d["new"] for k, d in diff.items()}, icon="✏️")
        emit(db, wo, "updated", cu, {"changes": diff})
    if wo.project_manager_id and wo.project_manager_id != prev_pm and wo.project_manager_id != cu.id:
        notify(db, wo.project_manager_id, "Order assigned", f"{cu.full_name} made you project manager of {wo.wo_number} – {wo.project_title}.", wo.id, "assigned")
    db.commit()


def delete_order(db: Session, cu: User, request: Request, wo: WorkOrder) -> None:
    if db.query(WOInvoice.id).filter(WOInvoice.wo_id == wo.id).first():
        raise HTTPException(409, f"{wo.wo_number} has invoices – it cannot be deleted")
    from app.models.commitments import OrderPaymentReceipt
    if db.query(OrderPaymentReceipt.id).filter(OrderPaymentReceipt.wo_id == wo.id).first():
        raise HTTPException(409, f"{wo.wo_number} has customer receipts – it cannot be deleted")
    kids = db.query(OrderProfile.wo_id).filter(OrderProfile.parent_wo_id == wo.id).count()
    if kids:
        raise HTTPException(409, f"{wo.wo_number} has {kids} follow-on contract{'s' if kids > 1 else ''} – delete those first")
    snap = {"wo_number": wo.wo_number, "title": wo.project_title, "customer": wo.customer_name, "po": wo.po_number, "value": float(value_of(wo)),
            "tender_id": wo.tender_id, "quotation_id": wo.quotation_id, "lead_id": wo.lead_id}
    # back-links only – the tender and quote records themselves are left as they are
    db.execute(text("UPDATE tenders SET wrk_order_id = NULL WHERE wrk_order_id = :n"), {"n": wo.wo_number})
    if _has_table(db, "quote_profiles"):
        db.execute(text("UPDATE quote_profiles SET work_order_id = NULL WHERE work_order_id = :i"), {"i": wo.id})
    for wf in ("wo",) + tuple(r[0] for r in db.query(OrderLifecycle.workflow).all()):
        db.execute(text("DELETE FROM workflow_record_stages WHERE workflow = :w AND record_id = :r"), {"w": wf, "r": wo.id})
    from app.core.logging import log_module_action
    log_module_action(db=db, user_id=cu.id, module=MODULE, action="delete", record_id=wo.id, record_name=wo.wo_number, ip=get_request_ip(request),
                      old_data=snap, description=f"Order {wo.wo_number} deleted")
    db.delete(wo)
    db.commit()


def _has_table(db: Session, name: str) -> bool:
    return db.execute(text("SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = :t"), {"t": name}).first() is not None


# ─── stage engine ─────────────────────────────────────────────────────────────

LEGACY_STATUS = {"won": "Closed"}


def apply_stage(db: Session, cu: Optional[User], request: Optional[Request], wo: WorkOrder, prof: OrderProfile, lc: dict, target: dict) -> list[WorkOrder]:
    old = db.execute(text("SELECT s.name FROM workflow_record_stages m JOIN workflow_stages s ON s.id = m.stage_id WHERE m.workflow = :w AND m.record_id = :r"),
                     {"w": lc["key"], "r": wo.id}).scalar()
    now = now_ist()
    db.execute(text("INSERT INTO workflow_record_stages (workflow, record_id, stage_id, mapped_at) VALUES (:w, :r, :s, :now) "
                    "ON DUPLICATE KEY UPDATE stage_id = VALUES(stage_id), mapped_at = VALUES(mapped_at)"), {"w": lc["key"], "r": wo.id, "s": target["id"], "now": now})
    prof.stage_entered_at, prof.pending_stage_id, prof.approval_request_id = now, None, None
    # keep the legacy status meaningful for reports and the legacy API
    first = next(s for s in lc["stages"] if s["kind"] == "open")
    if target["kind"] == "won":
        wo.status, wo.progress_percent = "Closed", 100
    elif target["id"] == first["id"]:
        wo.status = wo.status if wo.status in ("Draft", "Confirmed") else "Confirmed"
    else:
        wo.status = "In Progress"
    _log(db, cu, request, wo, "stage_change", f"Stage changed: {old or '—'} → {target['name']}", old={"stage": old}, new={"stage": target["name"], "lifecycle": lc["key"]}, icon="🔄")
    emit(db, wo, "completed" if target["kind"] == "won" else "progress_changed", cu, {"stage": target["name"]})
    if wo.project_manager_id and (not cu or wo.project_manager_id != cu.id):
        notify(db, wo.project_manager_id, "Order stage changed", f"{wo.wo_number} moved to {target['name']}" + (f" by {cu.full_name}." if cu else "."), wo.id, "stage_changed")
    created: list[WorkOrder] = []
    if target["kind"] == "won" and not prof.parent_wo_id and cu:
        for l in lifecycles(db):
            if l["trigger"] == "closure" and l["key"] != lc["key"]:
                fo = follow_on(db, cu, request, wo, l["key"], auto=True)
                if fo:
                    created.append(fo)
    return created


def move(db: Session, cu: User, request: Request, wo: WorkOrder, stage_id: int, checklist: Optional[list[str]] = None) -> dict[str, Any]:
    lcs = lifecycles(db, include_inactive=True)
    profiles, st = sync(db, [wo], lcs)
    info, prof = st.get(wo.id), profiles.get(wo.id)
    if not info:
        raise HTTPException(409, "No order lifecycle is configured")
    lc, cur = info["lc"], info["stage"]
    target = next((s for s in lc["stages"] if s["id"] == stage_id), None)
    if not target:
        raise HTTPException(422, "That stage is not part of this order's lifecycle")
    if target["id"] == cur["id"]:
        return {"status": "unchanged", "stage": cur["name"]}
    db.execute(text("SELECT wo_id FROM order_profiles WHERE wo_id = :i FOR UPDATE"), {"i": wo.id})
    if prof.pending_stage_id:
        raise HTTPException(409, "A stage change is waiting for approval")
    if cur["kind"] == "won" and not user_has_permission(db, cu, "settings.manage"):
        raise HTTPException(403, "Only managers can reopen a closed order")
    order = [s["id"] for s in lc["stages"]]
    forward = order.index(target["id"]) > order.index(cur["id"])
    if forward:
        passed = lc["stages"][order.index(cur["id"]) + 1: order.index(target["id"]) + 1]
        need = [s for s in passed if s["gate"] == "Checklist" and s["checklist"]]
        if need:
            done = {str(x).strip() for x in checklist or []}
            gate = need[-1] if target in need else need[0]
            todo = [i for i in gate["checklist"] if i not in done] if gate["id"] == target["id"] else gate["checklist"]
            if gate["id"] != target["id"]:
                raise HTTPException(422, f"Move through “{gate['name']}” first – its checklist must be completed")
            if todo:
                raise HTTPException(422, {"message": f"Complete the checklist for {target['name']}", "checklist": target["checklist"], "missing_items": todo})
            prof.checklist = {**(prof.checklist or {}), target["name"]: list(target["checklist"])}
        gated = [s for s in passed if s["gate"] == "Approval"]
        if gated:
            from app.services.generic_approval_engine import create_generic_approval_request
            req = create_generic_approval_request(db, tenant_id=getattr(getattr(request.state, "tenant", None), "id", None), requester=cu,
                                                  module_key="work_order", action_key="stage", record_id=wo.id)
            from app.services.approvals360_service import apply_stage_policy   # Process Designer stage approval policy (chain · threshold · SLA)
            req = apply_stage_policy(db, req, (lc or {}).get("key") if isinstance(lc, dict) else getattr(lc, "key", None), gated[-1]["name"], cur["name"], float(wo.wo_value or wo.po_value or 0))
            if (req.status or "").strip().lower() != "approved":
                prof.pending_stage_id, prof.approval_request_id = target["id"], req.id
                step = next((s for s in sorted(req.steps or [], key=lambda x: x.step_no) if s.step_no == req.current_step_no), None)
                approver = step.approver.full_name if step is not None and getattr(step, "approver", None) else None
                _log(db, cu, request, wo, "approval_requested", f"Stage change to {target['name']} sent for approval" + (f" ({approver})" if approver else ""),
                     new={"to": target["name"], "approval_request_id": req.id, "gate": gated[-1]["name"]}, icon="⏳")
                db.commit()
                return {"status": "pending", "stage": cur["name"], "pending_stage": target["name"], "approver": approver,
                        "message": f"“{target['name']}” needs approval – sent to {approver or 'the approver'}"}
    created = apply_stage(db, cu, request, wo, prof, lc, target)
    db.commit()
    res: dict[str, Any] = {"status": "moved", "stage": target["name"]}
    if created:
        res["follow_ons"] = [{"id": f.id, "ref": f.wo_number} for f in created]
        res["message"] = f"Moved to {target['name']} · follow-on " + ", ".join(f.wo_number for f in created) + " created"
    return res


def on_stage_decision(db: Session, request_row, actor: User, remarks: str = "") -> None:
    """Approval engine callback (module "work_order", action "stage")."""
    prof = db.query(OrderProfile).filter(OrderProfile.approval_request_id == request_row.id).first()
    if not prof or not prof.pending_stage_id:
        return
    wo = db.query(WorkOrder).filter(WorkOrder.id == prof.wo_id).first()
    if not wo:
        return
    lc = next((l for l in lifecycles(db, include_inactive=True) if l["key"] == prof.lifecycle), None)
    target = next((s for s in (lc or {}).get("stages", []) if s["id"] == prof.pending_stage_id), None)
    status = (request_row.status or "").strip().lower()
    if status == "approved" and lc and target:
        apply_stage(db, actor, None, wo, prof, lc, target)
        notify(db, wo.created_by, "Stage change approved", f"{wo.wo_number} moved to {target['name']} after approval.", wo.id, "stage_approved")
    elif status == "rejected":
        name = target["name"] if target else "the requested stage"
        prof.pending_stage_id = prof.approval_request_id = None
        _log(db, actor, None, wo, "approval_rejected", f"Stage change to {name} rejected" + (f" – {remarks}" if remarks else ""), new={"to": name, "remarks": remarks or None}, icon="⛔")
        for uid in {wo.created_by, wo.project_manager_id}:
            notify(db, uid, "Stage change rejected", f"Moving {wo.wo_number} to {name} was rejected" + (f": {remarks}" if remarks else "."), wo.id, "stage_rejected")


# ─── follow-on contracts ──────────────────────────────────────────────────────

def follow_on(db: Session, cu: User, request: Optional[Request], parent: WorkOrder, key: str, auto: bool = False) -> Optional[WorkOrder]:
    """Prototype olFollow(): a contract of another lifecycle for the same customer, PO, PM and journey. One per parent and
    lifecycle (auto_key) – a second request returns None (auto) or 409 (manual)."""
    lc = next((l for l in lifecycles(db) if l["key"] == key), None)
    if not lc or key == DEFAULT_KEY:
        raise HTTPException(422, "Choose a follow-on lifecycle")
    ak = f"fo:{parent.id}:{key}"
    existing = db.query(OrderProfile.wo_id).filter(OrderProfile.auto_key == ak).first()
    if existing:
        if auto:
            return None
        n = db.query(WorkOrder.wo_number).filter(WorkOrder.id == existing.wo_id).scalar()
        raise HTTPException(409, {"message": f"{lc['type']} contract {n} already exists for {parent.wo_number}", "id": existing.wo_id})
    pprof = db.query(OrderProfile).filter(OrderProfile.wo_id == parent.id).first()
    val = q2(value_of(parent) * Decimal("0.1") / 1000) * 1000 if value_of(parent) else Decimal(0)
    v = {"title": f"{parent.project_title or parent.wo_number} – {lc['type']}"[:300], "customer": {"id": parent.customer_id, "customer_name": parent.customer_name},
         "po": parent.po_number, "value": q2(val), "start": today_ist() + timedelta(days=7), "due": today_ist() + timedelta(days=372), "pm": parent.project_manager_id}
    sp = db.begin_nested()
    try:
        wo = create_order(db, cu, request, v, lifecycle=key, source={"lead_id": parent.lead_id, "tender_id": parent.tender_id, "quotation_id": parent.quotation_id,
                                                                      "label": "automatic follow-on" if auto else "follow-on"},
                          parent=parent, deal_id=pprof.deal_id if pprof else None, auto_key=ak, commit=False)
        sp.commit()
    except IntegrityError:
        sp.rollback()
        if auto:
            return None
        raise HTTPException(409, f"A {lc['type']} contract already exists for {parent.wo_number}")
    _log(db, cu, request, parent, "follow_on", f"{lc['type']} contract {wo.wo_number} created", new={"follow_on": wo.wo_number, "lifecycle": key}, icon="🔁")
    return wo


def on_deal_won(db: Session, cu: User, lead: Lead) -> list[WorkOrder]:
    """Lifecycles with trigger "won": one order per won deal and lifecycle, in the deal's transaction (savepoints)."""
    try:
        lcs = [l for l in lifecycles(db) if l["trigger"] == "won"]
        if not lcs or not lead.customer_id:
            return []
        out = []
        for l in lcs:
            ak = f"won:{lead.id}:{l['key']}"
            if db.query(OrderProfile.wo_id).filter(OrderProfile.auto_key == ak).first():
                continue
            v = {"title": (lead.lead_title or f"Deal {lead.id}")[:300], "customer": {"id": lead.customer_id, "customer_name": lead.customer_name or "—"},
                 "po": None, "value": q2(dec(lead.est_value)), "start": today_ist(), "due": None, "pm": lead.assigned_to}
            sp = db.begin_nested()
            try:
                out.append(create_order(db, cu, None, v, lifecycle=l["key"], source={"lead_id": lead.id, "label": f"deal {lead.opportunity_ref_id or lead.id} won"},
                                        deal_id=lead.id, auto_key=ak, commit=False))
                sp.commit()
            except Exception as exc:
                sp.rollback()
                logger.warning("order on deal won (%s) failed: %s", ak, exc)
        return out
    except Exception as exc:
        logger.warning("orders: deal-won trigger skipped: %s", exc)
        return []


# ─── milestones & invoices ────────────────────────────────────────────────────

def _ms_json(m: WOMilestone, inv: Optional[WOInvoice]) -> dict[str, Any]:
    return {"id": m.id, "name": m.title, "date": m.due_date.isoformat() if m.due_date else None, "amount": float(dec(m.amount)),
            "done": m.status == "Completed", "status": "Done" if m.status == "Completed" else "Pending",
            "completed": m.completed_date.isoformat() if m.completed_date else None, "notes": m.notes or "",
            "overdue": bool(m.due_date and m.due_date < today_ist() and m.status != "Completed"),
            "invoice": {"id": inv.id, "number": inv.invoice_number, "date": inv.invoice_date.isoformat() if inv.invoice_date else None,
                        "amount": float(dec(inv.total_amount)), "status": inv.payment_status} if inv else None}


def sync_progress(db: Session, wo: WorkOrder) -> None:
    """Persist the measured progress on the order (legacy reports read progress_percent)."""
    lcs = lifecycles(db, include_inactive=True)
    _, st = sync(db, [wo], lcs)
    ms, _ = metrics(db, [wo.id])
    pr = progress_of(wo, ms[wo.id], st[wo.id]["stage"], config(db))
    if pr != (wo.progress_percent or 0):
        wo.progress_percent = pr
        emit(db, wo, "progress_changed", None, {"progress_percent": pr})


def save_milestone(db: Session, cu: User, request: Request, wo: WorkOrder, mid: Optional[int], body: dict[str, Any]) -> WOMilestone:
    name = (body.get("name") or "").strip()
    if not name or len(name) > 200:
        raise HTTPException(422, "Name the milestone (at most 200 characters)")
    amount = dec(body.get("amount") or 0)
    if amount < 0:
        raise HTTPException(422, "The billing amount must be zero or more")
    if mid:
        m = db.query(WOMilestone).filter(WOMilestone.id == mid, WOMilestone.wo_id == wo.id).first()
        if not m:
            raise HTTPException(404, "Milestone not found")
        old = _ms_json(m, None)
    else:
        m, old = WOMilestone(wo_id=wo.id, milestone_type="Payment" if amount > 0 else "Other", status="Pending"), None
        db.add(m)
    m.title, m.due_date, m.amount, m.notes = name, body.get("date"), q2(amount), (body.get("notes") or "").strip() or None
    done = bool(body.get("done"))
    if done and m.status != "Completed":
        m.status, m.completed_date = "Completed", body.get("completed") or today_ist()
    elif not done and m.status == "Completed":
        m.status, m.completed_date = "Pending", None
    db.flush()
    new = _ms_json(m, None)
    what = "Milestone added" if not old else ("Milestone completed" if done and not old["done"] else "Milestone reopened" if old["done"] and not done else "Milestone updated")
    _log(db, cu, request, wo, "milestone", f"{what}: {name}", old=old, new=new, icon="🏁")
    sync_progress(db, wo)
    db.commit()
    return m


def delete_milestone(db: Session, cu: User, request: Request, wo: WorkOrder, mid: int) -> None:
    m = db.query(WOMilestone).filter(WOMilestone.id == mid, WOMilestone.wo_id == wo.id).first()
    if not m:
        raise HTTPException(404, "Milestone not found")
    if getattr(m, "invoice_id", None) or db.execute(text("SELECT invoice_id FROM wo_milestones WHERE id = :i"), {"i": mid}).scalar():
        raise HTTPException(409, "This milestone is invoiced – it cannot be deleted")
    _log(db, cu, request, wo, "milestone", f"Milestone deleted: {m.title}", old=_ms_json(m, None), icon="🗑️")
    db.delete(m)
    db.flush()
    sync_progress(db, wo)
    db.commit()


def add_invoice(db: Session, cu: User, request: Request, wo: WorkOrder, body: dict[str, Any]) -> WOInvoice:
    """A billing record (wo_invoices). Linked to a milestone when one is given; Billed % is computed from these."""
    number = (body.get("number") or "").strip()
    if not number or len(number) > 100:
        raise HTTPException(422, "Enter the invoice number")
    amount = dec(body.get("amount") or 0)
    if amount <= 0:
        raise HTTPException(422, "The invoice amount must be more than zero")
    gst = dec(body.get("gst") or 0)
    if gst < 0:
        raise HTTPException(422, "GST must be zero or more")
    if db.query(WOInvoice.id).filter(func.lower(WOInvoice.invoice_number) == number.lower()).first():
        raise HTTPException(409, f"Invoice {number} is already recorded")
    m = None
    if body.get("milestone_id"):
        m = db.query(WOMilestone).filter(WOMilestone.id == int(body["milestone_id"]), WOMilestone.wo_id == wo.id).first()
        if not m:
            raise HTTPException(404, "Milestone not found")
        if db.execute(text("SELECT invoice_id FROM wo_milestones WHERE id = :i FOR UPDATE"), {"i": m.id}).scalar():
            raise HTTPException(409, "This milestone is already invoiced")
    inv = WOInvoice(wo_id=wo.id, invoice_number=number, invoice_date=body.get("date") or today_ist(), due_date=body.get("due"), amount=q2(amount), gst_amount=q2(gst),
                    total_amount=q2(amount + gst), payment_status="Pending", paid_amount=0, notes=(body.get("notes") or "").strip() or None)
    db.add(inv)
    db.flush()
    if m:
        db.execute(text("UPDATE wo_milestones SET invoice_id = :v WHERE id = :i"), {"v": inv.id, "i": m.id})
    _log(db, cu, request, wo, "invoice", f"Invoice {number} recorded" + (f" for milestone {m.title}" if m else ""),
         new={"invoice": number, "amount": float(amount + gst), "milestone": m.title if m else None}, icon="🧾")
    db.commit()
    return inv


def milestones(db: Session, wo: WorkOrder) -> dict[str, Any]:
    ms, inv_tot = metrics(db, [wo.id])
    links = dict(db.execute(text("SELECT id, invoice_id FROM wo_milestones WHERE wo_id = :w AND invoice_id IS NOT NULL"), {"w": wo.id}).all())
    invs = {i.id: i for i in db.query(WOInvoice).filter(WOInvoice.wo_id == wo.id).order_by(WOInvoice.invoice_date, WOInvoice.id).all()}
    return {"items": [_ms_json(m, invs.get(links.get(m.id))) for m in ms[wo.id]],
            "invoices": [{"id": i.id, "number": i.invoice_number, "date": i.invoice_date.isoformat() if i.invoice_date else None, "amount": float(dec(i.total_amount)),
                          "status": i.payment_status, "milestone_id": next((k for k, v in links.items() if v == i.id), None)} for i in invs.values()],
            "invoiced": float(inv_tot.get(wo.id, Decimal(0)))}


def set_progress(db: Session, cu: User, request: Request, wo: WorkOrder, pct: int) -> None:
    if not 0 <= pct <= 100:
        raise HTTPException(422, "Progress must be between 0 and 100")
    cfg = config(db)
    if cfg["milestones"] and db.query(WOMilestone.id).filter(WOMilestone.wo_id == wo.id).first():
        raise HTTPException(409, "Progress is measured from the milestones of this order – complete milestones instead")
    old = wo.progress_percent or 0
    wo.progress_percent = pct
    _log(db, cu, request, wo, "progress", f"Progress updated: {old}% → {pct}%", old={"progress": old}, new={"progress": pct}, icon="📈")
    emit(db, wo, "progress_changed", cu, {"progress_percent": pct})
    db.commit()


# ─── overdue milestone alerts (background job) ────────────────────────────────

def milestone_alerts(db: Session) -> int:
    """Settings → Alert when a milestone slips: notify the PM (else the creator) once per overdue milestone."""
    if not config(db)["slip_alert"]:
        return 0
    today = today_ist()
    rows = (db.query(WOMilestone, WorkOrder).join(WorkOrder, WorkOrder.id == WOMilestone.wo_id)
            .filter(WOMilestone.due_date < today, WOMilestone.status != "Completed").all())
    if not rows:
        return 0
    from app.models.all_models import Notification
    sent = {r[0] for r in db.query(Notification.record_id).filter(Notification.module == MODULE, Notification.action == "milestone_overdue").all()}
    n = 0
    for m, wo in rows:
        uid = wo.project_manager_id or wo.created_by
        if not uid:
            continue
        key = m.id   # one alert per milestone: record_id holds the milestone id for this action
        if key in sent:
            continue
        try:
            from app.services.notification_service import upsert_notification
            upsert_notification(db, uid, "Milestone overdue", f"{wo.wo_number} – milestone “{m.title}” was due {m.due_date.strftime('%d %b %Y')} and is not complete.",
                                module=MODULE, record_id=m.id, action="milestone_overdue", action_url=f"/workorders?open={wo.id}", send_email=True)
            n += 1
        except Exception as exc:
            logger.warning("milestone alert failed: %s", exc)
    db.commit()
    return n


def run_milestone_alerts_for_all_tenants() -> dict[str, int]:
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant
    m = MasterSessionLocal()
    try:
        slugs = [t.slug for t in m.query(Tenant).all()]
    finally:
        m.close()
    out: dict[str, int] = {}
    for slug in slugs:
        try:
            db = get_tenant_session(slug)
        except Exception:
            continue
        try:
            db.info["tenant_slug"] = slug
            ensure_schema(db)
            k = milestone_alerts(db)
            if k:
                out[slug] = k
        except Exception as exc:
            db.rollback()
            logger.warning("milestone alerts for %s failed: %s", slug, exc)
        finally:
            db.close()
    return out


# ─── record drawer ────────────────────────────────────────────────────────────

def journey(db: Session, wo: WorkOrder, prof: OrderProfile, stage: dict) -> dict[str, Any]:
    """Prototype journeyHTML(): Lead → Deal → Tender / Quote → Work order → Follow-on contract (source references only)."""
    parent = db.query(WorkOrder).filter(WorkOrder.id == prof.parent_wo_id).first() if prof.parent_wo_id else None
    base = parent or wo
    lead_id = base.lead_id
    ten = db.query(Tender).filter(Tender.id == base.tender_id).first() if base.tender_id else None
    q = db.query(Quotation).filter(Quotation.id == base.quotation_id).first() if base.quotation_id else None
    lead_id = lead_id or (ten.lead_id if ten else None) or (q.lead_id if q else None)
    lead = db.query(Lead).filter(Lead.id == lead_id).first() if lead_id else None
    d = lambda x: x.date().isoformat() if isinstance(x, datetime) else (x.isoformat() if x else None)  # noqa: E731
    steps = []
    is_opp = bool(lead and lead.opportunity_ref_id)
    lead_step = bool(lead and (lead.lead_type or "lead") != "direct_opportunity")
    steps.append({"k": "lead", "label": "Lead", "ref": lead.lead_ref_id if lead_step else None, "route": f"/leads?open={lead.id}" if lead_step else None,
                  "stage": "Converted" if lead_step and is_opp else (lead.status if lead_step else None), "done": lead_step, "date": d(lead.created_at) if lead_step else None})
    steps.append({"k": "deal", "label": "Deal", "ref": lead.opportunity_ref_id if is_opp else None, "route": f"/opportunities?open={lead.id}" if is_opp else None,
                  "stage": lead.status if is_opp else None, "done": is_opp, "value": float(dec(lead.est_value)) if is_opp else None, "date": d(lead.opportunity_created_at) if is_opp else None})
    if ten:
        steps.append({"k": "tq", "label": "Tender / bid", "ref": ten.tender_num or f"TND-{ten.id}", "route": f"/tenders/{ten.id}", "stage": ten.result or ten.tender_status,
                      "done": True, "value": float(dec(ten.po_value or ten.est_value)), "date": d(ten.created_at)})
    elif q:
        root = db.query(func.min(Quotation.id)).filter(Quotation.quotation_number == q.quotation_number).scalar()
        steps.append({"k": "tq", "label": "Quote", "ref": q.quotation_number, "route": f"/quotations/{root}", "stage": q.status, "done": True, "date": d(q.created_at)})
    else:
        steps.append({"k": "tq", "label": "Tender / Quote", "ref": None, "route": None, "stage": None, "done": False})
    steps.append({"k": "order", "label": "Work order", "ref": base.wo_number, "route": None if base.id == wo.id else f"/workorders?open={base.id}",
                  "stage": stage["name"] if base.id == wo.id else None, "done": True, "value": float(value_of(base)), "date": d(base.created_at), "me": base.id == wo.id})
    kids = (db.query(WorkOrder.id, WorkOrder.wo_number, WorkOrder.created_at, OrderProfile.lifecycle).join(OrderProfile, OrderProfile.wo_id == WorkOrder.id)
            .filter(OrderProfile.parent_wo_id == base.id).order_by(WorkOrder.id).all())
    lmap = {l["key"]: l["type"] for l in lifecycles(db, include_inactive=True)}
    fo = [{"id": k.id, "ref": k.wo_number, "type": lmap.get(k.lifecycle, ""), "me": k.id == wo.id, "date": d(k.created_at)} for k in kids]
    return {"id": f"J-{lead.id:04d}" if lead else None, "lead_id": lead.id if lead else None, "steps": steps, "follow_ons": fo}


def detail(db: Session, cu: User, wo: WorkOrder) -> dict[str, Any]:
    lcs = lifecycles(db, include_inactive=True)
    profiles, st = sync(db, [wo], lcs)
    prof, info = profiles[wo.id], st[wo.id]
    lc, cur = info["lc"], info["stage"]
    cfg = config(db)
    ms, inv = metrics(db, [wo.id])
    pr, bl = progress_of(wo, ms[wo.id], cur, cfg), billed_of(wo, inv.get(wo.id, Decimal(0)))
    who = names(db, [wo.project_manager_id, wo.created_by])
    due, today = due_of(wo), today_ist()
    value = value_of(wo)
    opens = [s for s in lc["stages"] if s["kind"] == "open"]
    pending = None
    if prof.pending_stage_id:
        ps = next((s for s in lc["stages"] if s["id"] == prof.pending_stage_id), None)
        pending = {"stage": ps["name"] if ps else None, "approval_request_id": prof.approval_request_id}
    signals = []
    if pr - bl >= GAP:
        signals.append({"t": "wa", "s": "Work done but not invoiced"})
    if due and due < today and cur["kind"] != "won":
        signals.append({"t": "ba", "s": f"Due date passed {(today - due).days} d ago"})
    late = [m for m in ms[wo.id] if m.due_date and m.due_date < today and m.status != "Completed"]
    if late:
        signals.append({"t": "ba", "s": f"{len(late)} milestone{'s' if len(late) > 1 else ''} overdue"})
    if pending:
        signals.append({"t": "wa", "s": f"Awaiting approval → {pending['stage']}"})
    custom = wo.custom_data if isinstance(wo.custom_data, dict) else {}
    labels = {f.field_key: f.label for f in db.query(FormField).filter(FormField.module == FORM_MODULE).all()}
    src = "Quote" if wo.quotation_id else "Tender" if wo.tender_id else "Deal" if prof.deal_id else "Direct"
    panels = [
        {"t": "Basic information", "i": "file", "f": [["Work order title", wo.project_title], ["Customer", wo.customer_name], ["Contract type", lc["type"]]]},
        {"t": "Commercials", "i": "tag", "f": [["PO number", wo.po_number], ["Order value", float(value) or None, "inr"], ["Billed", f"{bl}%"],
                                                 ["Billing model", cfg["billing_model"]]]
         + ([["Retention money", float(q2(value * dec(wo.retention_percent) / 100)) or None, "inr"]] if cfg["retention"] else [])},
        {"t": "Ownership & timeline", "i": "cal", "f": [["Start date", prof.start_date.isoformat() if prof.start_date else None, "date"],
                                                         ["Due date", due.isoformat() if due else None, "due"], ["Project manager", who.get(wo.project_manager_id), "user"],
                                                         ["Stage", cur["name"], "pill"]]},
        {"t": "Additional information", "i": "layout", "f": [["Source", src], ["Created by", who.get(wo.created_by)]]
         + [[labels.get(k, k.replace("_", " ").capitalize()), v if not isinstance(v, (dict, list)) else json.dumps(v)] for k, v in custom.items()
            if k not in ("source", "quote_id", "quotation_number", "revision", "revision_row_id", "delivery_period", "liquidated_damages") and not str(k).startswith("_")]},
    ]
    acts = db.query(ActivityLog).filter(ActivityLog.module == MODULE, ActivityLog.record_id == wo.id).order_by(ActivityLog.id.desc()).limit(200).all()
    by = names(db, [a.user_id for a in acts])
    timeline = [{"t": a.description, "by": by.get(a.user_id, "System"), "d": a.created_at.isoformat() if getattr(a, "created_at", None) else None} for a in acts]
    if not any(a.action == "create" for a in acts):
        timeline.append({"t": "Record created", "by": who.get(wo.created_by, "System"), "d": wo.created_at.isoformat() if wo.created_at else None})
    notes = db.query(OrderNote).filter(OrderNote.wo_id == wo.id).order_by(OrderNote.id.desc()).all()
    nby = names(db, [n.created_by for n in notes])
    follow = [l for l in lifecycles(db) if l["key"] != DEFAULT_KEY] if not prof.parent_wo_id else []
    return {
        "id": wo.id, "ref": wo.wo_number, "title": wo.project_title or wo.wo_number, "customer": wo.customer_name, "customer_id": wo.customer_id,
        "po": wo.po_number, "value": float(value), "start": prof.start_date.isoformat() if prof.start_date else None, "due": due.isoformat() if due else None,
        "due_in": (due - today).days if due else None, "progress": pr, "billed": bl, "billed_amount": float(inv.get(wo.id, Decimal(0))),
        "pm": who.get(wo.project_manager_id), "pm_id": wo.project_manager_id, "lifecycle": {"key": lc["key"], "type": lc["type"]},
        "stages": lc["stages"], "stage": cur, "stage_no": next((i + 1 for i, s in enumerate(opens) if s["id"] == cur["id"]), len(opens)), "stages_of": len(opens),
        "pending": pending, "signals": signals, "journey": journey(db, wo, prof, cur), "panels": panels, "timeline": timeline,
        "notes": [{"id": n.id, "body": n.body, "by": nby.get(n.created_by, ""), "by_id": n.created_by, "at": n.created_at.isoformat() if n.created_at else None} for n in notes],
        "parent": {"id": prof.parent_wo_id, "ref": db.query(WorkOrder.wo_number).filter(WorkOrder.id == prof.parent_wo_id).scalar()} if prof.parent_wo_id else None,
        "follow_on_options": [{"key": l["key"], "type": l["type"]} for l in follow],
        "progress_basis": "milestones" if cfg["milestones"] and ms[wo.id] else "stage" if cur["kind"] == "won" else "manual",
        "config": {"milestones": cfg["milestones"], "billing_model": cfg["billing_model"]},
        "form": {"title": wo.project_title or "", "customer_id": wo.customer_id, "customer_name": wo.customer_name, "po": wo.po_number or "",
                 "value": float(value) if value else None, "start": prof.start_date.isoformat() if prof.start_date else None, "due": due.isoformat() if due else None,
                 "pm_id": wo.project_manager_id, "pm_name": who.get(wo.project_manager_id), "custom_data": custom},
    }
