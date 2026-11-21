"""Customer 360 view model (prototype v17 cust360): header, KPI cards and every tab, from the tenant's records."""
from __future__ import annotations

import logging
from collections import Counter, defaultdict
from datetime import timedelta
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.core.timezone import today_ist
from app.models.all_models import (
    EMDBG, ApprovalRequest, Customer, KAMActivity, Lead, Quotation, Tender, User,
)
from app.services import customer360_service as S
from app.services import inbox_service as records

logger = logging.getLogger(__name__)

MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def last6() -> list[tuple[str, str]]:
    t = today_ist()
    out = []
    y, m = t.year, t.month
    for _ in range(6):
        out.insert(0, (f"{y}-{m:02d}", MON[m - 1]))
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    return out


def _scoped(db: Session, user: User, module: str, model, cid: int) -> list:
    try:
        q = records._record_query(db, user, module)
        return q.filter(model.customer_id == cid).all() if q is not None else []
    except Exception as exc:
        logger.warning("360 %s failed: %s", module, exc)
        db.rollback()
        return []


def related(db: Session, user: User, c: Customer) -> dict[str, Any]:
    """Records the user may see in each module, for this customer."""
    from app.services.calendar_service import _emdbg_query, _orders_query
    X: dict[str, Any] = {
        "leads": _scoped(db, user, "leads", Lead, c.id),
        "opps": _scoped(db, user, "opportunities", Lead, c.id),
        "tenders": _scoped(db, user, "tenders", Tender, c.id),
        "quotes": _scoped(db, user, "quotations", Quotation, c.id),
    }
    try:
        q = _emdbg_query(db, user)
        X["emd"] = q.filter(EMDBG.customer_id == c.id).order_by(EMDBG.expiry_date.desc()).all() if q is not None else []
    except Exception as exc:
        logger.warning("360 emdbg failed: %s", exc); db.rollback(); X["emd"] = []
    try:
        oq = _orders_query(db, user)
        allowed = {t.id for t in oq.filter(Tender.customer_id == c.id).all()} if oq is not None else set()
        X["orders"] = [o for o in S.order_rows(db, {c.id}) if (o["kind"] == "tender" and o["id"] in allowed) or (o["kind"] == "wo" and oq is not None)]
    except Exception as exc:
        logger.warning("360 orders failed: %s", exc); db.rollback(); X["orders"] = []
    X["acts"] = []
    if S.can(db, user, "kam.view"):
        try:
            from app.utils.data_scope import apply_data_scope
            q = db.query(KAMActivity).filter(KAMActivity.customer_id == c.id)
            q = apply_data_scope(db, q, user, "kam", KAMActivity.user_id, KAMActivity.on_behalf_of)
            X["acts"] = q.order_by(KAMActivity.activity_date.desc(), KAMActivity.id.desc()).limit(300).all()
        except Exception as exc:
            logger.warning("360 activities failed: %s", exc); db.rollback()
    return X


def _stage_tender(t: Tender) -> str:
    return t.result if t.result in ("Won", "Lost", "Cancelled") else (t.tender_status or "Aligned")


