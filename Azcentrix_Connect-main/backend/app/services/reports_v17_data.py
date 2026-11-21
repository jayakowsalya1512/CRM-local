"""Reports (prototype v17) – the 21 ready-made report definitions (REPD in the prototype), each with its own KPI cards,
charts and table columns, computed from the tenant's real records.

Every report reads its rows through the owning module's service (lead360 / deal / bid / instrument / order / customer360 /
field-sales / travel / approvals …), so each module's own permission and data-visibility rules decide which records a user
can see; a report never widens what the user could already open in that module. Money is summed as Decimal and converted to
float only for the response. Each definition states the date its reporting period applies to (``basis``).

Output of a report function:
  k    – KPI cards [{l, v, f (inr|int|pct|text|num|days), dc}]
  c    – charts    [{t, type (hbars|bars|donut|funnel|line), d [{l, v}], f (inr|pct|int|pts), lw, vw, h}]
  cols – columns   [{k, t, f (id|inr|pill|user|date|d|bar|pct|int|journey|text), w, r, sum}]
  rows – table rows
"""
from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Callable, Iterable, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.timezone import today_ist
from app.dependencies import user_has_permission
from app.models.all_models import Lead, Tender, User

logger = logging.getLogger(__name__)


@dataclass
class Ctx:
    db: Session
    cu: User
    start: date
    end: date
    label: str
    fy: dict
    today: date = field(default_factory=today_ist)
    cache: dict = field(default_factory=dict)

    def inp(self, d: Any) -> bool:
        d = _day(d)
        return d is not None and self.start <= d <= self.end

    def memo(self, key: str, fn: Callable[[], Any]) -> Any:
        if key not in self.cache:
            self.cache[key] = fn()
        return self.cache[key]


def _day(v: Any) -> Optional[date]:
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def D(v: Any) -> Decimal:
    try:
        return Decimal(str(v or 0))
    except Exception:
        return Decimal(0)


def S0(rows: Iterable, fn: Callable[[Any], Any]) -> float:
    return float(sum((D(fn(r)) for r in rows), Decimal(0)))


def pct(a: float, b: float) -> int:
    return round(a / b * 100) if b else 0


def grp(rows: Iterable, key: Callable, val: Optional[Callable] = None) -> list[dict]:
    """prototype grp(): [{l, n, v}] in first-seen order."""
    out: dict[str, dict] = {}
    for r in rows:
        k = key(r)
        k = "—" if k in (None, "") else str(k)
        g = out.setdefault(k, {"l": k, "n": 0, "v": Decimal(0)})
        g["n"] += 1
        if val:
            g["v"] += D(val(r))
    return [{"l": g["l"], "n": g["n"], "v": float(g["v"])} for g in out.values()]


def K(l: str, v: Any, f: str = "int", dc: Optional[str] = None) -> dict:
    return {"l": l, "v": v, "f": f, **({"dc": dc} if dc else {})}


def CH(t: str, type_: str, d: list[dict], f: str = "int", **o: Any) -> dict:
    return {"t": t, "type": type_, "d": d, "f": f, **o}


def C(k: str, t: str, f: str = "text", **o: Any) -> dict:
    return {"k": k, "t": t, "f": f, **o}


def INR(k: str, t: str, **o: Any) -> dict:
    return C(k, t, "inr", r=True, money=True, sum=True, **o)


# ─── shared, memoised sources (module services decide visibility) ───────────────

def leads(x: Ctx) -> list[dict]:
    def load():
        from app.services import lead360_service as L
        rows = L.list_rows(x.db, x.cu) if user_has_permission(x.db, x.cu, "leads.view") else []
        dates = _dates(x.db, Lead, [r["id"] for r in rows], (Lead.lead_created_at, Lead.created_at))
        for r in rows:
            r["created"] = dates.get(r["id"])
        return rows
    return x.memo("leads", load)


def deals(x: Ctx) -> list[dict]:
    def load():
        from app.models.deals import DealProfile
        from app.services import deal_service as DS
        rows, pipes = DS.list_rows(x.db, x.cu) if user_has_permission(x.db, x.cu, "opportunities.view") else ([], [])
        ids = [r["id"] for r in rows]
        meta = {l.id: l for l in x.db.query(Lead.id, Lead.opportunity_created_at, Lead.created_at, Lead.converted_at, Lead.lost_at,
                                            Lead.updated_at, Lead.converted_tender_id).filter(Lead.id.in_(ids or [-1])).all()}
        prof = {p.lead_id: p for p in x.db.query(DealProfile.lead_id, DealProfile.lost_reason, DealProfile.stage_entered_at).filter(
            DealProfile.lead_id.in_(ids or [-1])).all()}
        comp = _deal_competitors(x.db, meta)
        for r in rows:
            m, p = meta.get(r["id"]), prof.get(r["id"])
            r["created"] = _day(m.opportunity_created_at or m.created_at) if m else None
            r["lead_created"] = _day(m.created_at) if m else None
            r["stage_since"] = p.stage_entered_at if p else None       # current stage entered (deal stage history)
            closed = None
            if r["stage_kind"] == "won":
                closed = (m and (m.converted_at)) or (p and p.stage_entered_at) or (m and m.updated_at)
            elif r["stage_kind"] == "lost":
                closed = (m and m.lost_at) or (p and p.stage_entered_at) or (m and m.updated_at)
            r["closed"] = _day(closed)
            r["lostReason"] = (p.lost_reason if p else None) or ("—" if r["stage_kind"] == "lost" else "")
            r["comp"] = comp.get(r["id"], "—")
        x.cache["pipes"] = pipes
        return rows
    return x.memo("deals", load)


def bids(x: Ctx) -> list[dict]:
    def load():
        from app.services import bid_service as BS
        rows, _ = BS.list_rows(x.db, x.cu) if user_has_permission(x.db, x.cu, "tenders.view") else ([], [])
        ids = [r["id"] for r in rows]
        meta = {t.id: t for t in x.db.query(Tender.id, Tender.published_date, Tender.created_at, Tender.result_date, Tender.submission_date).filter(
            Tender.id.in_(ids or [-1])).all()}
        oem = _tender_oems(x.db, ids)
        for r in rows:
            m = meta.get(r["id"])
            r["published"] = (_day(m.published_date) or _day(m.created_at)) if m else None
            r["decided"] = (_day(m.result_date) or _day(m.submission_date)) if m else None
            r["oem"] = oem.get(r["id"], "—")
        return rows
    return x.memo("bids", load)


def instruments(x: Ctx) -> list[dict]:
    def load():
        from app.services import instrument_service as IS
        return IS.list_rows(x.db, x.cu) if user_has_permission(x.db, x.cu, "emdbg.view") else []
    return x.memo("emd", load)


def orders(x: Ctx) -> list[dict]:
    def load():
        from app.services import order_service as OS
        if not user_has_permission(x.db, x.cu, "workorders.view"):
            return []
        rows, _ = OS.list_rows(x.db, x.cu)
        return rows
    return x.memo("orders", load)


