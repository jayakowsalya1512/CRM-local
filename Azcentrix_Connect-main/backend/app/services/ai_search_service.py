"""
ai_search_service.py — Natural-language "Ask AI" search mode.

The model never touches the database directly. It can only call the tool
functions defined below, each of which reuses the same tenant DB session,
current user, and data-scope rules ("own"/"team"/"all"/"none") as the rest
of the app. The model reasons over the JSON results and produces a plain
-English answer; the raw records it used are returned alongside the answer
so the UI can render real links, not just prose.
"""
from __future__ import annotations

import json
import logging
from datetime import date, timedelta
from typing import Any, Optional

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.all_models import (
    Customer, KAMActivity, Lead, Quotation, Tender, User, WorkOrder,
)
from app.utils.data_scope import apply_data_scope, get_module_data_scope, get_team_user_ids

logger = logging.getLogger(__name__)

MAX_ROWS = 20
MAX_TOOL_ROUNDS = 4


# ─── Scoping helpers (mirrors search_router.py) ───────────────────────────────

def _scope_leads(db: Session, cu: User):
    q = db.query(Lead).filter(Lead.is_deleted == False)
    return apply_data_scope(db, q, cu, "leads", Lead.created_by, Lead.assigned_to)


def _scope_tenders(db: Session, cu: User):
    return apply_data_scope(db, db.query(Tender), cu, "tenders", Tender.created_by, Tender.assigned_to)


def _scope_workorders(db: Session, cu: User):
    scope = get_module_data_scope(db, cu, "workorders")
    q = db.query(WorkOrder)
    if scope == "none":
        return q.filter(WorkOrder.id == -1)
    if scope == "own":
        return q.filter(or_(WorkOrder.created_by == cu.id, WorkOrder.project_manager_id == cu.id))
    if scope == "team":
        team_ids = get_team_user_ids(db, int(cu.id))
        if team_ids is not None:
            return q.filter(or_(WorkOrder.created_by.in_(team_ids), WorkOrder.project_manager_id.in_(team_ids)))
    return q


def _scope_customers(db: Session, cu: User):
    q = db.query(Customer).filter(Customer.is_deleted == False)
    return apply_data_scope(db, q, cu, "customers", Customer.created_by, Customer.assigned_to)


def _scope_kam_activities(db: Session, cu: User):
    return apply_data_scope(db, db.query(KAMActivity), cu, "kam", KAMActivity.user_id)


def _user_names(db: Session, ids: set[int]) -> dict[int, str]:
    if not ids:
        return {}
    return {int(r.id): (r.full_name or "") for r in db.query(User.id, User.full_name).filter(User.id.in_(ids)).all()}


def _clip(rows: list, limit: Optional[int]) -> list:
    n = max(1, min(int(limit or MAX_ROWS), MAX_ROWS))
    return rows[:n]


# ─── Tool implementations ─────────────────────────────────────────────────────

def _tool_search_customers(db: Session, cu: User, args: dict) -> list[dict]:
    q = _scope_customers(db, cu)
    if args.get("status"):
        q = q.filter(Customer.account_status.ilike(args["status"]))
    if args.get("search"):
        like = f"%{args['search']}%"
        q = q.filter(Customer.customer_name.ilike(like))

    rows = q.order_by(Customer.customer_name).limit(500).all()

    no_activity_days = args.get("no_activity_days")
    if no_activity_days:
        cutoff = date.today() - timedelta(days=int(no_activity_days))
        cust_ids = [c.id for c in rows]
        last_activity: dict[int, date] = {}
        if cust_ids:
            for cid, last_dt in (
                db.query(KAMActivity.customer_id, func.max(KAMActivity.activity_date))
                .filter(KAMActivity.customer_id.in_(cust_ids))
                .group_by(KAMActivity.customer_id)
                .all()
            ):
                if last_dt:
                    last_activity[int(cid)] = last_dt
        rows = [c for c in rows if last_activity.get(int(c.id), date.min) < cutoff]

    rows = _clip(rows, args.get("limit"))
    a_ids = {c.assigned_to for c in rows if c.assigned_to}
    umap = _user_names(db, a_ids)

    return [
        {
            "id": c.id,
            "customer_name": c.customer_name,
            "account_status": c.account_status,
            "billing_city": c.billing_city,
            "billing_state": c.billing_state,
            "potential_value": float(c.potential_value or 0),
            "assigned_to_name": umap.get(int(c.assigned_to)) if c.assigned_to else None,
            "url": "/customers",
        }
        for c in rows
    ]


