"""
KAM 360 Router — Full rebuild with enhanced 360 dashboard.

New endpoints:
  POST /kam/targets               — set activity + sales targets for hierarchy scope
  GET  /kam/targets/summary       — target summary for a user/period
  GET  /kam/360-summary           — top-level summary cards (customers, acts, leads, tenders, WOs)
  GET  /kam/customer-activities   — per-customer activity breakdown with lead/tender/WO counts
  GET  /kam/team-360              — per-member summary for hierarchy scope
"""

import json, logging, calendar, os
from collections import Counter, defaultdict
from datetime import date, datetime, timezone, time
from app.core.timezone import now_ist, today_ist
from decimal import Decimal
from typing import Optional, List, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile, File
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session
from sqlalchemy import func, or_, and_, text as sa_text
from pydantic import BaseModel, field_validator

from app.dependencies import get_tenant_db, get_current_user, require_permission
from app.models.all_models import (
    KAMActivity, KAMTarget, KAMGroupTarget, KAMTravelExpense, KAMTaskAssignment,
    KAMLeadLink, KAMWorkOrder, User, Customer, ActivityLog, WorkOrder,
    TravelRequest, SalesCustomerAssignment, Lead, Tender, Quotation,
    Group, Role, UserReportingHierarchy, OrgTreeNode, CustomerContact,
    VerticalSector, LeadSource,
    KAMActivityExecutionCycle,
    KAMLog,
)
from app.services.kam_activity_audit_service import (
    log_kam_activity, complete_activity_cycle, get_latest_reopen_info,
)
from app.services.travel_approval_service import submit_travel_request_with_policy
from app.core.config import settings
from app.utils.file_storage import media_slug_from_request, save_upload_optimized
from app.services.kam_weekly_plan_service import (
    WeeklyPlanTokenError,
    send_weekly_plan_ceo_report_if_due,
    send_weekly_plan_escalations,
    send_weekly_plan_reminders_from_token,
    weekly_plan_report_status,
)
from app.utils.data_scope import get_module_data_scope, get_team_user_ids

logger = logging.getLogger(__name__)
router = APIRouter()

ACTIVITY_TYPES = ["Phone Call","Video Call","In Person Meet","Demo","Site Visit","Follow Up","Email"]
# DB_ACTIVITY_TYPES = ["Daily Call","Meeting","Demo","Site Visit","Follow up","Email","Presentation","Proposal","Task"]
TRAVEL_MODES   = ["Own Vehicle","Company Vehicle","Train","Bus","Auto/Cab"]

FOLLOWUP_CATEGORIES = {
    "Technical":    ["Product Demo","PoC Support","Spec Clarification","Installation Support"],
    "Commercial":   ["Price Negotiation","Payment Follow-up","Order Confirmation","Quotation Review"],
    "Tender":       ["Tender Submission","Bid Clarification","Rate Revision","L1 Negotiation"],
    "Support":      ["AMC Renewal","Complaint Resolution","Escalation","SLA Review"],
    "Relationship": ["Executive Visit","Review Meeting","Reference Request","Event Invite"],
}

CANCELLATION_REASONS = [
    "Customer unavailable","Customer rescheduled","Internal priority change",
    "Travel issue","Technical issue","Customer cancelled","Weather / force majeure","Other",
]

KAM_DOCUMENT_EXTENSIONS = {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".jpg", ".jpeg", ".png", ".webp"}


# --- Utils --------------------------------------------------------------------

def _save_kam_document(request: Request, file: UploadFile, contents: bytes) -> tuple[str, int]:
    ext = os.path.splitext(file.filename or "")[-1].lower()
    if ext not in KAM_DOCUMENT_EXTENSIONS:
        raise HTTPException(400, f"File type '{ext}' not allowed.")
    saved = save_upload_optimized(
        root_dir=os.path.abspath(settings.MEDIA_ROOT),
        subfolder="kam_activities",
        original_filename=file.filename,
        contents=contents,
        media_slug=media_slug_from_request(request),
        content_type=file.content_type,
    )
    return saved.url, saved.size_kb


def _none(v):
    return None if v is None or (isinstance(v, str) and not v.strip()) else v


def _get_tenant_id(request: Request) -> Optional[int]:
    tenant = getattr(request.state, "tenant", None)
    tenant_id = getattr(tenant, "id", None)
    return int(tenant_id) if isinstance(tenant_id, int) else tenant_id

def _safe_get(obj, field, default=None):
    try:
        v = getattr(obj, field, default)
        return default if v is None else v
    except Exception:
        return default

def _normalize_activity_type(value):
    value = (value or "Phone Call").strip()
    if value not in ACTIVITY_TYPES:
        raise HTTPException(400, f"Invalid activity_type: {value}")
    return value

def _activity_mode_for_type(value, current=None):
    if value == "Video Call":
        return "Video Call"
    if value in ("In Person Meet", "Meeting", "Site Visit", "Demo"):
        return "In Person Meet"
    if value == "Email":
        return "Email"
    if value in ("Phone Call", "Daily Call"):
        return "Phone Call"
    if value in ("Follow Up", "Follow-up"):
        return "Follow Up"
    return current or "Phone Call"

def _activity_type_name(activity_type, mode=None):
    return activity_type or "Phone Call"

def _contacts_to_db(c): return json.dumps(c) if c and not isinstance(c, str) else (c or None)
def _contacts_from_db(raw):
    if not raw: return []
    if isinstance(raw, list): return raw
    try: return json.loads(raw)
    except: return []

def _valid_cols(model): return {c.name for c in model.__table__.columns}

def _tr_num(db):
    n = db.query(func.count(TravelRequest.id)).scalar() or 0
    return f"TR-{now_ist().strftime('%Y%m')}-{n+1:04d}"

def _period_range(period):
    y, m = int(period[:4]), int(period[5:7])
    return f"{period}-01", f"{period}-{calendar.monthrange(y,m)[1]:02d}"

def _quarter_range(year, q):
    sm = (q-1)*3+1; em = sm+2
    return f"{year}-{sm:02d}-01", f"{year}-{em:02d}-{calendar.monthrange(year,em)[1]:02d}"

def _resolve_360_window(period: Optional[str]=None, view_type: Optional[str]=None,
                        year: Optional[int]=None, date_from: Optional[str]=None,
                        date_to: Optional[str]=None):
    if date_from and date_to:
        cy = year or int(str(date_from)[:4])
        return str(date_from), str(date_to), cy, view_type == "yearly"
    if not period:
        period = now_ist().strftime("%Y-%m")
    cy = year or int(str(period)[:4])
    is_yearly = (view_type == "yearly")
    d_from, d_to = (f"{cy}-01-01", f"{cy}-12-31") if is_yearly else _period_range(period)
    return d_from, d_to, cy, is_yearly

def _target_periods_for_window(d_from: str, d_to: str) -> list[str]:
    start = date.fromisoformat(str(d_from))
    end = date.fromisoformat(str(d_to))
    periods = []
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        periods.append(f"{y}-{m:02d}")
        m += 1
        if m > 12:
            y += 1
            m = 1
    return periods

def _target_rows_for_window(db: Session, user_ids: list[int], d_from: str, d_to: str):
    uids = [int(uid) for uid in (user_ids or []) if uid]
    if not uids:
        return []
    start = date.fromisoformat(str(d_from))
    end = date.fromisoformat(str(d_to))
    monthly_periods = _target_periods_for_window(d_from, d_to)

    yearly_rows = []
    yearly_user_ids: set[int] = set()
    if start.month == 1 and start.day == 1 and end.month == 12 and end.day == 31 and start.year == end.year:
        yearly_rows = db.query(KAMTarget).filter(
            KAMTarget.user_id.in_(uids),
            KAMTarget.period == str(start.year),
        ).all()
        yearly_user_ids = {int(t.user_id) for t in yearly_rows if t.user_id}

    remaining_uids = [uid for uid in uids if uid not in yearly_user_ids]
    monthly_rows = []
    if remaining_uids and monthly_periods:
        monthly_rows = db.query(KAMTarget).filter(
            KAMTarget.user_id.in_(remaining_uids),
            KAMTarget.period.in_(monthly_periods),
        ).all()
    return [*yearly_rows, *monthly_rows]

def _customer_window(period: Optional[str]=None, view_type: Optional[str]=None, year: Optional[int]=None):
    if not period and not year:
        return None, None
    raw_period = str(period or year or "")
    cy = int(year or raw_period[:4])
    is_yearly = (view_type == "yearly") or len(raw_period) == 4
    if is_yearly:
        return f"{cy}-01-01", f"{cy}-12-31"
    return _period_range(raw_period)


# --- Role / visibility --------------------------------------------------------