def journeys(X: dict[str, Any]) -> list[dict[str, Any]]:
    """Lead → Deal → Bid / Quote → Order chains linked through lead_id / tender_id."""
    leads = {l.id: l for l in X["leads"] + X["opps"]}
    tenders, quotes, orders = X["tenders"], X["quotes"], X["orders"]
    used_t, used_q = set(), set()
    out = []

    def order_for(tids: set[int]) -> Optional[dict]:
        return next((o for o in orders if o["kind"] == "tender" and o["id"] in tids), None)

    def build(jid, lead, deal, ts, qs, kind, rid):
        tids = {t.id for t in ts}
        o = order_for(tids)
        ev = []
        if lead:
            ev.append((S.as_date(lead.lead_created_at or lead.created_at), f"Lead {lead.lead_ref_id or lead.id} created – {lead.lead_title}"))
        if deal and deal.opportunity_created_at:
            ev.append((S.as_date(deal.opportunity_created_at), f"Deal {deal.opportunity_ref_id or deal.lead_ref_id} opened"))
        for t in ts:
            ref = t.tender_num or f"TND-{t.id}"
            if t.published_date:
                ev.append((t.published_date, f"Bid {ref} published"))
            if t.submission_date:
                ev.append((t.submission_date, f"Bid {ref} due for submission"))
            if t.result in ("Won", "Lost") and t.result_date:
                ev.append((t.result_date, f"Bid {ref} {t.result.lower()}"))
        for q in qs:
            ev.append((S.as_date(q.created_at), f"Quote {q.quotation_number} {q.status.lower() if q.status else 'created'}"))
        if o and o["date"]:
            ev.append((o["date"], f"Order {o['ref']} – value {round(o['value'])}"))
        stage = (o and "Order") or (ts and _stage_tender(ts[-1])) or (qs and qs[-1].status) or (deal and deal.status) or (lead and lead.status) or "—"
        steps = [
            {"k": "L", "label": "Lead", "done": bool(lead), "stage": lead.status if lead else None,
             "route": records.record_route("leads", lead.id) if lead and lead not in X["opps"] else None},
            {"k": "D", "label": "Deal", "done": bool(deal), "stage": deal.status if deal else None,
             "route": records.record_route("opportunities", deal.id) if deal else None},
            ({"k": "Q", "label": "Quote", "done": True, "stage": qs[-1].status, "route": "/quotations"} if qs and not ts else
             {"k": "T", "label": "Tender", "done": bool(ts), "stage": _stage_tender(ts[-1]) if ts else None,
              "route": records.record_route("tenders", ts[-1].id) if ts else None}),
            {"k": "O", "label": "Order", "done": bool(o), "stage": o["status"] if o else None, "route": o["route"] if o else None},
        ]
        out.append({"id": jid, "stage": stage, "kind": kind, "record_id": rid, "steps": steps,
                    "timeline": [{"date": S.iso(d), "text": t} for d, t in sorted((e for e in ev if e[0]), key=lambda e: e[0])]})

    for l in sorted(leads.values(), key=lambda x: x.id):
        ts = [t for t in tenders if t.lead_id == l.id]
        qs = [q for q in quotes if q.lead_id == l.id or (q.tender_id and q.tender_id in {t.id for t in ts})]
        used_t |= {t.id for t in ts}; used_q |= {q.id for q in qs}
        is_deal = l in X["opps"]
        build(l.opportunity_ref_id if is_deal and l.opportunity_ref_id else (l.lead_ref_id or f"LD-{l.id}"),
              l, l if is_deal else None, ts, qs, "opps" if is_deal else "leads", l.id)
    for t in tenders:
        if t.id in used_t:
            continue
        qs = [q for q in quotes if q.tender_id == t.id and q.id not in used_q]
        used_q |= {q.id for q in qs}
        build(t.tender_num or f"TND-{t.id}", None, None, [t], qs, "tenders", t.id)
    return out


def journey_index(J: list[dict]) -> dict[tuple[str, int], dict]:
    idx = {}
    for j in J:
        idx[(j["kind"], j["record_id"])] = j
    return idx