def _tool_search_leads(db: Session, cu: User, args: dict) -> list[dict]:
    q = _scope_leads(db, cu).filter(Lead.lead_type == "lead")
    if args.get("status"):
        q = q.filter(Lead.status.ilike(args["status"]))
    if args.get("search"):
        like = f"%{args['search']}%"
        q = q.filter(or_(Lead.lead_title.ilike(like), Lead.customer_name.ilike(like)))

    rows = q.order_by(Lead.created_at.desc()).limit(500).all()
    rows = _clip(rows, args.get("limit"))
    a_ids = {l.assigned_to for l in rows if l.assigned_to}
    umap = _user_names(db, a_ids)

    return [
        {
            "id": l.id,
            "lead_ref_id": l.lead_ref_id,
            "lead_title": l.lead_title,
            "customer_name": l.customer_name,
            "status": l.status,
            "est_value": float(l.est_value or 0),
            "assigned_to_name": umap.get(int(l.assigned_to)) if l.assigned_to else None,
            "created_at": str(l.created_at)[:10] if l.created_at else None,
            "url": "/leads",
        }
        for l in rows
    ]


def _tool_search_opportunities(db: Session, cu: User, args: dict) -> list[dict]:
    q = _scope_leads(db, cu).filter(
        or_(Lead.lead_type == "direct_opportunity", Lead.status.in_(["Opportunity Created", "Converted"]))
    )
    if args.get("status"):
        q = q.filter(Lead.status.ilike(args["status"]))
    if args.get("search"):
        like = f"%{args['search']}%"
        q = q.filter(or_(Lead.lead_title.ilike(like), Lead.customer_name.ilike(like)))

    rows = q.order_by(Lead.created_at.desc()).limit(500).all()
    rows = _clip(rows, args.get("limit"))
    a_ids = {o.assigned_to for o in rows if o.assigned_to}
    umap = _user_names(db, a_ids)

    return [
        {
            "id": o.id,
            "opportunity_ref_id": o.opportunity_ref_id or o.lead_ref_id,
            "title": o.lead_title,
            "customer_name": o.customer_name,
            "status": o.status,
            "est_value": float(o.est_value or 0),
            "assigned_to_name": umap.get(int(o.assigned_to)) if o.assigned_to else None,
            "url": "/opportunities",
        }
        for o in rows
    ]


def _tool_search_tenders(db: Session, cu: User, args: dict) -> list[dict]:
    q = _scope_tenders(db, cu)
    if args.get("status"):
        q = q.filter(Tender.tender_status.ilike(args["status"]))
    if args.get("result"):
        q = q.filter(Tender.result.ilike(args["result"]))
    if args.get("search"):
        like = f"%{args['search']}%"
        q = q.filter(or_(Tender.tender_title.ilike(like), Tender.customer_name.ilike(like), Tender.tender_num.ilike(like)))
    if args.get("date_from"):
        q = q.filter(Tender.submission_date >= args["date_from"])
    if args.get("date_to"):
        q = q.filter(Tender.submission_date <= args["date_to"])

    rows = q.order_by(Tender.id.desc()).limit(500).all()
    rows = _clip(rows, args.get("limit"))
    a_ids = {t.assigned_to for t in rows if t.assigned_to}
    umap = _user_names(db, a_ids)

    return [
        {
            "id": t.id,
            "tender_num": t.tender_num,
            "tender_title": t.tender_title,
            "customer_name": t.customer_name,
            "tender_status": t.tender_status,
            "result": t.result,
            "est_value": float(t.est_value or 0),
            "bid_amount": float(t.bid_amount or 0) if t.bid_amount else None,
            "submission_date": str(t.submission_date)[:10] if t.submission_date else None,
            "assigned_to_name": umap.get(int(t.assigned_to)) if t.assigned_to else None,
            "url": "/tenders",
        }
        for t in rows
    ]


def _tool_search_work_orders(db: Session, cu: User, args: dict) -> list[dict]:
    q = _scope_workorders(db, cu)
    if args.get("status"):
        q = q.filter(WorkOrder.status.ilike(args["status"]))
    if args.get("search"):
        like = f"%{args['search']}%"
        q = q.filter(or_(WorkOrder.project_title.ilike(like), WorkOrder.customer_name.ilike(like), WorkOrder.wo_number.ilike(like)))

    rows = q.order_by(WorkOrder.created_at.desc()).limit(500).all()
    rows = _clip(rows, args.get("limit"))
    pm_ids = {w.project_manager_id for w in rows if w.project_manager_id}
    umap = _user_names(db, pm_ids)

    return [
        {
            "id": w.id,
            "wo_number": w.wo_number,
            "project_title": w.project_title,
            "customer_name": w.customer_name,
            "status": w.status,
            "wo_value": float(w.wo_value or 0),
            "delivery_date": str(w.delivery_date)[:10] if w.delivery_date else None,
            "project_manager_name": umap.get(int(w.project_manager_id)) if w.project_manager_id else None,
            "url": "/workorders",
        }
        for w in rows
    ]


