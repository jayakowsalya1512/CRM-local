"""Intelligence → Funnel & analytics (Phase 1 of 5 – the "Funnel" view).

Every number here comes from a real query, never a placeholder. This module does not re-implement stage
modelling, SLA tracking or business-vertical lookup – it reuses, read-only, what the Deals/Bids/Quotes
modules already maintain:

  stage (current)   workflow_record_stages (workflow, record_id) → stage_id, joined to workflow_stages
                     for the stage's name / kind / sla_days. Stage LISTS per object come from
                     deal_service.pipelines() (deals), bid_service.flows() (tenders), quote_service.stages()
                     (quotes). Leads don't use this system – a lead's "stage" is its own `status` enum.
  stage age / SLA    each object's own side table's `stage_entered_at` (DealProfile / BidProfile /
                     QuoteProfile) – real elapsed time, not a hash.
  business vertical  Lead.business_vertical_id / Tender.business_vertical_id → deal_service.business_model_vertical()
                     (Masters table business_category_units; parent row = business model, child = vertical).
  customer segment   Customer.customer_vertical (validated against the VerticalSector master elsewhere).
  customer sub-seg   Customer.sub_segment_id → VerticalSubSector.name.

A "journey" can start directly as a Deal, Tender or Quote (no Lead) – see journey_root() – so every funnel
count here is BY DISTINCT JOURNEY ROOT, never a per-table row count, to avoid counting a Lead that became a
Deal that became a Tender three times.
"""
from __future__ import annotations

import csv
import io
import logging
import threading
from datetime import timedelta
from decimal import Decimal
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

from app.core.timezone import now_ist
from app.models.all_models import Customer, Lead, Quotation, Tender, User, VerticalSubSector, WorkOrder
from app.models.deals import DealProfile
from app.models.bids import BidProfile
from app.models.quotes import QuoteProfile
from app.services import bid_service, deal_service, quote_service

logger = logging.getLogger(__name__)

_READY: set[str] = set()
_LOCK = threading.Lock()

PERIODS = {"All": None, "Last 30 days": 30, "Last quarter": 90, "Last 6 months": 180}
OBJECTS = ["Whole journey", "Leads", "Deals", "Bids & Tenders", "Quotes"]
DIMENSIONS = [("segment", "Customer segment"), ("sub_segment", "Customer sub-segment"), ("vertical", "Business vertical"),
              ("business_model", "Business model"), ("owner", "Owner")]

LEAD_OPEN_STATUSES = ["Assigned", "Contacted", "Qualified", "Proposal Pending", "Nurturing", "Opportunity Created"]


def ensure_schema(db: Session) -> None:
    """Append-only stage-transition history, populated by DB triggers (not application code) so every one of
    the ~18 existing write paths across deals/bids/orders/quotes is covered without touching any of them."""
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        try:
            db.execute(text("""
                CREATE TABLE IF NOT EXISTS workflow_record_stage_history (
                  id INT AUTO_INCREMENT PRIMARY KEY,
                  workflow VARCHAR(40) NOT NULL,
                  record_id INT NOT NULL,
                  from_stage_id INT NULL,
                  to_stage_id INT NOT NULL,
                  moved_at DATETIME NOT NULL,
                  KEY ix_wrsh_lookup (workflow, record_id, moved_at),
                  KEY ix_wrsh_to_stage (to_stage_id, moved_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """))
            db.execute(text("""
                CREATE TRIGGER IF NOT EXISTS trg_wrs_history_ins AFTER INSERT ON workflow_record_stages
                FOR EACH ROW INSERT INTO workflow_record_stage_history (workflow, record_id, from_stage_id, to_stage_id, moved_at)
                VALUES (NEW.workflow, NEW.record_id, NULL, NEW.stage_id, NEW.mapped_at)
            """))
            db.execute(text("""
                CREATE TRIGGER IF NOT EXISTS trg_wrs_history_upd AFTER UPDATE ON workflow_record_stages
                FOR EACH ROW INSERT INTO workflow_record_stage_history (workflow, record_id, from_stage_id, to_stage_id, moved_at)
                SELECT NEW.workflow, NEW.record_id, OLD.stage_id, NEW.stage_id, NEW.mapped_at WHERE OLD.stage_id <> NEW.stage_id
            """))
            try:
                db.execute(text("ALTER TABLE customers ADD COLUMN IF NOT EXISTS sub_segment_id INT NULL"))
                db.commit()
            except Exception:
                db.rollback()
            for stmt in (
                "ALTER TABLE leads ADD INDEX IF NOT EXISTS ix_leads_status (status)",
                "ALTER TABLE leads ADD INDEX IF NOT EXISTS ix_leads_business_vertical (business_vertical_id)",
                "ALTER TABLE tenders ADD INDEX IF NOT EXISTS ix_tenders_business_vertical (business_vertical_id)",
                "ALTER TABLE customers ADD INDEX IF NOT EXISTS ix_customers_vertical (customer_vertical)",
                "ALTER TABLE work_orders ADD INDEX IF NOT EXISTS ix_wo_lead (lead_id)",
                "ALTER TABLE work_orders ADD INDEX IF NOT EXISTS ix_wo_quotation (quotation_id)",
            ):
                try:
                    db.execute(text(stmt))
                except Exception:
                    db.rollback()
            db.commit()
        except Exception as exc:  # pragma: no cover
            logger.warning("funnel ensure_schema: %s", exc)
            db.rollback()
        _READY.add(slug)


