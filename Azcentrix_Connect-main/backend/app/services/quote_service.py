"""Quotes (prototype v17 · Sales → Quotes): quote lifecycle, revisions, line items, pricing, commercial terms, PDF
data, approvals and work-order conversion.

* A quote = every ``quotations`` row with the same ``quotation_number``; each row is one revision. Rows are ordered by
  (revision_number, id); index 0 is shown as "Rev 0" (prototype). The last row is the latest revision – the only one
  whose lines / note can change. Older rows are never written by this module.
* Lifecycle: the shared tenant workflow tables (workflow_definitions / workflow_stages / workflow_record_stages) under
  the workflow key ``quote``; record_id = the quote's first revision row id. A tenant without a quote workflow gets
  the prototype stages once (Draft → Internal Review [approval] → Sent to Customer → Under Negotiation → Accepted /
  Rejected); after that the configured stages are always read from the database.
* ``quotations.status`` of the latest revision is kept in step with the stage kind (Draft / Sent / Accepted /
  Rejected) because reports, dashboards and Deals read it.
* Pricing: Amount = Qty × Rate × (1 − Disc % / 100); GST per line (tax_percent, default from Settings → Quotes or
  the product's GST %); totals are stored on the revision row (amount / tax_amount / total_amount). Decimal maths.
* Permissions: quotations.view / create / update / delete (+ data scope "quotations": created_by / signatory = owner).
"""
from __future__ import annotations

import json
import logging
import threading
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Optional

from fastapi import HTTPException, Request
from sqlalchemy import bindparam, false, text
from sqlalchemy.orm import Session

from app.core.timezone import now_ist, today_ist
from app.dependencies import get_request_ip, user_has_permission
from app.models.all_models import (ActivityLog, Customer, FormField, Lead, LeadProduct, Quotation, QuotationLineItem, Setting,
                                   Tender, User, WorkOrder)
from app.models.quotes import QUOTE_TABLES, QuoteProfile

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()

WORKFLOW = "quote"
MODULE = "quotations"            # permissions, audit log, Document Hub source, Form Builder module
# Prototype v17 WF.quote: name | kind | SLA days | gate | owner role
DEFAULT_STAGES = [
    ("Draft", "open", 2, "None", None), ("Internal Review", "open", 2, "Approval", "Sales Head"),
    ("Sent to Customer", "open", 1, "None", None), ("Under Negotiation", "open", 7, "None", None),
    ("Accepted", "won", 0, "None", None), ("Rejected", "lost", 0, "None", None),
]
GATES = ("None", "Approval", "Checklist")
KINDS = ("open", "won", "lost")

# Settings → Quotes (tenant ``settings`` table, category "quotes"). Empty = not configured.
CONFIG_KEYS = {
    "gst_percent": ("quote_gst_percent", "Default GST % on quote lines", "number"),
    "validity_days": ("quote_validity_days", "Default quote validity (days)", "number"),
    "max_discount": ("quote_max_discount_percent", "Maximum line discount %", "number"),
    "payment": ("quote_terms_payment", "Commercial terms – Payment", "string"),
    "delivery": ("quote_terms_delivery", "Commercial terms – Delivery", "string"),
    "warranty": ("quote_terms_warranty", "Commercial terms – Warranty", "string"),
}
D0 = Decimal("0")
C2 = Decimal("0.01")


def q2(v: Decimal) -> Decimal:
    return v.quantize(C2, rounding=ROUND_HALF_UP)


def dec(v: Any) -> Decimal:
    if v is None or v == "":
        return D0
    try:
        return Decimal(str(v))
    except Exception:
        raise HTTPException(422, f"Invalid number: {v}")


# ─── schema + default workflow ────────────────────────────────────────────────

def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        from app.routers.quotation_router import _ensure_quotation_runtime_schema
        from app.services.platform_workflow_templates import TENANT_DDL
        _ensure_quotation_runtime_schema(db)
        for ddl in TENANT_DDL:
            db.execute(text(ddl))
        for ddl in (
            "ALTER TABLE quotation_line_items ADD COLUMN IF NOT EXISTS `discount_percent` DECIMAL(5,2) NOT NULL DEFAULT 0",
            "ALTER TABLE quotation_line_items ADD COLUMN IF NOT EXISTS `product_id` INT NULL",
            "ALTER TABLE products_master ADD COLUMN IF NOT EXISTS `list_price` DECIMAL(15,2) NULL",
            "ALTER TABLE products_master ADD COLUMN IF NOT EXISTS `gst_percent` DECIMAL(5,2) NULL",
        ):
            try:
                db.execute(text(ddl))
            except Exception as exc:           # table missing on a very old tenant – the module still works without it
                logger.warning("quotes schema: %s skipped: %s", ddl[:60], exc)
                db.rollback()
        db.commit()
        for t in QUOTE_TABLES:
            t.create(bind=db.get_bind(), checkfirst=True)
        db.commit()
        if not db.execute(text("SELECT 1 FROM workflow_definitions WHERE workflow = :w"), {"w": WORKFLOW}).first():
            db.execute(text("INSERT INTO workflow_definitions (workflow, revision, template_key, template_name, applied_by, applied_at) "
                            "VALUES (:w, 1, 'quote-default', 'Quote lifecycle', 'Quotes defaults', :now)"), {"w": WORKFLOW, "now": now_ist()})
            for i, (n, k, sla, g, o) in enumerate(DEFAULT_STAGES):
                db.execute(text("INSERT INTO workflow_stages (workflow, revision, position, name, kind, sla_days, gate, owner_role, checklist) "
                                "VALUES (:w, 1, :p, :n, :k, :sla, :g, :o, NULL)"), {"w": WORKFLOW, "p": i, "n": n, "k": k, "sla": sla, "g": g, "o": o})
            db.commit()
        # Prototype v17 names the sidebar entry "Quotes": drop the old "Quotations" rename override left on older tenants.
        if db.execute(text("UPDATE modules SET display_name = NULL WHERE `key` = 'quotations' AND display_name = 'Quotations'")).rowcount:
            db.commit()
            from app.services.cache_service import invalidate_sidebar_cache
            invalidate_sidebar_cache(db)
        else:
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
            logger.warning("quotes schema: tenant %s unavailable: %s", slug, exc)
            continue
        try:
            db.info["tenant_slug"] = slug
            ensure_schema(db)
        except Exception as exc:
            logger.warning("quotes schema for %s failed: %s", slug, exc)
            db.rollback()
        finally:
            db.close()


# ─── workflow (Pipelines & Stages / Process Designer) ─────────────────────────

def stages(db: Session) -> list[dict[str, Any]]:
    rev = db.execute(text("SELECT revision FROM workflow_definitions WHERE workflow = :w"), {"w": WORKFLOW}).scalar()
    if rev is None:
        return []
    rows = db.execute(text("SELECT id, position, name, kind, sla_days, gate, owner_role, checklist FROM workflow_stages "
                           "WHERE workflow = :w AND revision = :r ORDER BY position"), {"w": WORKFLOW, "r": rev}).mappings().all()
    out = []
    for s in rows:
        cl = s["checklist"]
        if isinstance(cl, str):
            try:
                cl = json.loads(cl)
            except ValueError:
                cl = None
        out.append({"id": s["id"], "name": s["name"], "kind": s["kind"], "sla": int(s["sla_days"] or 0), "gate": s["gate"] or "None",
                    "owner_role": s["owner_role"], "checklist": cl or [], "position": s["position"]})
    return [s for s in out if s["kind"] == "open"] + [s for s in out if s["kind"] == "won"] + [s for s in out if s["kind"] == "lost"]


