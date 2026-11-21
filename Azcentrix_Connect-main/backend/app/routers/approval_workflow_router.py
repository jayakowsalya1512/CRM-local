import logging
from datetime import datetime
from app.core.timezone import now_ist, today_ist
from typing import Any, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import or_, text as sa_text
from sqlalchemy.orm import Session, selectinload

from app.core import validators as V
from app.core.logging import log_module_action
from app.dependencies import get_current_user, get_request_ip, get_tenant_db
from app.models.all_models import ApprovalAutoApproveSetting, ApprovalEscalationRule, ApprovalEscalationSetting, ApprovalRequest, ApprovalRequestStep, ApprovalRule, ApprovalRuleStep, Customer, EMDBG, Group, OrgTreeNode, Tender, TravelRequest, User
from app.services.dynamic_notification_service import emit_notification_event
from app.services.generic_approval_engine import (
    APPROVAL_MODULES,
    decide_generic_approval_request,
    ensure_generic_approval_schema,
    get_effective_approval_escalation_setting,
    get_approval_catalog,
    get_role_options,
    normalize_role_key,
    normalize_requester_type,
    run_approval_escalation_maintenance_for_db,
    serialize_auto_approve_setting,
    serialize_escalation_rule,
    serialize_escalation_setting,
    serialize_request_for_ui,
    serialize_rule,
)
from app.services.travel_approval_service import sync_travel_request_from_generic_approval

logger = logging.getLogger(__name__)
router = APIRouter()

MANAGE_APPROVAL_ROLES = {"manager", "ceo", "admin"}


def _utcnow():
    return now_ist()


class ApprovalRuleStepInput(BaseModel):
    step_no: int = Field(..., ge=1)
    approver_type: Literal["reporting_manager", "role", "specific_user", "hierarchy_level"]
    approver_role: Optional[str] = None
    approver_user_id: Optional[int] = None
    approver_level: Optional[int] = None
    is_required: bool = True
    stop_on_reject: bool = True


class ApprovalRuleModuleActionPairInput(BaseModel):
    module_key: str
    action_key: str


class ApprovalRuleUpsertInput(BaseModel):
    module_key: Optional[str] = None
    action_key: Optional[str] = None
    module_keys: List[str] = Field(default_factory=list)
    action_keys: List[str] = Field(default_factory=list)
    module_action_pairs: List[ApprovalRuleModuleActionPairInput] = Field(default_factory=list)
    name: str = ""
    requester_type: Literal["role", "specific_user", "group"]
    requester_role: Optional[str] = None
    requester_roles: List[str] = Field(default_factory=list)
    requester_user_id: Optional[int] = None
    requester_user_ids: List[int] = Field(default_factory=list)
    requester_group_id: Optional[int] = None
    requester_group_ids: List[int] = Field(default_factory=list)
    approval_type: Literal["hierarchy", "sequential"] = "sequential"
    is_active: bool = True
    steps: List[ApprovalRuleStepInput] = Field(default_factory=list)

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, v: Any) -> str:
        # optional (auto-generated when blank) but never whitespace-only / overlong
        if v is not None and str(v) != "" and not str(v).strip():
            raise ValueError("Rule name cannot be blank or only spaces.")
        return V.check_text(v, "Rule name", 3, 150) or ""


class ApprovalRuleStatusInput(BaseModel):
    is_active: bool


# Escalation time limits: 1 minute .. 1 year (UI asks in hours, max 8760).
_MAX_ESCALATION_MINUTES = 525600


def _check_escalation_minutes(v: Optional[int], required: bool = False) -> Optional[int]:
    if v is None:
        if required:
            raise ValueError("Escalation time is required.")
        return None
    if v < 0:
        raise ValueError("Escalation time cannot be negative.")
    if v > _MAX_ESCALATION_MINUTES:
        raise ValueError("Escalation time cannot exceed 8760 hours (1 year).")
    return v


class ApprovalEscalationSettingsInput(BaseModel):
    is_enabled: bool
    default_escalation_minutes: Optional[int] = Field(default=None, ge=1)

    @field_validator("default_escalation_minutes")
    @classmethod
    def _mins(cls, v: Optional[int]) -> Optional[int]:
        return _check_escalation_minutes(v)


class ApprovalEscalationRuleInput(BaseModel):
    module_key: str
    action_key: str
    approver_role: str
    escalation_minutes: int = Field(..., ge=1)
    is_active: bool = True


class ApprovalEscalationRuleStatusInput(BaseModel):
    is_active: bool


class ApprovalAutoApproveSettingInput(BaseModel):
    module_key: str
    action_key: str
    is_enabled: bool


class GenericApprovalRequestInput(BaseModel):
    module_key: str
    action_key: str
    record_id: int = Field(..., gt=0)
    group_id: Optional[int] = None


class ApprovalDecisionInput(BaseModel):
    decision: Literal["approved", "rejected"]
    remarks: str = ""


def _ensure_can_manage_approvals(current_user: User) -> None:
    if (current_user.role or "").strip().lower() not in MANAGE_APPROVAL_ROLES:
        raise HTTPException(status_code=403, detail="You do not have permission to manage approval rules.")


def _get_tenant_id(request: Request) -> Optional[int]:
    tenant = getattr(request.state, "tenant", None)
    tenant_id = getattr(tenant, "id", None)
    return int(tenant_id) if isinstance(tenant_id, int) else tenant_id


def _scoped_approval_rule_query(db: Session, tenant_id: Optional[int]):
    query = db.query(ApprovalRule)
    if tenant_id is None:
        return query.filter(ApprovalRule.tenant_id.is_(None))
    return query.filter(ApprovalRule.tenant_id == tenant_id)


def _scoped_approval_escalation_rule_query(
    db: Session,
    tenant_id: Optional[int],
    *,
    include_fallback: bool = False,
):
    query = db.query(ApprovalEscalationRule)
    if tenant_id is None:
        return query.filter(ApprovalEscalationRule.tenant_id.is_(None))
    if include_fallback:
        return query.filter(
            or_(
                ApprovalEscalationRule.tenant_id == tenant_id,
                ApprovalEscalationRule.tenant_id.is_(None),
            )
        )
    return query.filter(ApprovalEscalationRule.tenant_id == tenant_id)


def _load_scoped_approval_escalation_setting(
    db: Session,
    tenant_id: Optional[int],
) -> Optional[ApprovalEscalationSetting]:
    if tenant_id is not None:
        exact = (
            db.query(ApprovalEscalationSetting)
            .filter(ApprovalEscalationSetting.tenant_id == tenant_id)
            .order_by(ApprovalEscalationSetting.id.asc())
            .first()
        )
        if exact:
            return exact
    return (
        db.query(ApprovalEscalationSetting)
        .filter(ApprovalEscalationSetting.tenant_id.is_(None))
        .order_by(ApprovalEscalationSetting.id.asc())
        .first()
    )