def _parse_user_group_ids(raw):
    ids = []
    for part in str(raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            ids.append(int(part))
        except ValueError:
            continue
    return ids

def _role_level(role, db):
    role_name = str(role or "").strip().lower()
    if not role_name:
        return None
    row = db.query(Role).filter(func.lower(Role.name) == role_name, Role.is_active == True).first()
    return int(row.level) if row and row.level is not None else None

def _active_user_ids(db):
    return [int(r.id) for r in db.query(User.id).filter(User.is_active == True).all()]

def _users_in_groups(group_ids, db):
    group_ids = {int(gid) for gid in group_ids if gid}
    if not group_ids:
        return []
    users = []
    for user in db.query(User).filter(User.is_active == True).all():
        if group_ids.intersection(_parse_user_group_ids(user.group_id)):
            users.append(user)
    return users

def _group_ids_for_user(user, db):
    if not user:
        return set()
    uid = int(user.id)
    group_ids = set(_parse_user_group_ids(getattr(user, "group_id", None)))
    group_ids.update(int(r.id) for r in db.query(Group.id).filter(Group.manager_id == uid, Group.is_active == True).all())
    group_ids.update(int(r.group_id) for r in db.query(UserReportingHierarchy.group_id).filter(
        UserReportingHierarchy.is_active == True,
        UserReportingHierarchy.group_id.isnot(None),
        or_(
            UserReportingHierarchy.reporting_user_id == uid,
            UserReportingHierarchy.parent_user_id == uid,
        ),
    ).all())
    return group_ids

def _descendant_hierarchy_user_ids(rows, user_id):
    children = {}
    for row in rows:
        if row.parent_user_id and row.reporting_user_id:
            children.setdefault(int(row.parent_user_id), set()).add(int(row.reporting_user_id))

    result = {int(user_id)}
    queue = [int(user_id)]
    while queue:
        parent_id = queue.pop(0)
        for child_id in children.get(parent_id, set()):
            if child_id in result:
                continue
            result.add(child_id)
            queue.append(child_id)
    return result

def _add_direct_report_tree(uid_set, db):
    queue = list(uid_set)
    seen = set()
    while queue:
        manager_id = queue.pop(0)
        if manager_id in seen:
            continue
        seen.add(manager_id)
        for user in db.query(User).filter(User.reporting_manager_id == manager_id, User.is_active == True).all():
            child_id = int(user.id)
            if child_id not in uid_set:
                uid_set.add(child_id)
                queue.append(child_id)

def _normalized_role(role):
    normalized = str(role or "").strip().lower().replace("-", "_").replace(" ", "_")
    return {
        "sales_executive": "sales",
        "salesexecutive": "sales",
        "sales_head": "manager",
        "saleshead": "manager",
    }.get(normalized, normalized)

_NON_KAM_ROLE_KEYS = {
    "ceo", "admin", "super_admin", "accounts", "account", "accountant", "finance",
    "purchase", "purchases", "procurement",
    "call_coordinator", "call_co_ordinator", "call_center", "telecaller", "tele_calling",
    "tender", "tenders", "tender_team", "tendering", "tender_executive", "tender_manager",
    "support", "service", "project_lead",
}

def _is_kam_sales_role(role) -> bool:
    return _normalized_role(role) not in _NON_KAM_ROLE_KEYS

def _user_group_ids(user):
    return set(_parse_user_group_ids(getattr(user, "group_id", None)))

def _get_org_tree_user_ids(db, user_id: int) -> list[int]:
    """Return all user IDs visible to user_id based on the Group Fixing tree (OrgTreeNode)."""
    user_ids: set[int] = {int(user_id)}
    pending = [int(user_id)]
    while pending:
        current_id = pending.pop(0)
        rows = db.query(OrgTreeNode).filter(
            OrgTreeNode.is_active == True,
            OrgTreeNode.user_id.isnot(None),
            or_(
                OrgTreeNode.parent_user_id == current_id,
                OrgTreeNode.group_lead_id == current_id,
            ),
        ).all()
        for row in rows:
            uid = int(row.user_id)
            if uid not in user_ids:
                user_ids.add(uid)
                pending.append(uid)
    return sorted(user_ids)


def _hierarchy_scope_uids(cu, db):
    """Return visible user IDs for KAM activities based on data_scope.

    Reads RolePermission.data_scope for the "kam" module:
      "all"  → all active users
      "none" → empty list
      "own"  → [cu.id]
      "team" → OrgTreeNode subtree under cu
    """
    if not cu:
        return []

    scope = get_module_data_scope(db, cu, "kam")

    if scope == "all":
        return _active_user_ids(db)

    if scope == "none":
        return []

    if scope == "own":
        return [int(cu.id)]

    # "team"
    return get_team_user_ids(db, int(cu.id))

def _get_team_uids(cu, db):
    return _hierarchy_scope_uids(cu, db)

def _kam_scope_is_all(cu, db) -> bool:
    """True when the role's configured KAM Data Visibility is "all"."""
    return bool(cu) and get_module_data_scope(db, cu, "kam") == "all"

def _get_visible_uids(cu, db, requested_uid=None):
    uids = _get_team_uids(cu, db)
    if requested_uid:
        if requested_uid in uids: return [requested_uid]
        raise HTTPException(403, "Not authorised")
    return uids

def _get_team_performance_uids(cu, db):
    return _hierarchy_scope_uids(cu, db)

def _target_baseline_scope_uids(cu, db):
    scope_uids = [int(uid) for uid in (_get_team_uids(cu, db) or []) if uid]
    if not scope_uids and getattr(cu, "id", None) and get_module_data_scope(db, cu, "kam") != "none":
        scope_uids = [int(cu.id)]
    if not scope_uids:
        return []
    rows = db.query(User.id, User.role).filter(
        User.id.in_(scope_uids),
        User.is_active == True,
    ).all()
    kam_scope_uids = [int(row.id) for row in rows if _is_kam_sales_role(row.role)]
    return kam_scope_uids or scope_uids


def _get_subtree_org_nodes(db: Session, root_id: int) -> list[OrgTreeNode]:
    """Return active Group Fixing nodes under root, including root."""
    all_nodes = (
        db.query(OrgTreeNode)
        .filter(OrgTreeNode.is_active == True)
        .order_by(OrgTreeNode.position.asc(), OrgTreeNode.id.asc())
        .all()
    )
    node_by_id = {
        int(node.id): node
        for node in all_nodes
        if getattr(node, "id", None)
    }
    children_by_parent: dict[int, list[OrgTreeNode]] = defaultdict(list)
    for node in all_nodes:
        if getattr(node, "parent_id", None):
            children_by_parent[int(node.parent_id)].append(node)
    result: list[OrgTreeNode] = []
    queue = [int(root_id)]
    seen: set[int] = set()
    while queue:
        node_id = queue.pop(0)
        if node_id in seen:
            continue
        seen.add(node_id)
        node = node_by_id.get(node_id)
        if not node:
            continue
        result.append(node)
        queue.extend(
            int(child.id)
            for child in children_by_parent.get(int(node.id), [])
            if getattr(child, "id", None)
        )
    return result


def _group_fixing_payload(db: Session) -> tuple[list[dict[str, Any]], dict[int, dict[str, Any]]]:
    """Build KAM-ready group data from Group Fixing (org_tree_nodes).

    The KAM advanced tree expects a flat group list plus per-user group IDs.
    Group Fixing L2 nodes are the source of truth for group names and hierarchy.
    """
    group_nodes = db.query(OrgTreeNode).filter(
        OrgTreeNode.is_active == True,
        OrgTreeNode.level == 2,
    ).order_by(OrgTreeNode.position.asc(), OrgTreeNode.id.asc()).all()

    if not group_nodes:
        return [], {}

    user_ids = {
        int(uid)
        for node in group_nodes
        for uid in (getattr(node, "user_id", None), getattr(node, "group_lead_id", None))
        if uid
    }
    for group_node in group_nodes:
        for node in _get_subtree_org_nodes(db, int(group_node.id)):
            for uid in (getattr(node, "user_id", None), getattr(node, "group_lead_id", None), getattr(node, "parent_user_id", None)):
                if uid:
                    user_ids.add(int(uid))

    users = db.query(User).filter(User.id.in_(user_ids)).all() if user_ids else []
    user_map = {int(u.id): u for u in users}

    def _user_name(user_id: Optional[int]) -> str:
        u = user_map.get(int(user_id)) if user_id else None
        return (getattr(u, "full_name", None) or getattr(u, "username", None) or "") if u else ""

    groups: list[dict[str, Any]] = []
    by_user: dict[int, dict[str, Any]] = {}
    group_master_by_name: dict[str, dict[str, Any]] = {}
    group_master_by_manager: dict[int, dict[str, Any]] = {}
    try:
        for group_row in db.query(Group).filter(Group.is_active == True).all():
            name_key = str(getattr(group_row, "name", "") or "").strip().lower()
            meta = {
                "color": getattr(group_row, "color", None) or "violet",
                "icon": getattr(group_row, "icon", None) or "zap",
            }
            if name_key:
                group_master_by_name[name_key] = meta
            manager_id = getattr(group_row, "manager_id", None)
            if manager_id:
                group_master_by_manager[int(manager_id)] = meta
    except Exception:
        group_master_by_name = {}
        group_master_by_manager = {}

    for index, group_node in enumerate(group_nodes):
        nodes = _get_subtree_org_nodes(db, int(group_node.id))
        group_name = (
            getattr(group_node, "group_name", None)
            or _user_name(getattr(group_node, "group_lead_id", None))
            or _user_name(getattr(group_node, "user_id", None))
            or f"Group {group_node.id}"
        )
        manager_id = getattr(group_node, "group_lead_id", None) or getattr(group_node, "user_id", None)
        group_master = (
            group_master_by_name.get(str(group_name or "").strip().lower())
            or group_master_by_manager.get(int(manager_id or 0))
            or {}
        )
        members: list[dict[str, Any]] = []
        hierarchy_by_level: dict[int, list[dict[str, Any]]] = {}

        for node in nodes:
            uid = getattr(node, "user_id", None)
            if not uid:
                continue
            user = user_map.get(int(uid))
            if not user or not getattr(user, "is_active", True):
                continue
            parent_user_id = getattr(node, "parent_user_id", None)
            item = {
                "node_id": node.id,
                "id": user.id,
                "user_id": user.id,
                "name": user.full_name or user.username or f"User #{user.id}",
                "role": user.role,
                "email": user.email,
                "level": node.level,
                "parent_user_id": parent_user_id,
                "is_group_lead": int(user.id) == int(manager_id or 0),
            }
            members.append(item)
            hierarchy_by_level.setdefault(int(node.level or 0), []).append(item)
            user_info = by_user.setdefault(int(user.id), {
                "group_ids": [],
                "group_names": [],
                "parent_user_id": parent_user_id,
            })
            if int(group_node.id) not in user_info["group_ids"]:
                user_info["group_ids"].append(int(group_node.id))
                user_info["group_names"].append(group_name)
            if parent_user_id:
                user_info["parent_user_id"] = parent_user_id

        groups.append({
            "id": int(group_node.id),
            "idx": index,
            "name": group_name,
            "group_name": group_name,
            "manager_id": int(manager_id) if manager_id else None,
            "manager_name": _user_name(manager_id),
            "color": group_master.get("color") or "violet",
            "icon": group_master.get("icon") or "zap",
            "member_count": len(members),
            "members": members,
            "reporting_hierarchy": [
                {
                    "level": level,
                    "level_label": f"L{level}",
                    "user_count": len(rows),
                    "users": rows,
                }
                for level, rows in sorted(hierarchy_by_level.items())
            ],
            "source": "group_fixing",
        })

    return groups, by_user


def _master_group_payload(db: Session) -> tuple[list[dict[str, Any]], dict[int, dict[str, Any]]]:
    """Build KAM group data from Masters → Groups and user group membership."""
    group_rows = (
        db.query(Group)
        .filter(Group.is_active == True)
        .order_by(Group.name.asc(), Group.id.asc())
        .all()
    )
    users = db.query(User).filter(User.is_active == True).all()
    users_by_group: dict[int, list[User]] = defaultdict(list)
    user_map = {int(user.id): user for user in users}

    for user in users:
        for group_id in _parse_user_group_ids(getattr(user, "group_id", None)):
            users_by_group[int(group_id)].append(user)

    groups: list[dict[str, Any]] = []
    by_user: dict[int, dict[str, Any]] = {}
    for index, group in enumerate(group_rows):
        group_id = int(group.id)
        group_name = str(group.name or f"Group {group_id}").strip()
        members = []
        for user in users_by_group.get(group_id, []):
            members.append({
                "id": user.id,
                "user_id": user.id,
                "name": user.full_name or user.username or f"User #{user.id}",
                "user_name": user.full_name or user.username or f"User #{user.id}",
                "role": user.role,
                "email": user.email,
                "is_group_lead": int(user.id) == int(group.manager_id or 0),
            })
            user_info = by_user.setdefault(int(user.id), {"group_ids": [], "group_names": []})
            user_info["group_ids"].append(group_id)
            user_info["group_names"].append(group_name)

        manager = user_map.get(int(group.manager_id)) if group.manager_id else None
        groups.append({
            "id": group_id,
            "idx": index,
            "name": group_name,
            "group_name": group_name,
            "manager_id": int(group.manager_id) if group.manager_id else None,
            "manager_name": (manager.full_name or manager.username or "") if manager else "",
            "color": group.color or "violet",
            "icon": group.icon or "zap",
            "member_count": len(members),
            "members": members,
            "source": "master_groups",
        })

    return groups, by_user

def _resolve_scoped_user_id(cu, db, requested_uid=None, action="use"):
    if not requested_uid or int(requested_uid) == int(cu.id):
        return int(cu.id)
    team_uids = _get_team_uids(cu, db)
    if int(requested_uid) not in team_uids:
        raise HTTPException(403, f"Cannot {action} this user")
    return int(requested_uid)


# --- Customer helpers ---------------------------------------------------------

def _customer_ids_for_uids(uids, db):
    scoped_uids = [int(uid) for uid in (uids or []) if uid]
    if not scoped_uids:
        return set()

    assignment_customer_ids = {
        int(row.customer_id)
        for row in db.query(SalesCustomerAssignment.customer_id).filter(
            SalesCustomerAssignment.user_id.in_(scoped_uids),
            SalesCustomerAssignment.is_active == True,
        ).all()
        if row.customer_id
    }

    all_assignment_customer_ids = {
        int(row.customer_id)
        for row in db.query(SalesCustomerAssignment.customer_id).filter(
            SalesCustomerAssignment.is_active == True,
        ).all()
        if row.customer_id
    }

    fallback_query = db.query(Customer.id).filter(
        Customer.is_deleted == False,
        Customer.assigned_to.in_(scoped_uids),
    )
    if all_assignment_customer_ids:
        fallback_query = fallback_query.filter(Customer.id.notin_(all_assignment_customer_ids))

    fallback_customer_ids = {
        int(row.id)
        for row in fallback_query.all()
        if row.id
    }

    candidate_customer_ids = assignment_customer_ids | fallback_customer_ids
    if not candidate_customer_ids:
        return set()

    return {
        int(row.id)
        for row in db.query(Customer.id).filter(
            Customer.id.in_(candidate_customer_ids),
            Customer.is_deleted == False,
        ).all()
        if row.id
    }


def _customer_signal_maps(customer_ids, db, scoped_uids=None, d_from: Optional[str]=None, d_to: Optional[str]=None):
    cids = [int(cid) for cid in (customer_ids or []) if cid]
    if not cids:
        return {
            "lead_value": {}, "lead_count": {},
            "opportunity_value": {}, "opportunity_count": {},
            "tender_value": {}, "tender_count": {},
            "work_order_value": {}, "work_order_count": {},
            "won_value": {}, "won_count": {},
            "activity_count": {}, "completed_activity_count": {},
            "pending_activity_count": {}, "last_activity_date": {}, "last_activity_type": {},
        }

    scoped_uid_list = [int(uid) for uid in (scoped_uids or []) if uid]
    start_date = end_date = None
    start_dt = end_dt = None
    if d_from and d_to:
        start_date = date.fromisoformat(str(d_from))
        end_date = date.fromisoformat(str(d_to))
        start_dt = datetime.combine(start_date, datetime.min.time())
        end_dt = datetime.combine(end_date, datetime.max.time())

    lead_value_map: dict = {}
    lead_count_map: dict = {}
    opportunity_value_map: dict = {}
    opportunity_count_map: dict = {}
    tender_value_map: dict = {}
    tender_count_map: dict = {}
    work_order_value_map: dict = {}
    work_order_count_map: dict = {}
    won_value_map: dict = {}
    won_count_map: dict = {}
    activity_count_map: dict = {}
    completed_activity_count_map: dict = {}
    pending_activity_count_map: dict = {}
    last_activity_date_map: dict = {}
    last_activity_type_map: dict = {}

    def _normalize_activity_date(raw_value):
        if raw_value is None:
            return None
        if isinstance(raw_value, datetime):
            return raw_value.date().isoformat()
        if isinstance(raw_value, date):
            return raw_value.isoformat()
        raw = str(raw_value).strip()
        return raw[:10] if raw else None

    def _remember_last_activity(customer_id, raw_value, source_label: str):
        normalized = _normalize_activity_date(raw_value)
        if not normalized:
            return
        current = str(last_activity_date_map.get(customer_id) or "")
        if normalized > current:
            last_activity_date_map[customer_id] = normalized
            last_activity_type_map[customer_id] = source_label

    lead_q = db.query(
        Lead.customer_id,
        func.count(Lead.id),
        func.sum(Lead.est_value),
    ).filter(
        Lead.customer_id.in_(cids),
        Lead.is_deleted == False,
        or_(Lead.lead_type.is_(None), Lead.lead_type != "direct_opportunity"),
        Lead.status.notin_(['Converted', 'Lost']),
    )
    if scoped_uid_list:
        lead_q = lead_q.filter(Lead.assigned_to.in_(scoped_uid_list))
    if start_dt and end_dt:
        lead_q = lead_q.filter(func.coalesce(Lead.lead_created_at, Lead.created_at).between(start_dt, end_dt))
    for cid, cnt, sv in lead_q.group_by(Lead.customer_id).all():
        lead_count_map[int(cid)] = int(cnt or 0)
        lead_value_map[int(cid)] = float(sv or 0)

    opportunity_q = db.query(
        Lead.customer_id,
        func.count(Lead.id),
        func.sum(Lead.est_value),
    ).filter(
        Lead.customer_id.in_(cids),
        Lead.is_deleted == False,
        or_(
            Lead.lead_type == "direct_opportunity",
            Lead.status.in_(["Opportunity Created", "Converted"]),
        ),
    )
    if scoped_uid_list:
        opportunity_q = opportunity_q.filter(Lead.assigned_to.in_(scoped_uid_list))
    if start_dt and end_dt:
        opportunity_q = opportunity_q.filter(func.coalesce(Lead.lead_created_at, Lead.created_at).between(start_dt, end_dt))
    for cid, cnt, sv in opportunity_q.group_by(Lead.customer_id).all():
        opportunity_count_map[int(cid)] = int(cnt or 0)
        opportunity_value_map[int(cid)] = float(sv or 0)
    lead_last_q = db.query(
        Lead.customer_id,
        Lead.lead_created_at,
        Lead.created_at,
    ).filter(
        Lead.customer_id.in_(cids),
        Lead.is_deleted == False,
    )
    if scoped_uid_list:
        lead_last_q = lead_last_q.filter(Lead.assigned_to.in_(scoped_uid_list))
    if start_dt and end_dt:
        lead_last_q = lead_last_q.filter(func.coalesce(Lead.lead_created_at, Lead.created_at).between(start_dt, end_dt))
    for cid, lead_created_at, created_at in lead_last_q.all():
        if cid:
            _remember_last_activity(int(cid), lead_created_at or created_at, "Lead")

    tender_q = db.query(
        Tender.customer_id,
        func.count(Tender.id),
        func.sum(Tender.est_value),
    ).filter(
        Tender.customer_id.in_(cids),
        Tender.is_deleted == False,
        Tender.result.notin_(['Won', 'Lost']),
    )
    if scoped_uid_list:
        tender_q = tender_q.filter(Tender.assigned_to.in_(scoped_uid_list))
    if start_dt and end_dt:
        tender_q = tender_q.filter(Tender.created_at.between(start_dt, end_dt))
    for cid, cnt, sv in tender_q.group_by(Tender.customer_id).all():
        tender_count_map[int(cid)] = int(cnt or 0)
        tender_value_map[int(cid)] = float(sv or 0)

    workorder_customer_expr = func.coalesce(WorkOrder.customer_id, Tender.customer_id, Lead.customer_id)
    workorder_q = db.query(
        workorder_customer_expr.label("customer_id"),
        func.count(WorkOrder.id),
        func.sum(func.coalesce(WorkOrder.wo_value, WorkOrder.po_value, 0)),
    ).outerjoin(
        Tender, WorkOrder.tender_id == Tender.id
    ).outerjoin(
        Lead, WorkOrder.lead_id == Lead.id
    ).filter(
        workorder_customer_expr.in_(cids),
    )
    if scoped_uid_list:
        workorder_q = workorder_q.filter(or_(
            WorkOrder.created_by.in_(scoped_uid_list),
            WorkOrder.project_manager_id.in_(scoped_uid_list),
            Tender.assigned_to.in_(scoped_uid_list),
            Tender.created_by.in_(scoped_uid_list),
            Lead.assigned_to.in_(scoped_uid_list),
            Lead.created_by.in_(scoped_uid_list),
        ))
    if start_date and end_date and start_dt and end_dt:
        workorder_q = workorder_q.filter(or_(
            and_(WorkOrder.po_date.isnot(None), WorkOrder.po_date.between(start_date, end_date)),
            WorkOrder.created_at.between(start_dt, end_dt),
            and_(Tender.result_date.isnot(None), Tender.result_date.between(start_date, end_date)),
        ))
    for cid, cnt, sv in workorder_q.group_by(workorder_customer_expr).all():
        if cid:
            work_order_count_map[int(cid)] = int(cnt or 0)
            work_order_value_map[int(cid)] = float(sv or 0)

    won_q = db.query(
        Tender.customer_id,
        func.count(Tender.id),
        func.sum(Tender.bid_amount),
    ).filter(
        Tender.customer_id.in_(cids),
        Tender.is_deleted == False,
        Tender.result == 'Won',
    )
    if scoped_uid_list:
        won_q = won_q.filter(Tender.assigned_to.in_(scoped_uid_list))
    if start_date and end_date and start_dt and end_dt:
        won_q = won_q.filter(or_(
            and_(Tender.result_date.isnot(None), Tender.result_date.between(start_date, end_date)),
            and_(Tender.result_date.is_(None), Tender.created_at.between(start_dt, end_dt)),
        ))
    for cid, cnt, sv in won_q.group_by(Tender.customer_id).all():
        won_count_map[int(cid)] = int(cnt or 0)
        won_value_map[int(cid)] = float(sv or 0)

    tender_last_q = db.query(
        Tender.customer_id,
        Tender.result_date,
        Tender.submission_date,
        Tender.published_date,
        Tender.created_at,
    ).filter(
        Tender.customer_id.in_(cids),
        Tender.is_deleted == False,
    )
    if scoped_uid_list:
        tender_last_q = tender_last_q.filter(Tender.assigned_to.in_(scoped_uid_list))
    if start_date and end_date and start_dt and end_dt:
        tender_last_q = tender_last_q.filter(or_(
            and_(Tender.result_date.isnot(None), Tender.result_date.between(start_date, end_date)),
            and_(Tender.submission_date.isnot(None), Tender.submission_date.between(start_date, end_date)),
            and_(Tender.published_date.isnot(None), Tender.published_date.between(start_date, end_date)),
            Tender.created_at.between(start_dt, end_dt),
        ))
    for cid, result_date, submission_date, published_date, created_at in tender_last_q.all():
        if cid:
            _remember_last_activity(int(cid), result_date or submission_date or published_date or created_at, "Tender")

    act_q = db.query(
        KAMActivity.customer_id,
        KAMActivity.status,
        KAMActivity.activity_date,
    ).filter(
        KAMActivity.customer_id.in_(cids),
    )
    if scoped_uid_list:
        act_q = act_q.filter(KAMActivity.user_id.in_(scoped_uid_list))
    if d_from and d_to:
        act_q = act_q.filter(KAMActivity.activity_date.between(d_from, d_to))
    for cid, status, activity_date in act_q.all():
        if not cid:
            continue
        key = int(cid)
        activity_count_map[key] = activity_count_map.get(key, 0) + 1
        if status == "Completed":
            completed_activity_count_map[key] = completed_activity_count_map.get(key, 0) + 1
        if status in ("Planned", "In Progress"):
            pending_activity_count_map[key] = pending_activity_count_map.get(key, 0) + 1
        _remember_last_activity(key, activity_date, "KAM Activity")

    return {
        "lead_value": lead_value_map,
        "lead_count": lead_count_map,
        "opportunity_value": opportunity_value_map,
        "opportunity_count": opportunity_count_map,
        "tender_value": tender_value_map,
        "tender_count": tender_count_map,
        "work_order_value": work_order_value_map,
        "work_order_count": work_order_count_map,
        "won_value": won_value_map,
        "won_count": won_count_map,
        "activity_count": activity_count_map,
        "completed_activity_count": completed_activity_count_map,
        "pending_activity_count": pending_activity_count_map,
        "last_activity_date": last_activity_date_map,
        "last_activity_type": last_activity_type_map,
    }

def _enrich_customers_with_values(custs, db, scoped_uids=None, d_from: Optional[str]=None, d_to: Optional[str]=None):
    if not custs:
        return []
    cids = [c.id for c in custs]
    signal_maps = _customer_signal_maps(cids, db, scoped_uids=scoped_uids, d_from=d_from, d_to=d_to)

    # Batch-fetch active assignments → assigned user name
    assignment_rows = db.query(
        SalesCustomerAssignment.customer_id, User.full_name
    ).join(User, User.id == SalesCustomerAssignment.user_id).filter(
        SalesCustomerAssignment.customer_id.in_(cids),
        SalesCustomerAssignment.is_active == True,
        User.is_active == True,
    ).all()
    assigned_name_map: dict = {}
    for row in assignment_rows:
        if row.customer_id not in assigned_name_map:
            assigned_name_map[row.customer_id] = row.full_name

    # Batch-fetch primary contacts
    contact_rows = db.query(CustomerContact).filter(
        CustomerContact.customer_id.in_(cids),
        CustomerContact.is_active == True,
    ).order_by(CustomerContact.is_primary.desc()).all()
    contact_map: dict = {}
    for ct in contact_rows:
        if ct.customer_id not in contact_map or ct.is_primary:
            contact_map[ct.customer_id] = {
                "contact_name": ct.contact_name or "",
                "mobile": ct.mobile or "",
                "office_phone": ct.office_phone or "",
                "office_email": ct.office_email or "",
                "department": ct.department or "",
                "is_primary": bool(ct.is_primary),
            }

    return [
        {
            "id": c.id,
            "customer_name": c.customer_name,
            "city": c.billing_city,
            "billing_city": c.billing_city,
            "billing_state": c.billing_state,
            "state": c.billing_state or c.shipping_state,
            "shipping_city": c.shipping_city,
            "shipping_state": c.shipping_state,
            "vertical": c.customer_vertical,
            "customer_vertical": c.customer_vertical,
            "industry": c.industry,
            "division": c.division,
            "sub_segment": c.division,
            "customer_sub_segment": c.division,
            "group_name": c.group_name,
            "account_potential": c.account_potential,
            "assigned_to_name": assigned_name_map.get(c.id) or getattr(c, "assigned_to_name", None) or "",
            "contacts": [contact_map[c.id]] if c.id in contact_map else [],
            "status": c.account_status,
            "potential_value": float(c.potential_value or 0),
            "lead_value": signal_maps["lead_value"].get(c.id, 0),
            "lead_count": signal_maps["lead_count"].get(c.id, 0),
            "opportunity_value": signal_maps["opportunity_value"].get(c.id, 0),
            "opportunity_count": signal_maps["opportunity_count"].get(c.id, 0),
            "tender_value": signal_maps["tender_value"].get(c.id, 0),
            "tender_count": signal_maps["tender_count"].get(c.id, 0),
            "work_order_value": signal_maps["work_order_value"].get(c.id, 0),
            "work_order_count": signal_maps["work_order_count"].get(c.id, 0),
            "wo_value": signal_maps["work_order_value"].get(c.id, 0),
            "wo_count": signal_maps["work_order_count"].get(c.id, 0),
            "won_value": signal_maps["won_value"].get(c.id, 0),
            "won_count": signal_maps["won_count"].get(c.id, 0),
            "activity_count": signal_maps["activity_count"].get(c.id, 0),
            "completed_activity_count": signal_maps["completed_activity_count"].get(c.id, 0),
            "pending_activity_count": signal_maps["pending_activity_count"].get(c.id, 0),
            "last_activity_date": signal_maps["last_activity_date"].get(c.id),
            "last_activity_type": signal_maps["last_activity_type"].get(c.id),
        }
        for c in custs
    ]


def _get_customers_for_user(uid, role, db, d_from: Optional[str]=None, d_to: Optional[str]=None):
    # Match the Customers page: active SalesCustomerAssignment is the source of
    # truth; customers.assigned_to is only a fallback when no active assignment exists.
    u = db.query(User).filter(User.id == uid).first()
    scope_ids = _get_team_uids(u, db) if u else [uid]

    customer_ids = _customer_ids_for_uids(scope_ids, db)
    if not customer_ids:
        return []

    custs = db.query(Customer).filter(
        Customer.id.in_(customer_ids),
        Customer.is_deleted == False,
    ).order_by(Customer.customer_name.asc()).all()
    return _enrich_customers_with_values(custs, db, scoped_uids=scope_ids, d_from=d_from, d_to=d_to)

def _get_all_assignable_users(cu, db):
    uids = _get_team_uids(cu, db)
    can_reopen = _user_can_reopen_activities(cu, db)
    reopen_scope = set(_reopen_hierarchy_scope_uids(cu, db))
    current_uid = int(cu.id)
    return [
        {
            "id": u.id,
            "full_name": u.full_name,
            "role": u.role,
            "is_self": u.id == cu.id,
            "can_reopen_activities": bool(can_reopen and int(u.id) == current_uid),
            "reopen_scope_user": int(u.id) in reopen_scope,
        }
        for u in db.query(User).filter(User.id.in_(uids), User.is_active==True).all()
    ]

def _customer_count_for_uids(uids, db):
    return len(_customer_ids_for_uids(uids, db))


_ADMIN_ROLES  = {"admin", "ceo", "super_admin"}
_MANAGER_ROLES = {"manager", "vp"}

def _reopen_hierarchy_scope_uids(cu, db) -> list[int]:
    if not cu:
        return []
    uid = int(cu.id)
    if _normalized_role(getattr(cu, "role", None)) in _ADMIN_ROLES:
        return _active_user_ids(db)

    scope_ids: set[int] = {uid}
    scope_ids.update(get_team_user_ids(db, uid))
    _add_direct_report_tree(scope_ids, db)

    hierarchy_rows = db.query(UserReportingHierarchy).filter(
        UserReportingHierarchy.is_active == True,
        UserReportingHierarchy.parent_user_id.isnot(None),
        UserReportingHierarchy.reporting_user_id.isnot(None),
    ).all()
    scope_ids.update(_descendant_hierarchy_user_ids(hierarchy_rows, uid))

    active_ids = set(_active_user_ids(db))
    return sorted(scope_ids.intersection(active_ids))

def _user_can_reopen_activities(cu, db) -> bool:
    if not cu:
        return False
    role = _normalized_role(getattr(cu, "role", None))
    if role in _ADMIN_ROLES:
        return True
    uid = int(cu.id)
    return any(scope_uid != uid for scope_uid in _reopen_hierarchy_scope_uids(cu, db))

def _customer_count_page_match(user: User, db: Session) -> int:
    """Count customers exactly as the Customer list page does for this user."""
    role = (user.role or "").strip().lower().replace("-", "_").replace(" ", "_")
    role = {"sales_executive": "sales"}.get(role, role)

    if role in _ADMIN_ROLES:
        return db.query(Customer).filter(Customer.is_deleted == False).count()

    uid = int(user.id)
    if role in _MANAGER_ROLES:
        team_ids = [
            int(r.id)
            for r in db.query(User.id).filter(
                User.reporting_manager_id == uid,
                User.is_active == True,
            ).all()
        ]
        scope_ids = [uid, *team_ids]
    else:
        scope_ids = [uid]

    active_any = db.query(SalesCustomerAssignment.customer_id).filter(
        SalesCustomerAssignment.is_active == True,
    )
    scoped_assigned = db.query(SalesCustomerAssignment.customer_id).filter(
        SalesCustomerAssignment.is_active == True,
        SalesCustomerAssignment.user_id.in_(scope_ids),
    )

    return db.query(Customer).filter(
        Customer.is_deleted == False,
        or_(
            Customer.id.in_(scoped_assigned),
            and_(
                ~Customer.id.in_(active_any),
                Customer.assigned_to.in_(scope_ids),
            ),
        ),
    ).count()


# --- Enrich activity ----------------------------------------------------------

def _activity_context_maps(db: Session, rows: list[KAMActivity]):
    user_ids = {int(row.user_id) for row in rows if row.user_id}
    customer_ids = {int(row.customer_id) for row in rows if row.customer_id}
    lead_ids = {int(row.lead_id) for row in rows if row.lead_id}
    tender_ids = {int(row.tender_id) for row in rows if row.tender_id}
    travel_request_ids = {
        int(row.travel_request_id)
        for row in rows
        if _safe_get(row, "travel_request_id")
    }
    users = {
        int(user.id): user
        for user in db.query(User).filter(User.id.in_(user_ids)).all()
    } if user_ids else {}
    customers = {
        int(customer.id): customer
        for customer in db.query(Customer).filter(Customer.id.in_(customer_ids)).all()
    } if customer_ids else {}
    travel_requests = {
        int(tr.id): tr
        for tr in db.query(TravelRequest).filter(TravelRequest.id.in_(travel_request_ids)).all()
    } if travel_request_ids else {}
    leads = {
        int(lead.id): lead
        for lead in db.query(Lead).filter(Lead.id.in_(lead_ids)).all()
    } if lead_ids else {}
    tenders = {
        int(tender.id): tender
        for tender in db.query(Tender).filter(Tender.id.in_(tender_ids)).all()
    } if tender_ids else {}
    return users, customers, travel_requests, leads, tenders


def _enrich_activity(
    row,
    db,
    *,
    user_map: Optional[dict[int, User]] = None,
    customer_map: Optional[dict[int, Customer]] = None,
    travel_request_map: Optional[dict[int, TravelRequest]] = None,
    lead_map: Optional[dict[int, Lead]] = None,
    tender_map: Optional[dict[int, Tender]] = None,
    include_reopen_info: bool = False,
):
    user_map = user_map or {}
    customer_map = customer_map or {}
    travel_request_map = travel_request_map or {}
    lead_map = lead_map or {}
    tender_map = tender_map or {}
    d = {c.name: (_contacts_from_db(getattr(row,c.name)) if c.name=="contacts_met" else getattr(row,c.name)) for c in row.__table__.columns}
    for tf in ("start_time", "end_time"):
        if isinstance(d.get(tf), time):
            d[tf] = d[tf].strftime("%H:%M")
    d["task_type_name"] = _activity_type_name(d.get("activity_type"), d.get("mode"))
    for f, dflt in [("outcome",None),("next_action",None),("next_action_date",None),("contacts_met",[]),
                    ("followup_category",None),("followup_sub_type",None),("followup_ref_id",None),
                    ("cancellation_reason",None),("has_travel",False),("travel_mode",None),
                    ("travel_from",None),("travel_to",None),("is_outside_district",False),
                    ("travel_approved",None),("travel_request_id",None),("on_behalf_of",None),("user_role",None)]:
        if f not in d: d[f] = dflt
    u = user_map.get(int(row.user_id)) if row.user_id else None
    if u is None and row.user_id:
        u = db.query(User).filter(User.id==row.user_id).first()
    d["user_name"] = u.full_name if u else ""
    d["user_role"] = u.role if u else ""
    if row.customer_id:
        c = customer_map.get(int(row.customer_id))
        if c is None:
            c = db.query(Customer).filter(Customer.id==row.customer_id).first()
        d["customer_name"] = c.customer_name if c else ""
    else:
        d["customer_name"] = ""
    lead = lead_map.get(int(row.lead_id)) if row.lead_id else None
    if lead is None and row.lead_id:
        lead = db.query(Lead).filter(Lead.id==row.lead_id).first()
    d["lead_title"] = lead.lead_title if lead else ""
    d["lead_ref_id"] = lead.lead_ref_id if lead else ""
    d["opportunity_ref_id"] = lead.opportunity_ref_id if lead else ""
    d["lead_status"] = lead.status if lead else ""
    d["lead_type"] = lead.lead_type if lead else ""
    d["lead_value"] = float(lead.est_value or 0) if lead else 0

    tender = tender_map.get(int(row.tender_id)) if row.tender_id else None
    if tender is None and row.tender_id:
        tender = db.query(Tender).filter(Tender.id==row.tender_id).first()
    d["tender_title"] = tender.tender_title if tender else ""
    d["tender_num"] = tender.tender_num if tender else ""
    d["portal_ref_number"] = tender.portal_ref_number if tender else ""
    d["tender_status"] = tender.tender_status if tender else ""
    d["tender_result"] = tender.result if tender else ""
    d["tender_value"] = float(tender.est_value or 0) if tender else 0
    d["tender_bid_amount"] = float(tender.bid_amount or 0) if tender else 0
    tr_id = _safe_get(row,"travel_request_id")
    if tr_id:
        tr = travel_request_map.get(int(tr_id))
        if tr is None:
            tr = db.query(TravelRequest).filter(TravelRequest.id==tr_id).first()
        d["travel_request_status"] = tr.status if tr else None
        d["travel_request_number"] = tr.request_number if tr else None
    else:
        d["travel_request_status"] = d["travel_request_number"] = None
    if include_reopen_info:
        d["latest_reopen"] = get_latest_reopen_info(db, row)
    return d

def _time_or_none(value):
    if value is None:
        return None
    if isinstance(value, time):
        return value
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        for fmt in ("%H:%M:%S", "%H:%M", "%I:%M %p", "%I:%M%p"):
            try:
                return datetime.strptime(raw.upper(), fmt).time()
            except ValueError:
                pass
    return value


VISIT_COVERAGE_COORD_PRECISION = 4


def _visit_coverage_status_mode(value: Optional[str]) -> str:
    normalized = str(value or "completed").strip().lower().replace("-", "_").replace(" ", "_")
    if normalized in {"all", "all_activities"}:
        return "all"
    return "completed"


def _visit_coverage_bucket(latitude, longitude) -> Optional[tuple[float, float]]:
    if latitude is None or longitude is None:
        return None
    try:
        return (
            round(float(latitude), VISIT_COVERAGE_COORD_PRECISION),
            round(float(longitude), VISIT_COVERAGE_COORD_PRECISION),
        )
    except (TypeError, ValueError):
        return None


def _activity_time_label(value) -> str:
    if isinstance(value, time):
        return value.strftime("%H:%M")
    return str(value or "").strip()


def _activity_sort_key(activity: KAMActivity):
    activity_day = str(getattr(activity, "activity_date", "") or "")
    start_time = _activity_time_label(getattr(activity, "start_time", None))
    created_at = getattr(activity, "created_at", None)
    created_sort = created_at.isoformat() if isinstance(created_at, datetime) else str(created_at or "")
    return (
        activity_day,
        start_time,
        created_sort,
        int(getattr(activity, "id", 0) or 0),
    )

def _auto_travel_request(db, act, cu, needs_approval, extra=None, tenant_id: Optional[int] = None):
    extra = extra or {}
    cust_name = ""
    if act.customer_id:
        c = db.query(Customer).filter(Customer.id==act.customer_id).first()
        cust_name = c.customer_name if c else ""
    tr_cols = _valid_cols(TravelRequest)
    travel_date = extra.get("tr_travel_date") or act.activity_date
    return_date = extra.get("tr_return_date") or travel_date
    total_days  = max(1, (return_date - travel_date).days + 1) if return_date else 1
    kw = dict(
        request_number=_tr_num(db),
        employee_id=act.user_id,
        purpose=f"KAM Activity: {act.subject}" + (f" @ {cust_name}" if cust_name else ""),
        visit_type=extra.get("tr_visit_type") or ("Customer Visit" if act.customer_id else "Site Visit"),
        customer_id=act.customer_id,
        from_city=_safe_get(act,"travel_from") or "Base Location",
        to_city=_safe_get(act,"travel_to") or _safe_get(act,"location") or "Destination",
        travel_date=travel_date,
        return_date=return_date,
        total_days=total_days,
        is_outside_district=_safe_get(act,"is_outside_district",False),
        transport_mode=extra.get("tr_transport_mode") or _safe_get(act,"travel_mode") or None,
        vehicle_number=extra.get("tr_vehicle_number"),
        estimated_kms=extra.get("tr_estimated_kms"),
        advance_booking_ref=extra.get("tr_advance_booking_ref"),
        estimated_total=extra.get("tr_estimated_cost") or 0,
        advance_required=extra.get("tr_advance_required") or False,
        advance_amount=extra.get("tr_advance_amount") or 0,
        accommodation_required=extra.get("tr_accommodation_required") or False,
        accommodation_type=extra.get("tr_accommodation_type") or "Not Required",
        hotel_name=extra.get("tr_hotel_name"),
        check_in_date=extra.get("tr_check_in_date"),
        check_out_date=extra.get("tr_check_out_date"),
        accommodation_cost=extra.get("tr_accommodation_cost") or 0,
        companions=extra.get("tr_companions"),
        contact_name=extra.get("tr_contact_name"),
        contact_phone=extra.get("tr_contact_phone"),
        notes=extra.get("tr_notes") or f"Auto-created from KAM activity #{act.id}",
        opportunity_id=extra.get("tr_opportunity_id"),
        lead_id=extra.get("tr_lead_id"),
        tender_id=extra.get("tr_tender_id"),
        status="Draft",
    )
    if "source" in tr_cols: kw["source"] = "kam"
    if "kam_activity_id" in tr_cols: kw["kam_activity_id"] = act.id
    tr = TravelRequest(**{k:v for k,v in kw.items() if k in tr_cols})
    db.add(tr); db.flush()
    act_user = db.query(User).filter(User.id == act.user_id).first() or cu
    # Auto-submit for approval when outside district
    if needs_approval:
        try:
            submit_travel_request_with_policy(
                db,
                tr,
                actor=act_user or cu,
                requester=act_user or cu,
                tenant_id=tenant_id,
            )
        except Exception:
            pass  # Don't block activity save if auto-submit fails
    return tr


def _update_travel_request_details(tr, extra):
    """Patch an existing TravelRequest with the full detail fields from extra."""
    tr_cols = _valid_cols(TravelRequest)
    field_map = {
        "tr_travel_date":           "travel_date",
        "travel_from":              "from_city",
        "travel_to":                "to_city",
        "tr_visit_type":             "visit_type",
        "tr_return_date":            "return_date",
        "tr_transport_mode":         "transport_mode",
        "tr_vehicle_number":         "vehicle_number",
        "tr_estimated_kms":          "estimated_kms",
        "tr_advance_booking_ref":    "advance_booking_ref",
        "tr_estimated_cost":         "estimated_total",
        "tr_advance_required":       "advance_required",
        "tr_advance_amount":         "advance_amount",
        "tr_accommodation_required": "accommodation_required",
        "tr_accommodation_type":     "accommodation_type",
        "tr_hotel_name":             "hotel_name",
        "tr_check_in_date":          "check_in_date",
        "tr_check_out_date":         "check_out_date",
        "tr_accommodation_cost":     "accommodation_cost",
        "tr_companions":             "companions",
        "tr_contact_name":           "contact_name",
        "tr_contact_phone":          "contact_phone",
        "tr_notes":                  "notes",
        "tr_opportunity_id":         "opportunity_id",
        "tr_lead_id":                "lead_id",
        "tr_tender_id":              "tender_id",
    }
    for src, dst in field_map.items():
        if src in extra and extra[src] is not None and dst in tr_cols:
            setattr(tr, dst, extra[src])
    if ("tr_travel_date" in extra or "tr_return_date" in extra) and "total_days" in tr_cols:
        from_date = extra.get("tr_travel_date") or tr.travel_date
        return_date = extra.get("tr_return_date") or tr.return_date
        try:
            tr.total_days = max(1, (return_date - from_date).days + 1)
        except Exception:
            pass


# --- Stats helpers ------------------------------------------------------------

def _lead_stats(uids, db, d_from: Optional[str]=None, d_to: Optional[str]=None):
    q = _kam_lead_records_query(db, uids, d_from, d_to)
    leads = q.all()
    opportunities = [l for l in leads if _is_kam_opportunity(l)]
    conversion_leads = [l for l in leads if getattr(l, "lead_type", "lead") != "direct_opportunity"]
    converted_opportunities = [l for l in conversion_leads if _is_kam_opportunity(l)]
    customer_to_lead_count = len({int(l.customer_id) for l in conversion_leads if l.customer_id})
    return {
        "lead_count": len(conversion_leads),
        "lead_value": float(sum(float(l.est_value or 0) for l in conversion_leads)),
        "opportunity_count": len(opportunities),
        "opportunity_value": float(sum(float(l.est_value or 0) for l in opportunities)),
        "conversion_lead_count": len(conversion_leads),
        "customer_to_lead_count": customer_to_lead_count,
        "converted_opportunity_count": len(converted_opportunities),
    }

def _tender_stats(uids, db, d_from: Optional[str]=None, d_to: Optional[str]=None):
    q = _kam_tender_records_query(db, uids, d_from, d_to)
    tenders = q.all()
    won = [t for t in tenders if t.result == 'Won']
    tender_lead_ids = {int(t.lead_id) for t in tenders if t.lead_id}
    opportunity_lead_ids = {
        int(lead.id)
        for lead in (
            _kam_lead_records_query(db, uids, d_from, d_to)
            .filter(Lead.id.in_(tender_lead_ids))
            .all()
        )
        if _is_kam_opportunity(lead)
    } if tender_lead_ids else set()
    linked_opportunity_count = sum(1 for t in tenders if t.lead_id and int(t.lead_id) in opportunity_lead_ids)
    return {
        "tender_count":      len(tenders),
        "tender_value":      float(sum(float(t.est_value or 0) for t in tenders)),
        "won_tender_count":  len(won),
        "won_tender_value":  float(sum(float(t.bid_amount or t.est_value or 0) for t in won)),
        "linked_opportunity_count": linked_opportunity_count,
    }

def _acknowledged_receipts(db, wo_ids) -> dict[int, float]:
    """Finance-acknowledged customer receipts per work order (order_payment_receipts) – the collected figure used by
    Orders & Projects → Collections & finance, Customer 360 and the dashboards."""
    ids = [int(i) for i in wo_ids if i]
    if not ids:
        return {}
    try:
        from app.models.commitments import OrderPaymentReceipt
        rows = db.query(OrderPaymentReceipt.wo_id, func.sum(OrderPaymentReceipt.amount)).filter(
            OrderPaymentReceipt.wo_id.in_(ids), OrderPaymentReceipt.status == "Acknowledged").group_by(OrderPaymentReceipt.wo_id).all()
        return {int(w): float(v or 0) for w, v in rows}
    except Exception:
        db.rollback()
        return {}


def _wo_stats(uids, db, d_from: Optional[str]=None, d_to: Optional[str]=None):
    q = _kam_workorder_records_query(db, uids, d_from, d_to)
    wos = q.all()
    workorder_tender_ids = {int(getattr(x, "tender_id", 0) or 0) for x in wos if getattr(x, "tender_id", None)}
    scoped_tender_ids = {
        int(t.id)
        for t in _kam_tender_records_query(db, uids, d_from, d_to)
            .filter(Tender.id.in_(workorder_tender_ids or [-1]))
            .all()
    } if workorder_tender_ids else set()
    linked_tender_workorder_count = sum(
        1
        for x in wos
        if getattr(x, "tender_id", None) and int(x.tender_id) in scoped_tender_ids
    )
    recv = _acknowledged_receipts(db, [x.id for x in wos])
    return {
        "wo_count": len(wos),
        "wo_value": float(sum(float(x.wo_value or x.po_value or 0) for x in wos)),
        # collected = receipts acknowledged by Finance (Orders & Projects → Collections & finance), not the PO advance field
        "payment_received": float(sum(recv.values())),
        "linked_tender_workorder_count": linked_tender_workorder_count,
        "wos": wos,
    }

def _business_unit_master_rows(db: Session) -> list[dict]:
    try:
        rows = db.execute(sa_text("""
            SELECT
              u.id AS unit_id,
              u.business_unit AS unit,
              c.business_vertical AS vertical
            FROM business_category_units u
            LEFT JOIN business_category_units c ON c.id = u.parent_category_id
            WHERE u.item_type = 'unit'
              AND u.is_active = 1
              AND u.business_unit IS NOT NULL
            ORDER BY c.display_order, c.business_vertical, u.display_order, u.business_unit, u.id
        """)).mappings().all()
    except Exception:
        return []
    return [
        {
            "unit_id": int(row["unit_id"]),
            "unit": (row["unit"] or "").strip(),
            "vertical": (row["vertical"] or "").strip() or "Unassigned",
        }
        for row in rows
        if row.get("unit_id") and (row.get("unit") or "").strip()
    ]

def _business_unit_pipeline_analysis(db: Session, scope_uids: Optional[list[int]], d_from: Optional[str], d_to: Optional[str]) -> dict:
    master_rows = _business_unit_master_rows(db)
    unit_master = {int(row["unit_id"]): row for row in master_rows}
    if not unit_master:
        return {"rows": [], "master_units": []}

    leads = _kam_lead_records_query(db, scope_uids, d_from, d_to).all()
    tenders = _kam_tender_records_query(db, scope_uids, d_from, d_to).all()
    work_orders = _kam_workorder_records_query(db, scope_uids, d_from, d_to).all()

    linked_lead_ids = {
        int(lead_id)
        for lead_id in [
            *(getattr(t, "lead_id", None) for t in tenders),
            *(getattr(w, "lead_id", None) for w in work_orders),
        ]
        if lead_id
    }
    tender_ids = {int(getattr(w, "tender_id", 0) or 0) for w in work_orders if getattr(w, "tender_id", None)}
    tender_link_map: dict[int, int] = {}
    tender_by_id: dict[int, Tender] = {}
    if tender_ids:
        for tender in db.query(Tender).filter(Tender.id.in_(tender_ids)).all():
            tender_by_id[int(tender.id)] = tender
            lead_id = getattr(tender, "lead_id", None)
            if tender.id and lead_id:
                tender_link_map[int(tender.id)] = int(lead_id)
                linked_lead_ids.add(int(lead_id))

    lead_by_id = {int(lead.id): lead for lead in leads}
    missing_lead_ids = [lead_id for lead_id in linked_lead_ids if lead_id not in lead_by_id]
    if missing_lead_ids:
        for lead in db.query(Lead).filter(Lead.id.in_(missing_lead_ids), Lead.is_deleted == False).all():
            lead_by_id[int(lead.id)] = lead

    customer_ids = {
        int(cid)
        for cid in [
            *(getattr(lead, "customer_id", None) for lead in leads),
            *(getattr(tender, "customer_id", None) for tender in tenders),
            *(getattr(order, "customer_id", None) for order in work_orders),
            *(getattr(lead, "customer_id", None) for lead in lead_by_id.values()),
        ]
        if cid
    }
    customer_location_map: dict[int, tuple[str, str]] = {}
    if customer_ids:
        for cid, billing_state, shipping_state, billing_city, shipping_city in db.query(
            Customer.id,
            Customer.billing_state,
            Customer.shipping_state,
            Customer.billing_city,
            Customer.shipping_city,
        ).filter(Customer.id.in_(customer_ids)).all():
            state = (billing_state or shipping_state or "Unassigned").strip() or "Unassigned"
            district = (billing_city or shipping_city or "").strip()
            customer_location_map[int(cid)] = (state, district)

    grouped: dict[tuple[str, str, int], dict] = {}

    def get_entry(unit_id: Optional[int], customer_id: Optional[int]) -> Optional[dict]:
        if not unit_id:
            return None
        master = unit_master.get(int(unit_id))
        if not master:
            return None
        state, district = customer_location_map.get(int(customer_id or 0), ("Unassigned", ""))
        key = (state.lower().strip(), district.lower().strip(), int(unit_id))
        entry = grouped.get(key)
        if not entry:
            entry = {
                "state": state,
                "district": district,
                "vertical": master["vertical"],
                "unit": master["unit"],
                "unit_id": int(unit_id),
                "customer_ids": set(),
                "lead_count": 0,
                "lead_value": 0.0,
                "opportunity_count": 0,
                "opportunity_value": 0.0,
                "tender_count": 0,
                "tender_value": 0.0,
                "work_order_count": 0,
                "work_order_value": 0.0,
            }
            grouped[key] = entry
        if customer_id:
            entry["customer_ids"].add(int(customer_id))
        return entry

    for lead in leads:
        unit_id = getattr(lead, "business_vertical_id", None)
        entry = get_entry(unit_id, getattr(lead, "customer_id", None))
        if not entry:
            continue
        value = float(getattr(lead, "est_value", 0) or 0)
        lead_type = str(getattr(lead, "lead_type", "") or "").strip().lower()
        # "leads" = total lead-originated records regardless of current status
        # (Converted/Lost included) — mirrors the /pipeline-records leads bucket.
        # direct_opportunity records were created straight as opportunities and
        # never went through the lead stage, so they're excluded here.
        if lead_type != "direct_opportunity":
            entry["lead_count"] += 1
            entry["lead_value"] += value
        if _is_kam_opportunity(lead):
            entry["opportunity_count"] += 1
            entry["opportunity_value"] += value

    for tender in tenders:
        lead = lead_by_id.get(int(getattr(tender, "lead_id", 0) or 0))
        unit_id = getattr(tender, "business_vertical_id", None) or (getattr(lead, "business_vertical_id", None) if lead else None)
        customer_id = getattr(tender, "customer_id", None) or getattr(lead, "customer_id", None)
        entry = get_entry(unit_id, customer_id)
        if not entry:
            continue
        entry["tender_count"] += 1
        entry["tender_value"] += float(getattr(tender, "est_value", 0) or 0)

    for order in work_orders:
        lead = lead_by_id.get(int(getattr(order, "lead_id", 0) or 0))
        tender = tender_by_id.get(int(order.tender_id)) if getattr(order, "tender_id", None) else None
        if not lead and tender is not None:
            lead = lead_by_id.get(tender_link_map.get(int(order.tender_id), 0))
        unit_id = (getattr(lead, "business_vertical_id", None) if lead else None) or (getattr(tender, "business_vertical_id", None) if tender else None)
        customer_id = getattr(order, "customer_id", None) or getattr(lead, "customer_id", None)
        if tender is not None:
            customer_id = customer_id or getattr(tender, "customer_id", None)
        entry = get_entry(unit_id, customer_id)
        if not entry:
            continue
        entry["work_order_count"] += 1
        entry["work_order_value"] += float(getattr(order, "wo_value", None) or getattr(order, "po_value", None) or 0)

    rows = []
    for entry in grouped.values():
        customer_ids_sorted = sorted(entry.pop("customer_ids"))
        total_count = int(
            entry["lead_count"]
            + entry["opportunity_count"]
            + entry["tender_count"]
            + entry["work_order_count"]
        )
        rows.append({
            **entry,
            "customer_ids": customer_ids_sorted,
            "customer_count": len(customer_ids_sorted),
            "total_count": total_count,
            "total_value": float(
                entry["lead_value"]
                + entry["opportunity_value"]
                + entry["tender_value"]
                + entry["work_order_value"]
            ),
        })
    rows.sort(key=lambda row: (row["state"], row["vertical"], row["unit"]))
    return {"rows": rows, "master_units": master_rows}

def _pipeline_conversion_pct(current, previous) -> int:
    previous_value = float(previous or 0)
    if previous_value <= 0:
        return 0
    return int(min(100, round((float(current or 0) / previous_value) * 100)))


def _pipeline_conversion_summary(customer_count: int, lead_stats: dict, tender_stats: dict, workorder_stats: dict) -> dict:
    lead_count = int(lead_stats.get("lead_count", 0) or 0)
    customer_to_lead_count = int(lead_stats.get("customer_to_lead_count", 0) or 0)
    opportunity_count = int(lead_stats.get("opportunity_count", 0) or 0)
    converted_opportunity_count = int(lead_stats.get("converted_opportunity_count", opportunity_count) or 0)
    tender_count = int(tender_stats.get("tender_count", 0) or 0)
    linked_opportunity_count = int(tender_stats.get("linked_opportunity_count", tender_count) or 0)
    workorder_count = int(workorder_stats.get("wo_count", tender_stats.get("won_tender_count", 0)) or 0)
    linked_tender_workorder_count = int(workorder_stats.get("linked_tender_workorder_count", workorder_count) or 0)
    return {
        "customers": 100,
        "leads": _pipeline_conversion_pct(customer_to_lead_count, customer_count),
        "opportunities": _pipeline_conversion_pct(converted_opportunity_count, lead_count),
        "tenders": _pipeline_conversion_pct(linked_opportunity_count, opportunity_count),
        "workorders": _pipeline_conversion_pct(linked_tender_workorder_count, tender_count),
    }


def _parse_member_ids_param(raw: Optional[str]) -> list[int]:
    ids: list[int] = []
    for part in str(raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            ids.append(int(part))
        except ValueError:
            continue
    return list(dict.fromkeys(ids))


def _kam_pipeline_scope_uids(
    cu: User,
    db: Session,
    user_id: Optional[int] = None,
    member_ids: Optional[str] = None,
) -> list[int]:
    visible_uids = [int(uid) for uid in (_get_team_uids(cu, db) or []) if uid]
    if user_id:
        return [int(_get_visible_uids(cu, db, int(user_id))[0])]

    requested_member_ids = _parse_member_ids_param(member_ids)
    if requested_member_ids:
        visible_set = set(visible_uids)
        if not set(requested_member_ids).issubset(visible_set):
            raise HTTPException(403, "Not authorised")
        return requested_member_ids

    if len(visible_uids) > 1:
        kam_scope_uids = [
            int(row.id)
            for row in db.query(User.id, User.role).filter(
                User.id.in_(visible_uids),
                User.is_active == True,
            ).all()
            if _is_kam_sales_role(row.role)
        ]
        return kam_scope_uids or visible_uids

    return visible_uids or [int(cu.id)]


def _kam_window_bounds(d_from: Optional[str], d_to: Optional[str]):
    if not d_from or not d_to:
        return None, None, None, None
    start_date = date.fromisoformat(str(d_from))
    end_date = date.fromisoformat(str(d_to))
    start_dt = datetime.combine(start_date, datetime.min.time())
    end_dt = datetime.combine(end_date, datetime.max.time())
    return start_date, end_date, start_dt, end_dt


def _kam_lead_records_query(db: Session, scope_uids: Optional[list[int]], d_from: Optional[str], d_to: Optional[str]):
    q = db.query(Lead).filter(
        Lead.is_deleted == False,
    )
    if scope_uids is not None:
        q = q.filter(or_(
            Lead.assigned_to.in_(scope_uids),
            Lead.created_by.in_(scope_uids),
        ))
    _, _, start_dt, end_dt = _kam_window_bounds(d_from, d_to)
    if start_dt and end_dt:
        q = q.filter(func.coalesce(Lead.lead_created_at, Lead.created_at).between(start_dt, end_dt))
    return q


def _kam_tender_records_query(db: Session, scope_uids: Optional[list[int]], d_from: Optional[str], d_to: Optional[str]):
    q = db.query(Tender).filter(
        Tender.is_deleted == False,
    )
    if scope_uids is not None:
        q = q.filter(or_(
            Tender.assigned_to.in_(scope_uids),
            Tender.created_by.in_(scope_uids),
        ))
    start_date, end_date, start_dt, end_dt = _kam_window_bounds(d_from, d_to)
    if start_date and end_date and start_dt and end_dt:
        q = q.filter(or_(
            and_(Tender.result_date.isnot(None), Tender.result_date.between(start_date, end_date)),
            and_(Tender.submission_date.isnot(None), Tender.submission_date.between(start_date, end_date)),
            and_(Tender.published_date.isnot(None), Tender.published_date.between(start_date, end_date)),
            Tender.created_at.between(start_dt, end_dt),
        ))
    return q


def _kam_workorder_records_query(db: Session, scope_uids: Optional[list[int]], d_from: Optional[str], d_to: Optional[str]):
    q = (
        db.query(WorkOrder)
        .outerjoin(Tender, WorkOrder.tender_id == Tender.id)
        .outerjoin(Lead, WorkOrder.lead_id == Lead.id)
    )
    if scope_uids is not None:
        q = q.filter(or_(
            WorkOrder.created_by.in_(scope_uids),
            WorkOrder.project_manager_id.in_(scope_uids),
            Tender.assigned_to.in_(scope_uids),
            Tender.created_by.in_(scope_uids),
            Lead.assigned_to.in_(scope_uids),
            Lead.created_by.in_(scope_uids),
        ))
    start_date, end_date, start_dt, end_dt = _kam_window_bounds(d_from, d_to)
    if start_date and end_date and start_dt and end_dt:
        q = q.filter(or_(
            and_(WorkOrder.po_date.isnot(None), WorkOrder.po_date.between(start_date, end_date)),
            WorkOrder.created_at.between(start_dt, end_dt),
            and_(Tender.result_date.isnot(None), Tender.result_date.between(start_date, end_date)),
        ))
    return q


def _is_kam_opportunity(row) -> bool:
    lead_type = str(getattr(row, "lead_type", "") or "").strip().lower()
    status = str(getattr(row, "status", "") or "").strip()
    return lead_type == "direct_opportunity" or status in {"Opportunity Created", "Converted"}

def _user_name_map(db: Session, rows) -> dict[int, str]:
    user_ids = {
        int(uid)
        for row in rows
        for uid in (
            getattr(row, "assigned_to", None),
            getattr(row, "project_manager_id", None),
            getattr(row, "created_by", None),
        )
        if uid
    }
    return {
        int(user.id): (user.full_name or user.username or "")
        for user in db.query(User).filter(User.id.in_(user_ids)).all()
    } if user_ids else {}


def _activity_stats_bucket():
    return {
        "total": 0,
        "completed": 0,
        "pending": 0,
        "calls": 0,
        "calls_total": 0,
        "calls_completed": 0,
        "calls_pending": 0,
        "video_calls": 0,
        "video_calls_completed": 0,
        "video_calls_pending": 0,
        "meetings": 0,
        "meetings_total": 0,
        "meetings_completed": 0,
        "meetings_pending": 0,
        "demos": 0,
        "demos_completed": 0,
        "demos_pending": 0,
        "site_visits": 0,
        "site_visits_completed": 0,
        "site_visits_pending": 0,
        "follow_ups": 0,
        "follow_ups_completed": 0,
        "follow_ups_pending": 0,
        "emails": 0,
        "emails_completed": 0,
        "emails_pending": 0,
        "activity_types": {t: 0 for t in ACTIVITY_TYPES},
    }


def _apply_activity_to_stats(stats: dict[str, Any], activity_type: str, status: str):
    atype = activity_type or ""
    completed = status == "Completed"
    pending = status in ("Planned", "In Progress")

    stats["total"] += 1
    if completed:
        stats["completed"] += 1
    if pending:
        stats["pending"] += 1
    if atype in stats["activity_types"]:
        stats["activity_types"][atype] += 1

    if atype in ("Phone Call", "Daily Call"):
        stats["calls"] += 1
        stats["calls_total"] += 1
        if completed:
            stats["calls_completed"] += 1
        if pending:
            stats["calls_pending"] += 1
    elif atype == "Video Call":
        stats["video_calls"] += 1
        if completed:
            stats["video_calls_completed"] += 1
        if pending:
            stats["video_calls_pending"] += 1
    elif atype in ("In Person Meet", "Meeting"):
        stats["meetings"] += 1
        stats["meetings_total"] += 1
        if completed:
            stats["meetings_completed"] += 1
        if pending:
            stats["meetings_pending"] += 1
    elif atype == "Demo":
        stats["demos"] += 1
        if completed:
            stats["demos_completed"] += 1
        if pending:
            stats["demos_pending"] += 1
    elif atype == "Site Visit":
        stats["site_visits"] += 1
        if completed:
            stats["site_visits_completed"] += 1
        if pending:
            stats["site_visits_pending"] += 1
    elif atype in ("Follow Up", "Follow-up"):
        stats["follow_ups"] += 1
        if completed:
            stats["follow_ups_completed"] += 1
        if pending:
            stats["follow_ups_pending"] += 1
    elif atype == "Email":
        stats["emails"] += 1
        if completed:
            stats["emails_completed"] += 1
        if pending:
            stats["emails_pending"] += 1


def _team_360_target_map(db: Session, user_ids: list[int], period: str, cy: int, is_yearly: bool):
    if not user_ids:
        return {}
    period_key = str(period or "")
    year_key = str(cy)
    rows = db.query(KAMTarget).filter(
        KAMTarget.user_id.in_(user_ids),
        or_(
            KAMTarget.period == period_key,
            KAMTarget.period == year_key,
            KAMTarget.period.like(f"{cy}-%"),
        ),
    ).all()

    targets: dict[int, KAMTarget] = {}
    ranks: dict[int, tuple[int, str]] = {}
    for row in rows:
        uid = int(row.user_id)
        row_period = str(row.period or "")
        if row_period == period_key:
            rank = (0, row_period)
        elif is_yearly and row_period == year_key:
            rank = (1, row_period)
        elif row_period.startswith(f"{cy}-"):
            rank = (2, row_period)
        else:
            continue

        current = ranks.get(uid)
        if current is None or rank[0] < current[0] or (rank[0] == current[0] == 2 and rank[1] > current[1]):
            ranks[uid] = rank
            targets[uid] = row
    return targets


def _team_360_customer_maps(db: Session, user_ids: list[int]):
    customer_ids_by_user: dict[int, set[int]] = {int(uid): set() for uid in user_ids}
    potential_by_customer: dict[int, float] = {}
    if not user_ids:
        return customer_ids_by_user, {}, {}, potential_by_customer

    assignment_rows = db.query(
        SalesCustomerAssignment.user_id,
        SalesCustomerAssignment.customer_id,
    ).filter(
        SalesCustomerAssignment.user_id.in_(user_ids),
        SalesCustomerAssignment.is_active == True,
    ).all()

    all_assignment_customer_ids = {
        int(row.customer_id)
        for row in db.query(SalesCustomerAssignment.customer_id).filter(
            SalesCustomerAssignment.is_active == True,
        ).all()
        if row.customer_id
    }

    candidate_customer_ids = {
        int(row.customer_id)
        for row in assignment_rows
        if row.customer_id
    }

    fallback_query = db.query(
        Customer.id,
        Customer.assigned_to,
        Customer.potential_value,
    ).filter(
        Customer.is_deleted == False,
        Customer.assigned_to.in_(user_ids),
    )
    if all_assignment_customer_ids:
        fallback_query = fallback_query.filter(Customer.id.notin_(all_assignment_customer_ids))
    fallback_rows = fallback_query.all()
    candidate_customer_ids.update(int(row.id) for row in fallback_rows if row.id)

    if candidate_customer_ids:
        for cid, potential_value in db.query(Customer.id, Customer.potential_value).filter(
            Customer.id.in_(candidate_customer_ids),
            Customer.is_deleted == False,
        ).all():
            potential_by_customer[int(cid)] = float(potential_value or 0)

    for row in assignment_rows:
        uid = int(row.user_id) if row.user_id else None
        cid = int(row.customer_id) if row.customer_id else None
        if uid in customer_ids_by_user and cid in potential_by_customer:
            customer_ids_by_user[uid].add(cid)

    for row in fallback_rows:
        uid = int(row.assigned_to) if row.assigned_to else None
        cid = int(row.id) if row.id else None
        if uid in customer_ids_by_user and cid in potential_by_customer:
            customer_ids_by_user[uid].add(cid)

    customer_counts = {uid: len(cids) for uid, cids in customer_ids_by_user.items()}
    potential_by_user = {
        uid: float(sum(potential_by_customer.get(cid, 0) for cid in cids))
        for uid, cids in customer_ids_by_user.items()
    }
    return customer_ids_by_user, customer_counts, potential_by_user, potential_by_customer


def _team_360_customer_status_maps(
    db: Session,
    user_ids: list[int],
    customer_ids_by_user: dict[int, set[int]],
    d_from: Optional[str],
    d_to: Optional[str],
):
    customers_with_win = {int(uid): 0 for uid in user_ids}
    customers_pending = {int(uid): 0 for uid in user_ids}
    all_customer_ids = {cid for cids in customer_ids_by_user.values() for cid in cids}
    if not user_ids or not all_customer_ids:
        return customers_with_win, customers_pending
    all_customer_id_list = list(all_customer_ids)

    start_date = date.fromisoformat(str(d_from)) if d_from and d_to else None
    end_date = date.fromisoformat(str(d_to)) if d_from and d_to else None
    start_dt = datetime.combine(start_date, datetime.min.time()) if start_date else None
    end_dt = datetime.combine(end_date, datetime.max.time()) if end_date else None
    signals: dict[tuple[int, int], dict[str, float | int]] = defaultdict(lambda: {
        "lead_count": 0, "lead_value": 0.0,
        "tender_count": 0, "tender_value": 0.0,
        "won_count": 0, "won_value": 0.0,
        "activity_count": 0,
    })

    lead_q = db.query(
        Lead.assigned_to,
        Lead.customer_id,
        func.count(Lead.id),
        func.sum(Lead.est_value),
    ).filter(
        Lead.assigned_to.in_(user_ids),
        Lead.customer_id.in_(all_customer_id_list),
        Lead.is_deleted == False,
        Lead.status.notin_(['Converted', 'Lost']),
    )
    if start_dt and end_dt:
        lead_q = lead_q.filter(func.coalesce(Lead.lead_created_at, Lead.created_at).between(start_dt, end_dt))
    for uid, cid, cnt, sv in lead_q.group_by(Lead.assigned_to, Lead.customer_id).all():
        if uid and cid:
            item = signals[(int(uid), int(cid))]
            item["lead_count"] = int(cnt or 0)
            item["lead_value"] = float(sv or 0)

    tender_q = db.query(
        Tender.assigned_to,
        Tender.customer_id,
        func.count(Tender.id),
        func.sum(Tender.est_value),
    ).filter(
        Tender.assigned_to.in_(user_ids),
        Tender.customer_id.in_(all_customer_id_list),
        Tender.is_deleted == False,
        Tender.result.notin_(['Won', 'Lost']),
    )
    if start_dt and end_dt:
        tender_q = tender_q.filter(Tender.created_at.between(start_dt, end_dt))
    for uid, cid, cnt, sv in tender_q.group_by(Tender.assigned_to, Tender.customer_id).all():
        if uid and cid:
            item = signals[(int(uid), int(cid))]
            item["tender_count"] = int(cnt or 0)
            item["tender_value"] = float(sv or 0)

    won_q = db.query(
        Tender.assigned_to,
        Tender.customer_id,
        func.count(Tender.id),
        func.sum(Tender.bid_amount),
    ).filter(
        Tender.assigned_to.in_(user_ids),
        Tender.customer_id.in_(all_customer_id_list),
        Tender.is_deleted == False,
        Tender.result == 'Won',
    )
    if start_date and end_date and start_dt and end_dt:
        won_q = won_q.filter(or_(
            and_(Tender.result_date.isnot(None), Tender.result_date.between(start_date, end_date)),
            and_(Tender.result_date.is_(None), Tender.created_at.between(start_dt, end_dt)),
        ))
    for uid, cid, cnt, sv in won_q.group_by(Tender.assigned_to, Tender.customer_id).all():
        if uid and cid:
            item = signals[(int(uid), int(cid))]
            item["won_count"] = int(cnt or 0)
            item["won_value"] = float(sv or 0)

    act_q = db.query(
        KAMActivity.user_id,
        KAMActivity.customer_id,
        func.count(KAMActivity.id),
    ).filter(
        KAMActivity.user_id.in_(user_ids),
        KAMActivity.customer_id.in_(all_customer_id_list),
    )
    if d_from and d_to:
        act_q = act_q.filter(KAMActivity.activity_date.between(d_from, d_to))
    for uid, cid, cnt in act_q.group_by(KAMActivity.user_id, KAMActivity.customer_id).all():
        if uid and cid:
            signals[(int(uid), int(cid))]["activity_count"] = int(cnt or 0)

    for uid, customer_ids in customer_ids_by_user.items():
        for cid in customer_ids:
            item = signals.get((int(uid), int(cid)))
            if not item:
                continue
            if int(item.get("won_count") or 0) > 0 or float(item.get("won_value") or 0) > 0:
                customers_with_win[int(uid)] += 1
            elif (
                int(item.get("lead_count") or 0) > 0
                or int(item.get("tender_count") or 0) > 0
                or float(item.get("lead_value") or 0) > 0
                or float(item.get("tender_value") or 0) > 0
                or int(item.get("activity_count") or 0) > 0
            ):
                customers_pending[int(uid)] += 1

    return customers_with_win, customers_pending


# --- Schemas ------------------------------------------------------------------

class ActivityCreate(BaseModel):
    activity_type: str = "Phone Call"
    customer_id: Optional[int] = None
    lead_id: Optional[int] = None
    tender_id: Optional[int] = None
    work_order_id: Optional[int] = None
    emdbg_id: Optional[int] = None
    subject: str
    description: Optional[str] = None
    activity_date: date
    start_time: Optional[str] = None
    duration_minutes: Optional[int] = None
    location: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    mode: str = "Phone"
    status: str = "Planned"
    outcome: Optional[str] = None
    next_action: Optional[str] = None
    next_action_date: Optional[date] = None
    contacts_met: Optional[List[int]] = None
    followup_category: Optional[str] = None
    followup_sub_type: Optional[str] = None
    cancellation_reason: Optional[str] = None
    document_url: Optional[str] = None
    document_name: Optional[str] = None
    document_size_kb: Optional[int] = None
    has_travel: bool = False
    travel_mode: Optional[str] = None
    travel_from: Optional[str] = None
    travel_to: Optional[str] = None
    is_outside_district: bool = False
    on_behalf_of: Optional[int] = None
    tr_visit_type: Optional[str] = None
    tr_return_date: Optional[date] = None
    tr_transport_mode: Optional[str] = None
    tr_vehicle_number: Optional[str] = None
    tr_estimated_kms: Optional[float] = None
    tr_advance_booking_ref: Optional[str] = None
    tr_estimated_cost: Optional[float] = None
    tr_advance_required: Optional[bool] = None
    tr_advance_amount: Optional[float] = None
    tr_accommodation_required: Optional[bool] = None
    tr_accommodation_type: Optional[str] = None
    tr_hotel_name: Optional[str] = None
    tr_check_in_date: Optional[date] = None
    tr_check_out_date: Optional[date] = None
    tr_accommodation_cost: Optional[float] = None
    tr_companions: Optional[str] = None
    tr_contact_name: Optional[str] = None
    tr_contact_phone: Optional[str] = None
    tr_notes: Optional[str] = None
    tr_opportunity_id: Optional[int] = None
    tr_lead_id: Optional[int] = None
    tr_tender_id: Optional[int] = None
    tr_travel_date: Optional[date] = None

    @field_validator("start_time","next_action_date","tr_return_date",
                     "tr_check_in_date","tr_check_out_date","tr_travel_date",mode="before")
    @classmethod
    def _ct(cls,v): return None if v is None or (isinstance(v,str) and not v.strip()) else v

    @field_validator("description","location","outcome","next_action","followup_category",
                      "followup_sub_type","cancellation_reason","travel_mode","travel_from","travel_to",
                      "document_url","document_name",
                      "tr_visit_type","tr_transport_mode","tr_vehicle_number","tr_advance_booking_ref",
                      "tr_accommodation_type","tr_hotel_name","tr_companions","tr_contact_name",
                      "tr_contact_phone","tr_notes",mode="before")
    @classmethod
    def _cs(cls,v): return None if isinstance(v,str) and not v.strip() else v

    @field_validator("tr_opportunity_id","tr_lead_id","tr_tender_id",mode="before")
    @classmethod
    def _ci(cls,v): return None if v is None or (isinstance(v,str) and not v.strip()) else (int(v) if isinstance(v,str) else v)


class ActivityUpdate(BaseModel):
    activity_type: Optional[str]=None; customer_id: Optional[int]=None
    lead_id: Optional[int]=None; tender_id: Optional[int]=None
    work_order_id: Optional[int]=None; emdbg_id: Optional[int]=None
    subject: Optional[str]=None; description: Optional[str]=None
    activity_date: Optional[date]=None; start_time: Optional[str]=None
    duration_minutes: Optional[int]=None; location: Optional[str]=None
    latitude: Optional[float]=None; longitude: Optional[float]=None
    mode: Optional[str]=None; status: Optional[str]=None
    outcome: Optional[str]=None; next_action: Optional[str]=None
    next_action_date: Optional[date]=None; cancellation_reason: Optional[str]=None
    followup_category: Optional[str]=None; followup_sub_type: Optional[str]=None
    document_url: Optional[str]=None; document_name: Optional[str]=None; document_size_kb: Optional[int]=None
    has_travel: Optional[bool]=None; travel_mode: Optional[str]=None
    travel_from: Optional[str]=None; travel_to: Optional[str]=None
    is_outside_district: Optional[bool]=None
    # Full travel request detail fields (used to enrich the auto-created TravelRequest)
    tr_visit_type: Optional[str] = None
    tr_return_date: Optional[date] = None
    tr_transport_mode: Optional[str] = None
    tr_vehicle_number: Optional[str] = None
    tr_estimated_kms: Optional[float] = None
    tr_advance_booking_ref: Optional[str] = None
    tr_estimated_cost: Optional[float] = None
    tr_advance_required: Optional[bool] = None
    tr_advance_amount: Optional[float] = None
    tr_accommodation_required: Optional[bool] = None
    tr_accommodation_type: Optional[str] = None
    tr_hotel_name: Optional[str] = None
    tr_check_in_date: Optional[date] = None
    tr_check_out_date: Optional[date] = None
    tr_accommodation_cost: Optional[float] = None
    tr_companions: Optional[str] = None
    tr_contact_name: Optional[str] = None
    tr_contact_phone: Optional[str] = None
    tr_notes: Optional[str] = None
    # CRM linkage for travel request
    tr_opportunity_id: Optional[int] = None
    tr_lead_id: Optional[int] = None
    tr_tender_id: Optional[int] = None

    tr_travel_date: Optional[date] = None  # separate travel departure date (may differ from activity_date)

    @field_validator("start_time","next_action_date","activity_date","tr_return_date",
                     "tr_check_in_date","tr_check_out_date","tr_travel_date",mode="before")
    @classmethod
    def _ct(cls,v): return None if v is None or (isinstance(v,str) and not v.strip()) else v

    @field_validator("description","location","outcome","next_action","followup_category",
                      "followup_sub_type","cancellation_reason","travel_mode","travel_from","travel_to",
                      "document_url","document_name",
                      "tr_visit_type","tr_transport_mode","tr_vehicle_number","tr_advance_booking_ref",
                      "tr_accommodation_type","tr_hotel_name","tr_companions","tr_contact_name",
                     "tr_contact_phone","tr_notes",mode="before")
    @classmethod
    def _cs(cls,v): return None if isinstance(v,str) and not v.strip() else v

    # Explicit travel request link (used when frontend links an existing TR)
    travel_request_id: Optional[int] = None

    @field_validator("tr_opportunity_id","tr_lead_id","tr_tender_id","travel_request_id",mode="before")
    @classmethod
    def _ci(cls,v): return None if v is None or (isinstance(v,str) and not v.strip()) else (int(v) if isinstance(v,str) else v)


class TravelSubmitIn(BaseModel):
    pass


class BulkPlanItem(BaseModel):
    activity_type: str = "Phone Call"
    customer_id: int; subject: str; activity_date: date
    lead_id: Optional[int] = None
    tender_id: Optional[int] = None
    work_order_id: Optional[int] = None
    emdbg_id: Optional[int] = None
    mode: Optional[str] = None
    start_time: Optional[str] = None
    duration_minutes: Optional[int] = None
    on_behalf_of: Optional[int] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None


class WeeklyPlanEscalationIn(BaseModel):
    user_ids: Optional[List[int]] = None


class TargetCreate(BaseModel):
    user_id: int
    period: str                  # "2025-06" monthly  OR  "2025" yearly
    calls_target: int = 0
    meetings_target: int = 0
    leads_target: int = 0
    revenue_target: float = 0
    demos_target: int = 0
    site_visits_target: int = 0
    sales_target: float = 0      # rupee sales target e.g. 10000000 = 1 Cr
    target_mode: str = "replace" # replace | add


class GroupTargetAllocationIn(BaseModel):
    user_id: int
    sales_target: Decimal


class GroupTargetCreate(BaseModel):
    group_id: int
    period: str
    sales_target: Decimal
    allocations: List[GroupTargetAllocationIn]


# --- Meta ---------------------------------------------------------------------

@router.get("/meta")
def get_meta():
    return {"activity_types":ACTIVITY_TYPES,"followup_categories":FOLLOWUP_CATEGORIES,
            "cancellation_reasons":CANCELLATION_REASONS,"travel_modes":TRAVEL_MODES,
            "statuses":["Planned","In Progress","Completed","Cancelled","Postponed"],
            "modes":["In-Person","Phone","Video Call","Email"]}


# --- Team / Customers ---------------------------------------------------------

@router.get("/team-members")
def get_team_members(db: Session=Depends(get_tenant_db), cu: User=Depends(get_current_user)):
    return _get_all_assignable_users(cu, db)

@router.get("/plan-customers")
def get_plan_customers(user_id: Optional[int]=None, own_only: bool=False,
                       period: Optional[str]=None, view_type: Optional[str]=None, year: Optional[int]=None,
                       date_from: Optional[str]=None, date_to: Optional[str]=None,
                       db: Session=Depends(get_tenant_db), cu: User=Depends(get_current_user)):
    target_uid, target_role = cu.id, cu.role
    if user_id and user_id != cu.id:
        if user_id not in _get_team_uids(cu, db): raise HTTPException(403,"Not authorised")
        u = db.query(User).filter(User.id==user_id, User.is_active==True).first()
        if not u: raise HTTPException(404,"User not found")
        target_uid, target_role = u.id, u.role
    if date_from and date_to:
        d_from, d_to, _, _ = _resolve_360_window(period, view_type, year, date_from, date_to)
    else:
        d_from, d_to = _customer_window(period=period, view_type=view_type, year=year)
    if own_only:
        customer_ids = _customer_ids_for_uids([target_uid], db)
        if not customer_ids:
            return []
        custs = db.query(Customer).filter(
            Customer.id.in_(customer_ids),
            Customer.is_deleted == False,
        ).order_by(Customer.customer_name.asc()).all()
        return _enrich_customers_with_values(custs, db, scoped_uids=[target_uid], d_from=d_from, d_to=d_to)
    return _get_customers_for_user(target_uid, target_role, db, d_from=d_from, d_to=d_to)


@router.get("/pipeline-records")
def get_pipeline_records(
    kind: str,
    user_id: Optional[int] = None,
    member_ids: Optional[str] = None,
    customer_ids: Optional[str] = None,
    business_unit_id: Optional[str] = None,
    period: Optional[str] = None,
    view_type: Optional[str] = None,
    year: Optional[int] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    all_time: bool = False,
    customer_scope_only: bool = False,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("kam.view")),
):
    """Return popup rows using the same scoped datasets as the KAM KPI counts."""
    kind_key = str(kind or "").strip().lower()
    allowed = {"customers", "leads", "opportunities", "tenders", "workorders"}
    if kind_key not in allowed:
        raise HTTPException(400, "Unknown pipeline record kind")

    cid_filter: Optional[list[int]] = None
    if customer_ids:
        cid_filter = [int(x) for x in customer_ids.split(",") if x.strip().isdigit()]
    bu_filter = [int(x) for x in str(business_unit_id or "").split(",") if x.strip().isdigit()]

    d_from, d_to = (None, None) if all_time else _resolve_360_window(period, view_type, year, date_from, date_to)[:2]
    scope_uids = _kam_pipeline_scope_uids(cu, db, user_id=user_id, member_ids=member_ids)
    is_all_admin_scope = (
        not user_id
        and not _parse_member_ids_param(member_ids)
        and _kam_scope_is_all(cu, db)
    )
    if is_all_admin_scope:
        scope_uids = None
    if customer_scope_only:
        if cid_filter is None:
            raise HTTPException(400, "customer_ids are required")
        if scope_uids is not None:
            visible_customer_ids = _customer_ids_for_uids(scope_uids, db)
            if not set(cid_filter).issubset(visible_customer_ids):
                raise HTTPException(403, "Not authorised")
        record_scope_uids = None
    else:
        record_scope_uids = scope_uids

    if kind_key == "customers":
        if cid_filter is not None:
            custs = db.query(Customer).filter(
                Customer.id.in_(cid_filter),
                Customer.is_deleted == False,
            ).order_by(Customer.customer_name.asc()).all()
            return _enrich_customers_with_values(custs, db, scoped_uids=None, d_from=d_from, d_to=d_to)
        if is_all_admin_scope:
            custs = db.query(Customer).filter(
                Customer.is_deleted == False,
            ).order_by(Customer.customer_name.asc()).all()
            return _enrich_customers_with_values(custs, db, scoped_uids=None, d_from=d_from, d_to=d_to)

        scoped_cids = _customer_ids_for_uids(scope_uids, db)
        if not scoped_cids:
            return []
        custs = db.query(Customer).filter(
            Customer.id.in_(scoped_cids),
            Customer.is_deleted == False,
        ).order_by(Customer.customer_name.asc()).all()
        return _enrich_customers_with_values(custs, db, scoped_uids=scope_uids, d_from=d_from, d_to=d_to)

    if kind_key in {"leads", "opportunities"}:
        q = _kam_lead_records_query(db, record_scope_uids, d_from, d_to)
        if cid_filter is not None:
            q = q.filter(Lead.customer_id.in_(cid_filter))
        if bu_filter:
            q = q.filter(Lead.business_vertical_id.in_(bu_filter))
        if kind_key == "opportunities":
            q = q.filter(or_(
                Lead.lead_type == "direct_opportunity",
                Lead.status.in_(["Opportunity Created", "Converted"]),
            ))
        else:
            # "leads" = all lead-originated records regardless of current status
            # (Converted/Lost included) — total lead count for the segment, not
            # just the ones still open. direct_opportunity records are excluded
            # since those were created straight as opportunities, never as leads.
            q = q.filter(or_(
                Lead.lead_type.is_(None),
                Lead.lead_type != "direct_opportunity",
            ))
        rows_q = q.order_by(func.coalesce(Lead.lead_created_at, Lead.created_at).desc())
        rows = rows_q.all() if customer_scope_only else rows_q.limit(1000).all()
        users = _user_name_map(db, rows)
        # batch-fetch source names
        source_ids = {int(row.source_id) for row in rows if getattr(row, "source_id", None)}
        source_name_map: dict = {}
        if source_ids:
            for src in db.query(LeadSource).filter(LeadSource.id.in_(source_ids)).all():
                source_name_map[src.id] = src.name or ""
        def _opportunity_origin(row) -> str:
            lead_type = str(getattr(row, "lead_type", None) or "").strip().lower()
            return "direct" if lead_type == "direct_opportunity" else "from_lead"
        return [
            {
                "id": row.id,
                "lead_id": row.id,
                "lead_ref_id": getattr(row, "lead_ref_id", None),
                "opportunity_ref_id": getattr(row, "opportunity_ref_id", None),
                "lead_title": row.lead_title or "",
                "lead_name": row.lead_title or "",
                "customer_id": row.customer_id,
                "customer_name": row.customer_name or "",
                "status": row.status or "",
                "priority": row.priority or "",
                "lead_type": getattr(row, "lead_type", None),
                "opportunity_origin": _opportunity_origin(row),
                "est_value": float(row.est_value or 0),
                "lead_value": float(row.est_value or 0),
                "assigned_to": row.assigned_to,
                "assigned_to_name": users.get(int(row.assigned_to)) if row.assigned_to else "",
                "source_name": source_name_map.get(int(row.source_id), "") if getattr(row, "source_id", None) else "",
                "source": source_name_map.get(int(row.source_id), "") if getattr(row, "source_id", None) else "",
                "contact_person": getattr(row, "contact_person", None) or "",
                "mobile": getattr(row, "mobile", None) or "",
                "email": getattr(row, "email", None) or "",
                "timeline": getattr(row, "timeline", None) or "",
                "follow_up": row.follow_up.isoformat() if getattr(row, "follow_up", None) else None,
                "created_at": row.created_at.isoformat() if row.created_at else None,
                "lead_created_at": row.lead_created_at.isoformat() if row.lead_created_at else None,
            }
            for row in rows
        ]

    if kind_key == "tenders":
        tq = _kam_tender_records_query(db, record_scope_uids, d_from, d_to)
        if cid_filter is not None:
            lead_ids_for_customers = [
                int(row.id)
                for row in db.query(Lead.id).filter(
                    Lead.customer_id.in_(cid_filter),
                    Lead.is_deleted == False,
                ).all()
            ]
            tq = tq.filter(or_(
                Tender.customer_id.in_(cid_filter),
                Tender.lead_id.in_(lead_ids_for_customers or [-1]),
            ))
        if bu_filter:
            lead_ids_for_bu = [
                int(row.id)
                for row in db.query(Lead.id).filter(
                    Lead.business_vertical_id.in_(bu_filter),
                    Lead.is_deleted == False,
                ).all()
            ]
            direct_tender_filter = Tender.business_vertical_id.in_(bu_filter)
            linked_tender_filter = Tender.lead_id.in_(lead_ids_for_bu or [-1])
            if not lead_ids_for_bu:
                has_direct_tenders = db.query(Tender.id).filter(
                    Tender.is_deleted == False,
                    direct_tender_filter,
                ).first()
                if not has_direct_tenders:
                    return []
            tq = tq.filter(or_(
                direct_tender_filter,
                linked_tender_filter,
            ))
        rows_q = tq.order_by(Tender.created_at.desc())
        rows = rows_q.all() if customer_scope_only else rows_q.limit(1000).all()
        users = _user_name_map(db, rows)
        tender_lead_ids = {int(row.lead_id) for row in rows if getattr(row, "lead_id", None)}
        tender_lead_map: dict = {}
        if tender_lead_ids:
            for lead in db.query(
                Lead.id,
                Lead.lead_type,
                Lead.source_id,
                Lead.customer_id,
                Lead.customer_name,
            ).filter(Lead.id.in_(tender_lead_ids)).all():
                tender_lead_map[int(lead.id)] = {
                    "lead_type": lead.lead_type or "lead",
                    "source_id": lead.source_id,
                    "customer_id": lead.customer_id,
                    "customer_name": lead.customer_name or "",
                }
        source_ids = {
            int(source_id)
            for source_id in [
                *[getattr(row, "source_id", None) for row in rows],
                *[lead.get("source_id") for lead in tender_lead_map.values()],
            ]
            if source_id
        }
        source_name_map: dict = {}
        if source_ids:
            for src in db.query(LeadSource).filter(LeadSource.id.in_(source_ids)).all():
                source_name_map[src.id] = src.name or ""
        def _linked_lead(row) -> dict:
            lid = getattr(row, "lead_id", None)
            return tender_lead_map.get(int(lid), {}) if lid else {}
        def _tender_source_id(row):
            return getattr(row, "source_id", None) or _linked_lead(row).get("source_id")
        def _tender_customer_id(row):
            return getattr(row, "customer_id", None) or _linked_lead(row).get("customer_id")
        def _tender_customer_name(row) -> str:
            return getattr(row, "customer_name", None) or _linked_lead(row).get("customer_name") or ""
        def _tender_origin(row) -> str:
            lid = getattr(row, "lead_id", None)
            if not lid:
                return "direct"
            lt = _linked_lead(row).get("lead_type", "lead")
            return "from_opportunity" if lt == "direct_opportunity" else "from_lead"
        return [
            {
                "id": row.id,
                "tender_id": row.id,
                "tender_num": row.tender_num or "",
                "portal_ref_number": row.portal_ref_number or row.tender_num or "",
                "tender_title": row.tender_title or "",
                "customer_id": _tender_customer_id(row),
                "customer_name": _tender_customer_name(row),
                "tender_status": row.tender_status or "",
                "result": row.result or "",
                "est_value": float(row.est_value or 0),
                "bid_amount": float(row.bid_amount or 0),
                "assigned_to": row.assigned_to,
                "assigned_to_name": users.get(int(row.assigned_to)) if row.assigned_to else "",
                "lead_id": getattr(row, "lead_id", None),
                "source_id": tender_source_id,
                "source_name": source_name_map.get(int(tender_source_id), "") if tender_source_id else "",
                "source": source_name_map.get(int(tender_source_id), "") if tender_source_id else "",
                "source_portal": str(getattr(row, "source_portal", None) or ""),
                "tender_origin": _tender_origin(row),
                "result_date": row.result_date.isoformat() if row.result_date else None,
                "submission_date": row.submission_date.isoformat() if row.submission_date else None,
                "published_date": row.published_date.isoformat() if row.published_date else None,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in rows
            for tender_source_id in [_tender_source_id(row)]
        ]

    woq = _kam_workorder_records_query(db, record_scope_uids, d_from, d_to)
    if cid_filter is not None:
        lead_ids_for_customers = [
            int(row.id)
            for row in db.query(Lead.id).filter(
                Lead.customer_id.in_(cid_filter),
                Lead.is_deleted == False,
            ).all()
        ]
        tender_ids_for_customers = [
            int(row.id)
            for row in db.query(Tender.id).filter(
                Tender.is_deleted == False,
                or_(
                    Tender.customer_id.in_(cid_filter),
                    Tender.lead_id.in_(lead_ids_for_customers or [-1]),
                ),
            ).all()
        ]
        woq = woq.filter(or_(
            WorkOrder.customer_id.in_(cid_filter),
            WorkOrder.lead_id.in_(lead_ids_for_customers or [-1]),
            WorkOrder.tender_id.in_(tender_ids_for_customers or [-1]),
        ))
    if bu_filter:
        lead_ids_for_bu = [
            int(row.id)
            for row in db.query(Lead.id).filter(
                Lead.business_vertical_id.in_(bu_filter),
                Lead.is_deleted == False,
            ).all()
        ]
        tender_ids_for_bu = [
            int(row.id)
            for row in db.query(Tender.id).filter(
                Tender.is_deleted == False,
                or_(
                    Tender.business_vertical_id.in_(bu_filter),
                    Tender.lead_id.in_(lead_ids_for_bu or [-1]),
                ),
            ).all()
        ]
        if not lead_ids_for_bu and not tender_ids_for_bu:
            return []
        woq = woq.filter(or_(
            WorkOrder.lead_id.in_(lead_ids_for_bu or [-1]),
            WorkOrder.tender_id.in_(tender_ids_for_bu or [-1]),
        ))
    rows_q = woq.order_by(WorkOrder.po_date.desc(), WorkOrder.created_at.desc())
    rows = rows_q.all() if customer_scope_only else rows_q.limit(1000).all()
    users = _user_name_map(db, rows)
    tender_context: dict[int, dict] = {}
    lead_context: dict[int, dict] = {}
    tender_ids = {int(row.tender_id) for row in rows if getattr(row, "tender_id", None)}
    if tender_ids:
        tender_context = {
            int(t.id): {
                "customer_id": getattr(t, "customer_id", None),
                "customer_name": getattr(t, "customer_name", None) or "",
                "lead_id": getattr(t, "lead_id", None),
                "source_id": getattr(t, "source_id", None),
                "source_portal": str(getattr(t, "source_portal", None) or ""),
            }
            for t in db.query(Tender).filter(Tender.id.in_(tender_ids)).all()
        }
    lead_ids = {
        int(lead_id)
        for lead_id in [
            *(getattr(row, "lead_id", None) for row in rows),
            *(ctx.get("lead_id") for ctx in tender_context.values()),
        ]
        if lead_id
    }
    if lead_ids:
        lead_context = {
            int(lead.id): {
                "customer_id": getattr(lead, "customer_id", None),
                "customer_name": getattr(lead, "customer_name", None) or "",
                "source_id": getattr(lead, "source_id", None),
            }
            for lead in db.query(Lead).filter(Lead.id.in_(lead_ids)).all()
        }
    source_ids = {
        int(source_id)
        for source_id in [
            *(ctx.get("source_id") for ctx in tender_context.values()),
            *(ctx.get("source_id") for ctx in lead_context.values()),
        ]
        if source_id
    }
    source_name_map: dict = {}
    if source_ids:
        for src in db.query(LeadSource).filter(LeadSource.id.in_(source_ids)).all():
            source_name_map[src.id] = src.name or ""
    def _wo_link_context(row) -> tuple[dict, dict]:
        tender_ctx = tender_context.get(int(row.tender_id)) if getattr(row, "tender_id", None) else {}
        lead_id = getattr(row, "lead_id", None) or tender_ctx.get("lead_id")
        lead_ctx = lead_context.get(int(lead_id)) if lead_id else {}
        return tender_ctx, lead_ctx
    def _wo_customer_id(row) -> Optional[int]:
        tender_ctx, lead_ctx = _wo_link_context(row)
        return getattr(row, "customer_id", None) or tender_ctx.get("customer_id") or lead_ctx.get("customer_id")
    def _wo_customer_name(row) -> str:
        tender_ctx, lead_ctx = _wo_link_context(row)
        return getattr(row, "customer_name", None) or tender_ctx.get("customer_name") or lead_ctx.get("customer_name") or ""
    def _wo_source_id(row):
        tender_ctx, lead_ctx = _wo_link_context(row)
        return tender_ctx.get("source_id") or lead_ctx.get("source_id")
    def _wo_source_portal(row) -> str:
        tender_ctx, _ = _wo_link_context(row)
        return tender_ctx.get("source_portal") or ""
    return [
        {
            "id": row.id,
            "work_order_id": row.id,
            "wrk_order_id": row.wo_number or row.po_number or "",
            "po_num": row.po_number or "",
            "project_title": row.project_title or "",
            "tender_title": row.project_title or "",
            "customer_id": _wo_customer_id(row),
            "customer_name": _wo_customer_name(row),
            "lead_id": getattr(row, "lead_id", None),
            "tender_id": getattr(row, "tender_id", None),
            "portal_ref_number": row.wo_number or row.po_number or "",
            "wo_status": row.status or "",
            "result": row.status or "",
            "wo_value": float(row.wo_value or row.po_value or 0),
            "bid_amount": float(row.po_value or 0),
            "assigned_to": row.project_manager_id,
            "assigned_to_name": users.get(int(row.project_manager_id)) if row.project_manager_id else "",
            "source_id": work_order_source_id,
            "source_name": source_name_map.get(int(work_order_source_id), "") if work_order_source_id else "",
            "source": source_name_map.get(int(work_order_source_id), "") if work_order_source_id else "",
            "source_portal": _wo_source_portal(row),
            "result_date": row.po_date.isoformat() if row.po_date else None,
            "created_at": row.created_at.isoformat() if row.created_at else None,
        }
        for row in rows
        for work_order_source_id in [_wo_source_id(row)]
    ]

# --- Activities CRUD ----------------------------------------------------------

@router.get("/activities")
def list_activities(user_id: Optional[int]=None, activity_type: Optional[str]=None,
                    status: Optional[str]=None, date_from: Optional[str]=None,
                    date_to: Optional[str]=None, customer_id: Optional[int]=None,
                    activity_date: Optional[str]=None, lead_id: Optional[int]=None,
                    db: Session=Depends(get_tenant_db), cu: User=Depends(require_permission("kam.view"))):
    if lead_id:
        # Anyone with a valid session can see activities tied to a specific lead
        q = db.query(KAMActivity).filter(KAMActivity.lead_id==lead_id)
    else:
        uids = _get_visible_uids(cu, db, requested_uid=user_id)
        q = db.query(KAMActivity).filter(KAMActivity.user_id.in_(uids))
    if activity_type:
        db_activity_type = _normalize_activity_type(activity_type)
        type_filters = [KAMActivity.activity_type==db_activity_type]
        if db_activity_type != activity_type:
            type_filters.append(KAMActivity.activity_type==activity_type)
        q=q.filter(or_(*type_filters))
        if activity_type == "Video Call":
            q=q.filter(or_(KAMActivity.mode=="Video Call", KAMActivity.activity_type=="Video Call"))
        elif activity_type == "Phone Call":
            q=q.filter(or_(KAMActivity.mode=="Phone", KAMActivity.mode.is_(None), KAMActivity.activity_type=="Phone Call"))
    if status:        q=q.filter(KAMActivity.status==status)
    if activity_date: q=q.filter(KAMActivity.activity_date==activity_date)
    if date_from:     q=q.filter(KAMActivity.activity_date>=date_from)
    if date_to:       q=q.filter(KAMActivity.activity_date<=date_to)
    if customer_id:   q=q.filter(KAMActivity.customer_id==customer_id)
    rows = q.order_by(KAMActivity.activity_date.desc(), KAMActivity.created_at.desc()).all()
    user_map, customer_map, travel_request_map, lead_map, tender_map = _activity_context_maps(db, rows)
    return [
        _enrich_activity(
            r,
            db,
            user_map=user_map,
            customer_map=customer_map,
            travel_request_map=travel_request_map,
            lead_map=lead_map,
            tender_map=tender_map,
        )
        for r in rows
    ]


@router.get("/visit-coverage")
def get_visit_coverage(
    user_id: Optional[int] = None,
    activity_type: Optional[str] = None,
    customer_id: Optional[int] = None,
    period: Optional[str] = None,
    view_type: Optional[str] = None,
    year: Optional[int] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    status_mode: str = Query("completed", description="completed or all"),
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("kam.view")),
):
    d_from, d_to, _, _ = _resolve_360_window(period, view_type, year, date_from, date_to)
    scoped_user_ids = _get_visible_uids(cu, db, requested_uid=user_id)
    coverage_mode = _visit_coverage_status_mode(status_mode)

    q = db.query(KAMActivity).filter(KAMActivity.user_id.in_(scoped_user_ids))
    if activity_type:
        db_activity_type = _normalize_activity_type(activity_type)
        type_filters = [KAMActivity.activity_type == db_activity_type]
        if db_activity_type != activity_type:
            type_filters.append(KAMActivity.activity_type == activity_type)
        q = q.filter(or_(*type_filters))
    if customer_id:
        q = q.filter(KAMActivity.customer_id == customer_id)
    if d_from:
        q = q.filter(KAMActivity.activity_date >= d_from)
    if d_to:
        q = q.filter(KAMActivity.activity_date <= d_to)
    if coverage_mode == "completed":
        q = q.filter(KAMActivity.status == "Completed")

    activities = q.order_by(
        KAMActivity.activity_date.desc(),
        KAMActivity.created_at.desc(),
        KAMActivity.id.desc(),
    ).all()
    user_map, customer_map, _, _, _ = _activity_context_maps(db, activities)
    activity_ids = [int(activity.id) for activity in activities if activity.id]
    logs_by_activity: dict[int, list[KAMLog]] = defaultdict(list)
    if activity_ids:
        log_rows = (
            db.query(KAMLog)
            .filter(
                KAMLog.activity_id.in_(activity_ids),
                KAMLog.latitude.isnot(None),
                KAMLog.longitude.isnot(None),
            )
            .order_by(KAMLog.activity_id.asc(), KAMLog.event_at.asc(), KAMLog.id.asc())
            .all()
        )
        for log in log_rows:
            logs_by_activity[int(log.activity_id)].append(log)

    global_unique_locations: set[str] = set()
    summary = {
        "activities": 0,
        "total_activities": 0,
        "completed_activities": 0,
        "gps_logs": 0,
        "gps_activities": 0,
        "unique_locations": 0,
    }

    rows_payload: list[dict[str, Any]] = []
    for activity in activities:
        summary["total_activities"] += 1
        if str(activity.status or "").strip() == "Completed":
            summary["completed_activities"] += 1

        user_id_value = int(activity.user_id) if activity.user_id else None
        user_row = user_map.get(user_id_value) if user_id_value else None
        employee_name = (
            getattr(user_row, "full_name", None)
            or getattr(user_row, "username", None)
            or "Unassigned"
        )
        customer_row = customer_map.get(int(activity.customer_id)) if activity.customer_id else None
        customer_name = getattr(customer_row, "customer_name", None) or ""

        route_points = []
        unique_locations_for_activity: set[str] = set()
        start_bucket = _visit_coverage_bucket(activity.latitude, activity.longitude)
        if start_bucket:
            start_latitude, start_longitude = start_bucket
            start_location_key = f"{start_latitude:.4f}:{start_longitude:.4f}"
            unique_locations_for_activity.add(start_location_key)
            global_unique_locations.add(start_location_key)
            summary["gps_logs"] += 1
            route_points.append({
                "id": -int(activity.id),
                "sequence": 1,
                "group_key": f"{int(activity.id)}::start",
                "latitude": start_latitude,
                "longitude": start_longitude,
                "event_type": "ACTIVITY_STARTED",
                "event_at": activity.created_at.isoformat() if getattr(activity, "created_at", None) else "",
                "activity_date": str(activity.activity_date or ""),
                "start_time": _activity_time_label(getattr(activity, "start_time", None)),
                "end_time": _activity_time_label(getattr(activity, "end_time", None)),
                "status": str(activity.status or ""),
                "customer_name": customer_name,
                "subject": str(activity.subject or ""),
                "activity_type": str(activity.activity_type or ""),
                "location": str(getattr(activity, "location", None) or ""),
                "remarks": "",
            })
        for index, log in enumerate(logs_by_activity.get(int(activity.id), []), start=len(route_points) + 1):
            bucket = _visit_coverage_bucket(log.latitude, log.longitude)
            if not bucket:
                continue
            latitude, longitude = bucket
            location_key = f"{latitude:.4f}:{longitude:.4f}"
            unique_locations_for_activity.add(location_key)
            global_unique_locations.add(location_key)
            summary["gps_logs"] += 1
            route_points.append({
                "id": int(log.id),
                "sequence": index,
                "group_key": f"{int(activity.id)}::{int(log.id)}",
                "latitude": latitude,
                "longitude": longitude,
                "event_type": str(log.event_type or ""),
                "event_at": log.event_at.isoformat() if getattr(log, "event_at", None) else "",
                "activity_date": str(activity.activity_date or ""),
                "start_time": _activity_time_label(getattr(activity, "start_time", None)),
                "end_time": _activity_time_label(getattr(activity, "end_time", None)),
                "status": str(activity.status or ""),
                "customer_name": customer_name,
                "subject": str(activity.subject or ""),
                "activity_type": str(activity.activity_type or ""),
                "location": str(getattr(log, "address", None) or getattr(activity, "location", None) or ""),
                "remarks": str(getattr(log, "remarks", None) or ""),
            })

        if route_points:
            summary["gps_activities"] += 1

        rows_payload.append({
            "key": f"activity::{int(activity.id)}",
            "activity_id": int(activity.id),
            "user_id": user_id_value,
            "employee_name": employee_name,
            "customer_name": customer_name,
            "activity_type": str(activity.activity_type or ""),
            "subject": str(activity.subject or ""),
            "activity_date": str(activity.activity_date or ""),
            "status": str(activity.status or ""),
            "gps_logs": len(route_points),
            "unique_locations": len(unique_locations_for_activity),
            "route": route_points,
        })

    rows_payload.sort(key=lambda item: (
        -int(item["gps_logs"]),
        str(item["activity_date"] or ""),
        str(item["subject"] or "").lower(),
    ))
    summary["activities"] = len(rows_payload)
    summary["unique_locations"] = len(global_unique_locations)

    return {
        "summary": summary,
        "rows": rows_payload,
        "filters": {
            "status_mode": coverage_mode,
            "date_from": d_from,
            "date_to": d_to,
            "user_id": user_id,
            "customer_id": customer_id,
            "activity_type": activity_type or "",
        },
    }

@router.post("/activities/{activity_id}/upload-document", status_code=200)
async def upload_activity_document(
    activity_id: int,
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("kam.update")),
):
    act = db.query(KAMActivity).filter(KAMActivity.id==activity_id).first()
    if not act:
        raise HTTPException(404, "Not found")
    if act.user_id not in _get_visible_uids(cu,db):
        raise HTTPException(403, "Not authorised")
    contents = await file.read()
    if not contents:
        raise HTTPException(400, "Uploaded file is empty")
    url, size_kb = _save_kam_document(request, file, contents)
    return {
        "document_url": url,
        "document_name": file.filename or url.rsplit("/", 1)[-1],
        "document_size_kb": size_kb,
    }