def save_stages(db: Session, new: list[dict]) -> None:
    """Update the quote lifecycle in place (stage ids – and the quotes on them – are kept), add stages, remove stages
    that hold no quotes. Needs open stages plus exactly one won (Accepted) and one lost (Rejected) stage."""
    clean = []
    for s in new:
        nm = str(s.get("name") or "").strip()
        if not nm:
            raise HTTPException(422, "Every stage needs a name")
        kind, gate = s.get("kind") or "open", s.get("gate") or "None"
        if kind not in KINDS or gate not in GATES:
            raise HTTPException(422, f"Invalid stage settings for {nm}")
        cl = [str(x).strip() for x in (s.get("checklist") or []) if str(x).strip()]
        if gate == "Checklist" and not cl:
            raise HTTPException(422, f"{nm}: a checklist gate needs at least one item")
        clean.append({**s, "name": nm, "kind": kind, "gate": gate, "checklist": cl or None})
    names = [s["name"].lower() for s in clean]
    if len(set(names)) != len(names):
        raise HTTPException(422, "Stage names must be unique")
    kinds = [s["kind"] for s in clean]
    if kinds.count("won") != 1 or kinds.count("lost") != 1 or not kinds.count("open"):
        raise HTTPException(422, "The quote lifecycle needs open stages plus exactly one won and one lost stage")
    clean = [s for s in clean if s["kind"] == "open"] + [s for s in clean if s["kind"] == "won"] + [s for s in clean if s["kind"] == "lost"]
    rev = db.execute(text("SELECT revision FROM workflow_definitions WHERE workflow = :w FOR UPDATE"), {"w": WORKFLOW}).scalar()
    current = {r[0] for r in db.execute(text("SELECT id FROM workflow_stages WHERE workflow = :w AND revision = :r"), {"w": WORKFLOW, "r": rev}).all()}
    keep = {int(s["id"]) for s in clean if s.get("id") and int(s["id"]) in current}
    gone = current - keep
    if gone:
        used = db.execute(text("SELECT COUNT(*) FROM workflow_record_stages WHERE workflow = :w AND stage_id IN :ids").bindparams(
            bindparam("ids", expanding=True)), {"w": WORKFLOW, "ids": list(gone)}).scalar()
        if used:
            raise HTTPException(409, f"{used} quote(s) are on stages you removed – move them first")
        db.execute(text("DELETE FROM workflow_stages WHERE id IN :ids").bindparams(bindparam("ids", expanding=True)), {"ids": list(gone)})
    db.execute(text("UPDATE workflow_stages SET position = position + 1000 WHERE workflow = :w AND revision = :r"), {"w": WORKFLOW, "r": rev})
    for i, s in enumerate(clean):
        p = {"w": WORKFLOW, "r": rev, "p": i, "n": s["name"], "k": s["kind"], "sla": int(s.get("sla") or 0), "g": s["gate"],
             "o": s.get("owner_role") or None, "c": json.dumps(s["checklist"]) if s["checklist"] else None}
        if s.get("id") and int(s["id"]) in keep:
            db.execute(text("UPDATE workflow_stages SET position=:p, name=:n, kind=:k, sla_days=:sla, gate=:g, owner_role=:o, checklist=:c WHERE id = :id"),
                       {**p, "id": int(s["id"])})
        else:
            db.execute(text("INSERT INTO workflow_stages (workflow, revision, position, name, kind, sla_days, gate, owner_role, checklist) "
                            "VALUES (:w, :r, :p, :n, :k, :sla, :g, :o, :c)"), p)


def stage_counts(db: Session) -> dict[int, int]:
    return {int(a): int(b) for a, b in db.execute(text("SELECT stage_id, COUNT(*) FROM workflow_record_stages WHERE workflow = :w GROUP BY stage_id"),
                                                  {"w": WORKFLOW}).all()}


# ─── Settings → Quotes (GST, validity, discount limit, commercial terms) ──────

def config(db: Session) -> dict[str, Any]:
    rows = {s.key: s.value for s in db.query(Setting).filter(Setting.key.in_([k for k, _, _ in CONFIG_KEYS.values()])).all()}
    out: dict[str, Any] = {}
    for name, (key, _, typ) in CONFIG_KEYS.items():
        v = (rows.get(key) or "").strip()
        if typ == "number":
            try:
                out[name] = float(v) if v != "" else None
            except ValueError:
                out[name] = None
        else:
            out[name] = v or None
    return out


def save_config(db: Session, cu: User, values: dict[str, Any]) -> dict[str, Any]:
    for name, raw in values.items():
        if name not in CONFIG_KEYS:
            continue
        key, label, typ = CONFIG_KEYS[name]
        v = "" if raw is None else str(raw).strip()
        if typ == "number" and v != "":
            try:
                n = float(v)
            except ValueError:
                raise HTTPException(422, f"{label} must be a number")
            lim = {"gst_percent": (0, 100), "max_discount": (0, 100), "validity_days": (0, 3650)}[name]
            if not lim[0] <= n <= lim[1]:
                raise HTTPException(422, f"{label} must be between {lim[0]} and {lim[1]}")
        row = db.query(Setting).filter(Setting.key == key).first()
        if row is None:
            row = Setting(key=key, value=v, type="number" if typ == "number" else "string", category="quotes", label=label)
            db.add(row)
        else:
            row.value = v
        row.updated_by = cu.id
    db.flush()
    return config(db)


# ─── reading quotes ───────────────────────────────────────────────────────────

def scoped(db: Session, cu: User):
    from app.utils.data_scope import apply_data_scope
    q = db.query(Quotation)
    if not user_has_permission(db, cu, "quotations.view"):
        return q.filter(false())
    return apply_data_scope(db, q, cu, "quotations", Quotation.created_by, Quotation.signatory_user_id)


def groups(db: Session, numbers: Optional[set[str]] = None, cu: Optional[User] = None) -> dict[str, list[Quotation]]:
    """quotation_number → its revision rows (oldest first). ``cu`` limits to the numbers the user can see."""
    if numbers is None:
        numbers = {n for (n,) in scoped(db, cu).with_entities(Quotation.quotation_number).distinct().all()} if cu else None
    q = db.query(Quotation)
    if numbers is not None:
        if not numbers:
            return {}
        q = q.filter(Quotation.quotation_number.in_(list(numbers)))
    out: dict[str, list[Quotation]] = {}
    for r in q.order_by(Quotation.revision_number, Quotation.id).all():
        out.setdefault(r.quotation_number, []).append(r)
    return out


def get_group(db: Session, cu: User, quote_id: int) -> list[Quotation]:
    """The revisions of quote ``quote_id`` (any revision row id is accepted) if the user may see the quote."""
    row = db.query(Quotation).filter(Quotation.id == quote_id).first()
    if not row:
        raise HTTPException(404, "Quote not found")
    if not scoped(db, cu).filter(Quotation.quotation_number == row.quotation_number).first():
        raise HTTPException(404, "Quote not found")
    return groups(db, {row.quotation_number})[row.quotation_number]


def lines_by_row(db: Session, ids: list[int]) -> dict[int, list[QuotationLineItem]]:
    out: dict[int, list[QuotationLineItem]] = {}
    if not ids:
        return out
    for li in db.query(QuotationLineItem).filter(QuotationLineItem.quotation_id.in_(ids)).order_by(
            QuotationLineItem.quotation_id, QuotationLineItem.sort_order, QuotationLineItem.id).all():
        out.setdefault(li.quotation_id, []).append(li)
    return out


def line_amount(li: QuotationLineItem) -> Decimal:
    return q2(dec(li.quantity) * dec(li.unit_price) * (Decimal(1) - dec(getattr(li, "discount_percent", 0)) / 100))


def totals(row: Quotation, lines: list[QuotationLineItem]) -> dict[str, float]:
    if not lines:                         # legacy revision saved without line items: keep its stored totals
        return {"sub": float(row.amount or 0), "gst": float(row.tax_amount or 0), "total": float(row.total_amount or 0)}
    sub = gst = D0
    for li in lines:
        a = line_amount(li)
        sub += a
        gst += q2(a * dec(li.tax_percent) / 100)
    return {"sub": float(sub), "gst": float(gst), "total": float(sub + gst)}


def recompute(db: Session, row: Quotation) -> None:
    lines = db.query(QuotationLineItem).filter(QuotationLineItem.quotation_id == row.id).all()
    sub = gst = D0
    for li in lines:
        a = line_amount(li)
        g = q2(a * dec(li.tax_percent) / 100)
        li.net_price, li.gst_value, li.line_total = a, g, a + g
        sub += a
        gst += g
    row.amount, row.tax_amount, row.total_amount = sub, gst, sub + gst
    row.updated_at = now_ist()


def root_id(rows: list[Quotation]) -> int:
    return min(r.id for r in rows)


def names(db: Session, ids) -> dict[int, str]:
    ids = {int(i) for i in ids if i}
    return {u.id: u.full_name for u in db.query(User.id, User.full_name).filter(User.id.in_(ids)).all()} if ids else {}


def customer_names(db: Session, rows: list[Quotation]) -> dict[int, str]:
    """revision row id → customer name (customer master, else the linked deal / tender / letter-pad name)."""
    cids = {r.customer_id for r in rows if r.customer_id}
    cust = {c.id: c.customer_name for c in db.query(Customer.id, Customer.customer_name).filter(Customer.id.in_(cids)).all()} if cids else {}
    lids = {r.lead_id for r in rows if r.lead_id and r.customer_id not in cust}
    leads = {l.id: l.customer_name for l in db.query(Lead.id, Lead.customer_name).filter(Lead.id.in_(lids)).all()} if lids else {}
    tids = {r.tender_id for r in rows if r.tender_id and r.customer_id not in cust}
    tenders = {t.id: t.customer_name for t in db.query(Tender.id, Tender.customer_name).filter(Tender.id.in_(tids)).all()} if tids else {}
    return {r.id: cust.get(r.customer_id) or leads.get(r.lead_id) or tenders.get(r.tender_id) or (r.customer_to_name or "") for r in rows}


def owner_of(r: Quotation) -> Optional[int]:
    return r.signatory_user_id or r.created_by


def _status_for(stage: dict, opens: list[dict]) -> str:
    if stage["kind"] == "won":
        return "Accepted"
    if stage["kind"] == "lost":
        return "Rejected"
    return "Draft" if opens and stage["id"] == opens[0]["id"] else "Sent"