def _scoped_approval_auto_approve_setting_query(
    db: Session,
    tenant_id: Optional[int],
    *,
    include_fallback: bool = False,
):
    query = db.query(ApprovalAutoApproveSetting)
    if tenant_id is None:
        return query.filter(ApprovalAutoApproveSetting.tenant_id.is_(None))
    if include_fallback:
        return query.filter(
            or_(
                ApprovalAutoApproveSetting.tenant_id == tenant_id,
                ApprovalAutoApproveSetting.tenant_id.is_(None),
            )
        )
    return query.filter(ApprovalAutoApproveSetting.tenant_id == tenant_id)


def _normalize_escalation_rule_input(
    payload: ApprovalEscalationRuleInput,
) -> tuple[str, str, str, int]:
    module_key = (payload.module_key or "").strip().lower()
    action_key = (payload.action_key or "").strip().lower()
    approver_role = normalize_role_key(payload.approver_role)
    escalation_minutes = int(payload.escalation_minutes or 0)

    if not module_key:
        raise HTTPException(status_code=400, detail="Module is required.")
    if not action_key:
        raise HTTPException(status_code=400, detail="Action is required.")
    if not approver_role:
        raise HTTPException(status_code=400, detail="Approver role is required.")
    if escalation_minutes <= 0:
        raise HTTPException(status_code=400, detail="Escalation time must be greater than zero.")

    return module_key, action_key, approver_role, escalation_minutes


def _save_approval_escalation_rule(
    db: Session,
    *,
    tenant_id: Optional[int],
    existing_rule: Optional[ApprovalEscalationRule],
    module_key: str,
    action_key: str,
    approver_role: str,
    escalation_minutes: int,
    is_active: bool,
) -> ApprovalEscalationRule:
    duplicate_query = _scoped_approval_escalation_rule_query(
        db,
        tenant_id,
        include_fallback=tenant_id is not None,
    ).filter(
        ApprovalEscalationRule.module_key == module_key,
        ApprovalEscalationRule.action_key == action_key,
        ApprovalEscalationRule.approver_role == approver_role,
    )
    if existing_rule is not None:
        duplicate_query = duplicate_query.filter(ApprovalEscalationRule.id != existing_rule.id)

    duplicate_rule = duplicate_query.order_by(ApprovalEscalationRule.id.asc()).first()
    if duplicate_rule and not (tenant_id is not None and duplicate_rule.tenant_id is None):
        raise HTTPException(
            status_code=409,
            detail="An escalation rule already exists for this module, action, and role.",
        )

    rule = existing_rule or duplicate_rule or ApprovalEscalationRule()
    rule.tenant_id = tenant_id
    rule.module_key = module_key
    rule.action_key = action_key
    rule.approver_role = approver_role
    rule.escalation_minutes = escalation_minutes
    rule.is_active = bool(is_active)
    if existing_rule is None and getattr(rule, "created_at", None) is None:
        rule.created_at = _utcnow()
    rule.updated_at = _utcnow()

    if existing_rule is None and getattr(rule, "id", None) is None:
        db.add(rule)

    db.flush()
    return rule


def _load_active_groups_for_meta(db: Session) -> list[dict]:
    """Groups (org-tree L2 nodes) available as a policy's requester scope, each with its current head — so the
    policy builder can show, up front, when one person already heads several of the groups being picked."""
    try:
        rows = db.execute(
            sa_text(
                """
                SELECT n.id, n.group_name AS name, n.group_lead_id AS lead_id, u.full_name AS lead_name
                FROM org_tree_nodes n
                LEFT JOIN users u ON u.id = n.group_lead_id
                WHERE n.level = 2
                  AND n.group_name IS NOT NULL
                  AND n.group_name <> ''
                  AND COALESCE(n.is_active, 1) = 1
                ORDER BY n.group_name ASC, n.id ASC
                """
            )
        ).mappings().all()
        return [
            {
                "id": int(row["id"]),
                "name": row["name"],
                "lead_id": int(row["lead_id"]) if row.get("lead_id") is not None else None,
                "lead_name": row.get("lead_name") or None,
            }
            for row in rows
            if row.get("id") is not None and row.get("name")
        ]
    except Exception:
        return []


def _emit_customer_approval_event(
    db: Session,
    *,
    customer: Customer,
    event_key: str,
    actor: Optional[User],
    approver_user_id: Optional[int] = None,
    reason: str = "",
) -> None:
    try:
        emit_notification_event(
            db,
            module_key="customers",
            event_key=event_key,
            record_id=customer.id,
            actor_user_id=getattr(actor, "id", None),
            context={
                "customer_id": customer.id,
                "customer_name": getattr(customer, "customer_name", "") or "",
                "account_status": getattr(customer, "account_status", "") or "",
                "creator_user_id": getattr(customer, "created_by", None),
                "approver_user_id": approver_user_id if approver_user_id is not None else getattr(actor, "id", None),
                "requester_user_id": getattr(customer, "created_by", None),
                "reason": reason or "",
                "record_ref": getattr(customer, "customer_name", "") or "",
            },
        )
    except Exception as exc:
        logger.warning("dynamic customer approval notification failed for customer=%s event=%s: %s", customer.id, event_key, exc)


