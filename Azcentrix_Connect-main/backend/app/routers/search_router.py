"""Global search router — unified search across Customers, Leads, Opportunities, Tenders, Work Orders.

Tenant-safe: every query goes through get_tenant_db (per-tenant DB connection).
Role-safe:   data-scope applied per module using the same helper as other routers.
Performance: OR filter on indexed columns only; LIMIT 5 per module; single user-name lookup.
"""
import logging
import re
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, func
from sqlalchemy.orm import Session

from app.dependencies import get_tenant_db, get_current_user
from app.models.all_models import (
    Customer, CustomerContact, Lead, Tender, WorkOrder, User,
    Module, Permission, Role, RolePermission,
    EMDBG, OEM, ProductMaster, Competitor, TravelRequest,
)
from app.services.ai_search_service import is_configured as ai_search_is_configured, run_ai_search
from app.utils.data_scope import apply_data_scope, get_module_data_scope, get_team_user_ids

logger = logging.getLogger(__name__)
router = APIRouter()

LIMIT = 5


# ─── Smart pattern detection ──────────────────────────────────────────────────

_SYNONYMS: dict[str, set[str]] = {
    "tender":      {"tender", "tenders", "bid", "bids", "rfp", "rfq"},
    "lead":        {"lead", "leads", "enquiry", "enquiries", "inquiry", "inquiries"},
    "opportunity": {"opportunity", "opportunities", "opp", "opps"},
    "customer":    {"customer", "customers", "client", "clients", "account", "accounts"},
    "workorder":   {"workorder", "workorders", "wo"},
    "lost":        {"lost", "closed", "rejected", "failed"},
    "won":         {"won", "converted", "success", "win"},
    "pending":     {"pending", "open", "assigned"},
    "active":      {"active", "ongoing", "progress", "current", "running"},
    "completed":   {"completed", "done", "finished", "complete"},
    "submitted":   {"submitted", "submit", "applied"},
    "evaluation":  {"evaluation", "evaluating", "evaluate"},
    "inactive":    {"inactive", "inactivity", "dormant", "churned"},
    "travel":      {"travel", "trip", "trips", "journey"},
    "approved":    {"approved", "approval"},
}

# More-specific patterns (with date) must come before less-specific ones
_SMART_PATTERNS = [
    {"label": "Lost Tenders Last Month",    "needs": {"lost",      "tender",      "last_month"},  "module": "tenders",       "filters": {"tender_status": "Closed"},                          "description": "Tenders closed in the previous month"},
    {"label": "Lost Tenders This Month",    "needs": {"lost",      "tender",      "this_month"},  "module": "tenders",       "filters": {"tender_status": "Closed"},                          "description": "Tenders closed this month"},
    {"label": "Lost Tenders This Year",     "needs": {"lost",      "tender",      "this_year"},   "module": "tenders",       "filters": {"tender_status": "Closed"},                          "description": "Tenders closed this year"},
    {"label": "Lost Tenders",               "needs": {"lost",      "tender"},                     "module": "tenders",       "filters": {"tender_status": "Closed"},                          "description": "All tenders with Closed status"},
    {"label": "Submitted Tenders",          "needs": {"submitted", "tender"},                     "module": "tenders",       "filters": {"tender_status": "Submitted"},                       "description": "Tenders that have been submitted"},
    {"label": "Evaluation Tenders",         "needs": {"evaluation","tender"},                     "module": "tenders",       "filters": {"tender_status": "Evaluation"},                      "description": "Tenders under evaluation"},
    {"label": "Won Opportunities",          "needs": {"won",       "opportunity"},                "module": "opportunities",  "filters": {"status": "Converted"},                             "description": "Opportunities that are converted or won"},
    {"label": "Pending Opportunities",      "needs": {"pending",   "opportunity"},                "module": "opportunities",  "filters": {"status__in": ["Opportunity Created"]},             "description": "Opportunities awaiting action"},
    {"label": "Pending Leads",              "needs": {"pending",   "lead"},                       "module": "leads",         "filters": {"status__in": ["Assigned", "Contacted", "Qualified", "Proposal Pending", "Nurturing"]},            "description": "Leads that are open or assigned"},
    {"label": "Active Work Orders",         "needs": {"active",    "workorder"},                  "module": "workorders",    "filters": {"status": "In Progress"},                            "description": "Work orders currently in progress"},
    {"label": "Completed Work Orders",      "needs": {"completed", "workorder"},                  "module": "workorders",    "filters": {"status": "Completed"},                              "description": "Work orders that are done"},
    {"label": "Active Customers",           "needs": {"active",    "customer"},                   "module": "customers",     "filters": {"account_status": "Active"},                         "description": "Customers with active status"},
    {"label": "Inactive Customers",         "needs": {"inactive",  "customer"},                   "module": "customers",     "filters": {"account_status": "Inactive"},                        "description": "Customers with inactive status"},
    {"label": "Pending Travel Requests",    "needs": {"pending",   "travel"},                     "module": "travel",        "filters": {"status": "Pending"},                                "description": "Travel requests pending approval"},
    {"label": "Approved Travel Requests",   "needs": {"approved",  "travel"},                     "module": "travel",        "filters": {"status__in": ["Approved", "Manager Approved", "Accounts Approved"]}, "description": "Approved travel requests"},
]