def ensure_schema_all_tenants() -> None:
    """Customer.sub_segment_id is a real column other modules may also query via `SELECT *`-style Customer
    loads, so this must run for every tenant at app startup, not lazily on first Funnel page view – otherwise
    any Customer query anywhere in the app breaks for a tenant that never happened to open /funnel first."""
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant
    master = MasterSessionLocal()
    try:
        slugs = [t.slug for t in master.query(Tenant.slug).all()]
    except Exception as exc:  # pragma: no cover
        logger.warning("Funnel schema sync: unable to list tenants: %s", exc)
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
            logger.warning("Funnel schema sync failed for %s: %s", slug, exc)


def _period_start(period: str):
    days = PERIODS.get(period)
    return None if days is None else now_ist() - timedelta(days=days)


def _num(v) -> float:
    return float(v) if v is not None else 0.0


# ─── dimension resolution (batched – no per-row queries) ──────────────────────

def _customer_dims(db: Session, customer_ids: set[int]) -> dict[int, dict[str, Any]]:
    if not customer_ids:
        return {}
    rows = db.query(Customer.id, Customer.customer_name, Customer.customer_vertical, Customer.sub_segment_id).filter(Customer.id.in_(customer_ids)).all()
    sub_ids = {r.sub_segment_id for r in rows if r.sub_segment_id}
    sub_names = dict(db.query(VerticalSubSector.id, VerticalSubSector.name).filter(VerticalSubSector.id.in_(sub_ids)).all()) if sub_ids else {}
    return {r.id: {"name": r.customer_name, "segment": r.customer_vertical, "sub_segment": sub_names.get(r.sub_segment_id)} for r in rows}


def _vertical_dims(db: Session, vertical_ids: set[int]) -> dict[int, tuple[Optional[str], Optional[str]]]:
    return deal_service.business_model_vertical(db, vertical_ids)


def _user_names(db: Session, user_ids: set[int]) -> dict[int, str]:
    if not user_ids:
        return {}
    return dict(db.query(User.id, User.full_name).filter(User.id.in_(user_ids)).all())


def _stage_map(db: Session, workflow: str, record_ids: list[int]) -> dict[int, int]:
    if not record_ids:
        return {}
    rows = db.execute(text("SELECT record_id, stage_id FROM workflow_record_stages WHERE workflow = :w AND record_id IN :ids")
                       .bindparams(bindparam("ids", expanding=True)), {"w": workflow, "ids": record_ids}).all()
    return {r[0]: r[1] for r in rows}


# ─── per-object row fetchers – each returns the SAME normalised row shape ────

def _base_row(*, kind: str, id_: int, name: str, customer_id, value, owner_id, created_at, stage_name, stage_kind,
              sla_days, stage_entered_at, vertical_id, root: str) -> dict[str, Any]:
    return {"kind": kind, "id": id_, "name": name, "customer_id": customer_id, "value": value or Decimal(0), "owner_id": owner_id,
            "created_at": created_at, "stage": stage_name, "stage_kind": stage_kind, "sla_days": sla_days,
            "stage_entered_at": stage_entered_at, "vertical_id": vertical_id, "root": root,
            "customer_name": "", "segment": None, "sub_segment": None, "vertical": None, "business_model": None, "owner_name": "Unassigned"}


def _leads_rows(db: Session, period_start) -> list[dict[str, Any]]:
    q = db.query(Lead).filter(Lead.is_deleted.is_(False))
    if period_start is not None:
        q = q.filter(Lead.created_at >= period_start)
    out = []
    for l in q.all():
        kind_ = "won" if l.status == "Converted" else "lost" if l.status == "Lost" else "open"
        out.append(_base_row(kind="lead", id_=l.id, name=l.lead_title, customer_id=l.customer_id, value=l.est_value,
                              owner_id=l.assigned_to, created_at=l.created_at, stage_name=l.status, stage_kind=kind_,
                              sla_days=None, stage_entered_at=None, vertical_id=l.business_vertical_id, root=f"L{l.id}"))
    return out


