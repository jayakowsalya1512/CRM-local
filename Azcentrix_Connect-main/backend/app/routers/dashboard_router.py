"""Dashboard router — overview stats, KAM, pipeline, preference storage.

FIXES vs previous version:
  1. Tender.our_bid_amount  → Tender.bid_amount       (correct column from all_models.py)
  2. Tender.bid_date        → Tender.submission_date   (correct column from all_models.py)
  3. WorkOrder.contract_value → WorkOrder.wo_value     (correct column from all_models.py)
  4. WorkOrder.amount_received → guarded try/except    (column doesn't exist in model)
  5. WorkOrder.payment_due_date/payment_status → guarded try/except
  6. Role check uses tenant admin/ceo roles to match VALID_ROLES
  7. _scope_leads/_scope_tenders role list fixed to include 'vp'
  8. DashboardPreference.widgets is JSON in DB — handle both dict and string on read
  9. quarterly revenue date filter uses created_at (reliable) instead of updated_at
"""
import json
from typing import Any
import calendar
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from fastapi.encoders import jsonable_encoder
from sqlalchemy.orm import Session
from sqlalchemy import func, or_, and_, text as sa_text
from datetime import date, timedelta, datetime
from app.core.timezone import now_ist, today_ist
from typing import Optional
from app.dependencies import get_tenant_db, get_current_user
from app.models.all_models import (
    User, Lead, Tender, WorkOrder, EMDBG, KAMActivity, Customer,
    TravelRequest, ActivityLog, Approval, DashboardPreference,
    SalesCustomerAssignment, Group, Permission, Role, RolePermission, UserReportingHierarchy,
    LeadSource, KAMTarget, LoginLog, UserSession, Region, State, OrgTreeNode,
    VerticalSector, ApprovalRequest, ApprovalRequestStep, Alert, Notification,
)
from app.services.cache_service import (
    CACHE_TTL_SECONDS,
    badges_cache_key,
    cache_get_json,
    cache_set_json,
    invalidate_sidebar_cache,
    sidebar_cache_key,
    tenant_slug_from_db,
)
from app.utils.data_scope import get_module_data_scope, get_team_user_ids

router = APIRouter()

# Badge helpers imported from individual routers — used only by the combined /badges endpoint
try:
    from app.routers.customer_router import _apply_customer_data_scope as _customer_scope
    from app.routers.lead_router import _scope_query as _lead_scope
    from app.routers.tender_router import apply_data_scope as _tender_scope
    from app.routers.workorder_router import _scope_user_ids as _wo_scope_user_ids
    from app.routers.emdbg_router import _emdbg_scope_user_ids
    from app.routers.approvals_router import (
        _refresh_travel_auto_approvals,
        _get_shadowed_dynamic_travel_record_ids,
    )
    from app.services.alert_service import sync_alerts_for_user as _sync_alerts
    _BADGE_HELPERS_AVAILABLE = True
except Exception:
    _BADGE_HELPERS_AVAILABLE = False

DASHBOARD_TAB_PERMISSIONS = {
    "customers": "dashboard.customers.view",
    "leads": "dashboard.leads.view",
    "tenders": "dashboard.tenders.view",
    "travel": "dashboard.travel.view",
    "emdbg": "dashboard.emdbg.view",
    "kam360": "dashboard.kam360.view",
    "login_tracker": "dashboard.login_tracker.view",
}

def _dashboard_permission_keys(db: Session, cu: User) -> set[str]:
    role = db.query(Role).filter(
        Role.name == cu.role,
        Role.is_active == True,
    ).first()
    if not role:
        return set()

    permission_ids = [
        row.permission_id
        for row in db.query(RolePermission).filter(RolePermission.role_id == role.id).all()
    ]
    if not permission_ids:
        return set()

    return {
        row.key
        for row in db.query(Permission).filter(Permission.id.in_(permission_ids)).all()
    }


def _require_dashboard_permissions(db: Session, cu: User, *permission_keys: str) -> None:
    granted_permissions = _dashboard_permission_keys(db, cu)
    if any(permission_key not in granted_permissions for permission_key in permission_keys):
        raise HTTPException(403, "Dashboard access permission required")


# ─── Role-scoped query helpers ───────────────────────────────────────────────

def _scope_leads(q, db: Session, cu: User):
    scope_user_ids = _scope_user_ids(db, cu)

    if scope_user_ids is None:
        return q

    return q.filter(or_(
        Lead.assigned_to.in_(scope_user_ids),
        Lead.created_by.in_(scope_user_ids),
    ))

def _scope_tenders(q, db: Session, cu: User):
    scope_user_ids = _scope_user_ids(db, cu)

    if scope_user_ids is None:
        return q

    return q.filter(or_(
        Tender.assigned_to.in_(scope_user_ids),
        Tender.created_by.in_(scope_user_ids),
    ))

def _scope_workorders(q, db: Session, cu: User):
    scope_user_ids = _scope_user_ids(db, cu)

    if scope_user_ids is None:
        return q

    return q.outerjoin(Tender, WorkOrder.tender_id == Tender.id).filter(or_(
        WorkOrder.created_by.in_(scope_user_ids),
        WorkOrder.project_manager_id.in_(scope_user_ids),
        Tender.assigned_to.in_(scope_user_ids),
        Tender.created_by.in_(scope_user_ids),
    ))

def _scope_emdbg(q, db: Session, cu: User):
    # Accounts only ever work with approved instruments; visibility itself
    # still comes from the role's Dashboard data scope below.
    if _normalized_role(cu.role) == "accounts":
        q = q.filter(EMDBG.approval_status == "approved")

    scope_user_ids = _scope_user_ids(db, cu)

    if scope_user_ids is None:
        return q

    return q.outerjoin(Tender, EMDBG.tender_id == Tender.id).filter(or_(
        EMDBG.created_by.in_(scope_user_ids),
        Tender.assigned_to.in_(scope_user_ids),
        Tender.created_by.in_(scope_user_ids),
    ))

def _scope_customers(q, db: Session, cu: User):
    """Scope customers exactly like the Customers module list endpoint."""
    scope_user_ids = _scope_user_ids(db, cu)
    q = q.filter(Customer.is_deleted == False)
    if scope_user_ids is None:
        return q

    active_assignment_customer_ids = db.query(SalesCustomerAssignment.customer_id).filter(
        SalesCustomerAssignment.is_active == True,
    )

    scoped_assignment_customer_ids = db.query(SalesCustomerAssignment.customer_id).filter(
        SalesCustomerAssignment.is_active == True,
        SalesCustomerAssignment.user_id.in_(scope_user_ids),
    )

    return q.filter(or_(
        Customer.created_by.in_(scope_user_ids),
        Customer.id.in_(scoped_assignment_customer_ids),
        and_(
            ~Customer.id.in_(active_assignment_customer_ids),
            Customer.assigned_to.in_(scope_user_ids),
        ),
    ))