def customers(x: Ctx) -> list[dict]:
    """Customer 360 rows (customer data visibility) + account metrics; revenue = order value dated in the period."""
    def load():
        if not user_has_permission(x.db, x.cu, "customers.view"):
            return []
        from app.routers.customer360_router import _rows
        from app.services import customer360_service as S
        rows = _rows(x.db, x.cu)
        ids = {r["id"] for r in rows}
        M = S.account_metrics(x.db, ids)
        rev: dict[int, Decimal] = defaultdict(Decimal)
        for o in S.order_rows(x.db, ids):
            if x.inp(o["date"]):
                rev[o["customer_id"]] += D(o["value"])
        for r in rows:
            m = S.metrics_for(M, r["id"])
            r.update(revenue=float(rev.get(r["id"], 0)), pipe=round(m["open_pipe"], 2), orders=m["orders"], out=round(m["outstanding"], 2),
                     wr=m["win_rate"], touch=(x.today - m["last_touch"]).days if m["last_touch"] else None)
        return rows
    return x.memo("customers", load)


def _dates(db: Session, model, ids: list[int], cols: tuple) -> dict[int, Optional[date]]:
    if not ids:
        return {}
    out = {}
    for row in db.query(model.id, *cols).filter(model.id.in_(ids)).all():
        out[row[0]] = next((_day(v) for v in row[1:] if v), None)
    return out


def _deal_competitors(db: Session, meta: dict) -> dict[int, str]:
    """Competitor of a deal = the winning / L1 bidder recorded on its tender's loss analysis or result."""
    try:
        from app.models.all_models import TenderLossAnalysis
        t_of: dict[int, int] = {}
        for t in db.query(Tender.id, Tender.lead_id).filter(Tender.lead_id.in_(list(meta) or [-1]), Tender.is_deleted == False).all():
            t_of.setdefault(t.lead_id, t.id)
        for lid, m in meta.items():
            if m.converted_tender_id:
                t_of.setdefault(lid, m.converted_tender_id)
        if not t_of:
            return {}
        la = {r.tender_id: (r.l1_company or r.competitor_name) for r in db.query(TenderLossAnalysis.tender_id, TenderLossAnalysis.l1_company,
                                                                                  TenderLossAnalysis.competitor_name).filter(
            TenderLossAnalysis.tender_id.in_(list(t_of.values()))).all()}
        return {lid: la[tid] for lid, tid in t_of.items() if la.get(tid)}
    except Exception as exc:
        db.rollback()
        logger.info("deal competitors unavailable: %s", exc)
        return {}


def _tender_oems(db: Session, ids: list[int]) -> dict[int, str]:
    """Principal OEM of a bid: the preferred (else first) OEM on its BOQ lines."""
    if not ids:
        return {}
    try:
        from app.models.all_models import OEM, TenderProduct, TenderProductOEM
        rows = db.query(TenderProduct.tender_id, TenderProductOEM.oem_name, OEM.name, TenderProductOEM.is_preferred).join(
            TenderProductOEM, TenderProductOEM.tender_product_id == TenderProduct.id).outerjoin(OEM, OEM.id == TenderProductOEM.oem_id).filter(
            TenderProduct.tender_id.in_(ids)).order_by(TenderProductOEM.is_preferred.desc(), TenderProductOEM.id).all()
        out: dict[int, str] = {}
        for tid, n1, n2, _ in rows:
            nm = (n2 or n1 or "").strip()
            if nm:
                out.setdefault(tid, nm)
        return out
    except Exception as exc:
        db.rollback()
        logger.info("tender OEMs unavailable: %s", exc)
        return {}


def ML6(x: Ctx) -> list[tuple[str, date, date]]:
    """Last six calendar months ending with the period end (prototype ML6)."""
    out = []
    y, m = x.end.year, x.end.month
    for _ in range(6):
        s = date(y, m, 1)
        e = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1))
        out.append((s.strftime("%b"), s, e))
        y, m = (y - 1, 12) if m == 1 else (y, m - 1)
    return out[::-1]


# ─── Sales ──────────────────────────────────────────────────────────────────────

def r_pipeline(x: Ctx) -> dict:
    op = [r for r in deals(x) if r["stage_kind"] == "open" and x.inp(r["created"])]
    order: list[str] = []
    for p in x.cache.get("pipes", []):
        for s in p["stages"]:
            if s["kind"] == "open" and s["name"] not in order:
                order.append(s["name"])
    by_stage = [{"l": s, "v": S0([o for o in op if o["stage"] == s], lambda o: o["value"])} for s in order]
    return {"k": [K("Open deals", len(op)), K("Value", S0(op, lambda o: o["value"]), "inr"),
                  K("Weighted", S0(op, lambda o: D(o["value"]) * D(o["prob"] or 30) / 100), "inr"),
                  K("Avg deal", S0(op, lambda o: o["value"]) / max(len(op), 1), "inr")],
            "c": [CH("Value by stage", "hbars", [s for s in by_stage if s["v"] or any(o["stage"] == s["l"] for o in op)], "inr", lw=120, vw=84),
                  CH("Value by owner", "hbars", sorted([{"l": g["l"], "v": g["v"]} for g in grp(op, lambda o: o["owner"], lambda o: o["value"])],
                                                       key=lambda z: -z["v"]), "inr", lw=110, vw=84)],
            "cols": [C("ref", "Deal", "id"), C("name", "Name", w=260), C("customer", "Customer", w=170), C("workflow", "Type"), INR("value", "Value"),
                     C("prob", "Win %", "int", r=True), C("stage", "Stage", "pill"), C("owner", "Owner", "user"), C("close", "Expected close", "date")],
            "rows": op, "open": {"module": "opportunities"}}


def _converted(l: dict) -> bool:
    if l.get("stage") == "Converted":
        return True
    steps = (l.get("journey") or {}).get("steps") or []
    return any(s.get("k") in ("D", "T", "Q") and s.get("done") for s in steps)


def r_leads(x: Ctx) -> dict:
    L = [l for l in leads(x) if x.inp(l["created"])]
    cv = [l for l in L if _converted(l)]
    allL = leads(x)
    by_month = [{"l": lab, "v": sum(1 for l in allL if l["created"] and s <= l["created"] <= e)} for lab, s, e in ML6(x)]
    return {"k": [K("Leads", len(L)), K("Converted", len(cv)), K("Conversion", pct(len(cv), len(L)), "pct"),
                  K("Avg score", round(sum((l.get("score") or 0) for l in L) / max(len(L), 1)))],
            "c": [CH("Conversion by source", "hbars", [{"l": g["l"], "v": pct(sum(1 for l in cv if (l.get("source") or "—") == g["l"]), g["n"])}
                                                       for g in grp(L, lambda l: l.get("source"))], "pct", lw=110, vw=40),
                  CH("Leads by month", "bars", by_month, "int", h=120)],
            "cols": [C("ref", "Lead", "id"), C("company", "Company", w=200), C("source", "Source"), INR("value", "Value"), C("score", "Score", "int", r=True),
                     C("stage", "Stage", "pill"), C("owner", "Owner", "user"), C("jid", "Journey", "journey")],
            "rows": L, "open": {"module": "leads"}}


