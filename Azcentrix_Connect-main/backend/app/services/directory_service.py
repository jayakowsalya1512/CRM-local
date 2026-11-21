"""Partners & OEM / Competitive Intel (prototype v17 listPage('oem') / listPage('competitors') + record drawers).

Partners & OEM     one paginated SELECT over ``oems`` with a LEFT JOIN on products_master (category) and a grouped
                   sub-query for "tenders supported" (tender_products.oem_id).  View counts come from SUM(CASE) in the
                   same statement family – no per-row lookups.  Prototype columns the table lacked (authorisation valid
                   till, typical discount %, rating, status) are added once at startup.
Competitive Intel  competitors are few (a directory), so the active set is loaded in one query and the head-to-head
                   numbers (met in bids / they won / we won / price vs us / share) come from three grouped queries over
                   bid_competitor_prices, tender_loss_analysis and tender_tech_bid_bidders restricted to those
                   competitors; filtering, sorting and paging then happen in memory.  No query touches user input
                   outside bound parameters and whitelisted sort columns.
"""
from __future__ import annotations

import logging
import threading
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import and_, case, func, or_, text
from sqlalchemy.orm import Session

from app.core.timezone import today_ist
from app.models.all_models import OEM, ActivityLog, Competitor, ProductMaster, Tender, TenderLossAnalysis, TenderProduct, TenderTechBidBidder, User
from app.models.bids import BidCompetitorPrice

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()

OEM_VIEWS = ["All", "Auth expiring ≤ 60d"]
OEM_STATUSES = ["Active", "On hold", "Inactive"]
OEM_SORT = {"name": OEM.name, "category": ProductMaster.category, "contact": OEM.contact_name, "auth": OEM.auth_valid_till, "discount": OEM.discount_pct,
            "rating": OEM.rating, "status": OEM.status}
COMP_VIEWS = ["All", "Underbid us"]
COMP_SORT = {"name", "hq", "met", "won", "lost", "wr", "delta", "share", "strength", "weak"}
OPS = {"contains", "ncontains", "eq", "ne", "starts", "gt", "lt", "gte", "lte", "empty", "nempty"}

OEM_DDL = [
    "ALTER TABLE oems ADD COLUMN IF NOT EXISTS auth_valid_till DATE NULL",
    "ALTER TABLE oems ADD COLUMN IF NOT EXISTS discount_pct DECIMAL(5,2) NULL",
    "ALTER TABLE oems ADD COLUMN IF NOT EXISTS rating TINYINT NULL",
    "ALTER TABLE oems ADD COLUMN IF NOT EXISTS status VARCHAR(20) NULL",
    "CREATE INDEX IF NOT EXISTS ix_oems_deleted_name ON oems (is_deleted, name)",          # list / search
    "CREATE INDEX IF NOT EXISTS ix_oems_auth_valid ON oems (auth_valid_till)",             # "Auth expiring" view
    "CREATE INDEX IF NOT EXISTS ix_tender_products_oem ON tender_products (oem_id, tender_id)",   # tenders supported
    "CREATE INDEX IF NOT EXISTS ix_competitors_active_name ON competitors (is_active, name)",
    "CREATE INDEX IF NOT EXISTS ix_tender_loss_l1 ON tender_loss_analysis (l1_company)",
    "CREATE INDEX IF NOT EXISTS ix_tender_loss_comp ON tender_loss_analysis (competitor_name)",
    "CREATE INDEX IF NOT EXISTS ix_tender_bidders_name ON tender_tech_bid_bidders (bidder_name)",
    "CREATE INDEX IF NOT EXISTS ix_activity_logs_record ON activity_logs (module, record_id, created_at)",
]


# ─── schema ───────────────────────────────────────────────────────────────────

def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        for ddl in OEM_DDL:
            try:
                db.execute(text(ddl))
            except Exception as exc:  # older MariaDB without IF NOT EXISTS on indexes – the index already exists
                logger.debug("directory ddl skipped: %s (%s)", ddl[:60], exc)
                db.rollback()
        db.commit()
        _READY.add(slug)


def ensure_schema_all_tenants() -> None:
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant
    master = MasterSessionLocal()
    try:
        slugs = [t.slug for t in master.query(Tenant.slug).all()]
    except Exception as exc:  # pragma: no cover
        logger.warning("Directory schema sync: unable to list tenants: %s", exc)
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
            logger.warning("Directory schema sync failed for %s: %s", slug, exc)