def build_360(db: Session, user: User, c: Customer, all_customers: list[Customer], M_all: dict[int, dict]) -> dict[str, Any]:
    today = today_ist()
    m = S.metrics_for(M_all, c.id)
    P = S.profiles(db)
    fam = S.Family(db)
    bands = S.value_bands(all_customers, M_all)
    X = related(db, user, c)
    names = S.user_names(db, [c.assigned_to] + [a.user_id for a in X["acts"]] + [t.assigned_to for t in X["tenders"]])
    kam_id, own, from_id = fam.kam(c.id, P)
    kam_name = (S.user_names(db, [kam_id]).get(kam_id) if kam_id else None)
    path = fam.path(c.id)
    level = S.level_of(c, P)
    prof = P.get(c.id)
    credit = (c.custom_data or {}).get("credit_limit") if isinstance(c.custom_data, dict) else None
    seg_name, sub_name = S.segment_of(c)

    header = {
        "id": c.id, "ref": S.cust_ref(c.id), "name": c.customer_name, "health": m["health"],
        "level": level, "badge": S.LEVEL_BADGE.get(level, ("•", "l5")),
        "path": [{"id": i, "name": fam.by_id[i].customer_name} for i in path],
        "below": len(fam.desc(c.id)),
        "type": (c.customer_vertical or "").strip() or "—", "location": ", ".join(x for x in (c.billing_city, c.billing_state) if x) or "—",
        "since": c.created_at.year if c.created_at else None,
        "kam": {"id": kam_id, "name": kam_name, "own": own, "from": fam.by_id[from_id].customer_name if from_id else None},
        "tier": S.TIER_OF.get(c.account_potential or "Medium", "B"), "segment": seg_name, "sub_segment": sub_name, "vertical": S.vertical_of(c), "value_band": bands.get(c.id, "Maintain"),
        "gst": c.gst_number or None, "credit_limit": float(credit) if isinstance(credit, (int, float, str)) and str(credit).replace(".", "", 1).isdigit() else None,
        "status": c.account_status or "Prospect", "approval_status": c.approval_status,
        "kam_mode": (prof.kam_mode if prof and prof.kam_mode else ("Own KAM")), "parent_id": fam.parent(c.id),
        "primary_email": None,
    }
    last = m["last_touch"]
    kpis = [
        {"l": "Lifetime revenue", "v": m["lifetime"], "f": "inr"},
        {"l": "FY revenue", "v": m["fy"], "f": "inr"},
        {"l": "Open pipeline", "v": m["open_pipe"], "f": "inr"},
        {"l": "Win rate", "v": m["win_rate"], "f": "pct", "note": f"{m['won']} won · {m['lost']} lost"},
        {"l": "Live bids", "v": m["live_bids"], "f": "int"},
        {"l": "Active orders", "v": m["active_orders"], "f": "int"},
        {"l": "Outstanding", "v": m["outstanding"], "f": "inr", "dc": "twarn" if m["outstanding"] else ""},
        {"l": "Guarantees blocked", "v": m["guarantees"], "f": "inr"},
        {"l": "Last touch", "v": (today - last).days if last else None, "f": "ago"},
    ]

    # ── deals & bids
    J = journeys(X)
    JI = journey_index(J)

    def jinfo(kind, rid):
        j = JI.get((kind, rid))
        return {"id": j["id"], "dots": [s["done"] for s in j["steps"]]} if j else None

    deals = [{"id": o.id, "name": o.lead_title, "value": S.f(o.est_value), "stage": o.status, "journey": jinfo("opps", o.id),
              "route": records.record_route("opportunities", o.id)} for o in X["opps"]]
    bids = [{"id": t.id, "ref": t.tender_num or f"TND-{t.id}", "value": S.f(t.est_value), "stage": _stage_tender(t),
             "deadline": S.iso(t.submission_date), "route": records.record_route("tenders", t.id)} for t in X["tenders"]]
    quotes = [{"id": q.id, "ref": f"{q.quotation_number}-R{q.revision_number or 1}" if q.quotation_number else f"QT-{q.id}",
               "subject": q.subject or "", "stage": q.status, "route": "/quotations"} for q in X["quotes"]]
    leads = [{"id": l.id, "ref": l.lead_ref_id or f"LD-{l.id}", "interest": l.lead_title, "stage": l.status,
              "route": records.record_route("leads", l.id)} for l in X["leads"]]

    # ── orders & billing
    orders = X["orders"]
    wo_ids = [o["wo_id"] for o in orders if o["wo_id"]]
    invs = S.invoice_rows(db, wo_ids)
    inv_by_wo = defaultdict(float)
    for i in invs:
        inv_by_wo[i.wo_id] += S.f(i.total_amount)
    order_out = [{"id": o["id"], "ref": o["ref"], "type": o["type"], "value": o["value"], "progress": o["progress"],
                  "billed": round(inv_by_wo.get(o["wo_id"], 0) / o["value"] * 100) if o["value"] and o["wo_id"] else 0,
                  "status": o["status"], "route": o["route"]} for o in orders]
    ord_val = {o["wo_id"]: (o["value"], o["ref"]) for o in orders if o["wo_id"]}
    # payment schedule = the Orders & Projects payment stages (same rows as Collections & finance)
    from app.services.order_payment_service import ledger
    LG = ledger(db, wo_ids)
    schedule = [{"milestone": f"{st['stage']} · {ord_val.get(st['wo_id'], (0, st['order']))[1] or st['order']}", "pct": st["pct"], "amount": st["amount"],
                 "due": st["due"], "received": st["received"], "awaiting": st["awaiting"], "balance": st["balance"], "status": st["status"], "wo_id": st["wo_id"]}
                for st in sorted(LG["stages"], key=lambda z: (z["due"] or "9999", z["order"]))]
    billing = {
        "order_value": sum(o["value"] for o in orders), "billed": m["billed"], "collected": m["collected"], "awaiting": m.get("awaiting", 0.0),
        "outstanding": m["outstanding"], "due": m.get("due", 0.0), "avg_delay": round(m["avg_delay"]) if m["avg_delay"] is not None else None,
        "invoices": len(invs), "receipts": sum(1 for r in LG["receipts"] if r["status"] == "Acknowledged"),
    }

    # ── guarantees
    tender_ref = {t.id: t.tender_num or f"TND-{t.id}" for t in X["tenders"]}
    guarantees = [{"id": e.id, "type": e.instrument_type, "ref": e.reference_num, "bid": tender_ref.get(e.tender_id) or e.tender_num or "—",
                   "bank": e.bank_name or "—", "amount": S.f(e.amount), "valid_until": S.iso(e.expiry_date), "status": e.status,
                   "route": "/emdbg"} for e in X["emd"]]

    # ── activity & comms
    acts = [{"id": a.id, "date": S.iso(a.activity_date), "type": a.activity_type, "notes": a.subject + (f" – {a.description}" if a.description else ""),
             "by": names.get(a.user_id, ""), "outcome": a.outcome or a.status, "status": a.status, "route": "/kam"} for a in X["acts"]]
    emails = email_rows(db, user, c)

    # ── overview
    funnel = [
        {"l": "Leads", "v": len(X["leads"])}, {"l": "Deals", "v": len(X["opps"])},
        {"l": "Bids + quotes", "v": len(X["tenders"]) + len(X["quotes"])},
        {"l": "Won", "v": sum(1 for t in X["tenders"] if t.result == "Won") + sum(1 for q in X["quotes"] if q.status == "Accepted")},
        {"l": "Orders", "v": len(orders)},
    ]
    months = last6()
    rev6 = [{"l": lab, "v": round(sum(o["value"] for o in orders if o["date"] and o["date"].strftime("%Y-%m") == key) / 1e5, 2)} for key, lab in months]
    stages = Counter()
    for o in X["opps"]:
        if o.status == "Opportunity Created":
            stages["Opportunity"] += S.f(o.est_value)
    for t in X["tenders"]:
        if t.result in (None, "Pending") and t.tender_status != "Closed":
            stages[t.tender_status or "Aligned"] += S.f(t.est_value)
    pipeline = [{"l": k, "v": v} for k, v in stages.items() if v]
    open_items = []
    for t in X["tenders"]:
        if t.result in (None, "Pending") and t.tender_status != "Closed" and t.submission_date:
            d = (t.submission_date - today).days
            open_items.append({"t": f"Bid {t.tender_num or t.id}", "s": f"due in {d} d · {t.tender_status}" if d >= 0 else f"due date passed {-d} d ago · {t.tender_status}",
                               "route": records.record_route("tenders", t.id), "sort": d})
    for e in X["emd"]:
        if e.status == "Active" and e.expiry_date and (e.expiry_date - today).days <= 45:
            open_items.append({"t": f"{e.instrument_type} {e.reference_num}", "s": f"expires {S.iso(e.expiry_date)}", "route": "/emdbg", "sort": (e.expiry_date - today).days})
    try:
        rec = [("tenders", t.id) for t in X["tenders"]] + [("leads", l.id) for l in X["leads"] + X["opps"]] + [("quotations", q.id) for q in X["quotes"]] + [("customers", c.id)]
        mods = {k for k, _ in rec}
        pend = db.query(ApprovalRequest).filter(ApprovalRequest.status == "pending", ApprovalRequest.module_key.in_(mods),
                                                ApprovalRequest.record_id.in_([i for _, i in rec] or [-1])).all()
        keys = set(rec)
        for a in pend:
            if (a.module_key, a.record_id) in keys:
                open_items.append({"t": f"Approval #{a.id}", "s": f"{a.module_key} {a.action_key or ''} awaiting approval".strip(), "route": "/approvals", "sort": 0})
    except Exception as exc:
        logger.info("360 approvals skipped: %s", exc); db.rollback()
    open_items = sorted(open_items, key=lambda x: x["sort"])[:6]
    tl = [(a.activity_date, f"{a.activity_type} – {a.subject}", names.get(a.user_id, ""), "Activity") for a in X["acts"]]
    tl += [(t.published_date or S.as_date(t.created_at), f"Bid {t.tender_num or t.id} published ({_stage_tender(t)})", names.get(t.assigned_to, ""), "Bid") for t in X["tenders"]]
    tl += [(o["date"], f"Order {o['ref']} started – value {round(o['value'])}", "", "Order") for o in orders]
    tl += [(S.as_date(e["sent"]), f"Email: {e['subject']}", e["from"], "Email") for e in emails if e.get("sent")]
    timeline = [{"date": S.iso(d), "text": t, "by": b, "kind": k} for d, t, b, k in sorted((x for x in tl if x[0]), key=lambda x: x[0], reverse=True)[:8]]

    # ── position vs peers (segment = value band, vertical)
    band, vert = header["value_band"], header["vertical"]
    in_s = [x for x in all_customers if bands.get(x.id) == band]
    in_v = [x for x in all_customers if S.vertical_of(x) == vert]
    avg = lambda L, k: (sum(S.metrics_for(M_all, x.id)[k] for x in L) / len(L)) if L else 0  # noqa: E731
    position = {
        "band": band, "vertical": vert,
        "rank": sorted(in_s, key=lambda x: -S.metrics_for(M_all, x.id)["fy"]).index(c) + 1 if c in in_s else None, "of": len(in_s),
        "rows": [{"m": lab, "f": fmt, "t": m[k], "s": avg(in_s, k), "v": avg(in_v, k), "hi": hi}
                 for lab, k, fmt, hi in [("FY revenue", "fy", "inr", 1), ("Open pipeline", "open_pipe", "inr", 1), ("Health score", "health", "int", 1),
                                         ("Win rate", "win_rate", "pct", 1), ("Outstanding", "outstanding", "inr", 0)]],
    }

    # ── health & risk
    drivers = [{"n": n, "v": v, "why": why} for n, v, why in S.health_drivers(m)]
    risks = insights(db, c, m, X, orders, today)

    return {
        "header": header, "kpis": kpis,
        "overview": {"funnel": funnel, "revenue6": rev6, "pipeline": pipeline, "position": position, "open_items": open_items, "timeline": timeline},
        "journeys": J,
        "contacts": S.contact_list(db, c.id),
        "deals": deals, "bids": bids, "quotes": quotes, "leads": leads,
        "orders": order_out, "schedule": schedule, "billing": billing,
        "guarantees": guarantees, "activities": acts, "emails": emails,
        "plan": plan_of(db, c.id, P.get(c.id)),
        "health": {"score": m["health"], "drivers": drivers, "risks": risks},
        "can": {"update": S.can(db, user, "customers.update"), "delete": S.can(db, user, "customers.delete"),
                "log_activity": S.can(db, user, "kam.create"), "email": S.can(db, user, "notifications.view"),
                "new_deal": S.can(db, user, "opportunities.create") or S.can(db, user, "leads.create"),
                "documents": S.can(db, user, "document_management.view"), "create": S.can(db, user, "customers.create")},
    }