def _tool_search_quotations(db: Session, cu: User, args: dict) -> list[dict]:
    # Quotations carry no assignee column of their own in this schema — scope
    # by the same "leads" visibility rule that governs the deal they belong to.
    scope = get_module_data_scope(db, cu, "leads")
    q = db.query(Quotation)
    if scope == "none":
        return []
    if scope == "own":
        q = q.filter(Quotation.created_by == cu.id)
    elif scope == "team":
        team_ids = get_team_user_ids(db, int(cu.id))
        if team_ids is not None:
            q = q.filter(Quotation.created_by.in_(team_ids))

    if args.get("status"):
        q = q.filter(Quotation.status.ilike(args["status"]))
    if args.get("search"):
        like = f"%{args['search']}%"
        q = q.filter(or_(Quotation.subject.ilike(like), Quotation.quotation_number.ilike(like)))

    rows = q.order_by(Quotation.created_at.desc()).limit(500).all()
    rows = _clip(rows, args.get("limit"))

    return [
        {
            "id": q_.id,
            "quotation_number": q_.quotation_number,
            "subject": q_.subject,
            "status": q_.status,
            "total_amount": float(q_.total_amount or 0),
            "valid_until": str(q_.valid_until)[:10] if q_.valid_until else None,
            "url": "/quotations",
        }
        for q_ in rows
    ]


def _tool_search_kam_activities(db: Session, cu: User, args: dict) -> list[dict]:
    q = _scope_kam_activities(db, cu)
    if args.get("activity_type"):
        q = q.filter(KAMActivity.activity_type.ilike(args["activity_type"]))
    if args.get("status"):
        q = q.filter(KAMActivity.status.ilike(args["status"]))
    if args.get("date_from"):
        q = q.filter(KAMActivity.activity_date >= args["date_from"])
    if args.get("date_to"):
        q = q.filter(KAMActivity.activity_date <= args["date_to"])

    rows = q.order_by(KAMActivity.activity_date.desc()).limit(500).all()
    rows = _clip(rows, args.get("limit"))
    u_ids = {a.user_id for a in rows if a.user_id}
    umap = _user_names(db, u_ids)

    return [
        {
            "id": a.id,
            "activity_type": a.activity_type,
            "subject": a.subject,
            "activity_date": str(a.activity_date)[:10] if a.activity_date else None,
            "status": a.status,
            "outcome": a.outcome,
            "owner_name": umap.get(int(a.user_id)) if a.user_id else None,
            "url": "/kam360",
        }
        for a in rows
    ]


_TOOL_IMPL = {
    "search_customers": _tool_search_customers,
    "search_leads": _tool_search_leads,
    "search_opportunities": _tool_search_opportunities,
    "search_tenders": _tool_search_tenders,
    "search_work_orders": _tool_search_work_orders,
    "search_quotations": _tool_search_quotations,
    "search_kam_activities": _tool_search_kam_activities,
}


# ─── OpenAI function-calling schemas ───────────────────────────────────────────

def _common_props(extra: dict | None = None) -> dict:
    base = {
        "search": {"type": "string", "description": "Free-text match on name/title fields"},
        "status": {"type": "string", "description": "Exact or partial status value to filter on"},
        "limit": {"type": "integer", "description": f"Max rows to return (default 20, hard cap {MAX_ROWS})"},
    }
    if extra:
        base.update(extra)
    return base