def _expand(text: str) -> set[str]:
    """Normalize query, replace multi-word entities, expand synonyms to canonical keys."""
    # Replace 'work order(s)' before splitting so it becomes one token
    t = re.sub(r'\bwork[\s_-]+orders?\b', 'workorder', text.lower())
    words = set(re.sub(r'[^a-z0-9 ]', '', t).split())
    canonical: set[str] = set()
    for key, syns in _SYNONYMS.items():
        if words & syns:
            canonical.add(key)
    return canonical


def _detect_date(text: str) -> str | None:
    """Detect a date-range keyword in the original query string."""
    tl = text.lower()
    if "last month" in tl or "previous month" in tl or "prev month" in tl:
        return "last_month"
    if "this month" in tl or "current month" in tl:
        return "this_month"
    if "this year" in tl or "current year" in tl:
        return "this_year"
    if "this week" in tl:
        return "this_week"
    if "today" in tl:
        return "today"
    return None


def _detect_smart(term: str) -> dict | None:
    """Return the first smart pattern that matches the query, or None."""
    tokens = _expand(term)
    date_key = _detect_date(term)
    if date_key:
        tokens.add(date_key)
    for pat in _SMART_PATTERNS:
        if pat["needs"].issubset(tokens):
            return pat
    return None


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _fetch_user_names(db: Session, ids: set) -> dict:
    """Return {user_id: full_name} for the given set of IDs — single query."""
    if not ids:
        return {}
    rows = db.query(User.id, User.full_name).filter(User.id.in_(ids)).all()
    return {int(r.id): (r.full_name or "") for r in rows}


def _active_module_keys(db: Session) -> set[str]:
    """Return all module keys that are currently enabled for this tenant."""
    rows = db.query(Module.key).filter(Module.is_active == True).all()
    return {r.key for r in rows}


def _user_permission_keys(db: Session, user: User) -> set[str]:
    """Return all permission keys granted to the user's role — single role lookup."""
    role_row = db.query(Role).filter(
        Role.name == user.role,
        Role.is_active == True,
    ).first()
    if not role_row:
        return set()
    perm_ids = [
        r.permission_id
        for r in db.query(RolePermission).filter(RolePermission.role_id == role_row.id).all()
    ]
    if not perm_ids:
        return set()
    return {
        r.key
        for r in db.query(Permission).filter(Permission.id.in_(perm_ids)).all()
    }


def _scope_leads(db: Session, cu: User):
    """Return a base Lead query with tenant-scope applied."""
    q = db.query(Lead).filter(Lead.is_deleted == False)
    return apply_data_scope(db, q, cu, "leads", Lead.created_by, Lead.assigned_to)


def _scope_travel(db: Session, cu: User):
    """Return a base TravelRequest query with data-scope applied."""
    scope = get_module_data_scope(db, cu, "travel")
    q = db.query(TravelRequest)
    if scope == "none":
        return q.filter(TravelRequest.id == -1)
    if scope == "own":
        q = q.filter(TravelRequest.employee_id == cu.id)
    elif scope == "team":
        team_ids = get_team_user_ids(db, int(cu.id))
        if team_ids is not None:
            q = q.filter(TravelRequest.employee_id.in_(team_ids))
    return q


