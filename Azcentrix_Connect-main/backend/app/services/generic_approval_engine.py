from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from app.core.timezone import now_ist, today_ist
from app.core.logging import log_module_action
from typing import Any, Iterable, Optional

from fastapi import HTTPException
from sqlalchemy import func, inspect, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.database import MasterSessionLocal, get_tenant_session_by_db_name
from app.models.all_models import (
    Approval,
    ApprovalAutoApproveSetting,
    ApprovalEscalationRule,
    ApprovalEscalationSetting,
    ApprovalRequest,
    ApprovalRequestStep,
    ApprovalRule,
    ApprovalRuleStep,
    ActivityLog,
    Customer,
    CustomerContact,
    CustomerBillingConsignee,
    CustomerShippingConsignee,
    EMDBG,
    Lead,
    LeadProduct,
    LeadProductOEM,
    OrgTreeNode,
    Role,
    Tender,
    TenderDocument,
    TenderLossAnalysis,
    TenderProduct,
    TenderProductOEM,
    TenderTechBidBidder,
    TenderTechBidItem,
    TravelRequest,
    User,
    UserReportingHierarchy,
)
from app.models.tenant import Tenant
from app.services.notification_service import upsert_notification
from app.services.user_group_service import get_effective_user_group_ids

logger = logging.getLogger(__name__)


APPROVAL_MODULES = [
    {
        "key": "customer",
        "label": "Customer",
        "actions": [
            {"key": "create", "label": "Create"},
        ],
    },
    {
        "key": "lead",
        "label": "Lead",
        "actions": [
            {"key": "convert", "label": "Convert"},
        ],
    },
    {
        "key": "tender",
        "label": "Tender",
        "actions": [
            {"key": "tender_details", "label": "Tender Details"},
            {"key": "workings", "label": "Workings"},
            {"key": "po_details", "label": "PO Details"},
            {"key": "stage", "label": "Stage change (approval-gated stages, e.g. Go / No-Go)"},
            {"key": "price_bid", "label": "Price bid (Freeze & send for approval)"},
        ],
    },
    {
        "key": "emdbg",
        "label": "EMD / BG",
        "actions": [
            {"key": "release", "label": "Release"},
            # Guarantees & Deposits v18: new guarantee / deposit request – head approval (Sales Head), and the chain for
            # requests of ₹50 lakh and above (Sales Head + Company Admin). Approved requests go to the Finance desk.
            {"key": "request", "label": "New guarantee / deposit request (below ₹50 lakh)"},
            {"key": "request_50l", "label": "New guarantee / deposit request (₹50 lakh and above)"},
            # Guarantees & Deposits v17: "Request release" (prototype approval chain "BG release") and "Extend validity".
            {"key": "release_request", "label": "BG release (request release)"},
            {"key": "extend", "label": "Extend validity"},
        ],
    },
    {
        "key": "travel",
        "label": "Travel",
        "actions": [
            {"key": "request", "label": "Request"},
        ],
    },
    {
        "key": "quotation",
        "label": "Quotation",
        "actions": [
            {"key": "submit", "label": "Submit for Approval"},
            # Quotes: Send for approval / moving a quote into (or past) a lifecycle stage whose gate is "Approval".
            {"key": "stage", "label": "Stage change (approval-gated stages)"},
        ],
    },
    {
        # Product & Price Books: discounts deeper than the configured limit (Settings → Product & Price Books).
        "key": "price_book",
        "label": "Price book",
        "actions": [
            {"key": "discount", "label": "Price book discount beyond limit"},
            {"key": "override", "label": "Product price override beyond limit"},
        ],
    },
    {
        # Product & Price Books (v18): moving a product into the approved / released record status, and opening a
        # change window to edit an approved (locked) product record.
        "key": "product",
        "label": "Product",
        "actions": [
            {"key": "approve", "label": "Approve product record (approved status)"},
            {"key": "change", "label": "Change to an approved product record"},
        ],
    },
    {
        # Deals: moving a deal into a pipeline stage whose gate is "Approval" (Pipelines & Stages).
        "key": "deal",
        "label": "Deal",
        "actions": [
            {"key": "stage", "label": "Stage change (approval-gated stages)"},
        ],
    },
    {
        # Orders & Projects: moving an order into (or past) a lifecycle stage whose gate is "Approval".
        "key": "work_order",
        "label": "Work order",
        "actions": [
            {"key": "stage", "label": "Stage change (approval-gated stages)"},
        ],
    },
    {
        # Forecasts: "Submit forecast" sends the period snapshot to the Sales Head / configured approval authority.
        "key": "forecast",
        "label": "Forecast",
        "actions": [
            {"key": "submit", "label": "Submit forecast"},
        ],
    },
]

APPROVER_TYPE_OPTIONS = [
    {"key": "role", "label": "Role"},
    {"key": "specific_user", "label": "Specific User"},
]

REQUESTER_TYPE_OPTIONS = [
    {"key": "role", "label": "Role"},
    {"key": "specific_user", "label": "Specific User"},
    {"key": "group", "label": "Group"},
]

FLOW_TYPE_OPTIONS = [
    {"key": "sequential", "label": "Company-defined Chain"},
    {"key": "hierarchy", "label": "Legacy Hierarchy"},
]

APPROVER_ROLE_OPTIONS = [
    {"key": "manager", "label": "Manager"},
    {"key": "vp", "label": "VP"},
    {"key": "accounts", "label": "Accounts"},
    {"key": "ceo", "label": "CEO"},
    {"key": "admin", "label": "Admin"},
    {"key": "sales", "label": "Sales"},
    {"key": "support", "label": "Support"},
]

HIERARCHY_ROLE_CHAIN_BY_REQUESTER_ROLE = {
    "sales": ("manager", "vp", "ceo"),
    "support": ("manager", "vp", "ceo"),
    "accounts": ("manager", "vp", "ceo"),
    "manager": ("ceo",),
    "vp": ("ceo",),
    "ceo": (),
    "admin": (),
}

TENDER_TIMELINE_STEP_META = {
    1: ("Step 1", "Basic Info"),
    2: ("Step 2", "Tender Details"),
    3: ("Step 3", "Workings"),
    4: ("Step 4", "Technical Bid"),
    5: ("Step 5", "Financial / Result"),
    6: ("Step 6", "PO Details"),
    7: ("Step 7", "Consignees"),
}

TENDER_TIMELINE_ACTION_STEPS = {
    "step1_saved": 1,
    "step2_submitted": 2,
    "step2_auto_approved": 2,
    "step2_mgr_auto_approved": 2,
    "step2_ceo_approved": 2,
    "tender_step2_manager_approved": 2,
    "tender_step2_ceo_approved": 2,
    "step3_submitted": 3,
    "step3_auto_approved": 3,
    "step3_mgr_auto_approved": 3,
    "step3_ceo_approved": 3,
    "tender_step3_manager_approved": 3,
    "tender_step3_ceo_approved": 3,
    "step4_saved": 4,
    "tech_bid_not_eligible": 4,
    "step5_saved": 5,
    "po_submitted": 6,
    "po_updated_pending": 6,
    "po_auto_approved": 6,
    "tender_po_manager_approved": 6,
    "consignees_submitted": 7,
}

TENDER_TIMELINE_ACTION_DETAILS = {
    "step1_saved": "Basic Info saved",
    "step2_submitted": "Tender Details submitted for approval",
    "step2_auto_approved": "Tender Details auto-approved",
    "step2_mgr_auto_approved": "Tender Details approved by manager",
    "step2_ceo_approved": "Tender Details approved by CEO",
    "tender_step2_manager_approved": "Tender Details approved by manager",
    "tender_step2_ceo_approved": "Tender Details approved by CEO",
    "step3_submitted": "Workings submitted for approval",
    "step3_auto_approved": "Workings auto-approved",
    "step3_mgr_auto_approved": "Workings approved by manager",
    "step3_ceo_approved": "Workings approved by CEO",
    "tender_step3_manager_approved": "Workings approved by manager",
    "tender_step3_ceo_approved": "Workings approved by CEO",
    "step4_saved": "Technical Bid saved",
    "tech_bid_not_eligible": "Technical Bid completed as Not Eligible",
    "step5_saved": "Financial / Result saved",
    "po_submitted": "PO Details submitted for approval",
    "po_updated_pending": "PO Details updated while approval is pending",
    "po_auto_approved": "PO Details auto-approved",
    "tender_po_manager_approved": "PO Details approved by manager",
    "consignees_submitted": "Consignees submitted",
}

TENDER_TIMELINE_LEGACY_APPROVAL_ACTION_ITEMS = {
    "tender_step1_manager": "tender-step-1",
    "tender_step1_ceo": "tender-step-1",
    "tender_step2_manager": "tender-step-2",
    "tender_step2_ceo": "tender-step-2",
    "tender_step3_manager": "tender-step-3",
    "tender_step3_ceo": "tender-step-3",
    "tender_po_manager": "tender-step-6",
}

TENDER_TIMELINE_DYNAMIC_APPROVAL_ACTION_ITEMS = {
    "tender_details": "tender-step-2",
    "workings": "tender-step-3",
    "po_details": "tender-step-6",
}

LEAD_TIMELINE_LEGACY_APPROVAL_ACTION_ITEMS = {
    "convert": "lead-converted",
    "convert_lead_manager": "lead-converted",
}

LEAD_TIMELINE_DYNAMIC_APPROVAL_ACTION_ITEMS = {
    "convert": "lead-converted",
}

TENDER_TIMELINE_EXTRA_DATE_COLUMNS = (
    "tender_fee_issued_date",
    "tender_fee_submitted_date",
    "tender_fee_valid_from",
    "tender_fee_expiry_date",
    "emd_issued_date",
    "emd_submitted_date",
    "emd_valid_from",
    "emd_expiry_date",
    "pbg_issued_date",
    "pbg_submitted_date",
    "pbg_valid_from",
    "pbg_expiry_date",
)

DEFAULT_HIERARCHY_ROLE_CHAIN = ("manager", "vp", "ceo")
MAX_REPORTING_CHAIN_DEPTH = 10
TOP_LEVEL_AUTO_APPROVAL_LEVEL = 1
TOP_LEVEL_AUTO_APPROVAL_ROLES = {"admin", "ceo"}
DEDICATED_APPROVAL_PUSH_MODULES = {"travel"}


def get_user_org_tree_level(db: Session, user: User) -> Optional[int]:
    """Return the org_tree_nodes.level for the given user, or None if not found."""
    node = (
        db.query(OrgTreeNode)
        .filter(OrgTreeNode.user_id == user.id, OrgTreeNode.is_active == True)
        .first()
    )
    return int(node.level) if node and node.level is not None else None


def _build_default_rule_blueprints() -> list[dict[str, str]]:
    blueprints: list[dict[str, str]] = []
    for module in APPROVAL_MODULES:
        for action in module["actions"]:
            blueprints.append(
                {
                    "module_key": module["key"],
                    "action_key": action["key"],
                    "name": f"{module['label']} - {action['label']}",
                    "approval_type": "hierarchy",
                }
            )
    return blueprints


DEFAULT_RULE_BLUEPRINTS = _build_default_rule_blueprints()


@dataclass
class ResolvedApprovalStep:
    step_no: int
    approver_user: User
    approver_role: Optional[str]
    resolved_from: str
    stop_on_reject: bool


@dataclass
class GroupHierarchyCandidate:
    hierarchy_id: int
    role: str
    user: User


@dataclass
class GroupHierarchyNode:
    hierarchy_id: int
    group_id: int
    user: User
    role: str
    level: int
    parent_user_id: Optional[int]


def _utcnow() -> datetime:
    return now_ist()


def normalize_role_key(value: Optional[str]) -> Optional[str]:
    normalized = (value or "").strip().lower()
    return normalized or None


def normalize_requester_type(value: Optional[str]) -> Optional[str]:
    normalized = (value or "").strip().lower()
    if normalized in {"role", "specific_user", "group"}:
        return normalized
    return None


def serialize_escalation_setting(setting: Optional[ApprovalEscalationSetting]) -> dict[str, Any]:
    return {
        "id": getattr(setting, "id", None),
        "tenant_id": getattr(setting, "tenant_id", None),
        "is_enabled": bool(getattr(setting, "is_enabled", False)),
        "default_escalation_minutes": getattr(setting, "default_escalation_minutes", None),
    }


def serialize_escalation_rule(rule: ApprovalEscalationRule) -> dict[str, Any]:
    return {
        "id": rule.id,
        "tenant_id": rule.tenant_id,
        "module_key": (rule.module_key or "").strip().lower(),
        "action_key": (rule.action_key or "").strip().lower(),
        "approver_role": normalize_role_key(rule.approver_role),
        "escalation_minutes": int(rule.escalation_minutes or 0),
        "is_active": bool(rule.is_active),
    }


def get_effective_approval_escalation_setting(
    db: Session,
    tenant_id: Optional[int],
) -> Optional[ApprovalEscalationSetting]:
    if tenant_id is not None:
        scoped = (
            db.query(ApprovalEscalationSetting)
            .filter(ApprovalEscalationSetting.tenant_id == tenant_id)
            .order_by(ApprovalEscalationSetting.id.asc())
            .first()
        )
        if scoped:
            return scoped

    fallback = (
        db.query(ApprovalEscalationSetting)
        .filter(ApprovalEscalationSetting.tenant_id.is_(None))
        .order_by(ApprovalEscalationSetting.id.asc())
        .first()
    )
    if fallback:
        return fallback

    return (
        db.query(ApprovalEscalationSetting)
        .order_by(ApprovalEscalationSetting.id.asc())
        .first()
    )


def get_effective_approval_escalation_minutes(
    db: Session,
    *,
    tenant_id: Optional[int],
    module_key: Optional[str],
    action_key: Optional[str],
    approver_role: Optional[str],
) -> Optional[int]:
    normalized_module = (module_key or "").strip().lower()
    normalized_action = (action_key or "").strip().lower()
    normalized_role = normalize_role_key(approver_role)

    if not normalized_module or not normalized_action or not normalized_role:
        setting = get_effective_approval_escalation_setting(db, tenant_id)
        default_minutes = getattr(setting, "default_escalation_minutes", None) if setting else None
        return int(default_minutes) if default_minutes and int(default_minutes) > 0 else None

    candidate_query = (
        db.query(ApprovalEscalationRule)
        .filter(
            ApprovalEscalationRule.module_key == normalized_module,
            ApprovalEscalationRule.action_key == normalized_action,
            func.lower(func.trim(ApprovalEscalationRule.approver_role)) == normalized_role,
            ApprovalEscalationRule.is_active == True,
        )
        .order_by(ApprovalEscalationRule.id.asc())
    )

    if tenant_id is not None:
        scoped_rule = candidate_query.filter(ApprovalEscalationRule.tenant_id == tenant_id).first()
        if scoped_rule and int(scoped_rule.escalation_minutes or 0) > 0:
            return int(scoped_rule.escalation_minutes)

    fallback_rule = candidate_query.filter(ApprovalEscalationRule.tenant_id.is_(None)).first()
    if fallback_rule and int(fallback_rule.escalation_minutes or 0) > 0:
        return int(fallback_rule.escalation_minutes)

    setting = get_effective_approval_escalation_setting(db, tenant_id)
    default_minutes = getattr(setting, "default_escalation_minutes", None) if setting else None
    return int(default_minutes) if default_minutes and int(default_minutes) > 0 else None


def serialize_auto_approve_setting(setting: ApprovalAutoApproveSetting) -> dict[str, Any]:
    return {
        "id": setting.id,
        "tenant_id": setting.tenant_id,
        "module_key": (setting.module_key or "").strip().lower(),
        "action_key": (setting.action_key or "").strip().lower(),
        "is_enabled": bool(setting.is_enabled),
    }


def is_auto_approve_enabled_when_no_rule(
    db: Session,
    *,
    tenant_id: Optional[int],
    module_key: Optional[str],
    action_key: Optional[str],
) -> bool:
    """Returns True only if an explicit, active setting turns auto-approve ON
    for this module+action. Absence of a setting (or is_enabled=False) always
    means False, preserving the existing group-hierarchy fallback behavior."""
    normalized_module = (module_key or "").strip().lower()
    normalized_action = (action_key or "").strip().lower()
    if not normalized_module or not normalized_action:
        return False

    candidate_query = db.query(ApprovalAutoApproveSetting).filter(
        ApprovalAutoApproveSetting.module_key == normalized_module,
        ApprovalAutoApproveSetting.action_key == normalized_action,
    )

    if tenant_id is not None:
        scoped = candidate_query.filter(ApprovalAutoApproveSetting.tenant_id == tenant_id).first()
        if scoped is not None:
            return bool(scoped.is_enabled)

    fallback = candidate_query.filter(ApprovalAutoApproveSetting.tenant_id.is_(None)).first()
    if fallback is not None:
        return bool(fallback.is_enabled)

    return False


def has_top_level_auto_approval_privilege(user: Optional[User]) -> bool:
    if not user:
        return False
    return normalize_role_key(getattr(user, "role", None)) in TOP_LEVEL_AUTO_APPROVAL_ROLES


def _primary_group_id_from_value(value: Any) -> Optional[int]:
    group_ids = _parse_group_ids(value)
    if not group_ids:
        return None
    return group_ids[0]


def _parse_group_ids(value: Any) -> list[int]:
    if value is None:
        return []
    if isinstance(value, int):
        return [value]
    if isinstance(value, str):
        group_ids: list[int] = []
        for part in value.split(","):
            normalized = part.strip()
            if normalized.isdigit():
                group_ids.append(int(normalized))
        return group_ids
    if isinstance(value, (list, tuple, set)):
        group_ids: list[int] = []
        for item in value:
            if isinstance(item, int):
                group_ids.append(item)
            elif isinstance(item, str):
                normalized = item.strip()
                if normalized.isdigit():
                    group_ids.append(int(normalized))
        return group_ids
    return []


def normalize_group_id(value: Any) -> Optional[int]:
    group_ids = _parse_group_ids(value)
    if not group_ids:
        return None
    return int(group_ids[0])


def get_user_group_ids(user: Optional[User]) -> list[int]:
    if not user:
        return []
    return get_effective_user_group_ids(user)


def get_role_options(db: Session) -> list[dict[str, str]]:
    seen_roles: set[str] = set()
    options: list[dict[str, str]] = []

    active_roles = (
        db.query(Role)
        .filter(Role.is_active == True)
        .order_by(Role.level.asc(), Role.display_name.asc(), Role.name.asc())
        .all()
    )
    for role in active_roles:
        key = normalize_role_key(role.name)
        if not key or key in seen_roles:
            continue
        seen_roles.add(key)
        options.append(
            {
                "key": key,
                "label": (role.display_name or role.name or key).strip(),
            }
        )

    user_roles = (
        db.query(User.role)
        .filter(
            User.is_active == True,
            User.role.is_not(None),
        )
        .distinct()
        .all()
    )
    for (role_name,) in user_roles:
        key = normalize_role_key(role_name)
        if not key or key in seen_roles:
            continue
        seen_roles.add(key)
        options.append({"key": key, "label": humanize_key(key)})

    hierarchy_roles = (
        db.query(UserReportingHierarchy.reporting_role)
        .filter(
            UserReportingHierarchy.is_active == True,
            UserReportingHierarchy.reporting_role.is_not(None),
        )
        .distinct()
        .all()
    )
    for (role_name,) in hierarchy_roles:
        key = normalize_role_key(role_name)
        if not key or key in seen_roles:
            continue
        seen_roles.add(key)
        options.append({"key": key, "label": humanize_key(key)})

    if options:
        return options
    return APPROVER_ROLE_OPTIONS


def _query_candidate_rules(
    db: Session,
    *,
    tenant_id: Optional[int],
    module_key: str,
    action_key: str,
) -> list[ApprovalRule]:
    base_query = (
        db.query(ApprovalRule)
        .filter(
            ApprovalRule.module_key == module_key,
            ApprovalRule.action_key == action_key,
            ApprovalRule.is_active == True,
        )
        .order_by(ApprovalRule.id.asc())
    )

    if tenant_id is None:
        return base_query.filter(ApprovalRule.tenant_id.is_(None)).all()

    tenant_rules = base_query.filter(ApprovalRule.tenant_id == tenant_id).all()
    if tenant_rules:
        return tenant_rules
    return base_query.filter(ApprovalRule.tenant_id.is_(None)).all()