# ─── helpers ──────────────────────────────────────────────────────────────────

def _like(s: str) -> str:
    return "%" + s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _cond(col, op: str, v: str):
    if op not in OPS:
        return None
    if op == "empty":
        return or_(col.is_(None), col == "")
    if op == "nempty":
        return and_(col.isnot(None), col != "")
    if op in ("gt", "lt", "gte", "lte"):
        try:
            n = float(v)
        except (TypeError, ValueError):
            return None
        return {"gt": col > n, "lt": col < n, "gte": col >= n, "lte": col <= n}[op]
    s = str(v or "")
    if op == "contains":
        return col.ilike(_like(s))
    if op == "ncontains":
        return ~col.ilike(_like(s))
    if op == "starts":
        return col.ilike(s.replace("%", "\\%") + "%")
    if op == "eq":
        return func.lower(col) == s.lower()
    return func.lower(col) != s.lower()


def _d(v) -> Optional[str]:
    return v.isoformat() if v else None


def _num(v) -> Optional[float]:
    return float(v) if isinstance(v, (int, float, Decimal)) else None


def _py_cond(val, op: str, v: str) -> bool:
    if op not in OPS:
        return True
    s = "" if val is None else str(val)
    if op == "empty":
        return s == ""
    if op == "nempty":
        return s != ""
    if op in ("gt", "lt", "gte", "lte"):
        try:
            a, b = float(val), float(v)
        except (TypeError, ValueError):
            return False
        return {"gt": a > b, "lt": a < b, "gte": a >= b, "lte": a <= b}[op]
    t = str(v or "").lower()
    if op == "contains":
        return t in s.lower()
    if op == "ncontains":
        return t not in s.lower()
    if op == "starts":
        return s.lower().startswith(t)
    if op == "eq":
        return s.lower() == t
    return s.lower() != t


def activity(db: Session, module_keys: tuple[str, ...], record_id: int) -> list[dict]:
    rows = db.query(ActivityLog, User.full_name).outerjoin(User, User.id == ActivityLog.user_id) \
        .filter(ActivityLog.module.in_(module_keys), ActivityLog.record_id == record_id).order_by(ActivityLog.created_at.desc()).limit(50).all()
    return [{"t": a.description, "by": n or "System", "d": _d(a.created_at)} for a, n in rows]


# ═══════════════════════════════ Partners & OEM ═══════════════════════════════

def oem_meta(db: Session, company: str) -> dict:
    cats = [c for (c,) in db.query(ProductMaster.category).filter(ProductMaster.is_active.is_(True), ProductMaster.category.isnot(None))
            .distinct().order_by(ProductMaster.category).all() if c]
    return {"company": company, "views": OEM_VIEWS, "categories": cats, "statuses": OEM_STATUSES}


def _oem_tenders_sq(db: Session):
    return db.query(TenderProduct.oem_id.label("oem_id"), func.count(func.distinct(TenderProduct.tender_id)).label("n")) \
        .filter(TenderProduct.oem_id.isnot(None)).group_by(TenderProduct.oem_id).subquery()


def _oem_row(o: OEM, cat: Optional[str], n: int, today: date) -> dict:
    return {"id": o.id, "name": o.name, "type": o.type or "OEM", "category": cat or "", "contact": o.contact_name or "", "contact_email": o.contact_email or "",
            "contact_phone": o.contact_phone or "", "auth": _d(o.auth_valid_till), "auth_number": o.auth_number or "", "discount": _num(o.discount_pct),
            "rating": int(o.rating) if o.rating is not None else 4, "tenders": int(n or 0), "status": o.status or "Active", "account_manager": o.account_manager or "",
            "payment_terms": o.payment_terms or "", "support_sla": o.support_sla or "", "credit_limit": o.credit_limit or "", "notes": o.notes or "",
            "created": _d(o.created_at), "auth_state": ("Renewal due" if o.auth_valid_till and (o.auth_valid_till - today).days < 60 else "Valid") if o.auth_valid_till else "Not recorded"}