TOOL_SPECS = [
    {
        "type": "function",
        "function": {
            "name": "search_customers",
            "description": "Search customer accounts. Use no_activity_days to find customers with no KAM follow-up/activity in the last N days.",
            "parameters": {
                "type": "object",
                "properties": _common_props({
                    "no_activity_days": {"type": "integer", "description": "Find customers with zero KAM activity in the last N days"},
                }),
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_leads",
            "description": "Search sales leads (pre-opportunity stage).",
            "parameters": {"type": "object", "properties": _common_props()},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_opportunities",
            "description": "Search converted/active sales opportunities.",
            "parameters": {"type": "object", "properties": _common_props()},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_tenders",
            "description": "Search tenders/bids. 'result' is Won/Lost/Pending; date_from/date_to filter by submission date (YYYY-MM-DD).",
            "parameters": {
                "type": "object",
                "properties": _common_props({
                    "result": {"type": "string", "description": "Won, Lost, or Pending"},
                    "date_from": {"type": "string", "description": "YYYY-MM-DD"},
                    "date_to": {"type": "string", "description": "YYYY-MM-DD"},
                }),
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_work_orders",
            "description": "Search active/completed work orders.",
            "parameters": {"type": "object", "properties": _common_props()},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_quotations",
            "description": "Search quotations sent to customers.",
            "parameters": {"type": "object", "properties": _common_props()},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_kam_activities",
            "description": "Search KAM (key account management) activities — calls, meetings, visits, follow-ups. date_from/date_to filter by activity date (YYYY-MM-DD).",
            "parameters": {
                "type": "object",
                "properties": _common_props({
                    "activity_type": {"type": "string", "description": "e.g. Phone Call, Meeting, Site Visit, Follow Up"},
                    "date_from": {"type": "string", "description": "YYYY-MM-DD"},
                    "date_to": {"type": "string", "description": "YYYY-MM-DD"},
                }),
            },
        },
    },
]

_SYSTEM_PROMPT = (
    "You are the AI search assistant inside a CRM. Answer the user's question about their "
    "sales/customer data ONLY by calling the provided tools — never invent numbers or records. "
    f"Today's date is {date.today().isoformat()}. "
    "Call as many tools as needed (in parallel where possible), then give a concise, direct answer "
    "(2-4 sentences, plain text, no markdown headers) citing real counts/values from the tool results. "
    "If a tool returns zero rows, say so plainly instead of guessing."
)


def is_configured() -> bool:
    return bool(settings.AI_SEARCH_ENABLED and settings.OPENAI_API_KEY)


def run_ai_search(question: str, db: Session, cu: User) -> dict[str, Any]:
    """Run the tool-calling agent loop and return {answer, records, tools_used, mode}."""
    if not is_configured():
        return {
            "answer": "AI search is not enabled on this server. Ask your admin to configure OPENAI_API_KEY and AI_SEARCH_ENABLED.",
            "records": [],
            "tools_used": [],
            "mode": "ai",
        }

    from openai import OpenAI  # local import — keep optional dependency out of module load path

    client = OpenAI(api_key=settings.OPENAI_API_KEY)
    messages: list[dict] = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": question},
    ]

    tools_used: list[str] = []
    all_records: list[dict] = []

    try:
        for _ in range(MAX_TOOL_ROUNDS):
            resp = client.chat.completions.create(
                model=settings.AI_SEARCH_MODEL,
                messages=messages,
                tools=TOOL_SPECS,
                tool_choice="auto",
                temperature=0.1,
            )
            msg = resp.choices[0].message
            tool_calls = msg.tool_calls or []

            if not tool_calls:
                return {
                    "answer": (msg.content or "").strip() or "I couldn't find an answer for that.",
                    "records": all_records[:MAX_ROWS],
                    "tools_used": tools_used,
                    "mode": "ai",
                }

            messages.append({
                "role": "assistant",
                "content": msg.content,
                "tool_calls": [tc.model_dump() for tc in tool_calls],
            })

            for tc in tool_calls:
                name = tc.function.name
                try:
                    args = json.loads(tc.function.arguments or "{}")
                except (TypeError, ValueError):
                    args = {}

                impl = _TOOL_IMPL.get(name)
                if not impl:
                    result: list[dict] = []
                else:
                    try:
                        result = impl(db, cu, args)
                    except Exception:
                        logger.exception("AI search tool %s failed", name)
                        result = []

                tools_used.append(name)
                all_records.extend(result)

                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": json.dumps({"count": len(result), "rows": result[:MAX_ROWS]}, default=str),
                })

        # Ran out of rounds — ask once more for a final answer with no further tool use.
        final = client.chat.completions.create(
            model=settings.AI_SEARCH_MODEL,
            messages=messages,
            temperature=0.1,
        )
        return {
            "answer": (final.choices[0].message.content or "").strip() or "I couldn't find an answer for that.",
            "records": all_records[:MAX_ROWS],
            "tools_used": tools_used,
            "mode": "ai",
        }
    except Exception:
        logger.exception("AI search failed")
        return {
            "answer": "AI search failed — please try again or use keyword search.",
            "records": [],
            "tools_used": tools_used,
            "mode": "ai",
        }