@router.get("/activities/{activity_id}")
def get_activity(activity_id: int, db: Session=Depends(get_tenant_db), cu: User=Depends(require_permission("kam.view"))):
    act = db.query(KAMActivity).filter(KAMActivity.id==activity_id).first()
    if not act: raise HTTPException(404,"Not found")
    if act.user_id not in _get_visible_uids(cu,db): raise HTTPException(403,"Not authorised")
    return _enrich_activity(act,db,include_reopen_info=True)

@router.post("/activities", status_code=201)
def create_activity(data: ActivityCreate, request: Request, db: Session=Depends(get_tenant_db), cu: User=Depends(require_permission("kam.create"))):
    db_activity_type = _normalize_activity_type(data.activity_type)
    db_mode = _activity_mode_for_type(data.activity_type, data.mode)
    act_uid = _resolve_scoped_user_id(cu, db, data.on_behalf_of, "create for")
    if data.status=="Completed" and not (data.outcome or "").strip(): raise HTTPException(400,"Outcome required")
    if data.status=="Cancelled" and not (data.cancellation_reason or "").strip(): raise HTTPException(400,"Cancellation reason required")
    if data.status in ("Postponed","Cancelled") and not (data.description or "").strip(): raise HTTPException(400,"Remarks required")
    u = db.query(User).filter(User.id==act_uid).first()
    vcols = _valid_cols(KAMActivity)
    kw = dict(user_id=act_uid, user_role=u.role if u else None,
              on_behalf_of=act_uid if act_uid != int(cu.id) else None,
              activity_type=db_activity_type, customer_id=data.customer_id,
              lead_id=data.lead_id, tender_id=data.tender_id,
              work_order_id=data.work_order_id, emdbg_id=data.emdbg_id,
              subject=data.subject,
              description=_none(data.description), activity_date=data.activity_date,
              start_time=_time_or_none(data.start_time), duration_minutes=data.duration_minutes,
              location=_none(data.location), latitude=data.latitude, longitude=data.longitude,
              mode=db_mode, status=data.status,
              outcome=_none(data.outcome), next_action=_none(data.next_action),
              next_action_date=data.next_action_date, contacts_met=_contacts_to_db(data.contacts_met),
              cancellation_reason=_none(data.cancellation_reason),
              document_url=_none(data.document_url), document_name=_none(data.document_name),
              document_size_kb=data.document_size_kb,
              followup_category=_none(data.followup_category), followup_sub_type=_none(data.followup_sub_type),
              has_travel=data.has_travel, travel_mode=_none(data.travel_mode),
              travel_from=_none(data.travel_from), travel_to=_none(data.travel_to),
              is_outside_district=data.is_outside_district,
              travel_approved=None if not data.has_travel else (None if data.is_outside_district else True),
              created_by=cu.id)
    act = KAMActivity(**{k:v for k,v in kw.items() if k in vcols})
    db.add(act); db.flush()

    created_at_ts = now_ist()
    db.add(KAMActivityExecutionCycle(
        activity_id=act.id, cycle_no=1,
        status=act.status if act.status in ("In Progress", "Completed") else "Open",
        opened_at=created_at_ts, opened_by=cu.id,
        started_at=created_at_ts if act.status == "In Progress" else None,
        completed_at=created_at_ts if act.status == "Completed" else None,
        completed_by=cu.id if act.status == "Completed" else None,
        completion_outcome=act.outcome if act.status == "Completed" else None,
    ))
    created_log_values = {}
    if act.outcome:
        created_log_values["outcome"] = act.outcome
    if act.cancellation_reason:
        created_log_values["cancellation_reason"] = act.cancellation_reason
    if act.description:
        created_log_values["description"] = act.description
    log_kam_activity(
        db, activity_id=act.id, event_type="ACTIVITY_CREATED", cycle_no=1,
        actor=cu, new_status=act.status, source="web", request=request,
        new_values=created_log_values or None,
        latitude=act.latitude, longitude=act.longitude,
    )

    travel_req = None
    if data.has_travel and data.is_outside_district and "travel_request_id" in vcols:
        TR_EXTRA_KEYS = [
            "tr_travel_date","travel_from","travel_to",
            "tr_visit_type","tr_return_date","tr_transport_mode","tr_vehicle_number",
            "tr_estimated_kms","tr_advance_booking_ref","tr_estimated_cost",
            "tr_advance_required","tr_advance_amount","tr_accommodation_required",
            "tr_accommodation_type","tr_hotel_name","tr_check_in_date","tr_check_out_date",
            "tr_accommodation_cost","tr_companions","tr_contact_name","tr_contact_phone","tr_notes",
            "tr_opportunity_id","tr_lead_id","tr_tender_id",
        ]
        tr_extra = {k: getattr(data, k) for k in TR_EXTRA_KEYS if hasattr(data, k) and getattr(data, k) is not None}
        travel_req = _auto_travel_request(
            db,
            act,
            cu,
            data.is_outside_district,
            extra=tr_extra,
            tenant_id=_get_tenant_id(request),
        )
        act.travel_request_id = travel_req.id
    db.add(ActivityLog(user_id=cu.id,module="kam",record_id=act.id,action="created",
                       description=f"KAM {_activity_type_name(db_activity_type, db_mode)}: {data.subject}",icon="📌",color="#EFF6FF"))
    db.commit(); db.refresh(act)
    result = _enrich_activity(act,db)
    if travel_req:
        result["auto_travel_request_id"] = travel_req.id
        result["auto_travel_request_number"] = travel_req.request_number
        result["travel_request_message"] = (f"Travel request {travel_req.request_number} created. "
            + ("Submit for manager approval." if data.is_outside_district else "Local travel recorded."))
    return result