def sync(db: Session, grp: dict[str, list[Quotation]], st: list[dict]) -> tuple[dict[int, QuoteProfile], dict[int, dict]]:
    """Every quote gets a profile and a stage. A first mapping is derived from the latest revision's status; later
    Accepted / Rejected decisions made outside the stage engine (legacy approvals) move the quote to the won / lost stage."""
    if not grp or not st:
        return {}, {}
    roots = {root_id(rows): rows for rows in grp.values()}
    ids = list(roots)
    profiles = {p.quote_id: p for p in db.query(QuoteProfile).filter(QuoteProfile.quote_id.in_(ids)).all()}
    maps = dict(db.execute(text("SELECT record_id, stage_id FROM workflow_record_stages WHERE workflow = :w AND record_id IN :ids")
                           .bindparams(bindparam("ids", expanding=True)), {"w": WORKFLOW, "ids": ids}).all())
    by_id = {s["id"]: s for s in st}
    opens = [s for s in st if s["kind"] == "open"]
    won = next(s for s in st if s["kind"] == "won")
    lost = next(s for s in st if s["kind"] == "lost")
    sent = next((s for s in opens if s["name"].lower().startswith("sent")), opens[1] if len(opens) > 1 else opens[0])
    out: dict[int, dict] = {}
    changed = False
    for rid, rows in roots.items():
        latest = rows[-1]
        prof = profiles.get(rid)
        if prof is None:
            prof = QuoteProfile(quote_id=rid, quotation_number=latest.quotation_number, stage_entered_at=latest.updated_at or latest.created_at)
            db.add(prof)
            profiles[rid] = prof
            changed = True
        cur = by_id.get(maps.get(rid))
        want = cur
        status = latest.status or "Draft"
        if cur is None:
            want = won if status == "Accepted" else lost if status == "Rejected" else sent if status in ("Sent", "Approved") else opens[0]
        elif status == "Accepted" and cur["kind"] != "won":
            want = won
        elif status == "Rejected" and cur["kind"] != "lost":
            want = lost
        if cur is None or want["id"] != cur["id"]:
            db.execute(text("INSERT INTO workflow_record_stages (workflow, record_id, stage_id, mapped_at) VALUES (:w, :r, :s, :now) "
                            "ON DUPLICATE KEY UPDATE stage_id = VALUES(stage_id), mapped_at = VALUES(mapped_at)"),
                       {"w": WORKFLOW, "r": rid, "s": want["id"], "now": now_ist()})
            if cur is not None:
                prof.stage_entered_at = now_ist()
            changed = True
        out[rid] = want
    if changed:
        db.commit()
    return profiles, out


def work_order_for(db: Session, prof: Optional[QuoteProfile], rows: list[Quotation]) -> Optional[WorkOrder]:
    if prof and prof.work_order_id:
        wo = db.query(WorkOrder).filter(WorkOrder.id == prof.work_order_id).first()
        if wo:
            return wo
    return db.query(WorkOrder).filter(WorkOrder.quotation_id.in_([r.id for r in rows])).order_by(WorkOrder.id).first()


def journeys(db: Session, grp: dict[str, list[Quotation]], profiles: dict, cur: dict[int, dict]) -> dict[int, dict]:
    """Prototype jTrack() per quote: L · D · Q · O (lead, deal, this quote, work order), read in batched queries."""
    latest = {root_id(rows): rows[-1] for rows in grp.values()}
    tids = {r.tender_id for r in latest.values() if r.tender_id and not r.lead_id}
    t_lead = {t.id: t.lead_id for t in db.query(Tender.id, Tender.lead_id).filter(Tender.id.in_(tids)).all()} if tids else {}
    lead_of = {rid: r.lead_id or t_lead.get(r.tender_id) for rid, r in latest.items()}
    lids = {v for v in lead_of.values() if v}
    leads = {l.id: l for l in db.query(Lead.id, Lead.lead_type, Lead.status, Lead.opportunity_ref_id).filter(Lead.id.in_(lids)).all()} if lids else {}
    qids = {r.id: root_id(rows) for rows in grp.values() for r in rows}
    wo_ids = {p.work_order_id for p in profiles.values() if p and p.work_order_id}
    wos_by_id, wos_by_root = {}, {}
    if wo_ids or qids:
        q = db.query(WorkOrder.id, WorkOrder.quotation_id, WorkOrder.wo_number, WorkOrder.status)
        conds = []
        if wo_ids:
            conds.append(WorkOrder.id.in_(wo_ids))
        if qids:
            conds.append(WorkOrder.quotation_id.in_(list(qids)))
        from sqlalchemy import or_
        for w in q.filter(or_(*conds)).order_by(WorkOrder.id).all():
            wos_by_id[w.id] = w
            if w.quotation_id in qids:
                wos_by_root.setdefault(qids[w.quotation_id], w)
    out = {}
    for rid, r in latest.items():
        l, s, prof = leads.get(lead_of[rid]), cur.get(rid), profiles.get(rid)
        w = wos_by_id.get(prof.work_order_id) if prof and prof.work_order_id else None
        w = w or wos_by_root.get(rid)
        is_lead = bool(l) and l.lead_type != "direct_opportunity"
        is_deal = bool(l) and (l.lead_type == "direct_opportunity" or bool(l.opportunity_ref_id))
        out[rid] = {"id": f"J-{l.id:04d}" if l else None, "steps": [   # prototype: only quotes in a lead/deal journey carry a journey id
            {"k": "L", "label": "Lead", "done": is_lead, "stage": "Converted" if is_lead else None},
            {"k": "D", "label": "Deal", "done": is_deal, "stage": ("Won" if l.status == "Converted" else l.status) if is_deal else None, "ref": l.opportunity_ref_id if is_deal else None},
            {"k": "Q", "label": "Quote", "done": True, "stage": s["name"] if s else None, "ref": r.quotation_number, "me": True},
            {"k": "O", "label": "Order", "done": bool(w), "stage": w.status if w else None, "ref": w.wo_number if w else None},
        ]}
    return out


def list_rows(db: Session, cu: User) -> tuple[list[dict], list[dict]]:
    st = stages(db)
    grp = groups(db, cu=cu)
    profiles, cur = sync(db, grp, st)
    latest_rows = [rows[-1] for rows in grp.values()]
    li = lines_by_row(db, [r.id for r in latest_rows])
    own = names(db, [owner_of(r) for r in latest_rows])
    cn = customer_names(db, latest_rows)
    jr = journeys(db, grp, profiles, cur)
    tenant_co = tenant_info(db)["name"] or ""
    out = []
    for rows in grp.values():
        rid, latest = root_id(rows), rows[-1]
        s = cur.get(rid)
        if not s:
            continue
        prof = profiles.get(rid)
        t = totals(latest, li.get(latest.id, []))
        out.append({
            "id": rid, "ref": latest.quotation_number, "subject": latest.subject or "", "customer": cn.get(latest.id, ""), "customer_id": latest.customer_id,
            "rev": len(rows) - 1, "revs": len(rows), "value": t["total"], "stage": s["name"], "stage_id": s["id"], "stage_kind": s["kind"],
            "owner": own.get(owner_of(latest), ""), "owner_id": owner_of(latest), "valid_till": latest.valid_until.isoformat() if latest.valid_until else None,
            "pending": bool(prof and prof.pending_stage_id), "enquiry": (prof.enquiry_ref if prof else None) or "", "lead_id": latest.lead_id,
            "jid": jr[rid]["id"], "journey": jr[rid],
            # prototype colsOf(): Company – the quote's letter-pad company when one was chosen, else this tenant company
            "company": (latest.company_name_override or "").strip() or tenant_co,
        })
    return out, st


# ─── validation helpers ───────────────────────────────────────────────────────

def authorized_customer(db: Session, cu: User, customer_id: int) -> str:
    from app.routers.deals_router import authorized_customers
    c = next((x for x in authorized_customers(db, cu) if x["id"] == customer_id), None)
    if not c:
        raise HTTPException(422, "Choose a customer you can work with")
    return c["customer_name"]


def active_user(db: Session, uid: int) -> None:
    if not db.query(User.id).filter(User.id == uid, User.is_active == True).first():
        raise HTTPException(422, "Choose an active user as owner")


def required_custom(db: Session) -> list[FormField]:
    return db.query(FormField).filter(FormField.module == MODULE, FormField.is_custom == True, FormField.is_visible == True,
                                      FormField.is_required == True).all()


def check_custom(db: Session, data: Optional[dict]) -> None:
    cd = data or {}
    miss = [f.label for f in required_custom(db) if cd.get(f.field_key) in (None, "", False)]
    if miss:
        raise HTTPException(422, "Required: " + ", ".join(miss))


def _log(db: Session, cu: User, request: Optional[Request], rid: int, number: str, action: str, description: str,
         old: Optional[dict] = None, new: Optional[dict] = None, icon: str = "📄") -> None:
    from app.core.logging import log_module_action
    db.add(ActivityLog(user_id=cu.id, module=MODULE, record_id=rid, action=action, description=description, icon=icon, color="#EFF6FF"))
    log_module_action(db=db, user_id=cu.id, module=MODULE, action=action, record_id=rid, record_name=number,
                      ip=get_request_ip(request) if request else "", old_data=old, new_data=new)


def _notify(db: Session, uid: Optional[int], title: str, msg: str, rid: int, action: str) -> None:
    if not uid:
        return
    try:
        from app.services.notification_service import upsert_notification
        upsert_notification(db, uid, title, msg, module=MODULE, record_id=rid, action=action, send_email=False)
    except Exception as exc:
        logger.warning("quote notification failed: %s", exc)