def find_matching_approval_rule(
    db: Session,
    *,
    tenant_id: Optional[int],
    requester: User,
    module_key: str,
    action_key: str,
    request_group_id: Optional[int] = None,
) -> Optional[ApprovalRule]:
    candidate_rules = _query_candidate_rules(
        db,
        tenant_id=tenant_id,
        module_key=module_key,
        action_key=action_key,
    )
    if not candidate_rules:
        return None

    requester_role = normalize_role_key(getattr(requester, "role", None))
    requester_user_id = getattr(requester, "id", None)
    normalized_request_group_id = int(request_group_id) if request_group_id else None

    specific_user_rule = next(
        (
            rule
            for rule in candidate_rules
            if normalize_requester_type(getattr(rule, "requester_type", None)) == "specific_user"
            and getattr(rule, "requester_user_id", None) == requester_user_id
        ),
        None,
    )
    if specific_user_rule:
        return specific_user_rule

    if normalized_request_group_id is not None:
        group_rule = next(
            (
                rule
                for rule in candidate_rules
                if normalize_requester_type(getattr(rule, "requester_type", None)) == "group"
                and getattr(rule, "requester_group_id", None) == normalized_request_group_id
            ),
            None,
        )
        if group_rule:
            return group_rule

    role_rule = next(
        (
            rule
            for rule in candidate_rules
            if normalize_requester_type(getattr(rule, "requester_type", None)) == "role"
            and normalize_role_key(getattr(rule, "requester_role", None)) == requester_role
        ),
        None,
    )
    if role_rule:
        return role_rule

    legacy_fallback_role_rule = next(
        (
            rule
            for rule in candidate_rules
            if normalize_requester_type(getattr(rule, "requester_type", None)) == "role"
            and not normalize_role_key(getattr(rule, "requester_role", None))
            and getattr(rule, "requester_user_id", None) is None
            and getattr(rule, "requester_group_id", None) is None
        ),
        None,
    )
    if legacy_fallback_role_rule:
        return legacy_fallback_role_rule

    return next(
        (
            rule
            for rule in candidate_rules
            if normalize_requester_type(getattr(rule, "requester_type", None)) is None
            and not normalize_role_key(getattr(rule, "requester_role", None))
            and getattr(rule, "requester_user_id", None) is None
            and getattr(rule, "requester_group_id", None) is None
        ),
        None,
    )


def _find_group_head_user(
    db: Session,
    group_id: Optional[int],
    requester_id: Optional[int],
) -> Optional[User]:
    """Return the group head (most senior member, lowest level) for fallback approval.

    Returns None if:
    - No group structure found (no org_tree_nodes for this group)
    - The requester IS the group head (they should auto-approve instead)
    """
    nodes = _load_group_hierarchy_nodes(db, group_id)
    if not nodes:
        return None
    head_node = min(nodes, key=lambda n: n.level)
    head_user = head_node.user
    if getattr(head_user, "id", None) == requester_id:
        return None  # requester is the group head — caller should auto-approve
    return head_user


def _find_active_users_by_role(
    db: Session,
    role: str,
    *,
    exclude_user_ids: Optional[set[int]] = None,
) -> list[User]:
    normalized_role = (role or "").strip().lower()
    if not normalized_role:
        return []

    excluded_ids = {user_id for user_id in (exclude_user_ids or set()) if user_id is not None}
    users = (
        db.query(User)
        .filter(
            User.is_active == True,
            func.lower(func.trim(User.role)) == normalized_role,
        )
        .order_by(User.id.asc())
        .all()
    )
    if not excluded_ids:
        return users
    return [user for user in users if user.id not in excluded_ids]


def get_role_level(db: Session, role_name: Optional[str]) -> Optional[int]:
    normalized_role = (role_name or "").strip().lower()
    if not normalized_role:
        return None

    role_row = (
        db.query(Role)
        .filter(
            func.lower(func.trim(Role.name)) == normalized_role,
            Role.is_active == True,
        )
        .first()
    )
    if role_row and role_row.level is not None:
        return int(role_row.level)

    logger.warning("Role level not found in roles table for role '%s'.", normalized_role)
    return None


def get_user_role_level(db: Session, user: Optional[User]) -> Optional[int]:
    if not user:
        return None
    return get_role_level(db, getattr(user, "role", None))


def is_top_level_auto_approval_requester(db: Session, user: Optional[User]) -> bool:
    # Only admin and ceo roles always auto-approve; all other roles must follow
    # the configured approval workflow regardless of their role level in the DB.
    return has_top_level_auto_approval_privilege(user)


def _is_duplicate_column_error(exc: OperationalError) -> bool:
    orig = getattr(exc, "orig", None)
    args = getattr(orig, "args", ()) or ()
    return bool(args and args[0] == 1060)


def _execute_schema_statement(bind, statement: str) -> None:
    try:
        with bind.begin() as conn:
            conn.execute(text(statement))
    except OperationalError as exc:
        if _is_duplicate_column_error(exc):
            logger.info("Approval schema column already exists while applying: %s", statement)
            return
        raise


def _execute_schema_statements(bind, statements: Iterable[str]) -> None:
    for statement in statements:
        _execute_schema_statement(bind, statement)


def ensure_generic_approval_schema(db: Session) -> None:
    bind = db.get_bind()
    ApprovalEscalationSetting.__table__.create(bind=bind, checkfirst=True)
    ApprovalEscalationRule.__table__.create(bind=bind, checkfirst=True)
    ApprovalRule.__table__.create(bind=bind, checkfirst=True)
    ApprovalRequest.__table__.create(bind=bind, checkfirst=True)
    ApprovalRuleStep.__table__.create(bind=bind, checkfirst=True)
    ApprovalRequestStep.__table__.create(bind=bind, checkfirst=True)
    ApprovalAutoApproveSetting.__table__.create(bind=bind, checkfirst=True)

    inspector = inspect(bind)
    table_names = set(inspector.get_table_names())

    if "approval_escalation_settings" in table_names:
        columns = {col["name"] for col in inspector.get_columns("approval_escalation_settings")}
        statements: list[str] = []
        if "tenant_id" not in columns:
            statements.append("ALTER TABLE approval_escalation_settings ADD COLUMN tenant_id INT NULL")
        if "is_enabled" not in columns:
            statements.append("ALTER TABLE approval_escalation_settings ADD COLUMN is_enabled TINYINT(1) NOT NULL DEFAULT 0")
        if "default_escalation_minutes" not in columns:
            statements.append("ALTER TABLE approval_escalation_settings ADD COLUMN default_escalation_minutes INT NULL")
        if "created_at" not in columns:
            statements.append("ALTER TABLE approval_escalation_settings ADD COLUMN created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP")
        if "updated_at" not in columns:
            statements.append("ALTER TABLE approval_escalation_settings ADD COLUMN updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP")
        if statements:
            _execute_schema_statements(bind, statements)

    if "approval_escalation_rules" in table_names:
        columns = {col["name"] for col in inspector.get_columns("approval_escalation_rules")}
        statements: list[str] = []
        if "tenant_id" not in columns:
            statements.append("ALTER TABLE approval_escalation_rules ADD COLUMN tenant_id INT NULL")
        if "module" not in columns:
            statements.append("ALTER TABLE approval_escalation_rules ADD COLUMN module VARCHAR(100) NULL")
        if "action" not in columns:
            statements.append("ALTER TABLE approval_escalation_rules ADD COLUMN action VARCHAR(100) NULL")
        if "approver_role" not in columns:
            statements.append("ALTER TABLE approval_escalation_rules ADD COLUMN approver_role VARCHAR(50) NULL")
        if "escalation_minutes" not in columns:
            statements.append("ALTER TABLE approval_escalation_rules ADD COLUMN escalation_minutes INT NULL")
        if "is_active" not in columns:
            statements.append("ALTER TABLE approval_escalation_rules ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1")
        if "created_at" not in columns:
            statements.append("ALTER TABLE approval_escalation_rules ADD COLUMN created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP")
        if "updated_at" not in columns:
            statements.append("ALTER TABLE approval_escalation_rules ADD COLUMN updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP")
        if statements:
            _execute_schema_statements(bind, statements)
        with bind.begin() as conn:
            conn.execute(text(
                """
                UPDATE approval_escalation_rules
                SET module = NULLIF(LOWER(TRIM(module)), ''),
                    action = NULLIF(LOWER(TRIM(action)), ''),
                    approver_role = NULLIF(LOWER(TRIM(approver_role)), ''),
                    escalation_minutes = COALESCE(escalation_minutes, 0),
                    is_active = COALESCE(is_active, 1)
                """
            ))

    if "approval_auto_approve_settings" in table_names:
        columns = {col["name"] for col in inspector.get_columns("approval_auto_approve_settings")}
        statements: list[str] = []
        if "tenant_id" not in columns:
            statements.append("ALTER TABLE approval_auto_approve_settings ADD COLUMN tenant_id INT NULL")
        if "module" not in columns:
            statements.append("ALTER TABLE approval_auto_approve_settings ADD COLUMN module VARCHAR(100) NULL")
        if "action" not in columns:
            statements.append("ALTER TABLE approval_auto_approve_settings ADD COLUMN action VARCHAR(100) NULL")
        if "is_enabled" not in columns:
            statements.append("ALTER TABLE approval_auto_approve_settings ADD COLUMN is_enabled TINYINT(1) NOT NULL DEFAULT 0")
        if "created_at" not in columns:
            statements.append("ALTER TABLE approval_auto_approve_settings ADD COLUMN created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP")
        if "updated_at" not in columns:
            statements.append("ALTER TABLE approval_auto_approve_settings ADD COLUMN updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP")
        if statements:
            _execute_schema_statements(bind, statements)
        with bind.begin() as conn:
            conn.execute(text(
                """
                UPDATE approval_auto_approve_settings
                SET module = NULLIF(LOWER(TRIM(module)), ''),
                    action = NULLIF(LOWER(TRIM(action)), ''),
                    is_enabled = COALESCE(is_enabled, 0)
                """
            ))

    if "approval_rules" in table_names:
        columns = {col["name"] for col in inspector.get_columns("approval_rules")}
        statements: list[str] = []
        if "module" not in columns:
            statements.append("ALTER TABLE approval_rules ADD COLUMN module VARCHAR(100) NULL")
        if "action" not in columns:
            statements.append("ALTER TABLE approval_rules ADD COLUMN action VARCHAR(100) NULL")
        if "tenant_id" not in columns:
            statements.append("ALTER TABLE approval_rules ADD COLUMN tenant_id INT NULL")
        if "name" not in columns:
            statements.append("ALTER TABLE approval_rules ADD COLUMN name VARCHAR(200) NULL")
        if "approval_type" not in columns:
            statements.append("ALTER TABLE approval_rules ADD COLUMN approval_type VARCHAR(30) NULL DEFAULT 'hierarchy'")
        if "requester_type" not in columns:
            statements.append("ALTER TABLE approval_rules ADD COLUMN requester_type VARCHAR(50) NULL")
        if "requester_role" not in columns:
            statements.append("ALTER TABLE approval_rules ADD COLUMN requester_role VARCHAR(50) NULL")
        if "requester_user_id" not in columns:
            statements.append("ALTER TABLE approval_rules ADD COLUMN requester_user_id INT NULL")
        if "requester_group_id" not in columns:
            statements.append("ALTER TABLE approval_rules ADD COLUMN requester_group_id INT NULL")
        if "approver_type" not in columns:
            statements.append("ALTER TABLE approval_rules ADD COLUMN approver_type VARCHAR(50) NULL")
        if "approver_role" not in columns:
            statements.append("ALTER TABLE approval_rules ADD COLUMN approver_role VARCHAR(50) NULL")
        if "approver_user_id" not in columns:
            statements.append("ALTER TABLE approval_rules ADD COLUMN approver_user_id INT NULL")
        if "notify_roles" not in columns:
            statements.append("ALTER TABLE approval_rules ADD COLUMN notify_roles JSON NULL")
        if "escalation_hours" not in columns:
            statements.append("ALTER TABLE approval_rules ADD COLUMN escalation_hours INT NULL DEFAULT 48")
        if "is_active" not in columns:
            statements.append("ALTER TABLE approval_rules ADD COLUMN is_active TINYINT(1) NULL DEFAULT 1")
        if "created_at" not in columns:
            statements.append("ALTER TABLE approval_rules ADD COLUMN created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP")
        if "updated_at" not in columns:
            statements.append("ALTER TABLE approval_rules ADD COLUMN updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP")
        if statements:
            _execute_schema_statements(bind, statements)
        # Drop legacy FK on requester_group_id (now references org_tree_nodes, not groups)
        try:
            fk_rows = list(
                bind.execute(text(
                    "SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'approval_rules' "
                    "AND COLUMN_NAME = 'requester_group_id' AND REFERENCED_TABLE_NAME = 'groups'"
                ))
            )
            for fk_row in fk_rows:
                fk_name = fk_row[0]
                try:
                    with bind.begin() as conn:
                        conn.execute(text(f"ALTER TABLE approval_rules DROP FOREIGN KEY `{fk_name}`"))
                except OperationalError:
                    pass
        except Exception:
            pass

        if "rule_key" in columns:
            for _stmt in [
                "ALTER TABLE approval_rules MODIFY COLUMN rule_key VARCHAR(100) NULL DEFAULT NULL",
                "ALTER TABLE approval_rules DROP INDEX rule_key",
            ]:
                try:
                    with bind.begin() as conn:
                        conn.execute(text(_stmt))
                except OperationalError:
                    pass
        with bind.begin() as conn:
            if "label" in columns:
                conn.execute(text("UPDATE approval_rules SET name = COALESCE(NULLIF(name, ''), label)"))
            if "rule_key" in columns:
                conn.execute(text(
                    """
                    UPDATE approval_rules
                    SET action = CASE
                        WHEN action IS NOT NULL AND action <> '' THEN action
                        WHEN rule_key = 'lead_conversion' THEN 'convert'
                        WHEN rule_key = 'tender_submission' THEN 'submit'
                        WHEN rule_key = 'tender_won' THEN 'approve'
                        WHEN rule_key = 'purchase_order' THEN 'po_approval'
                        ELSE action
                    END
                    """
                ))
                conn.execute(text(
                    """
                    UPDATE approval_rules
                    SET module = CASE
                        WHEN module IS NOT NULL AND module <> '' THEN module
                        WHEN rule_key = 'lead_conversion' THEN 'lead'
                        WHEN rule_key IN ('tender_submission', 'tender_won', 'purchase_order') THEN 'tender'
                        ELSE module
                    END
                    """
                ))
            conn.execute(text(
                """
                UPDATE approval_rules
                SET approval_type = COALESCE(NULLIF(approval_type, ''), 'hierarchy')
                """
            ))
            conn.execute(text(
                """
                UPDATE approval_rules
                SET requester_type = NULLIF(LOWER(TRIM(requester_type)), '')
                """
            ))
            conn.execute(text(
                """
                UPDATE approval_rules
                SET requester_role = NULLIF(LOWER(TRIM(requester_role)), '')
                """
            ))
            conn.execute(text(
                """
                UPDATE approval_rules
                SET approver_type = COALESCE(NULLIF(approver_type, ''), 'reporting_manager')
                """
            ))
            conn.execute(text(
                """
                UPDATE approval_rules
                SET escalation_hours = COALESCE(escalation_hours, 48)
                """
            ))
        try:
            with bind.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE approval_rules MODIFY COLUMN approver_type "
                    "ENUM('reporting_manager','role','specific_user','hierarchy_level') "
                    "DEFAULT 'reporting_manager'"
                ))
        except Exception:
            pass

    if "approval_requests" in table_names:
        columns = {col["name"] for col in inspector.get_columns("approval_requests")}
        statements = []
        if "tenant_id" not in columns:
            statements.append("ALTER TABLE approval_requests ADD COLUMN tenant_id INT NULL")
        if "module" not in columns:
            statements.append("ALTER TABLE approval_requests ADD COLUMN module VARCHAR(100) NULL")
        if "action_key" not in columns:
            statements.append("ALTER TABLE approval_requests ADD COLUMN action_key VARCHAR(100) NULL")
        if "approval_rule_id" not in columns:
            statements.append("ALTER TABLE approval_requests ADD COLUMN approval_rule_id INT NULL")
        if "workflow_id" not in columns:
            statements.append("ALTER TABLE approval_requests ADD COLUMN workflow_id INT NULL")
        if "record_id" not in columns:
            statements.append("ALTER TABLE approval_requests ADD COLUMN record_id INT NULL")
        if "group_id" not in columns:
            statements.append("ALTER TABLE approval_requests ADD COLUMN group_id INT NULL")
        if "requester_user_id" not in columns:
            statements.append("ALTER TABLE approval_requests ADD COLUMN requester_user_id INT NULL")
        if "approver_user_ids" not in columns:
            statements.append("ALTER TABLE approval_requests ADD COLUMN approver_user_ids JSON NULL")
        if "approval_mode" not in columns:
            statements.append("ALTER TABLE approval_requests ADD COLUMN approval_mode VARCHAR(20) NULL")
        if "current_step_no" not in columns:
            statements.append("ALTER TABLE approval_requests ADD COLUMN current_step_no INT NOT NULL DEFAULT 1")
        if "overall_status" not in columns:
            statements.append("ALTER TABLE approval_requests ADD COLUMN overall_status VARCHAR(30) NULL DEFAULT 'pending'")
        if "created_at" not in columns:
            statements.append("ALTER TABLE approval_requests ADD COLUMN created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP")
        if "completed_at" not in columns:
            statements.append("ALTER TABLE approval_requests ADD COLUMN completed_at DATETIME NULL")
        if statements:
            _execute_schema_statements(bind, statements)

    inspector.clear_cache()
    table_names = set(inspector.get_table_names())

    if "approval_rule_steps" in table_names:
        columns = {col["name"] for col in inspector.get_columns("approval_rule_steps")}
        statements = []
        if "approval_rule_id" not in columns:
            statements.append("ALTER TABLE approval_rule_steps ADD COLUMN approval_rule_id INT NOT NULL")
        if "step_no" not in columns:
            statements.append("ALTER TABLE approval_rule_steps ADD COLUMN step_no INT NOT NULL DEFAULT 1")
        if "approver_type" not in columns:
            statements.append("ALTER TABLE approval_rule_steps ADD COLUMN approver_type VARCHAR(50) NOT NULL DEFAULT 'reporting_manager'")
        if "approver_role" not in columns:
            statements.append("ALTER TABLE approval_rule_steps ADD COLUMN approver_role VARCHAR(50) NULL")
        if "approver_user_id" not in columns:
            statements.append("ALTER TABLE approval_rule_steps ADD COLUMN approver_user_id INT NULL")
        if "is_required" not in columns:
            statements.append("ALTER TABLE approval_rule_steps ADD COLUMN is_required TINYINT(1) NOT NULL DEFAULT 1")
        if "stop_on_reject" not in columns:
            statements.append("ALTER TABLE approval_rule_steps ADD COLUMN stop_on_reject TINYINT(1) NOT NULL DEFAULT 1")
        if "approver_level" not in columns:
            statements.append("ALTER TABLE approval_rule_steps ADD COLUMN approver_level INT NULL")
        if "escalation_minutes" not in columns:
            statements.append("ALTER TABLE approval_rule_steps ADD COLUMN escalation_minutes INT NULL")
        if "created_at" not in columns:
            statements.append("ALTER TABLE approval_rule_steps ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP")
        if "updated_at" not in columns:
            statements.append("ALTER TABLE approval_rule_steps ADD COLUMN updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP")
        if statements:
            _execute_schema_statements(bind, statements)
        with bind.begin() as conn:
            conn.execute(text(
                """
                UPDATE approval_rule_steps
                SET is_required = COALESCE(is_required, 1),
                    stop_on_reject = COALESCE(stop_on_reject, 1),
                    approver_type = CASE
                        WHEN approver_type IS NULL OR TRIM(approver_type) = ''
                        THEN 'reporting_manager'
                        ELSE approver_type
                    END
                """
            ))
        try:
            with bind.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE approval_rule_steps MODIFY COLUMN approver_type "
                    "ENUM('reporting_manager','role','specific_user','hierarchy_level') "
                    "NOT NULL DEFAULT 'reporting_manager'"
                ))
        except Exception:
            pass

    if "approval_request_steps" in table_names:
        columns = {col["name"] for col in inspector.get_columns("approval_request_steps")}
        statements = []
        if "approval_request_id" not in columns:
            statements.append("ALTER TABLE approval_request_steps ADD COLUMN approval_request_id INT NOT NULL")
        if "step_no" not in columns:
            statements.append("ALTER TABLE approval_request_steps ADD COLUMN step_no INT NOT NULL DEFAULT 1")
        if "approver_user_id" not in columns:
            statements.append("ALTER TABLE approval_request_steps ADD COLUMN approver_user_id INT NULL")
        if "approver_role" not in columns:
            statements.append("ALTER TABLE approval_request_steps ADD COLUMN approver_role VARCHAR(50) NULL")
        if "status" not in columns:
            statements.append("ALTER TABLE approval_request_steps ADD COLUMN status VARCHAR(30) NOT NULL DEFAULT 'pending'")
        if "remarks" not in columns:
            statements.append("ALTER TABLE approval_request_steps ADD COLUMN remarks TEXT NULL")
        if "acted_at" not in columns:
            statements.append("ALTER TABLE approval_request_steps ADD COLUMN acted_at DATETIME NULL")
        if "assigned_at" not in columns:
            statements.append("ALTER TABLE approval_request_steps ADD COLUMN assigned_at DATETIME NULL")
        if "escalated_at" not in columns:
            statements.append("ALTER TABLE approval_request_steps ADD COLUMN escalated_at DATETIME NULL")
        if "escalation_count" not in columns:
            statements.append("ALTER TABLE approval_request_steps ADD COLUMN escalation_count INT NOT NULL DEFAULT 0")
        if "resolved_from" not in columns:
            statements.append("ALTER TABLE approval_request_steps ADD COLUMN resolved_from VARCHAR(100) NULL")
        if statements:
            _execute_schema_statements(bind, statements)
        with bind.begin() as conn:
            conn.execute(text(
                """
                UPDATE approval_request_steps
                SET escalation_count = COALESCE(escalation_count, 0)
                """
            ))

    inspector.clear_cache()
    table_names = set(inspector.get_table_names())

    if "user_reporting_hierarchy" in table_names:
        columns = {col["name"] for col in inspector.get_columns("user_reporting_hierarchy")}
        statements = []
        if "parent_user_id" not in columns:
            statements.append("ALTER TABLE user_reporting_hierarchy ADD COLUMN parent_user_id INT NULL")
        if statements:
            _execute_schema_statements(bind, statements)

        hierarchy_rows = (
            db.query(UserReportingHierarchy)
            .filter(
                UserReportingHierarchy.group_id.is_not(None),
                UserReportingHierarchy.is_active == True,
            )
            .order_by(
                UserReportingHierarchy.group_id.asc(),
                UserReportingHierarchy.level.asc(),
                UserReportingHierarchy.id.asc(),
            )
            .all()
        )
        hierarchy_changed = False
        rows_by_group: dict[int, list[UserReportingHierarchy]] = {}
        for row in hierarchy_rows:
            if row.group_id is None:
                continue
            rows_by_group.setdefault(int(row.group_id), []).append(row)

        for group_rows in rows_by_group.values():
            active_rows = [row for row in group_rows if getattr(row, "reporting_user_id", None)]
            for index, row in enumerate(active_rows):
                expected_parent_user_id = (
                    getattr(active_rows[index + 1], "reporting_user_id", None)
                    if index + 1 < len(active_rows)
                    else None
                )
                if getattr(row, "parent_user_id", None) != expected_parent_user_id:
                    row.parent_user_id = expected_parent_user_id
                    hierarchy_changed = True
        if hierarchy_changed:
            db.flush()