@router.patch("/activities/{activity_id}")
def update_activity(activity_id: int, data: ActivityUpdate, request: Request, db: Session=Depends(get_tenant_db), cu: User=Depends(require_permission("kam.update"))):
    act = db.query(KAMActivity).filter(KAMActivity.id==activity_id).with_for_update().first()
    if not act: raise HTTPException(404,"Not found")
    if act.user_id not in _get_visible_uids(cu,db): raise HTTPException(403,"Not authorised")
    previous_status = act.status
    if data.status=="Reopened":
        raise HTTPException(400,"Use POST /activities/{activity_id}/reopen to reopen an activity")
    if previous_status=="Completed":
        raise HTTPException(400,"Completed activities cannot be edited. Reopen the activity before making changes.")
    if data.status=="Completed" and not (data.outcome or _safe_get(act,"outcome") or "").strip():
        raise HTTPException(400,"Outcome required")
    if data.status=="Cancelled" and not (data.cancellation_reason or _safe_get(act,"cancellation_reason") or "").strip():
        raise HTTPException(400,"Cancellation reason required")
    if data.status in ("Postponed","Cancelled") and not (data.description or "").strip():
        raise HTTPException(400,"Remarks required")
    vcols = _valid_cols(KAMActivity)
    existing_tr_id = _safe_get(act,"travel_request_id")
    updates = data.model_dump(exclude_unset=True)
    is_completing = data.status == "Completed"
    # When completing, status is applied by complete_activity_cycle() below (together with
    # the cycle/event bookkeeping) rather than by the generic setattr loop.
    apply_updates = {k: v for k, v in updates.items() if k != "status"} if is_completing else dict(updates)
    old_values = {f: _safe_get(act, f) for f in apply_updates if f in vcols}
    incoming_activity_type = apply_updates.get("activity_type")
    if incoming_activity_type:
        apply_updates["activity_type"] = _normalize_activity_type(incoming_activity_type)
        apply_updates["mode"] = _activity_mode_for_type(
            apply_updates["activity_type"],
            apply_updates.get("mode") or _safe_get(act, "mode")
        )
    for f,v in apply_updates.items():
        if f not in vcols: continue
        if f=="start_time": v=_time_or_none(v)
        if v is not None: setattr(act,f,v)
    act.updated_at = now_ist()
    changed_fields = [f for f, old in old_values.items() if old != _safe_get(act, f)]
    has_location = data.latitude is not None and data.longitude is not None
    if is_completing:
        other_changed = [f for f in changed_fields if f != "outcome"]
        complete_activity_cycle(
            db, act, cu, notes=data.description or _safe_get(act,"description"), outcome=data.outcome or _safe_get(act,"outcome"),
            extra_old_values={f: old_values[f] for f in other_changed},
            extra_new_values={f: _safe_get(act, f) for f in other_changed},
            latitude=data.latitude, longitude=data.longitude, source="web", request=request,
        )
    elif changed_fields or has_location:
        log_remarks = data.description or None
        log_kam_activity(
            db, activity_id=act.id, event_type="ACTIVITY_UPDATED", cycle_no=act.current_cycle_no,
            actor=cu, old_values={f: old_values[f] for f in changed_fields},
            new_values={f: _safe_get(act, f) for f in changed_fields},
            remarks=log_remarks,
            latitude=data.latitude, longitude=data.longitude,
            source="web", request=request,
        )
    has_travel_now = updates.get("has_travel",_safe_get(act,"has_travel",False))
    tr_id = _safe_get(act,"travel_request_id")
    explicit_tr_link = "travel_request_id" in updates and updates.get("travel_request_id") != existing_tr_id
    # Collect the extra travel detail fields submitted by the frontend
    TR_EXTRA_KEYS = [
        "tr_travel_date","travel_from","travel_to",
        "tr_visit_type","tr_return_date","tr_transport_mode","tr_vehicle_number",
        "tr_estimated_kms","tr_advance_booking_ref","tr_estimated_cost",
        "tr_advance_required","tr_advance_amount","tr_accommodation_required",
        "tr_accommodation_type","tr_hotel_name","tr_check_in_date","tr_check_out_date",
        "tr_accommodation_cost","tr_companions","tr_contact_name","tr_contact_phone","tr_notes",
        "tr_opportunity_id","tr_lead_id","tr_tender_id",
    ]
    tr_extra = {k: updates[k] for k in TR_EXTRA_KEYS if k in updates}
    if has_travel_now and "travel_request_id" in vcols:
        is_outside = updates.get("is_outside_district",_safe_get(act,"is_outside_district",False))
        if explicit_tr_link:
            # User linked an existing TR — already set on act via the loop above; skip auto-create
            if tr_extra:
                existing_tr = db.query(TravelRequest).filter(TravelRequest.id==tr_id).first()
                if existing_tr and existing_tr.status in ("Draft","Rejected"):
                    _update_travel_request_details(existing_tr, tr_extra)
        elif not tr_id and is_outside:
            # Auto-create only when outside district and no TR linked yet (create mode)
            tr = _auto_travel_request(
                db,
                act,
                cu,
                is_outside,
                extra=tr_extra,
                tenant_id=_get_tenant_id(request),
            )
            act.travel_request_id = tr.id
            tr_id = tr.id
        else:
            # Update existing travel request with enriched details if provided
            if tr_extra:
                existing_tr = db.query(TravelRequest).filter(TravelRequest.id==tr_id).first()
                if existing_tr and existing_tr.status in ("Draft","Rejected"):
                    _update_travel_request_details(existing_tr, tr_extra)
    next_act_created = False
    nad = data.next_action_date or _safe_get(act,"next_action_date")
    nat = data.next_action or _safe_get(act,"next_action")
    if nad and nat:
        if not db.query(KAMActivity).filter(KAMActivity.user_id==act.user_id,
            KAMActivity.customer_id==act.customer_id, KAMActivity.activity_date==str(nad),
            KAMActivity.subject==nat, KAMActivity.status=="Planned").first():
            db.add(KAMActivity(**{k:v for k,v in dict(user_id=act.user_id,activity_type=act.activity_type,
                customer_id=act.customer_id,subject=nat,activity_date=str(nad),status="Planned",
                description=f"Follow-up from #{act.id}: {act.subject}",created_by=cu.id).items() if k in vcols}))
            next_act_created = True
    db.add(ActivityLog(user_id=cu.id,module="kam",record_id=act.id,action="updated",
                       description=f"Updated — {data.status or act.status}",icon="📌",color="#F0FDF4"))
    db.commit(); db.refresh(act)
    result = _enrich_activity(act,db)
    result["follow_up_created"] = next_act_created
    # Include travel request info so frontend can show submit banner
    final_tr_id = _safe_get(act,"travel_request_id")
    if final_tr_id:
        final_tr = db.query(TravelRequest).filter(TravelRequest.id==final_tr_id).first()
        if final_tr:
            result["auto_travel_request_id"] = final_tr.id
            result["auto_travel_request_number"] = final_tr.request_number
            is_out = _safe_get(act,"is_outside_district",False)
            result["travel_request_message"] = (
                f"Travel request {final_tr.request_number} ready. "
                + ("Submit for manager approval." if is_out else "Local travel recorded.")
            )
    return result