# ─── create / header ──────────────────────────────────────────────────────────

def create(db: Session, cu: User, request: Request, *, subject: str, customer_id: int, enquiry: Optional[str], valid_till: Optional[date],
           owner_id: Optional[int], custom_data: Optional[dict], deal_id: Optional[int] = None) -> Quotation:
    from app.routers.quotation_router import _next_quotation_number
    cname = authorized_customer(db, cu, customer_id)
    if owner_id:
        active_user(db, owner_id)
    check_custom(db, custom_data)
    st = stages(db)
    if not st:
        raise HTTPException(409, "No quote lifecycle is configured – set one up in Pipelines & Stages")
    lead = None
    if deal_id:
        from app.services.deal_service import deal_query
        lead = deal_query(db, cu).filter(Lead.id == deal_id).first()
        if not lead:
            raise HTTPException(422, "That deal is not available")
    cfg = config(db)
    if valid_till is None and cfg["validity_days"]:
        valid_till = today_ist() + timedelta(days=int(cfg["validity_days"]))
    row = Quotation(lead_id=lead.id if lead else None, customer_id=customer_id, quotation_number=_next_quotation_number(db), revision_number=1,
                    subject=subject.strip(), valid_until=valid_till, status="Draft", approval_status="none", notes="Initial quotation",
                    customer_to_name=cname, signatory_user_id=owner_id or cu.id, created_by=cu.id, amount=0, tax_amount=0, total_amount=0)
    db.add(row)
    db.flush()
    if lead:                                     # deal products become the first revision's lines
        gst_default = dec(cfg["gst_percent"]) if cfg["gst_percent"] is not None else D0
        for i, p in enumerate(db.query(LeadProduct).filter(LeadProduct.lead_id == lead.id).order_by(LeadProduct.sort_order).all()):
            db.add(QuotationLineItem(quotation_id=row.id, description=(p.product_name or p.description or "Item")[:500], quantity=p.quantity or 1,
                                     unit_price=p.unit_price or 0, tax_percent=p.gst_percent if p.gst_percent is not None else gst_default,
                                     discount_percent=0, sort_order=i))
        db.flush()
        recompute(db, row)
    first = next(s for s in st if s["kind"] == "open")
    db.add(QuoteProfile(quote_id=row.id, quotation_number=row.quotation_number, enquiry_ref=(enquiry or "").strip() or None,
                        stage_entered_at=now_ist(), custom_data=custom_data or None))
    db.execute(text("INSERT INTO workflow_record_stages (workflow, record_id, stage_id, mapped_at) VALUES (:w, :r, :s, :now)"),
               {"w": WORKFLOW, "r": row.id, "s": first["id"], "now": now_ist()})
    _log(db, cu, request, row.id, row.quotation_number, "create", f"Quote {row.quotation_number} created",
         new={"subject": row.subject, "customer": cname, "enquiry": enquiry, "valid_till": valid_till.isoformat() if valid_till else None,
              "owner_id": row.signatory_user_id, "deal_id": deal_id, "stage": first["name"]}, icon="🆕")
    if row.signatory_user_id and row.signatory_user_id != cu.id:
        _notify(db, row.signatory_user_id, "Quote assigned", f"{cu.full_name} assigned quote {row.quotation_number} – {row.subject} to you.", row.id, "assigned")
    return row


def update_header(db: Session, cu: User, request: Request, rows: list[Quotation], prof: QuoteProfile, *, subject: str, customer_id: int,
                  enquiry: Optional[str], valid_till: Optional[date], owner_id: Optional[int], custom_data: Optional[dict]) -> None:
    """Edit header (prototype edit('quotes')): quote-level values live on the latest revision + profile; older
    revisions keep their snapshot."""
    latest, rid = rows[-1], root_id(rows)
    if prof.pending_stage_id:
        raise HTTPException(409, "A stage change is waiting for approval – the quote is locked")
    old = {"subject": latest.subject, "customer_id": latest.customer_id, "enquiry": prof.enquiry_ref,
           "valid_till": latest.valid_until.isoformat() if latest.valid_until else None, "owner_id": owner_of(latest), "custom_data": prof.custom_data}
    if customer_id != latest.customer_id:
        latest.customer_to_name = authorized_customer(db, cu, customer_id)
        latest.customer_id = customer_id
    if owner_id and owner_id != owner_of(latest):
        active_user(db, owner_id)
    if custom_data is not None:
        check_custom(db, custom_data)
        prof.custom_data = custom_data or None
    latest.subject = subject.strip()
    latest.valid_until = valid_till
    prof.enquiry_ref = (enquiry or "").strip() or None
    prev_owner = owner_of(latest)
    if owner_id:
        latest.signatory_user_id = owner_id
    latest.updated_at = now_ist()
    new = {"subject": latest.subject, "customer_id": latest.customer_id, "enquiry": prof.enquiry_ref,
           "valid_till": latest.valid_until.isoformat() if latest.valid_until else None, "owner_id": owner_of(latest), "custom_data": prof.custom_data}
    ch = {k: new[k] for k in new if old[k] != new[k]}
    if ch:
        _log(db, cu, request, rid, latest.quotation_number, "update", "Quote header updated: " + ", ".join(ch), old={k: old[k] for k in ch}, new=ch, icon="✏️")
    if prev_owner != owner_of(latest):
        _notify(db, owner_of(latest), "Quote assigned", f"{cu.full_name} assigned quote {latest.quotation_number} – {latest.subject} to you.", rid, "assigned")


# ─── revisions & lines ────────────────────────────────────────────────────────

def edit_block(db: Session, rows: list[Quotation], prof: QuoteProfile, stage: dict) -> Optional[str]:
    """Why the latest revision cannot be edited right now (None = editable)."""
    latest = rows[-1]
    if prof.pending_stage_id:
        return "Waiting for approval – the revision is locked until it is decided."
    if stage["kind"] != "open":
        return f"The quote is {stage['name']} – move it back to an open stage to change it."
    if work_order_for(db, prof, rows):
        return "A work order has been created from this quote."
    if (latest.approval_status or "").lower() == "approved":
        return "This revision is approved – save as a new revision to change it."
    return None


def assert_editable(db: Session, rows: list[Quotation], prof: QuoteProfile, stage: dict, rev_id: Optional[int] = None) -> Quotation:
    latest = rows[-1]
    if rev_id is not None and rev_id != latest.id:
        raise HTTPException(409, "Older revisions are locked – only the latest revision can be changed")
    why = edit_block(db, rows, prof, stage)
    if why:
        raise HTTPException(409, why)
    return latest


def _validate_line(db: Session, f: str, v: Any) -> Any:
    if f == "description":
        s = str(v or "").strip()
        if not s:
            raise HTTPException(422, "Description cannot be empty")
        return s[:500]
    n = dec(v)
    if f == "quantity":
        if n <= 0:
            raise HTTPException(422, "Qty must be more than zero")
        if n >= Decimal("1e8"):
            raise HTTPException(422, "Qty is too large")
        return q2(n)
    if f == "unit_price":
        if n < 0:
            raise HTTPException(422, "Rate cannot be negative")
        if n >= Decimal("1e13"):
            raise HTTPException(422, "Rate is too large")
        return q2(n)
    if f == "discount_percent":
        if not D0 <= n <= 100:
            raise HTTPException(422, "Disc % must be between 0 and 100")
        mx = config(db)["max_discount"]
        if mx is not None and n > dec(mx):
            raise HTTPException(422, f"Disc % cannot exceed {mx:g}% (Discount configuration)")
        return q2(n)
    if f == "tax_percent":
        if not D0 <= n <= 100:
            raise HTTPException(422, "GST % must be between 0 and 100")
        return q2(n)
    raise HTTPException(422, "Unknown field")


LINE_FIELDS = {"description": "description", "qty": "quantity", "rate": "unit_price", "disc": "discount_percent", "tax": "tax_percent"}


def add_line(db: Session, row: Quotation, *, description: str = "New item", qty: Any = 1, rate: Any = 0, disc: Any = 0, tax: Any = None,
             product_id: Optional[int] = None) -> QuotationLineItem:
    if tax is None:
        g = config(db)["gst_percent"]
        tax = g if g is not None else 0
    pos = (db.execute(text("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM quotation_line_items WHERE quotation_id = :q"), {"q": row.id}).scalar() or 0)
    li = QuotationLineItem(quotation_id=row.id, description=_validate_line(db, "description", description), quantity=_validate_line(db, "quantity", qty),
                           unit_price=_validate_line(db, "unit_price", rate), discount_percent=_validate_line(db, "discount_percent", disc),
                           tax_percent=_validate_line(db, "tax_percent", tax), product_id=product_id, sort_order=pos)
    db.add(li)
    db.flush()
    recompute(db, row)
    return li