def _apply_dynamic_request_side_effects(
    db: Session,
    *,
    request: ApprovalRequest,
    actor: User,
    remarks: str = "",
) -> None:
    normalized_status = (request.status or "").strip().lower()
    active_step = next(
        (
            step
            for step in sorted(request.steps or [], key=lambda item: item.step_no)
            if step.step_no == request.current_step_no
        ),
        None,
    )

    if request.module_key == "customer" and request.action_key == "create":
        customer = db.query(Customer).filter(Customer.id == request.record_id).first()
        if not customer:
            return
        if normalized_status == "approved":
            customer.is_active = True
            customer.approval_status = "approved"
            _emit_customer_approval_event(
                db,
                customer=customer,
                event_key="approved",
                actor=actor,
            )
        elif normalized_status == "rejected":
            customer.is_active = False
            customer.approval_status = "rejected"
            _emit_customer_approval_event(
                db,
                customer=customer,
                event_key="rejected",
                actor=actor,
                reason=remarks,
            )
        else:
            customer.is_active = False
            customer.approval_status = "pending"
            _emit_customer_approval_event(
                db,
                customer=customer,
                event_key="approval_requested",
                actor=actor,
                approver_user_id=getattr(active_step, "approver_user_id", None),
            )
        return

    if request.module_key == "deal" and request.action_key == "stage":
        # Deals: apply (approved) or release (rejected) the stage move held for approval.
        from app.services.deal_service import on_stage_decision
        on_stage_decision(db, request, actor, remarks)
        return

    if request.module_key == "work_order" and request.action_key == "stage":
        # Orders & Projects: apply (approved) or release (rejected) the lifecycle stage move held for approval.
        from app.services.order_service import on_stage_decision as on_order_stage_decision
        on_order_stage_decision(db, request, actor, remarks)
        return

    if request.module_key == "forecast" and request.action_key == "submit":
        # Forecasts: mark the submitted forecast snapshot approved / rejected and notify the submitter.
        from app.services.forecast_service import on_decision as on_forecast_decision
        on_forecast_decision(db, request, actor, remarks)
        return

    if request.module_key == "price_book":
        # Product & Price Books: apply (approved) or drop (rejected) a held book discount / product price override.
        from app.services.product_service import on_decision as on_price_book_decision
        on_price_book_decision(db, request, actor, remarks)
        return

    if request.module_key == "product":
        # Product & Price Books: apply / drop a held record-status approval or change window on a locked product.
        from app.services.product_model_service import on_decision as on_product_decision
        on_product_decision(db, request, actor, remarks)
        return

    if request.module_key == "quotation" and request.action_key == "stage":
        # Quotes: apply (approved) or release (rejected) the lifecycle stage move held for approval.
        from app.services.quote_service import on_stage_decision as on_quote_stage_decision
        on_quote_stage_decision(db, request, actor, remarks)
        return

    if request.module_key == "lead" and request.action_key == "convert":
        from app.routers.lead_router import _create_tender_from_lead, _dispatch_lead_event, _next_tender_ref_id
        from app.models.all_models import Lead

        lead = db.query(Lead).filter(Lead.id == request.record_id).first()
        if not lead:
            return

        if normalized_status == "approved":
            target = getattr(lead, "conversion_target", None) or "tender"
            if target == "quotation":
                already_converted = lead.status == "Converted" and lead.approval_status == "approved"
                lead.converted_tender_id = None
                lead.conversion_target = "quotation"
                if not already_converted:
                    _dispatch_lead_event(
                        db,
                        lead=lead,
                        event_key="status_won",
                        title="Lead Won",
                        message=f"Lead '{lead.lead_title}' was converted directly to Quotation by {actor.full_name}.",
                        actor_user_id=actor.id,
                    )
            elif not getattr(lead, "converted_tender_id", None):
                tender_num = _next_tender_ref_id(db)
                tender = _create_tender_from_lead(db, lead, tender_num, actor)
                lead.converted_tender_id = tender.id
                lead.conversion_target = "tender"
                _dispatch_lead_event(
                    db,
                    lead=lead,
                    event_key="status_won",
                    title="Lead Won",
                    message=f"Lead '{lead.lead_title}' was converted to Tender {tender_num} by {actor.full_name}.",
                    actor_user_id=actor.id,
                )
            lead.status = "Converted"
            lead.approval_status = "approved"
            lead.converted_at = _utcnow()
            lead.rejection_reason = None
        elif normalized_status == "rejected":
            lead.approval_status = "rejected"
            lead.rejection_reason = remarks or None
        else:
            lead.approval_status = "pending"
        return

    if request.module_key == "tender" and request.action_key in ("stage", "price_bid"):
        # Bids & Tenders: apply / release a held stage move, or record the price-bid decision.
        from app.services.bid_service import on_price_decision, on_stage_decision as on_tender_stage_decision
        (on_tender_stage_decision if request.action_key == "stage" else on_price_decision)(db, request, actor, remarks)
        return

    if request.module_key == "tender":
        tender = db.query(Tender).filter(Tender.id == request.record_id).first()
        if not tender:
            return

        if request.action_key == "tender_details":
            if normalized_status == "approved":
                tender.workflow_status = "active"
                tender.listed_in_accounts = True
                if hasattr(tender, "step2_approved_at"):
                    tender.step2_approved_at = _utcnow()
            elif normalized_status == "rejected":
                tender.workflow_status = "rejected"
            else:
                tender.workflow_status = "step2_pending"
            return

        if request.action_key == "workings":
            if normalized_status == "approved":
                tender.workflow_status = "step3_active"
                tender.tender_status = "Submitted"
                tender.listed_in_accounts = True
                if hasattr(tender, "step3_approved_at"):
                    tender.step3_approved_at = _utcnow()
            elif normalized_status == "rejected":
                tender.workflow_status = "active"
            else:
                tender.workflow_status = "step3_pending"
            return

        if request.action_key == "po_details":
            if normalized_status == "approved":
                tender.po_workflow_status = "approved"
            elif normalized_status == "rejected":
                tender.po_workflow_status = "draft"
            else:
                tender.po_workflow_status = "pending_approval"
            return

    if request.module_key == "emdbg" and request.action_key in ("request", "request_50l", "release_request", "extend"):
        # Guarantees & Deposits v18: head approval → With Finance / Rejected; refund / release request → Release
        # Requested / rejected; validity extension applied / rejected.
        from app.services.instrument_service import on_decision as on_instrument_decision
        on_instrument_decision(db, request, actor, remarks)
        return

    if request.module_key == "emdbg":
        record = db.query(EMDBG).filter(EMDBG.id == request.record_id).first()
        if not record:
            return

        if normalized_status == "approved":
            record.approval_status = "approved"
            if hasattr(record, "last_rejection_reason"):
                record.last_rejection_reason = None
        elif normalized_status == "rejected":
            record.approval_status = "rejected"
            if hasattr(record, "last_rejection_reason"):
                record.last_rejection_reason = remarks or None
        else:
            record.approval_status = "pending"
        return

    if request.module_key == "travel" and request.action_key == "request":
        sync_travel_request_from_generic_approval(
            db,
            approval_request=request,
            actor=actor,
            remarks=remarks,
        )

    if request.module_key == "quotation" and request.action_key == "submit":
        from app.models.all_models import Quotation
        q = db.query(Quotation).filter(Quotation.id == request.record_id).first()
        if not q:
            return
        if normalized_status == "approved":
            q.approval_status = "approved"
            q.status = "Accepted"   # directly accepted → unlocks PO tab
        elif normalized_status == "rejected":
            q.approval_status = "rejected"
        else:
            q.approval_status = "pending"