@router.delete("/activities/{activity_id}")
def delete_activity(activity_id: int, db: Session=Depends(get_tenant_db), cu: User=Depends(require_permission("kam.delete"))):
    act = db.query(KAMActivity).filter(KAMActivity.id==activity_id).first()
    if not act: raise HTTPException(404,"Not found")
    team_uids = _get_team_uids(cu, db)
    if act.user_id not in team_uids or (act.user_id != cu.id and len(team_uids) <= 1):
        raise HTTPException(403,"Not authorised")
    db.delete(act); db.commit()
    return {"message":"Deleted"}

@router.post("/activities/bulk", status_code=201)
def bulk_create_activities(
    items: List[BulkPlanItem],
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("kam.create")),
):
    vcols = _valid_cols(KAMActivity)
    team_uids = _get_team_uids(cu, db)
    created = []

    for item in items:
        if item.on_behalf_of and int(item.on_behalf_of) not in team_uids:
            raise HTTPException(403, f"Cannot assign to {item.on_behalf_of}")
        act_uid = int(item.on_behalf_of) if item.on_behalf_of else int(cu.id)

        u = db.query(User).filter(User.id == act_uid).first()

        db_activity_type = _normalize_activity_type(item.activity_type)
        db_mode = _activity_mode_for_type(item.activity_type, item.mode)

        act = KAMActivity(**{
            k: v for k, v in dict(
                user_id=act_uid,
                user_role=u.role if u else None,
                on_behalf_of=act_uid if act_uid != int(cu.id) else None,
                activity_type=db_activity_type,
                customer_id=item.customer_id,
                lead_id=item.lead_id,
                tender_id=item.tender_id,
                work_order_id=item.work_order_id,
                emdbg_id=item.emdbg_id,
                subject=item.subject,
                activity_date=item.activity_date,
                start_time=_time_or_none(item.start_time),
                duration_minutes=item.duration_minutes,
                latitude=item.latitude,
                longitude=item.longitude,
                status="Planned",
                mode=db_mode,
                has_travel=False,
                is_outside_district=False,
                created_by=cu.id,
            ).items()
            if k in vcols
        })

        db.add(act)
        created.append(act)

    db.commit()

    return [_enrich_activity(a, db) for a in created]


