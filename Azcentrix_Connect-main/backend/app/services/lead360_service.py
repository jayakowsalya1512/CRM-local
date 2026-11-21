"""Leads (prototype v17 → Application → Sales → Leads): list rows, score, stages, drawer data.

* Stages are the prototype v17 lead workflow (New · Contacted · Qualified · Proposal Pending · Nurturing ·
  Converted · Disqualified). Each stage is stored as one leads.status value (its key) and also groups the
  legacy values other modules use: New = Assigned, Converted = Opportunity Created + Converted, Disqualified = Lost.
* Lead score uses the tenant's configured rules (settings key "lead_scoring_rules", category "leads",
  editable like any other setting) applied to the lead's real data.
* Records are read through the Leads module's own scope (lead_router._scope_query).
"""
from __future__ import annotations

import json
import logging
import threading
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from typing import Any, Iterable, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.timezone import today_ist
from app.models.all_models import (
    ActivityLog, Customer, CustomerContact, KAMActivity, Lead, LeadProduct, LeadSource, Quotation, Setting, Tender, User, WorkOrder,
)
from app.models.lead360 import LEAD360_TABLES, LeadContactLink, LeadNote

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()

SCORING_KEY = "lead_scoring_rules"
LOST_KEY = "lead_lost_reasons"
# Lost-reason master for the Lost stage (prototype "Lost reasons"); a tenant setting so it is edited, not coded.
DEFAULT_LOST: dict[str, Any] = {"required": True, "reasons": ["Price", "Technical", "Eligibility", "Delivery", "Relationship"]}
DEFAULT_RULES: dict[str, Any] = {
    "base": 20,
    "value_bands": [[10000000, 25], [1000000, 15], [1, 5]],     # ₹ ≥ 1 Cr → +25, ≥ 10 L → +15, any value → +5
    "customer_linked": 10, "contact_linked": 10,
    "source_points": {},                                         # {"<lead source id>": points}
    "follow_up_set": 10, "follow_up_overdue": -10,
    "activity_points": 5, "activity_cap": 15, "activity_days": 30,
    "stage_points": {"Qualified": 10, "Opportunity Created": 20, "Converted": 25, "Lost": -100},
    "hot_threshold": 75, "high_value": 10000000,
}


# ─── schema & settings ────────────────────────────────────────────────────────

def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        bind = db.get_bind()
        for t in LEAD360_TABLES:
            t.create(bind=bind, checkfirst=True)
        db.commit()
        try:
            _ensure_status_enum(db)
        except Exception as exc:
            db.rollback()
            logger.warning("leads.status stage upgrade failed for %s: %s", slug, exc)
        if not db.query(Setting.id).filter(Setting.key == SCORING_KEY).first():
            db.add(Setting(key=SCORING_KEY, value=json.dumps(DEFAULT_RULES), type="json", category="leads", label="Lead scoring rules",
                           description="Points used for the lead score (0-99): base, value bands, linked customer / contact, "
                                       "source points by lead-source id, follow-up, recent activity and stage. hot_threshold drives the Hot view."))
            db.commit()
        if not db.query(Setting.id).filter(Setting.key == LOST_KEY).first():
            db.add(Setting(key=LOST_KEY, value=json.dumps(DEFAULT_LOST), type="json", category="leads", label="Lead lost reasons",
                           description="Reasons offered when a lead is moved to a lost stage; required = a reason must be chosen."))
            db.commit()
        _READY.add(slug)


def ensure_schema_all_tenants() -> None:
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant
    master = MasterSessionLocal()
    try:
        slugs = [t.slug for t in master.query(Tenant).all()]
    except Exception as exc:  # pragma: no cover
        logger.warning("Leads schema sync: unable to list tenants: %s", exc)
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
            logger.warning("Leads schema sync failed for %s: %s", slug, exc)


def lost_reasons(db: Session) -> dict[str, Any]:
    out = dict(DEFAULT_LOST)
    row = db.query(Setting).filter(Setting.key == LOST_KEY).first()
    if row and row.value:
        try:
            v = json.loads(row.value)
            if isinstance(v, dict):
                out.update({k: v[k] for k in ("required", "reasons") if k in v})
            elif isinstance(v, list):
                out["reasons"] = v
        except ValueError:
            pass
    out["reasons"] = [str(x).strip() for x in out.get("reasons") or [] if str(x).strip()]
    out["required"] = bool(out.get("required")) and bool(out["reasons"])
    return out


