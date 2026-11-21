"""Dashboards › Funnel (prototype v17 funnelBoard) – data for the dashboard's Funnel tab.

One normalised row per lead, deal, bid and quote the user may see (each module's own Data Visibility, then the dashboard's),
with the dimensions the prototype drills by (customer segment / sub-segment / parent customer from Customer 360, business
vertical, business model, owner, company), the record's stage and stage kind, value, dates, and – where the module records it –
days in the current stage against that stage's SLA (Process Designer). Orders are returned for the journey's last step.
Everything interactive (object, flow, period, drill path, focus, compare, what-if) is computed in the browser from these rows,
as the prototype does; nothing is estimated – unknown values are null.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from app.core.timezone import now_ist

logger = logging.getLogger(__name__)

KIND = {"won": "won", "lost": "lost"}


def _iso(v) -> Optional[str]:
    from app.services.dashboard_v9 import _d
    d = _d(v)
    return d.isoformat() if d else None


def _age(since) -> Optional[int]:
    if not since:
        return None
    try:
        return max(0, (now_ist().replace(tzinfo=None) - since.replace(tzinfo=None)).days)
    except Exception:
        return None


def _jsteps(r: dict) -> str:
    """Journey steps this record's journey has reached (L lead · D deal · T tender · Q quote · O order) – linked records."""
    try:
        return "".join(st.get("k", "") for st in (r.get("journey") or {}).get("steps", []) if st.get("done"))
    except AttributeError:
        return ""