# --- Travel submit ------------------------------------------------------------

@router.post("/travel-requests/{request_id}/submit")
def submit_travel_request(request_id: int, request: Request, data: Optional[TravelSubmitIn] = None, db: Session=Depends(get_tenant_db), cu: User=Depends(get_current_user)):
    tr = db.query(TravelRequest).filter(TravelRequest.id==request_id).first()
    if not tr: raise HTTPException(404,"Not found")
    if tr.employee_id != cu.id and tr.employee_id not in _get_team_uids(cu, db): raise HTTPException(403,"Not authorised")
    if tr.status not in ("Draft", "Rejected"):
        raise HTTPException(400, f"Cannot submit from status: {tr.status}")
    requester = db.query(User).filter(User.id == tr.employee_id).first()
    if not requester:
        raise HTTPException(404, "Requester not found")
    response = submit_travel_request_with_policy(
        db,
        tr,
        actor=cu,
        requester=requester,
        tenant_id=_get_tenant_id(request),
    )
    db.commit()
    return response


# --- Targets ------------------------------------------------------------------

@router.get("/targets")
def list_targets(user_id: Optional[int]=None, period: Optional[str]=None,
                 db: Session=Depends(get_tenant_db), cu: User=Depends(require_permission("kam.view"))):
    uids = _get_visible_uids(cu,db,requested_uid=user_id)
    q = db.query(KAMTarget).filter(KAMTarget.user_id.in_(uids))
    if period: q=q.filter(KAMTarget.period==period)
    rows = q.all()
    vcols = _valid_cols(KAMTarget)
    result = []
    for t in rows:
        d = {c.name:getattr(t,c.name) for c in t.__table__.columns}
        d["sales_target"] = float(getattr(t,"sales_target",0) or 0)
        result.append(d)
    return result


@router.post("/targets", status_code=201)
def set_target(data: TargetCreate, db: Session=Depends(get_tenant_db), cu: User=Depends(require_permission("kam.update"))):
    """Set activity + rupee sales targets for users in the caller's hierarchy scope."""
    _ensure_kam_target_identity_columns(db)
    team_uids = _get_team_uids(cu, db)
    if len(team_uids) <= 1:
        raise HTTPException(403,"Team hierarchy required to set targets")
    if data.user_id not in team_uids:
        raise HTTPException(403,"Cannot set target for this user")
    user = db.query(User).filter(User.id==data.user_id, User.is_active==True).first()
    if not user:
        raise HTTPException(404,"User not found")
    existing_row = db.query(KAMTarget.id, KAMTarget.sales_target).filter(
        KAMTarget.user_id == data.user_id,
        KAMTarget.period == data.period,
    ).first()
    vcols = _valid_cols(KAMTarget)
    payload = {k:v for k,v in data.model_dump().items() if k in vcols}
    target_mode = str(getattr(data, "target_mode", "replace") or "replace").strip().lower()
    incoming_sales_target = Decimal(str(data.sales_target or 0))
    if target_mode == "add":
        if existing_row:
            current_sales_target = Decimal(str(existing_row.sales_target or 0))
        elif str(data.period).isdigit() and len(str(data.period)) == 4:
            monthly_targets = db.query(KAMTarget).filter(
                KAMTarget.user_id == data.user_id,
                KAMTarget.period.like(f"{data.period}-%"),
            ).all()
            current_sales_target = Decimal(str(sum(float(getattr(t, "sales_target", 0) or 0) for t in monthly_targets)))
            if current_sales_target <= 0:
                current_sales_target = Decimal(str(getattr(user, "target", None) or 0))
        else:
            current_sales_target = Decimal("0")
        sales_target_value = current_sales_target + incoming_sales_target
    else:
        sales_target_value = incoming_sales_target
    payload["sales_target"] = sales_target_value
    # Keep the user master target in sync with the latest KAM sales target.
    user.target = sales_target_value if sales_target_value > 0 else None
    if existing_row:
        if target_mode == "add":
            payload = {"sales_target": sales_target_value}
        db.query(KAMTarget).filter(
            KAMTarget.user_id == data.user_id,
            KAMTarget.period == data.period,
        ).update(payload, synchronize_session=False)
        db.commit()
        return {
            "id": existing_row.id,
            "user_id": data.user_id,
            "period": data.period,
            "sales_target": float(sales_target_value),
        }
    t = KAMTarget(**{**payload,"created_by":cu.id})
    db.add(t)
    db.flush()
    target_id = t.id
    db.commit()
    return {
        "id": target_id,
        "user_id": data.user_id,
        "period": data.period,
        "sales_target": float(sales_target_value),
    }


def _ensure_kam_target_identity_columns(db: Session) -> None:
    """Repair older tenant schemas where target id columns missed AUTO_INCREMENT."""
    for table_name in ("kam_targets", "kam_group_targets"):
        row = db.execute(sa_text(f"SHOW COLUMNS FROM {table_name} LIKE 'id'")).mappings().first()
        extra = str(row.get("Extra") or "").lower() if row else ""
        if "auto_increment" not in extra:
            db.execute(sa_text(f"ALTER TABLE {table_name} MODIFY COLUMN id INT NOT NULL AUTO_INCREMENT"))


def _scoped_target_group_members(group_id: int, cu: User, db: Session):
    group_node = db.query(OrgTreeNode).filter(
        OrgTreeNode.id == group_id,
        OrgTreeNode.level == 2,
        OrgTreeNode.is_active == True,
    ).first()
    if not group_node:
        raise HTTPException(404, "Group not found")

    ordered_ids: list[int] = []
    seen: set[int] = set()
    for node in _get_subtree_org_nodes(db, int(group_node.id)):
        uid = int(node.user_id) if getattr(node, "user_id", None) else None
        if uid and uid not in seen:
            seen.add(uid)
            ordered_ids.append(uid)

    users = db.query(User).filter(User.id.in_(ordered_ids), User.is_active == True).all() if ordered_ids else []
    users_by_id = {int(user.id): user for user in users if _is_kam_sales_role(user.role)}
    members = [users_by_id[uid] for uid in ordered_ids if uid in users_by_id]
    if not members:
        raise HTTPException(400, "Selected group has no active KAM sales members")

    scope_uids = {int(uid) for uid in (_get_team_uids(cu, db) or []) if uid}
    member_ids = {int(member.id) for member in members}
    if not member_ids.issubset(scope_uids):
        raise HTTPException(403, "Cannot set targets outside your hierarchy scope")
    return group_node, members


@router.get("/targets/group/summary")
def get_group_target_summary(group_id: int, period: str,
                             db: Session=Depends(get_tenant_db), cu: User=Depends(require_permission("kam.view"))):
    group_node, members = _scoped_target_group_members(group_id, cu, db)
    member_ids = [int(member.id) for member in members]
    rows = db.query(KAMTarget).filter(
        KAMTarget.user_id.in_(member_ids),
        KAMTarget.period == period,
    ).all()
    targets_by_user = {int(row.user_id): float(getattr(row, "sales_target", 0) or 0) for row in rows}
    group_target = db.query(KAMGroupTarget).filter(
        KAMGroupTarget.group_id == group_id,
        KAMGroupTarget.period == period,
    ).first()
    total = float(group_target.sales_target or 0) if group_target else sum(targets_by_user.values())
    return {
        "group_id": int(group_node.id),
        "group_name": group_node.group_name or f"Group {group_node.id}",
        "period": period,
        "sales_target": total,
        "allocations": [
            {
                "user_id": int(member.id),
                "user_name": member.full_name or member.username,
                "role": member.role,
                "sales_target": targets_by_user.get(int(member.id), 0.0),
            }
            for member in members
        ],
    }


@router.post("/targets/group", status_code=201)
def set_group_target(data: GroupTargetCreate, db: Session=Depends(get_tenant_db), cu: User=Depends(require_permission("kam.update"))):
    """Atomically replace a group total and every member allocation in the caller's hierarchy scope."""
    if len(str(data.period)) != 4 or not str(data.period).isdigit():
        raise HTTPException(400, "Group targets require a valid four-digit year")
    _ensure_kam_target_identity_columns(db)
    group_node, members = _scoped_target_group_members(data.group_id, cu, db)
    expected_ids = [int(member.id) for member in members]
    supplied_ids = [int(allocation.user_id) for allocation in data.allocations]
    if len(supplied_ids) != len(set(supplied_ids)):
        raise HTTPException(400, "Duplicate member target allocation")
    if set(supplied_ids) != set(expected_ids):
        raise HTTPException(400, "Allocations must include every group member exactly once")

    total = Decimal(str(data.sales_target or 0))
    if not total.is_finite() or total <= 0 or total != total.to_integral_value():
        raise HTTPException(400, "Group target must be a positive whole-rupee amount")
    if total > Decimal("999999999999999"):
        raise HTTPException(400, "Group target exceeds the supported limit")
    allocations_by_user: dict[int, Decimal] = {}
    for allocation in data.allocations:
        amount = Decimal(str(allocation.sales_target or 0))
        if not amount.is_finite() or amount < 0 or amount != amount.to_integral_value():
            raise HTTPException(400, "Member targets must be whole-rupee amounts")
        if amount > Decimal("999999999999999"):
            raise HTTPException(400, "A member target exceeds the supported limit")
        allocations_by_user[int(allocation.user_id)] = amount
    if sum(allocations_by_user.values(), Decimal("0")) != total:
        raise HTTPException(400, "Member target total must match the group target")

    try:
        group_target = db.query(KAMGroupTarget).filter(
            KAMGroupTarget.group_id == data.group_id,
            KAMGroupTarget.period == data.period,
        ).first()
        if group_target:
            group_target.sales_target = total
            group_target.updated_by = cu.id
        else:
            group_target = KAMGroupTarget(
                group_id=data.group_id,
                period=data.period,
                sales_target=total,
                created_by=cu.id,
                updated_by=cu.id,
            )
            db.add(group_target)

        existing_user_ids = {
            int(row[0])
            for row in db.query(KAMTarget.user_id).filter(
                KAMTarget.user_id.in_(expected_ids),
                KAMTarget.period == data.period,
            ).distinct().all()
        }
        members_by_id = {int(member.id): member for member in members}
        for user_id in expected_ids:
            amount = allocations_by_user[user_id]
            if user_id in existing_user_ids:
                db.query(KAMTarget).filter(
                    KAMTarget.user_id == user_id,
                    KAMTarget.period == data.period,
                ).update({"sales_target": amount}, synchronize_session=False)
            else:
                target = KAMTarget(
                    user_id=user_id,
                    period=data.period,
                    sales_target=amount,
                    created_by=cu.id,
                )
                db.add(target)
            members_by_id[user_id].target = amount if amount > 0 else None

        db.commit()
        db.refresh(group_target)
    except Exception:
        db.rollback()
        raise

    return {
        "group_id": int(group_node.id),
        "group_name": group_node.group_name or f"Group {group_node.id}",
        "period": data.period,
        "sales_target": float(group_target.sales_target or 0),
        "allocations": [
            {
                "user_id": user_id,
                "user_name": members_by_id[user_id].full_name or members_by_id[user_id].username,
                "role": members_by_id[user_id].role,
                "sales_target": float(allocations_by_user[user_id]),
            }
            for user_id in expected_ids
        ],
    }


@router.get("/targets/summary")
def get_target_summary(user_id: Optional[int]=None, period: Optional[str]=None,
                       db: Session=Depends(get_tenant_db), cu: User=Depends(require_permission("kam.view"))):
    if not period: period = now_ist().strftime("%Y-%m")
    uid = user_id or cu.id
    if uid != cu.id and uid not in _get_team_uids(cu,db): raise HTTPException(403,"Not authorised")
    tgt = db.query(KAMTarget).filter(KAMTarget.user_id==uid,KAMTarget.period==period).first()
    u = db.query(User).filter(User.id==uid).first()
    fallback_sales_target = 0.0
    if not tgt and len(str(period)) == 4 and str(period).isdigit():
        monthly_targets = db.query(KAMTarget).filter(
            KAMTarget.user_id == uid,
            KAMTarget.period.like(f"{period}-%"),
        ).all()
        fallback_sales_target = float(sum(float(getattr(t, "sales_target", 0) or 0) for t in monthly_targets))
        if fallback_sales_target <= 0 and u:
            fallback_sales_target = float(getattr(u, "target", None) or 0)
    return {"user_id":uid,"user_name":u.full_name if u else "","period":period,
            "calls_target":tgt.calls_target if tgt else 0,
            "meetings_target":tgt.meetings_target if tgt else 0,
            "demos_target":getattr(tgt,"demos_target",0) if tgt else 0,
            "site_visits_target":getattr(tgt,"site_visits_target",0) if tgt else 0,
            "revenue_target":float(tgt.revenue_target or 0) if tgt else 0,
            "sales_target":float(getattr(tgt,"sales_target",0) or 0) if tgt else fallback_sales_target,
            "has_target":tgt is not None}


@router.get("/targets/baseline-summary")
def get_target_baseline_summary(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(require_permission("kam.view")),
):
    scope_uids = _target_baseline_scope_uids(cu, db)
    if not scope_uids:
        return {
            "scope": "team",
            "member_count": 0,
            "sales_target": 0.0,
            "achieved_value": 0.0,
            "remaining_value": 0.0,
            "achievement_pct": 0,
            "has_target": False,
        }

    users = db.query(User.id, User.target).filter(
        User.id.in_(scope_uids),
        User.is_active == True,
    ).all()
    target_by_user: dict[int, float] = {}
    missing_uids: list[int] = []
    for user in users:
        uid = int(user.id)
        master_target = float(getattr(user, "target", None) or 0)
        if master_target > 0:
            target_by_user[uid] = master_target
        else:
            missing_uids.append(uid)

    if missing_uids:
        fallback_rows = db.query(KAMTarget).filter(
            KAMTarget.user_id.in_(missing_uids)
        ).order_by(
            KAMTarget.user_id.asc(),
            KAMTarget.created_at.desc(),
            KAMTarget.id.desc(),
        ).all()
        for row in fallback_rows:
            uid = int(row.user_id)
            if uid in target_by_user:
                continue
            target_by_user[uid] = float(getattr(row, "sales_target", 0) or 0)

    sales_target = float(sum(target_by_user.values()))
    achieved_value = float(_wo_stats(scope_uids, db).get("wo_value", 0) or 0)
    remaining_value = max(0.0, sales_target - achieved_value)
    achievement_pct = int(min(100, round((achieved_value / sales_target) * 100))) if sales_target > 0 else 0

    return {
        "scope": "team",
        "member_count": len(scope_uids),
        "sales_target": sales_target,
        "achieved_value": achieved_value,
        "remaining_value": remaining_value,
        "achievement_pct": achievement_pct,
        "has_target": sales_target > 0,
    }


# --- KAM 360 Summary (top cards) ----------------------------------------------

@router.get("/360-summary")
def get_360_summary(user_id: Optional[int]=None, period: Optional[str]=None,
                    view_type: Optional[str]=None, year: Optional[int]=None,
                    date_from: Optional[str]=None, date_to: Optional[str]=None,
                    db: Session=Depends(get_tenant_db), cu: User=Depends(require_permission("kam.view"))):
    if not period: period = now_ist().strftime("%Y-%m")
    d_from,d_to,cy,is_yearly = _resolve_360_window(period, view_type, year, date_from, date_to)

    scope_uids = _get_team_uids(cu, db)
    if user_id:
        scope_uids=[_get_visible_uids(cu,db,user_id)[0]]; uid=user_id
    elif len(scope_uids) > 1:
        kam_scope_uids = [
            int(row.id)
            for row in db.query(User.id, User.role).filter(
                User.id.in_(scope_uids),
                User.is_active == True,
            ).all()
            if _is_kam_sales_role(row.role)
        ]
        if kam_scope_uids:
            scope_uids = kam_scope_uids
        uid=None
    else:
        uid=cu.id

    is_agg = uid is None
    act_q=db.query(KAMActivity).filter(KAMActivity.activity_date.between(d_from,d_to))
    if uid: act_q=act_q.filter(KAMActivity.user_id==uid)
    else:   act_q=act_q.filter(KAMActivity.user_id.in_(scope_uids))
    activities=act_q.all()

    is_admin_all_scope = uid is None and _kam_scope_is_all(cu, db)
    stats_scope = None if is_admin_all_scope else (scope_uids if uid is None else [uid])
    stats_d_from = d_from
    stats_d_to = d_to

    # Keep admin/CEO aggregate KPI aligned with the master Customer count.
    # Do not change selected-user or non-admin scope logic.
    cust_ids: list[int] = []
    if is_admin_all_scope:
        cust_count = db.query(Customer).filter(Customer.is_deleted == False).count()
        customer_potential_value = float(db.query(func.sum(Customer.potential_value)).filter(Customer.is_deleted == False).scalar() or 0)
    else:
        cust_ids = _customer_ids_for_uids(scope_uids if uid is None else [uid], db)
        cust_count = len(cust_ids)
        customer_potential_value = float(db.query(func.sum(Customer.potential_value)).filter(Customer.id.in_(cust_ids)).scalar() or 0) if cust_ids else 0.0

    ls=_lead_stats(stats_scope,db,stats_d_from,stats_d_to)
    ts=_tender_stats(stats_scope,db,stats_d_from,stats_d_to)
    wo=_wo_stats(stats_scope,db,stats_d_from,stats_d_to)

    portfolio_customer_q = db.query(Customer).filter(Customer.is_deleted == False)
    if not is_admin_all_scope:
        portfolio_customer_q = portfolio_customer_q.filter(Customer.id.in_(cust_ids or [-1]))

    def _portfolio_customer_rows(column):
        label_expr = func.coalesce(func.nullif(func.trim(column), ""), "Unassigned")
        rows = (
            portfolio_customer_q
            .with_entities(
                label_expr.label("label"),
                func.count(Customer.id).label("count"),
                func.coalesce(func.sum(Customer.potential_value), 0).label("value"),
            )
            .group_by(label_expr)
            .order_by(func.coalesce(func.sum(Customer.potential_value), 0).desc(), func.count(Customer.id).desc())
            .all()
        )
        return [
            {"name": str(label or "Unassigned"), "label": str(label or "Unassigned"), "count": int(count or 0), "value": float(value or 0)}
            for label, count, value in rows
        ]

    business_scope = stats_scope
    business_q = db.query(
        Lead.business_vertical_id,
        func.count(Lead.id).label("count"),
        func.coalesce(func.sum(Lead.est_value), 0).label("value"),
    ).filter(
        Lead.is_deleted == False,
    )
    if business_scope is not None:
        business_q = business_q.filter(or_(
            Lead.assigned_to.in_(business_scope),
            Lead.created_by.in_(business_scope),
        ))
    if d_from and d_to:
        start_dt = datetime.combine(date.fromisoformat(str(d_from)), datetime.min.time())
        end_dt = datetime.combine(date.fromisoformat(str(d_to)), datetime.max.time())
        business_q = business_q.filter(func.coalesce(Lead.lead_created_at, Lead.created_at).between(start_dt, end_dt))
    business_rows_raw = (
        business_q
        .group_by(Lead.business_vertical_id)
        .order_by(func.coalesce(func.sum(Lead.est_value), 0).desc(), func.count(Lead.id).desc())
        .all()
    )
    business_ids = [int(bid) for bid, _, _ in business_rows_raw if bid]
    business_name_map: dict[int, str] = {}
    if business_ids:
        try:
            id_csv = ", ".join(str(int(i)) for i in business_ids)
            rows = db.execute(sa_text(
                f"SELECT id, COALESCE(NULLIF(business_unit, ''), NULLIF(business_vertical, '')) AS name "
                f"FROM business_category_units WHERE id IN ({id_csv})"
            )).mappings().all()
            business_name_map = {
                int(row["id"]): (row["name"] or "").strip() or f"Business Unit {row['id']}"
                for row in rows
            }
        except Exception:
            business_name_map = {}
    # Fetch all active master segments so 0-count ones still appear
    master_segment_names: list[str] = [
        vs.name for vs in
        db.query(VerticalSector)
          .filter(VerticalSector.is_active == True)
          .order_by(VerticalSector.display_order, VerticalSector.name, VerticalSector.id)
          .all()
    ]
    master_source_names: list[str] = [
        source.name for source in
        db.query(LeadSource)
          .filter(LeadSource.is_active == True)
          .order_by(LeadSource.name, LeadSource.id)
          .all()
        if (source.name or "").strip()
    ]
    _by_segment_customer = _portfolio_customer_rows(Customer.customer_vertical)
    if master_segment_names:
        _segment_by_key = {
            str(seg or "").strip().lower(): {"name": seg, "label": seg, "count": 0, "value": 0.0}
            for seg in master_segment_names
            if str(seg or "").strip()
        }
        for row in _by_segment_customer:
            key = str(row.get("name") or row.get("label") or "").strip().lower()
            if key not in _segment_by_key:
                continue
            _segment_by_key[key]["count"] += int(row.get("count") or 0)
            _segment_by_key[key]["value"] += float(row.get("value") or 0)
        _by_segment_customer = [
            _segment_by_key[str(seg or "").strip().lower()]
            for seg in master_segment_names
            if str(seg or "").strip().lower() in _segment_by_key
        ]

    active_business_units = _business_unit_master_rows(db)
    active_business_unit_by_id = {int(row["unit_id"]): row["unit"] for row in active_business_units if row.get("unit_id")}

    portfolio_mix = {
        "master_segments": master_segment_names,
        "master_sources": master_source_names,
        "by_segment": _by_segment_customer,
        "by_business_unit": [
            {
                "name": active_business_unit_by_id.get(int(bid)) or business_name_map.get(int(bid), f"Business Unit {bid}"),
                "label": active_business_unit_by_id.get(int(bid)) or business_name_map.get(int(bid), f"Business Unit {bid}"),
                "count": int(count or 0),
                "value": float(value or 0),
            }
            for bid, count, value in business_rows_raw
            if bid and (not active_business_unit_by_id or int(bid) in active_business_unit_by_id)
        ],
        "business_unit_analysis": _business_unit_pipeline_analysis(db, stats_scope, d_from, d_to),
        "by_location": _portfolio_customer_rows(Customer.billing_city),
    }

    # Sum sales targets across the selected hierarchy scope.
    if uid:
        target_scope = [uid]
    else:
        target_scope = scope_uids

    tgts = _target_rows_for_window(db, target_scope, d_from, d_to)
    sales_target = float(sum(float(getattr(t, "sales_target", 0) or 0) for t in tgts))

    pipeline_conversion = _pipeline_conversion_summary(cust_count, ls, ts, wo)

    return {"uid":uid,"is_aggregate":is_agg,"period":period,"year":cy,"is_yearly":is_yearly,
            "customers":cust_count,"customer_potential_value":customer_potential_value,
            "total_activities":len(activities),
            "completed_activities":sum(1 for a in activities if a.status=="Completed"),
            "pending_activities":sum(1 for a in activities if a.status in ("Planned","In Progress")),
            **ls,**ts,"wo_count":wo["wo_count"],"wo_value":wo["wo_value"],
            "linked_tender_workorder_count": wo.get("linked_tender_workorder_count", wo["wo_count"]),
            "payment_received":wo["payment_received"],"sales_target":sales_target,
            "pipeline_conversion": pipeline_conversion,
            "portfolio_mix": portfolio_mix}