def scoring_rules(db: Session) -> dict[str, Any]:
    rules = dict(DEFAULT_RULES)
    row = db.query(Setting).filter(Setting.key == SCORING_KEY).first()
    if row and row.value:
        try:
            custom = json.loads(row.value)
            if isinstance(custom, dict):
                rules.update(custom)
        except ValueError:
            logger.warning("Lead scoring rules are not valid JSON – defaults used")
    return rules


# ─── stages (lead workflow) ───────────────────────────────────────────────────

# Prototype v17 buildWF() lead workflow: 5 open stages + Converted (won) + Disqualified (lost).
# key = the leads.status value a move stores; values = every status shown in that column.
STAGES: tuple[dict[str, Any], ...] = (
    {"key": "Assigned", "label": "New", "kind": "open", "values": ["Assigned"]},
    {"key": "Contacted", "label": "Contacted", "kind": "open", "values": ["Contacted"]},
    {"key": "Qualified", "label": "Qualified", "kind": "open", "values": ["Qualified"]},
    {"key": "Proposal Pending", "label": "Proposal Pending", "kind": "open", "values": ["Proposal Pending"]},
    {"key": "Nurturing", "label": "Nurturing", "kind": "open", "values": ["Nurturing"]},
    {"key": "Opportunity Created", "label": "Converted", "kind": "won", "values": ["Opportunity Created", "Converted"]},
    {"key": "Lost", "label": "Disqualified", "kind": "lost", "values": ["Lost"]},
)
# Statuses of a lead that is still being worked (can be converted to a deal, follow-ups count as due).
OPEN_STAGES: tuple[str, ...] = tuple(s["key"] for s in STAGES if s["kind"] == "open")
# Full leads.status enum, in workflow order (legacy values kept – Deals, reports and dashboards use them).
STATUS_ENUM: tuple[str, ...] = ("Assigned", "Contacted", "Qualified", "Proposal Pending", "Nurturing", "Opportunity Created", "Converted", "Lost")


def stages() -> list[dict[str, Any]]:
    """The lead workflow stages in order with their kind and the statuses each one groups."""
    return [{**s, "values": list(s["values"])} for s in STAGES]


def stage_of(status: Optional[str]) -> Optional[dict[str, Any]]:
    return next((s for s in STAGES if status in s["values"]), None)


def _ensure_status_enum(db: Session) -> None:
    """Add the prototype v17 open stages to leads.status (additive – existing values and rows are untouched)."""
    from sqlalchemy import text
    col = db.execute(text("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() "
                          "AND TABLE_NAME = 'leads' AND COLUMN_NAME = 'status'")).scalar()
    if not col:
        return
    have = {v.strip().strip("'") for v in str(col)[str(col).find("(") + 1:str(col).rfind(")")].split(",")}
    if all(v in have for v in STATUS_ENUM):
        return
    values = list(STATUS_ENUM) + sorted(have - set(STATUS_ENUM))   # never drop a value a tenant already has
    enum_sql = ",".join("'" + v.replace("'", "''") + "'" for v in values)
    db.execute(text(f"ALTER TABLE leads MODIFY COLUMN status ENUM({enum_sql}) NOT NULL DEFAULT 'Assigned'"))
    db.commit()
    logger.info("leads.status upgraded to the v17 stages for %s", db.info.get("tenant_slug"))


# ─── helpers ──────────────────────────────────────────────────────────────────

def f(v: Any) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def as_date(d: Any) -> Optional[date]:
    if d is None:
        return None
    return d.date() if isinstance(d, datetime) else d


def iso(d: Any) -> Optional[str]:
    d = as_date(d)
    return d.isoformat() if d else None


def user_names(db: Session, ids: Iterable[Optional[int]]) -> dict[int, str]:
    want = {int(i) for i in ids if i}
    return {u.id: u.full_name for u in db.query(User.id, User.full_name).filter(User.id.in_(want)).all()} if want else {}


def lead_query(db: Session, user: User):
    from app.routers.lead_router import _scope_query
    return _scope_query(db.query(Lead), db, user).filter(Lead.lead_type != "direct_opportunity")


def first_products(db: Session, lead_ids: list[int]) -> dict[int, dict[str, Any]]:
    """The lead's first product line (the prototype's single "Interested in") and how many lines there are."""
    out: dict[int, dict[str, Any]] = {}
    if not lead_ids:
        return out
    for p in db.query(LeadProduct).filter(LeadProduct.lead_id.in_(lead_ids)).order_by(LeadProduct.lead_id, LeadProduct.sort_order, LeadProduct.id).all():
        if p.lead_id in out:
            out[p.lead_id]["more"] += 1
        else:
            out[p.lead_id] = {"row_id": p.id, "product_id": p.product_id, "name": p.product_name, "more": 0}
    return out