def seed_default_approval_rules(db: Session, tenant_id: Optional[int]) -> None:
    ensure_generic_approval_schema(db)
    existing_rules = (
        db.query(ApprovalRule)
        .filter(
            ApprovalRule.module_key.is_not(None),
            ApprovalRule.action_key.is_not(None),
        )
        .order_by(ApprovalRule.id.asc())
        .all()
    )
    existing_by_key = {
        ((rule.module_key or "").strip().lower(), (rule.action_key or "").strip().lower()): rule
        for rule in existing_rules
        if rule.module_key and rule.action_key
    }
    touched = False

    for blueprint in DEFAULT_RULE_BLUEPRINTS:
        key = (blueprint["module_key"], blueprint["action_key"])
        rule = existing_by_key.get(key)

        if rule is None:
            rule = ApprovalRule(
                tenant_id=tenant_id,
                module_key=blueprint["module_key"],
                action_key=blueprint["action_key"],
                name=blueprint["name"],
                approval_type=blueprint["approval_type"],
                approver_type="reporting_manager",
                is_active=True,
                created_at=_utcnow(),
                updated_at=_utcnow(),
            )
            db.add(rule)
            db.flush()
            existing_by_key[key] = rule
            touched = True
        else:
            rule_changed = False
            if not rule.name:
                rule.name = blueprint["name"]
                rule_changed = True
            if not rule.tenant_id and tenant_id is not None:
                rule.tenant_id = tenant_id
                rule_changed = True
            if rule_changed:
                rule.updated_at = _utcnow()
                touched = True

    if touched:
        db.commit()


def get_approval_catalog(role_options: Optional[list[dict[str, str]]] = None) -> dict:
    resolved_role_options = role_options or APPROVER_ROLE_OPTIONS
    return {
        "modules": APPROVAL_MODULES,
        "flow_types": FLOW_TYPE_OPTIONS,
        "requester_types": REQUESTER_TYPE_OPTIONS,
        "approver_types": APPROVER_TYPE_OPTIONS,
        "requester_roles": resolved_role_options,
        "approver_roles": resolved_role_options,
    }


def humanize_key(value: str) -> str:
    return str(value or "").replace("_", " ").strip().title()


def get_module_label(module_key: str) -> str:
    normalized_module = (module_key or "").strip().lower()
    for module in APPROVAL_MODULES:
        if module["key"] == normalized_module:
            return module["label"]
    return humanize_key(normalized_module or "module")


def get_action_label(module_key: str, action_key: str) -> str:
    normalized_module = (module_key or "").strip().lower()
    normalized_action = (action_key or "").strip().lower()
    for module in APPROVAL_MODULES:
        if module["key"] != normalized_module:
            continue
        for action in module["actions"]:
            if action["key"] == normalized_action:
                return action["label"]
        return humanize_key(normalized_action or "action")
    return humanize_key(normalized_action or "action")


def get_request_progress(request: ApprovalRequest) -> dict[str, Any]:
    steps = sorted(request.steps or [], key=lambda item: item.step_no)
    total_steps = len(steps)
    approved_steps = sum(1 for step in steps if (step.status or "").strip().lower() == "approved")
    normalized_status = (request.status or "").strip().lower() or "pending"

    if normalized_status == "approved":
        approved_steps = total_steps or approved_steps

    status_label = {
        "pending": "Pending",
        "approved": "Approved",
        "rejected": "Rejected",
    }.get(normalized_status, humanize_key(normalized_status))

    display = f"{status_label} ({approved_steps}/{total_steps})" if total_steps else status_label
    return {
        "current": approved_steps,
        "total": total_steps,
        "display": display,
    }


def _sync_request_step_assignments(
    request: ApprovalRequest,
    steps: list[ApprovalRequestStep],
) -> bool:
    changed = False
    active_step_no = int(getattr(request, "current_step_no", 0) or 0)

    for step in steps:
        normalized_status = (step.status or "").strip().lower()
        if normalized_status != "pending":
            continue

        if active_step_no > 0 and step.step_no == active_step_no:
            target_assigned_at = step.assigned_at
            if target_assigned_at is None:
                if step.step_no == 1 and request.requested_at is not None:
                    target_assigned_at = request.requested_at
                else:
                    target_assigned_at = _utcnow()
            if step.assigned_at != target_assigned_at:
                step.assigned_at = target_assigned_at
                changed = True
            continue

        if step.assigned_at is not None:
            step.assigned_at = None
            changed = True

    return changed


def _activate_request_step(step: ApprovalRequestStep, *, when: Optional[datetime] = None) -> None:
    step.assigned_at = when or _utcnow()


def _advance_request_to_step(
    db: Session,
    request: ApprovalRequest,
    next_step: ApprovalRequestStep,
    *,
    progressed: bool = True,
) -> ApprovalRequest:
    request.current_step_no = next_step.step_no
    _activate_request_step(next_step)
    db.flush()
    _notify_current_approval_step(db, request, progressed=progressed)
    return request


def repair_request_steps_from_rule(db: Session, request: ApprovalRequest) -> list[ApprovalRequestStep]:
    steps = sorted(request.steps or [], key=lambda item: item.step_no)
    if not request.approval_rule_id:
        if _sync_request_step_assignments(request, steps):
            db.flush()
        return steps

    rule = request.rule
    if not rule:
        rule = db.query(ApprovalRule).filter(ApprovalRule.id == request.approval_rule_id).first()
    if not rule:
        return steps

    requester = request.requester
    if not requester:
        requester = db.query(User).filter(User.id == request.requested_by).first()
    if not requester:
        return steps

    approval_type = (getattr(rule, "approval_type", None) or "hierarchy").strip().lower()
    request_group_id = getattr(request, "group_id", None) or _resolve_request_group_id(
        db,
        requester=requester,
        module_key=request.module_key,
        record_id=request.record_id,
    )

    if is_top_level_auto_approval_requester(db, requester):
        changed = False
        for step in steps:
            if (step.status or "").strip().lower() == "pending":
                db.delete(step)
                changed = True

        if request.approver_user_ids != []:
            request.approver_user_ids = []
            changed = True
        if request.current_step_no != 0:
            request.current_step_no = 0
            changed = True
        if (request.status or "").strip().lower() != "approved":
            request.status = "approved"
            changed = True
        if request.final_decided_at is None:
            request.final_decided_at = _utcnow()
            changed = True

        if changed:
            db.flush()

        return sorted(
            db.query(ApprovalRequestStep)
            .filter(ApprovalRequestStep.approval_request_id == request.id)
            .all(),
            key=lambda item: item.step_no,
        )

    try:
        if approval_type == "hierarchy":
            # If the rule has explicit steps configured, use them (same as sequential).
            # This prevents repair from adding CEO when the rule only configured L2.
            hierarchy_rule_steps = (
                db.query(ApprovalRuleStep)
                .filter(ApprovalRuleStep.approval_rule_id == rule.id)
                .order_by(ApprovalRuleStep.step_no.asc())
                .all()
            ) if rule else []
            if hierarchy_rule_steps:
                expected_steps = resolve_rule_steps_for_request(
                    db,
                    requester,
                    hierarchy_rule_steps,
                    request_group_id=request_group_id,
                    allow_global_role_fallback=True,
                )
            else:
                expected_steps = filter_resolved_steps_for_request(
                    db,
                    requester,
                    resolve_hierarchy_approval_steps(
                        db,
                        requester,
                        request_group_id=request_group_id,
                    ),
                )
        else:
            rule_steps = (
                db.query(ApprovalRuleStep)
                .filter(ApprovalRuleStep.approval_rule_id == rule.id)
                .order_by(ApprovalRuleStep.step_no.asc())
                .all()
            )
            expected_steps = resolve_rule_steps_for_request(
                db,
                requester,
                rule_steps,
                request_group_id=request_group_id,
                allow_global_role_fallback=True,
            )
    except HTTPException:
        logger.warning("Unable to repair approval request steps for request %s", request.id, exc_info=True)
        return steps

    expected_by_step_no = {step.step_no: step for step in expected_steps}
    retained_step_nos: set[int] = set()
    changed = False

    for step in steps:
        expected_step = expected_by_step_no.get(step.step_no)
        normalized_status = (step.status or "").strip().lower()

        # Never delete or reassign the step that is currently awaiting action —
        # the approver has already been notified and may be mid-decision.
        is_active_pending = (
            normalized_status == "pending"
            and step.step_no == request.current_step_no
        )

        if expected_step is None:
            if normalized_status == "pending":
                # Never delete a pending step — renumbering mismatches (caused by
                # skipped role steps resolving to a different step_no than stored)
                # would otherwise remove valid future approver slots, causing the
                # request to be incorrectly marked approved with fewer approvals.
                retained_step_nos.add(step.step_no)
            continue

        retained_step_nos.add(step.step_no)

        if normalized_status != "pending":
            continue

        # Don't reassign the active pending step's approver mid-flight.
        if is_active_pending:
            continue

        if step.approver_user_id != expected_step.approver_user.id:
            step.approver_user_id = expected_step.approver_user.id
            changed = True
        if (step.approver_role or None) != (expected_step.approver_role or None):
            step.approver_role = expected_step.approver_role
            changed = True
        if (step.resolved_from or None) != (expected_step.resolved_from or None):
            step.resolved_from = expected_step.resolved_from
            changed = True

    for expected_step in expected_steps:
        if expected_step.step_no in retained_step_nos:
            continue
        db.add(
            ApprovalRequestStep(
                approval_request_id=request.id,
                step_no=expected_step.step_no,
                approver_user_id=expected_step.approver_user.id,
                approver_role=expected_step.approver_role,
                status="pending",
                resolved_from=expected_step.resolved_from,
            )
        )
        changed = True

    db.flush()
    refreshed_steps = sorted(
        db.query(ApprovalRequestStep)
        .filter(ApprovalRequestStep.approval_request_id == request.id)
        .all(),
        key=lambda item: item.step_no,
    )

    pending_steps = [
        step
        for step in refreshed_steps
        if (step.status or "").strip().lower() == "pending"
    ]
    rejected_steps = [
        step
        for step in refreshed_steps
        if (step.status or "").strip().lower() == "rejected"
    ]
    approver_user_ids = [
        step.approver_user_id
        for step in refreshed_steps
        if step.approver_user_id is not None
    ]

    if request.approver_user_ids != approver_user_ids:
        request.approver_user_ids = approver_user_ids
        changed = True

    if pending_steps:
        next_step_no = pending_steps[0].step_no
        if request.current_step_no != next_step_no:
            request.current_step_no = next_step_no
            changed = True
        if (request.status or "").strip().lower() != "pending":
            request.status = "pending"
            changed = True
        if request.final_decided_at is not None:
            request.final_decided_at = None
            changed = True
    else:
        final_status = "rejected" if rejected_steps else "approved"
        if request.current_step_no != 0:
            request.current_step_no = 0
            changed = True
        if (request.status or "").strip().lower() != final_status:
            request.status = final_status
            changed = True
        if request.final_decided_at is None:
            request.final_decided_at = _utcnow()
            changed = True

    if changed:
        db.flush()

    if _sync_request_step_assignments(request, refreshed_steps):
        db.flush()

    return refreshed_steps


def find_pending_request_for_record(
    db: Session,
    *,
    module_key: str,
    action_key: str,
    record_id: int,
) -> Optional[ApprovalRequest]:
    return (
        db.query(ApprovalRequest)
        .filter(
            ApprovalRequest.module_key == module_key,
            ApprovalRequest.action_key == action_key,
            ApprovalRequest.record_id == record_id,
            ApprovalRequest.status == "pending",
        )
        .order_by(ApprovalRequest.requested_at.desc(), ApprovalRequest.id.desc())
        .first()
    )


def find_latest_request_for_record(
    db: Session,
    *,
    module_key: str,
    action_key: str,
    record_id: int,
) -> Optional[ApprovalRequest]:
    pending_request = find_pending_request_for_record(
        db,
        module_key=module_key,
        action_key=action_key,
        record_id=record_id,
    )
    if pending_request:
        repair_request_steps_from_rule(db, pending_request)
        db.flush()
        db.expire(pending_request)
        return pending_request

    return (
        db.query(ApprovalRequest)
        .filter(
            ApprovalRequest.module_key == module_key,
            ApprovalRequest.action_key == action_key,
            ApprovalRequest.record_id == record_id,
        )
        .order_by(ApprovalRequest.requested_at.desc(), ApprovalRequest.id.desc())
        .first()
    )


def _build_request_record_ref(db: Session, request: ApprovalRequest) -> str:
    if request.module_key == "customer":
        customer = db.query(Customer).filter(Customer.id == request.record_id).first()
        if customer:
            return f"Customer: {customer.customer_name}"
        return f"Customer #{request.record_id}"
    if request.module_key == "lead":
        lead = db.query(Lead).filter(Lead.id == request.record_id).first()
        if lead:
            return f"Lead: {lead.lead_title}"
        return f"Lead #{request.record_id}"
    if request.module_key == "tender":
        tender = db.query(Tender).filter(Tender.id == request.record_id).first()
        if tender:
            return f"Tender: {tender.tender_title or tender.portal_ref_number or tender.tender_num}"
        return f"Tender #{request.record_id}"
    if request.module_key == "emdbg":
        from app.services.instrument_service import record_label as instrument_record_label
        label = instrument_record_label(db, request)
        if label:
            return label
        record = db.query(EMDBG).filter(EMDBG.id == request.record_id).first()
        if record:
            return f"EMDBG: {record.reference_num}"
        return f"EMDBG #{request.record_id}"
    if request.module_key == "travel":
        travel_request = db.query(TravelRequest).filter(TravelRequest.id == request.record_id).first()
        if travel_request:
            return f"Travel: {travel_request.request_number}"
        return f"Travel #{request.record_id}"
    if request.module_key == "quotation":
        from app.models.all_models import Quotation
        q = db.query(Quotation).filter(Quotation.id == request.record_id).first()
        if q:
            return f"Quotation: {q.quotation_number}"
        return f"Quotation #{request.record_id}"
    if request.module_key == "price_book":
        from app.models.products import PriceBook, PriceBookItem
        if request.action_key == "override":
            it = db.query(PriceBookItem).filter(PriceBookItem.id == request.record_id).first()
            b = db.query(PriceBook).filter(PriceBook.id == it.price_book_id).first() if it else None
            name = db.execute(text("SELECT name FROM products_master WHERE id = :i"), {"i": it.product_id}).scalar() if it else None
            return f"Price book: {b.name if b else '—'} · {name or 'product'} override" if it else f"Price override #{request.record_id}"
        b = db.query(PriceBook).filter(PriceBook.id == request.record_id).first()
        return f"Price book: {b.name}" if b else f"Price book #{request.record_id}"
    if request.module_key == "product":
        from app.services.product_model_service import record_label as product_record_label
        return product_record_label(db, request)
    if request.module_key == "deal":
        lead = db.query(Lead).filter(Lead.id == request.record_id).first()
        if lead:
            return f"Deal: {lead.opportunity_ref_id or lead.lead_ref_id} – {lead.lead_title}"
        return f"Deal #{request.record_id}"
    if request.module_key == "work_order":
        from app.models.all_models import WorkOrder
        wo = db.query(WorkOrder).filter(WorkOrder.id == request.record_id).first()
        if wo:
            return f"Work order: {wo.wo_number} – {wo.project_title or wo.customer_name or ''}"
        return f"Work order #{request.record_id}"
    if request.module_key == "forecast":
        from app.models.forecasts import ForecastSubmission
        sub = db.query(ForecastSubmission).filter(ForecastSubmission.id == request.record_id).first()
        if sub:
            return f"Forecast: {sub.period_label} v{sub.version} – {sub.submitted_by_name or 'rep'}"
        return f"Forecast #{request.record_id}"
    return f"{get_module_label(request.module_key)} #{request.record_id}"


def _format_request_value(value: Any) -> Optional[str]:
    if value is None or value == "":
        return None
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return None
    return f"\u20b9{amount:,.0f}"


def _build_request_notes(db: Session, request: ApprovalRequest) -> Optional[str]:
    if request.module_key == "lead" and request.action_key == "convert":
        lead = db.query(Lead).filter(Lead.id == request.record_id).first()
        if not lead:
            return None
        title = lead.lead_title or f"Lead #{lead.id}"
        lead_ref = lead.lead_ref_id or str(lead.id)
        opportunity_ref = lead.opportunity_ref_id or "-"
        value_text = _format_request_value(lead.est_value)
        value_part = f", Value: {value_text}" if value_text else ""
        return (
            f"Requesting conversion of '{title}' "
            f"(Lead: {lead_ref}, Opp: {opportunity_ref}{value_part}) to tender."
        )
    return None