def _deals_rows(db: Session, period_start, flow_key: Optional[str] = None) -> list[dict[str, Any]]:
    pipes = deal_service.pipelines(db)
    if not pipes:
        return []
    by_key = deal_service.pipeline_by_key(pipes)
    q = db.query(Lead, DealProfile).join(DealProfile, DealProfile.lead_id == Lead.id).filter(Lead.is_deleted.is_(False))
    if flow_key:
        q = q.filter(DealProfile.pipeline == flow_key)
    if period_start is not None:
        q = q.filter(Lead.opportunity_created_at >= period_start)
    rows = q.all()
    stage_by_pipe: dict[str, dict[int, int]] = {}
    out = []
    for l, prof in rows:
        pipe = by_key.get(prof.pipeline)
        if not pipe:
            continue
        smap = stage_by_pipe.setdefault(prof.pipeline, _stage_map(db, prof.pipeline, [r.id for r, p in rows if p.pipeline == prof.pipeline]))
        stage_id = smap.get(l.id)
        stage = next((s for s in pipe["stages"] if s["id"] == stage_id), None)
        out.append(_base_row(kind="deal", id_=l.id, name=l.lead_title, customer_id=l.customer_id, value=l.est_value,
                              owner_id=l.assigned_to, created_at=l.opportunity_created_at or l.created_at,
                              stage_name=stage["name"] if stage else "Unstaged", stage_kind=stage["kind"] if stage else "open",
                              sla_days=stage["sla"] if stage else None, stage_entered_at=prof.stage_entered_at,
                              vertical_id=l.business_vertical_id, root=f"L{l.id}"))
    return out


def _tenders_rows(db: Session, period_start, flow_key: Optional[str] = None) -> list[dict[str, Any]]:
    fl = bid_service.flows(db)
    fmap = bid_service.flow_map(fl)
    q = db.query(Tender, BidProfile).outerjoin(BidProfile, BidProfile.tender_id == Tender.id)
    if period_start is not None:
        q = q.filter(Tender.created_at >= period_start) if hasattr(Tender, "created_at") else q
    rows = q.all()
    ids_by_flow: dict[str, list[int]] = {}
    for t, prof in rows:
        key = (prof.flow if prof and prof.flow else (bid_service.default_flow(fl) or {}).get("key"))
        if flow_key and key != flow_key:
            continue
        ids_by_flow.setdefault(key, []).append(t.id)
    smap_by_flow = {k: _stage_map(db, k, ids) for k, ids in ids_by_flow.items() if k}
    out = []
    for t, prof in rows:
        key = (prof.flow if prof and prof.flow else (bid_service.default_flow(fl) or {}).get("key"))
        if flow_key and key != flow_key:
            continue
        flow = fmap.get(key)
        stage_id = smap_by_flow.get(key, {}).get(t.id)
        stage = next((s for s in flow["stages"] if s["id"] == stage_id), None) if flow else None
        kind_ = stage["kind"] if stage else ("won" if t.result == "Won" else "lost" if t.result in ("Lost", "Cancelled") else "open")
        root = f"L{t.lead_id}" if t.lead_id else f"T{t.id}"
        out.append(_base_row(kind="tender", id_=t.id, name=t.tender_num or f"Tender #{t.id}", customer_id=t.customer_id, value=t.est_value,
                              owner_id=t.assigned_to, created_at=getattr(t, "created_at", None), stage_name=stage["name"] if stage else (t.tender_status or "Open"),
                              stage_kind=kind_, sla_days=stage["sla"] if stage else None, stage_entered_at=prof.stage_entered_at if prof else None,
                              vertical_id=t.business_vertical_id, root=root))
    return out


def _quotes_rows(db: Session, period_start) -> list[dict[str, Any]]:
    stages = quote_service.stages(db)
    q = db.query(Quotation, QuoteProfile).outerjoin(QuoteProfile, QuoteProfile.quote_id == Quotation.id)
    if period_start is not None:
        q = q.filter(Quotation.created_at >= period_start) if hasattr(Quotation, "created_at") else q
    rows = q.all()
    smap = _stage_map(db, quote_service.WORKFLOW, [q_.id for q_, _ in rows])
    out = []
    for q_, prof in rows:
        stage_id = smap.get(q_.id)
        stage = next((s for s in stages if s["id"] == stage_id), None)
        kind_ = stage["kind"] if stage else ("won" if q_.status == "Accepted" else "lost" if q_.status == "Rejected" else "open")
        root = f"T{q_.tender_id}" if q_.tender_id else (f"L{q_.lead_id}" if q_.lead_id else f"Q{q_.id}")
        out.append(_base_row(kind="quote", id_=q_.id, name=q_.quotation_number, customer_id=q_.customer_id, value=q_.total_amount,
                              owner_id=None, created_at=getattr(q_, "created_at", None), stage_name=stage["name"] if stage else (q_.status or "Draft"),
                              stage_kind=kind_, sla_days=stage["sla"] if stage else None, stage_entered_at=prof.stage_entered_at if prof else None,
                              vertical_id=None, root=root))
    return out


def _enrich(db: Session, rows: list[dict[str, Any]]) -> None:
    """One batched pass to fill in customer / segment / vertical / owner names – no per-row queries."""
    cust_ids = {r["customer_id"] for r in rows if r["customer_id"]}
    vert_ids = {r["vertical_id"] for r in rows if r["vertical_id"]}
    owner_ids = {r["owner_id"] for r in rows if r["owner_id"]}
    cust = _customer_dims(db, cust_ids)
    vert = _vertical_dims(db, vert_ids)
    owners = _user_names(db, owner_ids)
    for r in rows:
        c = cust.get(r["customer_id"]) if r["customer_id"] else None
        if c:
            r["customer_name"], r["segment"], r["sub_segment"] = c["name"], c["segment"], c["sub_segment"]
        v = vert.get(r["vertical_id"]) if r["vertical_id"] else None
        if v:
            r["business_model"], r["vertical"] = v
        if r["owner_id"]:
            r["owner_name"] = owners.get(r["owner_id"], "Unassigned")