def recent_activity_counts(db: Session, lead_ids: list[int], days: int) -> dict[int, int]:
    if not lead_ids:
        return {}
    since = today_ist() - timedelta(days=days)
    rows = db.query(KAMActivity.lead_id, func.count(KAMActivity.id)).filter(
        KAMActivity.lead_id.in_(lead_ids), KAMActivity.activity_date >= since, KAMActivity.activity_date <= today_ist(),
        KAMActivity.status != "Cancelled").group_by(KAMActivity.lead_id).all()
    return {lid: int(n) for lid, n in rows}


def score(lead: Lead, rules: dict[str, Any], *, contact_linked: bool, acts: int, today: date) -> int:
    pts = f(rules.get("base"))
    val = f(lead.est_value)
    for floor, add in sorted(rules.get("value_bands") or [], key=lambda x: -f(x[0])):
        if val >= f(floor):
            pts += f(add)
            break
    if lead.customer_id:
        pts += f(rules.get("customer_linked"))
    if contact_linked or (lead.contact_person or "").strip():
        pts += f(rules.get("contact_linked"))
    if lead.source_id is not None:
        pts += f((rules.get("source_points") or {}).get(str(lead.source_id)))
    fu = as_date(lead.follow_up)
    if fu:
        pts += f(rules.get("follow_up_set")) if fu >= today else f(rules.get("follow_up_overdue"))
    pts += min(f(rules.get("activity_cap")), acts * f(rules.get("activity_points")))
    pts += f((rules.get("stage_points") or {}).get(lead.status))
    return int(max(0, min(99, round(pts))))


# ─── list rows ────────────────────────────────────────────────────────────────

def list_rows(db: Session, user: User) -> list[dict[str, Any]]:
    today = today_ist()
    rules = scoring_rules(db)
    leads = lead_query(db, user).all()
    ids = [l.id for l in leads]
    sources = {s.id: s.name for s in db.query(LeadSource.id, LeadSource.name).all()}
    owners = user_names(db, [l.assigned_to for l in leads])
    prods = first_products(db, ids)
    acts = recent_activity_counts(db, ids, int(rules.get("activity_days") or 30))
    linked = {r.lead_id for r in db.query(LeadContactLink.lead_id).filter(LeadContactLink.lead_id.in_(ids or [-1]), LeadContactLink.contact_id.isnot(None)).all()}
    from app.services.deal_service import _row_extras
    extras = _row_extras(db, leads)          # business model / vertical + tender / quote / order of each journey
    out = []
    for l in leads:
        p = prods.get(l.id)
        interest = (p["name"] + (f" +{p['more']}" if p["more"] else "")) if p else (l.lead_title or "")
        out.append({
            "id": l.id, "ref": l.lead_ref_id or f"LD-{l.id}", "company": l.customer_name or "", "customer_id": l.customer_id,
            "contact": l.contact_person or "", "source": sources.get(l.source_id, "") if l.source_id else "", "source_id": l.source_id,
            "interest": interest, "title": l.lead_title, "value": f(l.est_value),
            "score": score(l, rules, contact_linked=l.id in linked, acts=acts.get(l.id, 0), today=today),
            "stage": l.status, "owner": owners.get(l.assigned_to, "") if l.assigned_to else "", "owner_id": l.assigned_to,
            "follow_up": iso(l.follow_up), "approval_status": l.approval_status,
            # prototype v17 grid additions: Journey · Flow · Model · Vertical
            "jid": f"J-{l.id:04d}", "journey": lead_journey(l, extras[l.id]), "flow": LEAD_FLOW,
            "model": extras[l.id]["model"] or "", "vertical": extras[l.id]["vertical"] or "",
        })
    return out


# The lead workflow above is the one lead flow a tenant has (deal flows are the Deals pipelines).
LEAD_FLOW = "Lead workflow"