def oem_list(db: Session, *, view: str, category: str, q: str, f: dict, adv: dict, sorts: list, offset: int, limit: int) -> dict:
    today = today_ist()
    soon = today + timedelta(days=60)
    sq = _oem_tenders_sq(db)
    base = db.query(OEM, ProductMaster.category, func.coalesce(sq.c.n, 0)).outerjoin(ProductMaster, ProductMaster.id == OEM.product_id) \
        .outerjoin(sq, sq.c.oem_id == OEM.id).filter(OEM.is_deleted.is_(False))
    expiring = and_(OEM.auth_valid_till.isnot(None), OEM.auth_valid_till <= soon)
    counts_q = db.query(func.count(OEM.id), func.sum(case((expiring, 1), else_=0))).filter(OEM.is_deleted.is_(False))
    total_all, n_exp = counts_q.first() or (0, 0)
    if view == "Auth expiring ≤ 60d":
        base = base.filter(expiring)
    if category:
        base = base.filter(ProductMaster.category == category)
    if q:
        base = base.filter(or_(OEM.name.ilike(_like(q)), OEM.contact_name.ilike(_like(q)), OEM.contact_email.ilike(_like(q))))
    cols = {**OEM_SORT, "tenders": sq.c.n}
    for k, v in (f or {}).items():
        v = str(v).strip()[:120]
        if k not in cols or not v:
            continue
        if k in ("tenders", "discount", "rating"):
            try:
                base = base.filter(cols[k] == float(v.rstrip("%")))
            except ValueError:
                base = base.filter(text("1 = 0"))
        else:
            base = base.filter(cols[k].ilike(_like(v)))
    conds = []
    for c in (adv or {}).get("conds") or []:
        col = cols.get(str(c.get("k")))
        if col is None:
            continue
        expr = _cond(col, str(c.get("op") or "contains"), str(c.get("v") or "")[:120])
        if expr is not None:
            conds.append(expr)
    if conds:
        base = base.filter(or_(*conds) if (adv or {}).get("logic") == "OR" else and_(*conds))
    total = base.with_entities(func.count(OEM.id)).order_by(None).scalar() or 0
    order = []
    for s in sorts or []:
        if isinstance(s, (list, tuple)) and len(s) == 2 and s[0] in cols:
            order.append(cols[s[0]].desc() if int(s[1]) < 0 else cols[s[0]].asc())
    rows = base.order_by(*(order or [OEM.name.asc()])).offset(max(0, offset)).limit(max(1, min(limit, 250))).all()
    return {"items": [_oem_row(o, c, n, today) for o, c, n in rows], "total": int(total), "total_all": int(total_all or 0),
            "counts": {"All": int(total_all or 0), "Auth expiring ≤ 60d": int(n_exp or 0)}}


def _oem(db: Session, oem_id: int) -> OEM:
    o = db.query(OEM).filter(OEM.id == oem_id, OEM.is_deleted.is_(False)).first()
    if o is None:
        raise HTTPException(404, "Partner not found")
    return o


def oem_detail(db: Session, oem_id: int) -> dict:
    today = today_ist()
    sq = _oem_tenders_sq(db)
    row = db.query(OEM, ProductMaster.category, func.coalesce(sq.c.n, 0)).outerjoin(ProductMaster, ProductMaster.id == OEM.product_id) \
        .outerjoin(sq, sq.c.oem_id == OEM.id).filter(OEM.id == oem_id, OEM.is_deleted.is_(False)).first()
    if row is None:
        raise HTTPException(404, "Partner not found")
    o, cat, n = row
    out = _oem_row(o, cat, n, today)
    # tenders this OEM supports (final BoQ rows) – one query, newest first
    tl = db.query(Tender.id, Tender.tender_title, Tender.tender_status, Tender.result, Tender.est_value) \
        .join(TenderProduct, TenderProduct.tender_id == Tender.id).filter(TenderProduct.oem_id == oem_id).distinct().order_by(Tender.id.desc()).limit(25).all()
    out["tender_list"] = [{"id": t[0], "title": t[1] or f"Tender #{t[0]}", "stage": t[3] if t[3] in ("Won", "Lost") else (t[2] or "Open"), "value": _num(t[4])} for t in tl]
    out["activity"] = activity(db, ("oems", "oem", "OEM"), oem_id)
    return out


def _product_for_category(db: Session, category: str) -> Optional[int]:
    if not category:
        return None
    row = db.query(ProductMaster.id).filter(ProductMaster.category == category, ProductMaster.is_active.is_(True)).order_by(ProductMaster.id).first()
    if row is None:
        raise HTTPException(422, "Unknown category – add it under Masters → Products first")
    return int(row[0])