def _normalize_step_inputs(step_inputs: List[ApprovalRuleStepInput]) -> List[ApprovalRuleStepInput]:
    normalized = sorted(step_inputs, key=lambda item: item.step_no)
    result: List[ApprovalRuleStepInput] = []
    for index, step in enumerate(normalized, start=1):
        approver_role = normalize_role_key(step.approver_role)
        if step.approver_type == "role" and not approver_role:
            raise HTTPException(status_code=400, detail=f"Step {index}: role approver is required.")
        if step.approver_type == "specific_user" and not step.approver_user_id:
            raise HTTPException(status_code=400, detail=f"Step {index}: specific user is required.")
        if step.approver_type == "hierarchy_level" and not step.approver_level:
            raise HTTPException(status_code=400, detail=f"Step {index}: org hierarchy level is required.")
        result.append(
            ApprovalRuleStepInput(
                step_no=index,
                approver_type=step.approver_type,
                approver_role=approver_role,
                approver_user_id=step.approver_user_id,
                approver_level=step.approver_level,
                is_required=bool(step.is_required),
                stop_on_reject=bool(step.stop_on_reject),
            )
        )
    return result


def _normalize_key_list(values: List[str], fallback: Optional[str] = None) -> List[str]:
    result: List[str] = []
    seen: set[str] = set()
    source_values = list(values or [])
    if fallback:
        source_values.append(fallback)

    for value in source_values:
        normalized = (value or "").strip().lower()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def _normalize_int_list(values: List[Any], fallback: Optional[int] = None) -> List[int]:
    result: List[int] = []
    seen: set[int] = set()
    source_values = list(values or [])
    if fallback is not None:
        source_values.append(fallback)

    for value in source_values:
        try:
            normalized = int(value)
        except (TypeError, ValueError):
            continue
        if normalized <= 0 or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def _normalize_requester_inputs(
    payload: ApprovalRuleUpsertInput,
) -> tuple[str, Optional[str], Optional[int], Optional[int], List[str], List[int], List[int]]:
    requester_type = normalize_requester_type(payload.requester_type)
    if not requester_type:
        raise HTTPException(status_code=400, detail="Requester type is required.")

    requester_role = normalize_role_key(payload.requester_role)
    requester_user_id = payload.requester_user_id
    requester_group_id = payload.requester_group_id
    requester_roles = [role for role in (normalize_role_key(value) for value in payload.requester_roles) if role]
    requester_user_ids = _normalize_int_list(payload.requester_user_ids, requester_user_id)
    requester_group_ids = _normalize_int_list(payload.requester_group_ids, requester_group_id)

    if requester_type == "role":
        normalized_roles = _normalize_key_list(requester_roles, requester_role)
        if not normalized_roles:
            raise HTTPException(status_code=400, detail="Requester role is required for role-based rules.")
        requester_role = normalized_roles[0]
        requester_roles = normalized_roles
        requester_user_id = None
        requester_group_id = None
        requester_user_ids = []
        requester_group_ids = []
    elif requester_type == "specific_user":
        if not requester_user_ids:
            raise HTTPException(status_code=400, detail="Requester user is required for specific-user rules.")
        requester_role = None
        requester_user_id = requester_user_ids[0]
        requester_group_id = None
        requester_roles = []
        requester_group_ids = []
    else:
        if not requester_group_ids:
            raise HTTPException(status_code=400, detail="Requester group is required for group rules.")
        requester_role = None
        requester_user_id = None
        requester_group_id = requester_group_ids[0]
        requester_roles = []
        requester_user_ids = []

    return (
        requester_type,
        requester_role,
        requester_user_id,
        requester_group_id,
        requester_roles,
        requester_user_ids,
        requester_group_ids,
    )


def _save_rule(
    db: Session,
    *,
    tenant_id: Optional[int],
    existing_rule: Optional[ApprovalRule],
    module_key: str,
    action_key: str,
    name: str,
    requester_type: str,
    requester_role: Optional[str],
    requester_user_id: Optional[int],
    requester_group_id: Optional[int],
    approval_type: str,
    is_active: bool,
    steps: List[ApprovalRuleStepInput],
) -> ApprovalRule:
    duplicate_query = db.query(ApprovalRule).filter(
        ApprovalRule.module_key == module_key,
        ApprovalRule.action_key == action_key,
        ApprovalRule.requester_type == requester_type,
    )
    if tenant_id is None:
        duplicate_query = duplicate_query.filter(ApprovalRule.tenant_id.is_(None))
    else:
        duplicate_query = duplicate_query.filter(ApprovalRule.tenant_id == tenant_id)
    if requester_type == "role":
        duplicate_query = duplicate_query.filter(ApprovalRule.requester_role == requester_role)
    elif requester_type == "specific_user":
        duplicate_query = duplicate_query.filter(ApprovalRule.requester_user_id == requester_user_id)
    elif requester_type == "group":
        duplicate_query = duplicate_query.filter(ApprovalRule.requester_group_id == requester_group_id)
    if existing_rule is not None:
        duplicate_query = duplicate_query.filter(ApprovalRule.id != existing_rule.id)
    if duplicate_query.first():
        raise HTTPException(status_code=409, detail="A rule already exists for this module, action, and requester condition.")

    rule = existing_rule or ApprovalRule()
    rule.tenant_id = tenant_id
    rule.module_key = module_key
    rule.action_key = action_key
    rule.name = name
    rule.approval_type = approval_type
    rule.requester_type = requester_type
    rule.requester_role = requester_role
    rule.requester_user_id = requester_user_id
    rule.requester_group_id = requester_group_id
    rule.is_active = bool(is_active)
    if existing_rule is None and not rule.created_at:
        rule.created_at = _utcnow()
    rule.updated_at = _utcnow()

    if approval_type == "sequential":
        if not steps:
            raise HTTPException(status_code=400, detail="At least one approval step is required for sequential approvals.")
        first_step = steps[0]
        rule.approver_type = first_step.approver_type
        rule.approver_role = first_step.approver_role
        rule.approver_user_id = first_step.approver_user_id
    else:
        rule.approver_type = "reporting_manager"
        rule.approver_role = None
        rule.approver_user_id = None

    if existing_rule is None:
        db.add(rule)
        db.flush()

    db.query(ApprovalRuleStep).filter(ApprovalRuleStep.approval_rule_id == rule.id).delete()

    if steps:
        for step in steps:
            db.add(
                ApprovalRuleStep(
                    approval_rule_id=rule.id,
                    step_no=step.step_no,
                    approver_type=step.approver_type,
                    approver_role=step.approver_role,
                    approver_user_id=step.approver_user_id,
                    approver_level=step.approver_level,
                    is_required=bool(step.is_required),
                    stop_on_reject=step.stop_on_reject,
                    updated_at=_utcnow(),
                )
            )

    db.flush()
    db.refresh(rule)
    return rule