def lead_journey(l: Lead, ex: dict[str, Any]) -> dict[str, Any]:
    """Prototype jSteps() from the lead's side: L (this lead) · D (deal on the same row) · T|Q · O."""
    is_deal = l.status in ("Opportunity Created", "Converted")
    tq = ex.get("tq")
    tq_k = "Q" if (tq and tq["k"] == "Q") or (not tq and (l.conversion_target or "").lower() == "quotation") else "T"
    grp = stage_of(l.status)
    return {"id": f"J-{l.id:04d}", "steps": [
        {"k": "L", "label": "Lead", "done": True, "stage": grp["label"] if grp else l.status, "me": True},
        {"k": "D", "label": "Deal", "done": is_deal, "stage": "Open" if is_deal else None},
        {"k": tq_k, "label": "Quote" if tq_k == "Q" else "Tender", "done": bool(tq), "stage": tq["stage"] if tq else None, "ref": tq["ref"] if tq else None},
        {"k": "O", "label": "Order", "done": bool(ex.get("order")), "stage": ex["order"]["stage"] if ex.get("order") else None},
    ]}


# ─── drawer ───────────────────────────────────────────────────────────────────

def detail(db: Session, user: User, lead: Lead) -> dict[str, Any]:
    from app.services import inbox_service as records
    today = today_ist()
    rules = scoring_rules(db)
    link = db.query(LeadContactLink).filter(LeadContactLink.lead_id == lead.id).first()
    acts_n = recent_activity_counts(db, [lead.id], int(rules.get("activity_days") or 30)).get(lead.id, 0)
    sc = score(lead, rules, contact_linked=bool(link and link.contact_id), acts=acts_n, today=today)
    names = user_names(db, [lead.assigned_to, lead.created_by])
    src = db.query(LeadSource.name).filter(LeadSource.id == lead.source_id).scalar() if lead.source_id else None
    prod = first_products(db, [lead.id]).get(lead.id)
    created = as_date(lead.lead_created_at or lead.created_at) or today
    fu = as_date(lead.follow_up)
    # model · vertical (business unit master)
    model = vertical = None
    if lead.business_vertical_id:
        try:
            from app.services.deal_service import business_model_vertical
            model, vertical = business_model_vertical(db, [lead.business_vertical_id]).get(lead.business_vertical_id, (None, None))
        except Exception:
            db.rollback()
    st = stages()
    open_st = [s for s in st if s["kind"] == "open"]
    idx = next((i for i, s in enumerate(open_st) if s["key"] == lead.status), len(open_st) - 1 if lead.status not in [s["key"] for s in open_st] else 0)

    # signals
    signals = []
    if lead.customer_id:
        try:
            from app.services.customer360_service import account_metrics, metrics_for
            h = metrics_for(account_metrics(db, {lead.customer_id}), lead.customer_id)["health"]
            signals.append({"t": "ok" if h >= 75 else "wa" if h >= 55 else "ba", "s": f"Customer health {h}"})
        except Exception:
            db.rollback()
    if f(lead.est_value) >= f(rules.get("high_value")):
        signals.append({"t": "ok", "s": "High-value opportunity"})
    last_act = db.query(func.max(KAMActivity.activity_date)).filter(KAMActivity.lead_id == lead.id, KAMActivity.status != "Cancelled",
                                                          KAMActivity.activity_date <= today).scalar()  # planned future follow-ups are not "activity"
    signals.append({"t": "wa", "s": "No activity logged yet"} if not last_act else {"t": "ok" if (today - as_date(last_act)).days <= 14 else "wa", "s": f"Last activity {(today - as_date(last_act)).days} d ago"})
    if fu and fu < today and lead.status in OPEN_STAGES:
        signals.append({"t": "ba", "s": f"Follow-up overdue by {(today - fu).days} d"})

    # journey: lead → deal → tender / quote → order
    is_deal = lead.status in ("Opportunity Created", "Converted")
    tender = db.query(Tender).filter(Tender.id == lead.converted_tender_id).first() if lead.converted_tender_id else \
        db.query(Tender).filter(Tender.lead_id == lead.id, Tender.is_deleted == False).order_by(Tender.id.desc()).first()
    quote = db.query(Quotation).filter(Quotation.lead_id == lead.id).order_by(Quotation.id.desc()).first()
    order = None
    if tender and tender.result == "Won":
        order = {"ref": tender.po_num or tender.tender_num or f"TND-{tender.id}", "route": f"/workorders/{tender.id}/edit", "status": "Won"}
    else:
        wo = db.query(WorkOrder).filter(WorkOrder.lead_id == lead.id).first()
        if wo:
            order = {"ref": wo.wo_number, "route": "/workorders", "status": wo.status}
    journey = [
        {"k": "lead", "label": "Lead", "ref": lead.lead_ref_id, "stage": lead.status, "value": f(lead.est_value), "date": iso(created), "done": True},
        {"k": "deal", "label": "Deal", "ref": lead.opportunity_ref_id if is_deal else None, "stage": lead.status if is_deal else None,
         "route": records.record_route("opportunities", lead.id) if is_deal else None, "done": is_deal},
        {"k": "tq", "label": "Tender or quote", "ref": (tender.tender_num or f"TND-{tender.id}") if tender else (quote.quotation_number if quote else None),
         "stage": (tender.result if tender and tender.result in ("Won", "Lost") else tender.tender_status) if tender else (quote.status if quote else None),
         "route": records.record_route("tenders", tender.id) if tender else ("/quotations" if quote else None), "done": bool(tender or quote)},
        {"k": "order", "label": "Work order", "ref": order["ref"] if order else None, "stage": order["status"] if order else None,
         "route": order["route"] if order else None, "done": bool(order)},
    ]

    # field panels
    custom = lead.custom_data if isinstance(lead.custom_data, dict) else {}
    panels = [
        {"t": "Contact & source", "i": "users", "f": [["Contact person", lead.contact_person], ["Source", src]]},
        {"t": "Commercials", "i": "tag", "f": [["Expected value", f(lead.est_value) or None, "inr"], ["Interested in", (prod["name"] if prod else lead.lead_title)]]},
        {"t": "Ownership & timeline", "i": "cal", "f": [["Owner", names.get(lead.assigned_to), "user"], ["Next follow-up", iso(fu), "date"], ["Stage", lead.status, "pill"]]},
        {"t": "Additional information", "i": "layout", "f": [["Company", lead.customer_name]] + [[k.replace("_", " ").capitalize(), v if not isinstance(v, (dict, list)) else json.dumps(v)] for k, v in custom.items()]},
    ]

    # activity timeline
    tl = [{"d": (lead.lead_created_at or lead.created_at).isoformat() if (lead.lead_created_at or lead.created_at) else None, "t": "Record created", "by": names.get(lead.created_by, "")}]
    logs = db.query(ActivityLog).filter(ActivityLog.module == "leads", ActivityLog.record_id == lead.id).order_by(ActivityLog.created_at.desc()).limit(60).all()
    acts = db.query(KAMActivity).filter(KAMActivity.lead_id == lead.id).order_by(KAMActivity.activity_date.desc()).limit(60).all()
    un = user_names(db, [x.user_id for x in logs] + [a.user_id for a in acts])
    tl += [{"d": x.created_at.isoformat() if x.created_at else None, "t": x.description, "by": un.get(x.user_id, "")} for x in logs]
    tl += [{"d": f"{a.activity_date}T00:00:00" if a.activity_date else None, "t": f"{a.activity_type} – {a.subject}" + (f" ({a.status})" if a.status else ""), "by": un.get(a.user_id, "")} for a in acts]
    tl.sort(key=lambda x: x["d"] or "", reverse=True)

    notes = db.query(LeadNote).filter(LeadNote.lead_id == lead.id).order_by(LeadNote.created_at.desc()).all()
    nn = user_names(db, [n.created_by for n in notes])
    note_rows = [{"id": n.id, "body": n.body, "by": nn.get(n.created_by, ""), "by_id": n.created_by, "at": n.created_at.isoformat() if n.created_at else None} for n in notes]
    if (lead.notes or "").strip():
        note_rows.append({"id": 0, "body": lead.notes.strip(), "by": names.get(lead.created_by, ""), "at": None, "legacy": True})

    contact_id = link.contact_id if link else None
    return {
        "id": lead.id, "ref": lead.lead_ref_id or f"LD-{lead.id}", "company": lead.customer_name or lead.lead_title, "customer_id": lead.customer_id,
        "title": lead.lead_title, "stage": lead.status, "approval_status": lead.approval_status, "conversion_target": lead.conversion_target,
        "kpis": {"value": f(lead.est_value), "score": sc, "age": (today - created).days, "created": iso(created), "follow_up": iso(fu),
                 "follow_in": (fu - today).days if fu else None, "model": model, "vertical": vertical},
        "progress": {"index": idx + 1, "of": len(open_st)}, "stages": st, "signals": signals, "journey": journey, "panels": panels,
        "timeline": tl, "notes": note_rows,
        "form": {"customer_id": lead.customer_id, "customer_name": lead.customer_name, "contact_id": contact_id, "contact_person": lead.contact_person,
                 "source_id": lead.source_id, "est_value": f(lead.est_value), "product_id": prod["product_id"] if prod else None,
                 "product_name": prod["name"] if prod else None, "assigned_to": lead.assigned_to, "follow_up": iso(fu), "custom_data": custom},
    }
