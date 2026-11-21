"""Workflow templates: industry-ready tender pipelines kept centrally and pushed to one tenant at a time.

Templates and their stages live in the platform database. Pushing one writes the tenant's tender workflow
(stages, SLAs, approval / checklist gates) into the tenant's own database and maps every existing tender to a
stage of the new workflow: a stage with the same name keeps its records, won / lost outcomes stay won / lost,
and records in removed stages move to the nearest stage by position. The tenant's ``tenders`` rows themselves
are never modified – the mapping is kept in ``workflow_record_stages``.

Everything in the tenant database happens in one transaction; any failure rolls the whole push back.
"""

from __future__ import annotations

import json
import logging
from collections import Counter
from datetime import datetime
from typing import Callable, Optional

from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.database import get_tenant_session, master_engine
from app.models.platform_workflow import PlatformTenantWorkflow, PlatformWorkflowTemplate, PlatformWorkflowTemplateStage
from app.models.tenant import Tenant
from app.services.tenant_hierarchy import _existing_tables, tender_stages

logger = logging.getLogger(__name__)

WORKFLOW = "tender"
GATES = ("None", "Approval", "Checklist")
OUTCOMES = ("Won", "Lost")
# Tender results that end a tender regardless of its status in the tenant app.
WON_RESULTS, LOST_RESULTS = ("Won",), ("Lost", "Cancelled")

# Bidwise prototype TPL → WFD (t1, t3, t5, t6): "name|SLA days|gate|owner|checklist;items".
CATALOG = [
    ("t1", "EPC tender-led · 9 steps", [
        "Identified|2|None|Bid Manager", "Go / No-Go|3|Approval|Sales Head", "Document Purchase|2", "Pre-bid Meeting|5", "Bid Preparation|10",
        "Tech Bid Submitted|1|Checklist|Bid Manager|EMD furnished;Tech bid uploaded;Power of attorney attached", "Tech Evaluation|15",
        "Price Bid Opened|7", "Negotiation|5"]),
    ("t3", "Defence & OEM-heavy · 11 steps", [
        "Identified|2", "Go / No-Go|3|Approval|Sales Head", "Eligibility Check|3|Checklist||Past performance;OEM authorisation;Turnover certificate",
        "OEM Quotation|7", "Pre-bid Query|5", "Bid Preparation|10", "Technical Submission|1", "Demo / Trial|10", "Tech Evaluation|15", "Price Bid|5",
        "Negotiation|7"]),
    ("t5", "Lean bidding · 6 steps", ["Identified|2", "Go / No-Go|3|Approval", "Bid Preparation|8", "Submitted|1", "Evaluation|14", "Negotiation|5"]),
    ("t6", "Quotation-first · 4 steps", ["Enquiry|1", "Quote Sent|2", "Technical Clarification|5", "Commercial Negotiation|7"]),
]


def _parse(spec: str) -> dict:
    name, sla, gate, owner, req = (spec.split("|") + [""] * 5)[:5]
    return {"name": name, "kind": "open", "sla_days": int(sla or 0), "gate": gate or "None", "owner_role": owner or None,
            "checklist": [r for r in req.split(";") if r] or None}


_ready: dict[str, bool] = {}


def ensure_schema() -> None:
    """Create the template tables and add any catalogue template that isn't stored yet (existing ones are left as edited)."""
    if _ready.get("schema"):
        return
    for model in (PlatformWorkflowTemplate, PlatformWorkflowTemplateStage, PlatformTenantWorkflow):
        model.__table__.create(bind=master_engine, checkfirst=True)
    with Session(master_engine) as db:
        stored = {key for (key,) in db.query(PlatformWorkflowTemplate.key).all()}
        for order, (key, name, specs) in enumerate(CATALOG):
            if key in stored:
                continue
            template = PlatformWorkflowTemplate(key=key, name=name, workflow=WORKFLOW, sort_order=order)
            db.add(template)
            db.flush()
            stages = [_parse(s) for s in specs] + [{"name": n, "kind": n.lower(), "sla_days": 0, "gate": "None", "owner_role": None, "checklist": None} for n in OUTCOMES]
            db.add_all(PlatformWorkflowTemplateStage(template_id=template.id, position=i, **s) for i, s in enumerate(stages))
        db.commit()
    _ready["schema"] = True