# --- Customer-wise activity breakdown -----------------------------------------

@router.get("/customer-activities")
def get_customer_activities(user_id: Optional[int]=None, period: Optional[str]=None,
                            view_type: Optional[str]=None, year: Optional[int]=None,
                            date_from: Optional[str]=None, date_to: Optional[str]=None,
                            db: Session=Depends(get_tenant_db), cu: User=Depends(require_permission("kam.view"))):
    if not period: period = now_ist().strftime("%Y-%m")
    d_from,d_to,cy,is_yearly = _resolve_360_window(period, view_type, year, date_from, date_to)

    scope_uids = _get_team_uids(cu, db)
    if user_id:
        scope_uids=[_get_visible_uids(cu,db,user_id)[0]]; uid=user_id
    elif len(scope_uids) > 1:
        uid=None
    else:
        uid=cu.id
    is_agg = uid is None
    act_q=db.query(KAMActivity).filter(KAMActivity.activity_date.between(d_from,d_to))
    if uid: act_q=act_q.filter(KAMActivity.user_id==uid)
    else:   act_q=act_q.filter(KAMActivity.user_id.in_(scope_uids))
    activities=act_q.all()

    # Preload user names to avoid per-customer queries
    uid_set={a.user_id for a in activities}
    user_name_map={u.id:u.full_name for u in db.query(User).filter(User.id.in_(uid_set)).all()} if uid_set else {}

    # For activities with no customer_id, resolve via lead → customer
    no_cid_lead_ids=[a.lead_id for a in activities if not a.customer_id and a.lead_id]
    if no_cid_lead_ids:
        lead_cid_rows=db.query(Lead.id,Lead.customer_id).filter(Lead.id.in_(no_cid_lead_ids)).all()
        lead_cid_map={r.id:r.customer_id for r in lead_cid_rows if r.customer_id}
    else:
        lead_cid_map={}
    def _eff_cid(a): return a.customer_id or lead_cid_map.get(a.lead_id)

    cust_ids=list({_eff_cid(a) for a in activities if _eff_cid(a)})
    activities_by_customer: dict[int, list[KAMActivity]] = defaultdict(list)
    for activity in activities:
        effective_customer_id = _eff_cid(activity)
        if effective_customer_id:
            activities_by_customer[int(effective_customer_id)].append(activity)

    customer_map = {
        int(customer.id): customer
        for customer in db.query(Customer).filter(Customer.id.in_(cust_ids)).all()
    } if cust_ids else {}
    leads_by_customer: dict[int, list[Lead]] = defaultdict(list)
    tenders_by_customer: dict[int, list[Tender]] = defaultdict(list)
    won_tenders_by_customer: dict[int, list[Tender]] = defaultdict(list)

    if cust_ids:
        lead_q=db.query(Lead).filter(Lead.customer_id.in_(cust_ids),Lead.is_deleted==False)
        tend_q=db.query(Tender).filter(Tender.customer_id.in_(cust_ids),Tender.is_deleted==False)
        wo_q=db.query(Tender).filter(
            Tender.customer_id.in_(cust_ids), Tender.is_deleted==False, Tender.result=="Won"
        )
        if uid:
            lead_q=lead_q.filter(Lead.assigned_to==uid)
            tend_q=tend_q.filter(Tender.assigned_to==uid)
            wo_q=wo_q.filter(or_(Tender.assigned_to==uid, Tender.created_by==uid))
        else:
            lead_q=lead_q.filter(Lead.assigned_to.in_(scope_uids))
            tend_q=tend_q.filter(Tender.assigned_to.in_(scope_uids))
            wo_q=wo_q.filter(or_(Tender.assigned_to.in_(scope_uids), Tender.created_by.in_(scope_uids)))
        if d_from and d_to:
            start_date = date.fromisoformat(str(d_from))
            end_date = date.fromisoformat(str(d_to))
            start_dt = datetime.combine(start_date, datetime.min.time())
            end_dt = datetime.combine(end_date, datetime.max.time())
            lead_q = lead_q.filter(func.coalesce(Lead.lead_created_at, Lead.created_at).between(start_dt, end_dt))
            tend_q = tend_q.filter(or_(
                and_(Tender.result_date.isnot(None), Tender.result_date.between(start_date, end_date)),
                and_(Tender.submission_date.isnot(None), Tender.submission_date.between(start_date, end_date)),
                and_(Tender.published_date.isnot(None), Tender.published_date.between(start_date, end_date)),
                Tender.created_at.between(start_dt, end_dt),
            ))
            wo_q = wo_q.filter(or_(
                and_(Tender.result_date.isnot(None), Tender.result_date.between(start_date, end_date)),
                and_(Tender.result_date.is_(None), Tender.created_at.between(start_dt, end_dt)),
            ))
        for lead in lead_q.all():
            if lead.customer_id:
                leads_by_customer[int(lead.customer_id)].append(lead)
        for tender in tend_q.all():
            if tender.customer_id:
                tenders_by_customer[int(tender.customer_id)].append(tender)
        for won_tender in wo_q.all():
            if won_tender.customer_id:
                won_tenders_by_customer[int(won_tender.customer_id)].append(won_tender)

    result=[]
    for cid in cust_ids:
        cid=int(cid)
        cust=customer_map.get(cid)
        c_acts=activities_by_customer.get(cid, [])

        # Assigned KAM info — most active user first
        ucount=Counter(a.user_id for a in c_acts)
        top_uid=ucount.most_common(1)[0][0] if ucount else None
        assigned_to_name=user_name_map.get(top_uid,'') if top_uid else ''
        assigned_to_names=[user_name_map.get(u,'') for u,_ in ucount.most_common() if user_name_map.get(u)]
        c_leads=leads_by_customer.get(cid, []); c_tenders=tenders_by_customer.get(cid, []); c_wos=won_tenders_by_customer.get(cid, [])
        c_opportunities=[l for l in c_leads if _is_kam_opportunity(l)]
        c_converted_opportunities=[
            l for l in c_opportunities
            if getattr(l, "lead_type", "lead") != "direct_opportunity"
        ]
        c_opportunity_ids = {int(l.id) for l in c_opportunities}
        c_linked_opportunity_tenders = [
            t for t in c_tenders
            if getattr(t, "lead_id", None) and int(t.lead_id) in c_opportunity_ids
        ]
        last_act=max((str(a.activity_date) for a in c_acts),default=None)
        last_outcome=next((a.outcome for a in sorted(c_acts,key=lambda x:x.activity_date,reverse=True) if a.outcome),None)
        result.append({
            "customer_id":cid,"customer_name":cust.customer_name if cust else "",
            "city":cust.billing_city if cust else "",
            "billing_city":cust.billing_city if cust else "",
            "billing_state":cust.billing_state if cust else "",
            "state":(cust.billing_state or cust.shipping_state) if cust else "",
            "shipping_city":cust.shipping_city if cust else "",
            "shipping_state":cust.shipping_state if cust else "",
            "vertical":cust.customer_vertical if cust else "",
            "customer_vertical":cust.customer_vertical if cust else "",
            "industry":cust.industry if cust else "",
            "division":cust.division if cust else "",
            "sub_segment":cust.division if cust else "",
            "customer_sub_segment":cust.division if cust else "",
            "total_activities":len(c_acts),
            "completed":sum(1 for a in c_acts if a.status=="Completed"),
            "pending":sum(1 for a in c_acts if a.status in ("Planned","In Progress")),
            "calls": sum(1 for a in c_acts if a.activity_type in ("Phone Call", "Video Call", "Daily Call")),
            "calls_done": sum(1 for a in c_acts if a.activity_type in ("Phone Call", "Video Call", "Daily Call") and a.status == "Completed"),
            "meetings": sum(1 for a in c_acts if a.activity_type in ("In Person Meet", "Meeting")),
            "meetings_done": sum(1 for a in c_acts if a.activity_type in ("In Person Meet", "Meeting") and a.status == "Completed"),
            "demos":sum(1 for a in c_acts if a.activity_type in ("Demo",)),
            "site_visits":sum(1 for a in c_acts if a.activity_type in ("Site Visit",)),
            "lead_count":len(c_leads),"lead_value":float(sum(float(l.est_value or 0) for l in c_leads)),
            "opportunity_count":len(c_opportunities),
            "opportunity_value":float(sum(float(l.est_value or 0) for l in c_opportunities)),
            "converted_opportunity_count":len(c_converted_opportunities),
            "tender_count":len(c_tenders),"tender_value":float(sum(float(t.est_value or 0) for t in c_tenders)),
            "linked_opportunity_count":len(c_linked_opportunity_tenders),
            "wo_count":len(c_wos),"wo_value":float(sum(float(x.wo_value or x.bid_amount or 0) for x in c_wos)),
            "linked_tender_workorder_count":len(c_wos),
            "payment_received":0.0,
            "last_activity_date":last_act,"last_outcome":last_outcome,
            "assigned_to_name":assigned_to_name,
            "assigned_to_names":assigned_to_names,
        })
    result.sort(key=lambda x:x["total_activities"],reverse=True)
    return result


# --- Team 360 (per-member for hierarchy scope) --------------------------------

@router.get("/team-360")
def get_team_360(period: Optional[str]=None, view_type: Optional[str]=None,
                 year: Optional[int]=None,
                 date_from: Optional[str]=None, date_to: Optional[str]=None,
                 db: Session=Depends(get_tenant_db), cu: User=Depends(require_permission("kam.view"))):
    if not period: period=now_ist().strftime("%Y-%m")
    d_from,d_to,cy,is_yearly = _resolve_360_window(period, view_type, year, date_from, date_to)
    customer_d_from, customer_d_to = d_from, d_to
    uids=_get_team_performance_uids(cu,db)

    # Masters → Groups uses the Org Tree hierarchy. Its active L2 nodes are
    # the source of truth for KAM Sales Team Performance.
    group_fixing_groups, group_fixing_by_user = _group_fixing_payload(db)
    _group_lookup = {int(g.id): g.name for g in db.query(Group).all()}
    def _resolve_group_ids(gid_str):
        return _parse_user_group_ids(gid_str)
    def _resolve_group_names(gid_str):
        return [_group_lookup.get(int(gid), str(gid)) for gid in _resolve_group_ids(gid_str)]
    def _resolve_group(gid_str) -> str:
        names = _resolve_group_names(gid_str)
        return ", ".join(names)

    _non_kam_roles = ('admin', 'ceo')
    users = db.query(User).filter(
        User.id.in_(uids),
        User.is_active==True,
        User.role.notin_(_non_kam_roles),
    ).all()
    member_ids = [int(u.id) for u in users]
    member_id_set = set(member_ids)
    kam_member_id_set = {int(u.id) for u in users if _is_kam_sales_role(u.role)}

    activity_stats = {uid: _activity_stats_bucket() for uid in member_ids}
    if member_ids:
        for uid, activity_type, status in db.query(
            KAMActivity.user_id,
            KAMActivity.activity_type,
            KAMActivity.status,
        ).filter(
            KAMActivity.user_id.in_(member_ids),
            KAMActivity.activity_date.between(d_from, d_to),
        ).all():
            if uid:
                _apply_activity_to_stats(activity_stats[int(uid)], activity_type, status)

    target_map = _team_360_target_map(db, member_ids, str(period), cy, is_yearly)
    target_rows = _target_rows_for_window(db, member_ids, d_from, d_to)
    sales_target_by_user: dict[int, float] = {}
    for target_row in target_rows:
        uid = int(target_row.user_id)
        sales_target_by_user[uid] = sales_target_by_user.get(uid, 0.0) + float(getattr(target_row, "sales_target", 0) or 0)
    annual_target_rows = _target_rows_for_window(db, member_ids, f"{cy}-01-01", f"{cy}-12-31")
    annual_sales_target_by_user: dict[int, float] = {}
    for target_row in annual_target_rows:
        uid = int(target_row.user_id)
        annual_sales_target_by_user[uid] = annual_sales_target_by_user.get(uid, 0.0) + float(getattr(target_row, "sales_target", 0) or 0)
    for u in users:
        uid = int(u.id)
        if annual_sales_target_by_user.get(uid, 0.0) <= 0:
            master_target = float(getattr(u, "target", None) or 0)
            if master_target > 0:
                annual_sales_target_by_user[uid] = master_target
    start_date = date.fromisoformat(str(d_from)) if d_from and d_to else None
    end_date = date.fromisoformat(str(d_to)) if d_from and d_to else None
    start_dt = datetime.combine(start_date, datetime.min.time()) if start_date else None
    end_dt = datetime.combine(end_date, datetime.max.time()) if end_date else None

    lead_stats = {
        uid: {"lead_count": 0, "lead_value": 0.0, "active_lead_value": 0.0, "opportunity_count": 0, "opportunity_value": 0.0, "converted_opportunity_count": 0}
        for uid in member_ids
    }
    if member_ids:
        lead_q = db.query(
            Lead.assigned_to,
            func.count(Lead.id),
            func.sum(Lead.est_value),
        ).filter(
            Lead.assigned_to.in_(member_ids),
            Lead.is_deleted == False,
            or_(Lead.lead_type.is_(None), Lead.lead_type != "direct_opportunity"),
        )
        if start_dt and end_dt:
            lead_q = lead_q.filter(func.coalesce(Lead.lead_created_at, Lead.created_at).between(start_dt, end_dt))
        for uid, cnt, sv in lead_q.group_by(Lead.assigned_to).all():
            if uid in member_id_set:
                lead_stats[int(uid)]["lead_count"] = int(cnt or 0)
                lead_stats[int(uid)]["lead_value"] = float(sv or 0)

        active_lead_q = db.query(
            Lead.assigned_to,
            func.sum(Lead.est_value),
        ).filter(
            Lead.assigned_to.in_(member_ids),
            Lead.is_deleted == False,
            or_(Lead.lead_type.is_(None), Lead.lead_type != "direct_opportunity"),
            or_(Lead.status.is_(None), ~Lead.status.in_(["Converted", "Lost"])),
        )
        if start_dt and end_dt:
            active_lead_q = active_lead_q.filter(func.coalesce(Lead.lead_created_at, Lead.created_at).between(start_dt, end_dt))
        for uid, sv in active_lead_q.group_by(Lead.assigned_to).all():
            if uid in member_id_set:
                lead_stats[int(uid)]["active_lead_value"] = float(sv or 0)

        opp_q = db.query(
            Lead.assigned_to,
            func.count(Lead.id),
            func.sum(Lead.est_value),
        ).filter(
            Lead.assigned_to.in_(member_ids),
            Lead.is_deleted == False,
            Lead.status.in_(["Opportunity Created", "Converted"]),
        )
        if start_dt and end_dt:
            opp_q = opp_q.filter(func.coalesce(Lead.lead_created_at, Lead.created_at).between(start_dt, end_dt))
        for uid, cnt, sv in opp_q.group_by(Lead.assigned_to).all():
            if uid in member_id_set:
                lead_stats[int(uid)]["opportunity_count"] = int(cnt or 0)
                lead_stats[int(uid)]["opportunity_value"] = float(sv or 0)

        converted_opp_q = db.query(
            Lead.assigned_to,
            func.count(Lead.id),
        ).filter(
            Lead.assigned_to.in_(member_ids),
            Lead.is_deleted == False,
            Lead.status.in_(["Opportunity Created", "Converted"]),
            or_(Lead.lead_type.is_(None), Lead.lead_type != "direct_opportunity"),
        )
        if start_dt and end_dt:
            converted_opp_q = converted_opp_q.filter(func.coalesce(Lead.lead_created_at, Lead.created_at).between(start_dt, end_dt))
        for uid, cnt in converted_opp_q.group_by(Lead.assigned_to).all():
            if uid in member_id_set:
                lead_stats[int(uid)]["converted_opportunity_count"] = int(cnt or 0)

    tender_stats = {
        uid: {"tender_count": 0, "tender_value": 0.0, "active_tender_value": 0.0, "won_tender_count": 0, "won_tender_value": 0.0, "lost_tender_count": 0, "lost_tender_value": 0.0, "linked_opportunity_count": 0}
        for uid in member_ids
    }
    if member_ids:
        tender_q = db.query(
            Tender.assigned_to,
            func.count(Tender.id),
            func.sum(Tender.est_value),
        ).filter(
            Tender.assigned_to.in_(member_ids),
            Tender.is_deleted == False,
        )
        if start_date and end_date and start_dt and end_dt:
            tender_q = tender_q.filter(or_(
                and_(Tender.result_date.isnot(None), Tender.result_date.between(start_date, end_date)),
                and_(Tender.submission_date.isnot(None), Tender.submission_date.between(start_date, end_date)),
                and_(Tender.published_date.isnot(None), Tender.published_date.between(start_date, end_date)),
                Tender.created_at.between(start_dt, end_dt),
            ))
        for uid, cnt, sv in tender_q.group_by(Tender.assigned_to).all():
            if uid in member_id_set:
                tender_stats[int(uid)]["tender_count"] = int(cnt or 0)
                tender_stats[int(uid)]["tender_value"] = float(sv or 0)

        linked_opp_tender_q = db.query(
            Tender.assigned_to,
            func.count(Tender.id),
        ).join(
            Lead, Tender.lead_id == Lead.id
        ).filter(
            Tender.assigned_to.in_(member_ids),
            Tender.is_deleted == False,
            Lead.is_deleted == False,
            Lead.status.in_(["Opportunity Created", "Converted"]),
        )
        if start_date and end_date and start_dt and end_dt:
            linked_opp_tender_q = linked_opp_tender_q.filter(or_(
                and_(Tender.result_date.isnot(None), Tender.result_date.between(start_date, end_date)),
                and_(Tender.submission_date.isnot(None), Tender.submission_date.between(start_date, end_date)),
                and_(Tender.published_date.isnot(None), Tender.published_date.between(start_date, end_date)),
                Tender.created_at.between(start_dt, end_dt),
            ))
            linked_opp_tender_q = linked_opp_tender_q.filter(func.coalesce(Lead.lead_created_at, Lead.created_at).between(start_dt, end_dt))
        for uid, cnt in linked_opp_tender_q.group_by(Tender.assigned_to).all():
            if uid in member_id_set:
                tender_stats[int(uid)]["linked_opportunity_count"] = int(cnt or 0)

        active_tender_q = db.query(
            Tender.assigned_to,
            func.sum(Tender.est_value),
        ).filter(
            Tender.assigned_to.in_(member_ids),
            Tender.is_deleted == False,
            or_(Tender.result.is_(None), ~Tender.result.in_(["Won", "Lost", "Cancelled"])),
        )
        if start_date and end_date and start_dt and end_dt:
            active_tender_q = active_tender_q.filter(or_(
                and_(Tender.result_date.isnot(None), Tender.result_date.between(start_date, end_date)),
                and_(Tender.submission_date.isnot(None), Tender.submission_date.between(start_date, end_date)),
                and_(Tender.published_date.isnot(None), Tender.published_date.between(start_date, end_date)),
                Tender.created_at.between(start_dt, end_dt),
            ))
        for uid, sv in active_tender_q.group_by(Tender.assigned_to).all():
            if uid in member_id_set:
                tender_stats[int(uid)]["active_tender_value"] = float(sv or 0)

        lost_tender_q = db.query(
            Tender.assigned_to,
            func.count(Tender.id),
            func.sum(Tender.est_value),
        ).filter(
            Tender.assigned_to.in_(member_ids),
            Tender.is_deleted == False,
            Tender.result.in_(["Lost", "Cancelled"]),
        )
        if start_date and end_date and start_dt and end_dt:
            lost_tender_q = lost_tender_q.filter(or_(
                and_(Tender.result_date.isnot(None), Tender.result_date.between(start_date, end_date)),
                and_(Tender.submission_date.isnot(None), Tender.submission_date.between(start_date, end_date)),
                and_(Tender.published_date.isnot(None), Tender.published_date.between(start_date, end_date)),
                Tender.created_at.between(start_dt, end_dt),
            ))
        for uid, cnt, sv in lost_tender_q.group_by(Tender.assigned_to).all():
            if uid in member_id_set:
                tender_stats[int(uid)]["lost_tender_count"] = int(cnt or 0)
                tender_stats[int(uid)]["lost_tender_value"] = float(sv or 0)

        won_tender_q = db.query(
            Tender.assigned_to,
            func.count(Tender.id),
            func.sum(Tender.bid_amount),
        ).filter(
            Tender.assigned_to.in_(member_ids),
            Tender.is_deleted == False,
            Tender.result == "Won",
        )
        if start_date and end_date and start_dt and end_dt:
            won_tender_q = won_tender_q.filter(or_(
                and_(Tender.result_date.isnot(None), Tender.result_date.between(start_date, end_date)),
                and_(Tender.submission_date.isnot(None), Tender.submission_date.between(start_date, end_date)),
                and_(Tender.published_date.isnot(None), Tender.published_date.between(start_date, end_date)),
                Tender.created_at.between(start_dt, end_dt),
            ))
        for uid, cnt, sv in won_tender_q.group_by(Tender.assigned_to).all():
            if uid in member_id_set:
                tender_stats[int(uid)]["won_tender_count"] = int(cnt or 0)
                tender_stats[int(uid)]["won_tender_value"] = float(sv or 0)

        for uid, item in tender_stats.items():
            if item["active_tender_value"] <= 0 and item["tender_value"] > 0:
                item["active_tender_value"] = max(
                    0.0,
                    item["tender_value"] - item["won_tender_value"] - item["lost_tender_value"],
                )

    wo_stats = {
        uid: {"wo_count": 0, "wo_value": 0.0, "payment_received": 0.0, "linked_tender_workorder_count": 0}
        for uid in member_ids
    }
    if member_ids:
        work_orders = _kam_workorder_records_query(db, member_ids, d_from, d_to).all()
        order_receipts = _acknowledged_receipts(db, [o.id for o in work_orders])
        work_order_tender_ids = {
            int(getattr(order, "tender_id", 0) or 0)
            for order in work_orders
            if getattr(order, "tender_id", None)
        }
        scoped_tender_ids = {
            int(tender.id)
            for tender in _kam_tender_records_query(db, member_ids, d_from, d_to)
                .filter(Tender.id.in_(work_order_tender_ids or [-1]))
                .all()
        } if work_order_tender_ids else set()
        tender_owner_map: dict[int, tuple[Optional[int], Optional[int], Optional[int]]] = {}
        if work_order_tender_ids:
            for tender_id, assigned_to, created_by, lead_id in db.query(
                Tender.id,
                Tender.assigned_to,
                Tender.created_by,
                Tender.lead_id,
            ).filter(Tender.id.in_(work_order_tender_ids)).all():
                tender_owner_map[int(tender_id)] = (assigned_to, created_by, lead_id)

        work_order_lead_ids = {
            int(getattr(order, "lead_id", 0) or 0)
            for order in work_orders
            if getattr(order, "lead_id", None)
        }
        work_order_lead_ids.update(
            int(lead_id)
            for _, _, lead_id in tender_owner_map.values()
            if lead_id
        )
        lead_owner_map: dict[int, tuple[Optional[int], Optional[int]]] = {}
        if work_order_lead_ids:
            for lead_id, assigned_to, created_by in db.query(
                Lead.id,
                Lead.assigned_to,
                Lead.created_by,
            ).filter(Lead.id.in_(work_order_lead_ids)).all():
                lead_owner_map[int(lead_id)] = (assigned_to, created_by)

        for order in work_orders:
            row_uids = set()
            for uid_value in (getattr(order, "created_by", None), getattr(order, "project_manager_id", None)):
                if uid_value in member_id_set:
                    row_uids.add(int(uid_value))

            tender_info = tender_owner_map.get(int(getattr(order, "tender_id", 0) or 0))
            if tender_info:
                tender_assigned_to, tender_created_by, tender_lead_id = tender_info
                for uid_value in (tender_assigned_to, tender_created_by):
                    if uid_value in member_id_set:
                        row_uids.add(int(uid_value))
                if tender_lead_id:
                    for uid_value in lead_owner_map.get(int(tender_lead_id), (None, None)):
                        if uid_value in member_id_set:
                            row_uids.add(int(uid_value))

            lead_id = int(getattr(order, "lead_id", 0) or 0)
            if lead_id:
                for uid_value in lead_owner_map.get(lead_id, (None, None)):
                    if uid_value in member_id_set:
                        row_uids.add(int(uid_value))

            value = float(getattr(order, "wo_value", None) or getattr(order, "po_value", None) or 0)
            received = order_receipts.get(int(order.id), 0.0)
            is_scoped_tender_workorder = bool(
                getattr(order, "tender_id", None)
                and int(order.tender_id) in scoped_tender_ids
            )
            for uid in row_uids:
                wo_stats[uid]["wo_count"] += 1
                if is_scoped_tender_workorder:
                    wo_stats[uid]["linked_tender_workorder_count"] += 1
                wo_stats[uid]["wo_value"] += value
                wo_stats[uid]["payment_received"] += received

    quotation_stats = {
        uid: {
            "quotation_count": 0,
            "quotation_value": 0.0,
            "quotation_accepted_count": 0,
            "quotation_rejected_count": 0,
            "quotation_active_count": 0,
        }
        for uid in member_ids
    }
    if member_ids:
        quote_q = db.query(
            Quotation.created_by,
            Quotation.status,
            func.count(Quotation.id),
            func.sum(Quotation.total_amount),
        ).filter(
            Quotation.created_by.in_(member_ids),
        )
        if start_dt and end_dt:
            quote_q = quote_q.filter(Quotation.created_at.between(start_dt, end_dt))
        for uid, status, cnt, total_amount in quote_q.group_by(Quotation.created_by, Quotation.status).all():
            if uid in member_id_set:
                qstats = quotation_stats[int(uid)]
                count = int(cnt or 0)
                qstats["quotation_count"] += count
                qstats["quotation_value"] += float(total_amount or 0)
                normalized_status = str(status or "").strip().lower()
                if normalized_status == "accepted":
                    qstats["quotation_accepted_count"] += count
                elif normalized_status == "rejected":
                    qstats["quotation_rejected_count"] += count
                else:
                    qstats["quotation_active_count"] += count

    customer_ids_by_user, customer_counts, customer_potential_values, potential_by_customer = _team_360_customer_maps(db, member_ids)
    customers_with_win_map, customers_pending_map = _team_360_customer_status_maps(
        db,
        member_ids,
        customer_ids_by_user,
        customer_d_from,
        customer_d_to,
    )

    def _enrich_group_fixing_metrics(groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
        enriched: list[dict[str, Any]] = []
        for group in groups or []:
            group_member_ids = {
                int(member.get("user_id") or member.get("id") or 0)
                for member in (group.get("members") or [])
                if member.get("user_id") or member.get("id")
            }
            scoped_member_ids = sorted(uid for uid in group_member_ids if uid in kam_member_id_set)
            customer_ids: set[int] = set()
            for uid in scoped_member_ids:
                customer_ids.update(customer_ids_by_user.get(uid, set()))
            customer_potential_value = float(sum(potential_by_customer.get(cid, 0.0) for cid in customer_ids))
            group_lead_stats = _lead_stats(scoped_member_ids, db, d_from, d_to) if scoped_member_ids else {
                "lead_count": 0,
                "lead_value": 0.0,
                "opportunity_count": 0,
                "opportunity_value": 0.0,
                "converted_opportunity_count": 0,
                "customer_to_lead_count": 0,
            }
            group_tender_stats = _tender_stats(scoped_member_ids, db, d_from, d_to) if scoped_member_ids else {
                "tender_count": 0,
                "tender_value": 0.0,
                "won_tender_count": 0,
                "won_tender_value": 0.0,
                "linked_opportunity_count": 0,
            }
            group_wo_stats = _wo_stats(scoped_member_ids, db, d_from, d_to) if scoped_member_ids else {
                "wo_count": 0,
                "wo_value": 0.0,
                "payment_received": 0.0,
                "linked_tender_workorder_count": 0,
            }
            group_activity_stats = _activity_stats_bucket()
            if scoped_member_ids:
                for activity_type, status in db.query(
                    KAMActivity.activity_type,
                    KAMActivity.status,
                ).filter(
                    KAMActivity.user_id.in_(scoped_member_ids),
                    KAMActivity.activity_date.between(d_from, d_to),
                ).all():
                    _apply_activity_to_stats(group_activity_stats, activity_type, status)

            metric_payload = {
                "member_count": int(group.get("member_count") or len(group_member_ids)),
                "kam_member_count": len(scoped_member_ids),
                "customer_count": len(customer_ids),
                "customer_potential_value": customer_potential_value,
                "lead_count": int(group_lead_stats.get("lead_count", 0) or 0),
                "lead_value": float(group_lead_stats.get("lead_value", 0) or 0),
                "opportunity_count": int(group_lead_stats.get("opportunity_count", 0) or 0),
                "opportunity_value": float(group_lead_stats.get("opportunity_value", 0) or 0),
                "converted_opportunity_count": int(group_lead_stats.get("converted_opportunity_count", 0) or 0),
                "tender_count": int(group_tender_stats.get("tender_count", 0) or 0),
                "tender_value": float(group_tender_stats.get("tender_value", 0) or 0),
                "won_tender_count": int(group_tender_stats.get("won_tender_count", 0) or 0),
                "won_tender_value": float(group_tender_stats.get("won_tender_value", 0) or 0),
                "wo_count": int(group_wo_stats.get("wo_count", 0) or 0),
                "wo_value": float(group_wo_stats.get("wo_value", 0) or 0),
                "linked_tender_workorder_count": int(group_wo_stats.get("linked_tender_workorder_count", 0) or 0),
                "payment_received": float(group_wo_stats.get("payment_received", 0) or 0),
                "activity_count": int(group_activity_stats.get("total", 0) or 0),
                "completed_activity_count": int(group_activity_stats.get("completed", 0) or 0),
                "pending_activity_count": int(group_activity_stats.get("pending", 0) or 0),
                "pipeline_conversion": _pipeline_conversion_summary(
                    len(customer_ids),
                    group_lead_stats,
                    group_tender_stats,
                    group_wo_stats,
                ),
            }
            enriched_group = dict(group)
            enriched_group.update({
                "member_ids": scoped_member_ids,
                "kam_member_count": len(scoped_member_ids),
                "customer_count": len(customer_ids),
                "customer_potential_value": customer_potential_value,
                **metric_payload,
                "metrics": metric_payload,
            })
            enriched.append(enriched_group)
        return enriched

    group_fixing_groups = _enrich_group_fixing_metrics(group_fixing_groups)

    members=[]
    for u in users:
        uid = int(u.id)
        tgt = target_map.get(uid)
        act = activity_stats.get(uid) or _activity_stats_bucket()
        ls = lead_stats.get(uid, {"lead_count": 0, "lead_value": 0.0, "active_lead_value": 0.0, "opportunity_count": 0, "opportunity_value": 0.0, "converted_opportunity_count": 0})
        ts = tender_stats.get(uid, {"tender_count": 0, "tender_value": 0.0, "active_tender_value": 0.0, "won_tender_count": 0, "won_tender_value": 0.0, "lost_tender_count": 0, "lost_tender_value": 0.0, "linked_opportunity_count": 0})
        wo = wo_stats.get(uid, {"wo_count": 0, "wo_value": 0.0, "payment_received": 0.0, "linked_tender_workorder_count": 0})
        qs = quotation_stats.get(uid, {"quotation_count": 0, "quotation_value": 0.0, "quotation_accepted_count": 0, "quotation_rejected_count": 0, "quotation_active_count": 0})
        own_customer_count = int(customer_counts.get(uid, 0) or 0)
        customer_potential_value = float(customer_potential_values.get(uid, 0) or 0)
        # Per-row customer count is own assigned customers. Aggregates are calculated by scope in /360-summary.
        cust_count = own_customer_count
        pipeline_conversion = _pipeline_conversion_summary(cust_count, ls, ts, wo)
        raw_gid = getattr(u,"group_id",None)
        org_group_info = group_fixing_by_user.get(uid, {})
        group_ids = org_group_info.get("group_ids") or _resolve_group_ids(raw_gid)
        group_names = org_group_info.get("group_names") or _resolve_group_names(raw_gid)
        parent_user_id = org_group_info.get("parent_user_id") or getattr(u,"reporting_manager_id",None)
        members.append({"user_id":u.id,"user_name":u.full_name,"role":u.role,"is_self":u.id==cu.id,
            "group_id":",".join(str(gid) for gid in group_ids) if group_ids else raw_gid,
            "group_ids":group_ids,
            "group_names":group_names,
            "group_name":", ".join(group_names) if group_names else _resolve_group(raw_gid),
            "reporting_manager_id":parent_user_id,
            "parent_user_id":parent_user_id,
            "customers":cust_count,"own_customers":own_customer_count,
            "customer_potential_value":customer_potential_value,
            "customers_with_win":customers_with_win_map.get(uid,0),"customers_pending":customers_pending_map.get(uid,0),
            **act,
            "calls_target":tgt.calls_target if tgt else 0,
            "meetings_target":tgt.meetings_target if tgt else 0,
            "sales_target":sales_target_by_user.get(uid, 0.0),
            "annual_sales_target":annual_sales_target_by_user.get(uid, sales_target_by_user.get(uid, 0.0)),
            **ls,**ts,**qs,"wo_count":wo["wo_count"],"wo_value":wo["wo_value"],
            "pipeline_conversion":pipeline_conversion,
            "payment_received":wo["payment_received"]})
    members.sort(key=lambda m:(not m["is_self"],-m["completed"]))
    return {"period":period,"members":members,"master_groups":group_fixing_groups}


def _require_weekly_plan_admin(cu: User) -> None:
    if str(cu.role or "").lower() not in {"ceo", "admin", "super_admin", "manager", "sales_head", "saleshead", "vp"}:
        raise HTTPException(status_code=403, detail="Only CEO/Head/Admin can manage weekly plan escalations")


@router.get("/weekly-plan/status")
def get_weekly_plan_status(
    db: Session=Depends(get_tenant_db),
    cu: User=Depends(require_permission("kam.view")),
):
    _require_weekly_plan_admin(cu)
    return weekly_plan_report_status(db)


@router.post("/weekly-plan/send-ceo-report")
def send_weekly_plan_ceo_report(
    force: bool = Query(False, description="Send now even if it is not Monday 11 AM or already sent"),
    db: Session=Depends(get_tenant_db),
    cu: User=Depends(get_current_user),
):
    _require_weekly_plan_admin(cu)
    try:
        result = send_weekly_plan_ceo_report_if_due(db, force=force)
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


@router.post("/weekly-plan/send-escalation")
def send_weekly_plan_escalation(
    data: WeeklyPlanEscalationIn,
    force: bool = Query(False, description="Allow manual send before Monday 11 AM"),
    db: Session=Depends(get_tenant_db),
    cu: User=Depends(get_current_user),
):
    _require_weekly_plan_admin(cu)
    status = weekly_plan_report_status(db)
    if not force and not bool(status.get("due_now")):
        raise HTTPException(status_code=400, detail="Escalation can be sent only after Monday 11:00 AM grace time")
    if not bool(status.get("force_send_possible")):
        raise HTTPException(status_code=400, detail=f"Escalation cannot be sent: {status.get('reason')}")

    try:
        result = send_weekly_plan_escalations(db, user_ids=data.user_ids)
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


@router.get("/weekly-plan/send-escalation-link", response_class=HTMLResponse)
@router.get("/weekly-plan/send-reminder", response_class=HTMLResponse)
def send_weekly_plan_reminder(token: str, db: Session=Depends(get_tenant_db)):
    try:
        result = send_weekly_plan_reminders_from_token(db, token)
        db.commit()
    except WeeklyPlanTokenError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception:
        db.rollback()
        raise

    sent = int(result.get("sent") or 0)
    requested = int(result.get("requested") or 0)
    if sent:
        title = "KAM escalations sent"
        message = f"Sent {sent} escalation email(s)."
    elif requested == 0:
        title = "No escalations needed"
        message = "All selected employees have planned their KAM week now."
    else:
        title = "No emails sent"
        message = "The selected employees could not be emailed. Check email settings and user email addresses."

    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>{title}</title>"
        "</head><body style='margin:0;background:#f8fafc;font-family:Inter,Arial,sans-serif;color:#0f172a;'>"
        "<main style='min-height:100vh;display:grid;place-items:center;padding:24px;'>"
        "<section style='max-width:520px;width:100%;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px;box-shadow:0 18px 45px rgba(15,23,42,.08);'>"
        f"<h1 style='margin:0 0 10px;font-size:24px;'>{title}</h1>"
        f"<p style='margin:0;color:#475569;line-height:1.5;'>{message}</p>"
        "</section></main></body></html>"
    )