def insights(db: Session, c: Customer, m: dict, X: dict, orders: list[dict], today) -> list[dict[str, str]]:
    out = []
    closed = m["won"] + m["lost"]
    if not closed:
        out.append({"t": "in", "s": "No closed bids or quotes yet – the first win is still to come."})
    elif m["win_rate"] < 50:
        out.append({"t": "wa", "s": f"Win rate here is {m['win_rate']}% – review pricing and technical positioning."})
    else:
        out.append({"t": "ok", "s": f"Win rate {m['win_rate']}% – {m['won']} won, {m['lost']} lost."})
    if m["last_touch"]:
        d = (today - m["last_touch"]).days
        out.append({"t": "ba", "s": f"No customer touch for {d} days – schedule a visit."} if d > 20 else {"t": "ok", "s": f"Last interaction {d} days ago."})
    else:
        out.append({"t": "ba", "s": "No interactions logged yet – plan a first visit."})
    if m.get("due") and m["outstanding"] > m["due"] * .1:
        out.append({"t": "wa", "s": f"Receivable of ₹{m['outstanding']:,.0f} due and not yet collected – follow up on payments."})
    elif m["billed"]:
        out.append({"t": "ok", "s": "Payments are on track."})
    if orders and not any(str(o["type"]).upper() in ("AMC", "SERVICE") for o in orders):
        out.append({"t": "in", "s": "Cross-sell: no AMC / service contract yet on delivered projects."})
    try:
        from app.models.all_models import TenderLossAnalysis, TenderTechBidBidder
        tids = [t.id for t in X["tenders"]]
        names: Counter = Counter()
        if tids:
            for la in db.query(TenderLossAnalysis).filter(TenderLossAnalysis.tender_id.in_(tids)).all():
                for n in (la.competitor_name, la.l1_company):
                    if n and n.strip():
                        names[n.strip()] += 1
            for b in db.query(TenderTechBidBidder.bidder_name).filter(TenderTechBidBidder.tender_id.in_(tids)).all():
                if b[0] and b[0].strip():
                    names[b[0].strip()] += 1
        if names:
            top, n = names.most_common(1)[0]
            out.append({"t": "wa", "s": f"Competitor presence: {top} appears in {n} bid record{'s' if n > 1 else ''} at this account."})
    except Exception as exc:
        logger.info("360 competitors skipped: %s", exc); db.rollback()
    ends = sorted(o["warranty_expiry"] for o in orders if o.get("warranty_expiry") and o["warranty_expiry"] >= today)
    if ends:
        out.append({"t": "in", "s": f"Renewal / re-tender window: the next warranty ends in {(ends[0] - today).days} days ({S.iso(ends[0])})."})
    return out