def catalog(db: Session, q: str = "", book_id: Optional[int] = None) -> list[dict[str, Any]]:
    """Product & Price Books catalogue for "Add from product catalogue" (prototype v18 A.qcat): products of the
    company's catalogue – only the approved record status when the model's rule "Only approved products can be added
    to quotes" is on – with the effective price of the chosen price book (override wins), floor and margin."""
    from app.services import product_model_service as PM
    from app.services import product_service as PS
    PS.ensure_schema(db)
    rules = PM.rules(db)
    lock = PM.lock_status(db)
    book = PS.get_book(db, book_id) if book_id else None
    if book is not None and book_id not in {b["id"] for b in PS.quote_books(db)}:
        raise HTTPException(422, "That price book is not active and valid today")
    ql = q.strip().lower()
    out = []
    for p in PS.products(db):
        if rules["quoteApproved"] and p["status"] != lock:
            continue
        if ql and not any(ql in str(p.get(k) or "").lower() for k in ("name", "cat", "code")):
            continue
        ep = PS.effective_price(db, book, p)
        out.append({"id": p["id"], "sku": p["code"], "code": p["code"], "name": p["name"], "category": p["cat"], "description": p["longDesc"], "unit": p["unit"],
                    "list": p["list"], "cost": p["cost"], "gst": p["gst"], "stock": p["stock"], "status": p["status"], **ep})
    out.sort(key=lambda r: r["name"].lower())
    return out[:300]


def catalog_meta(db: Session) -> dict[str, Any]:
    from app.services import product_model_service as PM
    from app.services import product_service as PS
    PS.ensure_schema(db)
    m = PM.model_out(db)
    books = PS.quote_books(db)
    default = next((b["id"] for b in books if b["is_default"]), books[0]["id"] if books else None)
    return {"books": [{"id": b["id"], "name": b["name"], "adjustment": b["adjustment"], "currency": b["currency"], "type": b["type"]} for b in books],
            "default_book": default, "lock": m["lock"], "model": m["name"], "approved_only": m["rules"]["quoteApproved"],
            "disc_limit": m["rules"]["discLimit"], "min_margin": m["rules"]["minMargin"], "disc_approval": m["rules"]["quoteDiscApproval"]}


def price_checks(db: Session, product_id: Optional[int], rate: Any, disc: Any) -> list[str]:
    """Margin / discount warnings for a quote line priced from the catalogue (company pricing rules)."""
    if not product_id:
        return []
    from app.services import product_model_service as PM
    from app.services import product_service as PS
    try:
        p = PS.get_product(db, int(product_id))
    except HTTPException:
        return []
    r = PM.rules(db)
    net = dec(rate) * (Decimal(1) - dec(disc or 0) / 100)
    out = []
    if p["list"]:
        off = (Decimal(1) - net / Decimal(str(p["list"]))) * 100
        if r["quoteDiscApproval"] and off > Decimal(str(r["discLimit"])):
            out.append(f"{p['code']}: {off:.1f}% below list is beyond the {r['discLimit']:g}% discount limit – the quote needs Sales Head approval before it is sent")
    fl = PS.floor_price(p["cost"], r["minMargin"])
    if fl is not None and net < fl:
        out.append(f"{p['code']}: net rate {net:.2f} is below the floor {fl} (cost + {r['minMargin']:g}% minimum margin)")
    return out


def new_revision(db: Session, cu: User, request: Request, rows: list[Quotation], prof: QuoteProfile) -> Quotation:
    """Prototype qnew(): copy the latest revision (lines included) into a new revision; the old one becomes locked."""
    latest, rid = rows[-1], root_id(rows)
    if prof.pending_stage_id:
        raise HTTPException(409, "A stage change is waiting for approval – decide it before revising")
    if work_order_for(db, prof, rows):
        raise HTTPException(409, "A work order has been created from this quote – it can no longer be revised")
    nxt = (db.execute(text("SELECT COALESCE(MAX(revision_number), 0) + 1 FROM quotations WHERE quotation_number = :n FOR UPDATE"),
                      {"n": latest.quotation_number}).scalar() or len(rows) + 1)
    copy_cols = ("lead_id", "tender_id", "customer_id", "letter_id", "subject", "valid_until", "terms_conditions", "ref_number", "customer_to_name",
                 "customer_address_text", "greeting_text", "signatory_user_id", "company_name_override", "company_address_override",
                 "company_address_id", "company_address_text", "status", "amount", "tax_amount", "total_amount", "tenant_id")
    new = Quotation(quotation_number=latest.quotation_number, revision_number=nxt, notes="Revised – describe what changed", approval_status="none",
                    approval_id=None, created_by=cu.id, **{c: getattr(latest, c, None) for c in copy_cols})
    db.add(new)
    db.flush()
    for li in db.query(QuotationLineItem).filter(QuotationLineItem.quotation_id == latest.id).order_by(QuotationLineItem.sort_order, QuotationLineItem.id).all():
        db.add(QuotationLineItem(quotation_id=new.id, description=li.description, quantity=li.quantity, unit_price=li.unit_price,
                                 tax_percent=li.tax_percent, discount_percent=getattr(li, "discount_percent", 0) or 0, product_id=getattr(li, "product_id", None),
                                 net_price=li.net_price, gst_value=li.gst_value, line_total=li.line_total, sort_order=li.sort_order))
    db.flush()
    recompute(db, new)
    n = len(rows)
    _log(db, cu, request, rid, latest.quotation_number, "revision", f"Revision {n} created – Rev {n - 1} is now locked",
         new={"revision": n, "revision_row_id": new.id, "copied_from_row_id": latest.id}, icon="📑")
    return new


# ─── stage engine ─────────────────────────────────────────────────────────────

def _missing_for_forward(db: Session, rows: list[Quotation], prof: QuoteProfile) -> list[str]:
    latest = rows[-1]
    miss = []
    if not latest.customer_id and not (latest.customer_to_name or "").strip():
        miss.append("Customer")
    if not (latest.subject or "").strip():
        miss.append("Subject")
    if not db.query(QuotationLineItem.id).filter(QuotationLineItem.quotation_id == latest.id).first():
        miss.append("Line items")
    cd = prof.custom_data if isinstance(prof.custom_data, dict) else {}
    miss += [f.label for f in required_custom(db) if cd.get(f.field_key) in (None, "", False)]
    return miss


def can_manage(db: Session, cu: User) -> bool:
    from app.routers.lead_router import MANAGER_ROLES
    return (cu.role or "") in MANAGER_ROLES or user_has_permission(db, cu, "settings.manage")


def apply_stage(db: Session, cu: User, request: Optional[Request], rows: list[Quotation], prof: QuoteProfile, st: list[dict], target: dict,
                reason: Optional[str] = None, comment: Optional[str] = None) -> None:
    rid, latest = root_id(rows), rows[-1]
    old = db.execute(text("SELECT s.name FROM workflow_record_stages m JOIN workflow_stages s ON s.id = m.stage_id WHERE m.workflow = :w AND m.record_id = :r"),
                     {"w": WORKFLOW, "r": rid}).scalar()
    now = now_ist()
    db.execute(text("INSERT INTO workflow_record_stages (workflow, record_id, stage_id, mapped_at) VALUES (:w, :r, :s, :now) "
                    "ON DUPLICATE KEY UPDATE stage_id = VALUES(stage_id), mapped_at = VALUES(mapped_at)"), {"w": WORKFLOW, "r": rid, "s": target["id"], "now": now})
    prof.stage_entered_at = now
    prof.pending_stage_id = None
    prof.approval_request_id = None
    if target["kind"] == "lost":
        prof.lost_reason, prof.lost_note = reason, (comment or "").strip() or None
    elif target["kind"] == "open":
        prof.lost_reason = prof.lost_note = None
    latest.status = _status_for(target, [s for s in st if s["kind"] == "open"])
    latest.updated_at = now
    _log(db, cu, request, rid, latest.quotation_number, "stage_change", f"Stage changed: {old or '—'} → {target['name']}",
         old={"stage": old}, new={"stage": target["name"], "reason": reason, "comment": (comment or "").strip() or None}, icon="🔄")
    owner = owner_of(latest)
    if owner and owner != cu.id:
        _notify(db, owner, "Quote stage changed", f"Quote {latest.quotation_number} moved to {target['name']} by {cu.full_name}.", rid, "stage_changed")