def _humanize_key(value: str) -> str:
    return str(value or "").replace("_", " ").strip().title()


def _build_rule_name(
    db: Session,
    *,
    base_name: str,
    module_key: str,
    action_key: str,
    requester_type: str,
    requester_role: Optional[str],
    requester_user_id: Optional[int],
    requester_group_id: Optional[int],
    append_requester_label: bool,
) -> str:
    module_label = _humanize_key(module_key)
    action_label = _humanize_key(action_key)

    if requester_type == "role" and requester_role:
        requester_label = _humanize_key(requester_role)
    elif requester_type == "specific_user" and requester_user_id:
        requester_user = db.query(User).filter(User.id == requester_user_id).first()
        requester_label = requester_user.full_name if requester_user else f"User {requester_user_id}"
    elif requester_type == "group" and requester_group_id:
        org_node = db.query(OrgTreeNode).filter(OrgTreeNode.id == requester_group_id, OrgTreeNode.level == 2).first()
        requester_label = getattr(org_node, "group_name", None) or f"Group {requester_group_id}"
    else:
        requester_label = _humanize_key(requester_type)

    trimmed_base_name = (base_name or "").strip()
    if trimmed_base_name:
        return f"{trimmed_base_name} - {requester_label}" if append_requester_label else trimmed_base_name
    return f"{module_label} - {action_label} - {requester_label}"