def _notify_current_approval_step(
    db: Session,
    request: ApprovalRequest,
    *,
    progressed: bool = False,
) -> None:
    """Notify the currently active approver; upsert_notification also sends FCM."""
    if not request or (request.status or "").strip().lower() != "pending":
        return

    module_key = normalize_role_key(getattr(request, "module_key", None)) or ""
    if module_key in DEDICATED_APPROVAL_PUSH_MODULES:
        return

    current_step_no = int(getattr(request, "current_step_no", 0) or 0)
    if current_step_no <= 0:
        return

    active_step = (
        db.query(ApprovalRequestStep)
        .filter(
            ApprovalRequestStep.approval_request_id == request.id,
            ApprovalRequestStep.step_no == current_step_no,
            ApprovalRequestStep.status == "pending",
        )
        .first()
    )
    if not active_step or not active_step.approver_user_id:
        return

    approver = active_step.approver or db.query(User).filter(User.id == active_step.approver_user_id).first()
    if not approver or not getattr(approver, "is_active", True):
        return

    requester = request.requester or db.query(User).filter(User.id == request.requested_by).first()
    requester_name = getattr(requester, "full_name", None) or getattr(requester, "username", None) or "An employee"
    record_ref = _build_request_record_ref(db, request)
    module_label = get_module_label(request.module_key)
    action_label = get_action_label(request.module_key, request.action_key)

    title = (
        f"Approval Moved: {record_ref}"
        if progressed
        else f"Approval Required: {record_ref}"
    )
    message = (
        f"{requester_name}'s {module_label} {action_label} request moved to your approval step."
        if progressed
        else f"{requester_name} submitted a {module_label} {action_label} request for your approval."
    )
    notes = _build_request_notes(db, request)
    if notes:
        message = f"{message} {notes}"

    try:
        upsert_notification(
            db,
            user_id=approver.id,
            title=title,
            message=message,
            module=request.module_key,
            record_id=request.record_id,
            action="approval_request",
            category="approval",
            send_email=True,
        )
    except Exception as exc:
        logger.warning(
            "Approval approver notification failed: request=%s approver=%s error=%s",
            getattr(request, "id", None),
            getattr(approver, "id", None),
            exc,
        )


def _timeline_stamp(value: Any) -> Optional[str]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _timeline_user_name(user_map: dict[int, User], user_id: Optional[int]) -> str:
    if not user_id:
        return ""
    user = user_map.get(int(user_id))
    return user.full_name if user else ""


def _append_timeline_approval_detail(
    bucket: dict[str, list[dict[str, Any]]],
    item_id: Optional[str],
    *,
    detail_id: str,
    step_no: int,
    approver_user_id: Optional[int],
    approver_name: str,
    approver_role: Optional[str],
    status: Optional[str],
    remarks: Optional[str],
    assigned_at: Any = None,
    acted_at: Any = None,
    escalated_at: Any = None,
    resolved_from: Optional[str] = None,
) -> None:
    if not item_id:
        return
    bucket.setdefault(item_id, []).append({
        "id": detail_id,
        "step_no": int(step_no or 1),
        "approver_user_id": approver_user_id,
        "approver_name": approver_name or None,
        "approver_role": approver_role,
        "status": (status or "pending").strip().lower(),
        "remarks": remarks,
        "assigned_at": _timeline_stamp(assigned_at),
        "acted_at": _timeline_stamp(acted_at),
        "escalated_at": _timeline_stamp(escalated_at),
        "escalation_count": 0,
        "resolved_from": resolved_from,
    })


def _sort_timeline_approval_details(
    bucket: dict[str, list[dict[str, Any]]],
) -> dict[str, list[dict[str, Any]]]:
    def sort_key(detail: dict[str, Any]) -> tuple[str, int, str]:
        stamp = detail.get("assigned_at") or detail.get("acted_at") or detail.get("escalated_at") or ""
        return (str(stamp), int(detail.get("step_no") or 0), str(detail.get("id") or ""))

    return {
        item_id: sorted(details, key=sort_key)
        for item_id, details in bucket.items()
    }


def _collect_legacy_timeline_approval_details(
    db: Session,
    bucket: dict[str, list[dict[str, Any]]],
    *,
    module: str,
    record_id: Optional[int],
    action_to_item: dict[str, str],
) -> None:
    if not record_id or not action_to_item:
        return

    action_order = {action: index + 1 for index, action in enumerate(action_to_item)}
    approvals = (
        db.query(Approval)
        .filter(
            Approval.module == module,
            Approval.record_id == record_id,
            Approval.action.in_(list(action_to_item.keys())),
        )
        .order_by(Approval.created_at.asc(), Approval.id.asc())
        .all()
    )
    if not approvals:
        return

    user_ids = {
        int(approval.requested_to)
        for approval in approvals
        if approval.requested_to
    }
    users = {
        int(user.id): user
        for user in db.query(User).filter(User.id.in_(user_ids)).all()
    } if user_ids else {}

    for approval in approvals:
        approver = users.get(int(approval.requested_to)) if approval.requested_to else None
        _append_timeline_approval_detail(
            bucket,
            action_to_item.get(approval.action),
            detail_id=f"legacy-{approval.id}",
            step_no=action_order.get(approval.action, 1),
            approver_user_id=approval.requested_to,
            approver_name=approver.full_name if approver else "",
            approver_role=approver.role if approver else None,
            status=approval.status,
            remarks=approval.decision_notes or approval.rejection_reason,
            assigned_at=approval.created_at,
            acted_at=approval.decided_at,
            resolved_from="legacy_approval",
        )


def _collect_dynamic_timeline_approval_details(
    db: Session,
    bucket: dict[str, list[dict[str, Any]]],
    *,
    module_key: str,
    record_id: Optional[int],
    action_to_item: dict[str, str],
) -> None:
    if not record_id or not action_to_item:
        return

    requests = (
        db.query(ApprovalRequest)
        .filter(
            ApprovalRequest.module_key == module_key,
            ApprovalRequest.record_id == record_id,
            ApprovalRequest.action_key.in_(list(action_to_item.keys())),
        )
        .order_by(ApprovalRequest.requested_at.asc(), ApprovalRequest.id.asc())
        .all()
    )
    if not requests:
        return

    for request in requests:
        item_id = action_to_item.get(request.action_key or "")
        for step in sorted(request.steps or [], key=lambda item: item.step_no):
            approver = step.approver
            _append_timeline_approval_detail(
                bucket,
                item_id,
                detail_id=f"dynamic-{request.id}-{step.id}",
                step_no=step.step_no,
                approver_user_id=step.approver_user_id,
                approver_name=approver.full_name if approver else "",
                approver_role=step.approver_role,
                status=step.status,
                remarks=step.remarks,
                assigned_at=step.assigned_at or request.requested_at,
                acted_at=step.acted_at,
                escalated_at=step.escalated_at,
                resolved_from=step.resolved_from or "dynamic_approval",
            )


def _build_lead_timeline_approval_details(
    db: Session,
    lead: Optional[Lead],
) -> dict[str, list[dict[str, Any]]]:
    if not lead:
        return {}
    bucket: dict[str, list[dict[str, Any]]] = {}
    _collect_legacy_timeline_approval_details(
        db,
        bucket,
        module="lead",
        record_id=lead.id,
        action_to_item=LEAD_TIMELINE_LEGACY_APPROVAL_ACTION_ITEMS,
    )
    _collect_dynamic_timeline_approval_details(
        db,
        bucket,
        module_key="lead",
        record_id=lead.id,
        action_to_item=LEAD_TIMELINE_DYNAMIC_APPROVAL_ACTION_ITEMS,
    )
    return _sort_timeline_approval_details(bucket)


def _build_tender_timeline_approval_details(
    db: Session,
    tender: Tender,
    lead: Optional[Lead] = None,
) -> dict[str, list[dict[str, Any]]]:
    bucket: dict[str, list[dict[str, Any]]] = {}
    _collect_legacy_timeline_approval_details(
        db,
        bucket,
        module="tender",
        record_id=tender.id,
        action_to_item=TENDER_TIMELINE_LEGACY_APPROVAL_ACTION_ITEMS,
    )
    _collect_dynamic_timeline_approval_details(
        db,
        bucket,
        module_key="tender",
        record_id=tender.id,
        action_to_item=TENDER_TIMELINE_DYNAMIC_APPROVAL_ACTION_ITEMS,
    )
    if lead:
        lead_details = _build_lead_timeline_approval_details(db, lead)
        for item_id, details in lead_details.items():
            bucket.setdefault(item_id, []).extend(details)
    return _sort_timeline_approval_details(bucket)


def _timeline_amount(value: Any) -> str:
    if value in (None, ""):
        return ""
    try:
        return f"INR {float(value):,.2f}"
    except (TypeError, ValueError):
        return str(value)


def _read_tender_timeline_extra_fields(db: Session, tender_id: int) -> dict[str, Any]:
    try:
        column_names = {
            column["name"]
            for column in inspect(db.get_bind()).get_columns("tenders")
        }
    except Exception:
        return {}

    selected = [
        column
        for column in TENDER_TIMELINE_EXTRA_DATE_COLUMNS
        if column in column_names
    ]
    if not selected:
        return {}

    quoted_columns = ", ".join(f"`{column}`" for column in selected)
    try:
        row = db.execute(
            text(f"SELECT {quoted_columns} FROM tenders WHERE id = :tender_id"),
            {"tender_id": tender_id},
        ).mappings().first()
    except Exception:
        return {}
    return dict(row) if row else {}


def _build_step2_timeline_details(db: Session, tender: Tender) -> list[dict[str, Any]]:
    extra = _read_tender_timeline_extra_fields(db, int(tender.id))
    linked_ids = {
        int(record_id)
        for record_id in [
            getattr(tender, "tender_fee_emdbg_id", None),
            getattr(tender, "emd_emdbg_id", None),
            getattr(tender, "pbg_emdbg_id", None),
        ]
        if record_id
    }
    records_by_id: dict[int, EMDBG] = {}
    if linked_ids:
        records_by_id = {
            int(record.id): record
            for record in db.query(EMDBG).filter(EMDBG.id.in_(linked_ids)).all()
        }

    records_by_type = (
        db.query(EMDBG)
        .filter(
            EMDBG.tender_id == tender.id,
            EMDBG.instrument_type.in_([
                "DD",
                "Online Payment",
                "EMD",
                "Performance BG",
                "Security Deposit",
                "Advance BG",
                "Retention BG",
            ]),
        )
        .order_by(EMDBG.created_at.asc(), EMDBG.id.asc())
        .all()
    )

    def pick_record(link_attr: str, type_names: set[str]) -> Optional[EMDBG]:
        linked_id = getattr(tender, link_attr, None)
        if linked_id and int(linked_id) in records_by_id:
            return records_by_id[int(linked_id)]
        return next(
            (
                record
                for record in records_by_type
                if (record.instrument_type or "") in type_names
            ),
            None,
        )

    def add_detail(
        parts: list[str],
        label: str,
        value: Any,
    ) -> None:
        if value not in (None, ""):
            parts.append(f"{label}: {value}")

    def detail_item(
        *,
        title: str,
        required: bool,
        record: Optional[EMDBG],
        amount: Any = None,
        method: str = "",
        bank_name: str = "",
        bank_branch: str = "",
        instrument_number: str = "",
        submitted_at: Any = None,
        issued_at: Any = None,
        valid_from: Any = None,
        expiry_at: Any = None,
        missing_field: str,
    ) -> dict[str, Any]:
        record_amount = getattr(record, "amount", None) if record else None
        record_bank = getattr(record, "bank_name", None) if record else None
        record_branch = getattr(record, "bank_branch", None) if record else None
        record_number = getattr(record, "instrument_number", None) if record else None
        record_type = getattr(record, "instrument_type", None) if record else None
        record_status = getattr(record, "status", None) if record else None
        record_submitted_at = (
            getattr(record, "submitted_date", None) if record else None
        ) or submitted_at
        record_created_at = getattr(record, "created_at", None) if record else None
        occurred_at = record_submitted_at or (
            getattr(record, "issued_date", None) if record else None
        ) or issued_at or (
            record_created_at
        )

        parts: list[str] = []
        amount_label = _timeline_amount(record_amount if record_amount is not None else amount)
        add_detail(parts, "Amount", amount_label)
        add_detail(parts, "Method", method or record_type or "")
        add_detail(parts, "Bank", record_bank or bank_name or "")
        add_detail(parts, "Branch", record_branch or bank_branch or "")
        add_detail(parts, "Instrument No.", record_number or instrument_number or "")
        add_detail(parts, "Valid From", getattr(record, "valid_from", None) if record else valid_from)
        add_detail(parts, "Expiry", getattr(record, "expiry_date", None) if record else expiry_at)
        add_detail(parts, "Status", record_status or "")

        if not required and not record:
            return {
                "title": title,
                "occurred_at": None,
                "submitted_at": None,
                "recorded_at": None,
                "detail": "Not required",
                "status": "not_required",
                "status_label": "Not Required",
                "missing_field": None,
            }

        has_data = bool(record or parts or occurred_at)
        return {
            "title": title,
            "occurred_at": _timeline_stamp(occurred_at),
            "submitted_at": _timeline_stamp(record_submitted_at),
            "recorded_at": _timeline_stamp(record_created_at),
            "detail": " | ".join(str(part) for part in parts) if parts else "No stored data found",
            "status": "completed" if has_data else "missing",
            "status_label": "Available" if has_data else "Missing",
            "missing_field": None if record_submitted_at else missing_field,
        }

    tender_fee_record = pick_record("tender_fee_emdbg_id", {"DD", "Online Payment"})
    emd_record = pick_record("emd_emdbg_id", {"EMD"})
    pbg_record = pick_record(
        "pbg_emdbg_id",
        {"Performance BG", "Security Deposit", "Advance BG", "Retention BG"},
    )

    return [
        detail_item(
            title="Tender Fee",
            required=bool(getattr(tender, "tender_fee_required", False)),
            record=tender_fee_record,
            amount=getattr(tender, "tender_fee_amount", None),
            method=getattr(tender, "tender_fee_method", "") or "",
            bank_name=getattr(tender, "tender_fee_bank_name", "") or "",
            bank_branch=getattr(tender, "tender_fee_bank_branch", "") or "",
            instrument_number=getattr(tender, "tender_fee_instrument_number", "") or "",
            submitted_at=extra.get("tender_fee_submitted_date"),
            issued_at=extra.get("tender_fee_issued_date"),
            valid_from=extra.get("tender_fee_valid_from"),
            expiry_at=extra.get("tender_fee_expiry_date"),
            missing_field="emdbg.submitted_date / tenders.tender_fee_submitted_date",
        ),
        detail_item(
            title="EMD",
            required=bool(getattr(tender, "emd_required", False)),
            record=emd_record,
            amount=getattr(tender, "emd_amount", None),
            method=getattr(tender, "emd_payment_method", "") or "",
            bank_name=getattr(tender, "emd_bank_name", "") or "",
            bank_branch=getattr(tender, "emd_bank_branch", "") or "",
            instrument_number=getattr(tender, "emd_instrument_number", "") or "",
            submitted_at=extra.get("emd_submitted_date"),
            issued_at=extra.get("emd_issued_date"),
            valid_from=extra.get("emd_valid_from"),
            expiry_at=extra.get("emd_expiry_date"),
            missing_field="emdbg.submitted_date / tenders.emd_submitted_date",
        ),
        detail_item(
            title="BG / Bank Guarantee",
            required=bool(getattr(tender, "pbg_required", False)),
            record=pbg_record,
            amount=getattr(tender, "pbg_amount", None),
            method=getattr(tender, "pbg_payment_method", "") or "Performance BG",
            bank_name=getattr(tender, "pbg_bank_name", "") or "",
            bank_branch=getattr(tender, "pbg_bank_branch", "") or "",
            instrument_number=getattr(tender, "pbg_instrument_number", "") or "",
            submitted_at=extra.get("pbg_submitted_date"),
            issued_at=extra.get("pbg_issued_date"),
            valid_from=extra.get("pbg_valid_from"),
            expiry_at=extra.get("pbg_expiry_date"),
            missing_field="emdbg.submitted_date / tenders.pbg_submitted_date",
        ),
    ]


def build_tender_lifecycle_timeline(db: Session, tender: Tender) -> list[dict[str, Any]]:
    """Build Lead -> Tender -> processing timeline rows from existing stored data."""
    if not tender:
        return []

    lead = None
    if getattr(tender, "lead_id", None):
        lead = db.query(Lead).filter(Lead.id == tender.lead_id).first()
    if not lead:
        lead = (
            db.query(Lead)
            .filter(Lead.converted_tender_id == tender.id)
            .order_by(Lead.converted_at.desc(), Lead.id.desc())
            .first()
        )

    tender_logs = (
        db.query(ActivityLog)
        .filter(
            ActivityLog.module == "tenders",
            ActivityLog.record_id == tender.id,
        )
        .order_by(ActivityLog.created_at.asc(), ActivityLog.id.asc())
        .all()
    )
    tender_created_log = next((log for log in tender_logs if log.action == "created"), None)

    lead_conversion_log = None
    lead_created_log = None
    opportunity_log = None
    if lead:
        lead_logs = (
            db.query(ActivityLog)
            .filter(
                ActivityLog.module == "leads",
                ActivityLog.record_id == lead.id,
                ActivityLog.action.in_(["create", "convert", "status_change", "status_changed"]),
            )
            .order_by(ActivityLog.created_at.asc(), ActivityLog.id.asc())
            .all()
        )
        lead_created_log = next((log for log in lead_logs if log.action == "create"), None)
        lead_conversion_log = next((log for log in reversed(lead_logs) if log.action == "convert"), None)
        opportunity_log = next(
            (
                log
                for log in lead_logs
                if log.action in ("status_change", "status_changed")
                and "Opportunity Created" in (log.description or "")
            ),
            None,
        )

    user_ids = {
        int(user_id)
        for user_id in [
            getattr(lead, "created_by", None) if lead else None,
            getattr(tender, "created_by", None),
            getattr(lead_created_log, "user_id", None),
            getattr(opportunity_log, "user_id", None),
            getattr(lead_conversion_log, "user_id", None),
            getattr(tender_created_log, "user_id", None),
            *[getattr(log, "user_id", None) for log in tender_logs],
        ]
        if user_id
    }
    user_map = {
        int(user.id): user
        for user in db.query(User).filter(User.id.in_(user_ids)).all()
    } if user_ids else {}
    approval_details_by_item = _build_tender_timeline_approval_details(db, tender, lead)

    tender_label = (
        tender.tender_num
        or tender.tender_title
        or tender.portal_ref_number
        or f"Tender #{tender.id}"
    )
    if tender.tender_num and tender.tender_title:
        tender_label = f"{tender.tender_num} - {tender.tender_title}"

    def event(
        *,
        event_id: str,
        sequence: int,
        title: str,
        occurred_at: Any = None,
        detail: str = "",
        user_id: Optional[int] = None,
        status: str = "completed",
        status_label: str = "Completed",
        missing_field: Optional[str] = None,
    ) -> dict[str, Any]:
        payload = {
            "id": event_id,
            "sequence": sequence,
            "title": title,
            "occurred_at": _timeline_stamp(occurred_at),
            "detail": detail,
            "user_name": _timeline_user_name(user_map, user_id),
            "status": status,
            "status_label": status_label,
            "missing_field": missing_field,
        }
        approval_details = approval_details_by_item.get(event_id)
        if approval_details:
            payload["approval_details"] = approval_details
        return payload

    def missing_event(
        *,
        event_id: str,
        sequence: int,
        title: str,
        detail: str,
        missing_field: str,
        user_id: Optional[int] = None,
    ) -> dict[str, Any]:
        return event(
            event_id=event_id,
            sequence=sequence,
            title=title,
            detail=detail,
            user_id=user_id,
            status="missing",
            status_label="Missing",
            missing_field=missing_field,
        )

    items: list[dict[str, Any]] = []
    opportunity_event_added = False

    if lead:
        lead_posted_at = getattr(lead, "lead_created_at", None) or getattr(lead, "created_at", None)
        lead_creator_id = getattr(lead_created_log, "user_id", None) or getattr(lead, "created_by", None)
        is_direct_opportunity = getattr(lead, "lead_type", None) == "direct_opportunity"
        opportunity_at = (
            getattr(lead, "opportunity_created_at", None)
            or getattr(opportunity_log, "created_at", None)
            or (lead_posted_at if is_direct_opportunity else None)
        )

        if is_direct_opportunity and opportunity_at:
            opportunity_event_added = True
            items.append(event(
                event_id="opportunity-created",
                sequence=10,
                title="Opportunity Created",
                occurred_at=opportunity_at,
                detail="Direct opportunity created",
                user_id=lead_creator_id,
            ))
        elif is_direct_opportunity:
            opportunity_event_added = True
            items.append(missing_event(
                event_id="opportunity-created",
                sequence=10,
                title="Opportunity Created",
                detail="Direct opportunity timestamp is not stored.",
                missing_field="leads.opportunity_created_at / leads.lead_created_at / leads.created_at",
                user_id=lead_creator_id,
            ))
        elif lead_posted_at:
            items.append(event(
                event_id="lead-posted",
                sequence=10,
                title="Lead Posted",
                occurred_at=lead_posted_at,
                detail="Completed",
                user_id=lead_creator_id,
            ))
        else:
            items.append(missing_event(
                event_id="lead-posted",
                sequence=10,
                title="Lead Posted",
                detail="Lead posted timestamp is not stored.",
                missing_field="leads.lead_created_at / leads.created_at",
                user_id=lead_creator_id,
            ))

        is_opportunity = (
            getattr(lead, "status", None) in ("Opportunity Created", "Converted")
            or bool(getattr(lead, "opportunity_ref_id", None))
        )
        if is_opportunity and not is_direct_opportunity:
            opportunity_event_added = True
            opportunity_user_id = (
                getattr(opportunity_log, "user_id", None)
                or getattr(lead_created_log, "user_id", None)
                or getattr(lead, "created_by", None)
            )
            if opportunity_at:
                items.append(event(
                    event_id="opportunity-created",
                    sequence=15,
                    title="Opportunity Created",
                    occurred_at=opportunity_at,
                    detail=(
                        "Direct opportunity created"
                        if getattr(lead, "lead_type", None) == "direct_opportunity"
                        else "Moved to Opportunity Created"
                    ),
                    user_id=opportunity_user_id,
                ))
            else:
                items.append(missing_event(
                    event_id="opportunity-created",
                    sequence=15,
                    title="Opportunity Created",
                    detail="Opportunity created timestamp is not stored.",
                    missing_field="leads.opportunity_created_at",
                    user_id=opportunity_user_id,
                ))

        conversion_user_id = (
            getattr(lead_conversion_log, "user_id", None)
            or getattr(tender_created_log, "user_id", None)
            or getattr(tender, "created_by", None)
        )
        if getattr(lead, "converted_at", None):
            items.append(event(
                event_id="lead-converted",
                sequence=20,
                title="Opportunity Converted" if opportunity_event_added else "Lead Converted",
                occurred_at=lead.converted_at,
                detail=f"Converted to {tender_label}",
                user_id=conversion_user_id,
            ))
        else:
            items.append(missing_event(
                event_id="lead-converted",
                sequence=20,
                title="Opportunity Converted" if opportunity_event_added else "Lead Converted",
                detail=f"Linked tender: {tender_label}. Lead converted timestamp is not stored.",
                missing_field="leads.converted_at",
                user_id=conversion_user_id,
            ))
    # No linked lead found — this is a directly created tender, not converted
    # from a lead, so there's no Lead Posted / Lead Converted stage to show.

    tender_creator_id = getattr(tender_created_log, "user_id", None) or getattr(tender, "created_by", None)
    if getattr(tender, "created_at", None):
        items.append(event(
            event_id="tender-posted",
            sequence=30,
            title="Tender Posted",
            occurred_at=tender.created_at,
            detail="Completed",
            user_id=tender_creator_id,
        ))
    else:
        items.append(missing_event(
            event_id="tender-posted",
            sequence=30,
            title="Tender Posted",
            detail="Tender posted timestamp is not stored.",
            missing_field="tenders.created_at",
            user_id=tender_creator_id,
        ))

    logs_by_step: dict[int, ActivityLog] = {}
    for log in tender_logs:
        step_no = TENDER_TIMELINE_ACTION_STEPS.get(log.action)
        if not step_no:
            continue
        logs_by_step[step_no] = log

    reached_steps = [int(getattr(tender, "current_step", None) or 1)]
    reached_steps.extend(logs_by_step.keys())
    max_step = min(7, max(reached_steps))

    for step_no in range(1, max_step + 1):
        step_label, step_name = TENDER_TIMELINE_STEP_META.get(step_no, (f"Step {step_no}", ""))
        log = logs_by_step.get(step_no)
        step2_details = _build_step2_timeline_details(db, tender) if step_no == 2 else None
        stored_step_at = {
            1: getattr(tender, "created_at", None),
            2: getattr(tender, "step2_approved_at", None),
            3: getattr(tender, "step3_approved_at", None),
        }.get(step_no)
        fallback_at = stored_step_at
        fallback_user_id = tender_creator_id if step_no == 1 else None
        occurred_at = getattr(log, "created_at", None) if log else fallback_at
        user_id = getattr(log, "user_id", None) if log else fallback_user_id
        detail = (
            TENDER_TIMELINE_ACTION_DETAILS.get(getattr(log, "action", ""), "")
            if log
            else {
                1: "Initial tender step reached at tender posting",
                2: "Tender Details approval completed",
                3: "Workings approval completed",
            }.get(step_no, "")
        )
        if not detail:
            detail = step_name

        if occurred_at:
            item = event(
                event_id=f"tender-step-{step_no}",
                sequence=40 + step_no,
                title=f"Tender Processed → {step_label}",
                occurred_at=occurred_at,
                detail=detail,
                user_id=user_id,
            )
            if step2_details:
                item["sub_items"] = step2_details
            items.append(item)
        else:
            item = missing_event(
                event_id=f"tender-step-{step_no}",
                sequence=40 + step_no,
                title=f"Tender Processed → {step_label}",
                detail=f"{step_name} transition timestamp is not stored.",
                missing_field="activity_logs.created_at",
                user_id=user_id,
            )
            if step2_details:
                item["sub_items"] = step2_details
            items.append(item)

    return sorted(items, key=lambda item: int(item.get("sequence") or 0))