def move(db: Session, cu: User, request: Request, rows: list[Quotation], stage_id: int, *, reason: Optional[str] = None,
         comment: Optional[str] = None, checklist: Optional[list[str]] = None) -> dict[str, Any]:
    st = stages(db)
    rid, latest = root_id(rows), rows[-1]
    profiles, cur_map = sync(db, {latest.quotation_number: rows}, st)
    prof, cur = profiles[rid], cur_map[rid]
    target = next((s for s in st if s["id"] == stage_id), None)
    if not target:
        raise HTTPException(422, "That stage is not part of the quote lifecycle")
    if target["id"] == cur["id"]:
        return {"status": "unchanged", "stage": cur["name"]}
    if prof.pending_stage_id:
        raise HTTPException(409, "A stage change is waiting for approval")
    if work_order_for(db, prof, rows):
        raise HTTPException(400, "A work order has been created from this quote – its stage can no longer change")
    if cur["kind"] == "won" and target["kind"] != "lost" and not can_manage(db, cu):
        raise HTTPException(403, "Only managers can move an accepted quote back")
    order = [s["id"] for s in st]
    ci, ti = order.index(cur["id"]), order.index(target["id"])
    forward = ti > ci and target["kind"] != "lost"
    if target["kind"] == "lost":
        from app.services.lead360_service import lost_reasons
        cfg = lost_reasons(db)
        reason = (reason or "").strip() or None
        if reason and reason not in cfg["reasons"]:
            raise HTTPException(422, "Choose a reason from the list")
        if cfg["required"] and not reason:
            raise HTTPException(422, {"message": "Choose why this quote was rejected", "lost": True})
    if forward:
        miss = _missing_for_forward(db, rows, prof)
        if miss:
            raise HTTPException(422, {"message": "Complete these before moving forward: " + ", ".join(miss), "missing": miss})
        if target["gate"] == "Checklist":
            done = {str(x).strip() for x in checklist or []}
            todo = [i for i in target["checklist"] if i not in done]
            if todo:
                raise HTTPException(422, {"message": f"Complete the checklist for {target['name']}", "checklist": target["checklist"], "missing_items": todo})
            prof.checklist = {**(prof.checklist or {}), target["name"]: list(target["checklist"])}
        # Approval gates can't be skipped: entering or passing an approval-gated stage needs the latest revision approved.
        gated = [s for s in st[: ti + 1] if s["kind"] == "open" and s["gate"] == "Approval"]
        if gated and (latest.approval_status or "").lower() != "approved":
            from app.services.generic_approval_engine import create_generic_approval_request
            req = create_generic_approval_request(db, tenant_id=getattr(getattr(request.state, "tenant", None), "id", None), requester=cu,
                                                  module_key="quotation", action_key="stage", record_id=rid)
            from app.services.approvals360_service import apply_stage_policy   # Process Designer stage approval policy (chain · threshold · SLA)
            req = apply_stage_policy(db, req, cur.get("flow"), gated[-1]["name"], cur["name"], float(latest.total_amount or 0))
            if (req.status or "").strip().lower() != "approved":
                prof.pending_stage_id, prof.approval_request_id = target["id"], req.id
                latest.approval_status, latest.approval_id = "pending", req.id
                step = next((s for s in sorted(req.steps or [], key=lambda x: x.step_no) if s.step_no == req.current_step_no), None)
                approver = step.approver.full_name if step is not None and getattr(step, "approver", None) else None
                _log(db, cu, request, rid, latest.quotation_number, "approval_requested",
                     f"Rev {len(rows) - 1} sent for approval to move to {target['name']}" + (f" ({approver})" if approver else ""),
                     new={"to": target["name"], "approval_request_id": req.id, "gate": gated[-1]["name"]}, icon="⏳")
                db.commit()
                return {"status": "pending", "stage": cur["name"], "pending_stage": target["name"], "approver": approver,
                        "message": f"Sent for approval{f' to {approver}' if approver else ''} – the quote moves to “{target['name']}” once approved"}
            latest.approval_status, latest.approval_id = "approved", req.id
    apply_stage(db, cu, request, rows, prof, st, target, reason, comment)
    db.commit()
    res: dict[str, Any] = {"status": "moved", "stage": target["name"]}
    if target["kind"] == "won":
        res["next"] = {"label": "Create work order"}
    return res


def send_for_approval_target(st: list[dict], cur: dict) -> Optional[dict]:
    """Prototype qsend(): the first open stage with an Approval gate, else the second stage."""
    return next((s for s in st if s["kind"] == "open" and s["gate"] == "Approval"), None) or (st[1] if len(st) > 1 else None)


def on_stage_decision(db: Session, request_row, actor: User, remarks: str = "") -> None:
    """Approval engine callback (module "quotation", action "stage")."""
    prof = db.query(QuoteProfile).filter(QuoteProfile.approval_request_id == request_row.id).first()
    if not prof or not prof.pending_stage_id:
        return
    grp = groups(db, {prof.quotation_number}).get(prof.quotation_number)
    if not grp:
        return
    latest = grp[-1]
    status = (request_row.status or "").strip().lower()
    st = stages(db)
    target = next((s for s in st if s["id"] == prof.pending_stage_id), None)
    if status == "approved" and target:
        latest.approval_status, latest.approval_id = "approved", request_row.id
        apply_stage(db, actor, None, grp, prof, st, target)
        _notify(db, owner_of(latest), "Quote approved", f"Quote {latest.quotation_number} was approved and moved to {target['name']}.", prof.quote_id, "approved")
    elif status == "rejected":
        name = target["name"] if target else "the requested stage"
        prof.pending_stage_id = prof.approval_request_id = None
        latest.approval_status = "rejected"
        db.add(ActivityLog(user_id=actor.id, module=MODULE, record_id=prof.quote_id, action="approval_rejected",
                           description=f"Approval to move to {name} rejected" + (f" – {remarks}" if remarks else ""), icon="⛔", color="#FEF2F2"))
        _notify(db, owner_of(latest), "Quote approval rejected", f"Moving quote {latest.quotation_number} to {name} was rejected" +
                (f": {remarks}" if remarks else "."), prof.quote_id, "rejected")


# ─── detail page ──────────────────────────────────────────────────────────────

def tenant_info(db: Session) -> dict[str, Optional[str]]:
    out: dict[str, Optional[str]] = {"name": None, "domain": None}
    try:
        from app.database import MasterSessionLocal
        from app.models.tenant import Tenant
        m = MasterSessionLocal()
        try:
            t = m.query(Tenant).filter(Tenant.slug == db.info.get("tenant_slug")).first()
            if t:
                out = {"name": t.name, "domain": t.subdomain}
        finally:
            m.close()
    except Exception:
        logger.debug("tenant lookup failed", exc_info=True)
    s = {r.key: r.value for r in db.query(Setting).filter(Setting.key.in_(["company_name", "theme_logo"])).all()}
    out["name"] = (s.get("company_name") or "").strip() or out["name"]
    out["logo"] = s.get("theme_logo") or None
    return out


def _d(v) -> Optional[str]:
    if not v:
        return None
    return (v.date() if isinstance(v, datetime) else v).isoformat()


def journey(db: Session, rows: list[Quotation], stage: dict, wo: Optional[WorkOrder], value: float) -> dict[str, Any]:
    """Prototype journeyHTML('quotes'): Lead · Deal · Quote · Work order."""
    latest, first = rows[-1], rows[0]
    lead_id = latest.lead_id
    tender = db.query(Tender).filter(Tender.id == latest.tender_id).first() if latest.tender_id else None
    if not lead_id and tender is not None:
        lead_id = tender.lead_id
    lead = db.query(Lead).filter(Lead.id == lead_id).first() if lead_id else None
    is_lead = bool(lead) and lead.lead_type != "direct_opportunity"
    is_opp = bool(lead) and (lead.lead_type == "direct_opportunity" or bool(lead.opportunity_ref_id))
    deal_stage = None
    if is_opp:                      # the deal's current stage in its pipeline (Pipelines & Stages), else its status
        deal_stage = db.execute(text("SELECT s.name FROM workflow_record_stages m JOIN workflow_stages s ON s.id = m.stage_id "
                                     "WHERE m.workflow LIKE 'deal%' AND m.record_id = :r LIMIT 1"), {"r": lead.id}).scalar()             or ("Won" if lead.status == "Converted" else lead.status)
    steps = [
        {"k": "lead", "label": "Lead", "ref": lead.lead_ref_id if is_lead else None, "stage": "Converted" if is_lead and lead.status in ("Converted", "Opportunity Created") else (lead.status if is_lead else None),
         "value": float(lead.est_value or 0) if is_lead else None, "date": _d(lead.created_at) if is_lead else None,
         "route": f"/leads?open={lead.id}" if is_lead else None, "note": "not started"},
        {"k": "deal", "label": "Deal", "ref": lead.opportunity_ref_id if is_opp else None, "stage": deal_stage,
         "value": float(lead.est_value or 0) if is_opp else None, "date": _d(lead.opportunity_created_at or lead.created_at) if is_opp else None,
         "route": f"/opportunities?open={lead.id}" if is_opp else None, "note": "not started"},
        {"k": "quote", "label": "Quote", "ref": latest.quotation_number, "stage": stage["name"], "value": value, "date": _d(first.created_at), "me": True, "route": None, "note": None},
        {"k": "order", "label": "Work order", "ref": wo.wo_number if wo else None, "stage": wo.status if wo else None,
         "value": float(wo.wo_value or wo.po_value or 0) if wo else None, "date": _d(wo.created_at) if wo else None,
         "route": "/workorders" if wo else None, "note": "not started"},
    ]
    if tender is not None:
        steps.insert(2, {"k": "tender", "label": "Tender / bid", "ref": tender.tender_num or f"TND-{tender.id}", "stage": tender.result or tender.tender_status,
                         "value": float(tender.est_value or 0) if getattr(tender, "est_value", None) is not None else None, "date": _d(tender.created_at),
                         "route": f"/tenders/{tender.id}", "note": None})
    for s in steps:
        s["done"] = bool(s["ref"])
    return {"id": f"J-{(lead.id if lead else root_id(rows)):04d}", "steps": steps}