def board_funnel(ctx) -> dict[str, Any]:
    from app.models.all_models import Lead, Tender
    from app.models.bids import BidProfile
    from app.models.quotes import QuoteProfile
    from app.services import dashboard_v9 as V
    from app.services import reports_v17_data as RD
    from app.services import bid_service as BS
    from app.services import lead360_service as LS
    from app.services import quote_service as QS
    from app.services.reports_v17_service import company_name

    db, x = ctx.db, V._v17(ctx)
    company = company_name(db) or ""

    # customer dimensions (Customer 360 – customer data visibility)
    cust: dict[int, dict] = {}
    if V._has(ctx, "customers.view"):
        try:
            cust = {c["id"]: c for c in RD.customers(x)}
        except Exception as exc:
            db.rollback()
            logger.info("funnel customer dimensions unavailable: %s", exc)

    def dims(customer_id, customer_name) -> dict[str, str]:
        c = cust.get(customer_id) if customer_id else None
        return {"segment": (c.get("segment") if c else None) or "Unmapped", "sub": (c.get("sub_segment") if c else None) or "Unmapped",
                "customer": (c.get("root") or c.get("name")) if c else (customer_name or "—")}

    rows: list[dict[str, Any]] = []
    flows: dict[str, list[dict]] = {}

    # ── leads ──
    if V._has(ctx, "leads.view"):
        L = V._keep(ctx, RD.leads(x), Lead, ("owner_id",))
        lead_sla = _fixed_sla(db, "lead")
        lst = [{"name": s["label"], "key": s["key"], "kind": s["kind"], "sla": lead_sla.get(s["key"]) or lead_sla.get(s["label"]) or 0} for s in LS.stages()]
        flows["leads"] = [{"key": "lead", "name": "Lead workflow", "stages": lst}]
        for r in L:
            st = LS.stage_of(r.get("stage")) or {}
            rows.append({"k": "leads", "id": r["id"], "ref": r.get("ref") or "", "name": r.get("title") or r.get("ref") or "", **dims(r.get("customer_id"), r.get("company")),
                         "vertical": r.get("vertical") or "Unmapped", "biz": r.get("model") or "Unmapped", "owner": r.get("owner") or "Unassigned", "owner_id": r.get("owner_id"),
                         "company": company, "stage": st.get("label") or r.get("stage") or "—", "kind": KIND.get(st.get("kind"), "open"),
                         "value": float(r.get("value") or 0), "date": _iso(r.get("created")), "closed": None, "age": None, "sla": None,
                         "flow": "lead", "converted": st.get("kind") == "won", "customer_id": r.get("customer_id"), "j": _jsteps(r), "reason": None,
                         "prob": r.get("score"), "due": _iso(r.get("follow_up")) if st.get("kind") == "open" else None})

    # ── deals ──
    deal_by_id: dict[int, dict] = {}
    if V._has(ctx, "opportunities.view"):
        D = V._keep(ctx, RD.deals(x), Lead, ("owner_id",))
        pipes = x.cache.get("pipes", []) or []
        sla_of = {(p["key"], s["name"]): int(s.get("sla") or 0) for p in pipes for s in p.get("stages", [])}
        flows["opps"] = [{"key": p["key"], "name": p["name"], "stages": [{"name": s["name"], "kind": s["kind"], "sla": int(s.get("sla") or 0)} for s in p.get("stages", [])]} for p in pipes]
        fkey = {p["name"]: p["key"] for p in pipes}
        for r in D:
            deal_by_id[r["id"]] = r
            fk = fkey.get(r.get("flow")) or r.get("pipeline") or ""
            kind = KIND.get(r.get("stage_kind"), "open")
            rows.append({"k": "opps", "id": r["id"], "ref": r.get("ref") or "", "name": r.get("name") or "", **dims(r.get("customer_id"), r.get("customer")),
                         "vertical": r.get("vertical") or "Unmapped", "biz": r.get("model") or "Unmapped", "owner": r.get("owner") or "Unassigned", "owner_id": r.get("owner_id"),
                         "company": company, "stage": r.get("stage") or "—", "kind": kind, "value": float(r.get("value") or 0),
                         "date": _iso(r.get("created")), "closed": _iso(r.get("closed")),
                         "age": _age(r.get("stage_since")) if kind == "open" else None, "sla": sla_of.get((fk, r.get("stage"))) or None, "flow": fk,
                         "prob": r.get("prob"), "due": None, "customer_id": r.get("customer_id"), "j": _jsteps(r),
                         "reason": (r.get("lostReason") or None) if kind == "lost" else None})

    # ── bids ──
    if V._has(ctx, "tenders.view"):
        B = V._keep(ctx, RD.bids(x), Tender, ("owner_id",))
        bfl = BS.flows(db)
        flows["tenders"] = [{"key": f["key"], "name": f["name"], "stages": [{"name": s["name"], "kind": s["kind"], "sla": int(s.get("sla") or 0)} for s in f["stages"]]} for f in bfl]
        sla_of = {(f["key"], s["name"]): int(s.get("sla") or 0) for f in bfl for s in f["stages"]}
        ids = [r["id"] for r in B] or [-1]
        since = {t: s for t, s in db.query(BidProfile.tender_id, BidProfile.stage_entered_at).filter(BidProfile.tender_id.in_(ids)).all()}
        lead_of = {t: l for t, l in db.query(Tender.id, Tender.lead_id).filter(Tender.id.in_(ids)).all()}
        for r in B:
            kind = KIND.get(r.get("stage_kind"), "open")
            d = deal_by_id.get(lead_of.get(r["id"]))
            rows.append({"k": "tenders", "id": r["id"], "ref": r.get("ref") or "", "name": r.get("title") or "", **dims(r.get("customer_id"), r.get("customer")),
                         "vertical": r.get("vertical") or (d.get("vertical") if d else "") or "Unmapped", "biz": (d.get("model") if d else "") or "Unmapped",
                         "owner": r.get("owner") or "Unassigned", "owner_id": r.get("owner_id"), "company": company, "stage": r.get("stage") or "—", "kind": kind,
                         "value": float(r.get("value") or 0), "date": _iso(r.get("published")), "closed": _iso(r.get("decided")) if kind != "open" else None,
                         "age": _age(since.get(r["id"])) if kind == "open" else None, "sla": sla_of.get((r.get("flow_key"), r.get("stage"))) or None,
                         "flow": r.get("flow_key") or "", "prob": None, "due": _iso(r.get("submit")) if kind == "open" else None,
                         "customer_id": r.get("customer_id"), "j": _jsteps(r), "reason": None})

    # ── quotes ──
    Q = V.quotes(ctx)
    if Q:
        qst = QS.stages(db)
        flows["quotes"] = [{"key": "quote", "name": "Quote workflow", "stages": [{"name": s["name"], "kind": s["kind"], "sla": int(s.get("sla") or 0)} for s in qst]}]
        sla_q = {s["name"]: int(s.get("sla") or 0) for s in qst}
        since = {q: s for q, s in db.query(QuoteProfile.quote_id, QuoteProfile.stage_entered_at).filter(QuoteProfile.quote_id.in_([r["id"] for r in Q])).all()}
        from app.models.all_models import Quotation
        made = {i: c for i, c in db.query(Quotation.id, Quotation.created_at).filter(Quotation.id.in_([r["id"] for r in Q])).all()}
        for r in Q:
            kind = KIND.get(r.get("stage_kind"), "open")
            d = deal_by_id.get(r.get("lead_id"))
            rows.append({"k": "quotes", "id": r["id"], "ref": r.get("ref") or "", "name": r.get("subject") or r.get("ref") or "", **dims(r.get("customer_id"), r.get("customer")),
                         "vertical": (d.get("vertical") if d else "") or "Unmapped", "biz": (d.get("model") if d else "") or "Unmapped",
                         "owner": r.get("owner") or "Unassigned", "owner_id": r.get("owner_id"), "company": company, "stage": r.get("stage") or "—", "kind": kind,
                         "value": float(r.get("value") or 0), "date": _iso(made.get(r["id"])),
                         "closed": _iso(since.get(r["id"])) if kind != "open" else None,
                         "age": _age(since.get(r["id"])) if kind == "open" else None, "sla": sla_q.get(r.get("stage")) or None, "flow": "quote",
                         "prob": None, "due": r.get("valid_till") if kind == "open" else None, "customer_id": r.get("customer_id"), "j": _jsteps(r), "reason": None})

    # ── orders (whole journey: last step) ──
    orders = []
    for o in V.orders(ctx):
        orders.append({"id": o["id"], "ref": o["number"], "value": o["value"], **dims(o.get("customer_id"), o.get("customer")),
                       "vertical": "Unmapped", "biz": "Unmapped", "owner": o.get("pm") or "Unassigned", "company": company, "stage": o["stage"], "flow_name": "Orders"})

    names = {(k, f["key"]): f["name"] for k, fl in flows.items() for f in fl}
    for r in rows:
        r["flow_name"] = names.get((r["k"], r["flow"])) or r["flow"] or "—"
        r["stuck"] = bool(r["kind"] == "open" and r["sla"] and r["age"] is not None and r["age"] > r["sla"])
    return {"rows": rows, "orders": orders, "flows": flows, "company": company, "today": ctx.today.isoformat(),
            "objects": {k: True for k in ("leads", "opps", "tenders", "quotes") if k in flows}}