def email_rows(db: Session, user: User, c: Customer) -> list[dict[str, Any]]:
    """The user's own mailbox copies linked to this customer or exchanged with its contacts."""
    try:
        from app.models.all_models import CustomerContact
        from app.models.inbox import MailMessage
        emails = {e.lower() for (e,) in db.query(CustomerContact.office_email).filter(CustomerContact.customer_id == c.id, CustomerContact.office_email.isnot(None)).all() if e}
        conds = [(MailMessage.link_module == "customers") & (MailMessage.link_record_id == c.id)]
        for e in list(emails)[:30]:
            conds.append(MailMessage.from_email == e)
            conds.append(MailMessage.to_emails.like(f"%{e}%"))
        from sqlalchemy import or_
        rows = (db.query(MailMessage).filter(MailMessage.owner_user_id == user.id, MailMessage.deleted_at.is_(None),
                                             MailMessage.folder.notin_(("Drafts", "Trash")), or_(*conds))
                .order_by(MailMessage.created_at.desc()).limit(50).all())
        return [{"id": r.id, "subject": r.subject or "(no subject)", "from": r.from_name or r.from_email, "sent": (r.sent_at or r.created_at).isoformat() if (r.sent_at or r.created_at) else None,
                 "opens": int(r.open_count or 0)} for r in rows]
    except Exception as exc:
        logger.info("360 emails skipped: %s", exc); db.rollback()
        return []