def detail(db: Session, cu: User, rows: list[Quotation]) -> dict[str, Any]:
    st = stages(db)
    rid, latest = root_id(rows), rows[-1]
    profiles, cur_map = sync(db, {latest.quotation_number: rows}, st)
    prof, cur = profiles[rid], cur_map[rid]
    li = lines_by_row(db, [r.id for r in rows])
    who = names(db, [r.created_by for r in rows] + [owner_of(latest)])
    cn = customer_names(db, [latest])
    cfg = config(db)
    revs = []
    for i, r in enumerate(rows):
        L = li.get(r.id, [])
        t = totals(r, L)
        revs.append({
            "id": r.id, "n": i, "rev_no": r.revision_number, "date": _d(r.created_at), "by": who.get(r.created_by, ""), "by_id": r.created_by,
            "note": r.notes or "", "approval_status": r.approval_status or "none", "latest": i == len(rows) - 1, **t,
            "lines": [{"id": x.id, "description": x.description, "qty": float(x.quantity or 0), "rate": float(x.unit_price or 0),
                       "disc": float(getattr(x, "discount_percent", 0) or 0), "tax": float(x.tax_percent or 0), "amount": float(line_amount(x)),
                       "product_id": getattr(x, "product_id", None)} for x in L],
        })
    wo = work_order_for(db, prof, rows)
    pending = None
    if prof.pending_stage_id:
        ps = next((s for s in st if s["id"] == prof.pending_stage_id), None)
        pending = {"stage": ps["name"] if ps else None, "approval_request_id": prof.approval_request_id}
    history = [{"t": a.description, "by": n or "", "d": a.created_at.isoformat() if a.created_at else None}
               for a, n in db.query(ActivityLog, User.full_name).outerjoin(User, User.id == ActivityLog.user_id)
               .filter(ActivityLog.module == MODULE, ActivityLog.record_id == rid).order_by(ActivityLog.id.desc()).limit(200).all()]
    labels = {f.field_key: f.label for f in db.query(FormField).filter(FormField.module == MODULE).all()}
    custom = prof.custom_data if isinstance(prof.custom_data, dict) else {}
    ti = tenant_info(db)
    block = edit_block(db, rows, prof, cur)
    nxt = send_for_approval_target(st, cur)
    # prototype recHero('quotes'): Quote total · Revision · Valid till · Customer · Owner, stage progress of the lifecycle,
    # signals (customer health, validity ending ≤ 5 d, approval pending) and the customer's 360 link
    opens = [s for s in st if s["kind"] == "open"]
    oi = next((i for i, s in enumerate(opens) if s["id"] == cur["id"]), -1)
    valid_in = (latest.valid_until - today_ist()).days if latest.valid_until else None
    sig: list[dict[str, str]] = []
    if latest.customer_id:
        try:
            from app.services.customer360_service import account_metrics
            h = (account_metrics(db, {latest.customer_id}).get(latest.customer_id) or {}).get("health")
            if h is not None:
                sig.append({"t": "ba" if h < 55 else "wa" if h < 75 else "ok", "s": f"Customer health {h}"})
        except Exception:
            db.rollback()
            logger.warning("customer health for quote %s failed", rid, exc_info=True)
    if valid_in is not None and 0 <= valid_in <= 5:
        sig.append({"t": "wa", "s": "Validity ends soon"})
    if prof.pending_stage_id:
        sig.append({"t": "wa", "s": "1 approval pending"})
    flow = db.execute(text("SELECT template_name FROM workflow_definitions WHERE workflow = :w"), {"w": WORKFLOW}).scalar() or "Quote lifecycle"
    hero = {"total": revs[-1]["total"], "rev": len(rows) - 1, "versions": len(rows), "valid_till": latest.valid_until.isoformat() if latest.valid_until else None,
            "valid_in": valid_in, "customer": cn.get(latest.id, ""), "owner": (who.get(owner_of(latest), "") or "").split(" ")[0],
            "kind": cur["kind"], "pct": 100 if cur["kind"] != "open" else round((oi + 1) / (len(opens) + 1) * 100),
            "stage_no": oi + 1, "stages_of": len(opens), "flow": flow, "signals": sig}
    return {
        "id": rid, "ref": latest.quotation_number, "subject": latest.subject or "", "customer": cn.get(latest.id, ""), "customer_id": latest.customer_id,
        "company": (latest.company_name_override or "").strip() or ti["name"], "enquiry": prof.enquiry_ref or "", "valid_till": latest.valid_until.isoformat() if latest.valid_until else None,
        "owner": who.get(owner_of(latest), ""), "owner_id": owner_of(latest), "stage": cur, "stages": st, "pending": pending,
        "lost": {"reason": prof.lost_reason, "note": prof.lost_note} if cur["kind"] == "lost" else None,
        "revisions": revs, "editable": block is None, "edit_block": block,
        "terms": {"payment": prof.payment_terms or cfg["payment"], "delivery": prof.delivery_terms or cfg["delivery"], "warranty": prof.warranty_terms or cfg["warranty"],
                  "custom": {"payment": prof.payment_terms, "delivery": prof.delivery_terms, "warranty": prof.warranty_terms},
                  "defaults": {"payment": cfg["payment"], "delivery": cfg["delivery"], "warranty": cfg["warranty"]}},
        "config": {"gst_percent": cfg["gst_percent"], "max_discount": cfg["max_discount"]},
        "work_order": {"id": wo.id, "number": wo.wo_number, "status": wo.status} if wo else None,
        "can_send": cur["kind"] == "open" and not pending and nxt is not None and nxt["id"] != cur["id"]
                    and [s["id"] for s in st].index(nxt["id"]) > [s["id"] for s in st].index(cur["id"]),
        "send_target": nxt["name"] if nxt else None,
        "hero": hero, "journey": journey(db, rows, cur, wo, revs[-1]["total"]), "history": history,
        "custom": [[labels.get(k, k.replace("_", " ").capitalize()), v if not isinstance(v, (dict, list)) else json.dumps(v)] for k, v in custom.items()],
        "form": {"subject": latest.subject or "", "customer_id": latest.customer_id, "customer_name": cn.get(latest.id, ""), "enquiry": prof.enquiry_ref or "",
                 "valid_till": latest.valid_until.isoformat() if latest.valid_until else None, "owner_id": owner_of(latest),
                 "owner_name": who.get(owner_of(latest), ""), "custom_data": custom},
        "lead_id": latest.lead_id, "tender_id": latest.tender_id,
    }


# ─── PDF ──────────────────────────────────────────────────────────────────────

def pdf_data(db: Session, rows: list[Quotation], rev_id: Optional[int]) -> dict[str, Any]:
    """Prototype qprint(): everything the quotation preview / PDF shows, for the selected revision."""
    row = next((r for r in rows if r.id == rev_id), None) if rev_id else rows[-1]
    if row is None:
        raise HTTPException(404, "Revision not found")
    n = rows.index(row)
    rid = root_id(rows)
    prof = db.query(QuoteProfile).filter(QuoteProfile.quote_id == rid).first()
    L = lines_by_row(db, [row.id]).get(row.id, [])
    t = totals(row, L)
    by = db.query(User).filter(User.id == row.created_by).first() if row.created_by else None
    ti = tenant_info(db)
    cfg = config(db)
    rates = sorted({float(x.tax_percent or 0) for x in L})
    addr = None
    try:                                            # Settings → Company addresses (primary first)
        from app.routers.theme_router import _load_company_addresses
        lst = _load_company_addresses(db)
        p = next((x for x in lst if x.is_primary), lst[0] if lst else None)
        if p:
            addr = ", ".join(str(getattr(p, k)).strip() for k in ("street_address", "area_locality", "city_district", "state", "pincode", "country")
                             if (getattr(p, k, None) or "").strip())
    except Exception:
        db.rollback()
        addr = None
    return {
        "company": (row.company_name_override or "").strip() or ti["name"], "domain": ti["domain"], "logo": ti.get("logo"), "address": row.company_address_text or row.company_address_override or addr,
        "ref": row.quotation_number, "rev": n, "rev_id": row.id, "date": _d(row.created_at), "customer": customer_names(db, [row]).get(row.id, ""),
        "customer_address": row.customer_address_text or None, "subject": row.subject or "", "enquiry": (prof.enquiry_ref if prof else None) or "",
        "valid_till": row.valid_until.isoformat() if row.valid_until else None,
        "lines": [{"n": i + 1, "description": x.description, "qty": float(x.quantity or 0), "rate": float(x.unit_price or 0),
                   "disc": float(getattr(x, "discount_percent", 0) or 0), "tax": float(x.tax_percent or 0), "amount": float(line_amount(x))} for i, x in enumerate(L)],
        **t, "gst_label": f"GST {rates[0]:g}%" if len(rates) == 1 else "GST",
        "terms": {"payment": (prof.payment_terms if prof else None) or cfg["payment"], "delivery": (prof.delivery_terms if prof else None) or cfg["delivery"],
                  "warranty": (prof.warranty_terms if prof else None) or cfg["warranty"]},
        "sender": {"name": by.full_name if by else "", "designation": getattr(by, "designation", None) or "", "email": getattr(by, "email", None) or "",
                   "phone": getattr(by, "phone", None) or ""},
    }