def build_lead_tender_lifecycle_timeline(
    db: Session,
    lead: Lead,
    request_created_at: Any = None,
    request_user_id: Optional[int] = None,
) -> list[dict[str, Any]]:
    """Build the same lifecycle view for lead conversion approvals."""
    if not lead:
        return []

    tender = None
    if getattr(lead, "converted_tender_id", None):
        tender = db.query(Tender).filter(Tender.id == lead.converted_tender_id).first()
    if not tender:
        tender = (
            db.query(Tender)
            .filter(Tender.lead_id == lead.id)
            .order_by(Tender.created_at.desc(), Tender.id.desc())
            .first()
        )
    if tender:
        return build_tender_lifecycle_timeline(db, tender)

    lead_logs = (
        db.query(ActivityLog)
        .filter(
            ActivityLog.module == "leads",
            ActivityLog.record_id == lead.id,
            ActivityLog.action.in_(["create", "convert", "status_change", "status_changed"]),
        )
        .order_by(ActivityLog.created_at.asc(), ActivityLog.id.asc())
        .all()
    )
    lead_created_log = next((log for log in lead_logs if log.action == "create"), None)
    lead_conversion_log = next((log for log in reversed(lead_logs) if log.action == "convert"), None)
    opportunity_log = next(
        (
            log
            for log in lead_logs
            if log.action in ("status_change", "status_changed")
            and "Opportunity Created" in (log.description or "")
        ),
        None,
    )
    user_ids = {
        int(user_id)
        for user_id in [
            getattr(lead, "created_by", None),
            getattr(lead_created_log, "user_id", None),
            getattr(opportunity_log, "user_id", None),
            getattr(lead_conversion_log, "user_id", None),
            request_user_id,
        ]
        if user_id
    }
    user_map = {
        int(user.id): user
        for user in db.query(User).filter(User.id.in_(user_ids)).all()
    } if user_ids else {}
    approval_details_by_item = _build_lead_timeline_approval_details(db, lead)

    def event(
        *,
        event_id: str,
        sequence: int,
        title: str,
        occurred_at: Any = None,
        detail: str = "",
        user_id: Optional[int] = None,
        status: str = "completed",
        status_label: str = "Completed",
        missing_field: Optional[str] = None,
    ) -> dict[str, Any]:
        payload = {
            "id": event_id,
            "sequence": sequence,
            "title": title,
            "occurred_at": _timeline_stamp(occurred_at),
            "detail": detail,
            "user_name": _timeline_user_name(user_map, user_id),
            "status": status,
            "status_label": status_label,
            "missing_field": missing_field,
        }
        approval_details = approval_details_by_item.get(event_id)
        if approval_details:
            payload["approval_details"] = approval_details
        return payload

    items: list[dict[str, Any]] = []
    lead_posted_at = getattr(lead, "lead_created_at", None) or getattr(lead, "created_at", None)
    lead_creator_id = getattr(lead_created_log, "user_id", None) or getattr(lead, "created_by", None)
    conversion_target = (getattr(lead, "conversion_target", None) or "tender").strip().lower()
    is_direct_opportunity = getattr(lead, "lead_type", None) == "direct_opportunity"
    opportunity_at = (
        getattr(lead, "opportunity_created_at", None)
        or getattr(opportunity_log, "created_at", None)
        or (lead_posted_at if is_direct_opportunity else None)
    )
    is_opportunity = (
        getattr(lead, "status", None) in ("Opportunity Created", "Converted")
        or bool(getattr(lead, "opportunity_ref_id", None))
    )
    opportunity_event_added = False

    if is_direct_opportunity:
        opportunity_event_added = True
        items.append(event(
            event_id="opportunity-created",
            sequence=10,
            title="Opportunity Created",
            occurred_at=opportunity_at,
            detail="Direct opportunity created" if opportunity_at else "Direct opportunity timestamp is not stored.",
            user_id=lead_creator_id,
            status="completed" if opportunity_at else "missing",
            status_label="Completed" if opportunity_at else "Missing",
            missing_field=(
                None
                if opportunity_at
                else "leads.opportunity_created_at / leads.lead_created_at / leads.created_at"
            ),
        ))
    else:
        items.append(event(
            event_id="lead-posted",
            sequence=10,
            title="Lead Posted",
            occurred_at=lead_posted_at,
            detail="Completed" if lead_posted_at else "Lead posted timestamp is not stored.",
            user_id=lead_creator_id,
            status="completed" if lead_posted_at else "missing",
            status_label="Completed" if lead_posted_at else "Missing",
            missing_field=None if lead_posted_at else "leads.lead_created_at / leads.created_at",
        ))

    if is_opportunity and not is_direct_opportunity:
        opportunity_event_added = True
        opportunity_user_id = (
            getattr(opportunity_log, "user_id", None)
            or getattr(lead_created_log, "user_id", None)
            or getattr(lead, "created_by", None)
        )
        items.append(event(
            event_id="opportunity-created",
            sequence=15,
            title="Opportunity Created",
            occurred_at=opportunity_at,
            detail=(
                "Direct opportunity created"
                if getattr(lead, "lead_type", None) == "direct_opportunity"
                else "Moved to Opportunity Created"
            ) if opportunity_at else "Opportunity created timestamp is not stored.",
            user_id=opportunity_user_id,
            status="completed" if opportunity_at else "missing",
            status_label="Completed" if opportunity_at else "Missing",
            missing_field=None if opportunity_at else "leads.opportunity_created_at",
        ))

    conversion_user_id = (
        getattr(lead_conversion_log, "user_id", None)
        or request_user_id
        or getattr(lead, "created_by", None)
    )
    pending_requested_at = (
        getattr(lead, "conversion_requested_at", None)
        or request_created_at
        or getattr(lead_conversion_log, "created_at", None)
    )
    target_label = "Quotation" if conversion_target == "quotation" else "Tender"
    if getattr(lead, "converted_at", None):
        items.append(event(
            event_id="lead-converted",
            sequence=20,
            title="Opportunity Converted" if opportunity_event_added else "Lead Converted",
            occurred_at=lead.converted_at,
            detail=f"Converted to {target_label}",
            user_id=conversion_user_id,
        ))
    elif (getattr(lead, "approval_status", None) or "").strip().lower() == "pending":
        items.append(event(
            event_id="lead-converted",
            sequence=20,
            title=f"{target_label} Conversion Requested",
            occurred_at=pending_requested_at,
            detail=f"Approval pending to convert opportunity to {target_label}.",
            user_id=conversion_user_id,
            status="pending",
            status_label="Pending",
            missing_field=(
                None
                if pending_requested_at
                else "leads.conversion_requested_at / approval_requests.created_at"
            ),
        ))
    else:
        items.append(event(
            event_id="lead-converted",
            sequence=20,
            title="Opportunity Converted" if opportunity_event_added else "Lead Converted",
            detail="Lead converted timestamp is not stored.",
            user_id=conversion_user_id,
            status="missing",
            status_label="Missing",
            missing_field="leads.converted_at",
        ))

    should_expect_tender = (
        conversion_target != "quotation"
        and (
            bool(getattr(lead, "converted_at", None))
            or (getattr(lead, "status", None) == "Converted")
            or ((getattr(lead, "approval_status", None) or "").strip().lower() == "approved")
        )
    )
    if should_expect_tender:
        items.append(event(
            event_id="tender-posted",
            sequence=30,
            title="Tender Posted",
            detail="Converted tender is not stored for this lead.",
            status="missing",
            status_label="Missing",
            missing_field="leads.converted_tender_id / tenders.lead_id",
        ))

    return sorted(items, key=lambda item: int(item.get("sequence") or 0))