def _oem_validate(d: dict) -> dict:
    name = str(d.get("name") or "").strip()[:200]
    if not name:
        raise HTTPException(422, "OEM name is required")
    disc = d.get("discount")
    if disc not in (None, ""):
        try:
            disc = float(disc)
        except (TypeError, ValueError):
            raise HTTPException(422, "Typical discount must be a number")
        if not 0 <= disc <= 100:
            raise HTTPException(422, "Typical discount must be between 0 and 100")
    else:
        disc = None
    rating = d.get("rating")
    if rating not in (None, ""):
        try:
            rating = int(rating)
        except (TypeError, ValueError):
            raise HTTPException(422, "Rating must be 1–5")
        if not 1 <= rating <= 5:
            raise HTTPException(422, "Rating must be 1–5")
    else:
        rating = None
    status = d.get("status")
    if status not in (None, "") and status not in OEM_STATUSES:
        raise HTTPException(422, "Unknown status")
    auth = d.get("auth")
    if auth not in (None, ""):
        try:
            auth = date.fromisoformat(str(auth)[:10])
        except ValueError:
            raise HTTPException(422, "Authorisation valid till must be a date")
    else:
        auth = None
    return {"name": name, "contact_name": str(d.get("contact") or "").strip()[:100] or None, "auth_valid_till": auth, "discount_pct": disc, "rating": rating,
            "status": status or None, "category": str(d.get("category") or "").strip()[:100]}


def oem_create(db: Session, cu: User, d: dict) -> int:
    from app.routers.oem_router import _check_duplicate
    v = _oem_validate(d)
    _check_duplicate(db, v["name"])
    o = OEM(name=v["name"], type="OEM", product_id=_product_for_category(db, v["category"]), contact_name=v["contact_name"], auth_valid_till=v["auth_valid_till"],
            discount_pct=v["discount_pct"], rating=v["rating"] or 4, status=v["status"] or "Active", created_by=cu.id, is_active=True, is_deleted=False)
    db.add(o)
    db.commit()
    return o.id


def oem_update(db: Session, cu: User, oem_id: int, d: dict) -> None:
    from app.routers.oem_router import _check_duplicate
    o = _oem(db, oem_id)
    patch = {k: d[k] for k in ("name", "contact", "auth", "discount", "rating", "status", "category", "notes") if k in d}
    if not patch:
        return
    full = {"name": o.name, "contact": o.contact_name, "auth": _d(o.auth_valid_till), "discount": _num(o.discount_pct), "rating": o.rating, "status": o.status, "category": "", **patch}
    v = _oem_validate(full)
    if "name" in patch and v["name"].lower() != (o.name or "").lower():
        _check_duplicate(db, v["name"], exclude_id=oem_id)
    o.name = v["name"]
    if "contact" in patch:
        o.contact_name = v["contact_name"]
    if "auth" in patch:
        o.auth_valid_till = v["auth_valid_till"]
    if "discount" in patch:
        o.discount_pct = v["discount_pct"]
    if "rating" in patch and v["rating"]:
        o.rating = v["rating"]
    if "status" in patch and v["status"]:
        o.status = v["status"]
    if "category" in patch and v["category"]:
        o.product_id = _product_for_category(db, v["category"])
    if "notes" in patch:
        o.notes = str(patch["notes"] or "")[:5000] or None
    db.commit()


def oem_delete(db: Session, ids: list[int]) -> int:
    n = db.query(OEM).filter(OEM.id.in_(ids), OEM.is_deleted.is_(False)).update({OEM.is_deleted: True}, synchronize_session=False)
    db.commit()
    return int(n)


# ═══════════════════════════════ Competitive Intel ════════════════════════════

def comp_meta(company: str) -> dict:
    return {"company": company, "views": COMP_VIEWS}