def plan_of(db: Session, cid: int, p) -> dict[str, Any]:
    by = S.user_names(db, [p.plan_updated_by]).get(p.plan_updated_by) if p and p.plan_updated_by else None
    return {"goal": (p.plan_goal if p else None) or "", "strategy": (p.plan_strategy if p else None) or "",
            "risks": (p.plan_risks if p else None) or "", "white_space": (p.plan_white_space if p else None) or "",
            "updated_at": p.plan_updated_at.isoformat() if p and p.plan_updated_at else None, "updated_by": by}


# ─── Segment & vertical tab ───────────────────────────────────────────────────

def segment_tab(db: Session, c: Customer, all_customers: list[Customer], M_all: dict[int, dict]) -> dict[str, Any]:
    bands = S.value_bands(all_customers, M_all)
    band, vert = bands.get(c.id, "Maintain"), S.vertical_of(c)
    mt = lambda x: S.metrics_for(M_all, x.id)  # noqa: E731
    in_s = [x for x in all_customers if bands.get(x.id) == band]
    in_v = [x for x in all_customers if S.vertical_of(x) == vert]
    tot = sum(mt(x)["lifetime"] for x in all_customers) or 0
    rk = lambda L: (sorted(L, key=lambda x: -mt(x)["lifetime"]).index(c) + 1) if c in L else None  # noqa: E731
    share = lambda a, b: round(a / b * 100) if b else 0  # noqa: E731
    me = mt(c)

    def peers(L):
        rows = []
        for lab, k, fmt, hi in [("FY revenue", "fy", "inr", 1), ("Open pipeline", "open_pipe", "inr", 1), ("Orders", "orders", "num", 1),
                                ("Win rate", "win_rate", "pct", 1), ("Health score", "health", "int", 1), ("Outstanding", "outstanding", "inr", 0)]:
            vs = [mt(x)[k] for x in L] or [0]
            a = sum(vs) / len(vs)
            rows.append({"m": lab, "f": fmt, "mine": me[k], "avg": a, "best": max(vs) if hi else min(vs), "hi": hi})
        return rows

    def top(L):
        return [{"l": x.customer_name, "v": mt(x)["lifetime"], "me": x.id == c.id} for x in sorted(L, key=lambda x: -mt(x)["lifetime"])[:6]]

    months = last6()
    m6 = lambda L: [round(sum(mt(x)["month_rev"].get(k, 0) for x in L) / max(len(L), 1) / 1e5, 2) for k, _ in months]  # noqa: E731
    verts = sorted({S.vertical_of(x) for x in all_customers}, key=lambda v: -sum(1 for x in all_customers if S.vertical_of(x) == v))[:8]
    if vert not in verts:
        verts.append(vert)
    grid = [{"vertical": v, "cells": [{"band": b, "n": sum(1 for x in all_customers if S.vertical_of(x) == v and bands.get(x.id) == b),
                                       "rev": sum(mt(x)["lifetime"] for x in all_customers if S.vertical_of(x) == v and bands.get(x.id) == b),
                                       "me": v == vert and b == band} for b in S.VALUE_BANDS]} for v in verts]
    # gaps vs peers
    ord_v = sum(mt(x)["orders"] for x in in_v) / max(len(in_v), 1)
    pipe_s = sum(mt(x)["open_pipe"] for x in in_s) / max(len(in_s), 1)
    gaps = [
        {"t": "wa" if me["orders"] < ord_v else "ok", "s": f"Orders: this customer has {me['orders']} vs {ord_v:.1f} on average for {vert} customers" + (" – room to grow." if me["orders"] < ord_v else " – ahead of peers.")},
        {"t": "wa" if me["open_pipe"] < pipe_s * .7 else "ok", "s": f"Pipeline ₹{me['open_pipe']:,.0f} vs the {band} average of ₹{pipe_s:,.0f}" + (" – open new deals." if me["open_pipe"] < pipe_s * .7 else " – healthy.")},
        {"t": "wa" if me["contacts"] < 3 else "ok", "s": f"Only {me['contacts']} contact{'s' if me['contacts'] != 1 else ''} mapped – add a technical and a commercial contact." if me["contacts"] < 3 else f"{me['contacts']} contacts mapped."},
    ]
    return {
        "band": band, "vertical": vert, "n_s": len(in_s), "n_v": len(in_v),
        "strip": [
            {"l": "Segment", "v": band, "f": "text", "dc": "tok" if band == "Strategic" else ""}, {"l": "Vertical", "v": vert, "f": "text"},
            {"l": f"Rank in {band.lower()}", "v": f"#{rk(in_s)} of {len(in_s)}", "f": "text"}, {"l": f"Rank in {vert}", "v": f"#{rk(in_v)} of {len(in_v)}", "f": "text"},
            {"l": "Seg. revenue share", "v": share(me["lifetime"], sum(mt(x)["lifetime"] for x in in_s)), "f": "pct"},
            {"l": "Vert. revenue share", "v": share(me["lifetime"], sum(mt(x)["lifetime"] for x in in_v)), "f": "pct"},
            {"l": "Segment of company", "v": share(sum(mt(x)["lifetime"] for x in in_s), tot), "f": "pct"},
            {"l": "Vertical of company", "v": share(sum(mt(x)["lifetime"] for x in in_v), tot), "f": "pct"},
        ],
        "peers_s": peers(in_s), "peers_v": peers(in_v), "top_s": top(in_s), "top_v": top(in_v),
        "line": {"labels": [lab for _, lab in months], "mine": m6([c]), "v_avg": m6(in_v), "s_avg": m6(in_s)},
        "grid": grid, "bands": list(S.VALUE_BANDS),
        "band_mix": [{"l": b, "v": sum(1 for x in in_v if bands.get(x.id) == b)} for b in S.VALUE_BANDS],
        "vert_mix": [{"l": v, "v": n} for v, n in Counter(S.vertical_of(x) for x in in_s).most_common(8)],
        "health_bars": [{"l": "This customer", "v": me["health"]}, {"l": f"{band} avg", "v": round(sum(mt(x)["health"] for x in in_s) / max(len(in_s), 1))},
                        {"l": f"{vert} avg", "v": round(sum(mt(x)["health"] for x in in_v) / max(len(in_v), 1))}],
        "gaps": gaps,
    }