def r_journeys(x: Ctx) -> dict:
    J: dict[str, dict] = {}
    first: dict[str, date] = {}

    def steps_of(r: dict) -> dict[str, dict]:
        return {s["k"]: s for s in ((r.get("journey") or {}).get("steps") or [])}

    for src, rows, dkey in (("lead", leads(x), "created"), ("deal", deals(x), "created"), ("bid", bids(x), "published"), ("order", orders(x), "start")):
        for r in rows:
            jid = r.get("jid")
            if not jid:
                continue
            j = J.setdefault(jid, {"id": jid, "cust": r.get("customer") or r.get("company") or "", "lead": "—", "deal": "—", "bid": "—", "wo": "—",
                                   "fo": "—", "val": Decimal(0), "won": False, "lead_date": None, "order_date": None})
            st = steps_of(r)
            if st.get("L", {}).get("done") and j["lead"] == "—":
                j["lead"] = st["L"].get("stage") or "—"
            if st.get("D", {}).get("done") and j["deal"] == "—":
                j["deal"] = st["D"].get("stage") or "—"
            for k in ("T", "Q"):
                if st.get(k, {}).get("done") and j["bid"] == "—":
                    j["bid"] = st[k].get("stage") or "—"
            j["val"] = max(j["val"], D(r.get("value")))
            if not j["cust"]:
                j["cust"] = r.get("customer") or r.get("company") or ""
            d = _day(r.get(dkey))
            if d and (jid not in first or d < first[jid]):
                first[jid] = d
            if src == "lead":
                j["lead"] = r.get("stage") or j["lead"]
                j["lead_date"] = d
            if src == "deal":                      # the record's own current stage beats a journey snapshot
                j["deal"] = r.get("stage") or j["deal"]
            if src == "bid":
                j["bid"] = r.get("stage") or j["bid"]
            if src == "order":
                j["won"] = True
                j["wo"] = f"{r.get('progress') or 0}%"
                j["order_date"] = j["order_date"] or d
    parents = {o["parent_id"]: o for o in orders(x) if o.get("parent_id")}
    by_id = {o["id"]: o for o in orders(x)}
    for pid, child in parents.items():
        p = by_id.get(pid)
        if p and p.get("jid") in J:
            J[p["jid"]]["fo"] = child.get("type") or "Follow-on"
    rows = []
    for jid, j in J.items():
        if not x.inp(first.get(jid)):
            continue
        start = j["lead_date"] or first.get(jid)
        days = ((j["order_date"] or x.today) - start).days if start else 0
        rows.append({**j, "val": float(j["val"]), "days": max(0, days)})
    won = [r for r in rows if r["won"]]
    L = [l for l in leads(x) if x.inp(l["created"])]
    Dl = [r for r in deals(x) if x.inp(r["created"])]
    B = [b for b in bids(x) if x.inp(b["published"])]
    Q = x.memo("quotes", lambda: _quotes(x))
    O = [o for o in orders(x) if x.inp(o.get("start"))]
    return {"k": [K("Journeys", len(rows)), K("Reached order", len(won), dc="tok"), K("Order rate", pct(len(won), len(rows)), "pct"),
                  K("Avg days to order", round(sum(r["days"] for r in won) / max(len(won), 1)), "int"),
                  K("With follow-on (AMC)", sum(1 for r in rows if r["fo"] != "—"))],
            "c": [CH("Journey funnel", "funnel", [{"l": "Leads", "v": len(L)}, {"l": "Converted", "v": sum(1 for l in L if _converted(l))},
                                                  {"l": "Deals", "v": len(Dl)}, {"l": "Bids + quotes", "v": len(B) + len([q for q in Q if x.inp(q)])},
                                                  {"l": "Orders", "v": len(O)}]),
                  CH("Where journeys stop", "hbars", [{"l": "Lead stage", "v": sum(1 for r in rows if r["deal"] == "—" and r["bid"] == "—" and not r["won"])},
                                                      {"l": "Deal stage", "v": sum(1 for r in rows if r["deal"] != "—" and r["bid"] == "—" and not r["won"])},
                                                      {"l": "Bid / quote stage", "v": sum(1 for r in rows if r["bid"] != "—" and not r["won"])},
                                                      {"l": "Reached order", "v": len(won)}], lw=120, vw=30)],
            "cols": [C("id", "Journey", "id"), C("cust", "Customer", w=200), C("lead", "Lead", "pill"), C("deal", "Deal", "pill"), C("bid", "Bid / quote", "pill"),
                     C("wo", "Order"), C("fo", "Follow-on"), INR("val", "Value"), C("days", "Age (days)", "int", r=True)],
            "rows": rows}


def _quotes(x: Ctx) -> list[date]:
    """Quotation dates the user may see (Quotes data visibility) – used only for counts."""
    if not user_has_permission(x.db, x.cu, "quotations.view"):
        return []
    try:
        from app.models.all_models import Quotation
        from app.routers.lead_router import _module_scope_clause
        q = x.db.query(Quotation.created_at, Quotation.created_by)
        try:
            from app.utils.data_scope import get_module_data_scope, get_team_user_ids
            sc = get_module_data_scope(x.db, x.cu, "quotations")
            if sc == "own":
                q = q.filter(Quotation.created_by == x.cu.id)
            elif sc == "team":
                q = q.filter(Quotation.created_by.in_(get_team_user_ids(x.db, int(x.cu.id)) or [-1]))
            elif sc == "none":
                return []
        except Exception:
            q = q.filter(Quotation.created_by == x.cu.id)
        return [_day(r[0]) for r in q.all() if r[0]]
    except Exception as exc:
        x.db.rollback()
        logger.info("quotes unavailable: %s", exc)
        return []


def r_winloss(x: Ctx) -> dict:
    O = [r for r in deals(x) if r["stage_kind"] in ("won", "lost") and x.inp(r["closed"])]
    won = [o for o in O if o["stage_kind"] == "won"]
    lost = [o for o in O if o["stage_kind"] == "lost"]
    for o in O:
        o["outcome"] = "Won" if o["stage_kind"] == "won" else "Lost"
    return {"k": [K("Closed deals", len(O)), K("Won", len(won), dc="tok"), K("Lost", len(lost)), K("Win rate", pct(len(won), len(O)), "pct")],
            "c": [CH("Lost reasons", "donut", [{"l": g["l"], "v": g["n"]} for g in grp(lost, lambda o: o.get("lostReason"))]),
                  CH("Win rate by competitor", "hbars", [{"l": g["l"], "v": pct(sum(1 for o in won if (o.get("comp") or "—") == g["l"]), g["n"])}
                                                         for g in grp(O, lambda o: o.get("comp") or "—")], "pct", lw=120, vw=40)],
            "cols": [C("ref", "Deal", "id"), C("name", "Name", w=240), C("customer", "Customer"), INR("value", "Value"), C("outcome", "Outcome", "pill"),
                     C("comp", "Competitor"), C("lostReason", "Reason"), C("owner", "Owner", "user")],
            "rows": O, "open": {"module": "opportunities"}}