def _object_rows(db: Session, obj: str, period_start, flow_key: Optional[str] = None) -> list[dict[str, Any]]:
    if obj == "Leads":
        rows = _leads_rows(db, period_start)
    elif obj == "Deals":
        rows = _deals_rows(db, period_start, flow_key)
    elif obj == "Bids & Tenders":
        rows = _tenders_rows(db, period_start, flow_key)
    elif obj == "Quotes":
        rows = _quotes_rows(db, period_start)
    else:
        raise HTTPException(400, f"Unknown object '{obj}'")
    _enrich(db, rows)
    return rows


def _apply_filters(rows: list[dict[str, Any]], *, open_only: bool, owner_id: Optional[int], drill: list[tuple[str, str]]) -> list[dict[str, Any]]:
    out = rows
    if open_only:
        out = [r for r in out if r["stage_kind"] == "open"]
    if owner_id:
        out = [r for r in out if r["owner_id"] == owner_id]
    for dim, val in drill:
        out = [r for r in out if (r.get(dim) or "Unassigned") == val]
    return out


def _flow_stages(db: Session, obj: str, flow_key: Optional[str]) -> list[dict[str, Any]]:
    if obj == "Leads":
        return ([{"id": None, "name": s, "kind": "open", "sla": None} for s in LEAD_OPEN_STATUSES]
                + [{"id": None, "name": "Converted", "kind": "won", "sla": None}])
    if obj == "Deals":
        pipes = deal_service.pipelines(db)
        flow = deal_service.pipeline_by_key(pipes).get(flow_key) if flow_key else deal_service.default_pipeline(pipes, None)
        return [s for s in (flow or {}).get("stages", []) if s["kind"] != "lost"]
    if obj == "Bids & Tenders":
        fl = bid_service.flows(db)
        flow = bid_service.flow_map(fl).get(flow_key) if flow_key else bid_service.default_flow(fl)
        return [s for s in (flow or {}).get("stages", []) if s["kind"] != "lost"]
    if obj == "Quotes":
        return [s for s in quote_service.stages(db) if s["kind"] != "lost"]
    return []


