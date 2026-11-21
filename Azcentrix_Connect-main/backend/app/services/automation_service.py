"""Automation Studio (prototype v17) – queries & execution.

Workflow rules are configured against a small, whitelisted set of real columns per module (see MODULE_META) and
evaluated with ordinary SQLAlchemy ORM queries / Python-side comparisons – no raw SQL string-building, so there is
nothing to inject. "Run now" performs the two safe, reversible actions (create a note-task, send a notification)
for matched records up to RUN_CAP; it is not wired into every module's live create/edit/delete path – that would
need per-module testing beyond this pass, so execution stays explicit/on-demand, exactly like the prototype's own
SLA "Run now" button. Approval policies are the existing approval matrix (ApprovalRule/engine) – not duplicated
here. Webhooks are the existing Marketplace & API outbound webhooks – not duplicated here either.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.timezone import now_ist
from app.models.all_models import ActivityLog, ApprovalRequest, ApprovalRule, Customer, EMDBG, Lead, Notification, Quotation, Tender, User, WorkOrder
from app.models.automation import AUTOMATION_TABLES, AutomationAssignmentRule, AutomationRule, AutomationRunLog, AutomationScoringRule, AutomationSlaRule

logger = logging.getLogger(__name__)

_READY: set[str] = set()
_LOCK = threading.Lock()

RUN_CAP = 200   # matched records per "Run now" that actually get the safe actions applied

MODULE_META: dict[str, dict] = {
    "leads": {"label": "Leads", "model": Lead, "numeric": {"value": "est_value"}, "text": {"region": "region", "priority": "priority", "branch": "branch"}},
    "customers": {"label": "Customers", "model": Customer, "numeric": {}, "text": {"state": "billing_state", "vertical": "customer_vertical", "industry": "industry"}},
    "tenders": {"label": "Bids & Tenders", "model": Tender, "numeric": {"value": "est_value"}, "text": {}},
    "quotes": {"label": "Quotes", "model": Quotation, "numeric": {"value": "total_amount"}, "text": {"status": "status"}},
    "wo": {"label": "Orders & Projects", "model": WorkOrder, "numeric": {"value": "wo_value"}, "text": {"status": "status"}},
    "emd": {"label": "Guarantees & Deposits", "model": EMDBG, "numeric": {"value": "amount"}, "text": {"status": "status", "type": "instrument_type"}},
}
TRIGGERS = {"create": "Record is created", "edit": "Record is edited", "stage": "Stage changes", "delete": "Record is deleted"}
ACTION_TYPES = ["Create task", "Send notification", "Send email", "Update field", "Assign owner", "Move to stage", "Request approval", "Call webhook"]
SAFE_ACTIONS = {"Create task", "Send notification"}
OPS = {">=", "<=", "=", "!=", ">", "<", "contains"}

SLA_DEFS: list[dict] = [
    {"key": "tender_due_3d", "name": "Bid due in 3 days", "module": "tenders"},
    {"key": "emd_expiring_30d", "name": "Guarantee expiring in 30 days", "module": "emd"},
    {"key": "quote_expiring_5d", "name": "Quote validity ends in 5 days", "module": "quotes"},
    {"key": "wo_past_due", "name": "Work order past due date", "module": "wo"},
    {"key": "approval_over_sla", "name": "Approval pending over 48 h", "module": "approvals"},
]


def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        bind = db.get_bind()
        for t in AUTOMATION_TABLES:
            t.create(bind=bind, checkfirst=True)
        db.commit()
        if not db.query(AutomationSlaRule.id).first():
            for d in SLA_DEFS:
                db.add(AutomationSlaRule(key=d["key"], is_active=True))
            db.commit()
        _READY.add(slug)


def catalog() -> dict:
    return {
        "modules": [{"key": k, "label": v["label"], "fields": sorted(list(v["numeric"]) + list(v["text"]))} for k, v in MODULE_META.items()],
        "triggers": TRIGGERS,
        "actions": ACTION_TYPES,
        "ops": sorted(OPS),
    }


def _field_cols(module: str) -> dict[str, Any]:
    meta = MODULE_META.get(module)
    if not meta:
        raise HTTPException(400, f"Unknown module '{module}'")
    return {**meta["numeric"], **meta["text"]}


def _compare(raw: Any, op: str, target: str) -> bool:
    if raw is None:
        return False
    try:
        if op in (">=", "<=", ">", "<"):
            a, b = float(raw), float(target)
            return {">=": a >= b, "<=": a <= b, ">": a > b, "<": a < b}[op]
        s = str(raw)
        if op == "=":
            return s == target
        if op == "!=":
            return s != target
        if op == "contains":
            return target.lower() in s.lower()
    except (TypeError, ValueError):
        return False
    return False


def _matching_records(db: Session, module: str, conditions: list[dict]) -> list:
    meta = MODULE_META[module]
    cols = _field_cols(module)
    rows = db.query(meta["model"]).limit(5000).all()
    if not conditions:
        return rows
    out = []
    for row in rows:
        ok = True
        for c in conditions:
            col = cols.get(c.get("f"))
            if not col or c.get("o") not in OPS:
                continue
            if not _compare(getattr(row, col, None), c["o"], str(c.get("v", ""))):
                ok = False
                break
        if ok:
            out.append(row)
    return out


def list_rules(db: Session) -> list[dict]:
    ensure_schema(db)
    rules = db.query(AutomationRule).order_by(AutomationRule.created_at.desc()).all()
    return [_rule_out(r) for r in rules]


def _rule_out(r: AutomationRule) -> dict:
    return {"id": r.id, "n": r.name, "mod": r.module, "trig": r.trigger, "stage": r.stage or "", "conds": r.conditions or [],
            "acts": r.actions or [], "on": bool(r.is_active), "runs": r.runs, "last": r.last_run_at.isoformat() if r.last_run_at else None}


def save_rule(db: Session, cu: User, data: dict, rule_id: Optional[int] = None) -> dict:
    ensure_schema(db)
    name = (data.get("n") or "").strip()
    module = data.get("mod")
    if not name:
        raise HTTPException(422, "Name the rule")
    if module not in MODULE_META:
        raise HTTPException(422, "Pick a valid module")
    trigger = data.get("trig") or "create"
    if trigger not in TRIGGERS:
        raise HTTPException(422, "Invalid trigger")
    conds = [c for c in (data.get("conds") or []) if c.get("f") in _field_cols(module) and c.get("o") in OPS][:10]
    acts = [a for a in (data.get("acts") or []) if a.get("t") in ACTION_TYPES][:10]
    if rule_id:
        r = db.query(AutomationRule).filter(AutomationRule.id == rule_id).first()
        if not r:
            raise HTTPException(404, "Rule not found")
    else:
        r = AutomationRule(created_by=cu.id)
        db.add(r)
    r.name, r.module, r.trigger, r.stage = name, module, trigger, (data.get("stage") or "").strip() or None
    r.conditions, r.actions, r.is_active = conds, acts, bool(data.get("on", True))
    db.commit()
    db.refresh(r)
    return _rule_out(r)


def toggle_rule(db: Session, rule_id: int, on: bool) -> None:
    r = db.query(AutomationRule).filter(AutomationRule.id == rule_id).first()
    if not r:
        raise HTTPException(404, "Rule not found")
    r.is_active = on
    db.commit()


def delete_rule(db: Session, rule_id: int) -> None:
    r = db.query(AutomationRule).filter(AutomationRule.id == rule_id).first()
    if not r:
        raise HTTPException(404, "Rule not found")
    db.delete(r)
    db.commit()


def run_rule(db: Session, cu: User, rule_id: int) -> dict:
    ensure_schema(db)
    r = db.query(AutomationRule).filter(AutomationRule.id == rule_id).first()
    if not r:
        raise HTTPException(404, "Rule not found")
    matches = _matching_records(db, r.module, r.conditions or [])
    done, skipped = [], []
    for act in (r.actions or []):
        if act.get("t") in SAFE_ACTIONS:
            done.append(act["t"])
        else:
            skipped.append(act["t"])
    for row in matches[:RUN_CAP]:
        for act in (r.actions or []):
            if act.get("t") == "Create task":
                db.add(ActivityLog(user_id=cu.id, module=r.module, record_id=row.id, action="task",
                                    description=act.get("p") or f"Task from rule “{r.name}”", icon="✅"))
            elif act.get("t") == "Send notification":
                db.add(Notification(user_id=cu.id, title=r.name, message=act.get("p") or f"Rule “{r.name}” matched this {r.module[:-1] if r.module.endswith('s') else r.module} record",
                                     module=r.module, record_id=row.id, action="automation_rule"))
    r.runs += 1
    r.last_run_at = now_ist()
    result = f"{len(matches)} record(s) matched" + (f" · ran: {', '.join(sorted(set(done)))}" if done else "") + (f" · not auto-executed: {', '.join(sorted(set(skipped)))}" if skipped else "")
    db.add(AutomationRunLog(source="rule", rule_id=r.id, rule_name=r.name, module=r.module, matched=len(matches), result=result, status="Done", run_by=cu.id))
    db.commit()
    return {"matched": len(matches), "result": result}


# ─── assignment & scoring (configuration only – no live scoring/assignment engine behind this, same as the
#     prototype, which also just stores the list) ─────────────────────────────────────────────────────────

def scoring_rules(db: Session) -> list[dict]:
    ensure_schema(db)
    rows = db.query(AutomationScoringRule).order_by(AutomationScoringRule.sort_order, AutomationScoringRule.id).all()
    return [{"id": r.id, "c": r.criterion, "p": r.points, "on": bool(r.is_active)} for r in rows]


def save_scoring_rule(db: Session, data: dict, rule_id: Optional[int] = None) -> dict:
    ensure_schema(db)
    criterion = (data.get("c") or "").strip()
    if not criterion:
        raise HTTPException(422, "Describe the criterion")
    if rule_id:
        r = db.query(AutomationScoringRule).filter(AutomationScoringRule.id == rule_id).first()
        if not r:
            raise HTTPException(404, "Scoring rule not found")
    else:
        max_pos = db.query(func.max(AutomationScoringRule.sort_order)).scalar() or 0
        r = AutomationScoringRule(sort_order=max_pos + 1)
        db.add(r)
    r.criterion, r.points, r.is_active = criterion, int(data.get("p") or 0), bool(data.get("on", True))
    db.commit()
    return {"id": r.id}


def delete_scoring_rule(db: Session, rule_id: int) -> None:
    r = db.query(AutomationScoringRule).filter(AutomationScoringRule.id == rule_id).first()
    if r:
        db.delete(r)
        db.commit()


def assignment_rules(db: Session) -> list[dict]:
    ensure_schema(db)
    rows = db.query(AutomationAssignmentRule).order_by(AutomationAssignmentRule.sort_order, AutomationAssignmentRule.id).all()
    return [{"id": r.id, "a": r.condition_text, "b": r.assignee_text, "on": bool(r.is_active)} for r in rows]


def save_assignment_rule(db: Session, data: dict, rule_id: Optional[int] = None) -> dict:
    ensure_schema(db)
    cond = (data.get("a") or "").strip()
    assignee = (data.get("b") or "").strip()
    if not cond or not assignee:
        raise HTTPException(422, "Fill in both the condition and the assignee")
    if rule_id:
        r = db.query(AutomationAssignmentRule).filter(AutomationAssignmentRule.id == rule_id).first()
        if not r:
            raise HTTPException(404, "Assignment rule not found")
    else:
        max_pos = db.query(func.max(AutomationAssignmentRule.sort_order)).scalar() or 0
        r = AutomationAssignmentRule(sort_order=max_pos + 1)
        db.add(r)
    r.condition_text, r.assignee_text, r.is_active = cond, assignee, bool(data.get("on", True))
    db.commit()
    return {"id": r.id}


def delete_assignment_rule(db: Session, rule_id: int) -> None:
    r = db.query(AutomationAssignmentRule).filter(AutomationAssignmentRule.id == rule_id).first()
    if r:
        db.delete(r)
        db.commit()


# ─── scheduled & SLA ──────────────────────────────────────────────────────────

def _sla_match_count(db: Session, key: str) -> int:
    today = now_ist().date()
    if key == "tender_due_3d":
        return db.query(Tender).filter(Tender.submission_date.isnot(None), Tender.submission_date >= today, Tender.submission_date <= today + timedelta(days=3)).count()
    if key == "emd_expiring_30d":
        return db.query(EMDBG).filter(EMDBG.status == "Active", EMDBG.expiry_date.isnot(None), EMDBG.expiry_date >= today, EMDBG.expiry_date <= today + timedelta(days=30)).count()
    if key == "quote_expiring_5d":
        return db.query(Quotation).filter(Quotation.status.notin_(["Accepted", "Rejected"]), Quotation.valid_until.isnot(None),
                                           Quotation.valid_until >= today, Quotation.valid_until <= today + timedelta(days=5)).count()
    if key == "wo_past_due":
        return db.query(WorkOrder).filter(WorkOrder.status.notin_(["Completed", "Cancelled", "Closed"]), WorkOrder.delivery_date.isnot(None), WorkOrder.delivery_date < today).count()
    if key == "approval_over_sla":
        cutoff = now_ist() - timedelta(hours=48)
        return db.query(ApprovalRequest).filter(ApprovalRequest.status == "pending", ApprovalRequest.requested_at < cutoff).count()
    return 0


def sla_rules(db: Session) -> list[dict]:
    ensure_schema(db)
    defs = {d["key"]: d for d in SLA_DEFS}
    rows = db.query(AutomationSlaRule).all()
    out = []
    for r in rows:
        d = defs.get(r.key)
        if not d:
            continue
        out.append({"key": r.key, "n": d["name"], "mod": d["module"], "on": bool(r.is_active), "match": _sla_match_count(db, r.key),
                    "last": r.last_run_at.isoformat() if r.last_run_at else None})
    return out


def toggle_sla_rule(db: Session, key: str, on: bool) -> None:
    r = db.query(AutomationSlaRule).filter(AutomationSlaRule.key == key).first()
    if not r:
        raise HTTPException(404, "SLA watcher not found")
    r.is_active = on
    db.commit()


def run_sla_rule(db: Session, cu: User, key: str) -> dict:
    ensure_schema(db)
    d = next((x for x in SLA_DEFS if x["key"] == key), None)
    if not d:
        raise HTTPException(404, "SLA watcher not found")
    r = db.query(AutomationSlaRule).filter(AutomationSlaRule.key == key).first()
    count = _sla_match_count(db, key)
    r.last_run_at = now_ist()
    r.last_match_count = count
    result = f"{count} record(s) match now" if count else "No records match"
    db.add(AutomationRunLog(source="sla", source_key=key, rule_name=d["name"], module=d["module"], matched=count, result=result, status="Done", run_by=cu.id))
    db.commit()
    return {"matched": count, "result": result}


# ─── overview & run log ───────────────────────────────────────────────────────

def overview(db: Session) -> dict:
    ensure_schema(db)
    rules = db.query(AutomationRule).all()
    policies = db.query(ApprovalRule).filter(ApprovalRule.is_active.is_(True)).count()
    pending_approvals = db.query(ApprovalRequest).filter(ApprovalRequest.status == "pending").count()
    today = now_ist().date()
    runs_7d = []
    for i in range(6, -1, -1):
        day = today - timedelta(days=i)
        n = db.query(AutomationRunLog).filter(func.date(AutomationRunLog.created_at) == day).count()
        runs_7d.append({"l": day.strftime("%d %b"), "v": n})
    most_active = sorted([{"n": r.name, "r": r.runs} for r in rules], key=lambda x: -x["r"])[:5]
    return {
        "active_rules": sum(1 for r in rules if r.is_active),
        "policies": policies,
        "runs_7d": sum(x["v"] for x in runs_7d),
        "runs_7d_series": runs_7d,
        "pending_approvals": pending_approvals,
        "most_active": most_active,
    }


def run_log(db: Session, limit: int = 100) -> list[dict]:
    ensure_schema(db)
    rows = db.query(AutomationRunLog).order_by(AutomationRunLog.created_at.desc()).limit(limit).all()
    return [{"t": r.created_at.isoformat(), "r": r.rule_name, "mod": r.module, "matched": r.matched, "a": r.result, "s": r.status} for r in rows]