class WorkflowTemplateError(Exception):
    pass


def validate_stages(stages: list[dict]) -> None:
    """A pushable workflow: named, unique open stages first, then exactly one won and one lost outcome; gates well-formed."""
    if not any(s["kind"] == "open" for s in stages):
        raise WorkflowTemplateError("The template has no open stages")
    kinds = Counter(s["kind"] for s in stages)
    if kinds["won"] != 1 or kinds["lost"] != 1 or set(kinds) - {"open", "won", "lost"}:
        raise WorkflowTemplateError("The template needs exactly one won and one lost outcome")
    if [s["kind"] for s in stages] != sorted((s["kind"] for s in stages), key=lambda k: k != "open"):
        raise WorkflowTemplateError("Outcomes must come after every open stage")
    seen: set[str] = set()
    for s in stages:
        name = (s["name"] or "").strip()
        if not name or len(name) > 150:
            raise WorkflowTemplateError("Every stage needs a name of at most 150 characters")
        if name.lower() in seen:
            raise WorkflowTemplateError(f"Stage “{name}” appears twice")
        seen.add(name.lower())
        if s["gate"] not in GATES:
            raise WorkflowTemplateError(f"Stage “{name}” has an unknown gate “{s['gate']}”")
        if s["gate"] == "Checklist" and not s.get("checklist"):
            raise WorkflowTemplateError(f"Checklist gate on “{name}” has no checklist items")
        if not 0 <= int(s["sla_days"] or 0) <= 365:
            raise WorkflowTemplateError(f"Stage “{name}” has an SLA outside 0–365 days")


def _stage_dict(s: PlatformWorkflowTemplateStage) -> dict:
    return {"position": s.position, "name": s.name, "kind": s.kind, "sla_days": s.sla_days, "gate": s.gate, "owner_role": s.owner_role,
            "checklist": s.checklist or []}


def templates(db: Session, allowed_tenant_ids: Optional[list[int]]) -> list[dict]:
    """Active templates with their stages in order and how many (visible) tenants use each: two queries in total."""
    ensure_schema()
    rows = (db.query(PlatformWorkflowTemplate, PlatformWorkflowTemplateStage)
            .join(PlatformWorkflowTemplateStage, PlatformWorkflowTemplateStage.template_id == PlatformWorkflowTemplate.id)
            .filter(PlatformWorkflowTemplate.is_active == True, PlatformWorkflowTemplate.workflow == WORKFLOW)  # noqa: E712
            .order_by(PlatformWorkflowTemplate.sort_order, PlatformWorkflowTemplate.id, PlatformWorkflowTemplateStage.position).all())
    usage = db.query(PlatformTenantWorkflow.template_id, func.count(PlatformTenantWorkflow.id)).filter(PlatformTenantWorkflow.workflow == WORKFLOW)
    if allowed_tenant_ids is not None:
        usage = usage.filter(PlatformTenantWorkflow.tenant_id.in_(allowed_tenant_ids or [0]))
    used = dict(usage.group_by(PlatformTenantWorkflow.template_id).all())
    out: dict[int, dict] = {}
    for t, s in rows:
        item = out.setdefault(t.id, {"id": t.id, "key": t.key, "name": t.name, "tenants": int(used.get(t.id, 0)), "stages": []})
        item["stages"].append(_stage_dict(s))
    return list(out.values())


def template_with_stages(db: Session, template_id: int) -> tuple[Optional[PlatformWorkflowTemplate], list[dict]]:
    ensure_schema()
    template = db.get(PlatformWorkflowTemplate, template_id)
    if template is None:
        return None, []
    stages = db.query(PlatformWorkflowTemplateStage).filter(PlatformWorkflowTemplateStage.template_id == template_id).order_by(PlatformWorkflowTemplateStage.position).all()
    return template, [_stage_dict(s) for s in stages]