def r_kam(x: Ctx) -> dict:
    from app.services import field_sales_service as FS
    if not user_has_permission(x.db, x.cu, "kam.view"):
        return {"k": [], "c": [], "cols": [], "rows": []}
    kams = FS.kam_users(x.db, x.cu)
    ids = [k["id"] for k in kams]
    fy = FS.fiscal_year(x.db)
    tg = FS.targets(x.db, ids, fy)
    share = (x.end - x.start).days + 1
    fy_days = (fy["end"] - fy["start"]).days + 1
    factor = Decimal(1) if (x.start, x.end) == (fy["start"], fy["end"]) or share >= fy_days else Decimal(share) / Decimal(fy_days)
    dl = FS.deals(x.db, x.cu, ids)
    acts = FS.activities(x.db, ids, x.start, min(x.end, x.today))
    cust = FS.customers(x.db, x.cu, ids)
    rows = []
    for k in kams:
        mine = [d for d in dl if d["owner_id"] == k["id"]]
        won = [d for d in mine if d["kind"] == "won" and x.inp(d["won_on"])]
        closed = [d for d in mine if d["kind"] in ("won", "lost")]
        cwon = [d for d in closed if d["kind"] == "won"]
        target = float(D(tg[k["id"]]["target"]) * factor)
        rows.append({"id": k["id"], "n": k["name"], "tg": round(target, 2), "won": S0(won, lambda d: d["value"]),
                     "pipe": S0([d for d in mine if d["kind"] == "open"], lambda d: d["value"]),
                     "wr": pct(len(cwon), len(closed)) if closed else None, "acts": sum(1 for a in acts if a["uid"] == k["id"]),
                     "accts": sum(1 for c in cust if c["kam_id"] == k["id"])})
    T, W = sum(r["tg"] for r in rows), sum(r["won"] for r in rows)
    return {"k": [K("Target", T, "inr"), K("Achieved", W, "inr"), K("Attainment", pct(W, T), "pct"), K("Pipeline", sum(r["pipe"] for r in rows), "inr")],
            "c": [CH("Attainment", "hbars", [{"l": r["n"].split(" ")[0], "v": pct(r["won"], r["tg"])} for r in rows], "pct", lw=90, vw=40)],
            "cols": [C("n", "KAM", "user", w=180), INR("tg", "Target"), INR("won", "Achieved"), INR("pipe", "Pipeline"), C("wr", "Win %", "int", r=True),
                     C("acts", "Activities", "int", r=True), C("accts", "Customers", "int", r=True)],
            "rows": rows, "note": "Target is the configured annual target, pro-rated to the period" if factor != 1 else None}


def r_customers(x: Ctx) -> dict:
    C_ = customers(x)
    srt = sorted(C_, key=lambda c: -c["revenue"])
    T = S0(C_, lambda c: c["revenue"])
    return {"k": [K("Customers", len(C_)), K("FY revenue", T, "inr"), K("Top 5 share", pct(S0(srt[:5], lambda c: c["revenue"]), T), "pct")],
            "c": [CH("Top customers", "hbars", [{"l": c["name"], "v": c["revenue"]} for c in srt[:8]], "inr", lw=140, vw=84)],
            "cols": [C("name", "Customer", "link360", w=220), C("type", "Type"), C("tier", "Tier"), C("kam", "KAM", "user"), INR("revenue", "FY revenue"),
                     INR("pipe", "Open pipeline"), C("health", "Health", "bar")],
            "rows": C_}


# ─── Bids & tenders ─────────────────────────────────────────────────────────────

def r_bids(x: Ctx) -> dict:
    T = [b for b in bids(x) if b["stage_kind"] == "open" and x.inp(b["published"])]
    due7 = sum(1 for b in T if b.get("submit") and 0 <= (_day(b["submit"]) - x.today).days <= 7)
    stages: list[str] = []
    for b in T:
        if b["stage"] not in stages:
            stages.append(b["stage"])
    return {"k": [K("Live bids", len(T)), K("Value", S0(T, lambda b: b["value"]), "inr"), K("Due ≤ 7 days", due7, dc="twarn"),
                  K("EMD blocked", S0(T, lambda b: b.get("emd") or 0), "inr")],
            "c": [CH("By stage", "hbars", [{"l": s, "v": sum(1 for b in T if b["stage"] == s)} for s in stages], lw=130, vw=30),
                  CH("By bid manager", "hbars", [{"l": g["l"], "v": g["n"]} for g in grp(T, lambda b: b.get("owner"))], lw=120, vw=30)],
            "cols": [C("ref", "Bid", "id"), C("nit", "Tender no.", w=150), C("customer", "Customer", w=170), C("portal", "Portal"), INR("value", "Value"),
                     INR("emd", "EMD"), C("stage", "Stage", "pill"), C("owner", "Bid manager", "user"), C("published", "Published", "d"),
                     C("submit", "Deadline", "date")],
            "rows": T, "open": {"module": "tenders"}}


def r_emd(x: Ctx) -> dict:
    E = [e for e in instruments(x) if x.inp(e.get("issued")) or (not e.get("issued") and e.get("status") == "Active")]
    act = [e for e in E if e["status"] == "Active"]
    exp30 = sum(1 for e in act if e.get("validity") and 0 <= (_day(e["validity"]) - x.today).days <= 30)
    return {"k": [K("Active", len(act)), K("Blocked", S0(act, lambda e: e["amount"]), "inr"), K("Expiring ≤ 30 d", exp30, dc="twarn"),
                  K("Released", sum(1 for e in E if e["status"] == "Released"))],
            "c": [CH("By bank", "hbars", [{"l": g["l"], "v": g["v"]} for g in grp(act, lambda e: e.get("bank"), lambda e: e["amount"])], "inr", lw=100, vw=84),
                  CH("By type", "donut", [{"l": g["l"], "v": g["v"]} for g in grp(E, lambda e: e.get("type"), lambda e: e["amount"])], "inr")],
            "cols": [C("type", "Type"), C("ref", "Reference", w=140), C("tender", "Bid"), C("customer", "Customer", w=170), C("bank", "Bank"), INR("amount", "Amount"),
                     C("issued", "Issued", "d"), C("validity", "Valid until", "date"), C("status", "Status", "pill")],
            "rows": E, "open": {"module": "emdbg"}}