def _build_request_summary(db: Session, request: ApprovalRequest) -> Optional[dict[str, Any]]:
    if request.module_key == "customer":
        customer = db.query(Customer).filter(Customer.id == request.record_id).first()
        if not customer:
            return None
        assigned_user = db.query(User).filter(User.id == customer.assigned_to).first() if customer.assigned_to else None
        created_by_user = db.query(User).filter(User.id == customer.created_by).first() if customer.created_by else None

        contacts = db.query(CustomerContact).filter(
            CustomerContact.customer_id == customer.id,
            CustomerContact.is_active == True,
        ).order_by(CustomerContact.is_primary.desc()).all()

        billing_consignees = db.query(CustomerBillingConsignee).filter(
            CustomerBillingConsignee.customer_id == customer.id
        ).order_by(CustomerBillingConsignee.sort_order).all()

        shipping_consignees = db.query(CustomerShippingConsignee).filter(
            CustomerShippingConsignee.customer_id == customer.id
        ).order_by(CustomerShippingConsignee.sort_order).all()

        def _addr(address, area, city, state, pincode, country):
            parts = [p for p in [address, area, city, state, pincode, country] if p]
            return ', '.join(parts) if parts else None

        return {
            "type":              "customer",
            "customer_name":     customer.customer_name or '',
            "account_status":    customer.account_status or 'Prospect',
            "account_potential": customer.account_potential or '',
            "potential_value":   float(customer.potential_value) if customer.potential_value else None,
            "assigned_to_name":  assigned_user.full_name if assigned_user else '',
            "created_by_name":   created_by_user.full_name if created_by_user else '',
            "industry":          customer.industry or '',
            "customer_vertical": customer.customer_vertical or '',
            "division":          customer.division or '',
            "group_name":        customer.group_name or '',
            "website":           customer.website or '',
            "gst_number":        customer.gst_number or '',
            "pan_number":        customer.pan_number or '',
            "annual_revenue":    float(customer.annual_revenue) if customer.annual_revenue else None,
            "employee_count":    int(customer.employee_count) if customer.employee_count else None,
            "remarks":           customer.remarks or '',
            "billing_address":   _addr(customer.billing_address, customer.billing_area, customer.billing_city, customer.billing_state, customer.billing_pincode, customer.billing_country),
            "billing_city":      customer.billing_city or '',
            "billing_state":     customer.billing_state or '',
            "billing_pincode":   customer.billing_pincode or '',
            "billing_country":   customer.billing_country or '',
            "shipping_same_as_billing": bool(customer.shipping_same_as_billing),
            "shipping_address":  _addr(customer.shipping_address, customer.shipping_area, customer.shipping_city, customer.shipping_state, customer.shipping_pincode, customer.shipping_country),
            "contacts": [
                {
                    "contact_name":   ct.contact_name or '',
                    "designation":    ct.designation or '',
                    "department":     ct.department or '',
                    "mobile":         ct.mobile or '',
                    "office_phone":   ct.office_phone or '',
                    "office_email":   ct.office_email or '',
                    "personal_email": ct.personal_email or '',
                    "is_primary":     bool(ct.is_primary),
                }
                for ct in contacts
            ],
            "billing_consignees": [
                {
                    "name":    bc.name or '',
                    "address": ', '.join(filter(None, [bc.address, bc.area, bc.city, bc.state, bc.pincode, bc.country])),
                }
                for bc in billing_consignees
            ],
            "shipping_consignees": [
                {
                    "name":    sc.name or '',
                    "address": ', '.join(filter(None, [sc.address, sc.area, sc.city, sc.state, sc.pincode, sc.country])),
                }
                for sc in shipping_consignees
            ],
        }
    if request.module_key == "lead":
        lead = db.query(Lead).filter(Lead.id == request.record_id).first()
        if not lead:
            return None
        assigned_user = db.query(User).filter(User.id == lead.assigned_to).first() if lead.assigned_to else None
        creator = db.query(User).filter(User.id == lead.created_by).first() if lead.created_by else None
        products = db.query(LeadProduct).filter(LeadProduct.lead_id == lead.id).order_by(LeadProduct.sort_order.asc(), LeadProduct.id.asc()).all()
        _lp_ids = [p.id for p in products]
        _lp_oems_all = db.query(LeadProductOEM).filter(
            LeadProductOEM.lead_product_id.in_(_lp_ids)
        ).order_by(LeadProductOEM.id.asc()).all() if _lp_ids else []
        _lp_oems_by_product: dict[int, list] = {}
        for _lo in _lp_oems_all:
            _lp_oems_by_product.setdefault(_lo.lead_product_id, []).append(_lo)

        def _ser_lead_product(product: LeadProduct) -> dict[str, Any]:
            oems = _lp_oems_by_product.get(product.id, [])
            quantity = float(product.quantity or 0)
            unit_price = float(product.unit_price or 0)
            gst_percent = float(product.gst_percent or 0)
            total_price = quantity * unit_price
            if gst_percent:
                total_price += total_price * gst_percent / 100
            return {
                "id": product.id,
                "product_name": product.product_name,
                "name": product.product_name,
                "quantity": quantity,
                "unit_price": unit_price,
                "gst_percent": gst_percent,
                "total_price": total_price,
                "description": product.description,
                "notes": product.notes,
                "oem_name": next((oem.oem_name for oem in oems if oem.oem_name), ""),
                "oems": [
                    {
                        "oem_name": oem.oem_name or "",
                        "authorization_num": oem.authorization_num or "",
                        "is_preferred": bool(oem.is_preferred),
                    }
                    for oem in oems
                ],
            }

        estimated_value = float(lead.est_value) if lead.est_value else None
        return {
            "type": "lead",
            "lead_id": lead.id,
            "lead_ref_id": lead.lead_ref_id,
            "opportunity_ref_id": lead.opportunity_ref_id,
            "lead_title": lead.lead_title,
            "title": lead.lead_title,
            "customer_name": lead.customer_name,
            "company_name": lead.customer_name,
            "status": lead.status,
            "est_value": estimated_value,
            "estimated_value": estimated_value,
            "contact_person": lead.contact_person,
            "email": lead.email,
            "phone": lead.mobile,
            "priority": lead.priority,
            "region": lead.region,
            "source": str(lead.source_id or ""),
            "assigned_to_name": assigned_user.full_name if assigned_user else "",
            "created_by_name": creator.full_name if creator else "",
            "description": lead.product_description,
            "notes": lead.notes,
            "request_notes": _build_request_notes(db, request),
            "products": [_ser_lead_product(product) for product in products],
            "tender_timeline": build_lead_tender_lifecycle_timeline(
                db,
                lead,
                request_created_at=getattr(request, "created_at", None),
                request_user_id=getattr(request, "requested_by", None),
            ),
        }
    if request.module_key == "tender":
        t = db.query(Tender).filter(Tender.id == request.record_id).first()
        if not t:
            return None

        assigned_user = db.query(User).filter(User.id == t.assigned_to).first() if t.assigned_to else None

        products = db.query(TenderProduct).filter(
            TenderProduct.tender_id == t.id,
            TenderProduct.is_final_boq == False,
        ).all()
        _tp_ids = [p.id for p in products]
        _tp_oems_all = db.query(TenderProductOEM).filter(
            TenderProductOEM.tender_product_id.in_(_tp_ids)
        ).all() if _tp_ids else []
        _tp_oems_by_product: dict[int, list] = {}
        for _to in _tp_oems_all:
            _tp_oems_by_product.setdefault(_to.tender_product_id, []).append(_to)

        def _ser_product(p: TenderProduct) -> dict:
            oems = _tp_oems_by_product.get(p.id, [])
            return {
                'product_name': p.product_name,
                'quantity': float(p.quantity or 0),
                'unit_price': float(p.unit_price or 0),
                'gst_percent': float(p.gst_percent or 0),
                'is_works_item': bool(p.is_works_item),
                'work_type': p.work_type or '',
                'work_unit': p.work_unit or '',
                'work_unit_rate': float(p.work_unit_rate or 0),
                'oems': [
                    {
                        'oem_name': o.oem_name or '',
                        'authorization_num': o.authorization_num or '',
                        'is_preferred': bool(o.is_preferred),
                    } for o in oems
                ],
            }

        docs = db.query(TenderDocument).filter(TenderDocument.tender_id == t.id).all()
        documents = [
            {
                'id': d.id,
                'doc_type': d.doc_type,
                'file_name': d.file_name or '',
                'file_path': d.file_url,
                'preview_url': d.file_url,
                'file_url': d.file_url,
                'file_size_kb': d.file_size_kb if hasattr(d, 'file_size_kb') else None,
                'uploaded_at': str(d.created_at) if d.created_at else None,
            }
            for d in docs
        ]

        step1 = {
            'customer_name': t.customer_name or '',
            'tender_title': t.tender_title or '',
            'portal_ref_number': t.portal_ref_number or '',
            'est_value': float(t.est_value) if t.est_value else None,
            'source_portal': t.source_portal or '',
            'tender_status': t.tender_status or '',
            'published_date': str(t.published_date) if t.published_date else None,
            'pre_bid_date': str(t.pre_bid_date) if t.pre_bid_date else None,
            'submission_date': str(t.submission_date) if t.submission_date else None,
            'assigned_to_name': assigned_user.full_name if assigned_user else '',
            'rfp_document': t.rfp_document,
            'products': [_ser_product(p) for p in products],
        }
        step2 = {
            'tender_fee_required': bool(t.tender_fee_required),
            'tender_fee_amount': float(t.tender_fee_amount) if t.tender_fee_amount else None,
            'tender_fee_method': t.tender_fee_method or '',
            'emd_required': bool(t.emd_required),
            'emd_amount': float(t.emd_amount) if t.emd_amount else None,
            'emd_payment_method': t.emd_payment_method or '',
            'emd_bank_name': t.emd_bank_name or '',
            'pbg_required': bool(t.pbg_required),
            'pbg_amount': float(t.pbg_amount) if t.pbg_amount else None,
            'split_order': bool(t.split_order),
            'reverse_auction': bool(t.reverse_auction),
        }
        fp_rows = db.query(TenderProduct).filter(
            TenderProduct.tender_id == t.id,
            TenderProduct.is_final_boq == True,
        ).all()
        final_products = [
            {
                'product_name': p.product_name,
                'oem_name': p.oem_name or '',
                'authorization_num': p.authorization_num or '',
                'quantity': float(p.quantity or 0),
                'unit_price': float(p.unit_price or 0),
                'gst_percent': float(p.gst_percent or 0),
                'total_price': float(p.total_price or 0),
                'is_works_item': bool(p.is_works_item),
                'work_type': p.work_type or '',
            }
            for p in fp_rows
        ]
        step3 = None
        if t.corrigendum_document or t.workings_document or final_products:
            step3 = {
                'corrigendum_document': t.corrigendum_document,
                'workings_document': t.workings_document,
                'final_products': final_products,
            }

        step4 = None
        if t.tech_bid_eligible:
            bidders = db.query(TenderTechBidBidder).filter(
                TenderTechBidBidder.tender_id == t.id
            ).order_by(TenderTechBidBidder.sort_order).all()
            _bidder_ids = [b.id for b in bidders]
            _bid_items_all = db.query(TenderTechBidItem).filter(
                TenderTechBidItem.bidder_id.in_(_bidder_ids)
            ).order_by(TenderTechBidItem.sort_order).all() if _bidder_ids else []
            _bid_items_by_bidder: dict[int, list] = {}
            for _bi in _bid_items_all:
                _bid_items_by_bidder.setdefault(_bi.bidder_id, []).append(_bi)
            step4 = {
                'tech_bid_eligible': t.tech_bid_eligible,
                'bidders': [
                    {
                        'bidder_name': b.bidder_name,
                        'bidder_type': b.bidder_type or '',
                        'items': [
                            {
                                'product_name': i.product_name or '',
                                'oem_name': i.oem_name or '',
                            }
                            for i in _bid_items_by_bidder.get(b.id, [])
                        ],
                    }
                    for b in bidders
                ],
            }

        step5 = None
        if t.result:
            loss = db.query(TenderLossAnalysis).filter(TenderLossAnalysis.tender_id == t.id).first()
            step5 = {
                'result': t.result or '',
                'result_date': str(t.result_date) if t.result_date else '',
                'bid_amount': float(t.bid_amount) if t.bid_amount else None,
                'reverse_auction_final_bid': float(t.reverse_auction_final_bid) if t.reverse_auction_final_bid else None,
                'loss_analysis': {
                    'our_position': loss.our_position or '',
                    'competitor_name': loss.competitor_name or '',
                    'competitor_amount': float(loss.competitor_amount) if loss.competitor_amount else None,
                    'our_bid_amount': float(loss.our_bid_amount) if loss.our_bid_amount else None,
                    'l1_company': loss.l1_company or '', 'l1_amount': float(loss.l1_amount) if loss.l1_amount else None,
                    'l2_company': loss.l2_company or '', 'l2_amount': float(loss.l2_amount) if loss.l2_amount else None,
                    'l3_company': loss.l3_company or '', 'l3_amount': float(loss.l3_amount) if loss.l3_amount else None,
                    'loss_reason': loss.loss_reason or '',
                } if loss else None,
            }

        step7 = None
        if t.po_num:
            po_docs = [d for d in documents if d['doc_type'] == 'PO Document']
            step7 = {
                'po_num': t.po_num or '',
                'po_date': str(t.po_date) if t.po_date else '',
                'po_value': float(t.po_value) if t.po_value else None,
                'wrnty_mth': int(t.wrnty_mth) if t.wrnty_mth else None,
                'no_of_consignee': int(t.no_of_consignee) if t.no_of_consignee else None,
                'dlvry_date': str(t.dlvry_date) if t.dlvry_date else '',
                'site_eng': t.site_eng or '',
                'eng_phone': t.eng_phone or '',
                'pmnt_terms': t.pmnt_terms or '',
                'sow': t.sow or '',
                'completion_days': int(t.completion_days) if t.completion_days else None,
                'completion_date': str(t.completion_date) if t.completion_date else '',
                'penalty': bool(t.penalty),
                'ld_type': t.ld_type or '',
                'ld_percent': float(t.ld_percent) if t.ld_percent else None,
                'po_documents': po_docs,
            }

        return {
            'type': 'tender',
            'action_key': request.action_key or '',
            'tender_id': t.id,
            'tender_num': t.tender_num,
            'workflow_status': t.workflow_status or 'draft',
            'current_step': t.current_step or 1,
            'step1': step1,
            'step2': step2,
            'step3': step3,
            'step4': step4,
            'step5': step5,
            'step7': step7,
            'documents': documents,
            'tender_timeline': build_tender_lifecycle_timeline(db, t),
        }
    if request.module_key == "emdbg":
        record = db.query(EMDBG).filter(EMDBG.id == request.record_id).first()
        if not record:
            return None
        return {
            "type": "emdbg",
            "reference_num": record.reference_num,
            "instrument_type": record.instrument_type,
            "amount": float(record.amount or 0),
            "status": record.status,
        }
    if request.module_key == "travel":
        travel_request = db.query(TravelRequest).filter(TravelRequest.id == request.record_id).first()
        if not travel_request:
            return None
        employee = db.query(User).filter(User.id == travel_request.employee_id).first() if travel_request.employee_id else None
        customer = db.query(Customer).filter(Customer.id == travel_request.customer_id).first() if travel_request.customer_id else None
        lead = db.query(Lead).filter(Lead.id == travel_request.lead_id).first() if travel_request.lead_id else None
        tender = db.query(Tender).filter(Tender.id == travel_request.tender_id).first() if travel_request.tender_id else None

        def _date(value: Any) -> str:
            return str(value) if value else ""

        def _num(value: Any) -> Optional[float]:
            return float(value) if value is not None else None

        tender_label = ""
        if tender:
            tender_label = tender.tender_num or tender.tender_title or f"Tender #{tender.id}"
            if tender.tender_num and tender.tender_title:
                tender_label = f"{tender.tender_num} — {tender.tender_title}"

        return {
            "type": "travel",
            "request_number": travel_request.request_number,
            "employee_name": employee.full_name if employee else "",
            "purpose": travel_request.purpose,
            "visit_type": travel_request.visit_type,
            "account_id": travel_request.customer_id,
            "account_name": (
                (customer.customer_name if customer else "")
                or (lead.customer_name if lead else "")
                or (tender.customer_name if tender else "")
            ),
            "lead_id": travel_request.lead_id,
            "lead_ref": (lead.lead_ref_id if lead else "") or (str(travel_request.lead_id) if travel_request.lead_id else ""),
            "opportunity_id": travel_request.opportunity_id,
            "tender_id": travel_request.tender_id,
            "tender_label": tender_label,
            "contact_name": travel_request.contact_name or "",
            "contact_phone": travel_request.contact_phone or "",
            "from_city": travel_request.from_city,
            "to_city": travel_request.to_city,
            "travel_date": _date(travel_request.travel_date),
            "return_date": _date(travel_request.return_date),
            "total_days": travel_request.total_days or 1,
            "is_outside_district": bool(travel_request.is_outside_district),
            "transport_mode": travel_request.transport_mode or "",
            "vehicle_number": travel_request.vehicle_number or "",
            "estimated_kms": _num(travel_request.estimated_kms),
            "advance_booking_ref": travel_request.advance_booking_ref or "",
            "estimated_total": _num(travel_request.estimated_total),
            "advance_required": bool(travel_request.advance_required),
            "advance_amount": _num(travel_request.advance_amount),
            "cost_center": travel_request.cost_center or "",
            "budget_code": travel_request.budget_code or "",
            "accommodation_required": bool(travel_request.accommodation_required),
            "accommodation_type": travel_request.accommodation_type or "",
            "hotel_name": travel_request.hotel_name or "",
            "check_in_date": _date(travel_request.check_in_date),
            "check_out_date": _date(travel_request.check_out_date),
            "accommodation_cost": _num(travel_request.accommodation_cost),
            "companions": travel_request.companions or "",
            "status": travel_request.status,
            "notes": travel_request.notes or "",
            "source": getattr(travel_request, "source", "direct"),
        }
    if request.module_key == "quotation":
        from app.models.all_models import Quotation, QuotationLineItem
        q = db.query(Quotation).filter(Quotation.id == request.record_id).first()
        if not q:
            return None
        if request.action_key == "stage":
            # Quotes stage gate: record_id is the quote's first revision – approvers review its latest revision.
            q = (
                db.query(Quotation)
                .filter(Quotation.quotation_number == q.quotation_number)
                .order_by(Quotation.revision_number.desc(), Quotation.id.desc())
                .first()
            ) or q
        items = (
            db.query(QuotationLineItem)
            .filter(QuotationLineItem.quotation_id == q.id)
            .order_by(QuotationLineItem.sort_order)
            .all()
        )
        source_title = source_ref = ""
        if q.lead_id:
            lead = db.query(Lead).filter(Lead.id == q.lead_id).first()
            if lead:
                source_title = lead.lead_title or ""
                source_ref = lead.lead_ref_id or ""
        elif q.tender_id:
            tender = db.query(Tender).filter(Tender.id == q.tender_id).first()
            if tender:
                source_title = tender.tender_title or ""
                source_ref = tender.tender_num or ""
        customer_name = ""
        if q.customer_id:
            cust = db.query(Customer).filter(Customer.id == q.customer_id).first()
            if cust:
                customer_name = cust.customer_name or ""
        return {
            "type":             "quotation",
            "quotation_number": q.quotation_number or "",
            "revision_number":  q.revision_number,
            "subject":          q.subject or "",
            "status":           q.status or "",
            "approval_status":  q.approval_status or "none",
            "customer_name":    customer_name,
            "source_title":     source_title,
            "source_ref":       source_ref,
            "amount":           float(q.amount or 0),
            "tax_amount":       float(q.tax_amount or 0),
            "total_amount":     float(q.total_amount or 0),
            "valid_until":      str(q.valid_until) if q.valid_until else None,
            "notes":            q.notes or "",
            "line_items": [
                {
                    "description": i.description or "",
                    "quantity":    float(i.quantity or 1),
                    "unit_price":  float(i.unit_price or 0),
                    "tax_percent": float(i.tax_percent or 0),
                    "line_total":  float(i.line_total or 0),
                }
                for i in items
            ],
        }
    return None


def serialize_request_for_ui(db: Session, request: ApprovalRequest) -> dict:
    steps = sorted(request.steps or [], key=lambda item: item.step_no)
    active_step = next((step for step in steps if step.step_no == request.current_step_no), None)
    latest_acted_step = next((step for step in reversed(steps) if step.acted_at), None)
    progress = get_request_progress(request)
    module_label = get_module_label(request.module_key)
    action_label = get_action_label(request.module_key, request.action_key)

    return {
        "id": request.id,
        "kind": "dynamic",
        "module": request.module_key,
        "module_key": request.module_key,
        "module_label": module_label,
        "action": request.action_key,
        "action_key": request.action_key,
        "action_label": action_label,
        "type_label": f"{module_label} {action_label} Approval",
        "record_id": request.record_id,
        "record_ref": _build_request_record_ref(db, request),
        "status": request.status,
        "requested_by": request.requested_by,
        "requested_by_name": request.requester.full_name if request.requester else "",
        "requested_to": active_step.approver_user_id if active_step else None,
        "requested_to_name": active_step.approver.full_name if active_step and active_step.approver else "",
        "request_notes": _build_request_notes(db, request),
        "decision_notes": latest_acted_step.remarks if latest_acted_step else None,
        "rejection_reason": latest_acted_step.remarks if (request.status or "").strip().lower() == "rejected" and latest_acted_step else None,
        "decided_at": request.final_decided_at.isoformat() if request.final_decided_at else None,
        "created_at": request.requested_at.isoformat() if request.requested_at else None,
        "approval_progress_current": progress["current"],
        "approval_progress_total": progress["total"],
        "approval_display": progress["display"],
        "current_step_no": request.current_step_no,
        "summary": _build_request_summary(db, request),
        "steps": [
            {
                "id": step.id,
                "step_no": step.step_no,
                "approver_user_id": step.approver_user_id,
                "approver_name": step.approver.full_name if step.approver else None,
                "approver_role": step.approver_role,
                "status": step.status,
                "remarks": step.remarks,
                "assigned_at": step.assigned_at.isoformat() if step.assigned_at else None,
                "acted_at": step.acted_at.isoformat() if step.acted_at else None,
                "escalated_at": step.escalated_at.isoformat() if step.escalated_at else None,
                "escalation_count": int(getattr(step, "escalation_count", 0) or 0),
                "resolved_from": step.resolved_from,
            }
            for step in steps
        ],
    }


def _get_active_reporting_manager(db: Session, requester: User) -> Optional[User]:
    manager_id = getattr(requester, "reporting_manager_id", None)
    if not manager_id:
        return None
    return (
        db.query(User)
        .filter(
            User.id == manager_id,
            User.is_active == True,
        )
        .first()
    )


def _get_user_org_tree_group_node_id(db: Session, user_id: Optional[int]) -> Optional[int]:
    if not user_id:
        return None
    try:
        node = db.query(OrgTreeNode).filter(
            OrgTreeNode.user_id == user_id,
            OrgTreeNode.is_active == True,
        ).first()
        if not node:
            return None
        if node.level == 2:
            return node.id
        # For L3+: find the L2 node for this group via group_lead_id
        lead_id = getattr(node, "group_lead_id", None)
        if lead_id:
            l2_node = db.query(OrgTreeNode).filter(
                OrgTreeNode.user_id == lead_id,
                OrgTreeNode.level == 2,
                OrgTreeNode.is_active == True,
            ).first()
            if l2_node:
                return l2_node.id
        return None
    except Exception:
        return None


def _resolve_request_group_id(
    db: Session,
    *,
    requester: User,
    module_key: str,
    record_id: int,
    explicit_group_id: Optional[int] = None,
) -> Optional[int]:
    if explicit_group_id:
        return int(explicit_group_id)

    model_by_module = {
        "customer": Customer,
        "lead": Lead,
        "deal": Lead,
        "tender": Tender,
        "emdbg": EMDBG,
        "travel": TravelRequest,
    }
    record_model = model_by_module.get((module_key or "").strip().lower())
    if record_model is not None:
        record = db.query(record_model).filter(record_model.id == record_id).first()
        if record is not None:
            record_group_id = _primary_group_id_from_value(getattr(record, "group_id", None))
            if record_group_id:
                return record_group_id

    # Look up the requester's group via org_tree_nodes (new group system)
    org_tree_group_id = _get_user_org_tree_group_node_id(db, getattr(requester, "id", None))
    if org_tree_group_id:
        return org_tree_group_id

    return _primary_group_id_from_value(getattr(requester, "group_id", None))


def _collect_org_subtree_ids(db: Session, node_id: int) -> list[int]:
    ids = [node_id]
    try:
        children = db.query(OrgTreeNode).filter(
            OrgTreeNode.parent_id == node_id,
            OrgTreeNode.is_active == True,
        ).all()
        for child in children:
            ids.extend(_collect_org_subtree_ids(db, child.id))
    except Exception:
        logger.exception("_collect_org_subtree_ids failed for node_id=%s", node_id)
    return ids


def _load_group_hierarchy_nodes(
    db: Session,
    group_id: Optional[int],
) -> list[GroupHierarchyNode]:
    if not group_id:
        return []

    try:
        # Resolve the group lead for this root node so we can find all members
        # via group_lead_id — more reliable than walking parent_id recursively.
        root = db.query(OrgTreeNode).filter(OrgTreeNode.id == group_id).first()
        if not root:
            return []
        lead_user_id = getattr(root, "group_lead_id", None) or getattr(root, "user_id", None)
        if not lead_user_id:
            return []

        rows = (
            db.query(OrgTreeNode, User)
            .join(User, User.id == OrgTreeNode.user_id)
            .filter(
                OrgTreeNode.group_lead_id == lead_user_id,
                OrgTreeNode.is_active == True,
                User.is_active == True,
            )
            .order_by(OrgTreeNode.level.asc(), OrgTreeNode.id.asc())
            .all()
        )
        return [
            GroupHierarchyNode(
                hierarchy_id=int(node.id),
                group_id=int(group_id),
                user=approver,
                role=normalize_role_key(getattr(approver, "role", None)) or "",
                level=int(getattr(node, "level", 0) or 0),
                parent_user_id=getattr(node, "parent_user_id", None),
            )
            for node, approver in rows
            if approver is not None
        ]
    except Exception:
        logger.exception("_load_group_hierarchy_nodes failed for group_id=%s", group_id)
        return []


def _find_global_org_node_at_level(
    db: Session,
    target_level: int,
    group_id: Optional[int],
) -> "Optional[GroupHierarchyNode]":
    """Find an approver at target_level by searching the full org tree.

    Used when the target level cannot be reached from within the requester's
    group hierarchy — e.g., an L1 CEO step where the L2 group lead has
    parent_id=NULL (no L1 parent in the org tree).

    Mirrors the logic in the approval-workflow UI endpoint that populates
    available levels: first look for an OrgTreeNode at the level, then fall
    back to users with admin/ceo role for level 1.
    """
    try:
        node = (
            db.query(OrgTreeNode)
            .filter(OrgTreeNode.level == target_level, OrgTreeNode.is_active == True)
            .first()
        )
        if node:
            approver = (
                db.query(User)
                .filter(User.id == node.user_id, User.is_active == True)
                .first()
            )
            if approver:
                return GroupHierarchyNode(
                    hierarchy_id=int(node.id),
                    group_id=int(group_id) if group_id else int(node.id),
                    user=approver,
                    role=normalize_role_key(getattr(approver, "role", None)) or "",
                    level=int(node.level),
                    parent_user_id=getattr(node, "parent_user_id", None),
                )

        # Level-1 fallback: no org-tree node exists, use ceo/admin role user.
        # Use func.lower so this matches regardless of how role is cased in the DB.
        if target_level <= 1:
            ceo_user = (
                db.query(User)
                .filter(
                    func.lower(func.trim(User.role)).in_(["ceo", "admin"]),
                    User.is_active == True,
                )
                .first()
            )
            if ceo_user:
                return GroupHierarchyNode(
                    hierarchy_id=0,
                    group_id=int(group_id) if group_id else 0,
                    user=ceo_user,
                    role=normalize_role_key(getattr(ceo_user, "role", None)) or "",
                    level=1,
                    parent_user_id=None,
                )
    except Exception:
        logger.exception(
            "_find_global_org_node_at_level failed for level=%s group=%s",
            target_level, group_id,
        )
    return None


def _find_ancestor_at_level(
    nodes_by_user_id: dict[int, "GroupHierarchyNode"],
    requester_id: int,
    target_level: int,
) -> "Optional[GroupHierarchyNode]":
    """Walk up parent_user_id links from requester to find the first ancestor at target_level."""
    current = nodes_by_user_id.get(requester_id)
    if current is None or current.level <= target_level:
        return None
    seen: set[int] = {requester_id}
    for _ in range(MAX_REPORTING_CHAIN_DEPTH):
        parent_id = current.parent_user_id
        if not parent_id or parent_id in seen:
            return None
        seen.add(parent_id)
        parent = nodes_by_user_id.get(parent_id)
        if parent is None:
            return None
        if parent.level == target_level:
            return parent
        if parent.level < target_level:
            return None
        current = parent
    return None