def eligible_tenants_query(db: Session, allowed_tenant_ids: Optional[list[int]]):
    """Tenants a template can be pushed to: not cancelled or scheduled for deletion, within the admin's scope."""
    q = db.query(Tenant.id, Tenant.name, Tenant.status, PlatformWorkflowTemplate.name.label("template")) \
        .outerjoin(PlatformTenantWorkflow, (PlatformTenantWorkflow.tenant_id == Tenant.id) & (PlatformTenantWorkflow.workflow == WORKFLOW)) \
        .outerjoin(PlatformWorkflowTemplate, PlatformWorkflowTemplate.id == PlatformTenantWorkflow.template_id) \
        .filter(Tenant.status != "cancelled", Tenant.deletion_scheduled_at.is_(None))
    if allowed_tenant_ids is not None:
        q = q.filter(Tenant.id.in_(allowed_tenant_ids or [0]))
    return q


def tenants_page(db: Session, allowed_tenant_ids: Optional[list[int]], q: str, offset: int, limit: int) -> dict:
    ensure_schema()
    query = eligible_tenants_query(db, allowed_tenant_ids)
    if q:
        query = query.filter(Tenant.name.like(f"%{q.replace('%', '').replace('_', '')}%"))
    total = query.order_by(None).count()
    rows = query.order_by(Tenant.name, Tenant.id).offset(offset).limit(limit).all()
    return {"items": [{"id": r.id, "name": r.name, "status": r.status, "template": r.template} for r in rows], "total": total, "offset": offset, "limit": limit}


# ─── Tenant database ─────────────────────────────────────────────────────────

