"""Analytics (prototype v17 · Intelligence → Analytics) – the nine tabs, computed for a fiscal year from real records.

Rows come from the same scoped module loaders as Reports (reports_v17_data: lead360 / deal / bid / order / customer360 /
instrument / directory / field sales), so each module's permission and data visibility apply; a section the user can't see
returns no data rather than an error. The selected fiscal year (Settings fiscal_year_start, IST) bounds every date-based
figure; each value states its basis in the response. Nothing is estimated: where the data doesn't exist (e.g. no recorded EMD
cost, no submitted forecasts, no invoices) the value is None and the page shows "—".
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.timezone import now_ist, today_ist
from app.dependencies import user_has_permission
from app.models.all_models import Lead, Quotation, Tender, User, WorkOrder
from app.services import reports_v17_data as RD
from app.services.reports_v17_data import CH, D, K, S0, _day, grp, pct

logger = logging.getLogger(__name__)

TABS = ["Executive", "Sales funnel & journeys", "Pipeline health", "Win / loss & competitors", "Customers", "Bids & OEM",
        "Revenue & collections", "People & productivity", "Geography"]
PERM = "report_engine.view"           # the Analytics module's permission (Intelligence → Analytics)


# ─── fiscal years ─────────────────────────────────────────────────────────────

def _m0(db: Session) -> int:
    from app.services.field_sales_service import settings
    return settings(db)["fy_start_month"]


def fy_bounds(y: int, m0: int) -> tuple[date, date, str]:
    start = date(y, m0, 1)
    end = (date(y + 1, m0, 1) if m0 > 1 else date(y + 1, 1, 1)) - timedelta(days=1)
    return start, end, (f"FY {y}" if m0 == 1 else f"FY {y}-{str(y + 1)[2:]}")


def fy_of(d: date, m0: int) -> int:
    return d.year if d.month >= m0 else d.year - 1


def fiscal_years(db: Session) -> list[dict[str, Any]]:
    """Current FY and every earlier FY that has CRM records (earliest lead / tender / order), newest first, max 6."""
    m0 = _m0(db)
    cur = fy_of(today_ist(), m0)
    first = None
    for col in (Lead.created_at, Tender.created_at, WorkOrder.created_at):
        try:
            v = db.query(func.min(col)).scalar()
            if v and (first is None or v.date() < first):
                first = v.date()
        except Exception:
            db.rollback()
    lo = min(cur - 1, max(cur - 5, fy_of(first, m0))) if first else cur - 1   # always the current and previous FY (prototype)
    out = []
    for y in range(cur, lo - 1, -1):
        s, e, lbl = fy_bounds(y, m0)
        out.append({"v": str(y), "l": lbl, "start": s.isoformat(), "end": e.isoformat()})
    return out


def ctx(db: Session, cu: User, fy: Optional[str]) -> RD.Ctx:
    m0 = _m0(db)
    cur = fy_of(today_ist(), m0)
    try:
        y = int(fy) if fy else cur
    except ValueError:
        raise HTTPException(422, "Unknown financial year")
    if not cur - 20 <= y <= cur + 1:
        raise HTTPException(422, "Unknown financial year")
    s, e, lbl = fy_bounds(y, m0)
    return RD.Ctx(db=db, cu=cu, start=s, end=e, label=lbl, fy={"start": s, "end": e, "label": lbl, "y": y, "m0": m0})


# ─── shared calculations ──────────────────────────────────────────────────────

def _months(x: RD.Ctx, n: int = 6, forward: bool = False) -> list[tuple[str, date, date]]:
    """n calendar months: ending at min(today, FY end) (history), or starting with the current month (forward)."""
    if forward:
        y, m = (x.today.year, x.today.month) if x.start <= x.today <= x.end else (x.end.year, x.end.month)
        if not (x.start <= x.today <= x.end):
            y, m = (y - (1 if m <= n - 1 else 0), (m - n) % 12 + 1)   # past FY: its last n months
        out = []
        for _ in range(n):
            s = date(y, m, 1)
            out.append((s.strftime("%b"), s, date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)))
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        return out
    end = min(x.today, x.end)
    y, m = end.year, end.month
    out = []
    for _ in range(n):
        s = date(y, m, 1)
        out.append((s.strftime("%b"), s, date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)))
        y, m = (y - 1, 12) if m == 1 else (y, m - 1)
    return out[::-1]


def _bm(rows: list, dk, vk=None, months=None) -> list[float]:
    out = []
    for _, s, e in months:
        out.append(round(sum(float(D(vk(r)) if vk else 1) for r in rows if (d := _day(dk(r))) and s <= d <= e), 2))
    return out


def deals_fy(x: RD.Ctx):
    Dl = RD.deals(x)
    won = [d for d in Dl if d["stage_kind"] == "won" and x.inp(d["closed"])]
    lost = [d for d in Dl if d["stage_kind"] == "lost" and x.inp(d["closed"])]
    opn = [d for d in Dl if d["stage_kind"] == "open" and x.inp(d["created"])]
    return Dl, won, lost, opn


def _journey_done(r: dict, k: str) -> bool:
    return any(s.get("k") == k and s.get("done") for s in ((r.get("journey") or {}).get("steps") or []))


def team_target(x: RD.Ctx) -> Optional[float]:
    if not user_has_permission(x.db, x.cu, "kam.view"):
        return None
    from app.services import field_sales_service as FS
    return x.memo("target", lambda: float(sum(t["target"] for t in FS.targets(x.db, [k["id"] for k in FS.kam_users(x.db, x.cu)], x.fy).values())))


def sales_cycle(won: list[dict]) -> Optional[int]:
    days = [(d["closed"] - (d.get("lead_created") or d["created"])).days for d in won if d.get("closed") and (d.get("lead_created") or d.get("created"))]
    days = [v for v in days if v >= 0]
    return round(sum(days) / len(days)) if days else None


def coverage(x: RD.Ctx, opn: list, won: list) -> Optional[float]:
    tg = team_target(x)
    gap = (tg or 0) - S0(won, lambda d: d["value"])
    if not tg or gap <= 0:
        return None
    r = S0(opn, lambda d: d["value"]) / gap
    return round(r, 2) if r < 1 else round(r, 1)


def _leads_fy(x: RD.Ctx) -> list[dict]:
    return [l for l in RD.leads(x) if x.inp(l["created"])]


def _quotes_fy(x: RD.Ctx) -> int:
    return len([q for q in x.memo("quotes", lambda: RD._quotes(x)) if x.inp(q)])


def _orders_fy(x: RD.Ctx) -> list[dict]:
    return [o for o in RD.orders(x) if x.inp(o.get("start"))]


def _bids_fy(x: RD.Ctx) -> list[dict]:
    return [b for b in RD.bids(x) if x.inp(b["published"])]


def _invoices(x: RD.Ctx) -> list:
    def load():
        from app.services import customer360_service as S
        return S.invoice_rows(x.db, [o["id"] for o in RD.orders(x)])
    return x.memo("invoices", load)


def _na(why: str) -> dict:
    return {"na": why}


# ─── tabs ─────────────────────────────────────────────────────────────────────

def executive(x: RD.Ctx) -> dict[str, Any]:
    Dl, won, lost, opn = deals_fy(x)
    L = _leads_fy(x)
    cyc = sales_cycle(won)
    cov = coverage(x, opn, won)                      # same basis as Pipeline health → Coverage vs gap
    fa = forecast_accuracy(x)
    cv = [l for l in L if RD._converted(l)]
    months = _months(x, 6, forward=True)
    fc = revenue_forecast(x, months)
    hist = _months(x, 6)
    C = RD.customers(x)
    return {"k": [K("Revenue booked", S0(won, lambda d: d["value"]), "inr"),
                  K("Pipeline coverage", f"{cov}×" if cov is not None else None, "text"),
                  K("Win rate", pct(len(won), len(won) + len(lost)) if (won or lost) else None, "pct"),
                  K("Lead → order", pct(sum(1 for l in L if _journey_done(l, "O")), len(L)) if L else None, "pct"),
                  K("Avg sales cycle", f"{cyc} days" if cyc is not None else None, "text"),
                  K("Forecast accuracy", fa, "pct")],
            "c": [{**CH("Revenue forecast", "line", [], "inr", h=140), "labels": [m[0] for m in months], "ser": fc},
                  CH("Sales journey", "funnel", [{"l": "Leads", "v": len(L)}, {"l": "Converted", "v": len(cv)},
                                                 {"l": "Deals", "v": sum(1 for d in Dl if x.inp(d["created"]))},
                                                 {"l": "Bids + quotes", "v": len(_bids_fy(x)) + _quotes_fy(x)},
                                                 {"l": "Won", "v": len(won)}, {"l": "Orders", "v": len(_orders_fy(x))}]),
                  CH("Revenue by customer type", "donut", [{"l": g["l"], "v": g["v"]} for g in grp(C, lambda c: c.get("type"), lambda c: c["revenue"]) if g["v"]], "inr"),
                  {**CH("Win / loss trend", "line", [], "int", h=130), "labels": [m[0] for m in hist],
                   "ser": [{"n": "Won", "c": 2, "v": _bm(won, lambda d: d["closed"], None, hist)}, {"n": "Lost", "c": 4, "v": _bm(lost, lambda d: d["closed"], None, hist)}]},
                  CH("Bookings vs target", "bars", [{"l": m[0], "v": v} for m, v in zip(hist, _bm(won, lambda d: d["closed"], lambda d: D(d["value"]) / 100000, hist))], "int", h=130,
                     note="₹ L booked per month" + (f" · monthly target ₹{(team_target(x) or 0) / 12 / 1e5:,.1f} L" if team_target(x) else ""))],
            "layout": [3, 2],
            "notes": {"Forecast accuracy": "Submitted forecasts vs closed-won for finished periods" if fa is not None else "No submitted forecast for a finished period yet",
                      "Pipeline coverage": "Open pipeline ÷ (team target − booked)" if cov is not None else "Needs annual targets above revenue booked"}}


def revenue_forecast(x: RD.Ctx, months) -> list[dict]:
    """Commit / Best case / Actual per month from the Forecasts engine (closed-won + commit + best-case buckets)."""
    if not user_has_permission(x.db, x.cu, "opportunities.view"):
        return []
    from app.services import forecast_service as FS
    cfg = FS.config(x.db)
    m0 = cfg["fy_start_month"]
    commit, best, actual = [], [], []
    for _, s, e in months:
        y = fy_of(s, m0)
        idx = (s.year - y) * 12 + s.month - m0 + 1
        try:
            res = FS.compute(x.db, x.cu, FS.parse_period(f"FY{y}-M{idx:02d}", m0), cfg)["kpis"]
        except Exception as exc:
            x.db.rollback()
            logger.info("forecast month unavailable: %s", exc)
            res = {"closed": 0, "commit": 0, "best_case": 0}
        commit.append(round(res["closed"] + res["commit"], 2))
        best.append(round(res["closed"] + res["commit"] + res["best_case"], 2))
        actual.append(round(res["closed"], 2) if s <= x.today else None)
    return [{"n": "Commit", "c": 0, "v": commit}, {"n": "Best case", "c": 1, "v": best}, {"n": "Actual", "c": 2, "v": actual}]


def forecast_accuracy(x: RD.Ctx) -> Optional[int]:
    """For forecasts submitted for periods that have ended inside the FY: 100 − |actual − forecast| ÷ forecast (latest version)."""
    if not user_has_permission(x.db, x.cu, "opportunities.view"):
        return None
    try:
        from app.models.forecasts import ForecastSubmission, ForecastSubmissionLine
        from app.services import forecast_service as FS
        cfg = FS.config(x.db)
        subs = x.db.query(ForecastSubmission).filter(ForecastSubmission.period_end.isnot(None), ForecastSubmission.period_end < datetime.combine(x.today, datetime.min.time()),
                                                     ForecastSubmission.period_start >= datetime.combine(x.start, datetime.min.time()),
                                                     ForecastSubmission.period_end <= datetime.combine(x.end, datetime.max.time())).order_by(ForecastSubmission.version.desc()).all()
        latest: dict[str, Any] = {}
        for s in subs:
            latest.setdefault(s.period_key, s)
        accs = []
        for key, s in latest.items():
            f = sum((D(l.closed) + D(l.commit_amount) + D(l.adjustment) for l in x.db.query(ForecastSubmissionLine).filter(ForecastSubmissionLine.submission_id == s.id).all()), Decimal(0))
            if f <= 0:
                continue
            actual = D(FS.compute(x.db, x.cu, FS.parse_period(key, cfg["fy_start_month"]), cfg)["kpis"]["closed"])
            accs.append(max(0.0, 100 - float(abs(actual - f) / f * 100)))
        return round(sum(accs) / len(accs)) if accs else None
    except Exception as exc:
        x.db.rollback()
        logger.info("forecast accuracy unavailable: %s", exc)
        return None


def funnel(x: RD.Ctx) -> dict[str, Any]:
    Dl, won, lost, opn = deals_fy(x)
    L = _leads_fy(x)
    cv = [l for l in L if RD._converted(l)]
    qual = [l for l in L if l.get("stage") in ("Qualified", "Proposal Pending", "Nurturing", "Converted") or RD._converted(l)]
    O = _orders_fy(x)
    jids = {r.get("jid") for src in (L, [d for d in Dl if x.inp(d["created"])], _bids_fy(x), O) for r in src if r.get("jid")}
    won_with_order = [d for d in won if _journey_done(d, "O")]
    steps = step_days(x)
    src = []
    for g in grp(L, lambda l: l.get("source")):
        src.append({"l": g["l"], "v": pct(sum(1 for l in cv if (l.get("source") or "—") == g["l"]), g["n"])})
    from app.services.reports_v17_service import company_name
    return {"k": [K("Lead → deal / bid", pct(len(cv), len(L)) if L else None, "pct"), K("Deal → won", pct(len(won), len(won) + len(lost)) if (won or lost) else None, "pct"),
                  K("Won → order", pct(len(won_with_order), len(won)) if won else None, "pct"),
                  K("Lead → order", pct(sum(1 for l in L if _journey_done(l, "O")), len(L)) if L else None, "pct"), K("Tracked journeys", len(jids))],
            "c": [CH("Full funnel", "funnel", [{"l": "Leads", "v": len(L)}, {"l": "Qualified+", "v": len(qual)}, {"l": "Converted", "v": len(cv)},
                                               {"l": "Deals", "v": sum(1 for d in Dl if x.inp(d["created"]))}, {"l": "Bids / quotes", "v": len(_bids_fy(x)) + _quotes_fy(x)},
                                               {"l": "Won", "v": len(won)}, {"l": "Orders", "v": len(O)},
                                               {"l": "Follow-on contracts", "v": sum(1 for o in O if o.get("parent_id"))}]),
                  CH("Average days between steps", "hbars", steps, "days", lw=150, vw=40),
                  CH("Conversion by source", "hbars", sorted(src, key=lambda z: -z["v"]), "pct", lw=110, vw=40),
                  CH("Lead → order by company", "hbars", [{"l": company_name(x.db), "v": pct(sum(1 for l in L if _journey_done(l, "O")), len(L))}] if L else [], "pct", lw=130, vw=40)],
            "layout": [2, 2]}


def step_days(x: RD.Ctx) -> list[dict]:
    """Average days Lead → Deal, Deal → Bid / quote, Bid / quote → Order from recorded dates only (no fallback values)."""
    Dl = [d for d in RD.deals(x) if x.inp(d["created"])]
    ids = [d["id"] for d in Dl]
    if not ids:
        return []
    meta = {l.id: l for l in x.db.query(Lead.id, Lead.lead_type, Lead.created_at, Lead.lead_created_at, Lead.opportunity_created_at, Lead.converted_tender_id)
            .filter(Lead.id.in_(ids)).all()}
    l2d = [(m.opportunity_created_at - (m.lead_created_at or m.created_at)).days for m in meta.values()
           if (m.lead_type or "lead") != "direct_opportunity" and m.opportunity_created_at and (m.lead_created_at or m.created_at)]
    bid_at: dict[int, tuple[datetime, Optional[int]]] = {}
    for t in x.db.query(Tender.id, Tender.lead_id, Tender.created_at).filter(Tender.is_deleted == False, Tender.lead_id.in_(ids)).all():
        if t.created_at and (t.lead_id not in bid_at or t.created_at < bid_at[t.lead_id][0]):
            bid_at[t.lead_id] = (t.created_at, t.id)
    for q in x.db.query(Quotation.lead_id, Quotation.created_at, Quotation.id).filter(Quotation.lead_id.in_(ids)).all():
        if q.created_at and (q.lead_id not in bid_at or q.created_at < bid_at[q.lead_id][0]):
            bid_at[q.lead_id] = (q.created_at, None)
    d2b = [(bid_at[i][0] - (meta[i].opportunity_created_at or meta[i].created_at)).days for i in bid_at if meta.get(i) and (meta[i].opportunity_created_at or meta[i].created_at)]
    order_at: dict[int, datetime] = {}
    for w in x.db.query(WorkOrder.lead_id, WorkOrder.tender_id, WorkOrder.created_at).filter(WorkOrder.lead_id.in_(ids)).all():
        if w.created_at:
            order_at[w.lead_id] = min(order_at.get(w.lead_id, w.created_at), w.created_at)
    t2l = {v[1]: k for k, v in bid_at.items() if v[1]}
    if t2l:
        for w in x.db.query(WorkOrder.tender_id, WorkOrder.created_at).filter(WorkOrder.tender_id.in_(list(t2l))).all():
            lid = t2l[w.tender_id]
            if w.created_at:
                order_at[lid] = min(order_at.get(lid, w.created_at), w.created_at)
    b2o = [(order_at[i] - bid_at[i][0]).days for i in order_at if i in bid_at]
    out = []
    for lbl, vals in (("Lead → Deal", l2d), ("Deal → Bid / quote", d2b), ("Bid / quote → Order", b2o)):
        vals = [v for v in vals if v >= 0]
        out.append({"l": lbl, "v": round(sum(vals) / len(vals)) if vals else None, "n": len(vals)})
    return out


def pipeline(x: RD.Ctx) -> dict[str, Any]:
    Dl, won, lost, opn = deals_fy(x)
    now = now_ist()
    for d in opn:
        d["days"] = (now - d["stage_since"]).days if d.get("stage_since") else None
        d["age"] = (x.today - d["created"]).days if d.get("created") else None
    cyc = sales_cycle(won)
    wr = len(won) / (len(won) + len(lost)) if (won or lost) else None
    cov = coverage(x, opn, won)
    order: list[str] = []
    for p in x.cache.get("pipes", []):
        for s in p["stages"]:
            if s["kind"] == "open" and s["name"] not in order:
                order.append(s["name"])
    month0 = date(x.today.year, x.today.month, 1)
    cal = []
    for i in range(6):
        y, m = month0.year + (month0.month - 1 + i) // 12, (month0.month - 1 + i) % 12 + 1
        cal.append({"l": date(y, m, 1).strftime("%b"), "v": round(S0([d for d in opn if (c := _day(d.get("close"))) and c.year == y and c.month == m], lambda d: D(d["value"]) / 100000), 2)})
    risk = sorted([d for d in opn if (d.get("prob") or 0) < 40 or (d["days"] or 0) > 30], key=lambda d: -(d["days"] or 0))
    return {"k": [K("Open pipeline", S0(opn, lambda d: d["value"]), "inr"), K("Coverage vs gap", f"{cov}×" if cov is not None else None, "text"),
                  K("Stalled > 21 d", sum(1 for d in opn if (d["days"] or 0) > 21), dc="twarn"),
                  K("Closing this month", sum(1 for d in opn if (c := _day(d.get("close"))) and 0 <= (c - x.today).days <= 30)),
                  K("Velocity", (S0(opn, lambda d: d["value"]) * wr / cyc) if (wr is not None and cyc) else None, "inr_day")],
            "c": [CH("Pipeline by stage", "hbars", [{"l": s, "v": S0([d for d in opn if d["stage"] == s], lambda d: d["value"])} for s in order
                                                    if any(d["stage"] == s for d in opn)], "inr", lw=120, vw=84),
                  CH("Deal age distribution", "bars", [{"l": lb, "v": sum(1 for d in opn if d["age"] is not None and a <= d["age"] < b)}
                                                       for lb, a, b in (("0-15", 0, 15), ("16-30", 15, 30), ("31-60", 30, 60), ("61-90", 60, 90), ("90+", 90, 10 ** 6))], "int", h=120),
                  CH("Close-date calendar", "bars", cal, "int", h=120, note="₹ L of open deals by expected close month")],
            "layout": [3],
            "table": {"t": "Deals at risk", "cols": [RD.C("name", "Deal", "deal"), RD.C("value", "Value", "inr", r=True), RD.C("stage", "Stage", "pill"),
                                                     RD.C("prob", "Win %", "int", r=True), RD.C("days", "Days in stage", "int", r=True), RD.C("owner", "Owner", "user")],
                      "rows": [{"id": d["id"], "name": d["name"], "value": d["value"], "stage": d["stage"], "prob": d.get("prob"), "days": d["days"], "owner": d.get("owner")} for d in risk]},
            "notes": {"Velocity": "Open pipeline × win rate ÷ avg sales cycle" if cyc else "Needs won deals with recorded dates",
                      "Stalled > 21 d": "Days since the deal entered its current stage"}}


def winloss(x: RD.Ctx) -> dict[str, Any]:
    Dl, won, lost, opn = deals_fy(x)
    comp = []
    if user_has_permission(x.db, x.cu, "competitors.view"):
        from app.services import directory_service as DS
        comp = DS.comp_list(x.db, view="All", q="", f={}, adv={}, sorts=[], offset=0, limit=5000).get("items", [])
    priced: set[str] = set()                                   # competitors with a priced loss analysis (else "Price vs ours" = —)
    if comp:
        from sqlalchemy import func as _f
        from app.models.all_models import TenderLossAnalysis as TLA
        priced = {(n or "").strip().lower() for (n,) in x.db.query(_f.lower(TLA.competitor_name))
                  .filter(TLA.competitor_amount > 0, TLA.our_bid_amount > 0, TLA.competitor_name.isnot(None)).distinct().all()}
    rows = [{"id": c["id"], "name": c["name"], "met": int(c.get("met") or 0), "won": int(c.get("won") or 0), "lost": int(c.get("lost") or 0),
             "wr": pct(int(c.get("lost") or 0), int(c.get("met") or 0)) if c.get("met") else None, "delta": float(c.get("delta") or 0) if (c.get("name") or "").strip().lower() in priced else None} for c in comp]
    return {"k": [K("Won", len(won), dc="tok"), K("Lost", len(lost)), K("Win rate", pct(len(won), len(won) + len(lost)) if (won or lost) else None, "pct"),
                  K("Avg won deal", S0(won, lambda d: d["value"]) / len(won) if won else None, "inr"),
                  K("Avg lost deal", S0(lost, lambda d: d["value"]) / len(lost) if lost else None, "inr")],
            "c": [CH("Lost reasons", "donut", [{"l": g["l"], "v": g["n"]} for g in grp(lost, lambda d: d.get("lostReason"))]),
                  CH("Competitor win share", "hbars", sorted([{"l": r["name"], "v": r["won"]} for r in rows], key=lambda z: -z["v"]), "int", lw=130, vw=30),
                  CH("Price delta vs competitors", "hbars", [{"l": r["name"], "v": abs(r["delta"]), "c": "var(--bw-ba)" if r["delta"] < 0 else "var(--bw-ok)"} for r in rows if r["delta"] is not None],
                     "pct", lw=130, vw=40)],
            "layout": [3],
            "table": {"t": "Head-to-head", "cols": [RD.C("name", "Competitor"), RD.C("met", "Bids met", "int", r=True), RD.C("won", "They won", "int", r=True),
                                                   RD.C("lost", "We won", "int", r=True), RD.C("wr", "Our win %", "bar"), RD.C("delta", "Price vs ours", "delta")],
                      "rows": rows},
            "notes": {"Head-to-head": "Competitor encounters across all recorded bids"}}


def customers(x: RD.Ctx) -> dict[str, Any]:
    C = RD.customers(x)
    srt = sorted(C, key=lambda c: -c["revenue"])
    T = S0(C, lambda c: c["revenue"])
    repeat: dict[Any, int] = defaultdict(int)
    for d in RD.deals(x):
        if d["stage_kind"] == "won" and d.get("customer_id"):
            repeat[d["customer_id"]] += 1
    need = sorted([c for c in C if c["health"] < 65], key=lambda c: -c["revenue"])
    return {"k": [K("Customers", len(C)), K("Avg health", round(sum(c["health"] for c in C) / len(C)) if C else None),
                  K("At risk", sum(1 for c in C if c["health"] < 55), dc="tbad"), K("Top 5 share", pct(S0(srt[:5], lambda c: c["revenue"]), T) if T else None, "pct"),
                  K("Repeat customers", sum(1 for c in C if repeat.get(c["id"], 0) > 1))],
            "c": [CH("Segmentation", "donut", [{"l": "Strategic (≥ ₹30 Cr)", "v": sum(1 for c in C if c["revenue"] >= 3e8)},
                                               {"l": "Growth (₹10–30 Cr)", "v": sum(1 for c in C if 1e8 <= c["revenue"] < 3e8)},
                                               {"l": "Maintain", "v": sum(1 for c in C if c["revenue"] < 1e8)}]),
                  CH("Health distribution", "bars", [{"l": lb, "v": sum(1 for c in C if a <= c["health"] < b)} for lb, a, b in
                                                     (("<40", 0, 40), ("40-55", 40, 55), ("55-70", 55, 70), ("70-85", 70, 85), ("85+", 85, 101))], "int", h=120),
                  CH("Revenue by industry type", "hbars", sorted([{"l": g["l"], "v": g["v"]} for g in grp(C, lambda c: c.get("type"), lambda c: c["revenue"])],
                                                                 key=lambda z: -z["v"]), "inr", lw=110, vw=84)],
            "layout": [3],
            "table": {"t": "Customers needing attention", "cols": [RD.C("name", "Customer", "link360"), RD.C("tier", "Tier"), RD.C("kam", "KAM", "user"),
                                                                  RD.C("revenue", "Revenue", "inr", r=True), RD.C("health", "Health", "bar")],
                      "rows": [{k: c[k] for k in ("id", "name", "tier", "kam", "revenue", "health")} for c in need]}}


def bids(x: RD.Ctx) -> dict[str, Any]:
    Tn = _bids_fy(x)
    dec = [b for b in RD.bids(x) if b["stage_kind"] in ("won", "lost") and x.inp(b["decided"])]
    wins = [b for b in Tn if b["stage_kind"] == "won"]
    prep = []
    ids = [b["id"] for b in Tn]
    if ids:
        for t in x.db.query(Tender.id, Tender.created_at, Tender.submission_date).filter(Tender.id.in_(ids)).all():
            if t.created_at and t.submission_date and t.submission_date <= x.today:
                d = (t.submission_date - t.created_at.date()).days
                if d >= 0:
                    prep.append(d)
    oems = []
    if user_has_permission(x.db, x.cu, "oems.view"):
        from app.models.all_models import OEM
        from app.services import directory_service as DS
        rows = DS.oem_list(x.db, view="All", category="", q="", f={}, adv={}, sorts=[], offset=0, limit=500).get("items", [])
        ratings = {o.id: o.rating for o in x.db.query(OEM.id, OEM.rating).all()}
        nb = defaultdict(int)
        for b in Tn:
            if b.get("oem") and b["oem"] != "—":
                nb[b["oem"].lower()] += 1
        oems = [{"id": o["id"], "name": o["name"], "category": o.get("category") or "", "bids": nb.get(o["name"].lower(), 0), "disc": o.get("discount"),
                 "auth": o.get("auth"), "rating": ratings.get(o["id"])} for o in rows]
        oems.sort(key=lambda o: (-o["bids"], o["name"]))
    return {"k": [K("Bids", len(Tn)), K("Hit rate", pct(sum(1 for b in dec if b["stage_kind"] == "won"), len(dec)) if dec else None, "pct"),
                  K("Bid-to-win", f"{len(Tn) / len(wins):.1f} : 1" if wins else None, "text"),
                  K("EMD cost / win", None, "inr"),
                  K("Avg prep time", f"{round(sum(prep) / len(prep))} days" if prep else None, "text")],
            "c": [CH("Hit rate by portal", "hbars", [{"l": g["l"], "v": pct(sum(1 for b in dec if (b.get("portal") or "—") == g["l"] and b["stage_kind"] == "won"), g["n"])}
                                                     for g in grp(dec, lambda b: b.get("portal"))], "pct", lw=110, vw=40),
                  CH("Value by OEM", "hbars", sorted([{"l": g["l"], "v": g["v"]} for g in grp(Tn, lambda b: b.get("oem"), lambda b: b["value"])],
                                                     key=lambda z: -z["v"])[:7], "inr", lw=110, vw=84),
                  CH("Bids by category", "donut", [{"l": g["l"], "v": g["n"]} for g in grp(Tn, lambda b: b.get("vertical") or "Uncategorised")])],
            "layout": [3],
            "table": {"t": "OEM scorecard", "cols": [RD.C("name", "OEM"), RD.C("category", "Category"), RD.C("bids", "Bids", "int", r=True), RD.C("disc", "Typical discount", "pctv"),
                                                    RD.C("auth", "Authorisation", "date"), RD.C("rating", "Rating", "int", r=True)],
                      "rows": oems},
            "notes": {"EMD cost / win": "EMD cost (bank charges / interest) isn't recorded on instruments", "Avg prep time": "Bid created → submission date",
                      "Bids by category": "Category = the bid's business vertical"}}


def revenue(x: RD.Ctx) -> dict[str, Any]:
    """Billed = invoices. Collections come from the Orders & Projects payment ledger (same as Collections & finance):
    collected = Finance-acknowledged receipts by bank credit date, outstanding = unpaid payment stages due to date."""
    Dl, won, lost, opn = deals_fy(x)
    W = RD.orders(x)
    inv = _invoices(x)
    L = RD.pay_ledger(x)
    ack = [r for r in L["receipts"] if r["status"] == "Acknowledged"]
    billed = sum((D(i.total_amount) for i in inv if x.inp(i.invoice_date)), Decimal(0))
    collected = sum((D(r["amount"]) for r in ack if x.inp(r["credited_on"])), Decimal(0))
    fell_due = sum((D(s_["amount"]) for s_ in L["stages"] if x.inp(s_["due"]) and _day(s_["due"]) <= x.today), Decimal(0))
    by_order_inv: dict[int, Decimal] = defaultdict(Decimal)
    for i in inv:
        by_order_inv[i.wo_id] += D(i.total_amount)
    by_order_out = {wid: D(o["receivable"]) for wid, o in L["orders"].items() if o["receivable"] > 0}
    live = [o for o in W if o.get("stage_kind") not in ("won", "lost") and o.get("stage_kind") != "closed"]
    backlog = [{**o, "bl": float(max(Decimal(0), D(o["value"]) - by_order_inv.get(o["id"], Decimal(0))))} for o in live]
    outstanding = sum(by_order_out.values(), Decimal(0))
    days = max(1, (min(x.end, x.today) - x.start).days + 1)
    dso = round(float(outstanding / fell_due) * days) if fell_due > 0 else None
    hist = _months(x, 6)
    big = sorted([{"id": o["id"], "ref": o["ref"], "customer": o.get("customer") or "", "o": float(by_order_out[o["id"]]), "progress": o.get("progress") or 0}
                  for o in W if by_order_out.get(o["id"], 0) > 0], key=lambda r: -r["o"])
    return {"k": [K("Booked", S0(won, lambda d: d["value"]), "inr"), K("Backlog", sum(b["bl"] for b in backlog), "inr"), K("Billed", float(billed), "inr"),
                  K("Collected", float(collected), "inr", "tok"), K("DSO", f"{dso} days" if dso is not None else None, "text")],
            "c": [{**CH("Bookings, billing, collection", "line", [], "int", h=140), "labels": [m[0] for m in hist],
                   "ser": [{"n": "Bookings", "c": 0, "v": _bm(won, lambda d: d["closed"], lambda d: D(d["value"]) / 100000, hist)},
                           {"n": "Billing", "c": 1, "v": _bm(inv, lambda i: i.invoice_date, lambda i: D(i.total_amount) / 100000, hist)},
                           {"n": "Collection", "c": 2, "v": _bm(ack, lambda r: r["credited_on"], lambda r: D(r["amount"]) / 100000, hist)}]},
                  CH("Backlog by contract type", "donut", [{"l": g["l"], "v": g["v"]} for g in grp(backlog, lambda o: o.get("type") or "Project / Supply", lambda o: o["bl"]) if g["v"]], "inr")],
            "layout": [2],
            "table": {"t": "Largest outstanding", "cols": [RD.C("ref", "Order", "order"), RD.C("customer", "Customer"), RD.C("o", "Outstanding", "inr", r=True),
                                                          RD.C("progress", "Progress", "bar")], "rows": big},
            "notes": {"DSO": "Outstanding (payment stages due, unpaid) ÷ payments fallen due in the FY × days elapsed" if dso is not None else "No payment stages fell due in this FY",
                      "Backlog": "Order value not yet invoiced on live orders",
                      "Collected": "Receipts acknowledged by Finance (bank credit date) in the FY"}}


def people(x: RD.Ctx) -> dict[str, Any]:
    if not user_has_permission(x.db, x.cu, "kam.view"):
        return {"k": [], "c": [], "layout": [2], "na": "Field Sales 360 access is needed"}
    from app.services import field_sales_service as FS
    kams = FS.kam_users(x.db, x.cu)
    ids = [k["id"] for k in kams]
    tg = FS.targets(x.db, ids, x.fy)
    dl = FS.deals(x.db, x.cu, ids)
    acts = FS.activities(x.db, ids, x.start, min(x.end, x.today))
    days14 = FS.window(min(x.today, x.end))
    a14 = FS.activities(x.db, ids, days14[0], days14[-1])
    rows = []
    for k in kams:
        won = S0([d for d in dl if d["owner_id"] == k["id"] and d["kind"] == "won" and x.inp(d["won_on"])], lambda d: d["value"])
        n = sum(1 for a in acts if a["uid"] == k["id"])
        t = tg[k["id"]]["target"]
        rows.append({"id": k["id"], "n": k["name"], "acts": n, "won": won, "e": won / n if n else None, "att": won / t * 100 if t else None,
                     "visits": sum(1 for a in a14 if a["uid"] == k["id"] and a["type"] == "Site Visit")})
    att = [r["att"] for r in rows if r["att"] is not None]
    top = max([r for r in rows if r["att"] is not None], key=lambda r: r["att"], default=None)
    live = [b for b in RD.bids(x) if b["stage_kind"] == "open"]
    pos = {k["id"]: i for i, k in enumerate(kams)}
    heat = [[0] * 14 for _ in kams]
    idx = {d: j for j, d in enumerate(days14)}
    for a in a14:
        if a["uid"] in pos and a["date"] in idx:
            heat[pos[a["uid"]]][idx[a["date"]]] += 1
    return {"k": [K("KAMs", len(kams)), K("Avg attainment", round(sum(att) / len(att)) if att else None, "pct"),
                  K("Activities / KAM / day", round(len(a14) / len(kams) / 14, 1) if kams else None, "num"),
                  K("Visits / KAM", round(sum(r["visits"] for r in rows) / len(rows), 1) if rows else None, "num"),
                  K("Top performer", top["n"].split(" ")[0] if top else None, "text")],
            "c": [{"t": "Activity vs result", "type": "table", "cols": [RD.C("n", "KAM", "user"), RD.C("acts", "Activities", "int", r=True),
                                                                         RD.C("won", "Achieved", "inr", r=True), RD.C("e", "₹ per activity", "inr", r=True)],
                   "rows": rows},
                  CH("Bid manager workload", "hbars", [{"l": g["l"], "v": g["n"]} for g in grp(live, lambda b: b.get("owner"))], "int", lw=130, vw=30)],
            "layout": [2],
            "heat": {"t": "Team activity heat-map", "rows": [k["name"] for k in kams], "cols": [d.isoformat() for d in days14], "v": heat},
            "notes": {"Activities / KAM / day": "Last 14 days", "Visits / KAM": "Site visits, last 14 days"}}


def geography(x: RD.Ctx) -> dict[str, Any]:
    C = RD.customers(x)
    st_of = {c["id"]: (c.get("state") or "") for c in C}
    if C and not any(st_of.values()):
        from app.models.all_models import Customer
        st_of = {i: (s or "") for i, s in x.db.query(Customer.id, Customer.billing_state).filter(Customer.id.in_(list(st_of))).all()}
    for c in C:
        c["state"] = st_of.get(c["id"]) or "Unspecified"
    states = sorted({c["state"] for c in C})
    rev = sorted([{"l": s, "v": round(S0([c for c in C if c["state"] == s], lambda c: c["revenue"]), 2)} for s in states], key=lambda z: -z["v"])
    rev = [r for r in rev if r["v"]]                             # states with booked revenue only
    Dl, won, lost, opn = deals_fy(x)
    from app.models.all_models import Customer
    cs = {i: (s or "Unspecified") for i, s in x.db.query(Customer.id, Customer.billing_state).filter(Customer.id.in_([d["customer_id"] for d in opn if d.get("customer_id")] or [-1])).all()}
    m0 = x.fy["m0"]
    grid: dict[str, list[float]] = defaultdict(lambda: [0.0] * 4)
    for d in opn:
        c = d.get("created")
        q = ((c.year - x.start.year) * 12 + c.month - m0) // 3 if c else None
        if q is None or not 0 <= q <= 3:
            continue
        grid[cs.get(d.get("customer_id"), "Unspecified")][q] += float(D(d["value"]))
    hs = sorted(grid, key=lambda s: -sum(grid[s]))
    mx = max([v for s in hs for v in grid[s]] or [0])
    Tn = _bids_fy(x)
    loc = {}
    tids = [b["customer_id"] for b in Tn if b.get("customer_id")]
    if tids:
        loc = {i: (c or s or "") for i, c, s in x.db.query(Customer.id, Customer.billing_city, Customer.billing_state).filter(Customer.id.in_(tids)).all()}
    return {"k": [], "c": [CH("Revenue by state", "hbars", rev, "inr", lw=120, vw=84)], "layout": [2],
            "heat": {"t": "Pipeline by state × quarter", "rows": hs, "cols": ["Q1", "Q2", "Q3", "Q4"], "v": [[round(v / mx * 100) if mx else 0 for v in grid[s]] for s in hs],
                     "raw": [grid[s] for s in hs], "fmt": "inr", "inline": True},
            "c2": [CH("Bids by location", "hbars", sorted([{"l": g["l"], "v": g["n"]} for g in grp(Tn, lambda b: loc.get(b.get("customer_id")) or "Unspecified")],
                                                          key=lambda z: -z["v"])[:8], "int", lw=120, vw=30)],
            "notes": {"Pipeline by state × quarter": "Open deals created in each FY quarter, by customer state", "Bids by location": "Customer city of each bid"}}


FN = {"Executive": executive, "Sales funnel & journeys": funnel, "Pipeline health": pipeline, "Win / loss & competitors": winloss, "Customers": customers,
      "Bids & OEM": bids, "Revenue & collections": revenue, "People & productivity": people, "Geography": geography}


def run(db: Session, cu: User, tab: str, fy: Optional[str]) -> dict[str, Any]:
    if not user_has_permission(db, cu, PERM):
        raise HTTPException(403, "You don't have access to Analytics")
    if tab not in FN:
        raise HTTPException(404, "Unknown analytics tab")
    x = ctx(db, cu, fy)
    out = FN[tab](x)
    from app.services.reports_v17_service import _jsonable, company_name
    if out.get("table"):
        out["table"]["rows"] = _jsonable(out["table"]["rows"])
    for c in out.get("c", []) + out.get("c2", []):
        if c.get("type") == "table":
            c["rows"] = _jsonable(c["rows"])
    return {"tab": tab, "fy": x.fy["y"], "fy_label": x.label, "start": x.start.isoformat(), "end": x.end.isoformat(), "company": company_name(db),
            "generated": now_ist().isoformat(timespec="minutes"), **out}