def _extend_chain_to_l1(
    db: Session,
    chain: list[GroupHierarchyNode],
    request_group_id: Optional[int],
    exclude_user_ids: Optional[set[int]] = None,
) -> None:
    """Append the global L1 CEO node to chain if the chain doesn't reach L1.

    Called after the parent_user_id walk so that every chain — regardless of
    how deep in the org tree the requester sits — always terminates at the
    top-level approver (L1 CEO).  Modifies chain in place.
    """
    if chain and getattr(chain[-1], "level", 0) <= 1:
        return  # already at or above L1
    already_ids = {getattr(n.user, "id", None) for n in chain} | (exclude_user_ids or set())
    l1_node = _find_global_org_node_at_level(db, 1, request_group_id)
    if l1_node is not None and getattr(l1_node.user, "id", None) not in already_ids:
        chain.append(l1_node)


def _build_group_parent_chain(
    db: Session,
    requester: User,
    request_group_id: Optional[int],
) -> list[GroupHierarchyNode]:
    """Build the ordered list of approvers above the requester in the org tree.

    Walk order: requester → parent_user_id → … → L2 group lead → L1 CEO.
    The chain always ends at L1 so multi-step reporting_manager flows (e.g.
    L4→L3→L2→L1) resolve correctly for every level in the hierarchy.
    """
    nodes = _load_group_hierarchy_nodes(db, request_group_id)
    if not nodes:
        return []

    node_by_user_id = {
        getattr(node.user, "id", None): node
        for node in nodes
        if getattr(node.user, "id", None) is not None
    }

    requester_id = getattr(requester, "id", None)
    requester_node = node_by_user_id.get(requester_id)
    current_parent_user_id = (
        getattr(requester_node, "parent_user_id", None)
        if requester_node is not None
        else getattr(requester, "reporting_manager_id", None)
    )

    chain: list[GroupHierarchyNode] = []
    seen_user_ids: set[int] = {requester_id} if requester_id is not None else set()

    for _ in range(MAX_REPORTING_CHAIN_DEPTH):
        if not current_parent_user_id or current_parent_user_id in seen_user_ids:
            break
        parent_node = node_by_user_id.get(current_parent_user_id)
        if not parent_node:
            break
        chain.append(parent_node)
        seen_user_ids.add(current_parent_user_id)
        current_parent_user_id = parent_node.parent_user_id

    # Always extend to L1 CEO so that:
    #   L4 requester → [L3, L2, L1]  (3-step flow works)
    #   L3 requester → [L2, L1]      (2-step flow works)
    #   L2 group lead → [L1]         (group lead always has an approver)
    _extend_chain_to_l1(db, chain, request_group_id, exclude_user_ids=seen_user_ids)

    return chain


def _renumber_resolved_steps(resolved_steps: list[ResolvedApprovalStep]) -> list[ResolvedApprovalStep]:
    for index, step in enumerate(resolved_steps, start=1):
        step.step_no = index
    return resolved_steps


def _update_cursor_from_chain_user(
    approver_user_id: Optional[int],
    parent_chain: list[GroupHierarchyNode],
    current_index: int,
) -> int:
    if approver_user_id is None:
        return current_index

    for index in range(current_index, len(parent_chain)):
        if getattr(parent_chain[index].user, "id", None) == approver_user_id:
            return index + 1
    return current_index


def resolve_rule_step_approver(
    db: Session,
    requester: User,
    step: ApprovalRuleStep,
    *,
    request_group_id: Optional[int] = None,
    parent_chain: Optional[list[GroupHierarchyNode]] = None,
    parent_chain_index: int = 0,
    allow_global_role_fallback: bool = False,
    exclude_user_ids: Optional[set[int]] = None,
) -> tuple[ResolvedApprovalStep, int]:
    approver_type = (step.approver_type or "reporting_manager").strip().lower()
    effective_parent_chain = parent_chain or _build_group_parent_chain(db, requester, request_group_id)

    if approver_type == "reporting_manager":
        if parent_chain_index < len(effective_parent_chain):
            approver_node = effective_parent_chain[parent_chain_index]
            return (
                ResolvedApprovalStep(
                    step_no=step.step_no,
                    approver_user=approver_node.user,
                    approver_role=approver_node.role,
                    resolved_from=f"group_parent:{request_group_id}:{approver_node.hierarchy_id}",
                    stop_on_reject=bool(step.stop_on_reject),
                ),
                parent_chain_index + 1,
            )

        # Chain exhausted — try the user's explicit reporting_manager_id, then
        # fall back to the global L1 CEO node so group leads (whose parent chain
        # is empty) always get a valid approver rather than a hard error.
        # NOTE: Do NOT filter by excluded_ids here — dedup is handled upstream in
        # resolve_rule_steps_for_request. Filtering here causes errors when the
        # only valid approver (e.g. CEO) was already used in an earlier step.
        approver = _get_active_reporting_manager(db, requester)
        if not approver:
            l1_node = _find_global_org_node_at_level(db, 1, request_group_id)
            if l1_node is not None:
                l1_user = l1_node.user
                if getattr(l1_user, "id", None) != getattr(requester, "id", None):
                    approver = l1_user
        if not approver:
            raise HTTPException(
                status_code=400,
                detail=(
                    "No approver could be found: the requester is at the top of the hierarchy "
                    "and no L1 CEO node is configured in the org tree. "
                    "Add an L1 CEO to org_tree_nodes or set reporting_manager_id on the user."
                ),
            )
        return (
            ResolvedApprovalStep(
                step_no=step.step_no,
                approver_user=approver,
                approver_role=normalize_role_key(getattr(approver, "role", None)),
                resolved_from="reporting_manager_chain_top",
                stop_on_reject=bool(step.stop_on_reject),
            ),
            parent_chain_index,
        )

    if approver_type == "role":
        role = normalize_role_key(step.approver_role)
        if not role:
            raise HTTPException(status_code=400, detail=f"Step {step.step_no} is missing approver role.")

        for index in range(parent_chain_index, len(effective_parent_chain)):
            candidate = effective_parent_chain[index]
            if candidate.role != role:
                continue
            return (
                ResolvedApprovalStep(
                    step_no=step.step_no,
                    approver_user=candidate.user,
                    approver_role=role,
                    resolved_from=f"group_parent:{request_group_id}:{candidate.hierarchy_id}:{role}",
                    stop_on_reject=bool(step.stop_on_reject),
                ),
                index + 1,
            )

        if allow_global_role_fallback:
            # Use global fallback whenever the role is not reachable from the
            # current chain position — even if the role exists elsewhere in the
            # group hierarchy (e.g. CEO registered in group but parent_user_id
            # chain doesn't reach them from the current index).
            role_in_remaining_chain = any(
                n.role == role
                for n in effective_parent_chain[parent_chain_index:]
            )
            if not role_in_remaining_chain:
                fallback_candidates = _find_active_users_by_role(
                    db,
                    role,
                    exclude_user_ids=exclude_user_ids,
                )
                if fallback_candidates:
                    fallback_approver = fallback_candidates[0]
                    return (
                        ResolvedApprovalStep(
                            step_no=step.step_no,
                            approver_user=fallback_approver,
                            approver_role=role,
                            resolved_from=f"role_fallback:{role}:{fallback_approver.id}",
                            stop_on_reject=bool(step.stop_on_reject),
                        ),
                        parent_chain_index,
                    )

        raise HTTPException(
            status_code=400,
            detail=f"No approver resolved for role '{role}' above the requester in this group.",
        )

    if approver_type == "specific_user":
        if not step.approver_user_id:
            raise HTTPException(status_code=400, detail=f"Step {step.step_no} is missing specific approver.")
        approver = (
            db.query(User)
            .filter(
                User.id == step.approver_user_id,
                User.is_active == True,
            )
            .first()
        )
        if not approver:
            raise HTTPException(status_code=400, detail=f"Specific approver for step {step.step_no} is inactive or missing.")
        next_index = _update_cursor_from_chain_user(
            getattr(approver, "id", None),
            effective_parent_chain,
            parent_chain_index,
        )
        return (
            ResolvedApprovalStep(
                step_no=step.step_no,
                approver_user=approver,
                approver_role=normalize_role_key(getattr(approver, "role", None)),
                resolved_from=f"specific_user:{approver.id}",
                stop_on_reject=bool(step.stop_on_reject),
            ),
            next_index,
        )

    if approver_type == "hierarchy_level":
        target_level = getattr(step, "approver_level", None)
        if not target_level:
            raise HTTPException(
                status_code=400,
                detail=f"Step {step.step_no} has hierarchy_level type but no approver_level set.",
            )
        all_nodes = _load_group_hierarchy_nodes(db, request_group_id)
        nodes_by_user_id = {
            getattr(n.user, "id", None): n
            for n in all_nodes
            if getattr(n.user, "id", None) is not None
        }
        requester_id = getattr(requester, "id", None)
        ancestor = _find_ancestor_at_level(nodes_by_user_id, requester_id, int(target_level))

        # Fallback: the target level may not exist inside this group's own nodes
        # (e.g., L1 CEO step when the L2 group lead has no parent in the org tree).
        # Mirror the same global-lookup logic used by the approval-workflow UI.
        if ancestor is None:
            ancestor = _find_global_org_node_at_level(db, int(target_level), request_group_id)

        if ancestor is not None:
            return (
                ResolvedApprovalStep(
                    step_no=step.step_no,
                    approver_user=ancestor.user,
                    approver_role=ancestor.role,
                    resolved_from=f"group_level:{request_group_id}:{target_level}:{ancestor.hierarchy_id}",
                    stop_on_reject=bool(getattr(step, "stop_on_reject", True)),
                ),
                parent_chain_index,
            )
        raise HTTPException(
            status_code=400,
            detail=f"No approver found at org level {target_level} for requester in group {request_group_id}.",
        )

    raise HTTPException(status_code=400, detail=f"Unsupported approver type '{step.approver_type}'.")


def resolve_rule_steps_for_request(
    db: Session,
    requester: User,
    rule_steps: list[ApprovalRuleStep],
    *,
    request_group_id: Optional[int] = None,
    allow_global_role_fallback: bool = False,
) -> list[ResolvedApprovalStep]:
    resolved_steps: list[ResolvedApprovalStep] = []
    parent_chain = _build_group_parent_chain(db, requester, request_group_id)
    parent_chain_index = 0

    # Use the org-tree level (reliable) rather than the roles-table level (can have
    # wrong values that previously caused auto-approval for non-CEO roles).
    requester_org_level = get_user_org_tree_level(db, requester)
    requester_role_name = normalize_role_key(getattr(requester, "role", None))

    for step in sorted(rule_steps, key=lambda item: item.step_no):
        approver_type = (step.approver_type or "").strip().lower()

        # Skip a role step only when the requester's own role matches the approver
        # role — i.e. the requester would be approving themselves.
        # We intentionally do NOT compare role-table levels here because those
        # values can be misconfigured (e.g. sales_head stored at level=1).
        if approver_type == "role":
            step_role = normalize_role_key(step.approver_role)
            if step_role and requester_role_name == step_role:
                logger.info(
                    "Skipping role step %s (%s) — requester %s has the same role",
                    step.step_no,
                    step_role,
                    getattr(requester, "id", None),
                )
                continue

        # For any step that carries an explicit approver_level, skip it when the
        # requester is already at that level or above it in the org hierarchy.
        # Org levels: lower number = higher in hierarchy (L1=CEO, L4=executive).
        # This applies to all approver_types — including reporting_manager —
        # so that a rule configured for [L2] auto-skips when L2 is the requester,
        # correctly falling through to the group-head auto-approve path.
        if (
            step.approver_level is not None
            and requester_org_level is not None
            and step.approver_level >= requester_org_level
        ):
            logger.info(
                "Skipping step %s (org level %s) — requester %s is at org level %s",
                step.step_no,
                step.approver_level,
                getattr(requester, "id", None),
                requester_org_level,
            )
            continue

        exclude_user_ids = {
            user_id
            for user_id in (
                getattr(requester, "id", None),
                *[getattr(rs.approver_user, "id", None) for rs in resolved_steps],
            )
            if user_id is not None
        }
        try:
            resolved_step, parent_chain_index = resolve_rule_step_approver(
                db,
                requester,
                step,
                request_group_id=request_group_id,
                parent_chain=parent_chain,
                parent_chain_index=parent_chain_index,
                allow_global_role_fallback=allow_global_role_fallback,
                exclude_user_ids=exclude_user_ids,
            )
        except HTTPException as exc:
            if exc.status_code == 400:
                is_required = bool(getattr(step, "is_required", True))
                if is_required:
                    # Required step could not be resolved — surface the error so the
                    # admin can fix the org tree or rule config instead of silently
                    # dropping the step (e.g. CEO has no org_tree_nodes entry at L1).
                    logger.error(
                        "Required approval step %s could not be resolved for requester %s "
                        "in group %s: %s",
                        step.step_no,
                        getattr(requester, "id", None),
                        request_group_id,
                        exc.detail,
                    )
                    raise
                logger.warning(
                    "Skipping optional approval step %s for requester %s in group %s: %s",
                    step.step_no,
                    getattr(requester, "id", None),
                    request_group_id,
                    exc.detail,
                )
                continue
            raise

        # Skip duplicate approver — same user resolved for two different steps
        # (common when L2 group lead submits: parent chain is [CEO], but a 2-step
        # rule with reporting_manager steps consumes CEO on step 1 then hits the
        # chain-exhausted fallback which resolves to CEO again on step 2).
        resolved_approver_id = getattr(resolved_step.approver_user, "id", None)
        already_resolved_ids = {
            getattr(rs.approver_user, "id", None) for rs in resolved_steps
        }
        if resolved_approver_id is not None and resolved_approver_id in already_resolved_ids:
            logger.info(
                "Skipping duplicate approver %s for step %s (requester=%s, group=%s) — "
                "already included in a previous step.",
                resolved_approver_id,
                step.step_no,
                getattr(requester, "id", None),
                request_group_id,
            )
            continue

        resolved_steps.append(resolved_step)

    return _renumber_resolved_steps(resolved_steps)

def filter_resolved_steps_for_request(
    db: Session,
    requester: User,
    resolved_steps: list[ResolvedApprovalStep],
) -> list[ResolvedApprovalStep]:
    requester_id = getattr(requester, "id", None)
    requester_level = get_role_level(db, getattr(requester, "role", None))

    filtered: list[ResolvedApprovalStep] = []
    for step in resolved_steps:
        approver_id = getattr(step.approver_user, "id", None)
        # Drop any step where the approver IS the requester
        if approver_id is not None and approver_id == requester_id:
            continue
        # Drop any step where the approver's role level is >= requester's level
        # (same rank or lower than requester — they cannot meaningfully approve above themselves)
        if requester_level is not None:
            approver_level = get_role_level(db, getattr(step.approver_user, "role", None))
            if approver_level is not None and approver_level >= requester_level:
                continue
        filtered.append(step)

    return _renumber_resolved_steps(filtered)


def _get_reporting_chain_users(db: Session, requester: User) -> list[User]:
    reporting_chain: list[User] = []
    seen_user_ids = {getattr(requester, "id", None)}
    current = requester

    for _ in range(MAX_REPORTING_CHAIN_DEPTH):
        manager_id = getattr(current, "reporting_manager_id", None)
        if not manager_id or manager_id in seen_user_ids:
            break

        manager = (
            db.query(User)
            .filter(User.id == manager_id, User.is_active == True)
            .first()
        )
        if not manager:
            break

        reporting_chain.append(manager)
        seen_user_ids.add(manager.id)
        current = manager

    return reporting_chain


def _resolve_fallback_reporting_manager_chain(
    db: Session,
    requester: User,
) -> list[ResolvedApprovalStep]:
    reporting_chain = _get_reporting_chain_users(db, requester)
    resolved_steps = [
        ResolvedApprovalStep(
            step_no=index,
            approver_user=approver,
            approver_role=normalize_role_key(getattr(approver, "role", None)),
            resolved_from="reporting_manager_chain",
            stop_on_reject=True,
        )
        for index, approver in enumerate(reporting_chain, start=1)
    ]
    return _renumber_resolved_steps(resolved_steps)


def resolve_hierarchy_approval_steps(
    db: Session,
    requester: User,
    *,
    request_group_id: Optional[int] = None,
) -> list[ResolvedApprovalStep]:
    node = db.query(OrgTreeNode).filter(
        OrgTreeNode.is_active == True,
        OrgTreeNode.user_id == requester.id,
    ).first()

    if not node:
        return []

    steps = []
    step_no = 1
    current = node

    while current and current.parent_id:
        parent = db.query(OrgTreeNode).filter(
            OrgTreeNode.id == current.parent_id,
            OrgTreeNode.is_active == True,
            OrgTreeNode.user_id.isnot(None),
        ).first()

        if not parent:
            break

        approver = db.query(User).filter(
            User.id == parent.user_id,
            User.is_active == True,
        ).first()

        if approver and approver.id != requester.id:
            steps.append(ResolvedApprovalStep(
                step_no=step_no,
                approver_user=approver,
                approver_role=normalize_role_key(getattr(approver, "role", None)),
                resolved_from=f"L{parent.level}",
                stop_on_reject=True,
            ))
            step_no += 1

        current = parent

    # If the chain terminated before reaching L1 (e.g. L2 group lead has no parent
    # in org_tree_nodes), extend it by looking for a global L1 CEO node so CEO is
    # always part of the hierarchy even when not wired into the parent_id chain.
    current_level = getattr(current, "level", None)
    if current_level and int(current_level) > 1:
        l1_node = _find_global_org_node_at_level(db, 1, request_group_id)
        if l1_node is not None:
            l1_approver = l1_node.user
            already_included = {getattr(s.approver_user, "id", None) for s in steps}
            if (
                getattr(l1_approver, "id", None) != getattr(requester, "id", None)
                and getattr(l1_approver, "id", None) not in already_included
            ):
                steps.append(ResolvedApprovalStep(
                    step_no=step_no,
                    approver_user=l1_approver,
                    approver_role=normalize_role_key(getattr(l1_approver, "role", None)),
                    resolved_from="L1",
                    stop_on_reject=True,
                ))

    return steps

def _tenant_filter(q, tenant_id):
    if tenant_id is None:
        return q.filter(ApprovalRule.tenant_id.is_(None))
    return q.filter(ApprovalRule.tenant_id == tenant_id)


def _find_requester_org_group_id(db: Session, user_id: int) -> Optional[int]:
    node = db.query(OrgTreeNode).filter(
        OrgTreeNode.is_active == True,
        OrgTreeNode.user_id == user_id,
    ).order_by(OrgTreeNode.level.asc()).first()

    if not node:
        return None

    if node.level == 2:
        return node.id

    current = node
    while current and current.parent_id:
        parent = db.query(OrgTreeNode).filter(
            OrgTreeNode.id == current.parent_id,
            OrgTreeNode.is_active == True,
        ).first()

        if parent and parent.level == 2:
            return parent.id

        current = parent

    if node.group_lead_id:
        group_node = db.query(OrgTreeNode).filter(
            OrgTreeNode.is_active == True,
            OrgTreeNode.level == 2,
            OrgTreeNode.group_lead_id == node.group_lead_id,
        ).first()
        if group_node:
            return group_node.id

    return None


def _find_matching_approval_rule(
    db: Session,
    *,
    tenant_id: Optional[int],
    requester: User,
    module_key: str,
    action_key: str,
    request_group_id: Optional[int],
) -> tuple[Optional[ApprovalRule], Optional[int]]:
    base = db.query(ApprovalRule).filter(
        ApprovalRule.module_key == module_key,
        ApprovalRule.action_key == action_key,
        ApprovalRule.is_active == True,
    )
    base = _tenant_filter(base, tenant_id)

    resolved_group_id = request_group_id or _find_requester_org_group_id(db, requester.id)
    requester_role = normalize_role_key(getattr(requester, "role", None))

    # 1. By specific user (highest priority)
    rule = base.filter(
        ApprovalRule.requester_type == "specific_user",
        ApprovalRule.requester_user_id == requester.id,
    ).first()
    if rule:
        return rule, resolved_group_id

    # 2. By org group (group membership is more specific than role)
    if resolved_group_id:
        rule = base.filter(
            ApprovalRule.requester_type == "group",
            ApprovalRule.requester_group_id == resolved_group_id,
        ).first()
        if rule:
            return rule, resolved_group_id

    # 3. By role (applies to all requesters with this role across the org)
    if requester_role:
        rule = base.filter(
            ApprovalRule.requester_type == "role",
            func.lower(func.trim(ApprovalRule.requester_role)) == requester_role,
        ).first()
        if rule:
            return rule, resolved_group_id

    # 4. No custom rule — caller falls back to default hierarchy
    return None, resolved_group_id