def r_portal(x: Ctx) -> dict:
    T = [b for b in bids(x) if b["stage_kind"] in ("won", "lost") and x.inp(b["decided"])]
    for b in T:
        b["result"] = "Won" if b["stage_kind"] == "won" else "Lost"

    def hr(f):
        return [{"l": g["l"], "v": pct(sum(1 for b in T if (f(b) or "—") == g["l"] and b["stage_kind"] == "won"), g["n"]), "n": g["n"]} for g in grp(T, f)]
    bp = sorted(hr(lambda b: b.get("portal")), key=lambda z: -z["v"])
    bo = sorted(hr(lambda b: b.get("oem")), key=lambda z: -z["v"])
    return {"k": [K("Decided bids", len(T)), K("Hit rate", pct(sum(1 for b in T if b["stage_kind"] == "won"), len(T)), "pct"),
                  K("Best portal", bp[0]["l"] if bp else "—", "text"), K("Best OEM", bo[0]["l"] if bo else "—", "text")],
            "c": [CH("By portal", "hbars", hr(lambda b: b.get("portal")), "pct", lw=110, vw=40), CH("By OEM", "hbars", hr(lambda b: b.get("oem")), "pct", lw=110, vw=40)],
            "cols": [C("ref", "Bid", "id"), C("customer", "Customer", w=180), C("portal", "Portal"), C("oem", "OEM"), INR("value", "Value"), C("result", "Result", "pill")],
            "rows": T, "open": {"module": "tenders"}}


def r_competitors(x: Ctx) -> dict:
    if not user_has_permission(x.db, x.cu, "competitors.view"):
        rows = []
    else:
        from app.services import directory_service as DS
        rows = DS.comp_list(x.db, view="All", q="", f={}, adv={}, sorts=[], offset=0, limit=5000).get("items", [])
    return {"k": [K("Competitors", len(rows)), K("Bids met", sum(int(r.get("met") or 0) for r in rows)), K("They won", sum(int(r.get("won") or 0) for r in rows)),
                  K("We won", sum(int(r.get("lost") or 0) for r in rows))],
            "c": [CH("Encounters", "hbars", [{"l": r["name"], "v": int(r.get("met") or 0)} for r in rows], lw=130, vw=30)],
            "cols": [C("name", "Competitor", w=200), C("hq", "HQ"), C("met", "Met", "int", r=True, sum=True), C("won", "They won", "int", r=True, sum=True),
                     C("lost", "We won", "int", r=True, sum=True), C("delta", "Price vs ours %", "num", r=True), C("share", "Share %", "num", r=True)],
            "rows": rows, "note": "Competitor encounters are counted across all recorded bids"}


# ─── Delivery & finance ─────────────────────────────────────────────────────────

def _period_orders(x: Ctx) -> list[dict]:
    return [o for o in orders(x) if x.inp(o.get("start")) or (not o.get("start") and x.inp(o.get("due")))]


def r_orders(x: Ctx) -> dict:
    W = _period_orders(x)
    delayed = sum(1 for w in W if w.get("delayed"))
    gap = sorted([{"l": w["ref"], "v": max(0, int(w.get("progress") or 0) - int(w.get("billed") or 0))} for w in W], key=lambda z: -z["v"])[:6]
    return {"k": [K("Orders", len(W)), K("Value", S0(W, lambda w: w["value"]), "inr"), K("Delayed", delayed, dc="tbad"),
                  K("Avg progress", round(sum(int(w.get("progress") or 0) for w in W) / max(len(W), 1)), "pct")],
            "c": [CH("By contract type", "donut", [{"l": g["l"], "v": g["n"]} for g in grp(W, lambda w: w.get("type") or "Project / Supply")]),
                  CH("Progress vs billed", "hbars", gap, "pts", lw=100, vw=50)],
            "cols": [C("ref", "Order", "id"), C("title", "Work", w=230), C("type", "Type"), C("customer", "Customer", w=170), INR("value", "Value"),
                     C("progress", "Progress", "bar"), C("billed", "Billed", "pct"), INR("received", "Received"), INR("awaiting", "Awaiting finance"),
                     C("stage", "Stage", "pill"), C("pm", "PM", "user"), C("due", "Due", "date")],
            "rows": W, "open": {"module": "workorders"}}


def pay_ledger(x: Ctx) -> dict:
    """Orders & Projects payment ledger for the orders in scope – the same receipts / stages as Collections & finance."""
    def load():
        from app.services.order_payment_service import ledger
        return ledger(x.db, [o["id"] for o in orders(x)])
    return x.memo("pay_ledger", load)


def r_billing(x: Ctx) -> dict:
    """Billed = invoices raised in the period · Collected = receipts acknowledged by Finance in the period (bank credit
    date) · Awaiting finance = receipts not yet acknowledged · Outstanding = unpaid balance of payment stages due to date."""
    from app.services import customer360_service as S
    W = orders(x)
    by = {w["id"]: w for w in W}
    L = pay_ledger(x)
    agg: dict[int, dict] = {wid: {"b": Decimal(0), "c": Decimal(0)} for wid in by}
    for inv in S.invoice_rows(x.db, list(by)):
        if x.inp(inv.invoice_date):
            agg[inv.wo_id]["b"] += D(inv.total_amount)
    for r in L["receipts"]:
        if r["status"] == "Acknowledged" and x.inp(r["credited_on"]) and r["wo_id"] in agg:
            agg[r["wo_id"]]["c"] += D(r["amount"])
    rows = []
    for wid, a in agg.items():
        w, lg = by[wid], L["orders"].get(wid, {})
        aw, out = float(lg.get("awaiting", 0.0)), float(lg.get("receivable", 0.0))
        if not (a["b"] or a["c"] or aw or out):
            continue
        rows.append({"id": wid, "ref": w["ref"], "customer": w.get("customer") or "", "value": w["value"], "bAmt": float(a["b"]), "cAmt": float(a["c"]),
                     "aAmt": aw, "oAmt": out})
    B, Cc = sum(r["bAmt"] for r in rows), sum(r["cAmt"] for r in rows)
    due = sum(o.get("due", 0.0) for o in L["orders"].values())
    rec = sum(o.get("received", 0.0) for o in L["orders"].values())
    return {"k": [K("Billed", B, "inr"), K("Collected", Cc, "inr", "tok"), K("Awaiting finance", sum(r["aAmt"] for r in rows), "inr", "twarn"),
                  K("Outstanding", sum(r["oAmt"] for r in rows), "inr", "twarn"), K("Collection efficiency", pct(rec, due), "pct")],
            "c": [CH("Outstanding by customer", "hbars", sorted([{"l": g["l"], "v": g["v"]} for g in grp(rows, lambda r: r["customer"], lambda r: r["oAmt"])],
                                                                 key=lambda z: -z["v"])[:7], "inr", lw=140, vw=84)],
            "cols": [C("ref", "Order", "id"), C("customer", "Customer", w=200), INR("value", "Order value"), INR("bAmt", "Billed"), INR("cAmt", "Collected"),
                     INR("aAmt", "Awaiting finance"), INR("oAmt", "Outstanding")],
            "rows": rows, "open": {"module": "workorders"},
            "note": "Collected = receipts acknowledged by Finance in the period; outstanding = unpaid payment stages due to date; "
                    "collection efficiency = received to date ÷ due to date (as Collections & finance)"}