def _scope_emdbg(db: Session, cu: User):
    """Return a base EMDBG query with data-scope applied."""
    scope = get_module_data_scope(db, cu, "emdbg")
    q = db.query(EMDBG)
    if scope == "none":
        return q.filter(EMDBG.id == -1)
    if scope == "own":
        q = q.filter(EMDBG.created_by == cu.id)
    elif scope == "team":
        team_ids = get_team_user_ids(db, int(cu.id))
        if team_ids is not None:
            q = q.filter(EMDBG.created_by.in_(team_ids))
    return q


def _scope_workorders(db: Session, cu: User):
    """Return a base WorkOrder query with data-scope applied."""
    scope = get_module_data_scope(db, cu, "workorders")
    q = db.query(WorkOrder)
    if scope == "none":
        return q.filter(WorkOrder.id == -1)          # empty result
    if scope == "own":
        q = q.filter(
            or_(
                WorkOrder.created_by == cu.id,
                WorkOrder.project_manager_id == cu.id,
            )
        )
    elif scope == "team":
        team_ids = get_team_user_ids(db, int(cu.id))
        if team_ids is not None:
            q = q.filter(
                or_(
                    WorkOrder.created_by.in_(team_ids),
                    WorkOrder.project_manager_id.in_(team_ids),
                )
            )
    # scope == "all" — no extra filter
    return q


# ─── Endpoint ────────────────────────────────────────────────────────────────