def _normalize_module_action_pairs(
    pairs: List[ApprovalRuleModuleActionPairInput],
) -> List[tuple[str, str]]:
    result: List[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for pair in pairs or []:
        module_key = (pair.module_key or "").strip().lower()
        action_key = (pair.action_key or "").strip().lower()
        if not module_key or not action_key:
            continue
        key = (module_key, action_key)
        if key in seen:
            continue
        seen.add(key)
        result.append(key)
    return result


def _expand_rule_payload(
    payload: ApprovalRuleUpsertInput,
) -> tuple[
    List[str],
    List[str],
    Optional[List[tuple[str, str]]],
    str,
    Optional[str],
    Optional[int],
    Optional[int],
    List[str],
    List[int],
    List[int],
    str,
    bool,
    List[ApprovalRuleStepInput],
    str,
]:
    approval_type = (payload.approval_type or "sequential").strip().lower()
    steps = _normalize_step_inputs(payload.steps) if payload.steps else []
    module_action_pairs = _normalize_module_action_pairs(payload.module_action_pairs)
    if module_action_pairs:
        module_keys = _normalize_key_list([m for m, _ in module_action_pairs])
        action_keys = _normalize_key_list([a for _, a in module_action_pairs])
    else:
        module_keys = _normalize_key_list(payload.module_keys, payload.module_key)
        action_keys = _normalize_key_list(payload.action_keys, payload.action_key)
    if not module_keys:
        raise HTTPException(status_code=400, detail="Select at least one module.")
    if not action_keys:
        raise HTTPException(status_code=400, detail="Select at least one action.")

    (
        requester_type,
        requester_role,
        requester_user_id,
        requester_group_id,
        requester_roles,
        requester_user_ids,
        requester_group_ids,
    ) = _normalize_requester_inputs(payload)

    return (
        module_keys,
        action_keys,
        module_action_pairs or None,
        requester_type,
        requester_role,
        requester_user_id,
        requester_group_id,
        requester_roles,
        requester_user_ids,
        requester_group_ids,
        approval_type,
        bool(payload.is_active),
        steps,
        (payload.name or "").strip(),
    )


def _serialize_rule_for_ui(rule: ApprovalRule, db: Optional[Session] = None, *, _org_node_map: Optional[dict] = None) -> dict:
    data = serialize_rule(rule)
    group_id = getattr(rule, "requester_group_id", None)
    data["requester_group_id"] = group_id
    group_name = None
    if group_id:
        if _org_node_map is not None:
            org_node = _org_node_map.get(group_id)
            group_name = getattr(org_node, "group_name", None)
        elif db is not None:
            try:
                org_node = db.query(OrgTreeNode).filter(OrgTreeNode.id == group_id, OrgTreeNode.level == 2).first()
                group_name = getattr(org_node, "group_name", None)
            except Exception:
                pass
    data["requester_group_name"] = group_name
    return data


@router.get("/meta")
def approval_meta(
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_can_manage_approvals(current_user)
    ensure_generic_approval_schema(db)

    active_users = (
        db.query(User)
        .filter(User.is_active == True)
        .order_by(User.full_name.asc(), User.id.asc())
        .all()
    )
    active_groups = _load_active_groups_for_meta(db)
    role_options = get_role_options(db)

    return {
        **get_approval_catalog(role_options),
        "users": [
            {
                "id": user.id,
                "full_name": user.full_name,
                "email": user.email,
                "role": user.role,
            }
            for user in active_users
        ],
        "groups": active_groups,
    }


@router.get("/rules")
def list_approval_rules(
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_can_manage_approvals(current_user)
    ensure_generic_approval_schema(db)
    tenant_id = _get_tenant_id(request)

    rules = _scoped_approval_rule_query(db, tenant_id).filter(
        ApprovalRule.module_key.is_not(None),
        ApprovalRule.action_key.is_not(None),
    ).options(
        selectinload(ApprovalRule.steps).selectinload(ApprovalRuleStep.approver_user),
        selectinload(ApprovalRule.requester_user),
    ).order_by(
        ApprovalRule.module_key.asc(),
        ApprovalRule.action_key.asc(),
        ApprovalRule.requester_type.asc(),
        ApprovalRule.requester_role.asc(),
        ApprovalRule.requester_user_id.asc(),
        ApprovalRule.requester_group_id.asc(),
        ApprovalRule.id.asc(),
    ).all()
    group_ids = {
        getattr(rule, "requester_group_id", None)
        for rule in rules
        if getattr(rule, "requester_group_id", None)
    }
    _org_node_map = {
        node.id: node
        for node in db.query(OrgTreeNode).filter(
            OrgTreeNode.id.in_(group_ids),
            OrgTreeNode.level == 2,
        ).all()
    } if group_ids else {}
    return [_serialize_rule_for_ui(rule, db, _org_node_map=_org_node_map) for rule in rules]


@router.get("/escalation/settings")
def get_approval_escalation_settings(
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_can_manage_approvals(current_user)
    ensure_generic_approval_schema(db)
    tenant_id = _get_tenant_id(request)
    setting = get_effective_approval_escalation_setting(db, tenant_id)
    return serialize_escalation_setting(setting)


@router.put("/escalation/settings")
def update_approval_escalation_settings(
    payload: ApprovalEscalationSettingsInput,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_can_manage_approvals(current_user)
    ensure_generic_approval_schema(db)
    tenant_id = _get_tenant_id(request)

    setting = _load_scoped_approval_escalation_setting(db, tenant_id)
    if setting is None:
        setting = ApprovalEscalationSetting(tenant_id=tenant_id, created_at=_utcnow())
        db.add(setting)

    setting.tenant_id = tenant_id
    setting.is_enabled = bool(payload.is_enabled)
    setting.default_escalation_minutes = (
        int(payload.default_escalation_minutes)
        if payload.default_escalation_minutes is not None
        else None
    )
    setting.updated_at = _utcnow()

    db.commit()
    db.refresh(setting)
    return serialize_escalation_setting(setting)


@router.get("/escalation/rules")
def list_approval_escalation_rules(
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_can_manage_approvals(current_user)
    ensure_generic_approval_schema(db)
    tenant_id = _get_tenant_id(request)

    rows = _scoped_approval_escalation_rule_query(
        db,
        tenant_id,
        include_fallback=tenant_id is not None,
    ).order_by(
        ApprovalEscalationRule.module_key.asc(),
        ApprovalEscalationRule.action_key.asc(),
        ApprovalEscalationRule.approver_role.asc(),
        ApprovalEscalationRule.id.asc(),
    ).all()

    deduped: dict[tuple[str, str, str], ApprovalEscalationRule] = {}
    for row in rows:
        key = (
            (row.module_key or "").strip().lower(),
            (row.action_key or "").strip().lower(),
            normalize_role_key(row.approver_role) or "",
        )
        existing = deduped.get(key)
        if existing is None:
            deduped[key] = row
            continue
        if tenant_id is not None and row.tenant_id == tenant_id and existing.tenant_id != tenant_id:
            deduped[key] = row

    return [
        serialize_escalation_rule(rule)
        for _, rule in sorted(
            deduped.items(),
            key=lambda item: (item[0][0], item[0][1], item[0][2], item[1].id),
        )
    ]


@router.post("/escalation/rules")
def create_approval_escalation_rule(
    payload: ApprovalEscalationRuleInput,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_can_manage_approvals(current_user)
    ensure_generic_approval_schema(db)
    tenant_id = _get_tenant_id(request)
    module_key, action_key, approver_role, escalation_minutes = _normalize_escalation_rule_input(payload)

    rule = _save_approval_escalation_rule(
        db,
        tenant_id=tenant_id,
        existing_rule=None,
        module_key=module_key,
        action_key=action_key,
        approver_role=approver_role,
        escalation_minutes=escalation_minutes,
        is_active=payload.is_active,
    )
    db.commit()
    db.refresh(rule)
    return serialize_escalation_rule(rule)


@router.put("/escalation/rules/{rule_id}")
def update_approval_escalation_rule(
    rule_id: int,
    payload: ApprovalEscalationRuleInput,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_can_manage_approvals(current_user)
    ensure_generic_approval_schema(db)
    tenant_id = _get_tenant_id(request)
    rule = _scoped_approval_escalation_rule_query(
        db,
        tenant_id,
        include_fallback=tenant_id is not None,
    ).filter(ApprovalEscalationRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Escalation rule not found.")

    module_key, action_key, approver_role, escalation_minutes = _normalize_escalation_rule_input(payload)
    updated_rule = _save_approval_escalation_rule(
        db,
        tenant_id=tenant_id,
        existing_rule=rule,
        module_key=module_key,
        action_key=action_key,
        approver_role=approver_role,
        escalation_minutes=escalation_minutes,
        is_active=payload.is_active,
    )
    db.commit()
    db.refresh(updated_rule)
    return serialize_escalation_rule(updated_rule)


@router.patch("/escalation/rules/{rule_id}/status")
def update_approval_escalation_rule_status(
    rule_id: int,
    payload: ApprovalEscalationRuleStatusInput,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_can_manage_approvals(current_user)
    ensure_generic_approval_schema(db)
    tenant_id = _get_tenant_id(request)
    rule = _scoped_approval_escalation_rule_query(
        db,
        tenant_id,
        include_fallback=tenant_id is not None,
    ).filter(ApprovalEscalationRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Escalation rule not found.")

    rule.is_active = bool(payload.is_active)
    rule.tenant_id = tenant_id
    rule.updated_at = _utcnow()
    db.commit()
    db.refresh(rule)
    return serialize_escalation_rule(rule)


@router.delete("/escalation/rules/{rule_id}")
def delete_approval_escalation_rule(
    rule_id: int,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_can_manage_approvals(current_user)
    ensure_generic_approval_schema(db)
    tenant_id = _get_tenant_id(request)
    rule = _scoped_approval_escalation_rule_query(
        db,
        tenant_id,
        include_fallback=tenant_id is not None,
    ).filter(ApprovalEscalationRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Escalation rule not found.")

    db.delete(rule)
    db.commit()
    return {"success": True}


@router.get("/auto-approve/settings")
def list_approval_auto_approve_settings(
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """List every (module, action) pair from the approval catalog with its current
    auto-approve-when-no-rule toggle. Pairs with no saved row default to disabled,
    which matches today's existing group-hierarchy fallback behavior."""
    _ensure_can_manage_approvals(current_user)
    ensure_generic_approval_schema(db)
    tenant_id = _get_tenant_id(request)

    rows = _scoped_approval_auto_approve_setting_query(
        db,
        tenant_id,
        include_fallback=tenant_id is not None,
    ).all()

    settings_by_key: dict[tuple[str, str], ApprovalAutoApproveSetting] = {}
    for row in rows:
        key = ((row.module_key or "").strip().lower(), (row.action_key or "").strip().lower())
        existing = settings_by_key.get(key)
        if existing is None:
            settings_by_key[key] = row
            continue
        if tenant_id is not None and row.tenant_id == tenant_id and existing.tenant_id != tenant_id:
            settings_by_key[key] = row

    result = []
    for module in APPROVAL_MODULES:
        module_key = module["key"]
        for action in module["actions"]:
            action_key = action["key"]
            setting = settings_by_key.get((module_key, action_key))
            result.append({
                "module_key": module_key,
                "module_label": module["label"],
                "action_key": action_key,
                "action_label": action["label"],
                "is_enabled": bool(setting.is_enabled) if setting else False,
            })
    return result


@router.put("/auto-approve/settings")
def update_approval_auto_approve_setting(
    payload: ApprovalAutoApproveSettingInput,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Upsert the auto-approve-when-no-rule toggle for one (module, action) pair.
    This setting only takes effect when no approval rule matches the request —
    it never overrides a matched rule, and never changes escalation behavior."""
    _ensure_can_manage_approvals(current_user)
    ensure_generic_approval_schema(db)
    tenant_id = _get_tenant_id(request)

    module_key = (payload.module_key or "").strip().lower()
    action_key = (payload.action_key or "").strip().lower()
    if not module_key:
        raise HTTPException(status_code=400, detail="Module is required.")
    if not action_key:
        raise HTTPException(status_code=400, detail="Action is required.")

    setting = _scoped_approval_auto_approve_setting_query(
        db,
        tenant_id,
        include_fallback=tenant_id is not None,
    ).filter(
        ApprovalAutoApproveSetting.module_key == module_key,
        ApprovalAutoApproveSetting.action_key == action_key,
    ).order_by(ApprovalAutoApproveSetting.id.asc()).first()

    if setting is None or (tenant_id is not None and setting.tenant_id is None):
        setting = ApprovalAutoApproveSetting(
            tenant_id=tenant_id,
            module_key=module_key,
            action_key=action_key,
            created_at=_utcnow(),
        )
        db.add(setting)

    setting.is_enabled = bool(payload.is_enabled)
    setting.updated_at = _utcnow()
    db.commit()
    db.refresh(setting)
    return serialize_auto_approve_setting(setting)


@router.post("/rules")
def create_approval_rule(
    payload: ApprovalRuleUpsertInput,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_can_manage_approvals(current_user)
    ensure_generic_approval_schema(db)
    tenant_id = _get_tenant_id(request)
    (
        module_keys,
        action_keys,
        module_action_pairs,
        requester_type,
        requester_role,
        requester_user_id,
        requester_group_id,
        requester_roles,
        requester_user_ids,
        requester_group_ids,
        approval_type,
        is_active,
        steps,
        base_name,
    ) = _expand_rule_payload(payload)

    module_action_combos = module_action_pairs or [
        (module_key, action_key) for module_key in module_keys for action_key in action_keys
    ]

    if requester_type == "role":
        requester_targets = [(role, None, None) for role in requester_roles]
    elif requester_type == "specific_user":
        requester_targets = [(None, user_id, None) for user_id in requester_user_ids]
    else:
        requester_targets = [(None, None, group_id) for group_id in requester_group_ids]

    if not requester_targets:
        if requester_type == "role":
            requester_targets = [(requester_role, None, None)]
        elif requester_type == "specific_user":
            requester_targets = [(None, requester_user_id, None)]
        else:
            requester_targets = [(None, None, requester_group_id)]

    created_rules: List[ApprovalRule] = []
    total_combinations = len(module_action_combos) * len(requester_targets)
    append_requester_label = total_combinations > 1

    for module_key, action_key in module_action_combos:
        for combo_role, combo_user_id, combo_group_id in requester_targets:
            created_rules.append(
                _save_rule(
                    db,
                    tenant_id=tenant_id,
                    existing_rule=None,
                    module_key=module_key,
                    action_key=action_key,
                    name=_build_rule_name(
                        db,
                        base_name=base_name,
                        module_key=module_key,
                        action_key=action_key,
                        requester_type=requester_type,
                        requester_role=combo_role,
                        requester_user_id=combo_user_id,
                        requester_group_id=combo_group_id,
                        append_requester_label=append_requester_label,
                    ),
                    requester_type=requester_type,
                    requester_role=combo_role,
                    requester_user_id=combo_user_id,
                    requester_group_id=combo_group_id,
                    approval_type=approval_type,
                    is_active=is_active,
                    steps=steps,
                )
            )
    for rule in created_rules:
        log_module_action(
            db=db, user_id=current_user.id, module="approval_rules", action="workflow_create",
            record_id=rule.id, record_name=rule.name, ip=get_request_ip(request),
            new_data={"module_key": rule.module_key, "action_key": rule.action_key, "is_active": rule.is_active},
        )
    db.commit()
    return {
        "items": [_serialize_rule_for_ui(rule, db) for rule in created_rules],
        "count": len(created_rules),
    }


@router.put("/rules/{rule_id}")
def update_approval_rule(
    rule_id: int,
    payload: ApprovalRuleUpsertInput,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_can_manage_approvals(current_user)
    ensure_generic_approval_schema(db)
    tenant_id = _get_tenant_id(request)
    rule = _scoped_approval_rule_query(db, tenant_id).filter(ApprovalRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Approval rule not found.")

    (
        module_keys,
        action_keys,
        _module_action_pairs,
        requester_type,
        requester_role,
        requester_user_id,
        requester_group_id,
        requester_roles,
        requester_user_ids,
        requester_group_ids,
        approval_type,
        is_active,
        steps,
        base_name,
    ) = _expand_rule_payload(payload)

    if len(module_keys) != 1 or len(action_keys) != 1:
        raise HTTPException(status_code=400, detail="Updating a rule supports exactly one module and one action.")
    if requester_type == "role":
        requester_targets = [(role, None, None) for role in requester_roles or ([requester_role] if requester_role else [])]
    elif requester_type == "specific_user":
        requester_targets = [(None, user_id, None) for user_id in requester_user_ids or ([requester_user_id] if requester_user_id else [])]
    else:
        requester_targets = [(None, None, group_id) for group_id in requester_group_ids or ([requester_group_id] if requester_group_id else [])]
    if len(requester_targets) != 1:
        raise HTTPException(status_code=400, detail="Updating a rule supports exactly one requester condition.")

    combo_role, combo_user_id, combo_group_id = requester_targets[0]
    updated_rule = _save_rule(
        db,
        tenant_id=tenant_id,
        existing_rule=rule,
        module_key=module_keys[0],
        action_key=action_keys[0],
        name=_build_rule_name(
            db,
            base_name=base_name,
            module_key=module_keys[0],
            action_key=action_keys[0],
            requester_type=requester_type,
            requester_role=combo_role,
            requester_user_id=combo_user_id,
            requester_group_id=combo_group_id,
            append_requester_label=False,
        ),
        requester_type=requester_type,
        requester_role=combo_role,
        requester_user_id=combo_user_id,
        requester_group_id=combo_group_id,
        approval_type=approval_type,
        is_active=is_active,
        steps=steps,
    )
    log_module_action(
        db=db, user_id=current_user.id, module="approval_rules", action="workflow_update",
        record_id=updated_rule.id, record_name=updated_rule.name, ip=get_request_ip(request),
        new_data={"module_key": updated_rule.module_key, "action_key": updated_rule.action_key, "is_active": updated_rule.is_active},
    )
    db.commit()
    db.refresh(updated_rule)
    return _serialize_rule_for_ui(updated_rule, db)


@router.patch("/rules/{rule_id}/status")
def update_approval_rule_status(
    rule_id: int,
    payload: ApprovalRuleStatusInput,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_can_manage_approvals(current_user)
    ensure_generic_approval_schema(db)
    rule = _scoped_approval_rule_query(db, _get_tenant_id(request)).filter(ApprovalRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Approval rule not found.")
    rule.is_active = bool(payload.is_active)
    rule.updated_at = _utcnow()
    log_module_action(
        db=db, user_id=current_user.id, module="approval_rules",
        action="workflow_enable" if rule.is_active else "workflow_disable",
        record_id=rule.id, record_name=rule.name, ip=get_request_ip(request),
    )
    db.commit()
    db.refresh(rule)
    return _serialize_rule_for_ui(rule, db)


@router.delete("/rules/{rule_id}")
def delete_approval_rule(
    rule_id: int,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_can_manage_approvals(current_user)
    ensure_generic_approval_schema(db)
    rule = _scoped_approval_rule_query(db, _get_tenant_id(request)).filter(ApprovalRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Approval rule not found.")

    db.query(ApprovalRuleStep).filter(ApprovalRuleStep.approval_rule_id == rule.id).delete()
    log_module_action(
        db=db, user_id=current_user.id, module="approval_rules", action="delete",
        record_id=rule.id, record_name=rule.name, ip=get_request_ip(request),
    )
    db.delete(rule)
    db.commit()
    return {"success": True}


class StepEscalationInput(BaseModel):
    escalation_minutes: Optional[int] = None

    @field_validator("escalation_minutes")
    @classmethod
    def _mins(cls, v: Optional[int]) -> Optional[int]:
        return _check_escalation_minutes(v)


@router.patch("/rules/{rule_id}/steps/{step_id}/escalation")
def update_step_escalation(
    rule_id: int,
    step_id: int,
    payload: StepEscalationInput,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_can_manage_approvals(current_user)
    rule = _scoped_approval_rule_query(db, _get_tenant_id(request)).filter(ApprovalRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Approval rule not found.")
    step = db.query(ApprovalRuleStep).filter(
        ApprovalRuleStep.id == step_id,
        ApprovalRuleStep.approval_rule_id == rule_id,
    ).first()
    if not step:
        raise HTTPException(status_code=404, detail="Step not found.")
    mins = payload.escalation_minutes
    step.escalation_minutes = int(mins) if mins is not None and int(mins) > 0 else None
    step.updated_at = _utcnow()
    db.commit()
    db.refresh(step)
    return {"id": step.id, "step_no": step.step_no, "escalation_minutes": step.escalation_minutes}


@router.get("/requests/pending")
def list_pending_requests(
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    ensure_generic_approval_schema(db)
    rows = (
        db.query(ApprovalRequest)
        .options(
            selectinload(ApprovalRequest.steps).selectinload(ApprovalRequestStep.approver),
            selectinload(ApprovalRequest.requester),
        )
        .join(
            ApprovalRequestStep,
            ApprovalRequestStep.approval_request_id == ApprovalRequest.id,
        )
        .filter(
            ApprovalRequest.status == "pending",
            ApprovalRequestStep.step_no == ApprovalRequest.current_step_no,
            ApprovalRequestStep.approver_user_id == current_user.id,
            ApprovalRequestStep.status == "pending",
        )
        .order_by(ApprovalRequest.requested_at.desc())
        .all()
    )
    return [serialize_request_for_ui(db, row) for row in rows]


@router.get("/requests/history")
def list_request_history(
    module_key: Optional[str] = None,
    record_id: Optional[int] = None,
    page: int = 1,
    per_page: int = 20,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    ensure_generic_approval_schema(db)
    q = db.query(ApprovalRequest).filter(ApprovalRequest.status != "pending")
    if current_user.role not in ("admin", "ceo"):
        from sqlalchemy import or_
        participated_ids = db.query(ApprovalRequestStep.approval_request_id).filter(
            ApprovalRequestStep.approver_user_id == current_user.id
        ).subquery()
        q = q.filter(
            or_(
                ApprovalRequest.requested_by == current_user.id,
                ApprovalRequest.id.in_(participated_ids),
            )
        )
    if module_key:
        q = q.filter(ApprovalRequest.module_key == module_key)
    if record_id:
        q = q.filter(ApprovalRequest.record_id == record_id)
    total = q.count()
    items = (
        q.options(
            selectinload(ApprovalRequest.steps).selectinload(ApprovalRequestStep.approver),
            selectinload(ApprovalRequest.requester),
        )
        .order_by(ApprovalRequest.requested_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )
    return {
        "items": [serialize_request_for_ui(db, row) for row in items],
        "total": total,
        "page": page,
        "per_page": per_page,
    }


@router.post("/requests")
def create_approval_request(
    payload: GenericApprovalRequestInput,
    request: Request,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    generic_request = create_generic_approval_request(
        db,
        tenant_id=_get_tenant_id(request),
        requester=current_user,
        module_key=payload.module_key.strip().lower(),
        action_key=payload.action_key.strip().lower(),
        record_id=payload.record_id,
        request_group_id=payload.group_id,
    )
    _apply_dynamic_request_side_effects(
        db,
        request=generic_request,
        actor=current_user,
    )
    db.commit()
    db.refresh(generic_request)
    return serialize_request_for_ui(db, generic_request)


@router.post("/requests/{approval_request_id}/decision")
def decide_approval_request(
    approval_request_id: int,
    payload: ApprovalDecisionInput,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    updated_request = decide_generic_approval_request(
        db,
        approval_request_id=approval_request_id,
        approver=current_user,
        decision=payload.decision,
        remarks=payload.remarks,
    )
    _apply_dynamic_request_side_effects(
        db,
        request=updated_request,
        actor=current_user,
        remarks=payload.remarks,
    )
    db.commit()
    db.refresh(updated_request)
    return serialize_request_for_ui(db, updated_request)



@router.post("/escalation/run")
def run_escalation_now(
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_can_manage_approvals(current_user)
    counts = run_approval_escalation_maintenance_for_db(db)
    return counts
