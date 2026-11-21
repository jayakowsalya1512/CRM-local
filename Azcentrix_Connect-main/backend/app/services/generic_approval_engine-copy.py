from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable, Optional

from fastapi import HTTPException
from sqlalchemy import func, inspect, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.models.all_models import (
    ApprovalRequest,
    ApprovalRequestStep,
    ApprovalRule,
    ApprovalRuleStep,
    Customer,
    CustomerContact,
    CustomerBillingConsignee,
    CustomerShippingConsignee,
    EMDBG,
    Lead,
    LeadProduct,
    LeadProductOEM,
    Role,
    Tender,
    TenderDocument,
    TenderProduct,
    TenderProductOEM,
    TravelRequest,
    User,
)

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
        ],
    },
    {
        "key": "emdbg",
        "label": "EMD / BG",
        "actions": [
            {"key": "release", "label": "Release"},
        ],
    },
    {
        "key": "travel",
        "label": "Travel",
        "actions": [
            {"key": "request", "label": "Request"},
        ],
    },
]

APPROVER_TYPE_OPTIONS = [
    {"key": "reporting_manager", "label": "Reporting Manager"},
    {"key": "role", "label": "Role"},
    {"key": "specific_user", "label": "Specific User"},
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

DEFAULT_HIERARCHY_ROLE_CHAIN = ("manager", "vp", "ceo")
MAX_REPORTING_CHAIN_DEPTH = 10
TOP_LEVEL_AUTO_APPROVAL_LEVEL = 1


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


def _utcnow() -> datetime:
    return datetime.utcnow()


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
    role_level = get_user_role_level(db, user)
    return role_level is not None and role_level <= TOP_LEVEL_AUTO_APPROVAL_LEVEL


def is_higher_authority_approver(
    db: Session,
    requester: User,
    approver: User,
) -> bool:
    requester_level = get_user_role_level(db, requester)
    approver_level = get_user_role_level(db, approver)

    if requester_level is None or approver_level is None:
        logger.warning(
            "Skipping non-comparable approval step: requester_id=%s requester_role=%s requester_level=%s approver_id=%s approver_role=%s approver_level=%s",
            getattr(requester, "id", None),
            getattr(requester, "role", None),
            requester_level,
            getattr(approver, "id", None),
            getattr(approver, "role", None),
            approver_level,
        )
        return False
    return approver_level < requester_level


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
    ApprovalRule.__table__.create(bind=bind, checkfirst=True)
    ApprovalRequest.__table__.create(bind=bind, checkfirst=True)
    ApprovalRuleStep.__table__.create(bind=bind, checkfirst=True)
    ApprovalRequestStep.__table__.create(bind=bind, checkfirst=True)

    inspector = inspect(bind)
    table_names = set(inspector.get_table_names())

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
                SET approver_type = COALESCE(NULLIF(approver_type, ''), 'reporting_manager')
                """
            ))
            conn.execute(text(
                """
                UPDATE approval_rules
                SET escalation_hours = COALESCE(escalation_hours, 48)
                """
            ))

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
        if "stop_on_reject" not in columns:
            statements.append("ALTER TABLE approval_rule_steps ADD COLUMN stop_on_reject TINYINT(1) NOT NULL DEFAULT 1")
        if "created_at" not in columns:
            statements.append("ALTER TABLE approval_rule_steps ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP")
        if statements:
            _execute_schema_statements(bind, statements)

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
        if "resolved_from" not in columns:
            statements.append("ALTER TABLE approval_request_steps ADD COLUMN resolved_from VARCHAR(100) NULL")
        if statements:
            _execute_schema_statements(bind, statements)


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


def get_approval_catalog() -> dict:
    return {
        "modules": APPROVAL_MODULES,
        "flow_types": FLOW_TYPE_OPTIONS,
        "approver_types": APPROVER_TYPE_OPTIONS,
        "approver_roles": APPROVER_ROLE_OPTIONS,
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


def repair_request_steps_from_rule(db: Session, request: ApprovalRequest) -> list[ApprovalRequestStep]:
    steps = sorted(request.steps or [], key=lambda item: item.step_no)
    if not request.approval_rule_id:
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

    approval_type = (getattr(rule, "approval_type", None) or "hierarchy").strip().lower()
    try:
        if approval_type == "hierarchy":
            expected_steps = filter_resolved_steps_for_request(
                db,
                requester,
                resolve_hierarchy_approval_steps(db, requester),
            )
        else:
            rule_steps = (
                db.query(ApprovalRuleStep)
                .filter(ApprovalRuleStep.approval_rule_id == rule.id)
                .order_by(ApprovalRuleStep.step_no.asc())
                .all()
            )
            expected_steps = resolve_rule_steps_for_request(db, requester, rule_steps)
    except HTTPException:
        logger.warning("Unable to repair approval request steps for request %s", request.id, exc_info=True)
        return steps

    expected_by_step_no = {step.step_no: step for step in expected_steps}
    retained_step_nos: set[int] = set()
    changed = False

    for step in steps:
        expected_step = expected_by_step_no.get(step.step_no)
        normalized_status = (step.status or "").strip().lower()

        if expected_step is None:
            if normalized_status == "pending":
                db.delete(step)
                changed = True
            continue

        retained_step_nos.add(step.step_no)

        if normalized_status != "pending":
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
        record = db.query(EMDBG).filter(EMDBG.id == request.record_id).first()
        if record:
            return f"EMDBG: {record.reference_num}"
        return f"EMDBG #{request.record_id}"
    if request.module_key == "travel":
        travel_request = db.query(TravelRequest).filter(TravelRequest.id == request.record_id).first()
        if travel_request:
            return f"Travel: {travel_request.request_number}"
        return f"Travel #{request.record_id}"
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

        def _ser_lead_product(product: LeadProduct) -> dict[str, Any]:
            oems = (
                db.query(LeadProductOEM)
                .filter(LeadProductOEM.lead_product_id == product.id)
                .order_by(LeadProductOEM.id.asc())
                .all()
            )
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

        def _ser_product(p: TenderProduct) -> dict:
            oems = db.query(TenderProductOEM).filter(TenderProductOEM.tender_product_id == p.id).all()
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
        step3 = None
        if 'workings' in (request.action_key or ''):
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
            step3 = {
                'corrigendum_document': t.corrigendum_document,
                'workings_document': t.workings_document,
                'final_products': final_products,
            }

        return {
            'type': 'tender',
            'tender_id': t.id,
            'tender_num': t.tender_num,
            'workflow_status': t.workflow_status or 'draft',
            'current_step': t.current_step or 1,
            'step1': step1,
            'step2': step2,
            'step3': step3,
            'step7': None,
            'documents': documents,
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
        return {
            "type": "travel",
            "request_number": travel_request.request_number,
            "purpose": travel_request.purpose,
            "from_city": travel_request.from_city,
            "to_city": travel_request.to_city,
            "status": travel_request.status,
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
                "acted_at": step.acted_at.isoformat() if step.acted_at else None,
                "resolved_from": step.resolved_from,
            }
            for step in steps
        ],
    }


def resolve_rule_step_approver(db: Session, requester: User, step: ApprovalRuleStep) -> ResolvedApprovalStep:
    if step.approver_type == "reporting_manager":
        if not requester.reporting_manager_id:
            raise HTTPException(status_code=400, detail="Requester has no reporting manager assigned.")
        approver = db.query(User).filter(
            User.id == requester.reporting_manager_id,
            User.is_active == True,
        ).first()
        if not approver:
            raise HTTPException(status_code=400, detail="Reporting manager is inactive or missing.")
        return ResolvedApprovalStep(
            step_no=step.step_no,
            approver_user=approver,
            approver_role=approver.role,
            resolved_from="reporting_manager",
            stop_on_reject=bool(step.stop_on_reject),
        )

    if step.approver_type == "role":
        role = (step.approver_role or "").strip().lower()
        if not role:
            raise HTTPException(status_code=400, detail=f"Step {step.step_no} is missing approver role.")

        # When a specific user is pinned to a role step, use them directly.
        if step.approver_user_id:
            approver = db.query(User).filter(
                User.id == step.approver_user_id,
                User.is_active == True,
            ).first()
            if not approver:
                raise HTTPException(
                    status_code=400,
                    detail=f"Pinned approver for step {step.step_no} is inactive or missing.",
                )
            return ResolvedApprovalStep(
                step_no=step.step_no,
                approver_user=approver,
                approver_role=role,
                resolved_from=f"role_pinned:{role}:{approver.id}",
                stop_on_reject=bool(step.stop_on_reject),
            )

        # No pinned user — pick the first active user with this role,
        # preferring someone in the requester's reporting chain.
        reporting_chain = _get_reporting_chain_users(db, requester)
        approver = next(
            (
                candidate
                for candidate in reporting_chain
                if (candidate.role or "").strip().lower() == role
            ),
            None,
        )
        resolved_from = f"reporting_chain_role:{role}" if approver else f"role:{role}"

        if not approver:
            approver = next(
                iter(_find_active_users_by_role(db, role, exclude_user_ids={requester.id})),
                None,
            )
        if not approver and (getattr(requester, "role", "") or "").strip().lower() == role:
            approver = requester
            resolved_from = f"self_role:{role}"
        if not approver:
            raise HTTPException(status_code=400, detail=f"No active user found for role '{role}'.")
        return ResolvedApprovalStep(
            step_no=step.step_no,
            approver_user=approver,
            approver_role=role,
            resolved_from=resolved_from,
            stop_on_reject=bool(step.stop_on_reject),
        )

    if step.approver_type == "specific_user":
        if not step.approver_user_id:
            raise HTTPException(status_code=400, detail=f"Step {step.step_no} is missing specific approver.")
        approver = db.query(User).filter(
            User.id == step.approver_user_id,
            User.is_active == True,
        ).first()
        if not approver:
            raise HTTPException(status_code=400, detail=f"Specific approver for step {step.step_no} is inactive or missing.")
        return ResolvedApprovalStep(
            step_no=step.step_no,
            approver_user=approver,
            approver_role=approver.role,
            resolved_from=f"specific_user:{approver.id}",
            stop_on_reject=bool(step.stop_on_reject),
        )

    raise HTTPException(status_code=400, detail=f"Unsupported approver type '{step.approver_type}'.")


def resolve_rule_steps_for_request(
    db: Session,
    requester: User,
    rule_steps: list[ApprovalRuleStep],
) -> list[ResolvedApprovalStep]:
    resolved_steps: list[ResolvedApprovalStep] = []
    for step in rule_steps:
        try:
            resolved_step = resolve_rule_step_approver(db, requester, step)
        except HTTPException as exc:
            if step.approver_type == "reporting_manager" and exc.status_code == 400:
                logger.info(
                    "Skipping reporting_manager step %s for requester %s: %s",
                    step.step_no,
                    getattr(requester, "id", None),
                    exc.detail,
                )
                continue
            raise

        if getattr(resolved_step.approver_user, "id", None) == getattr(requester, "id", None):
            logger.info(
                "Skipping approval step %s for requester %s because it resolves to self-approval",
                step.step_no,
                getattr(requester, "id", None),
            )
            continue

        # Sequential role/specific-user steps should honor the configured chain
        # exactly as defined. Only dynamic reporting-manager steps are pruned
        # using role-level hierarchy rules.
        if step.approver_type == "reporting_manager" and not is_higher_authority_approver(
            db,
            requester,
            resolved_step.approver_user,
        ):
            logger.info(
                "Skipping reporting_manager approval step %s for requester %s because approver role '%s' is not higher authority",
                step.step_no,
                getattr(requester, "id", None),
                getattr(resolved_step.approver_user, "role", None),
            )
            continue
        resolved_steps.append(resolved_step)
    return resolved_steps


def filter_resolved_steps_for_request(
    db: Session,
    requester: User,
    resolved_steps: list[ResolvedApprovalStep],
) -> list[ResolvedApprovalStep]:
    filtered_steps: list[ResolvedApprovalStep] = []
    for step in resolved_steps:
        if not is_higher_authority_approver(db, requester, step.approver_user):
            logger.info(
                "Skipping resolved approval step %s for requester %s because approver role '%s' is not higher authority",
                step.step_no,
                getattr(requester, "id", None),
                getattr(step.approver_user, "role", None),
            )
            continue
        filtered_steps.append(step)
    return filtered_steps


def _get_hierarchy_role_chain(requester: User) -> list[str]:
    requester_role = (getattr(requester, "role", "") or "").strip().lower()
    configured_chain = HIERARCHY_ROLE_CHAIN_BY_REQUESTER_ROLE.get(requester_role)
    if configured_chain is None:
        return list(DEFAULT_HIERARCHY_ROLE_CHAIN)
    return list(configured_chain)


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


def _resolve_hierarchy_role_approver(
    db: Session,
    *,
    requester: User,
    reporting_chain: list[User],
    target_role: str,
    used_user_ids: set[int],
) -> User:
    normalized_target_role = (target_role or "").strip().lower()
    if not normalized_target_role:
        raise HTTPException(status_code=400, detail="Hierarchy configuration contains an empty approver role.")

    for candidate in reporting_chain:
        if candidate.id in used_user_ids:
            continue
        if (candidate.role or "").strip().lower() == normalized_target_role:
            return candidate

    approver = (
        next(
            iter(
                _find_active_users_by_role(
                    db,
                    normalized_target_role,
                    exclude_user_ids=used_user_ids | {requester.id},
                )
            ),
            None,
        )
    )
    if approver and approver.id not in used_user_ids:
        return approver

    requester_role = (getattr(requester, "role", "") or "").strip().lower()
    if requester.id not in used_user_ids and requester_role == normalized_target_role:
        return requester

    raise HTTPException(
        status_code=400,
        detail=f"No active approver found for hierarchy role '{normalized_target_role}'.",
    )


def resolve_hierarchy_approval_steps(db: Session, requester: User) -> list[ResolvedApprovalStep]:
    hierarchy_chain = _get_hierarchy_role_chain(requester)
    if not hierarchy_chain:
        return []

    reporting_chain = _get_reporting_chain_users(db, requester)
    used_user_ids: set[int] = set()
    resolved_steps: list[ResolvedApprovalStep] = []

    for step_no, target_role in enumerate(hierarchy_chain, start=1):
        approver = _resolve_hierarchy_role_approver(
            db,
            requester=requester,
            reporting_chain=reporting_chain,
            target_role=target_role,
            used_user_ids=used_user_ids,
        )
        used_user_ids.add(approver.id)
        resolved_steps.append(
            ResolvedApprovalStep(
                step_no=step_no,
                approver_user=approver,
                approver_role=(approver.role or "").strip().lower(),
                resolved_from=f"hierarchy:{target_role}",
                stop_on_reject=True,
            )
        )

    return resolved_steps


def create_generic_approval_request(
    db: Session,
    *,
    tenant_id: Optional[int],
    requester: User,
    module_key: str,
    action_key: str,
    record_id: int,
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

    rule = db.query(ApprovalRule).filter(
        ApprovalRule.module_key == module_key,
        ApprovalRule.action_key == action_key,
        ApprovalRule.is_active == True,
    )
    if tenant_id is None:
        rule = rule.filter(ApprovalRule.tenant_id.is_(None))
    else:
        rule = rule.filter(ApprovalRule.tenant_id == tenant_id)
    rule = rule.order_by(ApprovalRule.id.asc()).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Approval rule not configured for this module/action.")

    approval_type = (getattr(rule, "approval_type", None) or "hierarchy").strip().lower()
    if is_top_level_auto_approval_requester(db, requester):
        request = ApprovalRequest(
            tenant_id=tenant_id,
            module_key=module_key,
            action_key=action_key,
            record_id=record_id,
            approval_rule_id=rule.id,
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

    if approval_type == "hierarchy":
        resolved_steps = filter_resolved_steps_for_request(
            db,
            requester,
            resolve_hierarchy_approval_steps(db, requester),
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
        resolved_steps = resolve_rule_steps_for_request(db, requester, rule_steps)

    if not resolved_steps:
        request = ApprovalRequest(
            tenant_id=tenant_id,
            module_key=module_key,
            action_key=action_key,
            record_id=record_id,
            approval_rule_id=rule.id,
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
        approval_rule_id=rule.id,
        current_step_no=resolved_steps[0].step_no,
        status="pending",
        requested_by=requester.id,
        requested_at=_utcnow(),
        approver_user_ids=[step.approver_user.id for step in resolved_steps],
        approval_mode=approval_type,
    )
    db.add(request)
    db.flush()

    for step in resolved_steps:
        db.add(
            ApprovalRequestStep(
                approval_request_id=request.id,
                step_no=step.step_no,
                approver_user_id=step.approver_user.id,
                approver_role=step.approver_role,
                status="pending",
                resolved_from=step.resolved_from,
            )
        )

    db.flush()
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

    repair_request_steps_from_rule(db, request)
    if (request.status or "").strip().lower() != "pending":
        db.flush()
        return request

    active_step = (
        db.query(ApprovalRequestStep)
        .filter(
            ApprovalRequestStep.approval_request_id == request.id,
            ApprovalRequestStep.step_no == request.current_step_no,
            ApprovalRequestStep.approver_user_id == approver.id,
        )
        .with_for_update()
        .first()
    )
    if not active_step:
        raise HTTPException(status_code=403, detail="You are not the active approver for this request.")

    active_step.status = normalized_decision
    active_step.remarks = remarks or None
    active_step.acted_at = _utcnow()

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

        request.current_step_no = next_step.step_no
        db.flush()
        return request

    next_step = db.query(ApprovalRequestStep).filter(
        ApprovalRequestStep.approval_request_id == request.id,
        ApprovalRequestStep.step_no > active_step.step_no,
    ).order_by(ApprovalRequestStep.step_no.asc()).first()

    if next_step:
        request.current_step_no = next_step.step_no
    else:
        request.status = "approved"
        request.final_decided_at = _utcnow()

    db.flush()
    return request


def serialize_rule(rule: ApprovalRule) -> dict:
    steps = sorted(rule.steps or [], key=lambda item: item.step_no)
    approval_type = (getattr(rule, "approval_type", None) or "hierarchy").strip().lower()
    return {
        "id": rule.id,
        "tenant_id": rule.tenant_id,
        "module_key": rule.module_key,
        "action_key": rule.action_key,
        "name": rule.name or f"{rule.module_key.title()} - {rule.action_key.replace('_', ' ').title()}",
        "approval_type": approval_type,
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
                "stop_on_reject": bool(step.stop_on_reject),
                "created_at": step.created_at.isoformat() if step.created_at else None,
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