def _fixed_sla(db, workflow: str) -> dict[str, int]:
    """SLA days of the fixed Lead / Quote flows (Process Designer → process_stage_extras)."""
    try:
        from app.models.process import ProcessStageExtra
        return {r.stage_ref: int(r.sla_days) for r in db.query(ProcessStageExtra.stage_ref, ProcessStageExtra.sla_days).filter(
            ProcessStageExtra.workflow == workflow, ProcessStageExtra.sla_days.isnot(None)).all()}
    except Exception as exc:
        db.rollback()
        logger.info("fixed-flow SLA unavailable: %s", exc)
        return {}


def module_data(ctx) -> dict[str, Any]:
    """Intelligence → Funnel & analytics (all six views): the funnel rows plus Customer 360 accounts (segment, sub-segment,
    main customer, FY revenue, health, KAM), the FY sales target and the Forecasts commit / best-case thresholds."""
    from app.services import analytics_v17_service as A
    from app.services import dashboard_v9 as V
    from app.services import reports_v17_data as RD
    out = board_funnel(ctx)
    x = V._v17(ctx)
    customers = []
    if V._has(ctx, "customers.view"):
        try:
            for c in RD.customers(x):
                customers.append({"id": c["id"], "name": c.get("name") or "", "parent_id": c.get("parent_id"), "root_id": c.get("root_id") or c["id"],
                                  "root": c.get("root") or c.get("name") or "", "segment": c.get("segment") or "Unmapped",
                                  "sub": c.get("sub_segment") or "Unmapped", "level": c.get("level") or "", "revenue": float(c.get("revenue") or 0),
                                  "health": c.get("health"), "kam": c.get("kam") or ""})
        except Exception as exc:
            ctx.db.rollback()
            logger.info("funnel customers unavailable: %s", exc)
    try:
        target = A.team_target(x)
    except Exception as exc:
        ctx.db.rollback()
        logger.info("funnel target unavailable: %s", exc)
        target = None
    try:
        from app.services import forecast_service as FS
        cfg = FS.config(ctx.db)
        thr = {"commit": float(cfg["commit_min"]), "best": float(cfg["best_min"])}
    except Exception:
        ctx.db.rollback()
        thr = {"commit": 70.0, "best": 40.0}
    out.update({"customers": customers, "target": float(target) if target else None, "fy": x.fy.get("label") if getattr(x, "fy", None) else None,
                "fy_start": _iso(x.fy.get("start")) if getattr(x, "fy", None) else None, "fy_end": _iso(x.fy.get("end")) if getattr(x, "fy", None) else None,
                "thresholds": thr})
    return out