def r_amc(x: Ctx) -> dict:
    W = [w for w in orders(x) if (w.get("type") or "Project / Supply") != "Project / Supply" and w.get("stage_kind") != "lost"]
    ren = sum(1 for w in W if w.get("due") and 0 <= (_day(w["due"]) - x.today).days <= 60)
    return {"k": [K("Contracts", len(W)), K("Annual value", S0(W, lambda w: w["value"]), "inr"), K("Renewing ≤ 60 d", ren, dc="twarn")],
            "c": [CH("By type", "donut", [{"l": g["l"], "v": g["n"]} for g in grp(W, lambda w: w.get("type"))])],
            "cols": [C("ref", "Contract", "id"), C("title", "Contract", w=240), C("type", "Type"), C("customer", "Customer", w=180), INR("value", "Value"),
                     C("due", "Renewal", "date"), C("stage", "Stage", "pill")],
            "rows": W, "open": {"module": "workorders"}, "note": "All live follow-on contracts – renewal dates are not limited to the period"}


# ─── Customers ──────────────────────────────────────────────────────────────────

def r_c360(x: Ctx) -> dict:
    C_ = customers(x)
    return {"k": [K("Customers", len(C_)), K("Avg health", round(sum(c["health"] for c in C_) / max(len(C_), 1))),
                  K("At risk", sum(1 for c in C_ if c["health"] < 55), dc="tbad"), K("No touch > 30 d", sum(1 for c in C_ if c["touch"] is None or c["touch"] > 30), dc="twarn")],
            "c": [CH("Health", "donut", [{"l": "Healthy", "v": sum(1 for c in C_ if c["health"] >= 75), "c": "var(--bw-ok)"},
                                         {"l": "Watch", "v": sum(1 for c in C_ if 55 <= c["health"] < 75), "c": "var(--bw-wa)"},
                                         {"l": "At risk", "v": sum(1 for c in C_ if c["health"] < 55), "c": "var(--bw-ba)"}])],
            "cols": [C("name", "Customer", "link360", w=220), C("tier", "Tier"), C("kam", "KAM", "user"), INR("revenue", "FY revenue"), INR("pipe", "Pipeline"),
                     C("orders", "Orders", "int", r=True), INR("out", "Outstanding"), C("wr", "Win %", "int", r=True), C("health", "Health", "bar"),
                     C("touch", "Last touch (d)", "int", r=True)],
            "rows": C_}


def r_concentration(x: Ctx) -> dict:
    C_ = sorted(customers(x), key=lambda c: -c["revenue"])
    T = S0(C_, lambda c: c["revenue"])
    cum = 0.0
    rows = []
    for c in C_:
        cum += c["revenue"]
        rows.append({**c, "sh": pct(c["revenue"], T), "cum": pct(cum, T)})
    return {"k": [K("Top 3 share", pct(S0(C_[:3], lambda c: c["revenue"]), T), "pct"), K("Top 10 share", pct(S0(C_[:10], lambda c: c["revenue"]), T), "pct"),
                  K("Strategic (Tier A)", sum(1 for c in C_ if c["tier"] == "A"))],
            "c": [CH("By customer type", "donut", [{"l": g["l"], "v": g["v"]} for g in grp(C_, lambda c: c.get("type"), lambda c: c["revenue"])], "inr"),
                  CH("By tier", "donut", [{"l": g["l"], "v": g["v"]} for g in grp(C_, lambda c: f"Tier {c['tier']}", lambda c: c["revenue"])], "inr")],
            "cols": [C("name", "Customer", "link360", w=220), INR("revenue", "FY revenue"), C("sh", "Share %", "int", r=True), C("cum", "Cumulative %", "int", r=True)],
            "rows": rows}


# ─── Field sales ────────────────────────────────────────────────────────────────

def r_activities(x: Ctx) -> dict:
    from app.services import field_sales_service as FS
    if not user_has_permission(x.db, x.cu, "kam.view"):
        return {"k": [], "c": [], "cols": [], "rows": []}
    uids = FS.scope_uids(x.db, x.cu)
    A = FS.activities(x.db, uids, x.start, min(x.end, x.today))
    who = FS.names(x.db, [a["uid"] for a in A])
    cn = FS.customer_names(x.db, [a["customer_id"] for a in A])
    rows = [{"id": a["id"], "date": a["date"], "time": a["time"], "kam": who.get(a["uid"], ""), "type": a["type"],
             "customer": (cn.get(a["customer_id"] or 0) or ("",))[0], "note": a["subject"], "outcome": a["outcome"] or ""} for a in A]
    return {"k": [K("Activities", len(rows)), K("Site visits", sum(1 for a in rows if a["type"] == "Site Visit")),
                  K("Positive", pct(sum(1 for a in rows if a["outcome"] == "Positive"), len(rows)), "pct", "tok")],
            "c": [CH("By KAM", "hbars", sorted([{"l": g["l"], "v": g["n"]} for g in grp(rows, lambda a: a["kam"])], key=lambda z: -z["v"]), lw=120, vw=30),
                  CH("By type", "donut", [{"l": g["l"], "v": g["n"]} for g in grp(rows, lambda a: a["type"])])],
            "cols": [C("date", "Date", "d"), C("time", "Time"), C("kam", "KAM", "user", w=170), C("type", "Type"), C("customer", "Customer", w=180),
                     C("note", "Notes", w=260), C("outcome", "Outcome", "pill")],
            "rows": rows}


def r_travel(x: Ctx) -> dict:
    from app.services import travel_expense_service as TE
    if not user_has_permission(x.db, x.cu, "travel.view"):
        return {"k": [], "c": [], "cols": [], "rows": []}
    from app.models.all_models import TravelRequest
    trips = [t for t in TE.scoped_trips(x.db, x.cu).filter(TravelRequest.status != "Cancelled").all() if x.inp(t.travel_date)]
    fin = TE.finance(x.db, trips)
    who = TE.names(x.db, [t.employee_id for t in trips])
    rows = [{**TE.row(t, who), "spent": float(fin[t.id]["claimed"]), "adv": float(fin[t.id]["issued"])} for t in trips]
    return {"k": [K("Trips", len(rows)), K("Spend", sum(r["spent"] for r in rows), "inr"), K("Advances", sum(r["adv"] for r in rows), "inr"),
                  K("Pending", sum(1 for r in rows if r["status"] in ("Pending", "Draft")))],
            "c": [CH("Spend by traveller", "hbars", [{"l": g["l"], "v": g["v"]} for g in grp(rows, lambda r: r["traveller"], lambda r: r["spent"])], "inr", lw=120, vw=84)],
            "cols": [C("code", "Trip", "id"), C("traveller", "Traveller", "user", w=170), C("purpose", "Purpose", w=230), C("to", "Destination"),
                     C("start", "From", "d"), INR("cost", "Cost"), C("status", "Status", "pill")],
            "rows": rows, "open": {"module": "travel"}, "note": "Spend = expenses claimed · Advances = advance actually disbursed · Cost = trip estimate"}


# ─── Management ─────────────────────────────────────────────────────────────────