def _stats(db: Session, comps: list[Competitor]) -> dict[int, dict]:
    """Head-to-head numbers for the given competitors from three grouped queries (no per-competitor queries)."""
    by_name = {c.name.strip().lower(): c.id for c in comps if c.name}
    ids = [c.id for c in comps]
    met: dict[int, set[int]] = defaultdict(set)
    they: dict[int, set[int]] = defaultdict(set)
    deltas: dict[int, list[float]] = defaultdict(list)
    results: dict[int, Optional[str]] = {}
    if not ids:
        return {}
    # 1) commercial bid prices recorded against competitors (competitor_id)
    for cid, tid, res in db.query(BidCompetitorPrice.competitor_id, BidCompetitorPrice.tender_id, Tender.result) \
            .join(Tender, Tender.id == BidCompetitorPrice.tender_id).filter(BidCompetitorPrice.competitor_id.in_(ids)).all():
        met[cid].add(tid)
        results[tid] = res
    # 2) loss analysis: L1 / L2 / L3 and the named competitor (by name)
    names = list(by_name.keys())
    la = db.query(TenderLossAnalysis.tender_id, Tender.result, TenderLossAnalysis.l1_company, TenderLossAnalysis.l2_company, TenderLossAnalysis.l3_company,
                  TenderLossAnalysis.competitor_name, TenderLossAnalysis.competitor_amount, TenderLossAnalysis.our_bid_amount) \
        .join(Tender, Tender.id == TenderLossAnalysis.tender_id) \
        .filter(or_(func.lower(TenderLossAnalysis.l1_company).in_(names), func.lower(TenderLossAnalysis.l2_company).in_(names),
                    func.lower(TenderLossAnalysis.l3_company).in_(names), func.lower(TenderLossAnalysis.competitor_name).in_(names))).all()
    for tid, res, l1, l2, l3, cname, camt, oamt in la:
        results[tid] = res
        for nm in (l1, l2, l3, cname):
            cid = by_name.get((nm or "").strip().lower())
            if cid:
                met[cid].add(tid)
        cid1 = by_name.get((l1 or "").strip().lower())
        if cid1 and res == "Lost":
            they[cid1].add(tid)
        cidc = by_name.get((cname or "").strip().lower())
        if cidc and camt and oamt and float(oamt) > 0:
            deltas[cidc].append((float(camt) - float(oamt)) / float(oamt) * 100)
    # 3) technical-bid bidder lists (by name)
    for tid, res, bname in db.query(TenderTechBidBidder.tender_id, Tender.result, TenderTechBidBidder.bidder_name) \
            .join(Tender, Tender.id == TenderTechBidBidder.tender_id).filter(func.lower(TenderTechBidBidder.bidder_name).in_(names)).all():
        cid = by_name.get((bname or "").strip().lower())
        if cid:
            met[cid].add(tid)
            results[tid] = res
    decided = db.query(func.count(Tender.id)).filter(Tender.result.in_(("Won", "Lost"))).scalar() or 0
    out = {}
    for c in comps:
        m = met.get(c.id, set())
        w = they.get(c.id, set())
        we = {t for t in m if results.get(t) == "Won"}
        dl = deltas.get(c.id) or []
        out[c.id] = {"met": len(m), "won": len(w), "lost": len(we), "delta": round(sum(dl) / len(dl), 1) if dl else 0.0,
                     "share": round(len(w) / decided * 100, 1) if decided else 0.0, "wr": round(len(w) / len(m) * 100) if m else 0}
    return out


def _comp_row(c: Competitor, s: dict) -> dict:
    return {"id": c.id, "name": c.name, "hq": c.city or c.state or "", "strength": c.strengths or "", "weak": c.weaknesses or "", "threat": c.threat_level or "",
            "website": c.website or "", "oem": c.oem_partnerships or "", "regions": c.strong_regions or "", "notes": c.internal_notes or "", "created": _d(c.created_at), **s}


def comp_list(db: Session, *, view: str, q: str, f: dict, adv: dict, sorts: list, offset: int, limit: int) -> dict:
    comps = db.query(Competitor).filter(Competitor.is_active.is_(True)).order_by(Competitor.name).limit(2000).all()
    stats = _stats(db, comps)
    rows = [_comp_row(c, stats.get(c.id, {"met": 0, "won": 0, "lost": 0, "delta": 0.0, "share": 0.0, "wr": 0})) for c in comps]
    total_all = len(rows)
    counts = {"All": total_all, "Underbid us": sum(1 for r in rows if r["delta"] < 0)}
    if view == "Underbid us":
        rows = [r for r in rows if r["delta"] < 0]
    if q:
        ql = q.lower()
        rows = [r for r in rows if ql in r["name"].lower() or ql in r["hq"].lower() or ql in r["strength"].lower() or ql in r["weak"].lower()]
    for k, v in (f or {}).items():
        if k in COMP_SORT and str(v).strip():
            rows = [r for r in rows if str(v).strip().lower() in str(r.get(k, "")).lower()]
    conds = [(c.get("k"), str(c.get("op") or "contains"), str(c.get("v") or "")) for c in (adv or {}).get("conds") or [] if c.get("k") in COMP_SORT]
    if conds:
        if (adv or {}).get("logic") == "OR":
            rows = [r for r in rows if any(_py_cond(r.get(k), op, v) for k, op, v in conds)]
        else:
            rows = [r for r in rows if all(_py_cond(r.get(k), op, v) for k, op, v in conds)]
    for s in reversed(sorts or []):
        if isinstance(s, (list, tuple)) and len(s) == 2 and s[0] in COMP_SORT:
            k = s[0]
            rows.sort(key=lambda r: (r.get(k) is None, r.get(k) if isinstance(r.get(k), (int, float)) else str(r.get(k) or "").lower()), reverse=int(s[1]) < 0)
    total = len(rows)
    page = rows[max(0, offset): max(0, offset) + max(1, min(limit, 250))]
    return {"items": page, "total": total, "total_all": total_all, "counts": counts}