def store_pdf(db: Session, cu: User, request: Request, rows: list[Quotation], rev_id: int, filename: str, contents: bytes) -> dict[str, Any]:
    """Generate PDF: the rendered file goes to the Document Hub, linked to the quote's revision row."""
    import os
    from app.models.all_models import DocumentManagementFile
    from app.routers.document_management_router import MEDIA_ROOT
    from app.utils.file_storage import media_slug_from_request, save_upload_optimized
    row = next((r for r in rows if r.id == rev_id), None)
    if row is None:
        raise HTTPException(404, "Revision not found")
    if not contents.startswith(b"%PDF"):
        raise HTTPException(422, "Upload a PDF file")
    if len(contents) > 15 * 1024 * 1024:
        raise HTTPException(413, "The PDF is too large")
    n = rows.index(row)
    saved = save_upload_optimized(root_dir=os.path.abspath(MEDIA_ROOT), subfolder="document-management", original_filename=filename, contents=contents,
                                  media_slug=media_slug_from_request(request), content_type="application/pdf", force_compression=False)
    label = f"{row.quotation_number} · Rev {n} – {row.subject or ''}"[:300]
    doc = DocumentManagementFile(name=f"{row.quotation_number}-Rev{n}.pdf", description=f"Quotation PDF – Rev {n}", file_url=saved.url,
                                 file_size_kb=saved.size_kb, uploaded_by=cu.id, linked_source="quotations", linked_record_id=row.id,
                                 linked_record_label=label, doc_type="Quotation PDF")
    db.add(doc)
    db.flush()
    _log(db, cu, request, root_id(rows), row.quotation_number, "pdf_generated", f"PDF generated for Rev {n} and attached to the Document Hub",
         new={"document_id": doc.id, "revision_row_id": row.id}, icon="📎")
    return {"id": doc.id, "name": doc.name, "url": doc.file_url}


def documents(db: Session, rows: list[Quotation]) -> list[dict[str, Any]]:
    from app.models.all_models import DocumentManagementFile
    ids = [r.id for r in rows]
    rev_of = {r.id: i for i, r in enumerate(rows)}
    who = {}
    docs = db.query(DocumentManagementFile).filter(DocumentManagementFile.linked_source == "quotations", DocumentManagementFile.linked_record_id.in_(ids),
                                                   DocumentManagementFile.deleted_at.is_(None)).order_by(DocumentManagementFile.id.desc()).all()
    who = names(db, [d.uploaded_by for d in docs])
    return [{"id": d.id, "name": d.name, "url": d.file_url, "type": d.doc_type, "rev": rev_of.get(d.linked_record_id), "size_kb": d.file_size_kb,
             "by": who.get(d.uploaded_by, ""), "at": d.created_at.isoformat() if d.created_at else None} for d in docs]


# ─── work order ───────────────────────────────────────────────────────────────

def create_work_order(db: Session, cu: User, request: Request, rows: list[Quotation]) -> WorkOrder:
    """Prototype quoteToWO(): Accepted quote → Orders & Projects, in one transaction; never twice."""
    st = stages(db)
    rid, latest = root_id(rows), rows[-1]
    db.execute(text("SELECT quote_id FROM quote_profiles WHERE quote_id = :q FOR UPDATE"), {"q": rid})
    profiles, cur_map = sync(db, {latest.quotation_number: rows}, st)
    prof, cur = profiles[rid], cur_map[rid]
    if cur["kind"] != "won":
        raise HTTPException(400, f"Only accepted quotes can become work orders (this one is {cur['name']})")
    existing = work_order_for(db, prof, rows)
    if existing:
        raise HTTPException(409, {"message": f"Work order {existing.wo_number} already exists for this quote", "work_order_id": existing.id})
    t = totals(latest, lines_by_row(db, [latest.id]).get(latest.id, []))
    cname = customer_names(db, [latest]).get(latest.id, "")
    from app.services.order_service import next_number   # Orders & Projects → Settings → Order number format
    terms = {"payment": prof.payment_terms or config(db)["payment"]}
    wo = WorkOrder(wo_number=next_number(db), customer_id=latest.customer_id, customer_name=cname or "—", lead_id=latest.lead_id, tender_id=latest.tender_id,
                   quotation_id=latest.id, project_title=(latest.subject or "")[:300], po_value=t["total"], wo_value=t["total"], status="Draft",
                   project_manager_id=owner_of(latest), payment_terms=terms["payment"], created_by=cu.id,
                   notes=f"Created from quote {latest.quotation_number} · Rev {len(rows) - 1}",
                   custom_data={"source": "quote", "quote_id": rid, "quotation_number": latest.quotation_number, "revision": len(rows) - 1,
                                "revision_row_id": latest.id})
    db.add(wo)
    db.flush()
    from app.models.all_models import WOLineItem
    for li in lines_by_row(db, [latest.id]).get(latest.id, []):
        a = line_amount(li)
        db.add(WOLineItem(wo_id=wo.id, product_id=getattr(li, "product_id", None), product_name=li.description[:300],
                          quantity=max(1, int(dec(li.quantity).to_integral_value(rounding=ROUND_HALF_UP))),
                          unit_price=q2(a / dec(li.quantity)) if dec(li.quantity) else li.unit_price, gst_percent=li.tax_percent,
                          total_amount=a + q2(a * dec(li.tax_percent) / 100)))
    prof.work_order_id = wo.id
    _log(db, cu, request, rid, latest.quotation_number, "convert", f"Work order {wo.wo_number} created from Rev {len(rows) - 1}",
         new={"work_order_id": wo.id, "wo_number": wo.wo_number, "value": t["total"]}, icon="🏗️")
    return wo


def duplicate(db: Session, cu: User, request: Request, rows: list[Quotation]) -> Quotation:
    """Prototype dupRec(): a new quote (new number, Rev 0, first stage) copied from this quote's latest revision –
    header, lines, enquiry reference, commercial terms and Form Builder values. Approvals, history and the work
    order are not copied."""
    from app.routers.quotation_router import _next_quotation_number
    st = stages(db)
    if not st:
        raise HTTPException(409, "No quote lifecycle is configured – set one up in Pipelines & Stages")
    src, src_rid = rows[-1], root_id(rows)
    sp = db.query(QuoteProfile).filter(QuoteProfile.quote_id == src_rid).first()
    copy_cols = ("lead_id", "tender_id", "customer_id", "subject", "valid_until", "terms_conditions", "ref_number", "customer_to_name",
                 "customer_address_text", "greeting_text", "signatory_user_id", "company_name_override", "company_address_override",
                 "company_address_id", "company_address_text", "amount", "tax_amount", "total_amount", "tenant_id")
    new = Quotation(quotation_number=_next_quotation_number(db), revision_number=1, status="Draft", approval_status="none", notes="Initial quotation",
                    created_by=cu.id, **{c: getattr(src, c, None) for c in copy_cols})
    db.add(new)
    db.flush()
    for li in db.query(QuotationLineItem).filter(QuotationLineItem.quotation_id == src.id).order_by(QuotationLineItem.sort_order, QuotationLineItem.id).all():
        db.add(QuotationLineItem(quotation_id=new.id, description=li.description, quantity=li.quantity, unit_price=li.unit_price, tax_percent=li.tax_percent,
                                 discount_percent=getattr(li, "discount_percent", 0) or 0, product_id=getattr(li, "product_id", None),
                                 net_price=li.net_price, gst_value=li.gst_value, line_total=li.line_total, sort_order=li.sort_order))
    db.flush()
    recompute(db, new)
    first = next(s for s in st if s["kind"] == "open")
    db.add(QuoteProfile(quote_id=new.id, quotation_number=new.quotation_number, enquiry_ref=sp.enquiry_ref if sp else None, stage_entered_at=now_ist(),
                        payment_terms=sp.payment_terms if sp else None, delivery_terms=sp.delivery_terms if sp else None,
                        warranty_terms=sp.warranty_terms if sp else None, custom_data=sp.custom_data if sp else None))
    db.execute(text("INSERT INTO workflow_record_stages (workflow, record_id, stage_id, mapped_at) VALUES (:w, :r, :s, :now)"),
               {"w": WORKFLOW, "r": new.id, "s": first["id"], "now": now_ist()})
    _log(db, cu, request, new.id, new.quotation_number, "create", f"Quote {new.quotation_number} duplicated from {src.quotation_number}",
         new={"duplicated_from": src.quotation_number, "source_revision_row_id": src.id}, icon="📋")
    return new


def delete_quote(db: Session, cu: User, request: Request, rows: list[Quotation]) -> None:
    from app.core.logging import model_snapshot
    st = stages(db)
    rid, latest = root_id(rows), rows[-1]
    profiles, cur_map = sync(db, {latest.quotation_number: rows}, st)
    prof, cur = profiles[rid], cur_map[rid]
    first = next(s for s in st if s["kind"] == "open")
    if cur["id"] != first["id"]:
        raise HTTPException(409, f"Only quotes in {first['name']} can be deleted")
    if prof.pending_stage_id or work_order_for(db, prof, rows):
        raise HTTPException(409, "This quote is waiting for approval or has a work order")
    snap = [model_snapshot(r) for r in rows]
    _log(db, cu, request, rid, latest.quotation_number, "delete", f"Quote {latest.quotation_number} deleted", old={"revisions": snap}, icon="🗑️")
    db.execute(text("DELETE FROM workflow_record_stages WHERE workflow = :w AND record_id = :r"), {"w": WORKFLOW, "r": rid})
    db.delete(prof)
    for r in rows:
        db.delete(r)