@router.get("")
def global_search(
    q: str = Query(..., min_length=1, max_length=200),
    module: Optional[str] = Query(None, description="Filter to a single module for 'View All' page"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    term = q.strip()
    if not term:
        return _empty()

    # ── Access gates: tenant module enabled + user has view permission ─────────
    _active_mods = _active_module_keys(db)
    _user_perms  = _user_permission_keys(db, cu)

    # (tenant_module_key, required_permission_key) per search module
    _GATES: dict[str, tuple[str, str]] = {
        "customers":     ("customers",  "customers.view"),
        "leads":         ("leads",      "leads.view"),
        "opportunities": ("leads",      "leads.view"),
        "tenders":       ("tenders",    "tenders.view"),
        "workorders":    ("workorders", "workorders.view"),
        "travel":        ("travel",     "travel.view"),
        "emdbg":         ("emdbg",      "emdbg.view"),
        "oem":           ("oems",       "oems.view"),
        "masters":       ("masters",    "masters.view"),
        "competitors":   ("competitors","competitors.view"),
    }

    def _allowed(mod: str) -> bool:
        gate = _GATES.get(mod)
        if not gate:
            return True
        tenant_key, perm_key = gate
        return tenant_key in _active_mods and perm_key in _user_perms

    # ── Smart pattern detection — runs before keyword search ─────────────────
    if not module:   # smart patterns only apply to the global quick-search, not "View All"
        smart_pat = _detect_smart(term)
        if smart_pat:
            date_key = _detect_date(term)
            res = _run_smart(db, cu, smart_pat, LIMIT, date_key, _allowed)
            res["smart_match"] = {
                "label": smart_pat["label"],
                "description": smart_pat.get("description", smart_pat["label"]),
                "module": smart_pat["module"],
            }
            return res

    like = f"%{term}%"
    is_full_page = module is not None        # "View All" mode — paginated, single module
    limit = page_size if is_full_page else LIMIT
    offset = (page - 1) * page_size if is_full_page else 0

    results: dict = {}

    # ── Customers ────────────────────────────────────────────────────────────
    if module in (None, "customers") and _allowed("customers"):
        cust_base = apply_data_scope(
            db,
            db.query(Customer).filter(Customer.is_deleted == False),
            cu, "customers", Customer.created_by, Customer.assigned_to,
        )

        contact_subq = (
            db.query(CustomerContact.customer_id)
            .filter(or_(
                CustomerContact.mobile.ilike(like),
                CustomerContact.office_phone.ilike(like),
                CustomerContact.office_email.ilike(like),
                CustomerContact.personal_email.ilike(like),
                CustomerContact.contact_name.ilike(like),
            ))
            .subquery()
        )

        exact_match = func.lower(Customer.customer_name) == term.lower()
        cust_q = cust_base.filter(or_(
            Customer.customer_name.ilike(like),
            Customer.id.in_(contact_subq),
        )).order_by(exact_match.desc(), Customer.customer_name)

        total_customers = cust_q.count() if is_full_page else None
        cust_rows = cust_q.offset(offset).limit(limit).all()

        a_ids = {c.assigned_to for c in cust_rows if c.assigned_to}
        umap = _fetch_user_names(db, a_ids)

        results["customers"] = {
            "items": [
                {
                    "id": c.id,
                    "module": "customers",
                    "title": c.customer_name,
                    "subtitle": _join(c.billing_city, c.billing_state),
                    "ref_id": None,
                    "status": str(c.account_status) if c.account_status else None,
                    "assigned_to_name": umap.get(int(c.assigned_to)) if c.assigned_to else None,
                    "url": "/customers",
                    "highlight_field": "customer_name",
                }
                for c in cust_rows
            ],
            "total": total_customers,
        }

    # ── Leads (non-direct, non-Converted) ────────────────────────────────────
    if module in (None, "leads") and _allowed("leads"):
        leads_base = _scope_leads(db, cu).filter(
            Lead.lead_type == "lead",
            Lead.status != "Converted",
        )

        exact_ref = Lead.lead_ref_id == term
        leads_q = leads_base.filter(or_(
            Lead.lead_title.ilike(like),
            Lead.lead_ref_id.ilike(like),
            Lead.customer_name.ilike(like),
            Lead.contact_person.ilike(like),
            Lead.mobile.ilike(like),
            Lead.email.ilike(like),
        )).order_by(exact_ref.desc(), Lead.created_at.desc())

        total_leads = leads_q.count() if is_full_page else None
        leads_rows = leads_q.offset(offset).limit(limit).all()

        a_ids = {l.assigned_to for l in leads_rows if l.assigned_to}
        umap_l = _fetch_user_names(db, a_ids)

        results["leads"] = {
            "items": [
                {
                    "id": l.id,
                    "module": "leads",
                    "title": l.lead_title,
                    "subtitle": l.customer_name,
                    "ref_id": l.lead_ref_id,
                    "status": l.status,
                    "assigned_to_name": umap_l.get(int(l.assigned_to)) if l.assigned_to else None,
                    "url": "/leads",
                    "highlight_field": _pick_field(term, l, ["lead_ref_id", "lead_title", "customer_name"]),
                }
                for l in leads_rows
            ],
            "total": total_leads,
        }

    # ── Opportunities (Converted leads + Opportunity Created + direct_opportunity) ──
    if module in (None, "opportunities") and _allowed("opportunities"):
        opp_base = _scope_leads(db, cu).filter(
            or_(
                Lead.lead_type == "direct_opportunity",
                Lead.status.in_(["Opportunity Created", "Converted"]),
            )
        )

        exact_opp = Lead.opportunity_ref_id == term
        opps_q = opp_base.filter(or_(
            Lead.lead_title.ilike(like),
            Lead.opportunity_ref_id.ilike(like),
            Lead.lead_ref_id.ilike(like),
            Lead.customer_name.ilike(like),
            Lead.contact_person.ilike(like),
        )).order_by(exact_opp.desc(), Lead.created_at.desc())

        total_opps = opps_q.count() if is_full_page else None
        opps_rows = opps_q.offset(offset).limit(limit).all()

        a_ids = {o.assigned_to for o in opps_rows if o.assigned_to}
        umap_o = _fetch_user_names(db, a_ids)

        results["opportunities"] = {
            "items": [
                {
                    "id": o.id,
                    "module": "opportunities",
                    "title": o.lead_title,
                    "subtitle": o.customer_name,
                    "ref_id": o.opportunity_ref_id or o.lead_ref_id,
                    "status": o.status,
                    "lead_type": o.lead_type,
                    "assigned_to_name": umap_o.get(int(o.assigned_to)) if o.assigned_to else None,
                    "url": f"/opportunities/{o.id}" if o.lead_type == "direct_opportunity" else "/opportunities",
                    "highlight_field": _pick_field(term, o, ["opportunity_ref_id", "lead_title", "customer_name"]),
                }
                for o in opps_rows
            ],
            "total": total_opps,
        }

    # ── Tenders ──────────────────────────────────────────────────────────────
    if module in (None, "tenders") and _allowed("tenders"):
        tend_base = apply_data_scope(
            db, db.query(Tender), cu, "tenders",
            Tender.created_by, Tender.assigned_to,
        )

        exact_tnum = Tender.tender_num == term
        tenders_q = tend_base.filter(or_(
            Tender.tender_num.ilike(like),
            Tender.tender_title.ilike(like),
            Tender.customer_name.ilike(like),
            Tender.portal_ref_number.ilike(like),
        )).order_by(exact_tnum.desc(), Tender.id.desc())

        total_tenders = tenders_q.count() if is_full_page else None
        tender_rows = tenders_q.offset(offset).limit(limit).all()

        a_ids = {t.assigned_to for t in tender_rows if t.assigned_to}
        umap_t = _fetch_user_names(db, a_ids)

        results["tenders"] = {
            "items": [
                {
                    "id": t.id,
                    "module": "tenders",
                    "title": t.tender_title or t.tender_num or f"Tender #{t.id}",
                    "subtitle": t.customer_name,
                    "ref_id": t.tender_num,
                    "status": str(t.tender_status) if t.tender_status else None,
                    "assigned_to_name": umap_t.get(int(t.assigned_to)) if t.assigned_to else None,
                    "url": "/tenders",
                    "highlight_field": _pick_field(term, t, ["tender_num", "tender_title", "customer_name"]),
                }
                for t in tender_rows
            ],
            "total": total_tenders,
        }

    # ── Work Orders ──────────────────────────────────────────────────────────
    if module in (None, "workorders") and _allowed("workorders"):
        wo_base = _scope_workorders(db, cu)

        exact_wo = WorkOrder.wo_number == term
        wos_q = wo_base.filter(or_(
            WorkOrder.wo_number.ilike(like),
            WorkOrder.project_title.ilike(like),
            WorkOrder.customer_name.ilike(like),
            WorkOrder.po_number.ilike(like),
        )).order_by(exact_wo.desc(), WorkOrder.created_at.desc())

        total_wos = wos_q.count() if is_full_page else None
        wo_rows = wos_q.offset(offset).limit(limit).all()

        pm_ids = {w.project_manager_id for w in wo_rows if w.project_manager_id}
        umap_w = _fetch_user_names(db, pm_ids)

        results["workorders"] = {
            "items": [
                {
                    "id": w.id,
                    "module": "workorders",
                    "title": w.project_title or w.wo_number,
                    "subtitle": w.customer_name,
                    "ref_id": w.wo_number,
                    "status": str(w.status) if w.status else None,
                    "assigned_to_name": umap_w.get(int(w.project_manager_id)) if w.project_manager_id else None,
                    "url": "/workorders",
                    "highlight_field": _pick_field(term, w, ["wo_number", "project_title", "customer_name"]),
                }
                for w in wo_rows
            ],
            "total": total_wos,
        }

    # ── Travel Requests ──────────────────────────────────────────────────────
    if module in (None, "travel") and _allowed("travel"):
        tr_base = _scope_travel(db, cu)

        exact_tr = TravelRequest.request_number == term
        tr_q = tr_base.filter(or_(
            TravelRequest.request_number.ilike(like),
            TravelRequest.purpose.ilike(like),
            TravelRequest.from_city.ilike(like),
            TravelRequest.to_city.ilike(like),
        )).order_by(exact_tr.desc(), TravelRequest.created_at.desc())

        total_tr = tr_q.count() if is_full_page else None
        tr_rows = tr_q.offset(offset).limit(limit).all()

        emp_ids = {t.employee_id for t in tr_rows if t.employee_id}
        umap_tr = _fetch_user_names(db, emp_ids)

        results["travel"] = {
            "items": [
                {
                    "id": t.id,
                    "module": "travel",
                    "title": t.purpose,
                    "subtitle": _join(t.from_city, t.to_city),
                    "ref_id": t.request_number,
                    "status": str(t.status) if t.status else None,
                    "assigned_to_name": umap_tr.get(int(t.employee_id)) if t.employee_id else None,
                    "url": "/travel",
                    "highlight_field": _pick_field(term, t, ["request_number", "purpose", "from_city"]),
                }
                for t in tr_rows
            ],
            "total": total_tr,
        }

    # ── EMD / BG (Data) ───────────────────────────────────────────────────────
    if module in (None, "emdbg") and _allowed("emdbg"):
        emdbg_base = _scope_emdbg(db, cu)

        exact_ref = EMDBG.reference_num == term
        emdbg_q = emdbg_base.filter(or_(
            EMDBG.reference_num.ilike(like),
            EMDBG.client_name.ilike(like),
            EMDBG.tender_num.ilike(like),
            EMDBG.instrument_number.ilike(like),
            EMDBG.po_number.ilike(like),
        )).order_by(exact_ref.desc(), EMDBG.created_at.desc())

        total_emdbg = emdbg_q.count() if is_full_page else None
        emdbg_rows = emdbg_q.offset(offset).limit(limit).all()

        results["emdbg"] = {
            "items": [
                {
                    "id": e.id,
                    "module": "emdbg",
                    "title": e.client_name,
                    "subtitle": str(e.instrument_type) if e.instrument_type else None,
                    "ref_id": e.reference_num,
                    "status": str(e.status) if e.status else None,
                    "assigned_to_name": None,
                    "url": "/emdbg",
                    "highlight_field": _pick_field(term, e, ["reference_num", "client_name", "tender_num"]),
                }
                for e in emdbg_rows
            ],
            "total": total_emdbg,
        }

    # ── OEM / Distributors ────────────────────────────────────────────────────
    if module in (None, "oem") and _allowed("oem"):
        oem_q = db.query(OEM).filter(OEM.is_deleted == False).filter(or_(
            OEM.name.ilike(like),
            OEM.contact_name.ilike(like),
            OEM.contact_email.ilike(like),
            OEM.contact_phone.ilike(like),
        )).order_by(
            (func.lower(OEM.name) == term.lower()).desc(),
            OEM.name,
        )

        total_oem = oem_q.count() if is_full_page else None
        oem_rows = oem_q.offset(offset).limit(limit).all()

        results["oem"] = {
            "items": [
                {
                    "id": o.id,
                    "module": "oem",
                    "title": o.name,
                    "subtitle": o.type,
                    "ref_id": None,
                    "status": "Active" if o.is_active else "Inactive",
                    "assigned_to_name": None,
                    "url": "/oems",
                    "highlight_field": _pick_field(term, o, ["name", "contact_name"]),
                }
                for o in oem_rows
            ],
            "total": total_oem,
        }

    # ── Product Masters ───────────────────────────────────────────────────────
    if module in (None, "masters") and _allowed("masters"):
        pm_q = db.query(ProductMaster).filter(or_(
            ProductMaster.name.ilike(like),
            ProductMaster.category.ilike(like),
            ProductMaster.description.ilike(like),
        )).order_by(
            (func.lower(ProductMaster.name) == term.lower()).desc(),
            ProductMaster.name,
        )

        total_pm = pm_q.count() if is_full_page else None
        pm_rows = pm_q.offset(offset).limit(limit).all()

        results["masters"] = {
            "items": [
                {
                    "id": p.id,
                    "module": "masters",
                    "title": p.name,
                    "subtitle": p.category,
                    "ref_id": None,
                    "status": "Active" if p.is_active else "Inactive",
                    "assigned_to_name": None,
                    "url": "/masters",
                    "highlight_field": _pick_field(term, p, ["name", "category"]),
                }
                for p in pm_rows
            ],
            "total": total_pm,
        }

    # ── Competitors ───────────────────────────────────────────────────────────
    if module in (None, "competitors") and _allowed("competitors"):
        comp_q = db.query(Competitor).filter(or_(
            Competitor.name.ilike(like),
            Competitor.city.ilike(like),
            Competitor.state.ilike(like),
            Competitor.email.ilike(like),
        )).order_by(
            (func.lower(Competitor.name) == term.lower()).desc(),
            Competitor.name,
        )

        total_comp = comp_q.count() if is_full_page else None
        comp_rows = comp_q.offset(offset).limit(limit).all()

        results["competitors"] = {
            "items": [
                {
                    "id": c.id,
                    "module": "competitors",
                    "title": c.name,
                    "subtitle": _join(c.city, c.state),
                    "ref_id": None,
                    "status": "Active" if c.is_active else "Inactive",
                    "assigned_to_name": None,
                    "url": "/competitors",
                    "highlight_field": _pick_field(term, c, ["name", "city", "state"]),
                }
                for c in comp_rows
            ],
            "total": total_comp,
        }

    # Fill in missing modules (when module filter is used, others are absent)
    for key in ("customers", "leads", "opportunities", "tenders", "workorders",
                "travel", "emdbg", "oem", "masters", "competitors"):
        if key not in results:
            results[key] = {"items": [], "total": 0}

    return results


# ─── AI Smart Search ("ask" mode) ─────────────────────────────────────────────

class AskRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=500)


@router.get("/ai-status")
def ai_search_status():
    """Whether AI search mode is available — frontend uses this to show/hide the AI tab."""
    return {"enabled": ai_search_is_configured()}


@router.post("/ask")
def ai_search_ask(
    body: AskRequest,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    """Natural-language question answered by an AI agent using safe, scoped data tools."""
    return run_ai_search(body.query.strip(), db, cu)


# ─── Smart query executor ─────────────────────────────────────────────────────

def _run_smart(db: Session, cu: User, pat: dict, limit: int, date_key: str | None, allowed_fn) -> dict:
    """Execute a smart pattern filter query. Returns grouped results (without smart_match)."""
    mod = pat["module"]
    filters = pat.get("filters", {})

    start_dt, end_dt = None, None
    if date_key:
        today = date.today()
        if date_key == "last_month":
            first_this = today.replace(day=1)
            start_dt = (first_this - timedelta(days=1)).replace(day=1)
            end_dt = first_this
        elif date_key == "this_month":
            start_dt, end_dt = today.replace(day=1), today
        elif date_key == "this_year":
            start_dt, end_dt = date(today.year, 1, 1), today
        elif date_key == "today":
            start_dt = end_dt = today
        elif date_key == "this_week":
            start_dt = today - timedelta(days=today.weekday())
            end_dt = today

    def _date_filter(q, col):
        if start_dt is not None:
            q = q.filter(col >= start_dt)
        if end_dt is not None and start_dt != end_dt:
            q = q.filter(col < end_dt)
        elif end_dt is not None:
            q = q.filter(col <= end_dt)
        return q

    results: dict = {}

    if mod == "tenders" and allowed_fn("tenders"):
        q = apply_data_scope(db, db.query(Tender), cu, "tenders", Tender.created_by, Tender.assigned_to)
        if filters.get("tender_status"):
            q = q.filter(Tender.tender_status == filters["tender_status"])
        if filters.get("tender_status__in"):
            q = q.filter(Tender.tender_status.in_(filters["tender_status__in"]))
        q = _date_filter(q, Tender.created_at)
        rows = q.order_by(Tender.id.desc()).limit(limit).all()
        a_ids = {t.assigned_to for t in rows if t.assigned_to}
        umap = _fetch_user_names(db, a_ids)
        results["tenders"] = {"items": [
            {"id": t.id, "module": "tenders",
             "title": t.tender_title or t.tender_num or f"Tender #{t.id}",
             "subtitle": t.customer_name, "ref_id": t.tender_num,
             "status": str(t.tender_status) if t.tender_status else None,
             "assigned_to_name": umap.get(int(t.assigned_to)) if t.assigned_to else None,
             "url": "/tenders", "highlight_field": "tender_title"}
            for t in rows
        ], "total": len(rows)}

    elif mod == "leads" and allowed_fn("leads"):
        q = _scope_leads(db, cu).filter(Lead.lead_type == "lead")
        if filters.get("status__in"):
            q = q.filter(Lead.status.in_(filters["status__in"]))
        elif filters.get("status"):
            q = q.filter(Lead.status == filters["status"])
        q = _date_filter(q, Lead.created_at)
        rows = q.order_by(Lead.created_at.desc()).limit(limit).all()
        a_ids = {l.assigned_to for l in rows if l.assigned_to}
        umap = _fetch_user_names(db, a_ids)
        results["leads"] = {"items": [
            {"id": l.id, "module": "leads", "title": l.lead_title, "subtitle": l.customer_name,
             "ref_id": l.lead_ref_id, "status": l.status,
             "assigned_to_name": umap.get(int(l.assigned_to)) if l.assigned_to else None,
             "url": "/leads", "highlight_field": "lead_title"}
            for l in rows
        ], "total": len(rows)}

    elif mod == "opportunities" and allowed_fn("opportunities"):
        q = _scope_leads(db, cu).filter(
            or_(Lead.lead_type == "direct_opportunity", Lead.status.in_(["Opportunity Created", "Converted"]))
        )
        if filters.get("status__in"):
            q = q.filter(Lead.status.in_(filters["status__in"]))
        elif filters.get("status"):
            q = q.filter(Lead.status == filters["status"])
        q = _date_filter(q, Lead.created_at)
        rows = q.order_by(Lead.created_at.desc()).limit(limit).all()
        a_ids = {o.assigned_to for o in rows if o.assigned_to}
        umap = _fetch_user_names(db, a_ids)
        results["opportunities"] = {"items": [
            {"id": o.id, "module": "opportunities", "title": o.lead_title, "subtitle": o.customer_name,
             "ref_id": o.opportunity_ref_id or o.lead_ref_id, "status": o.status,
             "assigned_to_name": umap.get(int(o.assigned_to)) if o.assigned_to else None,
             "url": "/opportunities", "highlight_field": "lead_title"}
            for o in rows
        ], "total": len(rows)}

    elif mod == "workorders" and allowed_fn("workorders"):
        q = _scope_workorders(db, cu)
        if filters.get("status__in"):
            q = q.filter(WorkOrder.status.in_(filters["status__in"]))
        elif filters.get("status"):
            q = q.filter(WorkOrder.status == filters["status"])
        q = _date_filter(q, WorkOrder.created_at)
        rows = q.order_by(WorkOrder.created_at.desc()).limit(limit).all()
        pm_ids = {w.project_manager_id for w in rows if w.project_manager_id}
        umap = _fetch_user_names(db, pm_ids)
        results["workorders"] = {"items": [
            {"id": w.id, "module": "workorders",
             "title": w.project_title or w.wo_number, "subtitle": w.customer_name,
             "ref_id": w.wo_number, "status": str(w.status) if w.status else None,
             "assigned_to_name": umap.get(int(w.project_manager_id)) if w.project_manager_id else None,
             "url": "/workorders", "highlight_field": "project_title"}
            for w in rows
        ], "total": len(rows)}

    elif mod == "travel" and allowed_fn("travel"):
        q = _scope_travel(db, cu)
        if filters.get("status__in"):
            q = q.filter(TravelRequest.status.in_(filters["status__in"]))
        elif filters.get("status"):
            q = q.filter(TravelRequest.status == filters["status"])
        q = _date_filter(q, TravelRequest.created_at)
        rows = q.order_by(TravelRequest.created_at.desc()).limit(limit).all()
        emp_ids = {t.employee_id for t in rows if t.employee_id}
        umap = _fetch_user_names(db, emp_ids)
        results["travel"] = {"items": [
            {"id": t.id, "module": "travel",
             "title": t.purpose or t.request_number,
             "subtitle": _join(t.from_city, t.to_city),
             "ref_id": t.request_number,
             "status": str(t.status) if t.status else None,
             "assigned_to_name": umap.get(int(t.employee_id)) if t.employee_id else None,
             "url": "/travel", "highlight_field": "purpose"}
            for t in rows
        ], "total": len(rows)}

    elif mod == "customers" and allowed_fn("customers"):
        q = apply_data_scope(
            db, db.query(Customer).filter(Customer.is_deleted == False),
            cu, "customers", Customer.created_by, Customer.assigned_to,
        )
        if filters.get("account_status"):
            q = q.filter(Customer.account_status == filters["account_status"])
        rows = q.order_by(Customer.customer_name).limit(limit).all()
        a_ids = {c.assigned_to for c in rows if c.assigned_to}
        umap = _fetch_user_names(db, a_ids)
        results["customers"] = {"items": [
            {"id": c.id, "module": "customers", "title": c.customer_name,
             "subtitle": _join(c.billing_city, c.billing_state), "ref_id": None,
             "status": str(c.account_status) if c.account_status else None,
             "assigned_to_name": umap.get(int(c.assigned_to)) if c.assigned_to else None,
             "url": "/customers", "highlight_field": "customer_name"}
            for c in rows
        ], "total": len(rows)}

    for key in ("customers", "leads", "opportunities", "tenders", "workorders",
                "travel", "emdbg", "oem", "masters", "competitors"):
        if key not in results:
            results[key] = {"items": [], "total": 0}

    return results


# ─── Private helpers ──────────────────────────────────────────────────────────

def _empty():
    return {
        k: {"items": [], "total": 0}
        for k in ("customers", "leads", "opportunities", "tenders", "workorders",
                  "travel", "emdbg", "oem", "masters", "competitors")
    }


def _join(*parts) -> Optional[str]:
    """Join non-empty string parts with ', '."""
    joined = ", ".join(p for p in parts if p)
    return joined or None


def _pick_field(term: str, row, fields: list) -> str:
    """Return the first field whose value contains the search term (case-insensitive)."""
    t = term.lower()
    for f in fields:
        v = getattr(row, f, None)
        if v and t in str(v).lower():
            return f
    return fields[0] if fields else ""