def _approval_rows(x: Ctx) -> list[dict]:
    def load():
        if not user_has_permission(x.db, x.cu, "approvals.view"):
            return []
        from app.services import approvals360_service as AP
        out, seen = [], set()
        for view in ("All pending", "Decided"):
            for r in AP.rows(x.db, x.cu, view=view, q="", offset=0, limit=5000)["items"]:
                if r["key"] not in seen:
                    seen.add(r["key"])
                    out.append(r)
        return out
    return x.memo("approvals", load)


def r_executive(x: Ctx) -> dict:
    Dl = deals(x)
    won = [d for d in Dl if d["stage_kind"] == "won" and x.inp(d["closed"])]
    W = _period_orders(x)
    out = Decimal(str(sum(o.get("receivable", 0.0) for o in pay_ledger(x)["orders"].values())))   # unpaid payment stages due to date
    pend = sum(1 for a in _approval_rows(x) if a.get("status") == "Pending")
    counts = [("Leads", len([l for l in leads(x) if x.inp(l["created"])])), ("Deals", len([d for d in Dl if x.inp(d["created"])])),
              ("Bids", len([b for b in bids(x) if x.inp(b["published"])])), ("Quotes", len([q for q in x.memo("quotes", lambda: _quotes(x)) if x.inp(q)])),
              ("Orders", len(W)), ("Customers", len(customers(x)))]
    return {"k": [K("Booked", S0(won, lambda d: d["value"]), "inr"), K("Pipeline", S0([d for d in Dl if d["stage_kind"] == "open"], lambda d: d["value"]), "inr"),
                  K("Live bids", sum(1 for b in bids(x) if b["stage_kind"] == "open")), K("Orders", len(W)), K("Outstanding", float(out), "inr"),
                  K("Approvals pending", pend)],
            "c": [CH("Overview", "bars", [{"l": m, "v": v} for m, v in counts], h=150)],
            "cols": [C("m", "Metric"), C("v", "Value", "int", r=True)],
            "rows": [{"id": i, "m": m, "v": v} for i, (m, v) in enumerate(counts)]}


def r_approvals(x: Ctx) -> dict:
    A = [a for a in _approval_rows(x) if x.inp(a.get("req"))]
    pend = [a for a in A if a.get("status") == "Pending"]
    over = [a for a in pend if (a.get("sla") or {}).get("left", 0) < 0]
    hrs = []
    for a in A:
        if a.get("status") != "Pending" and a.get("req") and a.get("decided"):
            try:
                h = (datetime.fromisoformat(str(a["decided"])[:19]) - datetime.fromisoformat(str(a["req"])[:19])).total_seconds() / 3600
                if h >= 0:
                    hrs.append(h)
            except ValueError:
                pass
    rows = [{**a, "req_on": str(a.get("req") or "")[:16].replace("T", " ")} for a in A]
    return {"k": [K("Requests", len(A)), K("Pending", len(pend)), K("Overdue", len(over), dc="tbad"),
                  K("Avg turnaround", f"{sum(hrs) / len(hrs):.1f} h" if hrs else "—", "text")],
            "c": [CH("By event", "donut", [{"l": g["l"], "v": g["n"]} for g in grp(A, lambda a: a.get("type"))]),
                  CH("Waiting for", "hbars", [{"l": g["l"], "v": g["n"]} for g in grp(pend, lambda a: a.get("cur"))], lw=130, vw=30)],
            "cols": [C("id", "Request", "id"), C("type", "Event"), C("title", "Request", w=280), C("by", "Requested by", "user"), C("req_on", "Requested on", w=130),
                     C("cur", "Waiting for", w=150), INR("value", "Value"), C("status", "Status", "pill")],
            "rows": rows, "open": {"route": "/approvals"}}


def r_logins(x: Ctx) -> dict:
    from app.models.all_models import LoginLog
    start = datetime.combine(x.start, datetime.min.time())
    end = datetime.combine(x.end, datetime.max.time())
    L = x.db.query(LoginLog).filter(LoginLog.created_at.between(start, end)).order_by(LoginLog.created_at.desc()).limit(20000).all()
    users = {u.id: u for u in x.db.query(User.id, User.full_name, User.role, User.username).all()}
    known = {str(u.username).lower() for u in users.values() if u.username}
    sess = {}
    try:
        from app.models.all_models import UserSession
        for s in x.db.query(UserSession.user_id, UserSession.login_time, UserSession.location).filter(UserSession.login_time.between(start, end)).all():
            sess[(s.user_id, s.login_time.replace(microsecond=0) if s.login_time else None)] = s.location
    except Exception:
        x.db.rollback()
    rows = []
    for e in L:
        u = users.get(e.user_id)
        ua = e.user_agent or ""
        rows.append({"id": e.id, "u": u.full_name if u else e.username, "role": u.role if u else "—", "date": e.created_at, "time": e.created_at.strftime("%H:%M") if e.created_at else "",
                     "dev": ua[:80], "city": sess.get((e.user_id, e.created_at.replace(microsecond=0) if e.created_at else None)) or e.ip_address or "",
                     "method": "Password", "ok": bool(e.success), "why": e.failure_reason or "Failed",
                     "flag": (not e.success) and str(e.username or "").lower() not in known, "result": "Success" if e.success else (e.failure_reason or "Failed")})
    d14 = datetime.combine(x.today - timedelta(days=13), datetime.min.time())
    n14 = x.db.query(func.count(LoginLog.id)).filter(LoginLog.created_at >= d14).scalar() or 0
    okr = [r for r in rows if r["ok"]]
    return {"k": [K("Logins · 14 d", int(n14)), K("Unique users", len({r["u"] for r in okr})), K("Failed", sum(1 for r in rows if not r["ok"]), dc="twarn"),
                  K("Flagged", sum(1 for r in rows if r["flag"]), dc="tbad")],
            "c": [CH("Logins per user", "hbars", sorted([{"l": g["l"], "v": g["n"]} for g in grp(okr, lambda r: r["u"])], key=lambda z: -z["v"])[:8], lw=140, vw=30)],
            "cols": [C("u", "User", "user", w=170), C("role", "Role"), C("date", "Date", "d"), C("time", "Time"), C("dev", "Device", w=160), C("city", "Location"),
                     C("method", "Method", w=130), C("result", "Result", "result")],
            "rows": rows, "note": "Flagged = failed sign-in for a user name that doesn't exist in this workspace"}