def _comp(db: Session, cid: int) -> Competitor:
    c = db.query(Competitor).filter(Competitor.id == cid, Competitor.is_active.is_(True)).first()
    if c is None:
        raise HTTPException(404, "Competitor not found")
    return c


def comp_detail(db: Session, cid: int) -> dict:
    c = _comp(db, cid)
    s = _stats(db, [c]).get(cid, {"met": 0, "won": 0, "lost": 0, "delta": 0.0, "share": 0.0, "wr": 0})
    out = _comp_row(c, s)
    # recent encounters (loss analysis rows naming this competitor) – one query
    nm = (c.name or "").strip().lower()
    enc = db.query(Tender.id, Tender.tender_title, Tender.result, TenderLossAnalysis.l1_company, TenderLossAnalysis.our_bid_amount, TenderLossAnalysis.competitor_amount) \
        .join(TenderLossAnalysis, TenderLossAnalysis.tender_id == Tender.id) \
        .filter(or_(func.lower(TenderLossAnalysis.l1_company) == nm, func.lower(TenderLossAnalysis.l2_company) == nm, func.lower(TenderLossAnalysis.l3_company) == nm,
                    func.lower(TenderLossAnalysis.competitor_name) == nm)).order_by(Tender.id.desc()).limit(25).all()
    out["encounters"] = [{"id": t[0], "title": t[1] or f"Tender #{t[0]}", "result": t[2], "l1": t[3] or "", "ours": _num(t[4]), "theirs": _num(t[5])} for t in enc]
    out["activity"] = activity(db, ("competitors", "competitor"), cid)
    return out


def _comp_validate(d: dict) -> dict:
    name = str(d.get("name") or "").strip()[:200]
    if not name:
        raise HTTPException(422, "Competitor name is required")
    return {"name": name, "city": str(d.get("hq") or "").strip()[:100] or None, "strengths": str(d.get("strength") or "").strip()[:2000] or None,
            "weaknesses": str(d.get("weak") or "").strip()[:2000] or None}


def comp_create(db: Session, d: dict) -> int:
    v = _comp_validate(d)
    existing = db.query(Competitor).filter(func.lower(Competitor.name) == v["name"].lower()).first()
    if existing is not None:
        if existing.is_active:
            raise HTTPException(409, "Competitor already exists")
        existing.is_active, existing.city, existing.strengths, existing.weaknesses = True, v["city"], v["strengths"], v["weaknesses"]
        db.commit()
        return existing.id
    c = Competitor(name=v["name"], city=v["city"], strengths=v["strengths"], weaknesses=v["weaknesses"], is_active=True)
    db.add(c)
    db.commit()
    return c.id


def comp_update(db: Session, cid: int, d: dict) -> None:
    c = _comp(db, cid)
    full = {"name": c.name, "hq": c.city, "strength": c.strengths, "weak": c.weaknesses, **{k: d[k] for k in ("name", "hq", "strength", "weak") if k in d}}
    v = _comp_validate(full)
    if v["name"].lower() != (c.name or "").lower() and db.query(Competitor.id).filter(func.lower(Competitor.name) == v["name"].lower(), Competitor.id != cid).first():
        raise HTTPException(409, "Competitor already exists")
    c.name, c.city, c.strengths, c.weaknesses = v["name"], v["city"], v["strengths"], v["weaknesses"]
    if "notes" in d:
        c.internal_notes = str(d.get("notes") or "")[:5000] or None
    db.commit()


def comp_delete(db: Session, ids: list[int]) -> int:
    n = db.query(Competitor).filter(Competitor.id.in_(ids), Competitor.is_active.is_(True)).update({Competitor.is_active: False}, synchronize_session=False)
    db.commit()
    return int(n)