def funnel_steps(rows: list[dict[str, Any]], stages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Step i's count = rows currently AT stage i, plus rows further along (any open stage after i, or won) –
    i.e. "reached at least this far", the same semantics the prototype uses, computed from real stage positions."""
    names = [s["name"] for s in stages]
    opens = [s for s in stages if s["kind"] == "open"]
    steps = []
    for i, s in enumerate(opens):
        later_names = {o["name"] for o in opens[i + 1:]}
        n = sum(1 for r in rows if r["stage"] == s["name"] or r["stage"] in later_names or r["stage_kind"] == "won")
        v = sum(_num(r["value"]) for r in rows if r["stage"] == s["name"] or r["stage"] in later_names or r["stage_kind"] == "won")
        steps.append({"l": s["name"], "n": n, "v": v, "sla": s.get("sla")})
    won_n = sum(1 for r in rows if r["stage_kind"] == "won")
    won_v = sum(_num(r["value"]) for r in rows if r["stage_kind"] == "won")
    steps.append({"l": "Won", "n": won_n, "v": won_v, "sla": None})
    prev = None
    for s in steps:
        s["cv"] = round(min(100, s["n"] / prev * 100)) if prev else None
        prev = s["n"] or prev
    return steps


def kpi_strip(rows: list[dict[str, Any]], steps: list[dict[str, Any]]) -> dict[str, Any]:
    won = [r for r in rows if r["stage_kind"] == "won"]
    lost = [r for r in rows if r["stage_kind"] == "lost"]
    open_ = [r for r in rows if r["stage_kind"] == "open"]
    entry_n = steps[0]["n"] if steps else len(rows)
    entry_v = steps[0]["v"] if steps else sum(_num(r["value"]) for r in rows)
    last_n = steps[-1]["n"] if steps else 0
    leak = min((s for s in steps[1:] if s["cv"] is not None), key=lambda s: s["cv"], default=None)
    stuck = stuck_rows(rows)
    return {
        "entry_n": entry_n, "entry_v": entry_v, "reached_last": last_n,
        "conversion_pct": round(last_n / entry_n * 100) if entry_n else 0,
        "win_rate_pct": round(len(won) / (len(won) + len(lost)) * 100) if (won or lost) else 0,
        "open_n": len(open_), "open_v": sum(_num(r["value"]) for r in open_),
        "biggest_leak": leak["l"] if leak else None, "biggest_leak_pct": leak["cv"] if leak else None,
        "stuck_n": len(stuck), "stuck_v": sum(_num(r["value"]) for r in stuck),
    }


def stuck_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    now = now_ist()
    out = []
    for r in rows:
        if r["stage_kind"] != "open" or not r["sla_days"] or not r["stage_entered_at"]:
            continue
        age = (now - r["stage_entered_at"]).days
        if age > r["sla_days"]:
            out.append({**r, "age_days": age})
    return out


def group_rows(rows: list[dict[str, Any]], dim: str) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    for r in rows:
        key = r.get(dim) or "Unassigned"
        g = groups.setdefault(key, {"group": key, "n": 0, "value": 0.0, "open": 0, "won": 0, "lost": 0, "open_value": 0.0, "won_value": 0.0})
        g["n"] += 1
        g["value"] += _num(r["value"])
        if r["stage_kind"] == "open":
            g["open"] += 1
            g["open_value"] += _num(r["value"])
        elif r["stage_kind"] == "won":
            g["won"] += 1
            g["won_value"] += _num(r["value"])
        elif r["stage_kind"] == "lost":
            g["lost"] += 1
    total_value = sum(g["value"] for g in groups.values()) or 1
    out = list(groups.values())
    for g in out:
        g["win_rate_pct"] = round(g["won"] / (g["won"] + g["lost"]) * 100) if (g["won"] or g["lost"]) else 0
        g["share_pct"] = round(g["value"] / total_value * 100)
    out.sort(key=lambda g: -g["value"])
    return out


def stage_matrix(rows: list[dict[str, Any]], stages: list[dict[str, Any]], dim: str) -> dict[str, Any]:
    groups = group_rows(rows, dim)[:9]
    cols = [s["name"] for s in stages if s["kind"] != "lost"] + ["Won"]
    cell_max = 1
    out_rows = []
    for g in groups:
        grows = [r for r in rows if (r.get(dim) or "Unassigned") == g["group"]]
        steps = funnel_steps(grows, stages)
        cells = [s["n"] for s in steps]
        cell_max = max(cell_max, cells[0] if cells else 1, 1)
        out_rows.append({"group": g["group"], "cells": cells})
    return {"cols": cols, "rows": out_rows, "max": cell_max}


def records_table(rows: list[dict[str, Any]], *, q: str, sort: str, offset: int, limit: int) -> dict[str, Any]:
    data = rows
    if q:
        ql = q.lower()
        data = [r for r in data if ql in (r["name"] or "").lower() or ql in (r["customer_name"] or "").lower()]
    key_fn = {"value": lambda r: -_num(r["value"]), "age": lambda r: -(_age_days(r)), "owner": lambda r: r["owner_name"]}.get(sort, lambda r: -_num(r["value"]))
    data = sorted(data, key=key_fn)
    total = len(data)
    page = data[offset:offset + limit]
    items = [{
        "id": r["id"], "type": r["kind"], "name": r["name"], "customer": r["customer_name"], "segment": r["segment"],
        "sub_segment": r["sub_segment"], "vertical": r["vertical"], "model": r["business_model"], "stage": r["stage"],
        "value": _num(r["value"]), "owner": r["owner_name"],
    } for r in page]
    return {"items": items, "total": total}


def _age_days(r: dict[str, Any]) -> int:
    if not r.get("stage_entered_at"):
        return 0
    return (now_ist() - r["stage_entered_at"]).days


def export_csv(rows: list[dict[str, Any]]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["ID", "Type", "Name", "Customer", "Segment", "Sub-segment", "Vertical", "Model", "Stage", "Value", "Owner"])
    for r in rows:
        w.writerow([r["id"], r["kind"], r["name"], r["customer_name"], r["segment"] or "", r["sub_segment"] or "",
                    r["vertical"] or "", r["business_model"] or "", r["stage"], _num(r["value"]), r["owner_name"]])
    return buf.getvalue()


# ─── public entry point used by the router ───────────────────────────────────

def funnel_board(db: Session, *, obj: str, period: str, flow_key: Optional[str], open_only: bool,
                  owner_id: Optional[int], drill: list[tuple[str, str]]) -> dict[str, Any]:
    ensure_schema(db)
    if obj not in OBJECTS:
        raise HTTPException(400, f"Unknown object '{obj}'")
    period_start = _period_start(period)
    if obj == "Whole journey":
        rows = whole_journey_rows(db, period_start)
        stages = [{"name": "Leads", "kind": "open", "sla": None}, {"name": "Qualified", "kind": "open", "sla": None},
                  {"name": "Deal / tender / quote", "kind": "open", "sla": None}]
    else:
        rows = _object_rows(db, obj, period_start, flow_key)
        stages = _flow_stages(db, obj, flow_key)
    filtered = _apply_filters(rows, open_only=open_only, owner_id=owner_id, drill=drill)
    steps = funnel_steps(filtered, stages) if obj != "Whole journey" else whole_journey_steps(filtered)
    return {"kpi": kpi_strip(filtered, steps), "steps": steps, "row_count": len(filtered)}


def whole_journey_rows(db: Session, period_start) -> list[dict[str, Any]]:
    """Cross-object rows for the 'Whole journey' object, each tagged with its journey_root so stage counts
    never double-count a Lead that became a Deal that became a Tender/Quote (see module docstring)."""
    leads = _leads_rows(db, period_start)
    deals = _deals_rows(db, period_start)
    tenders = _tenders_rows(db, period_start)
    quotes = _quotes_rows(db, period_start)
    by_root: dict[str, dict[str, Any]] = {}
    for r in leads + deals + tenders + quotes:
        existing = by_root.get(r["root"])
        # Keep the record furthest along the journey as the representative row for that root.
        if existing is None or _stage_rank(r) >= _stage_rank(existing):
            by_root[r["root"]] = r
    rows = list(by_root.values())
    _enrich(db, rows)
    return rows


def _stage_rank(r: dict[str, Any]) -> int:
    return {"lead": 0, "deal": 1, "tender": 2, "quote": 2}.get(r["kind"], 0) + (10 if r["stage_kind"] == "won" else 0)


def whole_journey_steps(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    leads_n = sum(1 for r in rows if r["kind"] == "lead")
    qualified_n = sum(1 for r in rows if r["kind"] == "lead" and r["stage"] not in ("Assigned",))
    opp_n = sum(1 for r in rows if r["kind"] in ("deal", "tender", "quote"))
    won_n = sum(1 for r in rows if r["stage_kind"] == "won")
    total_v = sum(_num(r["value"]) for r in rows)
    steps = [
        {"l": "Leads", "n": len(rows), "v": total_v, "sla": None},
        {"l": "Qualified", "n": qualified_n + opp_n, "v": total_v, "sla": None},
        {"l": "Deal / tender / quote", "n": opp_n, "v": sum(_num(r["value"]) for r in rows if r["kind"] in ("deal", "tender", "quote")), "sla": None},
        {"l": "Won", "n": won_n, "v": sum(_num(r["value"]) for r in rows if r["stage_kind"] == "won"), "sla": None},
    ]
    prev = None
    for s in steps:
        s["cv"] = round(min(100, s["n"] / prev * 100)) if prev else None
        prev = s["n"] or prev
    return steps


def flows_for_object(db: Session, obj: str) -> list[dict[str, str]]:
    if obj == "Deals":
        return [{"key": p["key"], "name": p["name"]} for p in deal_service.pipelines(db)]
    if obj == "Bids & Tenders":
        return [{"key": f["key"], "name": f["name"]} for f in bid_service.flows(db)]
    return []


def owners_list(db: Session) -> list[dict[str, Any]]:
    return [{"id": u.id, "name": u.full_name} for u in db.query(User.id, User.full_name).filter(User.is_active.is_(True)).order_by(User.full_name).all()]


# --- Phase 2: Journey & trends ------------------------------------------------
# Every node/edge count below comes from real FK/status data (lead_id / tender_id / status / result), never
# a random number. Work-order linkage uses the loose (non-FK) lead_id/tender_id/quotation_id columns on
# WorkOrder, so an order created with no linkage back to its origin will not appear on the Won -> Work
# orders edge; that is a gap in the source data, not something papered over here.

MONTHS_BACK = 6


def _month_buckets():
    now = now_ist()
    months = []
    for i in range(MONTHS_BACK - 1, -1, -1):
        idx = now.month - i - 1
        y = now.year + (idx // 12 if idx < 0 else 0)
        m = idx % 12 + 1
        months.append((y, m))
    return months


def _in_month(dt_, y, m) -> bool:
    return bool(dt_) and dt_.year == y and dt_.month == m


def journey_sankey(db: Session, period_start) -> dict[str, Any]:
    leads_q = db.query(Lead).filter(Lead.is_deleted.is_(False))
    if period_start is not None:
        leads_q = leads_q.filter(Lead.created_at >= period_start)
    leads = leads_q.all()
    lead_ids = [l.id for l in leads]
    deal_lead_ids = {r[0] for r in db.query(DealProfile.lead_id).filter(DealProfile.lead_id.in_(lead_ids)).all()} if lead_ids else set()

    tenders_q = db.query(Tender)
    if period_start is not None:
        tenders_q = tenders_q.filter(Tender.created_at >= period_start)
    tenders = tenders_q.all()
    tenders_by_lead: dict[int, list] = {}
    for t in tenders:
        if t.lead_id:
            tenders_by_lead.setdefault(t.lead_id, []).append(t)

    quotes_q = db.query(Quotation)
    if period_start is not None:
        quotes_q = quotes_q.filter(Quotation.created_at >= period_start)
    quotes = quotes_q.all()
    quotes_by_lead: dict[int, list] = {}
    for q_ in quotes:
        if q_.lead_id and not q_.tender_id:
            quotes_by_lead.setdefault(q_.lead_id, []).append(q_)

    direct_deals = [l for l in leads if l.lead_type == "direct_opportunity"]
    normal_leads = [l for l in leads if l.lead_type != "direct_opportunity"]
    direct_bids = [t for t in tenders if not t.lead_id]
    direct_quotes = [q_ for q_ in quotes if not q_.lead_id and not q_.tender_id]

    disqualified = [l for l in normal_leads if l.status == "Lost" and l.id not in deal_lead_ids]
    deals_from_leads = [l for l in normal_leads if l.id in deal_lead_ids]
    open_leads = [l for l in normal_leads if l.status != "Lost" and l.id not in deal_lead_ids]
    all_deal_leads = deals_from_leads + direct_deals

    deals_lost = [l for l in all_deal_leads if l.status == "Lost"]
    deals_to_tender = [l for l in all_deal_leads if l.id in tenders_by_lead]
    deals_to_quote = [l for l in all_deal_leads if l.id not in tenders_by_lead and l.id in quotes_by_lead]
    deals_open = [l for l in all_deal_leads if l.status != "Lost" and l.id not in tenders_by_lead and l.id not in quotes_by_lead]

    tender_rows = [t for l in deals_to_tender for t in tenders_by_lead[l.id]] + direct_bids
    quote_rows = [q_ for l in deals_to_quote for q_ in quotes_by_lead[l.id]] + direct_quotes

    def t_outcome(t):
        return "won" if t.result == "Won" else "lost" if t.result in ("Lost", "Cancelled") else "open"

    def q_outcome(q_):
        return "won" if q_.status == "Accepted" else "lost" if q_.status == "Rejected" else "open"

    direct_won_leads = [l for l in normal_leads + direct_deals if l.status == "Converted" and l.id not in tenders_by_lead and l.id not in quotes_by_lead]
    won = [t for t in tender_rows if t_outcome(t) == "won"] + [q_ for q_ in quote_rows if q_outcome(q_) == "won"] + direct_won_leads
    lost = [t for t in tender_rows if t_outcome(t) == "lost"] + [q_ for q_ in quote_rows if q_outcome(q_) == "lost"]
    in_progress = [t for t in tender_rows if t_outcome(t) == "open"] + [q_ for q_ in quote_rows if q_outcome(q_) == "open"]

    won_lead_ids = {l.id for l in direct_won_leads}
    won_tender_ids = {t.id for t in won if isinstance(t, Tender)}
    won_quote_ids = {q_.id for q_ in won if isinstance(q_, Quotation)}
    wo_q = db.query(WorkOrder)
    if period_start is not None:
        wo_q = wo_q.filter(WorkOrder.created_at >= period_start)
    work_orders = wo_q.all()
    linked_wo = [w for w in work_orders if (w.lead_id in won_lead_ids) or (w.tender_id in won_tender_ids) or (w.quotation_id in won_quote_ids)]

    def n(items):
        return len(items)

    nodes = [
        {"id": "leads", "col": 0, "label": "Leads", "n": n(normal_leads)},
        {"id": "direct_deals", "col": 0, "label": "Direct deals", "n": n(direct_deals)},
        {"id": "direct_bids", "col": 0, "label": "Direct bids", "n": n(direct_bids)},
        {"id": "deals", "col": 1, "label": "Deals", "n": n(all_deal_leads)},
        {"id": "disqualified", "col": 1, "label": "Disqualified", "n": n(disqualified)},
        {"id": "open_leads", "col": 1, "label": "Open leads", "n": n(open_leads)},
        {"id": "tenders", "col": 2, "label": "Tenders", "n": n(tender_rows)},
        {"id": "quotes", "col": 2, "label": "Quotes", "n": n(quote_rows)},
        {"id": "open_deals", "col": 2, "label": "Open deals", "n": n(deals_open)},
        {"id": "deals_lost", "col": 2, "label": "Deals lost", "n": n(deals_lost)},
        {"id": "won", "col": 3, "label": "Won", "n": n(won)},
        {"id": "lost", "col": 3, "label": "Lost", "n": n(lost)},
        {"id": "in_progress", "col": 3, "label": "In progress", "n": n(in_progress)},
        {"id": "work_orders", "col": 4, "label": "Work orders", "n": n(work_orders)},
    ]
    links = [
        {"source": "leads", "target": "deals", "value": n(deals_from_leads)},
        {"source": "leads", "target": "disqualified", "value": n(disqualified)},
        {"source": "leads", "target": "open_leads", "value": n(open_leads)},
        {"source": "direct_deals", "target": "deals", "value": n(direct_deals)},
        {"source": "direct_bids", "target": "tenders", "value": n(direct_bids)},
        {"source": "deals", "target": "tenders", "value": n(deals_to_tender)},
        {"source": "deals", "target": "quotes", "value": n(deals_to_quote)},
        {"source": "deals", "target": "open_deals", "value": n(deals_open)},
        {"source": "deals", "target": "deals_lost", "value": n(deals_lost)},
        {"source": "tenders", "target": "won", "value": n([t for t in tender_rows if t_outcome(t) == "won"])},
        {"source": "tenders", "target": "lost", "value": n([t for t in tender_rows if t_outcome(t) == "lost"])},
        {"source": "tenders", "target": "in_progress", "value": n([t for t in tender_rows if t_outcome(t) == "open"])},
        {"source": "quotes", "target": "won", "value": n([q_ for q_ in quote_rows if q_outcome(q_) == "won"])},
        {"source": "quotes", "target": "lost", "value": n([q_ for q_ in quote_rows if q_outcome(q_) == "lost"])},
        {"source": "quotes", "target": "in_progress", "value": n([q_ for q_ in quote_rows if q_outcome(q_) == "open"])},
        {"source": "won", "target": "work_orders", "value": n(linked_wo)},
    ]
    keep_ids = {"deals", "tenders", "quotes", "won", "lost", "in_progress"}
    return {"nodes": [x for x in nodes if x["n"] > 0 or x["id"] in keep_ids],
            "links": [l for l in links if l["value"] > 0]}


def conversion_trend(db: Session) -> dict[str, Any]:
    months = _month_buckets()
    labels = [f"{y}-{m:02d}" for y, m in months]
    leads = db.query(Lead.created_at).filter(Lead.is_deleted.is_(False)).all()
    converted = db.query(Lead.converted_at).filter(Lead.status == "Converted").all()
    won_deals = db.query(DealProfile.close_date).join(Lead, Lead.id == DealProfile.lead_id).filter(
        Lead.status == "Converted", DealProfile.close_date.isnot(None)).all()
    created_series = [sum(1 for (d,) in leads if _in_month(d, y, m)) for y, m in months]
    converted_series = [sum(1 for (d,) in converted if _in_month(d, y, m)) for y, m in months]
    won_series = [sum(1 for (d,) in won_deals if _in_month(d, y, m)) for y, m in months]
    return {"labels": labels, "leads_created": created_series, "leads_converted": converted_series, "deals_won": won_series}


def conversion_by_flow(db: Session) -> list[dict[str, Any]]:
    out = []
    for p in deal_service.pipelines(db):
        rows = _deals_rows(db, None, p["key"])
        won = sum(1 for r in rows if r["stage_kind"] == "won")
        lost = sum(1 for r in rows if r["stage_kind"] == "lost")
        out.append({"name": p["name"], "object": "Deal", "n": len(rows), "open": sum(1 for r in rows if r["stage_kind"] == "open"),
                    "win_rate_pct": round(won / (won + lost) * 100) if (won or lost) else 0, "value": sum(_num(r["value"]) for r in rows)})
    for f in bid_service.flows(db):
        rows = _tenders_rows(db, None, f["key"])
        won = sum(1 for r in rows if r["stage_kind"] == "won")
        lost = sum(1 for r in rows if r["stage_kind"] == "lost")
        out.append({"name": f["name"], "object": "Tender", "n": len(rows), "open": sum(1 for r in rows if r["stage_kind"] == "open"),
                    "win_rate_pct": round(won / (won + lost) * 100) if (won or lost) else 0, "value": sum(_num(r["value"]) for r in rows)})
    return sorted(out, key=lambda x: -x["value"])


def lost_reasons(db: Session) -> list[dict[str, Any]]:
    counts: dict[str, int] = {}
    for col in (DealProfile.lost_reason, BidProfile.lost_reason, QuoteProfile.lost_reason):
        for (reason,) in db.query(col).filter(col.isnot(None), col != "").all():
            counts[reason] = counts.get(reason, 0) + 1
    return [{"l": k, "v": v} for k, v in sorted(counts.items(), key=lambda kv: -kv[1])]


def tender_ageing(db: Session) -> list[dict[str, Any]]:
    fl = bid_service.flows(db)
    rows = _tenders_rows(db, None)
    by_stage: dict[str, list[int]] = {}
    now = now_ist()
    for r in rows:
        if r["stage_kind"] != "open" or not r["stage_entered_at"]:
            continue
        by_stage.setdefault(r["stage"], []).append((now - r["stage_entered_at"]).days)
    sla_by_stage = {s["name"]: s.get("sla") for f in fl for s in f["stages"]}
    out = []
    for k, v in by_stage.items():
        avg_age = round(sum(v) / len(v)) if v else 0
        sla = sla_by_stage.get(k)
        out.append({"stage": k, "avg_age": avg_age, "n": len(v), "sla": sla, "breach": bool(sla) and avg_age > sla})
    return sorted(out, key=lambda x: -x["avg_age"])


def journey_trends(db: Session, period: str) -> dict[str, Any]:
    ensure_schema(db)
    period_start = _period_start(period)
    rows = whole_journey_rows(db, period_start)
    steps = whole_journey_steps(rows)
    lost_ = [r for r in rows if r["stage_kind"] == "lost"]
    open_ = [r for r in rows if r["stage_kind"] == "open"]
    # No per-record win-probability field exists yet, so "weighted pipeline" uses a flat 30% factor on open
    # value until a real probability field is added - the UI must label this an estimate, not a precise figure.
    weighted = sum(_num(r["value"]) * 0.3 for r in open_)
    leak_v = sum(_num(r["value"]) for r in lost_)
    return {
        "kpi": {**kpi_strip(rows, steps), "weighted_pipeline": weighted, "leakage_value": leak_v},
        "steps": steps,
        "sankey": journey_sankey(db, period_start),
        "trend": conversion_trend(db),
        "by_flow": conversion_by_flow(db),
        "lost_reasons": lost_reasons(db),
        "tender_ageing": tender_ageing(db),
    }