def r_automation(x: Ctx) -> dict:
    from app.models.all_models import ApprovalRequest, ApprovalRule
    rows = []
    start = datetime.combine(x.start, datetime.min.time())
    end = datetime.combine(x.end, datetime.max.time())
    try:
        from app.models.studio import ValidationRule
        for r in x.db.query(ValidationRule).all():
            rows.append({"id": f"r{r.id}", "n": r.name, "kind": "Workflow rule", "mod": getattr(r, "object", "") or "", "runs": None, "on": bool(r.is_active)})
    except Exception:
        x.db.rollback()
    runs = dict(x.db.query(ApprovalRequest.approval_rule_id, func.count(ApprovalRequest.id)).filter(
        ApprovalRequest.approval_rule_id.isnot(None), ApprovalRequest.requested_at.between(start, end)).group_by(ApprovalRequest.approval_rule_id).all())
    from app.services.approvals360_service import MODL
    for p in x.db.query(ApprovalRule).all():
        rows.append({"id": f"p{p.id}", "n": p.name or f"{p.module_key} · {p.action_key}", "kind": "Approval policy", "mod": MODL.get(p.module_key, p.module_key),
                     "runs": int(runs.get(p.id, 0)), "on": bool(getattr(p, "is_active", True))})
    for r in rows:
        r["active"] = "Active" if r["on"] else "Paused"
    rl = [r for r in rows if r["kind"] == "Workflow rule"]
    pl = [r for r in rows if r["kind"] == "Approval policy"]
    tracked = [r for r in rl if r["runs"] is not None]
    return {"k": [K("Rules", len(rl)), K("Approval policies", len(pl)), K("Runs", sum(r["runs"] for r in tracked) if tracked else "—", "int" if tracked else "text"),
                  K("Approvals raised", sum(r["runs"] or 0 for r in pl))],
            "c": [CH("Most used", "hbars", sorted([{"l": ("🔒 " if r["kind"] == "Approval policy" else "") + r["n"], "v": r["runs"] or 0} for r in rows],
                                                  key=lambda z: -z["v"])[:7], lw=200, vw=30)],
            "cols": [C("n", "Name", w=300), C("kind", "Kind"), C("mod", "Module"), C("runs", "Runs", "int", r=True, sum=True), C("active", "Active", "active")],
            "rows": rows, "note": "Approvals raised = approval requests created by each policy in the period; rule executions are not logged, so Runs shows —"}


# ─── registry (prototype REPD order: rp0 … rp20) ────────────────────────────────

ADMIN = ("audit_logs.view",)
REPORTS: list[dict] = [
    {"key": "pipeline-by-stage-owner", "cat": "Sales", "n": "Pipeline by stage & owner", "d": "Open deals, value and weighted value for every stage and owner",
     "perm": ("opportunities.view",), "fn": r_pipeline, "basis": "Deal created"},
    {"key": "lead-conversion-source-roi", "cat": "Sales", "n": "Lead conversion & source ROI", "d": "How many leads convert, by source and owner",
     "perm": ("leads.view",), "fn": r_leads, "basis": "Lead created"},
    {"key": "journey-conversion", "cat": "Sales", "n": "Journey conversion – lead to order",
     "d": "Every journey from lead to deal, bid/quote, order and follow-on, with time at each step", "perm": ("leads.view",), "fn": r_journeys,
     "basis": "Journey start"},
    {"key": "win-loss-analysis", "cat": "Sales", "n": "Win / loss analysis", "d": "Outcomes by reason, deal type and competitor",
     "perm": ("opportunities.view",), "fn": r_winloss, "basis": "Deal closed"},
    {"key": "sales-by-kam", "cat": "Sales", "n": "Sales by KAM", "d": "Target, achievement, pipeline and win rate for every KAM",
     "perm": ("kam.view",), "fn": r_kam, "basis": "Deal won / activity date"},
    {"key": "sales-by-customer", "cat": "Sales", "n": "Sales by customer", "d": "Revenue, pipeline and orders for each customer",
     "perm": ("customers.view",), "fn": r_customers, "basis": "Order date"},
    {"key": "bid-pipeline-deadlines", "cat": "Bids & tenders", "n": "Bid pipeline & deadlines", "d": "Live bids with submission dates, EMD and owners",
     "perm": ("tenders.view",), "fn": r_bids, "basis": "Bid published"},
    {"key": "emd-guarantee-register", "cat": "Bids & tenders", "n": "EMD & guarantee register", "d": "Every guarantee with bank, amount, validity and exposure",
     "perm": ("emdbg.view",), "fn": r_emd, "basis": "Issued"},
    {"key": "portal-oem-hit-rate", "cat": "Bids & tenders", "n": "Portal & OEM hit-rate", "d": "Win rate by tender portal and principal OEM",
     "perm": ("tenders.view",), "fn": r_portal, "basis": "Result date"},
    {"key": "competitor-outcomes", "cat": "Bids & tenders", "n": "Competitor outcomes", "d": "Encounters, wins and price position per competitor",
     "perm": ("competitors.view",), "fn": r_competitors, "basis": None},
    {"key": "order-progress-delays", "cat": "Delivery & finance", "n": "Order progress & delays", "d": "Orders and contracts with progress, billing and due dates",
     "perm": ("workorders.view",), "fn": r_orders, "basis": "Order start"},
    {"key": "billing-collections", "cat": "Delivery & finance", "n": "Billing & collections", "d": "Billed versus collected by order",
     "perm": ("workorders.view",), "fn": r_billing, "basis": "Invoice date"},
    {"key": "amc-contract-renewals", "cat": "Delivery & finance", "n": "AMC & contract renewals", "d": "Follow-on contracts and renewal dates",
     "perm": ("workorders.view",), "fn": r_amc, "basis": None},
    {"key": "customer-360-summary", "cat": "Customers", "n": "Customer 360 summary",
     "d": "One row per customer with revenue, pipeline, orders, health and last touch", "perm": ("customers.view",), "fn": r_c360, "basis": "Order date (revenue)"},
    {"key": "revenue-concentration", "cat": "Customers", "n": "Revenue concentration", "d": "Share of revenue by customer, type and tier",
     "perm": ("customers.view",), "fn": r_concentration, "basis": "Order date"},
    {"key": "activity-summary", "cat": "Field sales", "n": "Activity summary", "d": "All logged activities by KAM, type and outcome",
     "perm": ("kam.view",), "fn": r_activities, "basis": "Activity date"},
    {"key": "travel-expense-summary", "cat": "Field sales", "n": "Travel & expense summary", "d": "Trips and spend by traveller and status",
     "perm": ("travel.view",), "fn": r_travel, "basis": "Departure"},
    {"key": "executive-summary", "cat": "Management", "n": "Executive summary pack", "d": "One-page view of revenue, pipeline, bids, orders and cash",
     "perm": ("opportunities.view",), "fn": r_executive, "basis": "Record dates"},
    {"key": "approval-turnaround-sla", "cat": "Management", "n": "Approval turnaround & SLA", "d": "How quickly approvals are decided and where they stall",
     "perm": ("approvals.view",), "fn": r_approvals, "basis": "Requested"},
    {"key": "user-login-adoption", "cat": "Management", "n": "User login & adoption", "d": "Who logs in, how often and from where",
     "perm": ADMIN, "fn": r_logins, "basis": "Sign-in date"},
    {"key": "automation-policy-usage", "cat": "Management", "n": "Automation & approval policy usage", "d": "How often rules and approval policies run",
     "perm": ("approvals.view", "settings.view"), "fn": r_automation, "basis": "Approval requested"},
]
BY_KEY = {r["key"]: r for r in REPORTS}