# ─── Hierarchy tab ────────────────────────────────────────────────────────────

def hierarchy_tab(db: Session, user: User, c: Customer, M_all: dict[int, dict]) -> dict[str, Any]:
    fam = S.Family(db)
    P = S.profiles(db)
    root = fam.root(c.id)
    ids = [root] + fam.desc(root)
    mine = [c.id] + fam.desc(c.id)
    full = {x.id: x for x in db.query(Customer).filter(Customer.id.in_(ids)).all()}
    kams = {i: fam.kam(i, P) for i in ids}
    kn = S.user_names(db, [k[0] for k in kams.values()])
    rows = []
    for i in ids:
        x = full.get(i)
        if not x:
            continue
        mt = S.metrics_for(M_all, i)
        k = kams[i]
        rows.append({"id": i, "name": x.customer_name, "depth": len(fam.path(i)) - 1 - (len(fam.path(root)) - 1), "parent": fam.parent(i),
                     "level": S.level_of(x, P), "city": x.billing_city or "—", "below": len(fam.kids.get(i, [])),
                     "kam": kn.get(k[0]) if k[0] else None, "kam_own": k[1], "kam_from": full[k[2]].customer_name if k[2] in full else None,
                     "revenue": mt["lifetime"], "pipeline": mt["open_pipe"], "open": mt["open_deals"] + mt["live_bids"],
                     "leads": 0, "deals": mt["open_deals"], "bids": mt["live_bids"] + mt["won"], "orders": mt["orders"]})
    try:
        from sqlalchemy import func
        lc = dict(db.query(Lead.customer_id, func.count(Lead.id)).filter(Lead.customer_id.in_(ids), Lead.is_deleted == False).group_by(Lead.customer_id).all())
        for r in rows:
            r["leads"] = int(lc.get(r["id"], 0))
    except Exception:
        db.rollback()
    kam_list = defaultdict(lambda: {"n": 0, "own": 0, "rev": 0.0})
    for r in rows:
        if r["kam"]:
            k = kam_list[r["kam"]]
            k["n"] += 1; k["own"] += 1 if r["kam_own"] else 0; k["rev"] += r["revenue"]
    prof = P.get(c.id)
    users = db.query(User.id, User.full_name).filter(User.is_active == True).order_by(User.full_name).all()
    return {
        "root": {"id": root, "name": full[root].customer_name if root in full else ""},
        "strip": [
            {"l": "Group", "v": (full[root].customer_name.split("–")[0].strip() if root in full else ""), "f": "text"},
            {"l": "Entities in group", "v": len(rows), "f": "int"},
            {"l": "Levels used", "v": len({r["level"] for r in rows}), "f": "int"},
            {"l": "Group revenue", "v": sum(r["revenue"] for r in rows), "f": "inr"},
            {"l": "Group pipeline", "v": sum(r["pipeline"] for r in rows), "f": "inr"},
            {"l": "This entity + below", "v": sum(r["pipeline"] for r in rows if r["id"] in mine), "f": "inr"},
            {"l": "KAMs covering", "v": len(kam_list), "f": "int"},
            {"l": "Dedicated KAMs", "v": sum(1 for r in rows if r["kam_own"] and r["kam"]), "f": "int", "dc": "tok" if any(r["kam_own"] and r["kam"] for r in rows) else "twarn"},
        ],
        "rows": rows, "current": c.id,
        "kams": [{"name": n, "entities": v["n"], "own": v["own"], "common": v["n"] - v["own"], "revenue": v["rev"]} for n, v in kam_list.items()],
        "kam_mode": (prof.kam_mode if prof and prof.kam_mode else "Own KAM"), "has_parent": fam.parent(c.id) is not None,
        "kam_id": c.assigned_to, "users": [{"id": u.id, "name": u.full_name} for u in users],
        "levels": list(S.HIERARCHY_LEVELS), "level": S.level_of(c, P),
        "next_level": S.HIERARCHY_LEVELS[min(len(S.HIERARCHY_LEVELS) - 1, S.HIERARCHY_LEVELS.index(S.level_of(c, P)) + 1)],
        "segment": S.segment_of(c)[0], "sub_segment": S.segment_of(c)[1],
    }