def create_generic_approval_request(
    db: Session,
    *,
    tenant_id: Optional[int],
    requester: User,
    module_key: str,
    action_key: str,
    record_id: int,
    request_group_id: Optional[int] = None,
) -> ApprovalRequest:
    ensure_generic_approval_schema(db)

    existing_pending = find_pending_request_for_record(
        db,
        module_key=module_key,
        action_key=action_key,
        record_id=record_id,
    )
    if existing_pending:
        repair_request_steps_from_rule(db, existing_pending)
        db.flush()
        if (existing_pending.status or "").strip().lower() != "pending":
            return existing_pending
        raise HTTPException(status_code=409, detail="An approval request is already pending for this record.")

    resolved_request_group_id = _resolve_request_group_id(
        db,
        requester=requester,
        module_key=module_key,
        record_id=record_id,
        explicit_group_id=request_group_id,
    )

    rule, resolved_request_group_id = _find_matching_approval_rule(
        db,
        tenant_id=tenant_id,
        requester=requester,
        module_key=module_key,
        action_key=action_key,
        request_group_id=resolved_request_group_id,
    )
    if is_top_level_auto_approval_requester(db, requester):
        request = ApprovalRequest(
            tenant_id=tenant_id,
            module_key=module_key,
            action_key=action_key,
            record_id=record_id,
            group_id=resolved_request_group_id,
            approval_rule_id=rule.id if rule else None,
            current_step_no=0,
            status="approved",
            requested_by=requester.id,
            requested_at=_utcnow(),
            final_decided_at=_utcnow(),
            approver_user_ids=[],
            approval_mode=(getattr(rule, "approval_type", None) or "hierarchy").strip().lower() if rule else "hierarchy",
        )
        db.add(request)
        db.flush()
        return request

    if not rule:
        if is_auto_approve_enabled_when_no_rule(
            db,
            tenant_id=tenant_id,
            module_key=module_key,
            action_key=action_key,
        ):
            request = ApprovalRequest(
                tenant_id=tenant_id,
                module_key=module_key,
                action_key=action_key,
                record_id=record_id,
                group_id=resolved_request_group_id,
                approval_rule_id=None,
                current_step_no=0,
                status="approved",
                requested_by=requester.id,
                requested_at=_utcnow(),
                final_decided_at=_utcnow(),
                approver_user_ids=[],
                approval_mode="auto",
            )
            db.add(request)
            db.flush()
            return request

        resolved_steps = filter_resolved_steps_for_request(
            db,
            requester,
            resolve_hierarchy_approval_steps(
                db,
                requester,
                request_group_id=resolved_request_group_id,
            ),
        )
        approval_type = "hierarchy"
        if not resolved_steps:
            # Requester is the top of the hierarchy — no one above to approve; auto-approve.
            request = ApprovalRequest(
                tenant_id=tenant_id,
                module_key=module_key,
                action_key=action_key,
                record_id=record_id,
                group_id=resolved_request_group_id,
                approval_rule_id=None,
                current_step_no=0,
                status="approved",
                requested_by=requester.id,
                requested_at=_utcnow(),
                final_decided_at=_utcnow(),
                approver_user_ids=[],
                approval_mode="hierarchy",
            )
            db.add(request)
            db.flush()
            return request
    else:
        approval_type = (getattr(rule, "approval_type", None) or "hierarchy").strip().lower()
        if approval_type == "hierarchy":
            # Use configured hierarchy_level steps if present; otherwise fall back to full parent chain.
            hierarchy_rule_steps = (
                db.query(ApprovalRuleStep)
                .filter(ApprovalRuleStep.approval_rule_id == rule.id)
                .order_by(ApprovalRuleStep.step_no.asc())
                .all()
            )
            if hierarchy_rule_steps:
                resolved_steps = resolve_rule_steps_for_request(
                    db,
                    requester,
                    hierarchy_rule_steps,
                    request_group_id=resolved_request_group_id,
                )
            else:
                resolved_steps = filter_resolved_steps_for_request(
                    db,
                    requester,
                    resolve_hierarchy_approval_steps(
                        db,
                        requester,
                        request_group_id=resolved_request_group_id,
                    ),
                )
        else:
            rule_steps = (
                db.query(ApprovalRuleStep)
                .filter(ApprovalRuleStep.approval_rule_id == rule.id)
                .order_by(ApprovalRuleStep.step_no.asc())
                .all()
            )
            if not rule_steps:
                raise HTTPException(status_code=400, detail="Approval rule has no steps configured.")
            resolved_steps = resolve_rule_steps_for_request(
                db,
                requester,
                rule_steps,
                request_group_id=resolved_request_group_id,
                allow_global_role_fallback=True,
            )

        if not resolved_steps:
            # For sequential (company-defined chain) mode: all configured steps were
            # skipped because the requester outranks every configured approver level.
            # Fall back to the group head so someone always reviews the request.
            # If the requester IS the group head, auto-approve instead.
            if approval_type == "sequential":
                group_head = _find_group_head_user(
                    db,
                    resolved_request_group_id,
                    getattr(requester, "id", None),
                )
                if group_head is not None:
                    logger.info(
                        "Sequential rule: all steps skipped for requester %s "
                        "(module=%s action=%s) — routing to group head %s.",
                        getattr(requester, "id", None),
                        module_key,
                        action_key,
                        getattr(group_head, "id", None),
                    )
                    resolved_steps = [
                        ResolvedApprovalStep(
                            step_no=1,
                            approver_user=group_head,
                            approver_role=normalize_role_key(getattr(group_head, "role", None)),
                            resolved_from="group_head_fallback",
                            stop_on_reject=True,
                        )
                    ]
                    # Fall through to create the pending request below.
                else:
                    # Requester is the group head — auto-approve.
                    logger.info(
                        "Auto-approving request for group head %s (module=%s action=%s): "
                        "no approvers configured above them.",
                        getattr(requester, "id", None),
                        module_key,
                        action_key,
                    )
                    request = ApprovalRequest(
                        tenant_id=tenant_id,
                        module_key=module_key,
                        action_key=action_key,
                        record_id=record_id,
                        group_id=resolved_request_group_id,
                        approval_rule_id=rule.id if rule else None,
                        current_step_no=0,
                        status="approved",
                        requested_by=requester.id,
                        requested_at=_utcnow(),
                        final_decided_at=_utcnow(),
                        approver_user_ids=[],
                        approval_mode=approval_type,
                    )
                    db.add(request)
                    db.flush()
                    return request
            else:
                # Hierarchy mode: requester is at the top — auto-approve.
                logger.info(
                    "Auto-approving request for requester %s (module=%s action=%s): "
                    "no approvers found above them in the org tree.",
                    getattr(requester, "id", None),
                    module_key,
                    action_key,
                )
                request = ApprovalRequest(
                    tenant_id=tenant_id,
                    module_key=module_key,
                    action_key=action_key,
                    record_id=record_id,
                    group_id=resolved_request_group_id,
                    approval_rule_id=rule.id if rule else None,
                    current_step_no=0,
                    status="approved",
                    requested_by=requester.id,
                    requested_at=_utcnow(),
                    final_decided_at=_utcnow(),
                    approver_user_ids=[],
                    approval_mode=approval_type,
                )
                db.add(request)
                db.flush()
                return request


    request = ApprovalRequest(
        tenant_id=tenant_id,
        module_key=module_key,
        action_key=action_key,
        record_id=record_id,
        group_id=resolved_request_group_id,
        approval_rule_id=rule.id if rule else None,
        current_step_no=resolved_steps[0].step_no,
        status="pending",
        requested_by=requester.id,
        requested_at=_utcnow(),
        approver_user_ids=[step.approver_user.id for step in resolved_steps],
        approval_mode=approval_type,
    )
    db.add(request)
    db.flush()

    log_module_action(
        db=db, user_id=requester.id, module=module_key, action="submit_for_approval",
        record_id=record_id, ip="",
        description=f"Submitted {module_key} #{record_id} for approval ({action_key})",
        new_data={
            "action_key": action_key,
            "approval_request_id": request.id,
            "approver_user_ids": request.approver_user_ids,
        },
    )

    for step in resolved_steps:
        db.add(
            ApprovalRequestStep(
                approval_request_id=request.id,
                step_no=step.step_no,
                approver_user_id=step.approver_user.id,
                approver_role=step.approver_role,
                status="pending",
                assigned_at=request.requested_at if step.step_no == request.current_step_no else None,
                escalation_count=0,
                resolved_from=step.resolved_from,
            )
        )

    db.flush()
    _notify_current_approval_step(db, request)
    return request


def decide_generic_approval_request(
    db: Session,
    *,
    approval_request_id: int,
    approver: User,
    decision: str,
    remarks: str = "",
) -> ApprovalRequest:
    normalized_decision = (decision or "").strip().lower()
    if normalized_decision not in {"approved", "rejected"}:
        raise HTTPException(status_code=400, detail="Decision must be 'approved' or 'rejected'.")

    request = (
        db.query(ApprovalRequest)
        .filter(ApprovalRequest.id == approval_request_id)
        .with_for_update()
        .first()
    )
    if not request:
        raise HTTPException(status_code=404, detail="Approval request not found.")
    if (request.status or "").strip().lower() != "pending":
        raise HTTPException(status_code=400, detail="Approval request is already closed.")

    # Authorise the approver BEFORE running repair so that repair cannot
    # reassign the current-step approver and invalidate the check.
    active_step = (
        db.query(ApprovalRequestStep)
        .filter(
            ApprovalRequestStep.approval_request_id == request.id,
            ApprovalRequestStep.step_no == request.current_step_no,
            ApprovalRequestStep.status == "pending",
        )
        .with_for_update()
        .first()
    )
    if not active_step:
        raise HTTPException(status_code=403, detail="You are not the active approver for this request.")

    # Only the user resolved for the active hierarchy step may decide it.
    if active_step.approver_user_id != approver.id:
        raise HTTPException(status_code=403, detail="You are not the active approver for this request.")

    # Run repair after authorisation so future steps stay consistent.
    repair_request_steps_from_rule(db, request)
    if (request.status or "").strip().lower() != "pending":
        db.flush()
        return request

    active_step.status = normalized_decision
    active_step.remarks = remarks or None
    active_step.acted_at = _utcnow()

    log_module_action(
        db=db, user_id=approver.id, module=request.module_key,
        action="approve" if normalized_decision == "approved" else "reject",
        record_id=request.record_id, ip="",
        description=f"{'Approved' if normalized_decision == 'approved' else 'Rejected'} "
                    f"{request.module_key} #{request.record_id} ({request.action_key})"
                    + (f" — {remarks}" if remarks else ""),
        new_data={"action_key": request.action_key, "remarks": remarks or None},
    )

    rule_step = db.query(ApprovalRuleStep).filter(
        ApprovalRuleStep.approval_rule_id == request.approval_rule_id,
        ApprovalRuleStep.step_no == active_step.step_no,
    ).first()

    if normalized_decision == "rejected":
        next_step = db.query(ApprovalRequestStep).filter(
            ApprovalRequestStep.approval_request_id == request.id,
            ApprovalRequestStep.step_no > active_step.step_no,
        ).order_by(ApprovalRequestStep.step_no.asc()).first()

        if not rule_step or rule_step.stop_on_reject or not next_step:
            request.status = "rejected"
            request.final_decided_at = _utcnow()
            db.flush()
            return request

        return _advance_request_to_step(db, request, next_step, progressed=True)

    next_step = db.query(ApprovalRequestStep).filter(
        ApprovalRequestStep.approval_request_id == request.id,
        ApprovalRequestStep.step_no > active_step.step_no,
    ).order_by(ApprovalRequestStep.step_no.asc()).first()

    if next_step:
        _advance_request_to_step(db, request, next_step, progressed=True)
    else:
        request.status = "approved"
        request.final_decided_at = _utcnow()

    db.flush()
    return request


def run_approval_escalation_maintenance_for_db(db: Session) -> dict[str, int]:
    ensure_generic_approval_schema(db)

    counts = {
        "escalated": 0,
        "last_step_waiting": 0,
        "waiting_without_sla": 0,
        "errors": 0,
    }

    setting = get_effective_approval_escalation_setting(db, None)
    if not setting or not bool(getattr(setting, "is_enabled", False)):
        logger.info("escalation_engine: disabled (is_enabled=False or no setting)")
        return counts

    pending_requests = (
        db.query(ApprovalRequest)
        .filter(
            ApprovalRequest.status == "pending",
            ApprovalRequest.current_step_no > 0,
        )
        .order_by(ApprovalRequest.requested_at.asc(), ApprovalRequest.id.asc())
        .all()
    )
    now = _utcnow()
    logger.info("escalation_engine: found %d pending request(s), now=%s", len(pending_requests), now)

    for request in pending_requests:
        try:
            repair_request_steps_from_rule(db, request)
            if (request.status or "").strip().lower() != "pending":
                logger.info("escalation_engine: request %s skipped (status changed to %s by repair)", request.id, request.status)
                db.commit()
                continue

            steps = sorted(
                db.query(ApprovalRequestStep)
                .filter(ApprovalRequestStep.approval_request_id == request.id)
                .all(),
                key=lambda item: item.step_no,
            )
            active_step = next(
                (
                    step
                    for step in steps
                    if step.step_no == request.current_step_no
                    and (step.status or "").strip().lower() == "pending"
                ),
                None,
            )
            if not active_step:
                logger.info("escalation_engine: request %s skipped (no active step at step_no=%s)", request.id, request.current_step_no)
                db.commit()
                continue

            next_step = next(
                (
                    step
                    for step in steps
                    if step.step_no > active_step.step_no
                    and (step.status or "").strip().lower() == "pending"
                ),
                None,
            )
            if not next_step:
                counts["last_step_waiting"] += 1
                logger.info("escalation_engine: request %s skipped (last step waiting)", request.id)
                db.commit()
                continue

            approver_role = normalize_role_key(getattr(active_step, "approver_role", None))
            if not approver_role:
                approver = active_step.approver or (
                    db.query(User)
                    .filter(User.id == active_step.approver_user_id)
                    .first()
                    if active_step.approver_user_id
                    else None
                )
                approver_role = normalize_role_key(getattr(approver, "role", None))

            _step_esc = getattr(active_step, "escalation_minutes", None)
            if _step_esc is not None and int(_step_esc) > 0:
                escalation_minutes = int(_step_esc)
            else:
                escalation_minutes = get_effective_approval_escalation_minutes(
                    db,
                    tenant_id=getattr(request, "tenant_id", None),
                    module_key=getattr(request, "module_key", None),
                    action_key=getattr(request, "action_key", None),
                    approver_role=approver_role,
                )
            logger.info(
                "escalation_engine: request %s step %s role=%s escalation_minutes=%s assigned_at=%s",
                request.id, active_step.step_no, approver_role, escalation_minutes, active_step.assigned_at,
            )
            if escalation_minutes is None or int(escalation_minutes) <= 0:
                counts["waiting_without_sla"] += 1
                db.commit()
                continue

            assigned_at = getattr(active_step, "assigned_at", None)
            if assigned_at is None:
                _activate_request_step(active_step)
                db.commit()
                continue

            due_at = assigned_at + timedelta(minutes=int(escalation_minutes))
            if due_at > now:
                logger.info("escalation_engine: request %s not due yet (due_at=%s, now=%s)", request.id, due_at, now)
                db.commit()
                continue

            active_step.status = "escalated"
            active_step.escalated_at = now
            active_step.escalation_count = int(getattr(active_step, "escalation_count", 0) or 0) + 1
            if not active_step.remarks:
                active_step.remarks = f"Escalated automatically after {int(escalation_minutes)} minute(s)."

            _advance_request_to_step(db, request, next_step, progressed=True)
            db.commit()
            counts["escalated"] += 1
        except Exception as exc:
            db.rollback()
            counts["errors"] += 1
            logger.warning(
                "approval_escalation: request %s failed: %s",
                getattr(request, "id", None),
                exc,
            )

    return counts


def run_approval_escalation_maintenance_for_all_tenants() -> dict[str, dict[str, int]]:
    master_db = MasterSessionLocal()
    results: dict[str, dict[str, int]] = {}
    try:
        tenants = (
            master_db.query(Tenant)
            .filter(Tenant.status.in_(["active", "trial"]))
            .all()
        )
        for tenant in tenants:
            try:
                tenant_db = get_tenant_session_by_db_name(tenant.db_name, cache_key=tenant.slug)
                try:
                    counts = run_approval_escalation_maintenance_for_db(tenant_db)
                    if any(int(value or 0) > 0 for value in counts.values()):
                        results[tenant.db_name] = counts
                finally:
                    tenant_db.close()
            except Exception as exc:
                logger.warning("approval_escalation: tenant %s error: %s", tenant.db_name, exc)
    finally:
        master_db.close()
    return results


def serialize_rule(rule: ApprovalRule) -> dict:
    steps = sorted(rule.steps or [], key=lambda item: item.step_no)
    approval_type = (getattr(rule, "approval_type", None) or "hierarchy").strip().lower()
    requester_type = normalize_requester_type(getattr(rule, "requester_type", None))
    requester_role = normalize_role_key(getattr(rule, "requester_role", None))
    return {
        "id": rule.id,
        "tenant_id": rule.tenant_id,
        "module_key": rule.module_key,
        "action_key": rule.action_key,
        "name": rule.name or f"{rule.module_key.title()} - {rule.action_key.replace('_', ' ').title()}",
        "approval_type": approval_type,
        "requester_type": requester_type,
        "requester_role": requester_role,
        "requester_user_id": rule.requester_user_id,
        "requester_user_name": rule.requester_user.full_name if rule.requester_user else None,
        "is_active": bool(rule.is_active),
        "created_at": rule.created_at.isoformat() if rule.created_at else None,
        "updated_at": rule.updated_at.isoformat() if rule.updated_at else None,
        "flow": "hierarchy" if approval_type == "hierarchy" else "sequential",
        "step_count": len(steps),
        "steps": [
            {
                "id": step.id,
                "step_no": step.step_no,
                "approver_type": step.approver_type,
                "approver_role": step.approver_role,
                "approver_user_id": step.approver_user_id,
                "approver_user_name": step.approver_user.full_name if step.approver_user else None,
                "approver_level": getattr(step, "approver_level", None),
                "is_required": bool(getattr(step, "is_required", True)),
                "stop_on_reject": bool(step.stop_on_reject),
                "escalation_minutes": getattr(step, "escalation_minutes", None),
                "created_at": step.created_at.isoformat() if step.created_at else None,
                "updated_at": step.updated_at.isoformat() if step.updated_at else None,
            }
            for step in steps
        ],
    }


def serialize_request(request: ApprovalRequest) -> dict:
    steps = sorted(request.steps or [], key=lambda item: item.step_no)
    return {
        "id": request.id,
        "tenant_id": request.tenant_id,
        "module_key": request.module_key,
        "action_key": request.action_key,
        "record_id": request.record_id,
        "approval_rule_id": request.approval_rule_id,
        "current_step_no": request.current_step_no,
        "status": request.status,
        "requested_by": request.requested_by,
        "requested_at": request.requested_at.isoformat() if request.requested_at else None,
        "final_decided_at": request.final_decided_at.isoformat() if request.final_decided_at else None,
        "steps": [
            {
                "id": step.id,
                "step_no": step.step_no,
                "approver_user_id": step.approver_user_id,
                "approver_name": step.approver.full_name if step.approver else None,
                "approver_role": step.approver_role,
                "status": step.status,
                "remarks": step.remarks,
                "acted_at": step.acted_at.isoformat() if step.acted_at else None,
                "resolved_from": step.resolved_from,
            }
            for step in steps
        ],
    }



# ─── Approvals v18: hook every new request (away delegation – My approval preferences) ───────────────────────
_create_generic_approval_request_core = create_generic_approval_request


def create_generic_approval_request(db, **kwargs):  # noqa: F811 – wraps the engine entry point defined above
    request = _create_generic_approval_request_core(db, **kwargs)
    try:
        from app.services.approvals360_service import after_request_created
        after_request_created(db, request)
    except Exception as exc:   # delegation is a convenience – never block the request itself
        logger.warning("approval away-delegation hook skipped: %s", exc)
    return request