def _parse_group_ids(raw: Any) -> set[int]:
    group_ids: set[int] = set()
    for part in str(raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            group_ids.add(int(part))
        except ValueError:
            continue
    return group_ids


def _normalized_role(role: Optional[str]) -> str:
    normalized = (role or "").strip().lower().replace("-", "_").replace(" ", "_")
    return {
        "sales_executive": "sales",
        "salesexecutive": "sales",
        "sales_head": "manager",
        "saleshead": "manager",
        "vice_president": "vp",
        "vicepresident": "vp",
        "administrator": "ceo",
    }.get(normalized, normalized)


def _normalize_customer_vertical(value: Optional[str]) -> Optional[str]:
    if not isinstance(value, str):
        return value

    cleaned = " ".join(value.replace("\u00a0", " ").split()).strip()
    return cleaned or None

def _active_customer_segments(db: Session) -> list[str]:
    rows = db.query(VerticalSector).filter(
        VerticalSector.is_active == True
    ).order_by(VerticalSector.display_order, VerticalSector.name, VerticalSector.id).all()

    segments = []
    seen = set()

    for row in rows:
        name = _normalize_customer_vertical(row.name)
        if not name:
            continue

        key = name.casefold()
        if key in seen:
            continue

        seen.add(key)
        segments.append(name)

    return segments

def _get_org_tree_user_ids(db: Session, user_id: int) -> list[int]:
    """Return all user IDs visible to user_id based on the Group Fixing tree (OrgTreeNode)."""
    return get_team_user_ids(db, int(user_id))


def _scope_user_ids(db: Session, cu: User) -> Optional[list[int]]:
    """
    User ids whose records the dashboard may show, driven by the Data
    Visibility configured for the role's Dashboard module.

    None means unrestricted ("all"); an empty list means nothing ("none").
    """
    scope = get_module_data_scope(db, cu, "dashboard")

    if scope == "all":
        return None
    if scope == "none":
        return []
    if scope == "own":
        return [int(cu.id)]

    return _get_org_tree_user_ids(db, int(cu.id))



def _activity_scope_user_ids(db: Session, cu: User) -> Optional[list[int]]:
    """User ids whose activity appears in the dashboard feed (Dashboard data scope)."""
    return _scope_user_ids(db, cu)


def _scope_customers_count(db: Session, cu: User) -> int:
    """Role-scoped customer count matching the Customers module list endpoint."""
    return _scope_customers(db.query(Customer), db, cu).count()


# ─── Main dashboard overview ─────────────────────────────────────────────────

@router.get("")
def get_dashboard(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    _require_dashboard_permissions(db, cu, "dashboard.view")
    today = today_ist()

    # ── Leads ──────────────────────────────────────────────────────────────
    total_leads = _scope_leads(
        db.query(Lead).filter(Lead.is_deleted == False, Lead.lead_type == 'lead'), db, cu
    ).count()

    new_leads = _scope_leads(
        db.query(Lead).filter(Lead.is_deleted == False, Lead.lead_type == 'lead', Lead.status == 'Assigned'), db, cu
    ).count()

    converted_leads = _scope_leads(
        db.query(Lead).filter(Lead.is_deleted == False, Lead.lead_type == 'lead', Lead.status == 'Converted'), db, cu
    ).count()

    converted_opportunities = _scope_leads(
        db.query(Lead).filter(Lead.is_deleted == False, Lead.status == 'Converted'), db, cu
    ).count()

    active_leads = _scope_leads(
        db.query(Lead).filter(
            Lead.is_deleted == False,
            Lead.lead_type == 'lead',
            Lead.status.in_(['Assigned', 'Contacted', 'Qualified', 'Proposal Pending', 'Nurturing', 'Opportunity Created'])
        ), db, cu
    ).count()

    follow_ups_today = _scope_leads(
        db.query(Lead).filter(Lead.is_deleted == False, Lead.lead_type == 'lead', Lead.follow_up == today), db, cu
    ).count()

    qualified_leads = _scope_leads(
        db.query(Lead).filter(Lead.is_deleted == False, Lead.lead_type == 'lead', Lead.status == 'Qualified'), db, cu
    ).count()

    opportunity_created = _scope_leads(
        db.query(Lead).filter(Lead.is_deleted == False, Lead.status == 'Opportunity Created'), db, cu
    ).count()

    lead_count = total_leads
    total_opportunities = opportunity_created + converted_opportunities

    lead_value = (
        _scope_leads(
            db.query(func.sum(Lead.est_value)).filter(
                Lead.is_deleted == False,
                Lead.lead_type == 'lead',
            ), db, cu
        ).scalar() or 0
    )

    opportunity_value = (
        _scope_leads(
            db.query(func.sum(Lead.est_value)).filter(
                Lead.is_deleted == False,
                Lead.status.in_(['Opportunity Created', 'Converted']),
            ), db, cu
        ).scalar() or 0
    )

    # ── Tenders ─────────────────────────────────────────────────────────────
    total_tenders = _scope_tenders(
        db.query(Tender).filter(Tender.is_deleted == False), db, cu
    ).count()

    active_tenders = _scope_tenders(
        db.query(Tender).filter(
            Tender.is_deleted == False,
            Tender.tender_status.notin_(['Closed'])
        ), db, cu
    ).count()

    won_tenders = _scope_tenders(
        db.query(Tender).filter(Tender.is_deleted == False, Tender.result == 'Won'), db, cu
    ).count()

    # upcoming_bids — tenders with submission_date in next 7 days (bid_date doesn't exist)
    upcoming_bids = _scope_tenders(
        db.query(Tender).filter(
            Tender.is_deleted == False,
            Tender.submission_date >= today,
            Tender.submission_date <= today + timedelta(days=7),
            Tender.tender_status.notin_(['Closed'])
        ), db, cu
    ).count()


    upcoming_bid_dates  = []
    upcoming_rows = _scope_tenders(
        db.query(Tender).filter(
        Tender.is_deleted == False,
        Tender.submission_date >= today,
        Tender.submission_date <= today + timedelta(days=30),
        Tender.tender_status.notin_(['Closed'])
    ),
    db,
    cu
).order_by(Tender.submission_date).limit(30).all()

    # Build lead_source lookup for portal name resolution
    _source_ids = [t.source_id for t in upcoming_rows if t.source_id]
    _source_map: dict = {}
    if _source_ids:
        for ls in db.query(LeadSource).filter(LeadSource.id.in_(_source_ids)).all():
            _source_map[ls.id] = ls.name

    for t in upcoming_rows:
        days_left = (t.submission_date - today).days if t.submission_date else 999
        portal_name = _source_map.get(t.source_id) or t.source_portal or ""
        upcoming_bid_dates.append({
            "id": t.id,
            "tender_num": t.tender_num or "",
            "title": t.tender_title or "",
            "customer": t.customer_name or "",
            "submission_date": t.submission_date.isoformat() if t.submission_date else None,
            "days_left": days_left,
            "est_value": float(t.est_value or 0),
            "portal": portal_name,
            "status": t.tender_status or "",
            "priority": "urgent" if days_left <= 3 else "upcoming" if days_left <= 7 else "normal",
    })

    tender_value = (
        _scope_tenders(
            db.query(func.sum(Tender.est_value)).filter(Tender.is_deleted == False), db, cu
        ).scalar() or 0
    )

    active_tender_value = (
        _scope_tenders(
            db.query(func.sum(Tender.est_value)).filter(
                Tender.is_deleted == False,
                Tender.tender_status.notin_(['Closed']),
            ), db, cu
        ).scalar() or 0
    )

    # ── Financial — use bid_amount (correct column name from all_models.py) ──
    won_value = (
        _scope_tenders(
            db.query(func.sum(func.coalesce(Tender.bid_amount, Tender.est_value, 0))).filter(
                Tender.is_deleted == False, Tender.result == 'Won'
            ), db, cu
        ).scalar() or 0
    )

    pipeline_value = (
        _scope_tenders(
            db.query(func.sum(Tender.est_value)).filter(
                Tender.is_deleted == False,
                Tender.result == 'Pending',
                Tender.tender_status.notin_(['Closed'])
            ), db, cu
        ).scalar() or 0
    )

    # ── Operations ───────────────────────────────────────────────────────────
    customer_base = _scope_customers(db.query(Customer), db, cu)
    total_customers = customer_base.count()
    customer_potential_value = (
        _scope_customers(db.query(func.sum(Customer.potential_value)), db, cu)
        .scalar() or 0
    )

    # WorkOrder statuses from all_models.py:
    # 'Draft','Confirmed','In Progress','On Hold','Delayed','Completed','Cancelled','Closed'
    wo_value_expr = func.coalesce(WorkOrder.wo_value, WorkOrder.po_value, 0)
    wo_base = _scope_workorders(db.query(WorkOrder), db, cu)

    total_work_orders = wo_base.count()
    active_work_orders = wo_base.filter(
        WorkOrder.status.in_(['Confirmed', 'In Progress', 'On Hold'])
    ).count()
    active_wo = active_work_orders

    delayed_wo = wo_base.filter(WorkOrder.status == 'Delayed').count()
    work_order_value = wo_base.with_entities(func.sum(wo_value_expr)).scalar() or 0

    emdbg_base = _scope_emdbg(db.query(EMDBG), db, cu)
    total_emdbg = emdbg_base.count()
    active_emdbg = emdbg_base.filter(EMDBG.status == 'Active').count()
    emdbg_value = emdbg_base.with_entities(func.sum(EMDBG.amount)).scalar() or 0
    active_emdbg_value = (
        emdbg_base.filter(EMDBG.status == 'Active')
        .with_entities(func.sum(EMDBG.amount))
        .scalar() or 0
    )

    emdbg_expiring = emdbg_base.filter(
        EMDBG.status == 'Active',
        EMDBG.expiry_date <= today + timedelta(days=30),
    ).count()

    emdbg_critical = emdbg_base.filter(
        EMDBG.status == 'Active',
        EMDBG.expiry_date <= today + timedelta(days=7),
    ).count()

    # Pending approvals — only for roles that manage approvals
    pending_approvals = 0
    total_approvals = 0
    try:
        approval_base = db.query(Approval)
        approval_scope_ids = _scope_user_ids(db, cu)
        if approval_scope_ids is not None:
            approval_base = approval_base.filter(or_(
                Approval.requested_by.in_(approval_scope_ids),
                Approval.requested_to.in_(approval_scope_ids),
            ))
        total_approvals = approval_base.count()
        pending_approvals = db.query(Approval).filter(
            Approval.requested_to == cu.id,
            Approval.status == 'pending'
        ).count()
    except Exception:
        pending_approvals = 0
        total_approvals = 0

    today_kam = db.query(KAMActivity).filter(
        KAMActivity.user_id == cu.id,
        KAMActivity.activity_date == today
    ).count()

    # ── Payment / Receivables — guarded for missing columns ─────────────────
    # WorkOrder model columns: wo_value, po_value, advance_amount, etc.
    # There is NO contract_value, amount_received, payment_due_date, payment_status
    # Use wo_value as proxy for invoiced amount on completed/active WOs
    total_invoiced   = 0
    total_received   = 0
    overdue_payments = 0

    try:
        total_invoiced = wo_base.with_entities(
            func.sum(wo_value_expr)
        ).filter(
            WorkOrder.status.in_(['Completed', 'In Progress', 'Confirmed'])
        ).scalar() or 0
    except Exception:
        total_invoiced = 0

    # advance_amount is the closest proxy for received payment
    try:
        total_received = wo_base.with_entities(
            func.sum(WorkOrder.advance_amount)
        ).filter(WorkOrder.advance_received == True).scalar() or 0
    except Exception:
        total_received = 0

    # overdue: WOs past delivery_date that are not completed/cancelled
    try:
        overdue_payments = wo_base.filter(
            WorkOrder.delivery_date < today,
            WorkOrder.status.notin_(['Completed', 'Closed', 'Cancelled'])
        ).count()
    except Exception:
        overdue_payments = 0

    collection_rate = round(
        float(total_received) / float(total_invoiced) * 100, 1
    ) if total_invoiced else 0

    # ── Chart data ───────────────────────────────────────────────────────────
    # Lead by status
    lead_status_rows = _scope_leads(
        db.query(Lead.status, func.count(Lead.id)).filter(
            Lead.is_deleted == False,
            Lead.lead_type == 'lead',
        ),
        db, cu
    ).group_by(Lead.status).all()

    # Tender by result
    tender_result_rows = _scope_tenders(
        db.query(Tender.result, func.count(Tender.id)).filter(Tender.is_deleted == False),
        db, cu
    ).group_by(Tender.result).all()

    # Monthly lead trend — last 6 months
    monthly_trend = []
    for i in range(5, -1, -1):
        # Build month start/end reliably
        ref_date = today.replace(day=1)
        for _ in range(i):
            # Go back one month
            ref_date = (ref_date - timedelta(days=1)).replace(day=1)
        year = ref_date.year
        month = ref_date.month
        last_day = calendar.monthrange(year, month)[1]
        m_start = date(year, month, 1)
        m_end   = date(year, month, last_day)

        cnt = _scope_leads(
            db.query(Lead).filter(
                Lead.is_deleted == False,
                Lead.lead_type == 'lead',
                Lead.created_at >= m_start,
                Lead.created_at <= m_end,
            ), db, cu
        ).count()
        monthly_trend.append({
            "month": m_start.strftime("%b"),
            "leads": cnt
        })

    # Quarterly revenue — last 4 quarters
    quarterly_revenue = []
    for q_off in range(3, -1, -1):
        # Current quarter number (1-4)
        current_q = (today.month - 1) // 3  # 0-indexed quarter
        # Go back q_off quarters
        q_total = current_q - q_off
        q_year  = today.year + (q_total // 4 if q_total < 0 else 0)
        q_num   = q_total % 4
        if q_num < 0:
            q_num  += 4
            q_year -= 1
        q_month_start = q_num * 3 + 1
        q_month_end   = q_month_start + 2
        last_day_q    = calendar.monthrange(q_year, q_month_end)[1]
        q_start = date(q_year, q_month_start, 1)
        q_end   = date(q_year, q_month_end, last_day_q)

        val = _scope_tenders(
            db.query(func.sum(Tender.bid_amount)).filter(
                Tender.is_deleted == False,
                Tender.result == 'Won',
                Tender.created_at >= q_start,
                Tender.created_at <= q_end,
            ), db, cu
        ).scalar() or 0

        quarterly_revenue.append({
            "quarter": f"Q{q_num + 1} {q_year}",
            "revenue": float(val),
        })

    # Recent activity log
    activity_scope_ids = _activity_scope_user_ids(db, cu)
    recent_log_q = db.query(ActivityLog)
    if activity_scope_ids is not None:
        recent_log_q = recent_log_q.filter(ActivityLog.user_id.in_(activity_scope_ids))
    recent_log = recent_log_q.order_by(
        ActivityLog.created_at.desc()
    ).limit(20).all()

    return {
        "overview": {
            "total_leads":        total_leads,
            "lead_count":         lead_count,
            "assigned_leads":     new_leads,
            "qualified_leads":    qualified_leads,
            "new_leads":          new_leads,
            "converted_leads":    converted_leads,
            "opportunity_created": opportunity_created,
            "total_opportunities": total_opportunities,
            "active_leads":       active_leads,
            "follow_ups_today":   follow_ups_today,
            "lead_value":         float(lead_value),
            "opportunity_value":  float(opportunity_value),
            "total_tenders":      total_tenders,
            "active_tenders":     active_tenders,
            "won_tenders":        won_tenders,
            "upcoming_bids":      upcoming_bids,
            "upcoming_bid_dates": upcoming_bid_dates,
            "tender_value":       float(tender_value),
            "active_tender_value": float(active_tender_value),
            "won_value":          float(won_value),
            "pipeline_value":     float(pipeline_value),
            "total_customers":    total_customers,
            "customer_value":     float(customer_potential_value),
            "customer_potential_value": float(customer_potential_value),
            "total_work_orders":  total_work_orders,
            "active_work_orders": active_work_orders,
            "work_order_value":   float(work_order_value),
            "active_wo":          active_wo,
            "delayed_wo":         delayed_wo,
            "total_emdbg":        total_emdbg,
            "active_emdbg":       active_emdbg,
            "emdbg_count":        total_emdbg,
            "emdbg_value":        float(emdbg_value),
            "active_emdbg_value": float(active_emdbg_value),
            "emdbg_expiring":     emdbg_expiring,
            "emdbg_critical":     emdbg_critical,
            "pending_approvals":  pending_approvals,
            "total_approvals":    total_approvals,
            "today_kam":          today_kam,
            "total_invoiced":     float(total_invoiced),
            "total_received":     float(total_received),
            "overdue_payments":   overdue_payments,
            "collection_rate":    collection_rate,
        },
        "lead_by_status":    [{"status": s or "Assigned", "count": c} for s, c in lead_status_rows],
        "tender_by_result":  [{"result": r or "Pending",  "count": c} for r, c in tender_result_rows],
        "monthly_trend":     monthly_trend,
        "quarterly_revenue": quarterly_revenue,
        "recent_activity": [
            {
                "id":          a.id,
                "description": a.description,
                "module":      a.module,
                "color":       a.color,
                "created_at":  a.created_at.isoformat() if a.created_at else None,
            }
            for a in recent_log
        ],
    }


# ─── KAM Summary ─────────────────────────────────────────────────────────────

@router.get("/kam-summary")
def get_kam_summary(
    period: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    _require_dashboard_permissions(db, cu, "dashboard.view", "dashboard.kam360.view")
    if not period:
        period = now_ist().strftime('%Y-%m')
    year, month = int(period[:4]), int(period[5:7])
    last_day = calendar.monthrange(year, month)[1]

    activities = db.query(KAMActivity).filter(
        KAMActivity.user_id == cu.id,
        KAMActivity.activity_date.between(f"{period}-01", f"{period}-{last_day:02d}"),
    ).all()

    by_type: dict = {}
    for a in activities:
        by_type[a.activity_type] = by_type.get(a.activity_type, 0) + 1        
    completed = sum(1 for a in activities if a.status == 'Completed')
    return {
        "period":          period,
        "total":           len(activities),
        "completed":       completed,
        "completion_rate": round(completed / len(activities) * 100, 1) if activities else 0,
        "by_type":         by_type,
    }


# ─── Pipeline ─────────────────────────────────────────────────────────────────

@router.get("/pipeline")
def get_pipeline(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    _require_dashboard_permissions(db, cu, "dashboard.view")
    stages = (
        db.query(Tender.tender_status, func.count(Tender.id), func.sum(Tender.est_value))
        .filter(Tender.is_deleted == False)
        .group_by(Tender.tender_status).all()
    )
    return [
        {"stage": s or "Unknown", "count": c, "value": float(v or 0)}
        for s, c, v in stages
    ]


# ─── Dashboard Preference ─────────────────────────────────────────────────────

class PreferencePayload(BaseModel):
    layout:  Optional[str] = None
    widgets: Optional[str] = None
    theme:   Optional[str] = "light"


@router.get("/preference")
def get_preference(
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    _require_dashboard_permissions(db, cu, "dashboard.view")
    pref = db.query(DashboardPreference).filter(
        DashboardPreference.user_id == cu.id
    ).first()
    if not pref:
        return {"layout": None, "widgets": None, "theme": "light"}

    # widgets column is JSON in the DB — it may come back as dict or str
    widgets_val = pref.widgets
    if isinstance(widgets_val, (dict, list)):
        # Already parsed by SQLAlchemy JSON column — re-serialize for the frontend
        widgets_str = json.dumps(widgets_val)
    else:
        widgets_str = widgets_val  # string or None

    return {
        "layout":  widgets_str,
        "widgets": widgets_str,
        "theme":   "light",
    }


# ─── Sidebar Order Preference ─────────────────────────────────────────────────
# Persisted on users.sidebar_order (JSON column, already in all_models.py User).
# Payload: list of nav item path strings in the user's preferred order,
# e.g. ["/dashboard", "/customers", "/leads", ...]

class SidebarOrderPayload(BaseModel):
    order: Any


@router.get("/sidebar-order")
def get_sidebar_order(
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    """Return the user's saved sidebar order, or null if not set."""
    tenant_slug = tenant_slug_from_db(db)
    cache_key = sidebar_cache_key(tenant_slug, cu.id, "order") if tenant_slug else ""
    if cache_key:
        cached = cache_get_json(cache_key, "sidebar-order")
        if cached is not None:
            return cached

    order = cu.sidebar_order
    if isinstance(order, list):
        response = {"order": order}
        if cache_key:
            cache_set_json(cache_key, response, CACHE_TTL_SECONDS["sidebar"])
        return response
    if isinstance(order, str):
        try:
            response = {"order": json.loads(order)}
            if cache_key:
                cache_set_json(cache_key, response, CACHE_TTL_SECONDS["sidebar"])
            return response
        except Exception:
            pass
    response = {"order": None}
    if cache_key:
        cache_set_json(cache_key, response, CACHE_TTL_SECONDS["sidebar"])
    return response


@router.put("/sidebar-order")
def save_sidebar_order(
    payload: SidebarOrderPayload,
    db:      Session = Depends(get_tenant_db),
    cu:      User    = Depends(get_current_user),
):
    """Persist the user's sidebar item order."""
    user = db.query(User).filter(User.id == cu.id).first()
    if user:
        user.sidebar_order = payload.order
        db.commit()
    invalidate_sidebar_cache(db, cu.id)
    return {"status": "saved"}


@router.put("/preference")
def save_preference(
    payload: PreferencePayload,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    _require_dashboard_permissions(db, cu, "dashboard.view")
    # Accept whichever of widgets/layout was sent
    new_widgets = payload.widgets or payload.layout

    pref = db.query(DashboardPreference).filter(
        DashboardPreference.user_id == cu.id
    ).first()

    if pref:
        if new_widgets is not None:
            # Store as parsed JSON if the column is JSON type, else as string
            try:
                pref.widgets = json.loads(new_widgets)
            except (json.JSONDecodeError, TypeError):
                pref.widgets = new_widgets
    else:
        try:
            parsed = json.loads(new_widgets) if new_widgets else None
        except (json.JSONDecodeError, TypeError):
            parsed = new_widgets
        pref = DashboardPreference(user_id=cu.id, widgets=parsed)
        db.add(pref)

    db.commit()
    db.refresh(pref)
    return {"status": "saved"}


# =============================================================================
# TAB ANALYTICS  —  GET /dashboard/tab/{module}
# =============================================================================

def _parse_date(s) -> Optional[date]:
    if not s:
        return None
    try:
        return date.fromisoformat(str(s))
    except Exception:
        return None


def _month_buckets(today: date):
    """Return last-6-month (start, end, label) tuples, oldest first."""
    buckets = []
    for i in range(5, -1, -1):
        ref = today.replace(day=1)
        for _ in range(i):
            ref = (ref - timedelta(days=1)).replace(day=1)
        last_day = calendar.monthrange(ref.year, ref.month)[1]
        buckets.append((ref, date(ref.year, ref.month, last_day), ref.strftime("%b")))
    return buckets


def _scope_customers_q(db: Session, cu: User):
    return _scope_customers(db.query(Customer), db, cu)


def _owners_list(db: Session, cu: Optional[User] = None):
    q = db.query(User).filter(User.is_active == True)

    if cu:
        scope_user_ids = _scope_user_ids(db, cu)
        if scope_user_ids is not None:
            q = q.filter(User.id.in_(scope_user_ids))

    return [
        {"id": u.id, "name": u.full_name or u.username}
        for u in q.order_by(User.full_name).all()
    ]

# ─── Customers Tab ─────────────────────────────────────────────────────────────

def _tab_customers(db, cu, d_from, d_to, assigned_to, status, result, state, country, customer_id, today):
    base = _scope_customers_q(db, cu)
    if assigned_to:
        base = base.filter(Customer.assigned_to == assigned_to)
    if status:
        base = base.filter(Customer.account_status == status)
    if state:
        base = base.filter(Customer.billing_state == state)
    if country:
        base = base.filter(Customer.billing_country == country)
    if d_from:
        base = base.filter(Customer.created_at >= d_from)
    if d_to:
        base = base.filter(Customer.created_at <= d_to)

    all_c = _scope_customers_q(db, cu)
    total    = base.count()
    active   = all_c.filter(Customer.account_status == 'Active').count()
    prospect = all_c.filter(Customer.account_status == 'Prospect').count()
    inactive = all_c.filter(Customer.account_status == 'Inactive').count()
    churned  = all_c.filter(Customer.account_status == 'Churned').count()

    by_status_rows   = all_c.with_entities(Customer.account_status, func.count(Customer.id)).group_by(Customer.account_status).all()
    by_state_rows    = all_c.with_entities(Customer.billing_state, func.count(Customer.id)).filter(Customer.billing_state.isnot(None)).group_by(Customer.billing_state).order_by(func.count(Customer.id).desc()).limit(12).all()
    by_industry_rows = all_c.with_entities(Customer.industry, func.count(Customer.id)).filter(Customer.industry.isnot(None)).group_by(Customer.industry).order_by(func.count(Customer.id).desc()).limit(12).all()
    by_group_rows    = all_c.with_entities(Customer.group_name, func.count(Customer.id)).filter(Customer.group_name.isnot(None)).group_by(Customer.group_name).order_by(func.count(Customer.id).desc()).limit(12).all()
    by_vertical_counts: dict[str, int] = {}
    for raw_vertical, cnt in (
        all_c.with_entities(Customer.customer_vertical, func.count(Customer.id))
        .filter(Customer.customer_vertical.isnot(None))
        .group_by(Customer.customer_vertical)
        .all()
    ):
        vertical_name = _normalize_customer_vertical(raw_vertical)
        if vertical_name:
            by_vertical_counts[vertical_name] = by_vertical_counts.get(vertical_name, 0) + int(cnt or 0)
    by_vertical_rows = sorted(by_vertical_counts.items(), key=lambda item: item[1], reverse=True)[:12]

    monthly = []
    for m_start, m_end, label in _month_buckets(today):
        cnt = all_c.filter(Customer.created_at >= m_start, Customer.created_at <= m_end).count()
        monthly.append({"month": label, "value": cnt})

    top_val = all_c.filter(Customer.potential_value.isnot(None)).order_by(Customer.potential_value.desc()).limit(10).all()
    top_leads_rows = (
        db.query(Lead.customer_id, Customer.customer_name, func.count(Lead.id).label('cnt'))
        .join(Customer, Lead.customer_id == Customer.id)
        .filter(Lead.is_deleted == False, Customer.is_deleted == False)
        .group_by(Lead.customer_id, Customer.customer_name)
        .order_by(func.count(Lead.id).desc()).limit(10).all()
    )

    table_rows = base.order_by(Customer.created_at.desc()).limit(100).all()

    # Batch-load lead/tender/won values per customer
    _cust_ids = [c.id for c in table_rows]
    _lead_val_map: dict = {}
    _tender_val_map: dict = {}
    _won_val_map: dict = {}
    if _cust_ids:
        for cid, sv in db.query(Lead.customer_id, func.sum(Lead.est_value)).filter(
            Lead.customer_id.in_(_cust_ids),
            Lead.is_deleted == False,
            Lead.status.notin_(['Converted', 'Lost']),
        ).group_by(Lead.customer_id).all():
            _lead_val_map[cid] = float(sv or 0)
        for cid, sv in db.query(Tender.customer_id, func.sum(Tender.est_value)).filter(
            Tender.customer_id.in_(_cust_ids),
            Tender.is_deleted == False,
            Tender.result.notin_(['Won', 'Lost']),
        ).group_by(Tender.customer_id).all():
            _tender_val_map[cid] = float(sv or 0)
        for cid, sv in db.query(Tender.customer_id, func.sum(Tender.bid_amount)).filter(
            Tender.customer_id.in_(_cust_ids),
            Tender.is_deleted == False,
            Tender.result == 'Won',
        ).group_by(Tender.customer_id).all():
            _won_val_map[cid] = float(sv or 0)

    states      = sorted({r[0] for r in db.query(Customer.billing_state).filter(Customer.billing_state.isnot(None)).distinct().all() if r[0]})
    countries   = sorted({r[0] for r in db.query(Customer.billing_country).filter(Customer.billing_country.isnot(None)).distinct().all() if r[0]})
    groups      = sorted({r[0] for r in db.query(Customer.group_name).filter(Customer.group_name.isnot(None)).distinct().all() if r[0]})
    verticals   = sorted({_normalize_customer_vertical(r[0]) for r in db.query(Customer.customer_vertical).filter(Customer.customer_vertical.isnot(None)).distinct().all() if r[0]})
    industries  = sorted({r[0] for r in db.query(Customer.industry).filter(Customer.industry.isnot(None)).distinct().all() if r[0]})

    return {
        "summary": {"total": total, "active": active, "prospect": prospect, "inactive": inactive, "churned": churned},
        "charts": {
            "by_status":   [{"name": s or "Unknown", "value": c} for s, c in by_status_rows],
            "by_state":    [{"name": s, "value": c} for s, c in by_state_rows if s],
            "by_industry": [{"name": i, "value": c} for i, c in by_industry_rows if i],
            "by_group":    [{"name": g, "value": c} for g, c in by_group_rows if g],
            "by_vertical": [{"name": v, "value": c} for v, c in by_vertical_rows if v],
            "monthly_new": monthly,
        },
        "top_lists": {
            "by_value":  [{"id": c.id, "name": c.customer_name, "value": float(c.potential_value or 0), "status": c.account_status, "state": c.billing_state} for c in top_val],
            "by_leads":  [{"id": r[0], "name": r[1], "count": r[2]} for r in top_leads_rows],
        },
        "table": [
            {"id": c.id, "name": c.customer_name, "status": c.account_status, "potential": c.account_potential,
             "state": c.billing_state, "country": c.billing_country, "industry": c.industry,
             "group": c.group_name, "vertical": _normalize_customer_vertical(c.customer_vertical),
             "potential_value": float(c.potential_value or 0),
             "lead_value": _lead_val_map.get(c.id, 0),
             "tender_value": _tender_val_map.get(c.id, 0),
             "won_value": _won_val_map.get(c.id, 0),
             "created_at": c.created_at.date().isoformat() if c.created_at else None}
            for c in table_rows
        ],
        "filters": {
            "statuses": ["Active", "Inactive", "Prospect", "Churned"],
            "states": states, "countries": countries, "groups": groups,
            "verticals": verticals, "industries": industries,
            "owners": _owners_list(db, cu),
        }
    }


# ─── Leads Tab ─────────────────────────────────────────────────────────────────

def _tab_leads(db, cu, d_from, d_to, assigned_to, status, result, state, country, customer_id, today):
    base = _scope_leads(db.query(Lead).filter(Lead.is_deleted == False, Lead.lead_type == 'lead'), db, cu)
    if assigned_to:
        base = base.filter(Lead.assigned_to == assigned_to)
    if status:
        base = base.filter(Lead.status == status)
    if customer_id:
        base = base.filter(Lead.customer_id == customer_id)
    if d_from:
        base = base.filter(Lead.created_at >= d_from)
    if d_to:
        base = base.filter(Lead.created_at <= d_to)

    total       = base.count()
    assigned    = base.filter(Lead.status == 'Assigned').count()
    qualified   = base.filter(Lead.status == 'Qualified').count()
    opportunity = base.filter(Lead.status == 'Opportunity Created').count()
    active      = base.filter(Lead.status.in_(['Assigned', 'Contacted', 'Qualified', 'Proposal Pending', 'Nurturing', 'Opportunity Created'])).count()
    converted   = base.filter(Lead.status == 'Converted').count()
    lost        = base.filter(Lead.status == 'Lost').count()
    overdue     = base.filter(Lead.follow_up < today, Lead.status.notin_(['Converted', 'Lost'])).count()
    high_val    = base.filter(Lead.est_value >= 1000000).count()
    assigned_value = base.filter(Lead.status == 'Assigned').with_entities(func.sum(Lead.est_value)).scalar() or 0
    qualified_value = base.filter(Lead.status == 'Qualified').with_entities(func.sum(Lead.est_value)).scalar() or 0
    opportunity_value = base.filter(Lead.status == 'Opportunity Created').with_entities(func.sum(Lead.est_value)).scalar() or 0
    converted_value = base.filter(Lead.status == 'Converted').with_entities(func.sum(Lead.est_value)).scalar() or 0

    by_status_rows   = base.with_entities(Lead.status, func.count(Lead.id)).group_by(Lead.status).all()
    by_priority_rows = base.with_entities(Lead.priority, func.count(Lead.id)).group_by(Lead.priority).all()
    by_region_rows   = base.with_entities(Lead.region, func.count(Lead.id)).filter(Lead.region.isnot(None)).group_by(Lead.region).order_by(func.count(Lead.id).desc()).limit(12).all()

    # ── Lead source name lookup ───────────────────────────────────────────────
    _lead_src_ids = [r[0] for r in base.with_entities(Lead.source_id).filter(Lead.source_id.isnot(None)).distinct().all()]
    _lead_source_map: dict = {}
    if _lead_src_ids:
        for ls in db.query(LeadSource).filter(LeadSource.id.in_(_lead_src_ids)).all():
            _lead_source_map[ls.id] = ls.name

    by_source_rows = (
        base.with_entities(Lead.source_id, func.count(Lead.id))
        .filter(Lead.source_id.isnot(None))
        .group_by(Lead.source_id)
        .order_by(func.count(Lead.id).desc())
        .limit(12)
        .all()
    )
    by_source = [
        {"name": _lead_source_map.get(src_id, f"Source {src_id}"), "value": int(cnt or 0)}
        for src_id, cnt in by_source_rows if src_id
    ]

    # ── Business vertical breakdown ───────────────────────────────────────────
    by_vertical_rows = (
        base.with_entities(Lead.business_vertical_id, func.count(Lead.id))
        .filter(Lead.business_vertical_id.isnot(None))
        .group_by(Lead.business_vertical_id)
        .all()
    )
    _bv_ids = [bv_id for bv_id, _ in by_vertical_rows if bv_id]
    _bv_map: dict = {}
    _bv_order_map: dict = {}
    if _bv_ids:
        try:
            id_csv = ", ".join(str(int(i)) for i in _bv_ids)
            bv_result = db.execute(
                sa_text(
                    f"SELECT id, COALESCE(business_vertical, business_unit) AS vname, display_order"
                    f" FROM business_category_units WHERE id IN ({id_csv})"
                )
            ).mappings().all()
            for row in bv_result:
                _bv_map[row["id"]] = (row["vname"] or "").strip() or f"Vertical {row['id']}"
                _bv_order_map[row["id"]] = int(row["display_order"] or row["id"])
        except Exception:
            pass
    by_vertical_rows = sorted(
        by_vertical_rows,
        key=lambda item: (_bv_order_map.get(item[0], 999999), _bv_map.get(item[0], f"Vertical {item[0]}")),
    )[:12]
    by_vertical = [
        {"name": _bv_map.get(bv_id, f"Vertical {bv_id}"), "value": int(cnt or 0)}
        for bv_id, cnt in by_vertical_rows if bv_id
    ]

    active_segments = _active_customer_segments(db)

    segment_source_map: dict[str, dict[str, int]] = {
        segment: {} for segment in active_segments
    }

    segment_total_map: dict[str, int] = {
        segment: 0 for segment in active_segments
    }

    segment_keys = {
        segment.casefold(): segment
        for segment in active_segments
    }

    segment_source_rows = (
        base
        .join(Customer, Lead.customer_id == Customer.id)
        .with_entities(
            Customer.customer_vertical,
            Lead.source_id,
            func.count(Lead.id),
        )
        .filter(
            Customer.is_deleted == False,
            Customer.customer_vertical.isnot(None),
        )
        .group_by(Customer.customer_vertical, Lead.source_id)
        .all()
    )

    for raw_segment, source_id, cnt in segment_source_rows:
        segment_name = _normalize_customer_vertical(raw_segment)
        if not segment_name:
            continue

        master_segment = segment_keys.get(segment_name.casefold())
        if not master_segment:
            continue

        source_name = _lead_source_map.get(source_id, f"Source {source_id}") if source_id else "Direct"
        count = int(cnt or 0)

        segment_source_map[master_segment][source_name] = (
            segment_source_map[master_segment].get(source_name, 0) + count
        )
        segment_total_map[master_segment] += count

    by_segment_source = [
        {
            "name": segment,
            "value": segment_total_map.get(segment, 0),
            "sources": [
                {"name": source_name, "value": source_count}
                for source_name, source_count in sorted(
                    segment_source_map.get(segment, {}).items(),
                    key=lambda item: item[1],
                    reverse=True,
                )
            ],
        }
        for segment in active_segments
    ]

    by_segment_source = sorted(
        by_segment_source,
        key=lambda item: item["value"],
        reverse=True,
    )

    monthly = []
    for m_start, m_end, label in _month_buckets(today):
        cnt = base.filter(Lead.created_at >= m_start, Lead.created_at <= m_end).count()
        monthly.append({"month": label, "value": cnt})

    top_value_rows = base.filter(Lead.est_value.isnot(None)).order_by(Lead.est_value.desc()).limit(10).all()
    top_customer_rows = (
        base.with_entities(Lead.customer_id, Lead.customer_name, func.count(Lead.id).label('cnt'), func.sum(Lead.est_value).label('val'))
        .filter(Lead.customer_id.isnot(None))
        .group_by(Lead.customer_id, Lead.customer_name)
        .order_by(func.count(Lead.id).desc()).limit(10).all()
    )

    table_rows = base.order_by(Lead.created_at.desc()).limit(100).all()
    assignees_q = db.query(User).filter(User.is_active == True).order_by(User.full_name).all()
    user_name_map = {u.id: (u.full_name or u.username) for u in assignees_q}
    user_group_map = {u.id: u.group_id for u in assignees_q}

    group_name_map = {
        str(g.id): g.name
        for g in db.query(Group).filter(Group.is_active == True).all()
    }

    def _resolve_group_name(group_id):
        if not group_id:
            return ""
        first = str(group_id).split(",")[0].strip()
        return group_name_map.get(first, "")

    customer_ids = [l.customer_id for l in table_rows if l.customer_id]

    customer_map = {
        c.id: c
        for c in db.query(Customer).filter(Customer.id.in_(customer_ids)).all()
    } if customer_ids else {}

    return {
        "summary": {
            "total": total,
            "assigned": assigned,
            "qualified": qualified,
            "opportunity": opportunity,
            "active": active,
            "converted": converted,
            "lost": lost,
            "overdue": overdue,
            "high_value": high_val,
            "lead_count": assigned + qualified,
            "lead_value": float(assigned_value + qualified_value),
            "opportunity_count": opportunity + converted,
            "opportunity_value": float(opportunity_value + converted_value),
            "assigned_value": float(assigned_value),
            "qualified_value": float(qualified_value),
            "converted_value": float(converted_value),
        },
        "charts": {
            "by_status":          [{"name": s or "Assigned", "value": c} for s, c in by_status_rows],
            "by_priority":        [{"name": p or "Medium",   "value": c} for p, c in by_priority_rows],
            "by_region":          [{"name": r, "value": c} for r, c in by_region_rows if r],
            "by_source":          by_source,
            "by_vertical":        by_vertical,
            "by_segment_source":  by_segment_source,
            "monthly_trend":      monthly,
        },
        "top_lists": {
            "by_value":    [{"id": l.id, "name": l.lead_title, "customer": l.customer_name, "value": float(l.est_value or 0), "status": l.status} for l in top_value_rows],
            "by_customer": [{"id": r[0], "name": r[1], "count": r[2], "value": float(r[3] or 0)} for r in top_customer_rows],
        },
        "table": [
            {
                "id": l.id,
                "ref": l.lead_ref_id,
                "title": l.lead_title,
                "customer": l.customer_name,
                "status": l.status,
                "priority": l.priority,
                "est_value": float(l.est_value or 0),
                "follow_up": l.follow_up.isoformat() if l.follow_up else None,

                "region": l.region,
                "branch": l.branch,

                "assigned_to": user_name_map.get(l.assigned_to),
                "assigned_to_id": l.assigned_to,

                "group": _resolve_group_name(user_group_map.get(l.assigned_to)),
                "assigned_group": _resolve_group_name(user_group_map.get(l.assigned_to)),

                "state": (
                    getattr(customer_map.get(l.customer_id), "billing_state", None)
                    or getattr(customer_map.get(l.customer_id), "shipping_state", None)
                    or l.region
                    or ""
                ),

                "source": _lead_source_map.get(l.source_id, "") if l.source_id else "",
                "industry": getattr(customer_map.get(l.customer_id), "industry", None) or "",
                "vertical": _normalize_customer_vertical(getattr(customer_map.get(l.customer_id), "customer_vertical", None)) or "",

                "created_at": l.created_at.date().isoformat() if l.created_at else None,
            }
            for l in table_rows
        ],
        "filters": {
            "statuses": ["Assigned", "Contacted", "Qualified", "Proposal Pending", "Nurturing", "Opportunity Created", "Converted", "Lost"],
            "priorities": ["High", "Medium", "Low"],
            "owners": _owners_list(db, cu),
        }
    }


# ─── Tenders Tab ───────────────────────────────────────────────────────────────

"""
Enhanced _tab_tenders handler for dashboard_router.py
======================================================
Drop-in replacement for the existing _tab_tenders() function.
Paste this function body into dashboard_router.py replacing the old one.

New additions vs old version:
  1. submitted / cancelled / overdue_bids / urgent_bids counts in summary
  2. average_bid_value in summary
  3. emd_required_count + emd_total_value in summary
  4. pipeline_stages with count, value, conversion, drop_off
  5. calendar list (upcoming tenders with days_left + priority)
  6. smart alerts list (overdue, urgent, emd_pending, won_without_po, lost_no_analysis)
  7. top_lists.highest_estimated, top_lists.top_customers, top_lists.top_users
  8. by_result includes value not just count
  9. prev_* comparison fields (total, won, won_value, pipeline) via same-period shift
  10. portal filtering support added

All existing logic (role scoping, date filters, table rows) is preserved.
"""

def _tab_tenders(db, cu, d_from, d_to, assigned_to, status, result, state, country, customer_id, today):
    from datetime import timedelta
    from sqlalchemy import func

    # ── Role-scoped base query (same as before) ───────────────────────────────
    base = _scope_tenders(db.query(Tender).filter(Tender.is_deleted == False), db, cu)
    if assigned_to:
        base = base.filter(Tender.assigned_to == assigned_to)
    if status:
        base = base.filter(Tender.tender_status == status)
    if result:
        base = base.filter(Tender.result == result)
    if customer_id:
        base = base.filter(Tender.customer_id == customer_id)
    if d_from:
        base = base.filter(Tender.created_at >= d_from)
    if d_to:
        base = base.filter(Tender.created_at <= d_to)

    # ── Summary counts ────────────────────────────────────────────────────────
    total     = base.count()
    active    = base.filter(Tender.tender_status.notin_(['Closed'])).count()
    submitted = base.filter(Tender.tender_status == 'Submitted').count()
    won       = base.filter(Tender.result == 'Won').count()
    lost      = base.filter(Tender.result == 'Lost').count()
    pending   = base.filter(Tender.result == 'Pending').count()
    cancelled = base.filter(Tender.result == 'Cancelled').count()

    won_val      = base.filter(Tender.result == 'Won').with_entities(func.sum(Tender.bid_amount)).scalar() or 0
    pipeline_val = base.filter(Tender.result == 'Pending', Tender.tender_status.notin_(['Closed'])).with_entities(func.sum(Tender.est_value)).scalar() or 0
    pending_val  = pipeline_val  # alias for clarity

    # Average bid value (over all tenders with a bid_amount)
    avg_bid = base.filter(Tender.bid_amount.isnot(None)).with_entities(func.avg(Tender.bid_amount)).scalar() or 0

    # Upcoming / urgent / overdue bids
    upcoming = base.filter(
        Tender.submission_date >= today,
        Tender.submission_date <= today + timedelta(days=7),
        Tender.tender_status.notin_(['Closed']),
    ).count()

    urgent = base.filter(
        Tender.submission_date >= today,
        Tender.submission_date <= today + timedelta(days=3),
        Tender.tender_status.notin_(['Closed']),
    ).count()

    overdue_bids = base.filter(
        Tender.submission_date < today,
        Tender.result == 'Pending',
        Tender.tender_status.notin_(['Closed']),
    ).count()

    # EMD stats
    emd_required_count = base.filter(Tender.emd_required == True).count()
    emd_total_value = (
        base.filter(Tender.emd_required == True, Tender.emd_amount.isnot(None))
        .with_entities(func.sum(Tender.emd_amount))
        .scalar() or 0
    )

    # ── Previous period comparison (same date range, shifted back by same span) ─
    def _prev_value(col_filter, agg_col=None):
        """Run same query on the shifted-back period."""
        try:
            if d_from and d_to:
                span = (d_to - d_from).days + 1
                from datetime import timedelta as _td
                prev_from = d_from - _td(days=span)
                prev_to   = d_from - _td(days=1)
                q = _scope_tenders(db.query(Tender).filter(Tender.is_deleted == False), db, cu)
                q = col_filter(q).filter(Tender.created_at >= prev_from, Tender.created_at <= prev_to)
                if agg_col:
                    return float(q.with_entities(func.sum(agg_col)).scalar() or 0)
                return q.count()
            return 0
        except Exception:
            return 0

    prev_total    = _prev_value(lambda q: q)
    prev_won      = _prev_value(lambda q: q.filter(Tender.result == 'Won'))
    prev_won_val  = _prev_value(lambda q: q.filter(Tender.result == 'Won'), Tender.bid_amount)
    prev_pipeline = _prev_value(
        lambda q: q.filter(Tender.result == 'Pending', Tender.tender_status.notin_(['Closed'])),
        Tender.est_value,
    )

    # ── Chart: by result (with value) ────────────────────────────────────────
    by_result_rows = (
        base.with_entities(Tender.result, func.count(Tender.id), func.sum(Tender.bid_amount))
        .group_by(Tender.result)
        .all()
    )
    by_result = [
        {"name": r or "Pending", "count": int(c or 0), "value": float(v or 0)}
        for r, c, v in by_result_rows
    ]

    # ── Chart: by status (pipeline stages) with conversion & drop-off ────────
    STAGE_ORDER = ['Aligned', 'Evaluation', 'Pre-Bid', 'Submitted', 'Reverse Auction', 'Closed']
    stage_rows = (
        base.with_entities(Tender.tender_status, func.count(Tender.id), func.sum(Tender.est_value))
        .group_by(Tender.tender_status)
        .all()
    )
    stage_map = {s: {"count": int(c or 0), "value": float(v or 0)} for s, c, v in stage_rows if s}

    pipeline_stages = []
    prev_count = None
    for stage in STAGE_ORDER:
        if stage not in stage_map:
            continue
        cnt   = stage_map[stage]["count"]
        val   = stage_map[stage]["value"]
        conv  = round((cnt / prev_count) * 100) if prev_count and prev_count > 0 else 100
        drop  = max(0, 100 - conv) if prev_count else 0
        pipeline_stages.append({
            "stage":      stage,
            "count":      cnt,
            "value":      val,
            "conversion": conv,
            "drop_off":   drop,
        })
        prev_count = cnt

    # ── Lead source name lookup (used by by_portal chart + calendar + table rows) ──
    _src_ids = [r[0] for r in base.with_entities(Tender.source_id).filter(Tender.source_id.isnot(None)).distinct().all()]
    _source_map: dict = {}
    if _src_ids:
        for ls in db.query(LeadSource).filter(LeadSource.id.in_(_src_ids)).all():
            _source_map[ls.id] = ls.name

    # ── Chart: by portal with value ───────────────────────────────────────────
    by_portal_rows = (
        base.with_entities(Tender.source_id, Tender.source_portal, func.count(Tender.id), func.sum(Tender.est_value))
        .group_by(Tender.source_id, Tender.source_portal)
        .all()
    )
    _portal_acc: dict = {}
    for _src_id, _src_portal, _cnt, _val in by_portal_rows:
        _name = _source_map.get(_src_id) or _src_portal or "Other"
        if _name not in _portal_acc:
            _portal_acc[_name] = {"count": 0, "est_value": 0.0}
        _portal_acc[_name]["count"] += int(_cnt or 0)
        _portal_acc[_name]["est_value"] += float(_val or 0)
    by_portal = [
        {"name": n, "value": v["count"], "est_value": v["est_value"]}
        for n, v in sorted(_portal_acc.items(), key=lambda x: -x[1]["count"])
    ]

    # ── Chart: monthly trend ──────────────────────────────────────────────────
    monthly = []
    for m_start, m_end, label in _month_buckets(today):
        cnt = base.filter(Tender.created_at >= m_start, Tender.created_at <= m_end).count()
        w_val = (
            base.filter(Tender.result == 'Won', Tender.created_at >= m_start, Tender.created_at <= m_end)
            .with_entities(func.sum(Tender.bid_amount)).scalar() or 0
        )
        s_val = (
            base.filter(Tender.tender_status == 'Submitted', Tender.created_at >= m_start, Tender.created_at <= m_end)
            .with_entities(func.sum(Tender.est_value)).scalar() or 0
        )
        monthly.append({"month": label, "count": cnt, "won_value": float(w_val), "submitted_value": float(s_val)})

    # ── Chart: by tech bid ────────────────────────────────────────────────────
    by_tech_rows = (
        base.with_entities(Tender.tech_bid_eligible, func.count(Tender.id))
        .filter(Tender.tech_bid_eligible.isnot(None))
        .group_by(Tender.tech_bid_eligible)
        .all()
    )
    by_tech = [{"name": t or "Not Evaluated", "value": int(c or 0)} for t, c in by_tech_rows]

    # ── Upcoming bid calendar ─────────────────────────────────────────────────
    upcoming_rows = (
        base.filter(
            Tender.submission_date >= today,
            Tender.submission_date <= today + timedelta(days=30),
            Tender.tender_status.notin_(['Closed']),
        )
        .order_by(Tender.submission_date)
        .limit(30)
        .all()
    )
    calendar_list = []
    for t_row in upcoming_rows:
        days_left = (t_row.submission_date - today).days if t_row.submission_date else 999
        priority = "urgent" if days_left <= 3 else "upcoming" if days_left <= 7 else "normal"
        calendar_list.append({
            "id":              t_row.id,
            "tender_num":      t_row.tender_num or "",
            "title":           t_row.tender_title or "",
            "customer":        t_row.customer_name or "",
            "submission_date": t_row.submission_date.isoformat() if t_row.submission_date else None,
            "days_left":       days_left,
            "est_value":       float(t_row.est_value or 0),
            "portal":          _source_map.get(t_row.source_id) or t_row.source_portal or "",
            "status":          t_row.tender_status or "",
            "priority":        priority,
        })

    # ── Smart alerts ──────────────────────────────────────────────────────────
    alerts = []

    # Overdue submissions
    overdue_rows = (
        base.filter(
            Tender.submission_date < today,
            Tender.result == 'Pending',
            Tender.tender_status.notin_(['Closed']),
        )
        .order_by(Tender.submission_date)
        .limit(5)
        .all()
    )
    for t_row in overdue_rows:
        days_ago = (today - t_row.submission_date).days if t_row.submission_date else 0
        alerts.append({
            "type":      "overdue",
            "severity":  "high",
            "message":   f"Submission overdue by {days_ago}d: {t_row.tender_title or t_row.tender_num} — {t_row.customer_name}",
            "tender_id": t_row.id,
        })

    # Urgent bids due today or in ≤ 3 days
    urgent_rows = (
        base.filter(
            Tender.submission_date >= today,
            Tender.submission_date <= today + timedelta(days=3),
            Tender.tender_status.notin_(['Closed']),
        )
        .order_by(Tender.submission_date)
        .limit(5)
        .all()
    )
    for t_row in urgent_rows:
        days_left = (t_row.submission_date - today).days if t_row.submission_date else 0
        msg = f"Bid due TODAY: {t_row.tender_title or t_row.tender_num} — {t_row.customer_name}" if days_left == 0 \
              else f"Bid due in {days_left}d: {t_row.tender_title or t_row.tender_num} — {t_row.customer_name}"
        alerts.append({
            "type":      "submission_due" if days_left == 0 else "urgent",
            "severity":  "high",
            "message":   msg,
            "tender_id": t_row.id,
        })

    # EMD required but no EMDBG linked
    try:
        emd_pending_rows = (
            base.filter(
                Tender.emd_required == True,
                Tender.emd_emdbg_id.is_(None),
                Tender.tender_status.notin_(['Closed']),
            )
            .limit(5)
            .all()
        )
        for t_row in emd_pending_rows:
            alerts.append({
                "type":      "emd_pending",
                "severity":  "medium",
                "message":   f"EMD required but not linked: {t_row.tender_title or t_row.tender_num}",
                "tender_id": t_row.id,
            })
    except Exception:
        pass

    # Won without PO number
    try:
        won_no_po_rows = (
            base.filter(Tender.result == 'Won', Tender.po_num.is_(None))
            .limit(5).all()
        )
        for t_row in won_no_po_rows:
            alerts.append({
                "type":      "won_without_po",
                "severity":  "medium",
                "message":   f"Won tender missing PO: {t_row.tender_title or t_row.tender_num} — {t_row.customer_name}",
                "tender_id": t_row.id,
            })
    except Exception:
        pass

    # Lost without loss analysis
    try:
        lost_no_analysis_ids = {
            r.tender_id for r in db.query(TenderLossAnalysis.tender_id).all()
        }
        lost_rows = base.filter(Tender.result == 'Lost').limit(30).all()
        for t_row in lost_rows:
            if t_row.id not in lost_no_analysis_ids:
                alerts.append({
                    "type":      "no_loss_analysis",
                    "severity":  "low",
                    "message":   f"Lost without analysis: {t_row.tender_title or t_row.tender_num}",
                    "tender_id": t_row.id,
                })
            if sum(1 for a in alerts if a["type"] == "no_loss_analysis") >= 3:
                break
    except Exception:
        pass

    # ── Top lists ─────────────────────────────────────────────────────────────
    top_bid_rows = (
        base.filter(Tender.bid_amount.isnot(None))
        .order_by(Tender.bid_amount.desc())
        .limit(10).all()
    )
    top_est_rows = (
        base.filter(Tender.est_value.isnot(None))
        .order_by(Tender.est_value.desc())
        .limit(10).all()
    )

    # Top customers by estimated value
    top_customers = []
    try:
        cust_data = (
            base
            .with_entities(
                Tender.customer_name,
                func.count(Tender.id),
                func.sum(Tender.est_value),
                func.sum(Tender.bid_amount),
            )
            .filter(Tender.customer_name.isnot(None))
            .group_by(Tender.customer_name)
            .order_by(func.sum(Tender.est_value).desc())
            .limit(10)
            .all()
        )
        won_by_customer = dict(
            base.filter(Tender.result == 'Won')
            .with_entities(Tender.customer_name, func.count(Tender.id))
            .group_by(Tender.customer_name)
            .all()
        )
        for name, cnt, est, bid in cust_data:
            top_customers.append({
                "name":      name or "—",
                "total":     int(cnt or 0),
                "won":       int(won_by_customer.get(name, 0)),
                "est_value": float(est or 0),
                "bid_value": float(bid or 0),
            })
    except Exception:
        top_customers = []

    # Top users by won count + won value
    top_users = []
    try:
        assignees_q = db.query(User).filter(User.is_active == True).all()
        user_map = {u.id: (u.full_name or u.username) for u in assignees_q}

        user_data = (
            base
            .with_entities(Tender.assigned_to, func.count(Tender.id), func.sum(Tender.est_value))
            .filter(Tender.assigned_to.isnot(None))
            .group_by(Tender.assigned_to)
            .order_by(func.count(Tender.id).desc())
            .limit(15)
            .all()
        )
        won_by_user = dict(
            base.filter(Tender.result == 'Won')
            .with_entities(Tender.assigned_to, func.count(Tender.id))
            .group_by(Tender.assigned_to)
            .all()
        )
        won_val_by_user = dict(
            base.filter(Tender.result == 'Won')
            .with_entities(Tender.assigned_to, func.sum(Tender.bid_amount))
            .group_by(Tender.assigned_to)
            .all()
        )
        for uid, cnt, _est in user_data:
            top_users.append({
                "name":      user_map.get(uid, f"User {uid}"),
                "total":     int(cnt or 0),
                "won":       int(won_by_user.get(uid, 0)),
                "won_value": float(won_val_by_user.get(uid, 0) or 0),
            })
        top_users.sort(key=lambda x: x["won"], reverse=True)
    except Exception:
        top_users = []

    # ── Full table rows ───────────────────────────────────────────────────────
    assignees_q = db.query(User).filter(User.is_active == True).all()
    user_name_map = {u.id: (u.full_name or u.username) for u in assignees_q}
    table_rows_raw = base.order_by(Tender.created_at.desc()).limit(200).all()

    table = []
    for t_row in table_rows_raw:
        days_left = (t_row.submission_date - today).days if t_row.submission_date else None
        table.append({
            "id":              t_row.id,
            "num":             t_row.tender_num,
            "title":           t_row.tender_title,
            "customer":        t_row.customer_name,
            "status":          t_row.tender_status,
            "result":          t_row.result,
            "portal":          _source_map.get(t_row.source_id) or t_row.source_portal or "",
            "est_value":       float(t_row.est_value or 0),
            "bid_amount":      float(t_row.bid_amount or 0),
            "submission_date": t_row.submission_date.isoformat() if t_row.submission_date else None,
            "days_left":       days_left,
            "tech_bid":        t_row.tech_bid_eligible,
            "emd_required":    bool(t_row.emd_required),
            "emd_amount":      float(t_row.emd_amount or 0),
            "reverse_auction": bool(t_row.reverse_auction),
            "po_num":          getattr(t_row, "po_num", None),
            "assigned_to":     user_name_map.get(t_row.assigned_to, None),
            "created_at":      t_row.created_at.date().isoformat() if t_row.created_at else None,
        })

    scoped_customers = _scope_customers(
        db.query(Customer),
        db,
        cu
    ).order_by(Customer.customer_name.asc()).all()

    customer_options = [
        {
            "id": c.id,
            "name": c.customer_name,
            "label": c.customer_name,
        }
        for c in scoped_customers
    ]

    # ── Filters metadata ──────────────────────────────────────────────────────
    return {
        "summary": {
            "total":               total,
            "active":              active,
            "submitted":           submitted,
            "won":                 won,
            "lost":                lost,
            "pending":             pending,
            "cancelled":           cancelled,
            "won_value":           float(won_val),
            "pipeline_value":      float(pipeline_val),
            "pending_value":       float(pending_val),
            "average_bid_value":   float(avg_bid),
            "emd_required_count":  emd_required_count,
            "emd_total_value":     float(emd_total_value),
            "upcoming_bids":       upcoming,
            "urgent_bids":         urgent,
            "overdue_bids":        overdue_bids,
            # Previous period
            "prev_total":          prev_total,
            "prev_won":            prev_won,
            "prev_won_value":      float(prev_won_val),
            "prev_pipeline":       float(prev_pipeline),
        },
        "charts": {
            "pipeline_stages": pipeline_stages,
            "by_result":       by_result,
            "by_portal":       by_portal,
            "by_tech":         by_tech,
            "monthly_trend":   monthly,
        },
        "calendar": calendar_list,
        "alerts":   alerts[:10],
        "top_lists": {
            "highest_bid":       [{"id": t.id, "num": t.tender_num, "title": t.tender_title,
                                   "customer": t.customer_name, "bid": float(t.bid_amount or 0),
                                   "value": float(t.bid_amount or 0), "result": t.result}
                                  for t in top_bid_rows],
            "highest_estimated": [{"id": t.id, "num": t.tender_num, "title": t.tender_title,
                                   "customer": t.customer_name, "value": float(t.est_value or 0),
                                   "result": t.result}
                                  for t in top_est_rows],
            "top_customers": top_customers,
            "top_users":     top_users,
            # backward compat aliases
            "by_bid": [{"id": t.id, "num": t.tender_num, "title": t.tender_title,
                        "customer": t.customer_name, "bid": float(t.bid_amount or 0),
                        "result": t.result} for t in top_bid_rows],
        },
        "table": table,
        "filters": {
            "statuses": ["Aligned", "Evaluation", "Pre-Bid", "Submitted", "Reverse Auction", "Closed"],
            "results":  ["Pending", "Won", "Lost", "Cancelled"],
            "portals":  ["IREPS", "GeM", "CPP", "CPPP", "NIC", "Direct", "Other"],

            # hierarchy / role / group scoped members
            "owners": _owners_list(db, cu),

            # hierarchy / role / group scoped customers
            "customers": customer_options,
        },
    }

# ─── Travel Tab ────────────────────────────────────────────────────────────────

def _tab_travel(db, cu, d_from, d_to, assigned_to, status, result, state, country, customer_id, today):
    base = db.query(TravelRequest)

    scope_user_ids = _scope_user_ids(db, cu)

    if scope_user_ids is not None:
        base = base.filter(TravelRequest.employee_id.in_(scope_user_ids))
    if assigned_to:
        base = base.filter(TravelRequest.employee_id == assigned_to)
    if status:
        base = base.filter(TravelRequest.status == status)
    if customer_id:
        base = base.filter(TravelRequest.customer_id == customer_id)
    if d_from:
        base = base.filter(TravelRequest.travel_date >= d_from)
    if d_to:
        base = base.filter(TravelRequest.travel_date <= d_to)

    total     = base.count()
    approved  = base.filter(TravelRequest.status == 'Approved').count()
    pending   = base.filter(TravelRequest.status == 'Submitted').count()
    rejected  = base.filter(TravelRequest.status == 'Rejected').count()
    completed = base.filter(TravelRequest.status == 'Completed').count()
    advance   = base.filter(TravelRequest.advance_required == True).with_entities(func.sum(TravelRequest.advance_amount)).scalar() or 0

    by_status_rows    = base.with_entities(TravelRequest.status, func.count(TravelRequest.id)).group_by(TravelRequest.status).all()
    by_mode_rows      = base.with_entities(TravelRequest.mode_of_travel, func.count(TravelRequest.id)).filter(TravelRequest.mode_of_travel.isnot(None)).group_by(TravelRequest.mode_of_travel).order_by(func.count(TravelRequest.id).desc()).all()
    by_visit_rows     = base.with_entities(TravelRequest.visit_type, func.count(TravelRequest.id)).filter(TravelRequest.visit_type.isnot(None)).group_by(TravelRequest.visit_type).order_by(func.count(TravelRequest.id).desc()).all()
    by_from_city_rows = base.with_entities(TravelRequest.from_city, func.count(TravelRequest.id)).filter(TravelRequest.from_city.isnot(None)).group_by(TravelRequest.from_city).order_by(func.count(TravelRequest.id).desc()).limit(10).all()

    monthly = []
    for m_start, m_end, label in _month_buckets(today):
        cnt = base.filter(TravelRequest.travel_date >= m_start, TravelRequest.travel_date <= m_end).count()
        monthly.append({"month": label, "value": cnt})

    table_rows  = base.order_by(TravelRequest.travel_date.desc()).limit(100).all()
    employee_map = {u.id: (u.full_name or u.username) for u in db.query(User).filter(User.is_active == True).all()}

    return {
        "summary": {"total": total, "approved": approved, "pending": pending, "rejected": rejected, "completed": completed, "advance_total": float(advance)},
        "charts": {
            "by_status":    [{"name": s or "Draft", "value": c} for s, c in by_status_rows],
            "by_mode":      [{"name": m or "Other", "value": c} for m, c in by_mode_rows],
            "by_visit_type":[{"name": v or "Other", "value": c} for v, c in by_visit_rows],
            "by_from_city": [{"name": f, "value": c} for f, c in by_from_city_rows if f],
            "monthly_trend": monthly,
        },
        "top_lists": {},
        "table": [
            {"id": r.id, "request_number": r.request_number,
             "employee": employee_map.get(r.employee_id, str(r.employee_id)),
             "purpose": r.purpose, "visit_type": r.visit_type,
             "from_city": r.from_city, "to_city": r.to_city,
             "travel_date": r.travel_date.isoformat() if r.travel_date else None,
             "return_date": r.return_date.isoformat() if r.return_date else None,
             "mode": r.mode_of_travel, "status": r.status,
             "advance_required": r.advance_required,
             "advance_amount": float(r.advance_amount or 0)}
            for r in table_rows
        ],
        "filters": {
            "statuses":    ["Draft", "Submitted", "Approved", "Rejected", "Completed", "Cancelled"],
            "visit_types": ["Customer Visit", "Site Visit", "Meeting", "Training", "Conference", "Other"],
            "owners": _owners_list(db, cu),
        }
    }


# ─── EMD / BG Tab ──────────────────────────────────────────────────────────────

def _tab_emdbg(db, cu, d_from, d_to, assigned_to, status, result, state, country, customer_id, today):
    base = _scope_emdbg(db.query(EMDBG), db, cu)

    if assigned_to:
        base = base.outerjoin(Tender, EMDBG.tender_id == Tender.id).filter(
            Tender.assigned_to == assigned_to
        )
    if status:
        base = base.filter(EMDBG.status == status)
    if customer_id:
        base = base.filter(EMDBG.customer_id == customer_id)
    if d_from:
        base = base.filter(EMDBG.issued_date >= d_from)
    if d_to:
        base = base.filter(EMDBG.issued_date <= d_to)

    count_base = _scope_emdbg(db.query(EMDBG), db, cu)

    total        = count_base.count()
    active       = count_base.filter(EMDBG.status == 'Active').count()
    expired      = count_base.filter(EMDBG.status == 'Expired').count()
    released     = count_base.filter(EMDBG.status == 'Released').count()
    expiring_7   = count_base.filter(EMDBG.status == 'Active', EMDBG.expiry_date <= today + timedelta(days=7)).count()
    expiring_30  = count_base.filter(EMDBG.status == 'Active', EMDBG.expiry_date <= today + timedelta(days=30)).count()
    total_value  = count_base.filter(EMDBG.status == 'Active').with_entities(func.sum(EMDBG.amount)).scalar() or 0
    finance_unpaid = count_base.filter(EMDBG.finance_status == 'unpaid').count()

    by_type_rows   = count_base.with_entities(EMDBG.instrument_type, func.count(EMDBG.id)).group_by(EMDBG.instrument_type).all()
    by_status_rows = count_base.with_entities(EMDBG.status, func.count(EMDBG.id)).group_by(EMDBG.status).all()
    by_bank_rows = count_base.with_entities(EMDBG.bank_name, func.count(EMDBG.id))

    # Expiry buckets
    expiry_buckets = [
        {"name": "Expired",       "value": expired},
        {"name": "Within 7 days", "value": expiring_7},
        {"name": "8–30 days",     "value": max(0, expiring_30 - expiring_7)},
        {"name": "31–90 days",    "value": count_base.filter(EMDBG.status == 'Active', EMDBG.expiry_date > today + timedelta(days=30), EMDBG.expiry_date <= today + timedelta(days=90)).count()},
        {"name": "90+ days",      "value": count_base.filter(EMDBG.status == 'Active', EMDBG.expiry_date > today + timedelta(days=90)).count()},
    ]

    # Critical expiring soon
    critical = (
        count_base.filter(EMDBG.status == 'Active', EMDBG.expiry_date <= today + timedelta(days=30))
        .order_by(EMDBG.expiry_date).limit(10).all()
    )

    table_rows = base.order_by(EMDBG.expiry_date).limit(100).all()
    scoped_customers = _scope_customers(
        db.query(Customer),
        db,
        cu
    ).order_by(Customer.customer_name.asc()).all()

    customer_options = [
        {
            "id": c.id,
            "name": c.customer_name,
            "label": c.customer_name,
        }
        for c in scoped_customers
    ]

    return {
        "summary": {"total": total, "active": active, "expired": expired, "released": released,
                    "expiring_7": expiring_7, "expiring_30": expiring_30,
                    "total_value": float(total_value), "finance_unpaid": finance_unpaid},
        "charts": {
            "by_type":       [{"name": t or "Unknown", "value": c} for t, c in by_type_rows],
            "by_status":     [{"name": s or "Active",  "value": c} for s, c in by_status_rows],
            "by_bank":       [{"name": b, "value": c} for b, c in by_bank_rows if b],
            "expiry_buckets": expiry_buckets,
        },
        "top_lists": {
            "critical": [{"id": e.id, "ref": e.reference_num, "client": e.client_name,
                          "type": e.instrument_type, "amount": float(e.amount or 0),
                          "expiry": e.expiry_date.isoformat() if e.expiry_date else None,
                          "days_left": (e.expiry_date - today).days if e.expiry_date else None}
                         for e in critical],
        },
        "table": [
            {
                "id": e.id,
                "ref": e.reference_num,
                "client": e.client_name,
                "tender_num": e.tender_num,
                "type": e.instrument_type,
                "amount": float(e.amount or 0),

                "bank": (
                    getattr(e, "issuing_bank_name", None)
                    or getattr(e, "issuing_bank", None)
                    or getattr(e, "bank_name", None)
                    or getattr(e, "bank", None)
                    or "—"
                ),

                "issued_date": e.issued_date.isoformat() if e.issued_date else None,
                "expiry_date": e.expiry_date.isoformat() if e.expiry_date else None,
                "days_left": (e.expiry_date - today).days if e.expiry_date else None,
                "status": e.status,
                "finance_status": e.finance_status,
                "return_status": e.return_status,
            }
            for e in table_rows
        ],
        "filters": {
            "statuses": ["Active", "Expired", "Released", "Encashed", "Renewed", "Cancelled"],
            "types": ["EMD", "Performance BG", "Security Deposit", "Advance BG", "Retention BG", "DD", "Online Payment"],

            # hierarchy / role / group scoped members
            "owners": _owners_list(db, cu),

            # hierarchy / role / group scoped customers
            "customers": customer_options,
        }
    }


def _count_customers_page_match(user: User, db: Session) -> int:
    """Count customers for a user exactly as the Customer list page does."""
    return _scope_customers(db.query(Customer), db, user).count()


# ─── KAM 360 Tab ───────────────────────────────────────────────────────────────

def _tab_kam360(db, cu, d_from, d_to, assigned_to, status, result, state, country, customer_id, today):
    """Per-KAM aggregated performance metrics for the KAM 360 dashboard tab."""

    # Determine which KAMs are visible to the current user
    # Admin/CEO are excluded from the KAM list — they should not appear in leaderboards
    scope_user_ids = _scope_user_ids(db, cu)
    _non_kam_roles = ('admin', 'ceo', 'super_admin')

    if scope_user_ids is None:
        kams = db.query(User).filter(
            User.is_active == True,
            User.role.notin_(_non_kam_roles),
        ).all()
    else:
        kams = db.query(User).filter(
            User.id.in_(scope_user_ids),
            User.is_active == True,
        ).all()

    if assigned_to:
        kams = [k for k in kams if int(k.id) == int(assigned_to)]


    kam_ids = [k.id for k in kams]

    if not kam_ids:
        return {
            "summary": {
                "total_kams": 0,
                "total_leads": 0,
                "converted_leads": 0,
                "overdue_leads": 0,
                "total_tenders": 0,
                "won_tenders": 0,
                "pipeline_value": 0,
                "won_value": 0,
                "active_emdbg": 0,
                "total_customers": 0,
                "active_customers": 0,
                "total_travel": 0,
                "total_sales_target": 0,
                "total_won_value": 0,
                "total_customers_with_win": 0,
            },
            "kams": [],
            "groups": [],
            "charts": {
                "top_by_leads": [],
                "top_by_tenders": [],
                "top_by_score": [],
                "leads_by_region": [],
            },
            "filters": {
                "owners": _owners_list(db, cu),
                "customers": [],
                "groups": [],
            },
        }

    # Build group name lookup from Group master table
    _group_lookup = {str(g.id): g.name for g in db.query(Group).all()}

    def _resolve_group(group_id_str) -> str:
        if not group_id_str:
            return ""
        # group_id may be comma-separated; use first entry for display
        first = str(group_id_str).split(",")[0].strip()
        return _group_lookup.get(first, str(group_id_str))

    # Base queries scoped to visible KAMs
    leads_base   = db.query(Lead).filter(Lead.is_deleted == False,   Lead.assigned_to.in_(kam_ids))
    tenders_base = db.query(Tender).filter(Tender.is_deleted == False, Tender.assigned_to.in_(kam_ids))
    travel_base  = db.query(TravelRequest).filter(TravelRequest.employee_id.in_(kam_ids))
    emdbg_base   = (
        db.query(EMDBG)
        .join(Tender, EMDBG.tender_id == Tender.id)
        .filter(Tender.is_deleted == False, Tender.assigned_to.in_(kam_ids))
    )
    customer_base = db.query(Customer).filter(Customer.is_deleted == False, Customer.assigned_to.in_(kam_ids))

    # Date filters (applied to leads / tenders if provided)
    if d_from:
        leads_base   = leads_base.filter(Lead.created_at >= d_from)
        tenders_base = tenders_base.filter(Tender.created_at >= d_from)
    if d_to:
        leads_base   = leads_base.filter(Lead.created_at <= d_to)
        tenders_base = tenders_base.filter(Tender.created_at <= d_to)

    # ── Summary totals ────────────────────────────────────────────────────────
    summary = {
        "total_kams":         len(kams),
        "total_leads":        leads_base.count(),
        "converted_leads":    leads_base.filter(Lead.status == 'Converted').count(),
        "overdue_leads":      leads_base.filter(Lead.follow_up < today, Lead.status.notin_(['Converted', 'Lost'])).count(),
        "total_tenders":      tenders_base.count(),
        "won_tenders":        tenders_base.filter(Tender.result == 'Won').count(),
        "pipeline_value":     float(tenders_base.with_entities(func.sum(Tender.bid_amount)).scalar() or 0),
        "won_value":          float(tenders_base.filter(Tender.result == 'Won').with_entities(func.sum(Tender.bid_amount)).scalar() or 0),
        "active_emdbg":       emdbg_base.filter(EMDBG.status == 'Active').count(),
        "total_customers":    _count_customers_page_match(cu, db),
        "active_customers":   _count_customers_page_match(cu, db),
        "total_travel":       travel_base.count(),
    }

    # ── Per-KAM rows ─────────────────────────────────────────────────────────
    def _kam_row(k: User) -> dict:
        l_base = db.query(Lead).filter(Lead.is_deleted == False, Lead.assigned_to == k.id)
        t_base = db.query(Tender).filter(Tender.is_deleted == False, Tender.assigned_to == k.id)
        if d_from:
            l_base = l_base.filter(Lead.created_at >= d_from)
            t_base = t_base.filter(Tender.created_at >= d_from)
        if d_to:
            l_base = l_base.filter(Lead.created_at <= d_to)
            t_base = t_base.filter(Tender.created_at <= d_to)

        leads_total     = l_base.count()
        leads_converted = l_base.filter(Lead.status == 'Converted').count()
        leads_lost      = l_base.filter(Lead.status == 'Lost').count()
        leads_overdue   = l_base.filter(Lead.follow_up < today, Lead.status.notin_(['Converted', 'Lost'])).count()
        leads_pipeline  = float(l_base.filter(Lead.status.notin_(['Converted', 'Lost'])).with_entities(func.sum(Lead.est_value)).scalar() or 0)

        tenders_total   = t_base.count()
        tenders_won     = t_base.filter(Tender.result == 'Won').count()
        tenders_bid_val = float(t_base.with_entities(func.sum(Tender.bid_amount)).scalar() or 0)

        emdbg_active = (
            db.query(EMDBG)
            .join(Tender, EMDBG.tender_id == Tender.id)
            .filter(Tender.is_deleted == False, Tender.assigned_to == k.id, EMDBG.status == 'Active')
            .count()
        )

        travel_total = db.query(TravelRequest).filter(TravelRequest.employee_id == k.id).count()

        cust_total = _count_customers_page_match(k, db)

        # Simple score: conversion rate + win rate weighted by volume
        conv_rate = (leads_converted / leads_total * 100) if leads_total else 0
        win_rate  = (tenders_won / tenders_total * 100)   if tenders_total else 0
        score     = round((conv_rate * 0.4 + win_rate * 0.6), 1)

        # Sales target — cascade: period → year → latest period that year → user.target
        _period = d_from.strftime('%Y-%m') if d_from else today.strftime('%Y-%m')
        _cy = _period[:4]
        _tgt = db.query(KAMTarget).filter(KAMTarget.user_id == k.id, KAMTarget.period == _period).first()
        if not _tgt:
            _tgt = db.query(KAMTarget).filter(KAMTarget.user_id == k.id, KAMTarget.period == _cy).first()
        if not _tgt:
            _tgt = db.query(KAMTarget).filter(
                KAMTarget.user_id == k.id, KAMTarget.period.like(f"{_cy}-%")
            ).order_by(KAMTarget.period.desc()).first()
        sales_target = float(getattr(_tgt, 'sales_target', 0) or 0) if _tgt else float(getattr(k, 'target', None) or 0)

        won_tender_value = float(
            t_base.filter(Tender.result == 'Won').with_entities(func.sum(Tender.bid_amount)).scalar() or 0
        )

        customers_with_win = int(
            db.query(func.count(func.distinct(Tender.customer_id)))
            .filter(
                Tender.is_deleted == False, Tender.assigned_to == k.id,
                Tender.result == 'Won', Tender.customer_id.isnot(None),
            ).scalar() or 0
        )
        customers_pending = int(
            db.query(func.count(func.distinct(Tender.customer_id)))
            .filter(
                Tender.is_deleted == False, Tender.assigned_to == k.id,
                Tender.result != 'Won', Tender.customer_id.isnot(None),
            ).scalar() or 0
        )

        return {
            "id":                 k.id,
            "name":               k.full_name or k.username,
            "group":              _resolve_group(k.group_id),
            "region":             k.region or "",
            "role":               k.role,
            "customers_total":    cust_total,
            "customers_active":   cust_total,
            "leads_total":        leads_total,
            "leads_converted":    leads_converted,
            "leads_lost":         leads_lost,
            "leads_overdue":      leads_overdue,
            "leads_pipeline":     leads_pipeline,
            "tenders_total":      tenders_total,
            "tenders_won":        tenders_won,
            "tenders_bid_value":  tenders_bid_val,
            "travel_total":       travel_total,
            "emdbg_active":       emdbg_active,
            "score":              score,
            "sales_target":       sales_target,
            "won_tender_value":   won_tender_value,
            "customers_with_win": customers_with_win,
            "customers_pending":  customers_pending,
        }

    kam_rows = [_kam_row(k) for k in kams]

    # Aggregate new target/won fields into summary
    summary["total_sales_target"]       = sum(r.get("sales_target",       0) for r in kam_rows)
    summary["total_won_value"]          = sum(r.get("won_tender_value",   0) for r in kam_rows)
    summary["total_customers_with_win"] = sum(r.get("customers_with_win", 0) for r in kam_rows)

    # ── Group aggregations ────────────────────────────────────────────────────
    group_map: dict[str, dict] = {}
    for row in kam_rows:
        g = row["group"] or "Unassigned"
        if g not in group_map:
            group_map[g] = {
                "name": g, "members": 0,
                "customers_total": 0, "customers_active": 0,
                "leads_total": 0, "leads_converted": 0,
                "tenders_total": 0, "tenders_won": 0, "pipeline": 0.0,
            }
        group_map[g]["members"]           += 1
        group_map[g]["customers_total"]   += row["customers_total"]
        group_map[g]["customers_active"]  += row["customers_active"]
        group_map[g]["leads_total"]       += row["leads_total"]
        group_map[g]["leads_converted"]   += row["leads_converted"]
        group_map[g]["tenders_total"]     += row["tenders_total"]
        group_map[g]["tenders_won"]       += row["tenders_won"]
        group_map[g]["pipeline"]          += row["leads_pipeline"]

    groups = sorted(group_map.values(), key=lambda x: x["pipeline"], reverse=True)

    # ── Charts ────────────────────────────────────────────────────────────────
    top_by_leads   = sorted(kam_rows, key=lambda r: r["leads_total"],    reverse=True)[:10]
    top_by_tenders = sorted(kam_rows, key=lambda r: r["tenders_total"],  reverse=True)[:10]
    top_by_score   = sorted(kam_rows, key=lambda r: r["score"],          reverse=True)[:10]

    charts = {
        "top_by_leads":   [{"name": r["name"], "value": r["leads_total"],   "converted": r["leads_converted"]}   for r in top_by_leads],
        "top_by_tenders": [{"name": r["name"], "value": r["tenders_total"], "won": r["tenders_won"]}              for r in top_by_tenders],
        "top_by_score":   [{"name": r["name"], "value": r["score"]}                                               for r in top_by_score],
        "leads_by_region": [
            {"name": reg, "value": cnt}
            for reg, cnt in (
                db.query(Lead.region, func.count(Lead.id))
                .filter(Lead.is_deleted == False, Lead.assigned_to.in_(kam_ids), Lead.region.isnot(None))
                .group_by(Lead.region).order_by(func.count(Lead.id).desc()).limit(10).all()
            ) if reg
        ],
    }

    scoped_customers = _scope_customers(
        db.query(Customer),
        db,
        cu
    ).order_by(Customer.customer_name.asc()).all()

    customer_options = [
        {
            "id": c.id,
            "name": c.customer_name,
            "label": c.customer_name,
        }
        for c in scoped_customers
    ]

    return {
        "summary": summary,
        "kams":    kam_rows,
        "groups":  groups,
        "charts":  charts,
        "filters": {
            "owners": _owners_list(db, cu),
            "customers": customer_options,
            "groups": [g["name"] for g in groups if g["name"] and g["name"] != "Unassigned"],
        },
    }

def _tab_kam360(db, cu, d_from, d_to, assigned_to, status, result, state, country, customer_id, today, group=None):
    """Dashboard KAM 360 aggregates aligned with module ownership rules."""

    if d_from and d_to and d_from > d_to:
        d_from, d_to = d_to, d_from

    start_dt = datetime.combine(d_from, datetime.min.time()) if d_from else None
    end_dt = datetime.combine(d_to, datetime.max.time()) if d_to else None

    customer_statuses = {"Active", "Inactive", "Prospect", "Churned"}
    lead_statuses = {"Assigned", "Contacted", "Qualified", "Proposal Pending", "Nurturing", "Opportunity Created", "Converted", "Lost"}
    tender_statuses = {"Aligned", "Evaluation", "Submitted", "Pre-Bid", "Reverse Auction", "Closed"}
    travel_statuses = {"Draft", "Submitted", "Approved", "Rejected", "Completed", "Cancelled"}
    emdbg_statuses = {"Active", "Expired", "Released", "Encashed", "Renewed", "Cancelled"}

    customer_status = status if status in customer_statuses else None
    lead_status = status if status in lead_statuses else None
    tender_status = status if status in tender_statuses else None
    travel_status = status if status in travel_statuses else None
    emdbg_status = status if status in emdbg_statuses else None

    scope_user_ids = _scope_user_ids(db, cu)
    users_q = db.query(User).filter(User.is_active == True)
    if scope_user_ids is not None:
        users_q = users_q.filter(User.id.in_(scope_user_ids))

    non_kam_roles = {"admin", "ceo", "super_admin"}
    kams = [
        user for user in users_q.order_by(User.full_name.asc()).all()
        if _normalized_role(getattr(user, "role", None)) not in non_kam_roles
    ]
    if assigned_to:
        kams = [user for user in kams if int(user.id) == int(assigned_to)]

    kam_role_by_id = {int(user.id): getattr(user, "role", None) for user in kams}

    from app.routers.kam_router import (
        _group_fixing_payload,
        _customer_signal_maps,
        _is_kam_sales_role,
        _kam_lead_records_query,
        _lead_stats,
        _tender_stats,
    )
    _group_fixing_groups, _group_fixing_by_user = _group_fixing_payload(db)

    group_lookup = {
        str(row.id): row.name
        for row in db.query(Group).all()
    }

    def _legacy_group_names(raw_group_id) -> list[str]:
        names: list[str] = []
        for part in str(raw_group_id or "").split(","):
            key = part.strip()
            if key:
                names.append(group_lookup.get(key, key))
        return [name for name in names if str(name or "").strip()]

    def _group_names(user: User) -> list[str]:
        fixing_info = _group_fixing_by_user.get(int(user.id))
        if fixing_info and fixing_info.get("group_names"):
            return [name for name in fixing_info["group_names"] if str(name or "").strip()]
        return _legacy_group_names(getattr(user, "group_id", None))

    def _display_group(user: User) -> str:
        names = _group_names(user)
        return ", ".join(names) if names else "Unassigned"

    group_options = sorted({
        name
        for user in kams
        for name in (_group_names(user) or ["Unassigned"])
        if name and name != "Unassigned"
    })

    group_filter = str(group or "").strip()
    if group_filter:
        wanted = group_filter.casefold()
        kams = [
            user for user in kams
            if wanted == _display_group(user).casefold()
            or wanted in {name.casefold() for name in _group_names(user)}
            or (wanted == "unassigned" and not _group_names(user))
        ]

    kam_ids = [int(user.id) for user in kams]

    def _empty_payload():
        return {
            "summary": {
                "total_kams": 0,
                "total_leads": 0,
                "converted_leads": 0,
                "overdue_leads": 0,
                "total_tenders": 0,
                "won_tenders": 0,
                "pipeline_value": 0,
                "won_value": 0,
                "active_emdbg": 0,
                "total_customers": 0,
                "active_customers": 0,
                "total_travel": 0,
                "total_sales_target": 0,
                "total_won_value": 0,
                "total_customers_with_win": 0,
            },
            "kams": [],
            "groups": [],
            "charts": {
                "top_by_leads": [],
                "top_by_tenders": [],
                "top_by_score": [],
                "leads_by_region": [],
                "monthly_activity": [],
            },
            "filters": {
                "owners": _owners_list(db, cu),
                "customers": [],
                "groups": group_options,
            },
        }

    if not kam_ids:
        return _empty_payload()

    def _apply_customer_filters(q):
        if customer_id:
            q = q.filter(Customer.id == customer_id)
        if customer_status:
            q = q.filter(Customer.account_status == customer_status)
        if state:
            q = q.filter(or_(Customer.billing_state == state, Customer.shipping_state == state))
        if country:
            q = q.filter(or_(Customer.billing_country == country, Customer.shipping_country == country))
        return q

    customer_filter_active = bool(customer_id or customer_status or state or country)
    filtered_customer_ids: Optional[set[int]] = None
    lead_ids_for_filtered_customers: set[int] = set()
    if customer_filter_active:
        filtered_customer_ids = {
            int(row.id)
            for row in _apply_customer_filters(
                db.query(Customer.id).filter(Customer.is_deleted == False)
            ).all()
            if row.id
        }
        if filtered_customer_ids:
            lead_ids_for_filtered_customers = {
                int(row.id)
                for row in db.query(Lead.id).filter(
                    Lead.is_deleted == False,
                    Lead.customer_id.in_(filtered_customer_ids),
                ).all()
                if row.id
            }

    def _restrict_customer_column(q, column, lead_column=None):
        if filtered_customer_ids is None:
            return q
        if not filtered_customer_ids:
            return q.filter(column.in_([-1]))
        clauses = [column.in_(filtered_customer_ids)]
        if lead_column is not None and lead_ids_for_filtered_customers:
            clauses.append(lead_column.in_(lead_ids_for_filtered_customers))
        return q.filter(or_(*clauses))

    customer_ids_by_user: dict[int, set[int]] = {uid: set() for uid in kam_ids}
    active_customer_ids_by_user: dict[int, set[int]] = {uid: set() for uid in kam_ids}
    potential_by_customer: dict[int, float] = {}

    assignment_q = (
        db.query(
            SalesCustomerAssignment.user_id,
            Customer.id,
            Customer.account_status,
            Customer.potential_value,
        )
        .join(Customer, Customer.id == SalesCustomerAssignment.customer_id)
        .filter(
            SalesCustomerAssignment.user_id.in_(kam_ids),
            SalesCustomerAssignment.is_active == True,
            Customer.is_deleted == False,
        )
    )
    assignment_q = _apply_customer_filters(assignment_q)
    for uid, cid, account_status, potential_value in assignment_q.all():
        if uid and cid:
            uid_i = int(uid)
            cid_i = int(cid)
            customer_ids_by_user.setdefault(uid_i, set()).add(cid_i)
            potential_by_customer[cid_i] = float(potential_value or 0)
            if account_status == "Active":
                active_customer_ids_by_user.setdefault(uid_i, set()).add(cid_i)

    active_assignment_customer_ids = db.query(SalesCustomerAssignment.customer_id).filter(
        SalesCustomerAssignment.is_active == True,
    )
    fallback_q = db.query(
        Customer.assigned_to,
        Customer.id,
        Customer.account_status,
        Customer.potential_value,
    ).filter(
        Customer.is_deleted == False,
        Customer.assigned_to.in_(kam_ids),
        ~Customer.id.in_(active_assignment_customer_ids),
    )
    fallback_q = _apply_customer_filters(fallback_q)
    for uid, cid, account_status, potential_value in fallback_q.all():
        if uid and cid:
            uid_i = int(uid)
            cid_i = int(cid)
            customer_ids_by_user.setdefault(uid_i, set()).add(cid_i)
            potential_by_customer[cid_i] = float(potential_value or 0)
            if account_status == "Active":
                active_customer_ids_by_user.setdefault(uid_i, set()).add(cid_i)

    def _apply_lead_date(q):
        created_expr = func.coalesce(Lead.lead_created_at, Lead.created_at)
        if start_dt:
            q = q.filter(created_expr >= start_dt)
        if end_dt:
            q = q.filter(created_expr <= end_dt)
        return q

    def _tender_date_expr(from_date=None, to_date=None, from_dt=None, to_dt=None):
        from_date = from_date if from_date is not None else d_from
        to_date = to_date if to_date is not None else d_to
        from_dt = from_dt if from_dt is not None else start_dt
        to_dt = to_dt if to_dt is not None else end_dt
        if not (from_date or to_date or from_dt or to_dt):
            return None
        exprs = []
        for column in (Tender.result_date, Tender.submission_date, Tender.published_date):
            checks = [column.isnot(None)]
            if from_date:
                checks.append(column >= from_date)
            if to_date:
                checks.append(column <= to_date)
            exprs.append(and_(*checks))
        created_checks = []
        if from_dt:
            created_checks.append(Tender.created_at >= from_dt)
        if to_dt:
            created_checks.append(Tender.created_at <= to_dt)
        if created_checks:
            exprs.append(and_(*created_checks))
        return or_(*exprs)

    def _apply_tender_date(q):
        expr = _tender_date_expr()
        return q.filter(expr) if expr is not None else q

    def _apply_date_column(q, column):
        if d_from:
            q = q.filter(column >= d_from)
        if d_to:
            q = q.filter(column <= d_to)
        return q

    def _lead_base_query():
        q = db.query(Lead).filter(
            Lead.is_deleted == False,
            Lead.assigned_to.in_(kam_ids),
            or_(Lead.lead_type.is_(None), Lead.lead_type != "direct_opportunity"),
        )
        if lead_status:
            q = q.filter(Lead.status == lead_status)
        q = _restrict_customer_column(q, Lead.customer_id)
        return _apply_lead_date(q)

    def _tender_base_query():
        q = db.query(Tender).filter(
            Tender.is_deleted == False,
            Tender.assigned_to.in_(kam_ids),
        )
        if tender_status:
            q = q.filter(Tender.tender_status == tender_status)
        if result:
            q = q.filter(Tender.result == result)
        q = _restrict_customer_column(q, Tender.customer_id, Tender.lead_id)
        return _apply_tender_date(q)

    lead_stats: dict[int, dict[str, Any]] = {
        uid: {"total": 0, "converted": 0, "lost": 0, "overdue": 0, "pipeline": 0.0}
        for uid in kam_ids
    }
    for uid, cnt in _lead_base_query().with_entities(Lead.assigned_to, func.count(Lead.id)).group_by(Lead.assigned_to).all():
        if uid in lead_stats:
            lead_stats[int(uid)]["total"] = int(cnt or 0)
    for uid, cnt in _lead_base_query().filter(Lead.status == "Converted").with_entities(Lead.assigned_to, func.count(Lead.id)).group_by(Lead.assigned_to).all():
        if uid in lead_stats:
            lead_stats[int(uid)]["converted"] = int(cnt or 0)
    for uid, cnt in _lead_base_query().filter(Lead.status == "Lost").with_entities(Lead.assigned_to, func.count(Lead.id)).group_by(Lead.assigned_to).all():
        if uid in lead_stats:
            lead_stats[int(uid)]["lost"] = int(cnt or 0)
    for uid, cnt in (
        _lead_base_query()
        .filter(Lead.follow_up < today, or_(Lead.status.is_(None), ~Lead.status.in_(["Converted", "Lost"])))
        .with_entities(Lead.assigned_to, func.count(Lead.id))
        .group_by(Lead.assigned_to)
        .all()
    ):
        if uid in lead_stats:
            lead_stats[int(uid)]["overdue"] = int(cnt or 0)
    for uid, sv in (
        _lead_base_query()
        .filter(or_(Lead.status.is_(None), ~Lead.status.in_(["Converted", "Lost"])))
        .with_entities(Lead.assigned_to, func.sum(Lead.est_value))
        .group_by(Lead.assigned_to)
        .all()
    ):
        if uid in lead_stats:
            lead_stats[int(uid)]["pipeline"] = float(sv or 0)

    tender_stats: dict[int, dict[str, Any]] = {
        uid: {"total": 0, "won": 0, "bid_value": 0.0, "won_value": 0.0}
        for uid in kam_ids
    }
    tender_value_expr = func.coalesce(Tender.bid_amount, Tender.est_value, 0)
    for uid, cnt, sv in (
        _tender_base_query()
        .with_entities(Tender.assigned_to, func.count(Tender.id), func.sum(tender_value_expr))
        .group_by(Tender.assigned_to)
        .all()
    ):
        if uid in tender_stats:
            tender_stats[int(uid)]["total"] = int(cnt or 0)
            tender_stats[int(uid)]["bid_value"] = float(sv or 0)
    for uid, cnt, sv in (
        _tender_base_query()
        .filter(Tender.result == "Won")
        .with_entities(Tender.assigned_to, func.count(Tender.id), func.sum(tender_value_expr))
        .group_by(Tender.assigned_to)
        .all()
    ):
        if uid in tender_stats:
            tender_stats[int(uid)]["won"] = int(cnt or 0)
            tender_stats[int(uid)]["won_value"] = float(sv or 0)

    customers_with_win_by_user: dict[int, set[int]] = {uid: set() for uid in kam_ids}
    won_rows = _tender_base_query().filter(Tender.result == "Won").with_entities(
        Tender.assigned_to,
        Tender.customer_id,
        Tender.lead_id,
    ).all()
    won_lead_ids = {int(lead_id) for _, _, lead_id in won_rows if lead_id}
    won_lead_customer_map = {
        int(lead_id): int(cid)
        for lead_id, cid in db.query(Lead.id, Lead.customer_id).filter(Lead.id.in_(won_lead_ids)).all()
        if lead_id and cid
    } if won_lead_ids else {}
    for uid, cid, lead_id in won_rows:
        resolved_customer_id = cid or won_lead_customer_map.get(int(lead_id or 0))
        if uid and resolved_customer_id:
            customers_with_win_by_user.setdefault(int(uid), set()).add(int(resolved_customer_id))

    travel_stats = {uid: 0 for uid in kam_ids}
    travel_q = db.query(TravelRequest).filter(TravelRequest.employee_id.in_(kam_ids))
    if travel_status:
        travel_q = travel_q.filter(TravelRequest.status == travel_status)
    travel_q = _restrict_customer_column(travel_q, TravelRequest.customer_id)
    travel_q = _apply_date_column(travel_q, TravelRequest.travel_date)
    for uid, cnt in travel_q.with_entities(TravelRequest.employee_id, func.count(TravelRequest.id)).group_by(TravelRequest.employee_id).all():
        if uid in travel_stats:
            travel_stats[int(uid)] = int(cnt or 0)

    emdbg_stats = {uid: 0 for uid in kam_ids}
    emdbg_owner = func.coalesce(Tender.assigned_to, EMDBG.created_by)
    emdbg_q = db.query(EMDBG).outerjoin(Tender, EMDBG.tender_id == Tender.id).filter(
        emdbg_owner.in_(kam_ids),
        or_(Tender.id.is_(None), Tender.is_deleted == False),
    )
    if emdbg_status:
        emdbg_q = emdbg_q.filter(EMDBG.status == emdbg_status)
    else:
        emdbg_q = emdbg_q.filter(EMDBG.status == "Active")
    if result:
        emdbg_q = emdbg_q.filter(Tender.result == result)
    if filtered_customer_ids is not None:
        if filtered_customer_ids:
            clauses = [EMDBG.customer_id.in_(filtered_customer_ids), Tender.customer_id.in_(filtered_customer_ids)]
            if lead_ids_for_filtered_customers:
                clauses.append(Tender.lead_id.in_(lead_ids_for_filtered_customers))
            emdbg_q = emdbg_q.filter(or_(*clauses))
        else:
            emdbg_q = emdbg_q.filter(EMDBG.customer_id.in_([-1]))
    emdbg_q = _apply_date_column(emdbg_q, EMDBG.issued_date)
    for uid, cnt in emdbg_q.with_entities(emdbg_owner.label("owner_id"), func.count(EMDBG.id)).group_by(emdbg_owner).all():
        if uid in emdbg_stats:
            emdbg_stats[int(uid)] = int(cnt or 0)

    def _month_periods(start: date, end: date) -> list[str]:
        periods = []
        cursor = date(start.year, start.month, 1)
        last = date(end.year, end.month, 1)
        while cursor <= last:
            periods.append(cursor.strftime("%Y-%m"))
            cursor = date(cursor.year + 1, 1, 1) if cursor.month == 12 else date(cursor.year, cursor.month + 1, 1)
        return periods

    target_start = d_from or date(today.year, today.month, 1)
    target_end = d_to or target_start
    target_periods = _month_periods(target_start, target_end)
    target_years = sorted({str(target_start.year), str(target_end.year), str(today.year)})

    target_by_user = {uid: 0.0 for uid in kam_ids}
    if target_periods:
        for uid, sv in db.query(KAMTarget.user_id, func.sum(KAMTarget.sales_target)).filter(
            KAMTarget.user_id.in_(kam_ids),
            KAMTarget.period.in_(target_periods),
        ).group_by(KAMTarget.user_id).all():
            target_by_user[int(uid)] = float(sv or 0)
    missing_target_ids = [uid for uid, value in target_by_user.items() if value <= 0]
    if missing_target_ids:
        for uid, sv in db.query(KAMTarget.user_id, func.sum(KAMTarget.sales_target)).filter(
            KAMTarget.user_id.in_(missing_target_ids),
            KAMTarget.period.in_(target_years),
        ).group_by(KAMTarget.user_id).all():
            target_by_user[int(uid)] = float(sv or 0)
    missing_target_ids = [uid for uid, value in target_by_user.items() if value <= 0]
    if missing_target_ids:
        fallback_rows = db.query(KAMTarget).filter(
            KAMTarget.user_id.in_(missing_target_ids),
            KAMTarget.period.like(f"{target_start.year}-%"),
        ).order_by(KAMTarget.user_id, KAMTarget.period.desc(), KAMTarget.id.desc()).all()
        for row in fallback_rows:
            uid = int(row.user_id)
            if target_by_user.get(uid, 0) <= 0:
                target_by_user[uid] = float(getattr(row, "sales_target", 0) or 0)
    for user in kams:
        uid = int(user.id)
        if target_by_user.get(uid, 0) <= 0:
            target_by_user[uid] = float(getattr(user, "target", None) or 0)

    def _score(cust_total: int, cust_active: int, leads_total: int, leads_converted: int, leads_overdue: int, tenders_total: int, tenders_won: int) -> int:
        cust_rate = (cust_active / cust_total * 100) if cust_total else 0
        conv_rate = (leads_converted / leads_total * 100) if leads_total else 0
        win_rate = (tenders_won / tenders_total * 100) if tenders_total else 0
        overdue_rate = 100 - (leads_overdue / leads_total * 100) if leads_total else 100
        return int(round(cust_rate * 0.2 + conv_rate * 0.35 + win_rate * 0.3 + overdue_rate * 0.15))

    kam_rows = []
    for user in kams:
        uid = int(user.id)
        cust_ids = customer_ids_by_user.get(uid, set())
        active_cust_ids = active_customer_ids_by_user.get(uid, set())
        won_customer_ids = customers_with_win_by_user.get(uid, set())
        leads = lead_stats.get(uid, {})
        tenders = tender_stats.get(uid, {})
        row = {
            "id": uid,
            "name": user.full_name or user.username,
            "group": _display_group(user),
            "region": user.region or "",
            "role": user.role,
            "customers_total": len(cust_ids),
            "customers_active": len(active_cust_ids),
            "customer_potential_value": float(sum(potential_by_customer.get(cid, 0.0) for cid in cust_ids)),
            "leads_total": int(leads.get("total", 0) or 0),
            "leads_converted": int(leads.get("converted", 0) or 0),
            "leads_lost": int(leads.get("lost", 0) or 0),
            "leads_overdue": int(leads.get("overdue", 0) or 0),
            "leads_pipeline": float(leads.get("pipeline", 0) or 0),
            "tenders_total": int(tenders.get("total", 0) or 0),
            "tenders_won": int(tenders.get("won", 0) or 0),
            "tenders_bid_value": float(tenders.get("bid_value", 0) or 0),
            "travel_total": int(travel_stats.get(uid, 0) or 0),
            "emdbg_active": int(emdbg_stats.get(uid, 0) or 0),
            "sales_target": float(target_by_user.get(uid, 0) or 0),
            "won_tender_value": float(tenders.get("won_value", 0) or 0),
            "customers_with_win": len(won_customer_ids),
            "customers_pending": max(0, len(cust_ids - won_customer_ids)),
        }
        row["score"] = _score(
            row["customers_total"],
            row["customers_active"],
            row["leads_total"],
            row["leads_converted"],
            row["leads_overdue"],
            row["tenders_total"],
            row["tenders_won"],
        )
        kam_rows.append(row)

    # Group Performance is built from the Group Fixing org-tree roster (the same
    # top-down "who's actually in this group" source the KAM 360 module uses),
    # not by bucketing users under their own resolved group label — a user with a
    # stale legacy group_id but no org-tree membership would otherwise get counted
    # under a group the module doesn't actually credit them to.
    kam_ids_set = set(kam_ids)
    sales_target_by_uid = {int(row["id"]): row["sales_target"] for row in kam_rows}

    def _sum_signal(signal_maps: dict[str, dict], key: str) -> float:
        return float(sum(float(value or 0) for value in signal_maps.get(key, {}).values()))

    signal_date_from = str(d_from or date(1970, 1, 1)) if (d_from or d_to) else None
    signal_date_to = str(d_to or today) if (d_from or d_to) else None

    visible_customer_ids_for_pipeline = sorted({cid for cids in customer_ids_by_user.values() for cid in cids})
    visible_pipeline_signals = _customer_signal_maps(
        visible_customer_ids_for_pipeline,
        db,
        scoped_uids=kam_ids,
        d_from=signal_date_from,
        d_to=signal_date_to,
    ) if visible_customer_ids_for_pipeline else {}
    active_pipeline_count = int(_sum_signal(visible_pipeline_signals, "lead_count") + _sum_signal(visible_pipeline_signals, "tender_count"))
    active_pipeline_value = float(_sum_signal(visible_pipeline_signals, "lead_value") + _sum_signal(visible_pipeline_signals, "tender_value"))

    if _group_fixing_groups:
        # Org uses Group Fixing (org-tree) — this is the same roster source the
        # KAM 360 module reads, so use it verbatim for exact parity.
        group_rosters = [
            (
                group.get("name") or f"Group {group.get('id')}",
                {
                    int(m.get("user_id") or m.get("id") or 0)
                    for m in (group.get("members") or [])
                    if (m.get("user_id") or m.get("id"))
                },
            )
            for group in _group_fixing_groups
        ]
    else:
        # No Group Fixing tree configured for this org — fall back to each user's
        # own resolved group label (legacy Group/group_id) so the section still
        # renders something instead of going empty.
        by_name: dict[str, set[int]] = {}
        for row in kam_rows:
            by_name.setdefault(row["group"] or "Unassigned", set()).add(int(row["id"]))
        group_rosters = list(by_name.items())

    groups: list[dict[str, Any]] = []
    for group_name, roster_ids in group_rosters:
        scoped_ids = sorted(
            uid for uid in roster_ids
            if uid in kam_ids_set and _is_kam_sales_role(kam_role_by_id.get(uid))
        )
        if not scoped_ids:
            continue

        group_customers: set[int] = set()
        group_active_customers: set[int] = set()
        sales_target = 0.0
        for uid in scoped_ids:
            group_customers.update(customer_ids_by_user.get(uid, set()))
            group_active_customers.update(active_customer_ids_by_user.get(uid, set()))
            sales_target += sales_target_by_uid.get(uid, 0.0)

        lstats = _lead_stats(scoped_ids, db, d_from, d_to)
        tstats = _tender_stats(scoped_ids, db, d_from, d_to)
        open_pipeline = (
            _kam_lead_records_query(db, scoped_ids, d_from, d_to)
            .filter(or_(Lead.status.is_(None), ~Lead.status.in_(["Converted", "Lost"])))
            .with_entities(func.sum(Lead.est_value))
            .scalar()
        )
        pipeline_signals = _customer_signal_maps(
            sorted(group_customers),
            db,
            scoped_uids=scoped_ids,
            d_from=signal_date_from,
            d_to=signal_date_to,
        ) if group_customers else {}
        active_lead_count = int(_sum_signal(pipeline_signals, "lead_count"))
        active_lead_value = float(_sum_signal(pipeline_signals, "lead_value"))
        active_tender_count = int(_sum_signal(pipeline_signals, "tender_count"))
        active_tender_value = float(_sum_signal(pipeline_signals, "tender_value"))
        won_count = int(_sum_signal(pipeline_signals, "won_count"))
        won_value = float(_sum_signal(pipeline_signals, "won_value"))
        active_group_pipeline = active_lead_value + active_tender_value

        groups.append({
            "name": group_name,
            "members": len(scoped_ids),
            "customers_total": len(group_customers),
            "customers_active": len(group_active_customers),
            "potential_value": float(sum(potential_by_customer.get(cid, 0.0) for cid in group_customers)),
            "leads_total": int(lstats.get("lead_count", 0) or 0),
            "leads_converted": int(lstats.get("converted_opportunity_count", 0) or 0),
            "lead_value": float(lstats.get("lead_value", 0) or 0),
            "tenders_total": int(tstats.get("tender_count", 0) or 0),
            "tenders_won": int(tstats.get("won_tender_count", 0) or 0),
            "tender_value": float(tstats.get("tender_value", 0) or 0),
            "pipeline": float(open_pipeline or 0),
            "sales_target": sales_target,
            "won_value": float(tstats.get("won_tender_value", 0) or 0),
            "active_leads_count": active_lead_count,
            "active_lead_value": active_lead_value,
            "active_tenders_count": active_tender_count,
            "active_tender_value": active_tender_value,
            "active_pipeline_count": active_lead_count + active_tender_count,
            "active_pipeline_value": active_group_pipeline,
            "won_count": won_count,
            "won_pipeline_value": won_value,
        })

    # "Unassigned" isn't a real team — exclude it from Group Performance entirely.
    groups = sorted(
        (row for row in groups if str(row["name"]).strip().casefold() != "unassigned"),
        key=lambda item: item["potential_value"],
        reverse=True,
    )

    visible_customer_ids = set().union(*customer_ids_by_user.values()) if customer_ids_by_user else set()
    visible_active_customer_ids = set().union(*active_customer_ids_by_user.values()) if active_customer_ids_by_user else set()
    visible_won_customer_ids = set().union(*customers_with_win_by_user.values()) if customers_with_win_by_user else set()

    summary = {
        "total_kams": len(kam_rows),
        "total_leads": sum(row["leads_total"] for row in kam_rows),
        "converted_leads": sum(row["leads_converted"] for row in kam_rows),
        "overdue_leads": sum(row["leads_overdue"] for row in kam_rows),
        "total_tenders": sum(row["tenders_total"] for row in kam_rows),
        "won_tenders": sum(row["tenders_won"] for row in kam_rows),
        "pipeline_value": sum(row["leads_pipeline"] for row in kam_rows),
        "active_pipeline_count": active_pipeline_count,
        "active_pipeline_value": active_pipeline_value,
        "won_value": sum(row["won_tender_value"] for row in kam_rows),
        "active_emdbg": sum(row["emdbg_active"] for row in kam_rows),
        "total_customers": len(visible_customer_ids),
        "active_customers": len(visible_active_customer_ids),
        "total_travel": sum(row["travel_total"] for row in kam_rows),
        "total_sales_target": sum(row["sales_target"] for row in kam_rows),
        "total_won_value": sum(row["won_tender_value"] for row in kam_rows),
        "total_customers_with_win": len(visible_won_customer_ids),
    }

    top_by_leads = sorted(kam_rows, key=lambda row: row["leads_total"], reverse=True)[:10]
    top_by_tenders = sorted(kam_rows, key=lambda row: row["tenders_total"], reverse=True)[:10]
    top_by_score = sorted(kam_rows, key=lambda row: row["score"], reverse=True)[:10]

    leads_region_q = (
        _lead_base_query()
        .filter(Lead.region.isnot(None))
        .with_entities(Lead.region, func.count(Lead.id))
        .group_by(Lead.region)
        .order_by(func.count(Lead.id).desc())
        .limit(10)
    )

    monthly_activity = []
    for m_start, m_end, label in _month_buckets(d_to or today):
        m_start_dt = datetime.combine(m_start, datetime.min.time())
        m_end_dt = datetime.combine(m_end, datetime.max.time())
        lead_month_q = _lead_base_query().filter(func.coalesce(Lead.lead_created_at, Lead.created_at).between(m_start_dt, m_end_dt))
        tender_month_q = db.query(Tender).filter(
            Tender.is_deleted == False,
            Tender.assigned_to.in_(kam_ids),
        )
        if tender_status:
            tender_month_q = tender_month_q.filter(Tender.tender_status == tender_status)
        if result:
            tender_month_q = tender_month_q.filter(Tender.result == result)
        tender_month_q = _restrict_customer_column(tender_month_q, Tender.customer_id, Tender.lead_id)
        tender_month_q = tender_month_q.filter(_tender_date_expr(m_start, m_end, m_start_dt, m_end_dt))
        monthly_activity.append({
            "month": label,
            "leads": int(lead_month_q.count() or 0),
            "converted": int(lead_month_q.filter(Lead.status == "Converted").count() or 0),
            "tenders": int(tender_month_q.count() or 0),
        })

    scoped_customers = _scope_customers(db.query(Customer), db, cu).order_by(Customer.customer_name.asc()).all()
    customer_options = [{"id": c.id, "name": c.customer_name, "label": c.customer_name} for c in scoped_customers]

    charts = {
        "top_by_leads": [{"name": row["name"], "value": row["leads_total"], "converted": row["leads_converted"]} for row in top_by_leads],
        "top_by_tenders": [{"name": row["name"], "value": row["tenders_total"], "won": row["tenders_won"]} for row in top_by_tenders],
        "top_by_score": [{"name": row["name"], "value": row["score"]} for row in top_by_score],
        "leads_by_region": [{"name": reg, "value": cnt} for reg, cnt in leads_region_q.all() if reg],
        "monthly_activity": monthly_activity,
    }

    return {
        "summary": summary,
        "kams": kam_rows,
        "groups": groups,
        "charts": charts,
        "filters": {
            "owners": [{"id": row["id"], "name": row["name"]} for row in kam_rows],
            "customers": customer_options,
            "groups": group_options,
        },
    }

def _tab_login_tracker(db, cu, d_from, d_to, assigned_to, status, result, state, country, customer_id, today, group=None):
    from datetime import datetime, timedelta
    from sqlalchemy import func, distinct, extract, or_
    from collections import defaultdict
 
    # Keep CEO data; only exclude admin and super_admin
    _ADMIN_ROLES_EXCLUDE = ("admin", "super_admin")
 
    # Default login tracker dashboard range: current week from Monday to today.
    # Today KPIs still use today_start/today_end below.
    if not d_from:
        d_from = today - timedelta(days=today.weekday())
    if not d_to:
        d_to = today

    if d_from > d_to:
        d_from, d_to = d_to, d_from
 
    today_start = datetime.combine(today, datetime.min.time())
    today_end   = today_start + timedelta(days=1)
    range_start = datetime.combine(d_from, datetime.min.time())
    range_end   = datetime.combine(d_to, datetime.min.time()) + timedelta(days=1)
 
    scope_ids = _scope_user_ids(db, cu)
 
    users_q = db.query(User).filter(User.is_active == True)
    if scope_ids is not None:
        users_q = users_q.filter(User.id.in_(scope_ids))
 
    all_users_raw = users_q.all()
 
    # Exclude admin/super_admin only — CEO is kept
    non_admin_users = [
        u for u in all_users_raw
        if (u.role or "").strip().lower() not in _ADMIN_ROLES_EXCLUDE
    ]
 
    non_admin_ids = [u.id for u in non_admin_users]
    non_admin_usernames = [u.username for u in non_admin_users]

    role_display_name_map = {
        r.name.strip().lower(): (r.display_name or r.name).strip()
        for r in db.query(Role).filter(Role.is_active == True).all()
    }

    all_regions = {
        r.id: r.name
        for r in db.query(Region).filter(Region.is_active == True).all()
    }
 
    try:
        all_states = {
            s.id: s.name
            for s in db.query(State).filter(State.is_active == True).all()
        }
    except Exception:
        all_states = {}
 
    all_groups_rows = db.query(Group).filter(Group.is_active == True).all()
    all_groups_map = {g.id: g for g in all_groups_rows}
    all_group_names = {g.id: g.name for g in all_groups_rows}
 
    def _parse_csv_ids(raw) -> set:
        ids = set()
        for part in str(raw or "").split(","):
            part = part.strip()
            if not part:
                continue
            try:
                ids.add(int(part))
            except ValueError:
                pass
        return ids

    # Masters → Groups is the source of truth for Login Tracker group labels.
    # Include direct user membership, the configured group manager, and the
    # reporting-hierarchy members maintained from the Master Group screen.
    master_group_ids_by_user = defaultdict(set)
    scoped_user_ids = {int(user.id) for user in all_users_raw if user.id}
    for user in all_users_raw:
        master_group_ids_by_user[int(user.id)].update(
            _parse_csv_ids(getattr(user, "group_id", None))
        )
    for master_group in all_groups_rows:
        if master_group.manager_id and int(master_group.manager_id) in scoped_user_ids:
            master_group_ids_by_user[int(master_group.manager_id)].add(int(master_group.id))
    if scoped_user_ids:
        hierarchy_memberships = db.query(
            UserReportingHierarchy.group_id,
            UserReportingHierarchy.reporting_user_id,
        ).filter(
            UserReportingHierarchy.is_active == True,
            UserReportingHierarchy.group_id.in_(list(all_groups_map)),
            UserReportingHierarchy.reporting_user_id.in_(scoped_user_ids),
        ).all()
        for group_id, user_id in hierarchy_memberships:
            if group_id and user_id:
                master_group_ids_by_user[int(user_id)].add(int(group_id))

    # The Groups tab in Masters is the Org Tree.  Prefer its L2 group name
    # (for example, Banking) for Login Tracker display and filtering.
    from app.routers.kam_router import _group_fixing_payload
    _, org_tree_groups_by_user = _group_fixing_payload(db)

    def _login_tracker_group_names(user_id: int) -> list[str]:
        org_tree_names = (org_tree_groups_by_user.get(int(user_id), {}) or {}).get("group_names") or []
        names = [str(name).strip() for name in org_tree_names if str(name or "").strip()]
        if names:
            return list(dict.fromkeys(names))
        return [
            all_group_names[group_id]
            for group_id in sorted(master_group_ids_by_user.get(int(user_id), set()))
            if group_id in all_group_names and all_group_names[group_id]
        ]

    group_options = sorted({
        group_name
        for user in non_admin_users
        for group_name in _login_tracker_group_names(int(user.id))
    })

    group_filter = (group or "").strip().lower()
    if group_filter:
        non_admin_users = [
            u for u in non_admin_users
            if group_filter in {
                name.strip().lower()
                for name in _login_tracker_group_names(int(u.id))
            }
        ]
        non_admin_ids = [u.id for u in non_admin_users]
        non_admin_usernames = [u.username for u in non_admin_users]
 
    user_map = {}
    username_to_fullname = {}
 
    for u in all_users_raw:
        role = (u.role or "").strip().lower()
        is_admin = role in _ADMIN_ROLES_EXCLUDE
        u_group_ids = master_group_ids_by_user.get(int(u.id), set())

        group_names = _login_tracker_group_names(int(u.id))
        resolved_group = ", ".join(group_names) if group_names else ""
 
        # Region is owned by the user record.  region_id can contain one or
        # more comma-separated Master Region IDs.
        region_names_set = {
            all_regions[region_id]
            for region_id in _parse_csv_ids(getattr(u, "region_id", None))
            if region_id in all_regions
        }
        if not region_names_set and str(getattr(u, "region", "") or "").strip():
            region_names_set.add(str(u.region).strip())
        resolved_region = ", ".join(sorted(region_names_set)) if region_names_set else ""
 
        state_names_set = set()
        for gid in u_group_ids:
            grp = all_groups_map.get(gid)
            if grp and getattr(grp, "state_id", None):
                for sid in _parse_csv_ids(grp.state_id):
                    sname = all_states.get(sid)
                    if sname:
                        state_names_set.add(sname)
        if not state_names_set and getattr(u, "state_id", None) and u.state_id in all_states:
            state_names_set.add(all_states[u.state_id])
        resolved_state = ", ".join(sorted(state_names_set)) if state_names_set else ""
 
        user_map[u.id] = {
            "id":       u.id,
            "name":     u.full_name or u.username,
            "username": u.username,
            "role":     u.role or "",
            "email":    getattr(u, "email", "") or "",
            "phone":    u.phone or "",
            "employee_code": u.employee_code or "",
            "branch":   u.branch or "",
            "last_login": u.last_login,
            "is_admin": is_admin,
            "region":   resolved_region,
            "state":    resolved_state,
            "group":    resolved_group,
        }
        username_to_fullname[u.username.lower()] = u.full_name or u.username
 
    def _resolve_region(uid):
        return user_map.get(uid, {}).get("region", "")
 
    def _resolve_group(uid):
        return user_map.get(uid, {}).get("group", "")
 
    def _resolve_state(uid):
        return user_map.get(uid, {}).get("state", "")
 
    def _resolve_name_from_username(uname):
        return username_to_fullname.get((uname or "").strip().lower(), uname or "Unknown")
 
    # ── Role/user-type breakdown (excluding admin/super_admin) ────────────────
    role_users_map = defaultdict(list)
    for u in non_admin_users:
        raw_role = (u.role or "Unknown").strip() or "Unknown"
        role_name = role_display_name_map.get(raw_role.lower(), raw_role)
        role_users_map[role_name].append({
            "id":       u.id,
            "name":     u.full_name or u.username,
            "username": u.username,
            "email":    getattr(u, "email", "") or "",
            "region":   _resolve_region(u.id),
            "state":    _resolve_state(u.id),
            "group":    _resolve_group(u.id),
            "branch":   u.branch or "",
            "last_login": u.last_login.isoformat() if u.last_login else None,
            "is_active":  bool(u.is_active),
        })
 
    role_user_counts = sorted(
        [
            {
                "name":  role,
                "value": len(users),
                "users": sorted(users, key=lambda item: item["name"]),
            }
            for role, users in role_users_map.items()
        ],
        key=lambda item: -item["value"],
    )
 
    def _login_q():
        q = db.query(LoginLog).filter(LoginLog.user_id.in_(non_admin_ids))
        if assigned_to:
            q = q.filter(LoginLog.user_id == assigned_to)
        return q
 
    def _session_q():
        q = db.query(UserSession).filter(UserSession.user_id.in_(non_admin_ids))
        if assigned_to:
            q = q.filter(UserSession.user_id == assigned_to)
        return q
 
    def _login_q_with_failed():
        q = db.query(LoginLog).filter(or_(
            LoginLog.user_id.in_(non_admin_ids),
            LoginLog.username.in_(non_admin_usernames),
        ))
        if assigned_to:
            q = q.filter(LoginLog.user_id == assigned_to)
        return q
 
    login_ranged = _login_q().filter(
        LoginLog.created_at >= range_start,
        LoginLog.created_at < range_end,
    )
    login_ranged_with_failed = _login_q_with_failed().filter(
        LoginLog.created_at >= range_start,
        LoginLog.created_at < range_end,
    )
    session_ranged = _session_q().filter(
        UserSession.login_time >= range_start,
        UserSession.login_time < range_end,
    )
 
    # ── KPI counts ────────────────────────────────────────────────────────────
    logins_today = _login_q().filter(
        LoginLog.success == True,
        LoginLog.created_at >= today_start,
        LoginLog.created_at < today_end,
    ).count()
 
    unique_users_today = _login_q().filter(
        LoginLog.success == True,
        LoginLog.created_at >= today_start,
        LoginLog.created_at < today_end,
        LoginLog.user_id.isnot(None),
    ).with_entities(func.count(distinct(LoginLog.user_id))).scalar() or 0
 
    active_sessions_now = _session_q().filter(UserSession.is_active == True).count()
 
    failed_today = _login_q_with_failed().filter(
        LoginLog.success == False,
        LoginLog.created_at >= today_start,
        LoginLog.created_at < today_end,
    ).count()
 
    total_logins_range = login_ranged.filter(LoginLog.success == True).count()
    failed_in_range = login_ranged_with_failed.filter(LoginLog.success == False).count()
 
    total_unique_range = login_ranged.filter(
        LoginLog.success == True,
        LoginLog.user_id.isnot(None),
    ).with_entities(func.count(distinct(LoginLog.user_id))).scalar() or 0
 
    total_users = len(non_admin_users)
    never_logged_in = sum(1 for u in non_admin_users if not u.last_login)
    avg_sessions = round(total_logins_range / total_unique_range, 1) if total_unique_range else 0
 
    # ── Not logged in today ───────────────────────────────────────────────────
    # ── Logged in today / Not logged in today ──────────────────────────────────
    logged_in_today_ids = set()

    # Source 1: successful LoginLog rows
    for row in _login_q().filter(
        LoginLog.success == True,
        LoginLog.created_at >= today_start,
        LoginLog.created_at < today_end,
        LoginLog.user_id.isnot(None),
    ).with_entities(LoginLog.user_id).distinct().all():
        if row.user_id:
            logged_in_today_ids.add(int(row.user_id))

    # Source 2: UserSession rows, fallback when session exists but LoginLog is missing
    for row in _session_q().filter(
        UserSession.login_time >= today_start,
        UserSession.login_time < today_end,
        UserSession.user_id.isnot(None),
    ).with_entities(UserSession.user_id).distinct().all():
        if row.user_id:
            logged_in_today_ids.add(int(row.user_id))

    unique_users_today = len(logged_in_today_ids)

    # ── Logged in today list for report table ──────────────────────────────────
    logged_in_today_list = []
    first_login_by_user = {
        int(user_id): first_login
        for user_id, first_login in _login_q().filter(
            LoginLog.success == True,
            LoginLog.created_at >= today_start,
            LoginLog.created_at < today_end,
            LoginLog.user_id.isnot(None),
        ).with_entities(
            LoginLog.user_id,
            func.min(LoginLog.created_at),
        ).group_by(LoginLog.user_id).all()
        if user_id is not None and first_login is not None
    }
    sessions_today_by_user: dict[int, list[UserSession]] = defaultdict(list)
    for session in _session_q().filter(
        UserSession.login_time >= today_start,
        UserSession.login_time < today_end,
        UserSession.user_id.isnot(None),
    ).all():
        sessions_today_by_user[int(session.user_id)].append(session)

    for uid in sorted(logged_in_today_ids):
        u_info = user_map.get(uid)
        if not u_info:
            continue

        first_login = first_login_by_user.get(uid)
        last_activity = None
        session_count = 0
        devices = set()

        for sess in sessions_today_by_user.get(uid, []):
            session_count += 1

            if sess.login_time and (first_login is None or sess.login_time < first_login):
                first_login = sess.login_time

            activity_time = sess.logout_time or sess.last_active or sess.login_time
            if activity_time and (last_activity is None or activity_time > last_activity):
                last_activity = activity_time

            if sess.device:
                devices.add(sess.device)

        if first_login and last_activity:
            duration_mins = round((last_activity - first_login).total_seconds() / 60, 1)
        else:
            duration_mins = None

        logged_in_today_list.append({
            "user_id":          uid,
            "user_name":        u_info.get("name", "Unknown"),
            "username":         u_info.get("username", ""),
            "role":             u_info.get("role", ""),
            "region":           _resolve_region(uid),
            "state":            _resolve_state(uid),
            "group":            _resolve_group(uid),
            "branch":           u_info.get("branch", ""),
            "date":             today.isoformat(),
            "first_login":      first_login.isoformat() if first_login else None,
            "last_logout":      last_activity.isoformat() if last_activity else None,
            "duration_minutes": duration_mins,
            "session_count":    session_count,
            "devices":          list(devices)[:3],
        })
 
    not_logged_in_list = []
    for u in non_admin_users:
        if u.id in logged_in_today_ids:
            continue
        not_logged_in_list.append({
            "id":            u.id,
            "name":          u.full_name or u.username,
            "username":      u.username,
            "email":         getattr(u, "email", "") or "",
            "phone":         u.phone or "",
            "employee_code": u.employee_code or "",
            "role":          u.role or "",
            "region":        _resolve_region(u.id),
            "state":         _resolve_state(u.id),
            "group":         _resolve_group(u.id),
            "branch":        u.branch or "",
            "last_login":    u.last_login.isoformat() if u.last_login else None,
            "is_active":     bool(u.is_active),
        })
    not_logged_in_list.sort(key=lambda x: x["name"])
    not_logged_in_today_count = len(not_logged_in_list)
 
    # ── Daily trend ───────────────────────────────────────────────────────────
    daily_trend = []
    success_daily_map = {
        str(day): {"logins": int(count or 0), "unique_users": int(unique_count or 0)}
        for day, count, unique_count in _login_q().filter(
            LoginLog.success == True,
            LoginLog.created_at >= range_start,
            LoginLog.created_at < range_end,
        ).with_entities(
            func.date(LoginLog.created_at),
            func.count(LoginLog.id),
            func.count(distinct(LoginLog.user_id)),
        ).group_by(func.date(LoginLog.created_at)).all()
        if day is not None
    }
    failed_daily_map = {
        str(day): int(count or 0)
        for day, count in _login_q_with_failed().filter(
            LoginLog.success == False,
            LoginLog.created_at >= range_start,
            LoginLog.created_at < range_end,
        ).with_entities(
            func.date(LoginLog.created_at),
            func.count(LoginLog.id),
        ).group_by(func.date(LoginLog.created_at)).all()
        if day is not None
    }
    d = d_from
    while d <= d_to:
        day_key = d.isoformat()
        success_stats = success_daily_map.get(day_key, {})
        daily_trend.append({
            "date": day_key,
            "label": d.strftime("%d %b"),
            "logins": success_stats.get("logins", 0),
            "failed": failed_daily_map.get(day_key, 0),
            "unique_users": success_stats.get("unique_users", 0),
        })
        d += timedelta(days=1)
 
    # ── Hourly distribution ───────────────────────────────────────────────────
    hourly_dist = [{"hour": h, "label": f"{h:02d}:00", "count": 0} for h in range(24)]
    try:
        hour_rows = login_ranged.filter(LoginLog.success == True).with_entities(
            extract("hour", LoginLog.created_at).label("hr"),
            func.count(LoginLog.id),
        ).group_by("hr").all()
        hour_map = {int(h): int(c) for h, c in hour_rows}
        for entry in hourly_dist:
            entry["count"] = hour_map.get(entry["hour"], 0)
    except Exception:
        pass
 
    # ── By role (login counts — for chart) ───────────────────────────────────
    by_role = defaultdict(int)
    login_success_rows = login_ranged.filter(
        LoginLog.success == True, LoginLog.user_id.isnot(None),
    ).with_entities(LoginLog.user_id).all()
    for row in login_success_rows:
        u_info = user_map.get(row.user_id, {})
        by_role[u_info.get("role") or "Unknown"] += 1
    by_role_list = sorted([{"name": k, "value": v} for k, v in by_role.items()], key=lambda x: -x["value"])
 
    # ── By weekday ────────────────────────────────────────────────────────────
    weekday_user_map = [set() for _ in range(7)]

    # Source 1: successful LoginLog rows in selected range
    for row in login_ranged.filter(
        LoginLog.success == True,
        LoginLog.user_id.isnot(None),
    ).with_entities(LoginLog.user_id, LoginLog.created_at).all():
        if row.created_at and row.user_id:
            weekday_user_map[row.created_at.weekday()].add(int(row.user_id))

    # Source 2: UserSession rows in selected range, fallback when LoginLog is missing
    for row in session_ranged.filter(
        UserSession.user_id.isnot(None),
    ).with_entities(UserSession.user_id, UserSession.login_time).all():
        if row.login_time and row.user_id:
            weekday_user_map[row.login_time.weekday()].add(int(row.user_id))

    weekday_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    by_weekday_list = [
        {
            "name": weekday_names[i],
            "value": len(weekday_user_map[i]),
        }
        for i in range(7)
    ] 
    # ── By browser / OS ───────────────────────────────────────────────────────
    by_browser = defaultdict(int)
    by_os = defaultdict(int)
    for s in session_ranged.with_entities(UserSession.browser, UserSession.os).all():
        by_browser[s.browser or "Unknown"] += 1
        by_os[s.os or "Unknown"] += 1
    by_browser_list = sorted([{"name": k, "value": v} for k, v in by_browser.items()], key=lambda x: -x["value"])[:8]
    by_os_list = sorted([{"name": k, "value": v} for k, v in by_os.items()], key=lambda x: -x["value"])[:8]
 
    # ── Per-user-per-day aggregation (for daily_log) ──────────────────────────
    user_day_map = defaultdict(lambda: {
        "first_login": None,
        "last_logout": None,
        "sessions": 0,
        "devices": set(),
        "ips": set(),
    })
    for s in session_ranged.all():
        if not s.user_id or not s.login_time:
            continue
        login_date = s.login_time.date()
        key = (s.user_id, login_date)
        entry = user_day_map[key]
        entry["sessions"] += 1
        if entry["first_login"] is None or s.login_time < entry["first_login"]:
            entry["first_login"] = s.login_time
        logout = s.logout_time or s.last_active
        if logout:
            if entry["last_logout"] is None or logout > entry["last_logout"]:
                entry["last_logout"] = logout
        if s.device:
            entry["devices"].add(s.device)
        if s.ip_address:
            entry["ips"].add(s.ip_address)
 
    daily_log = []
    for (uid, log_date), entry in sorted(user_day_map.items(), key=lambda x: (x[0][1], x[0][0]), reverse=True):
        u_info = user_map.get(uid)
        if not u_info:
            continue
        duration_mins = None
        if entry["first_login"] and entry["last_logout"]:
            duration_mins = round((entry["last_logout"] - entry["first_login"]).total_seconds() / 60, 1)
        daily_log.append({
            "user_id":          uid,
            "user_name":        u_info.get("name", "Unknown"),
            "username":         u_info.get("username", ""),
            "role":             u_info.get("role", ""),
            "region":           _resolve_region(uid),
            "state":            _resolve_state(uid),
            "group":            _resolve_group(uid),
            "branch":           u_info.get("branch", ""),
            "date":             log_date.isoformat(),
            "first_login":      entry["first_login"].isoformat() if entry["first_login"] else None,
            "last_logout":      entry["last_logout"].isoformat() if entry["last_logout"] else None,
            "duration_minutes": duration_mins,
            "session_count":    entry["sessions"],
            "devices":          list(entry["devices"])[:3],
            "ips":              list(entry["ips"])[:3],
        })
    daily_log = daily_log[:500]
 
    # ── Top active users ──────────────────────────────────────────────────────
    user_login_counts = defaultdict(int)
    for row in login_success_rows:
        user_login_counts[row.user_id] += 1
    top_active = []
    for uid, cnt in sorted(user_login_counts.items(), key=lambda x: -x[1])[:15]:
        u_info = user_map.get(uid, {})
        top_active.append({
            "user_id":    uid,
            "name":       u_info.get("name", "Unknown"),
            "role":       u_info.get("role", ""),
            "group":      _resolve_group(uid),
            "login_count": cnt,
        })
 
    # ── Failed attempts ───────────────────────────────────────────────────────
    failed_by_user = defaultdict(int)
    for row in login_ranged_with_failed.filter(LoginLog.success == False).all():
        key = row.username or "Unknown"
        failed_by_user[key] += 1
    top_failed = sorted(
        [{"username": _resolve_name_from_username(k), "raw_username": k, "attempts": v} for k, v in failed_by_user.items()],
        key=lambda x: -x["attempts"],
    )[:10]
 
    # ── Active sessions ───────────────────────────────────────────────────────
    active_sessions = []
    for s in _session_q().filter(UserSession.is_active == True).order_by(UserSession.last_active.desc()).limit(50).all():
        u_info = user_map.get(s.user_id, {})
        active_sessions.append({
            "user_id":    s.user_id,
            "user_name":  u_info.get("name", "Unknown"),
            "role":       u_info.get("role", ""),
            "region":     _resolve_region(s.user_id),
            "group":      _resolve_group(s.user_id),
            "device":     s.device or "",
            "browser":    s.browser or "",
            "os":         s.os or "",
            "ip_address": s.ip_address or "",
            "login_time": s.login_time.isoformat() if s.login_time else None,
            "last_active": s.last_active.isoformat() if s.last_active else None,
        })
 
    # ── Session table ─────────────────────────────────────────────────────────
    session_table = []
    for s in session_ranged.order_by(UserSession.login_time.desc()).limit(300).all():
        u_info = user_map.get(s.user_id, {})
        duration_mins = None
        end_time = s.logout_time or (s.last_active if not s.is_active else None)
        if s.login_time and end_time:
            duration_mins = round((end_time - s.login_time).total_seconds() / 60, 1)
        session_table.append({
            "id":               s.id,
            "user_id":          s.user_id,
            "user_name":        u_info.get("name", "Unknown"),
            "username":         u_info.get("username", ""),
            "role":             u_info.get("role", ""),
            "region":           _resolve_region(s.user_id),
            "state":            _resolve_state(s.user_id),
            "group":            _resolve_group(s.user_id),
            "branch":           u_info.get("branch", ""),
            "device":           s.device or "",
            "browser":          s.browser or "",
            "os":               s.os or "",
            "ip_address":       s.ip_address or "",
            "login_time":       s.login_time.isoformat() if s.login_time else None,
            "logout_time":      s.logout_time.isoformat() if s.logout_time else None,
            "last_active":      s.last_active.isoformat() if s.last_active else None,
            "duration_minutes": duration_mins,
            "is_active":        bool(s.is_active),
            "revoke_reason":    s.revoke_reason or "",
        })
 
    # ── Alerts ────────────────────────────────────────────────────────────────
    alerts = []
    for username, cnt in sorted(failed_by_user.items(), key=lambda x: -x[1])[:5]:
        if cnt >= 3:
            alerts.append({
                "type":     "failed_attempts",
                "severity": "high" if cnt >= 5 else "medium",
                "message":  f"{_resolve_name_from_username(username)}: {cnt} failed login attempts in period",
            })
    seven_days_ago = today - timedelta(days=7)
    inactive_count = 0
    for u in non_admin_users:
        if u.last_login and hasattr(u.last_login, "date") and u.last_login.date() < seven_days_ago and u.is_active:
            days_ago = (today - u.last_login.date()).days
            if days_ago >= 14:
                alerts.append({
                    "type":     "inactive_user",
                    "severity": "low",
                    "message":  f"{u.full_name or u.username} hasn't logged in for {days_ago} days",
                    "user_id":  u.id,
                })
                inactive_count += 1
                if inactive_count >= 5:
                    break
 
    return {
        "summary": {
            "logins_today":          logins_today,
            "unique_users_today":    unique_users_today,
            "active_sessions":       active_sessions_now,
            "failed_today":          failed_today,
            "total_logins":          total_logins_range,
            "total_unique_users":    total_unique_range,
            "failed_in_range":       failed_in_range,
            "total_users":           total_users,
            "never_logged_in":       never_logged_in,
            "avg_sessions_per_user": avg_sessions,
            # New:
            "not_logged_in_today":   not_logged_in_today_count,
        },
        "charts": {
            "daily_trend":        daily_trend,
            "hourly_distribution": hourly_dist,
            "by_role":            by_role_list,
            "by_role_users":      role_user_counts,
            "by_browser":         by_browser_list,
            "by_os":              by_os_list,
            "by_weekday":         by_weekday_list,
        },
        "daily_log":    daily_log,
        "logged_in_today":  logged_in_today_list,
        "not_logged_in": not_logged_in_list,   # NEW
        "top_lists": {
            "most_active": top_active,
            "most_failed": top_failed,
        },
        "active_sessions": active_sessions,
        "session_table":   session_table,
        "alerts":          alerts[:10],
        "filters": {
            "owners": [
                o for o in _owners_list(db, cu)
                if user_map.get(o["id"], {}).get("is_admin") is not True
            ],
            "groups": group_options,
        },
    }

# ─── Main Tab Dispatcher ────────────────────────────────────────────────────────

_TAB_HANDLERS = {
    "customers": _tab_customers,
    "leads":     _tab_leads,
    "tenders":   _tab_tenders,
    "travel":    _tab_travel,
    "emdbg":     _tab_emdbg,
    "kam360":    _tab_kam360,
    "login_tracker": _tab_login_tracker,
}


@router.get("/tab/{module}")
def get_dashboard_tab(
    module:      str,
    date_from:   Optional[str] = None,
    date_to:     Optional[str] = None,
    assigned_to: Optional[int] = None,
    status:      Optional[str] = None,
    result:      Optional[str] = None,
    state:       Optional[str] = None,
    country:     Optional[str] = None,
    customer_id: Optional[int] = None,
    group:       Optional[str] = None,
    db:  Session = Depends(get_tenant_db),
    cu:  User    = Depends(get_current_user),
):
    """Unified analytics endpoint for dashboard module tabs."""
    handler = _TAB_HANDLERS.get(module)
    if not handler:
        raise HTTPException(status_code=404, detail=f"Unknown module: {module}")
    _require_dashboard_permissions(db, cu, "dashboard.view", DASHBOARD_TAB_PERMISSIONS[module])
    today  = today_ist()
    d_from = _parse_date(date_from)
    d_to   = _parse_date(date_to)
    if module in ("kam360", "login_tracker"):
        return handler(db, cu, d_from, d_to, assigned_to, status, result, state, country, customer_id, today, group)
    return handler(db, cu, d_from, d_to, assigned_to, status, result, state, country, customer_id, today)


from pydantic import BaseModel as _BaseModel
from typing import List as _List
 
class LoginReminderPayload(_BaseModel):
    user_ids: _List[int]
    subject:  str = "Action Required: Please Log In to the CRM System Today"
    message:  str = "Dear {name},\n\nPlease log in to the CRM system today."


@router.post("/send-login-reminder")
def send_login_reminder(
    payload: LoginReminderPayload,
    request: Request,
    db:      Session = Depends(get_tenant_db),
    cu:      User    = Depends(get_current_user),
):
    """Send login reminder emails to selected not-logged-in users."""
    _require_dashboard_permissions(db, cu, "dashboard.view", "dashboard.login_tracker.view")

    if not payload.user_ids:
        raise HTTPException(400, "Select at least one user")

    users = db.query(User).filter(
        User.id.in_(payload.user_ids),
        User.is_active == True,
    ).all()

    # Resolve tenant for email
    from app.services.tenant_email_service import send_tenant_email, TenantEmailConfigurationError, TenantEmailDeliveryError
    from app.dependencies import _resolve_tenant_slug
    from app.models.tenant import Tenant
    from app.database import get_master_db
    import logging as _logging
    _logger = _logging.getLogger(__name__)

    tenant = None
    try:
        tenant_slug = _resolve_tenant_slug(request)
        master_sess = next(get_master_db())
        tenant = master_sess.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    except Exception as e:
        _logger.warning("send_login_reminder: could not resolve tenant: %s", e)

    sent_count = 0
    failed_count = 0

    for user in users:
        email = (getattr(user, "email", "") or "").strip()
        if not email:
            failed_count += 1
            continue

        name = user.full_name or user.username or "User"
        body = payload.message.replace("{name}", name)
        html_body = "<html><body style='font-family:Arial,sans-serif;color:#0f172a;'>"
        for line in body.split("\n"):
            html_body += f"<p style='margin:4px 0'>{line}</p>"
        html_body += "</body></html>"

        try:
            if tenant:
                send_tenant_email(
                    tenant=tenant,
                    to_email=email,
                    subject=payload.subject,
                    text_body=body,
                    html_body=html_body,
                )
                sent_count += 1
            else:
                _logger.warning("send_login_reminder: no tenant config, skipping %s", email)
                failed_count += 1
        except (TenantEmailConfigurationError, TenantEmailDeliveryError) as e:
            _logger.warning("send_login_reminder: email failed for %s: %s", email, e)
            failed_count += 1

    return {
        "message": f"Reminder sent to {sent_count} user(s)" + (f", {failed_count} failed" if failed_count else ""),
        "sent":    sent_count,
        "failed":  failed_count,
    }


# ─── Combined badge endpoint ────────────────────────────────────────────────────

@router.get("/badges")
def get_all_badges(
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Single endpoint returning all sidebar badge counts + notification unread count.
    Each module is wrapped in try/except so one failure never breaks the others.
    """
    counts: dict = {
        "customers": 0, "leads": 0, "tenders": 0, "workorders": 0,
        "emdbg": 0, "approvals": 0, "alerts": 0, "notifications": 0,
    }
    tenant_slug = tenant_slug_from_db(db)
    cache_key = badges_cache_key(tenant_slug, current_user.id) if tenant_slug else ""
    if cache_key:
        cached = cache_get_json(cache_key, "badges")
        if cached is not None:
            return cached

    if not _BADGE_HELPERS_AVAILABLE:
        return counts

    layout = dict(current_user.dashboard_layout or {})

    def _last_seen(key: str):
        val = layout.get(key)
        if not val:
            return None
        try:
            return datetime.fromisoformat(val)
        except (ValueError, TypeError):
            return None

    # Customers
    try:
        last_seen = _last_seen("customers_last_seen_at")
        if last_seen:
            q = db.query(func.count(Customer.id)).filter(
                Customer.is_deleted == False,
                Customer.created_at > last_seen,
            )
            q = _customer_scope(db, q, current_user)
            counts["customers"] = q.scalar() or 0
    except Exception:
        pass

    # Leads
    try:
        last_seen = _last_seen("leads_last_seen_at")
        if last_seen:
            q = db.query(func.count(Lead.id)).filter(Lead.created_at > last_seen)
            q = _lead_scope(q, db, current_user)
            counts["leads"] = q.scalar() or 0
    except Exception:
        pass

    # Tenders
    try:
        last_seen = _last_seen("tenders_last_seen_at")
        if last_seen:
            q = db.query(func.count(Tender.id)).filter(
                Tender.created_at > last_seen,
                Tender.is_deleted == False,
            )
            q = _tender_scope(db, q, current_user, "tenders", Tender.created_by, Tender.assigned_to)
            counts["tenders"] = q.scalar() or 0
    except Exception:
        pass

    # Work Orders
    try:
        last_seen = _last_seen("workorders_last_seen_at")
        if last_seen:
            q = db.query(func.count(WorkOrder.id)).filter(WorkOrder.created_at > last_seen)
            scope_ids = _wo_scope_user_ids(db, current_user)
            if scope_ids is not None:
                q = q.filter(or_(
                    WorkOrder.created_by.in_(scope_ids),
                    WorkOrder.project_manager_id.in_(scope_ids),
                ))
            counts["workorders"] = q.scalar() or 0
    except Exception:
        pass

    # EMDBG
    try:
        last_seen = _last_seen("emdbg_last_seen_at")
        if last_seen:
            q = db.query(func.count(EMDBG.id)).filter(EMDBG.created_at > last_seen)
            if current_user.role == "accounts":
                q = q.filter(EMDBG.approval_status == "approved")
            else:
                scope_ids = _emdbg_scope_user_ids(db, current_user)
                if scope_ids is not None:
                    q = q.outerjoin(Tender, EMDBG.tender_id == Tender.id).filter(
                        or_(EMDBG.created_by.in_(scope_ids), Tender.assigned_to.in_(scope_ids))
                    )
            counts["emdbg"] = q.scalar() or 0
    except Exception:
        pass

    # Approvals (legacy + dynamic workflow)
    try:
        _refresh_travel_auto_approvals(db, approver_id=current_user.id)
        shadowed_ids = _get_shadowed_dynamic_travel_record_ids(db, approver_id=current_user.id)
        legacy = db.query(Approval).filter(
            Approval.requested_to == current_user.id,
            Approval.status == "pending",
        ).all()
        if shadowed_ids:
            legacy = [a for a in legacy if a.module != "travel" or a.record_id not in shadowed_ids]
        dynamic = (
            db.query(func.count(ApprovalRequest.id))
            .join(ApprovalRequestStep, ApprovalRequestStep.approval_request_id == ApprovalRequest.id)
            .filter(
                ApprovalRequest.status == "pending",
                ApprovalRequestStep.step_no == ApprovalRequest.current_step_no,
                ApprovalRequestStep.approver_user_id == current_user.id,
                ApprovalRequestStep.status == "pending",
            )
            .scalar() or 0
        )
        counts["approvals"] = len(legacy) + int(dynamic)
        db.commit()
    except Exception:
        pass

    # Alerts
    try:
        _sync_alerts(db, current_user)
        counts["alerts"] = db.query(Alert).filter(
            Alert.user_id == current_user.id,
            Alert.is_read == False,
            Alert.is_dismissed == False,
        ).count()
        db.commit()
    except Exception:
        pass

    # Notifications
    try:
        counts["notifications"] = db.query(Notification).filter(
            Notification.user_id == current_user.id,
            Notification.is_read == False,
        ).count()
    except Exception:
        pass

    if cache_key:
        cache_set_json(cache_key, counts, CACHE_TTL_SECONDS["badges"])
    return counts

# ─── Prototype v9 dashboards: boards, welcome banner, drill-down records, custom layouts ──────────────────────
# Analytics live in app/services/dashboard_v9.py; these routes add permissions, data scope and caching.
from app.services import dashboard_v9 as _v9

V9_BOARD_PERMISSIONS = {
    "overview": "dashboard.view",
    "leads": "dashboard.leads.view",
    "deals": "dashboard.deals.view",
    "bids": "dashboard.tenders.view",
    "kam": "dashboard.kam360.view",
    "orders": "dashboard.orders.view",
    "finance": "dashboard.finance.view",
    "login": "dashboard.login_tracker.view",
    "funnel": "dashboard.view",          # rows are limited by each module's own permissions and data visibility
}
# Drill-down sources: login and KAM records need their tab permission; every other source is reachable from the
# Overview KPIs, so the base dashboard permission is enough.
V9_SOURCE_PERMISSIONS = {"logins": "dashboard.login_tracker.view", "signals": "dashboard.login_tracker.view", "kams": "dashboard.kam360.view",
                         "leads": "dashboard.leads.view"}
V9_CACHE_SECONDS = 60


def _v9_ctx(db: Session, cu: User, period: str) -> "_v9.Ctx":
    perms = _dashboard_permission_keys(db, cu)
    if "dashboard.view" not in perms:
        raise HTTPException(403, "Dashboard access permission required")
    _v9.ensure_schema(db, tenant_slug_from_db(db))
    return _v9.Ctx(db, cu, _scope_user_ids(db, cu), period, today_ist(), perms)


def _v9_cache_key(db: Session, cu: User, *parts: str) -> str:
    return f"dash9:{tenant_slug_from_db(db)}:{cu.id}:{':'.join(parts)}"


@router.get("/v9/welcome")
def v9_welcome(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    """Welcome banner counts for the signed-in user (prototype dashHero)."""
    return _v9.welcome(_v9_ctx(db, cu, "FY"))


@router.get("/v9/records/{source}")
def v9_records(
    source: str,
    filter: str = "all",
    period: str = "FY",
    q: str = "",
    status: str = "",
    date_from: str = "",
    date_to: str = "",
    sort: str = "",
    dir: str = "desc",
    page: int = 1,
    page_size: int = 25,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    """Paginated records behind a KPI card, chart element or table row; same filters as the board metrics."""
    if source not in _v9.SOURCES:
        raise HTTPException(404, f"Unknown source: {source}")
    ctx = _v9_ctx(db, cu, period)
    need = V9_SOURCE_PERMISSIONS.get(source)
    if need and not ctx.can(need) and not (source == "leads" and ctx.can("dashboard.view")):
        raise HTTPException(403, "Dashboard access permission required")
    try:
        return _v9.records(ctx, source, filter, q.strip(), status, date_from, date_to, sort, dir, page, page_size)
    except KeyError:
        raise HTTPException(400, f"Unknown filter: {filter}")


class FunnelNudgeIn(BaseModel):
    k: str
    id: int


_NUDGE = {"leads": ("leads", "Lead", "/leads/{id}"), "opps": ("opportunities", "Deal", "/opportunities/{id}"),
          "tenders": ("tenders", "Bid", "/tenders/{id}"), "quotes": ("quotations", "Quote", "/quotations/{id}")}


@router.post("/v9/funnel/nudge")
def v9_funnel_nudge(body: FunnelNudgeIn, db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    """Funnel › Stuck beyond SLA › Nudge: an in-app notification to the record's owner asking them to move it forward.
    Only records in the caller's own funnel (their permissions and data visibility) can be nudged."""
    if body.k not in _NUDGE:
        raise HTTPException(400, "Unknown record type")
    ctx = _v9_ctx(db, cu, "FY")
    from app.services.dashboard_funnel import board_funnel
    row = next((r for r in board_funnel(ctx)["rows"] if r["k"] == body.k and r["id"] == body.id), None)
    if row is None:
        raise HTTPException(404, "Record not found in your funnel")
    if not row.get("owner_id"):
        raise HTTPException(422, "This record has no owner to remind")
    module, kind, url = _NUDGE[body.k]
    from app.services.notification_service import upsert_notification
    when = f" for {row['age']} days (SLA {row['sla']} d)" if row.get("age") is not None and row.get("sla") else ""
    upsert_notification(db, int(row["owner_id"]), f"Follow-up needed: {row['ref'] or row['name']}",
                        f"{cu.full_name or cu.username} asked you to move {kind.lower()} {row['ref'] or row['name']} forward – it has been at “{row['stage']}”{when}.",
                        module=module, record_id=int(row["id"]), action="funnel_nudge", action_url=url.format(id=row["id"]), send_email=False)
    db.commit()
    return {"sent": True, "to": row.get("owner")}


@router.get("/v9/{board}")
def v9_board(board: str, period: str = "FY", fresh: bool = False, db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    """One dashboard's KPIs and chart data. Cached for 60 s per user, board and period; ?fresh=1 bypasses the cache."""
    if board not in _v9.BOARDS:
        raise HTTPException(404, f"Unknown dashboard: {board}")
    ctx = _v9_ctx(db, cu, period)
    if not ctx.can(V9_BOARD_PERMISSIONS[board]):
        raise HTTPException(403, "You don't have permission to view this dashboard")
    key = _v9_cache_key(db, cu, board, ctx.period)
    if not fresh:
        hit = cache_get_json(key, "dashboard_v9")
        if hit is not None:
            return hit
    data = jsonable_encoder({**_v9.BOARDS[board](ctx), "period": ctx.period, "from": ctx.d_from, "to": ctx.d_to, "generated_at": now_ist()})
    cache_set_json(key, data, V9_CACHE_SECONDS)
    return data


# Custom dashboards (prototype "Save as my dashboard" / "New dashboard"). Stored per tenant database, so a layout can
# never reach another tenant; sharing is limited to users, roles or everyone in the same tenant, and every viewer
# still sees only the data their own permissions and data visibility allow.
class LayoutWidget(BaseModel):
    id: str
    s: int = 1


class LayoutIn(BaseModel):
    name: str
    widgets: list[LayoutWidget] = []


class LayoutPatch(BaseModel):
    name: Optional[str] = None
    widgets: Optional[list[LayoutWidget]] = None


class LayoutShare(BaseModel):
    scope: str = "private"           # private | users | roles | tenant
    user_ids: list[int] = []
    roles: list[str] = []


def _layout_row(r, cu: User) -> dict:
    users = json.loads(r.shared_user_ids or "[]")
    roles = json.loads(r.shared_roles or "[]")
    return {"id": r.id, "name": r.name, "widgets": json.loads(r.widgets or "[]"), "owner_id": r.owner_user_id, "mine": int(r.owner_user_id) == int(cu.id),
            "share": {"scope": r.share_scope, "user_ids": users, "roles": roles}, "updated_at": _v9._iso(r.updated_at)}


def _layout_visible(r, cu: User) -> bool:
    if int(r.owner_user_id) == int(cu.id) or r.share_scope == "tenant":
        return True
    if r.share_scope == "users":
        return int(cu.id) in [int(x) for x in json.loads(r.shared_user_ids or "[]")]
    if r.share_scope == "roles":
        return (cu.role or "") in json.loads(r.shared_roles or "[]")
    return False


def _layout_widgets(widgets: list[LayoutWidget]) -> str:
    clean = [{"id": w.id[:30], "s": max(1, min(3, int(w.s)))} for w in widgets[:40]]
    return json.dumps(clean)


def _layout_get(db: Session, layout_id: int):
    r = db.execute(sa_text("SELECT * FROM dashboard_layouts WHERE id = :id"), {"id": layout_id}).fetchone()
    if not r:
        raise HTTPException(404, "Dashboard not found")
    return r


def _layout_own(db: Session, cu: User, layout_id: int):
    r = _layout_get(db, layout_id)
    if int(r.owner_user_id) != int(cu.id):
        raise HTTPException(403, "Only the owner can change this dashboard")
    return r


@router.get("/layouts")
def list_layouts(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    _v9_ctx(db, cu, "FY")
    rows = db.execute(sa_text("SELECT * FROM dashboard_layouts WHERE owner_user_id = :me OR share_scope <> 'private' ORDER BY id"), {"me": cu.id}).fetchall()
    visible = [_layout_row(r, cu) for r in rows if _layout_visible(r, cu)]
    owners = {u.id: (u.full_name or u.username) for u in db.query(User.id, User.full_name, User.username).filter(User.id.in_({x["owner_id"] for x in visible} or {0})).all()}
    for x in visible:
        x["owner"] = owners.get(x["owner_id"])
    return visible


@router.post("/layouts", status_code=201)
def create_layout(data: LayoutIn, db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    _v9_ctx(db, cu, "FY")
    name = data.name.strip()[:80] or "My dashboard"
    res = db.execute(sa_text("INSERT INTO dashboard_layouts (owner_user_id, name, widgets) VALUES (:o, :n, :w)"), {"o": cu.id, "n": name, "w": _layout_widgets(data.widgets)})
    db.commit()
    return _layout_row(_layout_get(db, res.lastrowid), cu)


@router.get("/layouts/{layout_id}")
def get_layout(layout_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    _v9_ctx(db, cu, "FY")
    r = _layout_get(db, layout_id)
    if not _layout_visible(r, cu):
        raise HTTPException(404, "Dashboard not found")
    return _layout_row(r, cu)


@router.put("/layouts/{layout_id}")
def update_layout(layout_id: int, data: LayoutPatch, db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    _v9_ctx(db, cu, "FY")
    _layout_own(db, cu, layout_id)
    if data.name is not None:
        db.execute(sa_text("UPDATE dashboard_layouts SET name = :n WHERE id = :id"), {"n": data.name.strip()[:80] or "Dashboard", "id": layout_id})
    if data.widgets is not None:
        db.execute(sa_text("UPDATE dashboard_layouts SET widgets = :w WHERE id = :id"), {"w": _layout_widgets(data.widgets), "id": layout_id})
    db.commit()
    return _layout_row(_layout_get(db, layout_id), cu)


@router.put("/layouts/{layout_id}/share")
def share_layout(layout_id: int, data: LayoutShare, db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    _v9_ctx(db, cu, "FY")
    _layout_own(db, cu, layout_id)
    if data.scope not in ("private", "users", "roles", "tenant"):
        raise HTTPException(400, "Invalid share scope")
    user_ids = sorted({int(u) for u in data.user_ids})
    if user_ids:
        known = {int(r[0]) for r in db.query(User.id).filter(User.id.in_(user_ids), User.is_active == True).all()}
        user_ids = [u for u in user_ids if u in known]
    roles = sorted({str(r)[:50] for r in data.roles if r})
    db.execute(sa_text("UPDATE dashboard_layouts SET share_scope = :s, shared_user_ids = :u, shared_roles = :r WHERE id = :id"),
               {"s": data.scope, "u": json.dumps(user_ids), "r": json.dumps(roles), "id": layout_id})
    db.commit()
    return _layout_row(_layout_get(db, layout_id), cu)


@router.delete("/layouts/{layout_id}", status_code=204)
def delete_layout(layout_id: int, db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    _v9_ctx(db, cu, "FY")
    _layout_own(db, cu, layout_id)
    db.execute(sa_text("DELETE FROM dashboard_layouts WHERE id = :id"), {"id": layout_id})
    db.commit()