# --- Performance (backward compat) --------------------------------------------

@router.get("/performance")
def get_performance(user_id: Optional[int]=None, period: Optional[str]=None,
                    view_type: Optional[str]=None, year: Optional[int]=None,
                    date_from: Optional[str]=None, date_to: Optional[str]=None,
                    db: Session=Depends(get_tenant_db), cu: User=Depends(require_permission("kam.view"))):
    if not period: period=now_ist().strftime("%Y-%m")
    d_from,d_to,cy,is_yearly = _resolve_360_window(period, view_type, year, date_from, date_to)
    scope_uids = _get_team_uids(cu, db)
    if user_id:
        scope_uids=[_get_visible_uids(cu,db,user_id)[0]]; uid=user_id
    elif len(scope_uids) > 1:
        uid=None
    else:
        uid=cu.id
    is_agg = uid is None
    act_q=db.query(KAMActivity).filter(KAMActivity.activity_date.between(d_from,d_to))
    if uid: act_q=act_q.filter(KAMActivity.user_id==uid)
    else:   act_q=act_q.filter(KAMActivity.user_id.in_(scope_uids))
    activities=act_q.all()
    def c(atype=None,st=None,acts=None):
        src=acts if acts is not None else activities
        return sum(1 for a in src if (not atype or a.activity_type==atype) and (not st or a.status==st))
    if is_yearly or is_agg:
        mts = _target_rows_for_window(db, [uid] if uid else scope_uids, d_from, d_to)
        ct=sum(t.calls_target or 0 for t in mts); mt_=sum(t.meetings_target or 0 for t in mts)
        dt=sum(getattr(t,"demos_target",0) or 0 for t in mts); svt=sum(getattr(t,"site_visits_target",0) or 0 for t in mts)
        st=sum(float(getattr(t,"sales_target",0) or 0) for t in mts)
    else:
        tgt=db.query(KAMTarget).filter(KAMTarget.user_id==uid,KAMTarget.period==period).first()
        ct=tgt.calls_target if tgt else 0; mt_=tgt.meetings_target if tgt else 0
        dt=getattr(tgt,"demos_target",0) if tgt else 0; svt=getattr(tgt,"site_visits_target",0) if tgt else 0
        st=float(getattr(tgt,"sales_target",0) or 0) if tgt else 0
    if uid:
        uo=db.query(User).filter(User.id==uid).first()
        dn=uo.full_name if uo else ""; dr=uo.role if uo else ""
        utv=float(getattr(uo,"target",None) or 0) if uo else 0
        st=st or utv
    else: dn="All Team Members"; dr="team"; utv=0
    is_admin_all_scope = uid is None and _kam_scope_is_all(cu, db)
    stats_scope = None if is_admin_all_scope else (scope_uids if uid is None else [uid])
    ls=_lead_stats(stats_scope,db,d_from,d_to)
    ts=_tender_stats(stats_scope,db,d_from,d_to)
    wo=_wo_stats(stats_scope,db,d_from,d_to)
    def _c_multi(atypes, st=None, acts=None):
        src = acts if acts is not None else activities
        return sum(1 for a in src if a.activity_type in atypes and (not st or a.status==st))
    actuals={"calls":_c_multi(("Phone Call","Daily Call"),"Completed"),
             "video_calls":_c_multi(("Video Call",),"Completed"),
             "meetings":_c_multi(("In Person Meet","Meeting"),"Completed"),
             "demos":_c_multi(("Demo",),"Completed"),
             "site_visits":_c_multi(("Site Visit",),"Completed"),
             "follow_ups":_c_multi(("Follow Up","Follow-up"),"Completed"),
             "emails":_c_multi(("Email",),"Completed"),
             "calls_total":_c_multi(("Phone Call","Daily Call")),
             "video_calls_total":_c_multi(("Video Call",)),
             "meetings_total":_c_multi(("In Person Meet","Meeting")),
             "demos_total":_c_multi(("Demo",)),
             "site_visits_total":_c_multi(("Site Visit",)),
             "follow_ups_total":_c_multi(("Follow Up","Follow-up")),
             "emails_total":_c_multi(("Email",)),
             "total":len(activities),"completed":c(st="Completed"),
             "pending":c(st="Planned")+c(st="In Progress"),"cancelled":c(st="Cancelled")}
    quarterly=[]
    if is_yearly:
        for qn in range(1,5):
            qf,qt=_quarter_range(cy,qn); q_acts=[a for a in activities if qf<=str(a.activity_date)<=qt]
            qms=[f"{cy}-{(qn-1)*3+m:02d}" for m in range(1,4)]
            qtq=db.query(KAMTarget).filter(KAMTarget.period.in_(qms))
            if uid: qtq=qtq.filter(KAMTarget.user_id==uid)
            else:   qtq=qtq.filter(KAMTarget.user_id.in_(scope_uids))
            qtgs=qtq.all()
            quarterly.append({"quarter":qn,"label":f"Q{qn} {cy}","total":len(q_acts),
                "completed":c(st="Completed",acts=q_acts),"pending":c(st="Planned",acts=q_acts)+c(st="In Progress",acts=q_acts),
                "calls":_c_multi(("Phone Call","Daily Call"),"Completed",q_acts),
                "meetings":_c_multi(("In Person Meet","Meeting"),"Completed",q_acts),
                "calls_target":sum(t.calls_target or 0 for t in qtgs),
                "meetings_target":sum(t.meetings_target or 0 for t in qtgs)})
    cust_ids=list({a.customer_id for a in activities if a.customer_id}); cb=[]
    customer_map = {
        int(customer.id): customer
        for customer in db.query(Customer).filter(Customer.id.in_(cust_ids)).all()
    } if cust_ids else {}
    start_date = end_date = start_dt = end_dt = None
    if d_from and d_to:
        start_date = date.fromisoformat(str(d_from))
        end_date = date.fromisoformat(str(d_to))
        start_dt = datetime.combine(start_date, datetime.min.time())
        end_dt = datetime.combine(end_date, datetime.max.time())

    lead_stats_q = db.query(
        Lead.customer_id,
        func.count(Lead.id),
        func.coalesce(func.sum(Lead.est_value), 0),
    ).filter(
        Lead.customer_id.in_(cust_ids),
        Lead.is_deleted == False,
    ) if cust_ids else None
    tender_stats_q = db.query(
        Tender.customer_id,
        func.count(Tender.id),
        func.coalesce(func.sum(Tender.est_value), 0),
    ).filter(
        Tender.customer_id.in_(cust_ids),
        Tender.is_deleted == False,
    ) if cust_ids else None
    workorder_stats_q = db.query(
        KAMWorkOrder.customer_id,
        func.count(KAMWorkOrder.id),
        func.coalesce(func.sum(KAMWorkOrder.order_value), 0),
        func.coalesce(func.sum(KAMWorkOrder.payment_received), 0),
    ).filter(KAMWorkOrder.customer_id.in_(cust_ids)) if cust_ids else None

    if cust_ids:
        if uid:
            lead_stats_q = lead_stats_q.filter(Lead.assigned_to == uid)
            tender_stats_q = tender_stats_q.filter(Tender.assigned_to == uid)
            workorder_stats_q = workorder_stats_q.filter(KAMWorkOrder.user_id == uid)
        else:
            lead_stats_q = lead_stats_q.filter(Lead.assigned_to.in_(scope_uids))
            tender_stats_q = tender_stats_q.filter(Tender.assigned_to.in_(scope_uids))
            workorder_stats_q = workorder_stats_q.filter(KAMWorkOrder.user_id.in_(scope_uids))
        if start_date and end_date and start_dt and end_dt:
            lead_stats_q = lead_stats_q.filter(func.coalesce(Lead.lead_created_at, Lead.created_at).between(start_dt, end_dt))
            tender_stats_q = tender_stats_q.filter(or_(
                and_(Tender.result_date.isnot(None), Tender.result_date.between(start_date, end_date)),
                and_(Tender.submission_date.isnot(None), Tender.submission_date.between(start_date, end_date)),
                and_(Tender.published_date.isnot(None), Tender.published_date.between(start_date, end_date)),
                Tender.created_at.between(start_dt, end_dt),
            ))
            workorder_stats_q = workorder_stats_q.filter(or_(
                and_(KAMWorkOrder.order_date.isnot(None), KAMWorkOrder.order_date.between(start_date, end_date)),
                and_(KAMWorkOrder.order_date.is_(None), KAMWorkOrder.created_at.between(start_dt, end_dt)),
            ))
    lead_stats = {
        int(customer_id): {"count": int(count or 0), "value": float(value or 0)}
        for customer_id, count, value in lead_stats_q.group_by(Lead.customer_id).all()
        if customer_id is not None
    } if lead_stats_q is not None else {}
    tender_stats = {
        int(customer_id): {"count": int(count or 0), "value": float(value or 0)}
        for customer_id, count, value in tender_stats_q.group_by(Tender.customer_id).all()
        if customer_id is not None
    } if tender_stats_q is not None else {}
    workorder_stats = {
        int(customer_id): {
            "count": int(count or 0),
            "order_value": float(order_value or 0),
            "payment_received": float(payment_received or 0),
        }
        for customer_id, count, order_value, payment_received in workorder_stats_q.group_by(KAMWorkOrder.customer_id).all()
        if customer_id is not None
    } if workorder_stats_q is not None else {}

    for cid in cust_ids:
        cust = customer_map.get(int(cid))
        ca=[a for a in activities if a.customer_id==cid]
        lead_stat = lead_stats.get(int(cid), {"count": 0, "value": 0.0})
        tender_stat = tender_stats.get(int(cid), {"count": 0, "value": 0.0})
        workorder_stat = workorder_stats.get(int(cid), {"count": 0, "order_value": 0.0, "payment_received": 0.0})
        cb.append({"customer_id":cid,"customer_name":cust.customer_name if cust else "",
            "activities":len(ca),"completed":sum(1 for a in ca if a.status=="Completed"),
            "calls":sum(1 for a in ca if a.activity_type in ("Phone Call","Daily Call") and a.status=="Completed"),
            "meetings":sum(1 for a in ca if a.activity_type in ("In Person Meet","Meeting") and a.status=="Completed"),
            "lead_count":lead_stat["count"],"lead_value":lead_stat["value"],
            "tender_count":tender_stat["count"],"tender_value":tender_stat["value"],
            "work_orders":workorder_stat["count"],"order_value":workorder_stat["order_value"],
            "payment_received":workorder_stat["payment_received"]})
    recent_activity_rows = sorted(activities,key=lambda x:x.activity_date,reverse=True)[:10]
    recent_user_name_map = {}
    if is_agg:
        recent_user_ids = {int(a.user_id) for a in recent_activity_rows if a.user_id}
        recent_user_name_map = {
            int(u.id): u.full_name
            for u in db.query(User).filter(User.id.in_(recent_user_ids)).all()
        } if recent_user_ids else {}

    return {"user_id":uid,"user_name":dn,"user_role":dr,"is_aggregate":is_agg,
            "period":period,"year":cy,"is_yearly":is_yearly,"user_sales_target":utv,"sales_target":st,
            "actuals":actuals,"targets":{"calls":ct,"meetings":mt_,"demos":dt,"site_visits":svt},
            "financials":{"lead_count":ls["lead_count"],"total_lead_value":ls["lead_value"],
                "tender_count":ts["tender_count"],"total_tender_value":ts["tender_value"],
                "order_count":wo["wo_count"],"work_order_count":wo["wo_count"],
                "total_order_value":wo["wo_value"],"payment_received":wo["payment_received"]},
            "quarterly":quarterly,"customer_breakdown":cb,
            "activity_breakdown":{t:sum(1 for a in activities if a.activity_type==t) for t in ACTIVITY_TYPES},
            "recent_activities":[{"id":a.id,"type":a.activity_type,"subject":a.subject,
                "date":str(a.activity_date),"status":a.status,"customer_id":a.customer_id,
                "outcome":_safe_get(a,"outcome"),"user_name":recent_user_name_map.get(int(a.user_id), "") if is_agg and a.user_id else ""}
                for a in recent_activity_rows]}