TENANT_DDL = [
    """CREATE TABLE IF NOT EXISTS workflow_definitions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        workflow VARCHAR(40) NOT NULL,
        revision INT NOT NULL,
        template_key VARCHAR(40) NULL,
        template_name VARCHAR(150) NULL,
        applied_by VARCHAR(255) NULL,
        applied_at DATETIME NOT NULL,
        UNIQUE KEY uq_workflow_definitions_workflow (workflow)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    """CREATE TABLE IF NOT EXISTS workflow_stages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        workflow VARCHAR(40) NOT NULL,
        revision INT NOT NULL,
        position INT NOT NULL,
        name VARCHAR(150) NOT NULL,
        kind VARCHAR(10) NOT NULL DEFAULT 'open',
        sla_days INT NOT NULL DEFAULT 0,
        gate VARCHAR(20) NOT NULL DEFAULT 'None',
        owner_role VARCHAR(100) NULL,
        checklist JSON NULL,
        UNIQUE KEY uq_workflow_stages_position (workflow, revision, position)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    # A record can't lose its stage: stages that still hold records can't be deleted (RESTRICT).
    """CREATE TABLE IF NOT EXISTS workflow_record_stages (
        workflow VARCHAR(40) NOT NULL,
        record_id INT NOT NULL,
        stage_id INT NOT NULL,
        mapped_at DATETIME NOT NULL,
        PRIMARY KEY (workflow, record_id),
        KEY ix_workflow_record_stages_stage (stage_id, workflow),   -- FK index; also serves the per-stage counts
        CONSTRAINT fk_workflow_record_stages_stage FOREIGN KEY (stage_id) REFERENCES workflow_stages (id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
]


def _placement(new: list[dict]) -> Callable[[str | None, int, str], dict]:
    """Where a record goes: same-named stage, same outcome, else the nearest open stage by position."""
    open_stages = [s for s in new if s["kind"] == "open"]
    outcome = {s["kind"]: s for s in new if s["kind"] != "open"}
    by_name = {s["name"].lower(): s for s in new}

    def place(name: Optional[str], open_pos: int, kind: str) -> dict:
        if kind in outcome:
            return outcome[kind]
        if name and name.lower() in by_name and by_name[name.lower()]["kind"] == "open":
            return by_name[name.lower()]
        return open_stages[min(max(open_pos, 0), len(open_stages) - 1)]
    return place


def apply_to_tenant(slug: str, template_key: str, template_name: str, stages: list[dict], actor: str,
                    session_factory: Callable[[str], Session] | None = None) -> dict:
    """Replace the tenant's tender workflow and remap its tenders, all-or-nothing. Returns the revision and the moves."""
    validate_stages(stages)
    session = (session_factory or get_tenant_session)(slug)
    try:
        for ddl in TENANT_DDL:   # DDL commits implicitly in MariaDB, so it runs before the data transaction starts
            session.execute(text(ddl))
        session.commit()
        has_tenders = bool(_existing_tables(session, ["tenders"]))
        w = {"w": WORKFLOW}

        current = session.execute(text("SELECT revision FROM workflow_definitions WHERE workflow = :w FOR UPDATE"), w).first()
        old_revision = current[0] if current else None
        revision = (old_revision or 0) + 1
        old = [dict(r._mapping) for r in session.execute(text(
            "SELECT id, name, kind, position FROM workflow_stages WHERE workflow = :w AND revision = :r ORDER BY position"),
            {**w, "r": old_revision})] if old_revision else []
        old_open_pos = {s["id"]: i for i, s in enumerate(x for x in old if x["kind"] == "open")}

        if has_tenders:   # mappings of tenders that were hard-deleted since the last push
            session.execute(text("DELETE m FROM workflow_record_stages m LEFT JOIN tenders t ON t.id = m.record_id "
                                 "WHERE m.workflow = :w AND t.id IS NULL"), w)
        mapped = dict(session.execute(text("SELECT stage_id, COUNT(*) FROM workflow_record_stages WHERE workflow = :w GROUP BY stage_id"), w).all())
        legacy = (tender_stages(session) or []) if has_tenders else []
        unmapped = session.execute(text(
            "SELECT t.tender_status, t.result, COUNT(*) FROM tenders t "
            "LEFT JOIN workflow_record_stages m ON m.workflow = :w AND m.record_id = t.id "
            "WHERE m.record_id IS NULL GROUP BY t.tender_status, t.result"), w).all() if has_tenders else []

        session.execute(text(
            "INSERT INTO workflow_stages (workflow, revision, position, name, kind, sla_days, gate, owner_role, checklist) "
            "VALUES (:w, :r, :position, :name, :kind, :sla_days, :gate, :owner_role, :checklist)"),
            [{**w, "r": revision, "position": i, "name": s["name"].strip(), "kind": s["kind"], "sla_days": int(s["sla_days"] or 0), "gate": s["gate"],
              "owner_role": s.get("owner_role") or None, "checklist": _json(s.get("checklist"))} for i, s in enumerate(stages)])
        new = [dict(r._mapping) for r in session.execute(text(
            "SELECT id, name, kind, position FROM workflow_stages WHERE workflow = :w AND revision = :r ORDER BY position"), {**w, "r": revision})]
        place = _placement(new)
        moves: Counter = Counter()

        # Records already on the previous pushed workflow: one UPDATE with a CASE over the old stages.
        if old:
            target = {s["id"]: place(s["name"], old_open_pos.get(s["id"], 0), s["kind"]) for s in old}
            params = {**w, "now": datetime.now()}
            cases = []
            for i, (old_id, to) in enumerate(target.items()):
                params[f"o{i}"], params[f"n{i}"] = old_id, to["id"]
                cases.append(f"WHEN :o{i} THEN :n{i}")
            session.execute(text(f"UPDATE workflow_record_stages SET stage_id = CASE stage_id {' '.join(cases)} END, mapped_at = :now "
                                 f"WHERE workflow = :w AND stage_id IN ({', '.join(f':o{i}' for i in range(len(target)))})"), params)
            names = {s["id"]: s["name"] for s in old}
            for old_id, count in mapped.items():
                if old_id in target:
                    moves[(names[old_id], target[old_id]["name"])] += int(count)

        # Tenders not mapped yet: placed from their status in the tenant app, in one INSERT … SELECT.
        if has_tenders and unmapped:
            outcome = {s["kind"]: s for s in new if s["kind"] != "open"}
            fallback = place(legacy[0] if legacy else None, 0, "open")
            legacy_target = {status: place(status, i, "open") for i, status in enumerate(legacy)}
            params = {**w, "now": datetime.now(), "won": outcome["won"]["id"], "lost": outcome["lost"]["id"], "fallback": fallback["id"]}
            params.update({f"wr{i}": v for i, v in enumerate(WON_RESULTS)})
            params.update({f"lr{i}": v for i, v in enumerate(LOST_RESULTS)})
            cases = []
            for i, (status, to) in enumerate(legacy_target.items()):
                params[f"s{i}"], params[f"m{i}"] = status, to["id"]
                cases.append(f"WHEN t.tender_status = :s{i} THEN :m{i}")
            session.execute(text(
                "INSERT INTO workflow_record_stages (workflow, record_id, stage_id, mapped_at) "
                f"SELECT :w, t.id, CASE WHEN t.result IN ({', '.join(f':wr{i}' for i in range(len(WON_RESULTS)))}) THEN :won "
                f"WHEN t.result IN ({', '.join(f':lr{i}' for i in range(len(LOST_RESULTS)))}) OR t.tender_status = 'Closed' THEN :lost "
                f"{' '.join(cases)} ELSE :fallback END, :now FROM tenders t "
                "LEFT JOIN workflow_record_stages m ON m.workflow = :w AND m.record_id = t.id WHERE m.record_id IS NULL"), params)
            for status, result, count in unmapped:
                if result in WON_RESULTS:
                    src, to = "Won", outcome["won"]
                elif result in LOST_RESULTS or status == "Closed":
                    src, to = "Lost", outcome["lost"]
                else:
                    src, to = status or (legacy[0] if legacy else "—"), legacy_target.get(status, fallback)
                moves[(src, to["name"])] += int(count)

        # The FK refuses this if any record still points at an old stage, which rolls the push back.
        session.execute(text("DELETE FROM workflow_stages WHERE workflow = :w AND revision <> :r"), {**w, "r": revision})
        session.execute(text(
            "INSERT INTO workflow_definitions (workflow, revision, template_key, template_name, applied_by, applied_at) "
            "VALUES (:w, :r, :k, :n, :by, :now) ON DUPLICATE KEY UPDATE revision = VALUES(revision), template_key = VALUES(template_key), "
            "template_name = VALUES(template_name), applied_by = VALUES(applied_by), applied_at = VALUES(applied_at)"),
            {**w, "r": revision, "k": template_key, "n": template_name, "by": actor, "now": datetime.now()})

        records = int(session.execute(text("SELECT COUNT(*) FROM workflow_record_stages WHERE workflow = :w"), w).scalar_one())
        if has_tenders:
            missing = int(session.execute(text("SELECT COUNT(*) FROM tenders t LEFT JOIN workflow_record_stages m "
                                               "ON m.workflow = :w AND m.record_id = t.id WHERE m.record_id IS NULL"), w).scalar_one())
            if missing:
                raise WorkflowTemplateError(f"{missing} tender(s) could not be mapped to the new workflow")
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
    moved = [{"from": a, "to": b, "records": n} for (a, b), n in sorted(moves.items()) if a != b]
    return {"revision": revision, "previous_revision": old_revision, "records": records,
            "moved": moved, "records_moved": sum(m["records"] for m in moved)}


def _json(value) -> Optional[str]:
    return json.dumps(value) if value else None


def record_assignment(db: Session, tenant_id: int, template_id: int, revision: int, records: int, actor: str) -> Optional[int]:
    """Point the tenant at the template it now uses; returns the template it used before."""
    row = db.query(PlatformTenantWorkflow).filter(PlatformTenantWorkflow.tenant_id == tenant_id, PlatformTenantWorkflow.workflow == WORKFLOW).first()
    previous = row.template_id if row else None
    if row is None:
        row = PlatformTenantWorkflow(tenant_id=tenant_id, workflow=WORKFLOW)
        db.add(row)
    row.template_id, row.revision, row.records_mapped, row.applied_by, row.applied_at = template_id, revision, records, actor, datetime.utcnow()
    return previous
